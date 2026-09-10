import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as adb from "../adb";
import { t, bundleFor, currentLang } from "../i18n";

/** The user's Downloads folder — where browsers drop .apk files. */
function downloadsDir(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), "Downloads"));
}
import {
  DeviceEntry,
  loadDevices,
  moveDevice,
  registerSeenDevice,
  removeDevice,
  setDeviceNickname,
  setDevicePreferredProfile,
  setFridaServerDir,
  setFridaServerInfo,
} from "../deviceStore";
import { loadProfiles, displayNameOf as displayNameOfProfile } from "../profileStore";
import { installFridaServerForProfile } from "../fridaServerInstaller";
import { PANEL_STYLE, PANEL_KIT_JS, PK_SERVER_JS, getNonce } from "./panelKit";

export type DevicesPanelTab = "list" | "server";

interface InstalledServerEntry {
  file: string;
  path: string;
}

interface DeviceRow {
  serial: string;
  registered: boolean;
  nickname: string;
  connected: boolean;
  /** true = still being probed; the row is shown from the stored registry meanwhile. */
  probing?: boolean;
  state?: string;
  fridaServerVersion: string;
  fridaServerPath: string;
  fridaServerDir: string;
  running: boolean;
  runningVersion?: string;
  runningPath?: string;
  abi?: string;
  installedServers: InstalledServerEntry[];
  /** Profile (by slug) pinned as this device's companion venv ("" = auto-match). */
  preferredProfile: string;
}

/** A profile sent to the webview: for the version-match pill and the companion-profile picker. */
interface ProfileVersion {
  version: string;
  /** Profile slug (stored as preferredProfile). */
  name: string;
  displayName: string;
}

type HostToWebviewMessage =
  | { type: "devices"; rows: DeviceRow[]; profiles: ProfileVersion[] }
  | { type: "deviceRow"; row: DeviceRow }
  | { type: "loading" }
  | { type: "statusResult"; id: string; ok: boolean; running: boolean; message: string }
  | { type: "progress"; id: string; message: string; percent: number; bar?: boolean }
  | { type: "progressDone"; id: string }
  | { type: "setTab"; tab: DevicesPanelTab };

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "registerDevice"; serial: string }
  | { type: "saveNickname"; serial: string; nickname: string }
  | { type: "saveFridaServerInfo"; id: string; version: string; path: string }
  | { type: "moveDevice"; id: string; dir: number }
  | { type: "saveFridaServerDir"; id: string; dir: string }
  | { type: "savePreferredProfile"; id: string; name: string }
  | { type: "remove"; serial: string }
  | { type: "checkStatus"; id: string }
  | { type: "installFridaServer"; id: string }
  | { type: "runInstalledVersion"; id: string; path: string; label: string }
  | { type: "stopFridaServer"; id: string }
  | { type: "deleteInstalledVersion"; id: string; path: string; file: string }
  | { type: "cancelServerOp"; id: string }
  | { type: "pullPath"; serial: string }
  | { type: "pullApk"; serial: string }
  | { type: "installApk"; serial: string }
  | { type: "copyCommand"; command: string };

/** Manages registered Android devices in one window (tabs): Devices / Frida Server. */
export class ManageDevicesPanel {
  private static current: ManageDevicesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  /** Abort handles for in-flight Frida Server operations, keyed by device serial. */
  private readonly serverAbort = new Map<string, AbortController>();

  static show(dataDir: string, onChanged: () => void, initialTab: DevicesPanelTab = "list"): void {
    if (ManageDevicesPanel.current) {
      ManageDevicesPanel.current.panel.reveal();
      ManageDevicesPanel.current.post({ type: "setTab", tab: initialTab });
      ManageDevicesPanel.current.sendDevices();
      return;
    }
    ManageDevicesPanel.current = new ManageDevicesPanel(dataDir, onChanged, initialTab);
  }

  static refreshIfOpen(): void {
    ManageDevicesPanel.current?.sendDevices();
  }

  /** Re-renders the open window in the new language when frivenv.language changes. */
  static relocalizeIfOpen(): void {
    const p = ManageDevicesPanel.current;
    if (!p) {
      return;
    }
    p.panel.webview.html = p.renderHtml();
    void p.sendDevices();
  }

  private constructor(
    private readonly dataDir: string,
    private readonly onChanged: () => void,
    private readonly initialTab: DevicesPanelTab
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "frivenv.manageDevices",
      t("dw.windowTitle"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      for (const ac of this.serverAbort.values()) {
        ac.abort();
      }
      ManageDevicesPanel.current = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => this.handleMessage(msg));
  }

  private post(msg: HostToWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    this.panel.webview.postMessage(msg);
  }

  private profileVersions(): ProfileVersion[] {
    return loadProfiles(this.dataDir)
      .filter((p) => p.frida_version)
      .map((p) => ({ version: p.frida_version, name: p.name, displayName: displayNameOfProfile(p) }));
  }

  /** A registered device row straight from the registry (no adb probing yet). */
  private shallowRow(entry: DeviceEntry): DeviceRow {
    return {
      serial: entry.serial,
      registered: true,
      nickname: entry.nickname ?? "",
      connected: false,
      probing: true,
      fridaServerVersion: entry.fridaServerVersion ?? "",
      fridaServerPath: entry.fridaServerPath ?? "",
      fridaServerDir:
        entry.fridaServerDir && entry.fridaServerDir.trim().length > 0
          ? entry.fridaServerDir.trim()
          : adb.DEFAULT_FRIDA_SERVER_REMOTE_DIR,
      running: false,
      installedServers: [],
      preferredProfile: entry.preferredProfile ?? "",
    };
  }

  /** Fills a shallow row in place with adb-probed connection + frida-server info. */
  private async probeRow(row: DeviceRow, adbPath: string | undefined, state: string | undefined): Promise<void> {
    row.probing = false;
    row.state = state;
    row.connected = state === "device";
    if (!row.connected || !adbPath) {
      return;
    }
    try {
      row.abi = await adb.getDeviceAbi(adbPath, row.serial);
    } catch {
      // ignore
    }
    try {
      const files = await adb.listInstalledFridaServerBinaries(adbPath, row.serial, row.fridaServerDir);
      row.installedServers = files.map((file) => ({ file, path: `${row.fridaServerDir}/${file}` }));
    } catch {
      // listing failed; leave it empty
    }
    try {
      const info = await adb.getRunningFridaServerInfo(adbPath, row.serial);
      row.running = info.running;
      row.runningVersion = info.version;
      row.runningPath = info.path;
      // Only record the running version when nothing is stored yet (first discovery).
      if (info.version && info.path && !row.fridaServerPath) {
        setFridaServerInfo(this.dataDir, row.serial, info.version, info.path);
        row.fridaServerVersion = info.version;
        row.fridaServerPath = info.path;
      }
    } catch {
      // ignore detection failures
    }
  }

  /** Re-probes ONE device and pushes a single-card update — no whole-list refresh. */
  private async refreshOneDevice(serial: string): Promise<void> {
    const entry = loadDevices(this.dataDir).find((d) => d.serial === serial);
    if (!entry) {
      await this.sendDevices();
      return;
    }
    const row = this.shallowRow(entry);
    const adbPath = await adb.findAdbCli();
    let state: string | undefined;
    if (adbPath) {
      try {
        state = (await adb.listDevices(adbPath)).find((d) => d.serial === serial)?.state;
      } catch {
        // ignore
      }
    }
    await this.probeRow(row, adbPath, state);
    this.post({ type: "deviceRow", row });
  }

  private async sendDevices(): Promise<void> {
    const entries = loadDevices(this.dataDir);
    const profiles = this.profileVersions();

    // Phase 1: show the registered devices straight from the registry so nickname
    // edits / Unregister work immediately, without waiting for the adb probes.
    const rowBySerial = new Map<string, DeviceRow>();
    const rows: DeviceRow[] = entries.map((entry) => {
      const row = this.shallowRow(entry);
      rowBySerial.set(entry.serial, row);
      return row;
    });
    if (rows.length > 0) {
      this.post({ type: "devices", rows, profiles });
    } else {
      this.post({ type: "loading" });
    }

    // Phase 2: probe adb and fill in connection status / frida-server info.
    const liveBySerial = new Map<string, string>();
    const adbPath = await adb.findAdbCli();
    if (adbPath) {
      try {
        for (const d of await adb.listDevices(adbPath)) {
          liveBySerial.set(d.serial, d.state);
        }
      } catch {
        // ignore; show the stored list only
      }
    }

    const registeredSerials = new Set(entries.map((e) => e.serial));
    for (const entry of entries) {
      await this.probeRow(rowBySerial.get(entry.serial)!, adbPath, liveBySerial.get(entry.serial));
    }

    // Seen by adb but not registered yet; register from the Devices tab with the "register" button.
    for (const [serial, state] of liveBySerial) {
      if (registeredSerials.has(serial)) {
        continue;
      }
      rows.push({
        serial,
        registered: false,
        nickname: "",
        connected: state === "device",
        state,
        fridaServerVersion: "",
        fridaServerPath: "",
        fridaServerDir: adb.DEFAULT_FRIDA_SERVER_REMOTE_DIR,
        running: false,
        installedServers: [],
        preferredProfile: "",
      });
    }

    // Registered devices keep their devices.json order (the user-set order); only
    // the transient connected-but-unregistered ones are pushed to the bottom.
    rows.sort((a, b) => Number(b.registered) - Number(a.registered));
    this.post({ type: "devices", rows, profiles });
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "setTab", tab: this.initialTab });
        await this.sendDevices();
        break;

      case "refresh":
        await this.sendDevices();
        this.onChanged(); // keep the sidebar tree in sync with the window
        break;

      case "registerDevice":
        registerSeenDevice(this.dataDir, msg.serial);
        await this.sendDevices();
        this.onChanged();
        break;

      case "saveNickname":
        try {
          setDeviceNickname(this.dataDir, msg.serial, msg.nickname);
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
          return;
        }
        await this.refreshOneDevice(msg.serial);
        this.onChanged();
        break;

      case "saveFridaServerInfo":
        // Persist the dropdown choice, but do NOT re-render — a re-render here is
        // what made the selection jump back while the user was reaching for a button.
        setFridaServerInfo(this.dataDir, msg.id, msg.version.trim(), msg.path.trim());
        break;

      case "saveFridaServerDir":
        setFridaServerDir(this.dataDir, msg.id, msg.dir);
        await this.refreshOneDevice(msg.id);
        break;

      case "savePreferredProfile":
        // Persist, refresh the tree, and re-probe the one device so BOTH tabs'
        // cards show the new pinned profile (not just the tab it was changed on).
        setDevicePreferredProfile(this.dataDir, msg.id, msg.name);
        this.onChanged();
        await this.refreshOneDevice(msg.id);
        break;

      case "moveDevice":
        // Reorder devices.json; both tabs re-render from the new order, tree follows.
        moveDevice(this.dataDir, msg.id, msg.dir < 0 ? -1 : 1);
        await this.sendDevices();
        this.onChanged();
        break;

      case "remove": {
        const unregBtn = t("wc.action.unregister");
        const confirm = await vscode.window.showWarningMessage(
          t("wc.confirm.unregister", msg.serial),
          { modal: true },
          unregBtn
        );
        if (confirm !== unregBtn) {
          return;
        }
        removeDevice(this.dataDir, msg.serial);
        await this.sendDevices();
        this.onChanged();
        break;
      }

      case "checkStatus": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          this.post({ type: "statusResult", id: msg.id, ok: false, running: false, message: t("cmd.err.adbNotFound") });
          return;
        }
        try {
          const abi = await adb.getDeviceAbi(adbPath, msg.id);
          const info = await adb.getRunningFridaServerInfo(adbPath, msg.id);
          const serverText = info.running
            ? t("wc.status.running", info.version ?? t("wc.status.versionUnknown")) + (info.path ? ` · ${info.path}` : "")
            : t("wc.status.notRunning");
          this.post({
            type: "statusResult",
            id: msg.id,
            ok: true,
            running: info.running,
            message: t("dw.status.archPrefix", abi, serverText),
          });
          // Re-probe so the pill / Stop button / running line reflect the check.
          await this.refreshOneDevice(msg.id);
        } catch (err) {
          if (err instanceof adb.DeviceOfflineError) {
            this.post({ type: "statusResult", id: msg.id, ok: false, running: false, message: t("dw.status.disconnected") });
            await this.refreshOneDevice(msg.id);
          } else {
            this.post({ type: "statusResult", id: msg.id, ok: false, running: false, message: (err as Error).message });
          }
        }
        break;
      }

      case "installFridaServer": {
        const ac = new AbortController();
        this.serverAbort.set(msg.id, ac);
        try {
          const profiles = loadProfiles(this.dataDir);
          if (profiles.length === 0) {
            vscode.window.showErrorMessage(t("cmd.err.noProfiles"));
            return;
          }
          const picked = await vscode.window.showQuickPick(
            profiles
              .filter((p) => p.frida_version)
              .map((p) => ({
                label: `frida ${p.frida_version}`,
                description: displayNameOfProfile(p),
                detail: t("iw.installVersionDetail", msg.id),
                profile: p,
              })),
            { title: t("iw.pick.installVersionTitle") }
          );
          if (!picked) {
            return;
          }
          const entry = loadDevices(this.dataDir).find((d) => d.serial === msg.id);
          const remoteDir =
            entry?.fridaServerDir && entry.fridaServerDir.trim().length > 0
              ? entry.fridaServerDir.trim()
              : adb.DEFAULT_FRIDA_SERVER_REMOTE_DIR;
          const result = await installFridaServerForProfile(
            picked.profile,
            (p) => this.post({ type: "progress", id: msg.id, message: p.message, percent: p.percent, bar: p.bar }),
            msg.id,
            remoteDir,
            ac.signal
          );
          if (result) {
            setFridaServerInfo(this.dataDir, result.serial, result.version, result.path);
            this.onChanged();
          }
        } finally {
          this.serverAbort.delete(msg.id);
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id);
        }
        break;
      }

      case "runInstalledVersion": {
        const ac = new AbortController();
        this.serverAbort.set(msg.id, ac);
        try {
          const adbPath = await adb.findAdbCli();
          if (!adbPath) {
            vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
            return;
          }
          if (!msg.path) {
            vscode.window.showInformationMessage(t("iw.err.noInstalledVersion", msg.id));
            return;
          }
          try {
            this.post({ type: "progress", id: msg.id, message: t("srv.prog.killExisting"), percent: 30, bar: true });
            await adb.killFridaServer(adbPath, msg.id, (line) =>
              this.post({ type: "progress", id: msg.id, message: line, percent: 30 })
            );
            if (ac.signal.aborted) {
              throw new Error(t("nw.log.cancelled"));
            }
            this.post({ type: "progress", id: msg.id, message: t("iw.prog.runningLabel", msg.label), percent: 70, bar: true });
            await adb.runFridaServerBinary(adbPath, msg.id, msg.path, (line) =>
              this.post({ type: "progress", id: msg.id, message: line, percent: 70 })
            );
            setFridaServerInfo(this.dataDir, msg.id, msg.label, msg.path);
            this.post({ type: "progress", id: msg.id, message: t("iw.prog.ranLabel", msg.label), percent: 100, bar: true });
          } catch (err) {
            if (err instanceof adb.DeviceOfflineError) {
              this.post({ type: "progress", id: msg.id, message: err.message, percent: 0 });
            } else {
              this.post({ type: "progress", id: msg.id, message: t("iw.prog.runFailed", (err as Error).message), percent: 0 });
            }
          }
          this.onChanged();
        } finally {
          this.serverAbort.delete(msg.id);
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id);
        }
        break;
      }

      case "stopFridaServer": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
          return;
        }
        try {
          this.post({ type: "progress", id: msg.id, message: t("srv.prog.killExisting"), percent: 50, bar: true });
          await adb.killFridaServer(adbPath, msg.id, (line) =>
            this.post({ type: "progress", id: msg.id, message: line, percent: 50 })
          );
          const still = await adb.getRunningFridaServerInfo(adbPath, msg.id).catch(() => ({ running: false }));
          this.post({
            type: "progress",
            id: msg.id,
            message: still.running ? t("iw.warn.stillRunning") : t("srv.log.stopped"),
            percent: still.running ? 0 : 100,
          });
        } catch (err) {
          this.post({ type: "progress", id: msg.id, message: t("iw.err.stopFailed", (err as Error).message), percent: 0 });
        } finally {
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id);
        }
        break;
      }

      case "deleteInstalledVersion": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
          return;
        }
        const deleteBtn = t("srv.action.delete");
        const confirm = await vscode.window.showWarningMessage(
          t("srv.confirm.deleteBinary", msg.file),
          { modal: true },
          deleteBtn
        );
        if (confirm !== deleteBtn) {
          return;
        }
        try {
          this.post({ type: "progress", id: msg.id, message: t("srv.prog.deleting", msg.file), percent: 50, bar: true });
          const log = (line: string) => this.post({ type: "progress", id: msg.id, message: line, percent: 50 });
          // Deleting the binary of a running server leaves a zombie — stop it first.
          const cur = await adb.getRunningFridaServerInfo(adbPath, msg.id).catch(() => undefined);
          if (cur?.running && cur.path === msg.path) {
            this.post({ type: "progress", id: msg.id, message: t("srv.prog.killExisting"), percent: 40, bar: true });
            await adb.killFridaServer(adbPath, msg.id, log);
          }
          await adb.deleteFridaServerBinary(adbPath, msg.id, msg.path, log);
          const entry = loadDevices(this.dataDir).find((d) => d.serial === msg.id);
          if (entry?.fridaServerPath === msg.path) {
            setFridaServerInfo(this.dataDir, msg.id, "", "");
          }
          this.post({ type: "progress", id: msg.id, message: t("srv.deleted", msg.file), percent: 100 });
        } catch (err) {
          this.post({ type: "progress", id: msg.id, message: t("srv.err.deleteFailed", (err as Error).message), percent: 0 });
        } finally {
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id);
          this.onChanged(); // the tree shows the frida-server version too
        }
        break;
      }

      case "cancelServerOp":
        this.serverAbort.get(msg.id)?.abort();
        break;

      case "pullPath": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
          return;
        }
        const remotePath = await vscode.window.showInputBox({
          prompt: t("dw.pull.promptPath"),
          placeHolder: t("dw.pull.placeholderPath"),
        });
        if (!remotePath) {
          return;
        }
        const destUris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: downloadsDir(),
          openLabel: t("dw.pull.openLabel"),
          title: t("dw.pull.saveFolder"),
        });
        if (!destUris || destUris.length === 0) {
          return;
        }
        const localDir = destUris[0].fsPath;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t("dw.pull.pulling", remotePath) },
            (progress) => adb.pullPath(adbPath, msg.serial, remotePath, localDir, (line) => progress.report({ message: line }))
          );
          vscode.window.showInformationMessage(t("dw.pull.saved", localDir));
        } catch (err) {
          vscode.window.showErrorMessage(t("dw.pull.failed", (err as Error).message));
        }
        break;
      }

      case "pullApk": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
          return;
        }
        let packages: string[];
        try {
          packages = await adb.listUserPackages(adbPath, msg.serial);
        } catch (err) {
          vscode.window.showErrorMessage(t("dw.apkPull.failed", (err as Error).message));
          return;
        }
        if (packages.length === 0) {
          vscode.window.showInformationMessage(t("dw.apkPull.noPackages"));
          return;
        }
        const pkg = await vscode.window.showQuickPick(packages, {
          title: t("dw.apkPull.pickTitle"),
          placeHolder: t("dw.apkPull.pickPlaceholder"),
        });
        if (!pkg) {
          return;
        }
        const dest = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: downloadsDir(),
          openLabel: t("dw.apkPull.openLabel"),
          title: t("dw.apkPull.saveFolder"),
        });
        if (!dest || dest.length === 0) {
          return;
        }
        try {
          let saved = "";
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t("dw.apkPull.progressTitle", pkg) },
            async (progress) => {
              saved = await adb.pullApk(adbPath, msg.serial, pkg, dest[0].fsPath, (line) =>
                progress.report({ message: line })
              );
            }
          );
          vscode.window.showInformationMessage(t("dw.apkPull.saved", saved));
        } catch (err) {
          vscode.window.showErrorMessage(t("dw.apkPull.failed", (err as Error).message));
        }
        break;
      }

      case "installApk": {
        const adbPath = await adb.findAdbCli();
        if (!adbPath) {
          vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
          return;
        }
        const apkUris = await vscode.window.showOpenDialog({
          canSelectFolders: false,
          canSelectFiles: true,
          canSelectMany: false,
          defaultUri: downloadsDir(),
          openLabel: t("dw.apk.openLabel"),
          title: t("dw.apk.pickTitle"),
          filters: { "Android package": ["apk"] },
        });
        if (!apkUris || apkUris.length === 0) {
          return;
        }
        const apkPath = apkUris[0].fsPath;
        const grantPick = await vscode.window.showQuickPick(
          [
            { label: t("dw.apk.grantNo"), grant: false },
            { label: t("dw.apk.grantYes"), grant: true },
          ],
          { title: t("dw.apk.grantTitle") }
        );
        if (!grantPick) {
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t("dw.apk.progressTitle") },
            (progress) =>
              adb.installApk(adbPath, msg.serial, apkPath, grantPick.grant, (line) => progress.report({ message: line }))
          );
          vscode.window.showInformationMessage(t("dw.apk.installed"));
        } catch (err) {
          vscode.window.showErrorMessage(t("dw.apk.failed", (err as Error).message));
        }
        break;
      }

      case "copyCommand":
        await vscode.env.clipboard.writeText(msg.command);
        vscode.window.showInformationMessage(t("wc.copied", msg.command));
        break;
    }
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
${PANEL_STYLE}
</head>
<body>
  <div id="root">
    <div class="pk-tabs">
      <button class="pk-tab pk-tab--active" data-tab="list">${t("iw.tab.manage")}</button>
      <button class="pk-tab" data-tab="server">${t("wc.tab.server")}</button>
      <span class="pk-tabs__spacer"></span>
      <button class="pk-tab-action" id="refreshBtn">${t("wc.refresh")}</button>
    </div>

    <section data-page="list">
      <div class="pk-empty" id="devEmpty">${t("dw.empty.connect")}</div>
      <div id="devList"></div>
    </section>

    <section data-page="server" hidden>
      <div class="pk-empty" id="srvEmpty">${t("wc.noDevices")}</div>
      <div id="srvList"></div>
    </section>
  </div>

<script nonce="${nonce}">
  const L = ${JSON.stringify({ ...bundleFor("pk."), ...bundleFor("dw."), ...bundleFor("wc."), ...bundleFor("iw.") })};
${PANEL_KIT_JS}
${PK_SERVER_JS}
  const root = document.getElementById('root');
  const tabs = pkTabs(root);
  document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  let rows = [];

  // ===== shared =====
  function connPill(row) {
    if (row.probing) return pkPill('set', L['wc.loading']);
    return pkPill(row.connected ? 'ok' : 'miss', row.connected ? L['dw.pill.connected'] : L['dw.pill.disconnected']);
  }
  function adbPrefix(row) { return 'adb -s ' + row.serial + ' shell'; }

  // ===== Devices tab =====
  function renderDevices() {
    const list = document.getElementById('devList');
    const empty = document.getElementById('devEmpty');
    empty.textContent = rows.length === 0 ? L['dw.empty.connect'] : '';
    empty.hidden = rows.length > 0;
    list.innerHTML = '';
    const regSerials = rows.filter((r) => r.registered).map((r) => r.serial);
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'pk-item';
      item.dataset.serial = row.serial;

      const head = document.createElement('div');
      head.className = 'pk-item__head';

      if (row.registered) {
        const name = document.createElement('input');
        name.className = 'pk-input';
        name.style.flex = '1 1 160px';
        name.placeholder = row.serial;
        name.value = row.nickname;
        const toast = document.createElement('span');
        toast.className = 'pk-toast';
        pkBindSave(name, { value: row.nickname, onSave: (v) => vscode.postMessage({ type: 'saveNickname', serial: row.serial, nickname: v }), toastEl: toast });
        head.appendChild(name);
        head.appendChild(toast);
        head.appendChild(connPill(row));
        const mp = pkServerMatchPill(srvCfg, row);
        if (mp) head.appendChild(mp);
        const ri = regSerials.indexOf(row.serial);
        head.appendChild(pkMoveBtns(row.serial, ri > 0, ri >= 0 && ri < regSerials.length - 1));
        item.appendChild(head);

        const sub = document.createElement('div');
        sub.className = 'pk-item__sub';
        sub.style.marginTop = '8px';
        sub.textContent = row.serial;
        item.appendChild(sub);

        const btns = document.createElement('div');
        btns.className = 'pk-btnrow pk-btnrow--end';
        const pull = document.createElement('button');
        pull.className = 'pk-btn';
        pull.textContent = L['dw.btn.pullFile'];
        pull.disabled = !row.connected;
        pull.addEventListener('click', () => vscode.postMessage({ type: 'pullPath', serial: row.serial }));
        pkAttachCopy(pull, () => 'adb -s ' + row.serial + ' pull <device-path> <local-dir>');
        btns.appendChild(pull);
        const pullApkBtn = document.createElement('button');
        pullApkBtn.className = 'pk-btn';
        pullApkBtn.textContent = L['dw.btn.pullApk'];
        pullApkBtn.disabled = !row.connected;
        pullApkBtn.addEventListener('click', () => vscode.postMessage({ type: 'pullApk', serial: row.serial }));
        pkAttachCopy(pullApkBtn, () => 'adb -s ' + row.serial + ' shell pm path <package>');
        btns.appendChild(pullApkBtn);
        const apk = document.createElement('button');
        apk.className = 'pk-btn';
        apk.textContent = L['dw.btn.installApk'];
        apk.disabled = !row.connected;
        apk.addEventListener('click', () => vscode.postMessage({ type: 'installApk', serial: row.serial }));
        pkAttachCopy(apk, () => 'adb -s ' + row.serial + ' install -r <apk-path>');
        btns.appendChild(apk);
        const rm = document.createElement('button');
        rm.className = 'pk-btn pk-btn--danger';
        rm.textContent = L['wc.item.unregister'];
        rm.addEventListener('click', () => vscode.postMessage({ type: 'remove', serial: row.serial }));
        btns.appendChild(rm);
        item.appendChild(btns);
      } else {
        const label = document.createElement('div');
        label.className = 'pk-item__title';
        label.textContent = row.serial;
        head.appendChild(label);
        head.appendChild(connPill(row));
        const reg = document.createElement('button');
        reg.className = 'pk-btn pk-btn--primary';
        reg.textContent = L['dw.btn.register'];
        reg.disabled = !row.connected;
        reg.addEventListener('click', () => vscode.postMessage({ type: 'registerDevice', serial: row.serial }));
        head.appendChild(reg);
        item.appendChild(head);
      }

      list.appendChild(item);
    }
  }

  // ===== Frida Server tab (shared renderer) =====
  const srvList = document.getElementById('srvList');
  const srvEmpty = document.getElementById('srvEmpty');

  function serverStatusText(row) {
    const arch = row.abi ? L['dw.status.archPrefixShort'].replace('{0}', row.abi) : '';
    if (row.running) return arch + L['wc.status.running'].replace('{0}', row.runningVersion || L['wc.status.versionUnknown']);
    return arch + L['wc.status.notRunning'];
  }

  const srvCfg = {
    idKey: 'serial',
    profiles: [],
    reachable: (r) => r.connected,
    noReachNote: null,
    optDisconnected: L['dw.opt.disconnected'],
    cardTitle: (r) => r.nickname || r.serial,
    headPill: (r) => (r.probing
      ? { state: 'set', text: L['wc.loading'] }
      : { state: r.connected ? 'ok' : 'miss', text: r.connected ? L['dw.pill.connected'] : L['dw.pill.disconnected'] }),
    statusLine: (r) => serverStatusText(r),
    cmdCheck: (r) => adbPrefix(r) + ' "pidof frida-server"',
    cmdInstall: (r) => 'adb -s ' + r.serial + ' push <frida-server-<version>> ' + r.fridaServerDir + '/',
    cmdRun: (r, p) => adbPrefix(r) + ' "su -c \\'nohup ' + p + ' >/dev/null 2>&1 &\\'"',
    cmdStop: (r) => adbPrefix(r) + ' "su -c \\'pkill -f frida-server\\'"',
    cmdDelete: (r, p) => adbPrefix(r) + ' "su -c \\'rm -f ' + p + '\\'"',
  };

  function renderServer() {
    pkRenderServerCards(srvList, srvEmpty, rows.filter((r) => r.registered), srvCfg);
  }

  function renderAll() { renderDevices(); renderServer(); }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'devices') {
      pkLoadingStop();
      rows = msg.rows;
      srvCfg.profiles = msg.profiles || [];
      renderAll();
    } else if (msg.type === 'deviceRow') {
      // Single-card update after an op on one device — the keyed reconcile in
      // renderAll() rebuilds only the card whose data changed.
      const i = rows.findIndex((r) => r.serial === msg.row.serial);
      if (i >= 0) rows[i] = msg.row; else rows.push(msg.row);
      renderAll();
    } else if (msg.type === 'setTab') {
      tabs.show(msg.tab);
    } else if (msg.type === 'loading') {
      if (document.getElementById('devList').children.length === 0) pkLoadingStart(document.getElementById('devEmpty'));
      pkServerOnMessage(srvList, srvEmpty, srvCfg, msg);
    } else {
      pkServerOnMessage(srvList, srvEmpty, srvCfg, msg);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
