import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as ssh from "../ssh";
import {
  IosDeviceEntry,
  IosSshAuthMode,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_USER,
  addManualIosDevice,
  loadIosDevices,
  moveIosDevice,
  removeIosDevice,
  setIosDeviceNickname,
  setIosFridaServerDir,
  setIosFridaServerInfo,
  setIosDevicePreferredProfile,
  setIosSshInfo,
} from "../iosDeviceStore";
import { loadProfiles, displayNameOf as displayNameOfProfile } from "../profileStore";
import { installIosFridaServer } from "../iosFridaServerInstaller";
import { PANEL_STYLE, PANEL_KIT_JS, PK_SERVER_JS, getNonce } from "./panelKit";
import { openSshTerminal } from "../sshTerminal";
import { t, bundleFor, currentLang } from "../i18n";

export type IosPanelTab = "list" | "server";

const DEFAULT_IOS_FRIDA_SERVER_DIR = "/usr/sbin";
/** Rootless jailbreaks (Dopamine, palera1n rootless) put system binaries here. */
const ROOTLESS_FRIDA_SERVER_DIR = "/var/jb/usr/sbin";

/** The user's Downloads folder — the default target for file/IPA extraction. */
function downloadsDir(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), "Downloads"));
}
/** Filesystem-safe base name for a saved file. */
function safeFileName(s: string): string {
  return s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "app";
}

interface InstalledServerEntry {
  file: string;
  path: string;
  /** Real version from `<file> --version`, filled in when the filename doesn't carry one. */
  version?: string;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

interface IosDeviceRow {
  udid: string;
  nickname: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuthMode: IosSshAuthMode;
  sshKeyPath: string;
  sshPassword: string;
  /** Terminal opens via OS `ssh` (type password, smoother typing) instead of the ssh2 pty. */
  terminalManualAuth: boolean;
  /** Whether status check / upload / run / stop can be automated (host + key or password). */
  automation: boolean;
  /** Whether an SSH command actually reached the device on the last refresh. */
  reachable: boolean;
  /** true = still being probed; the row is shown from the stored registry meanwhile. */
  probing?: boolean;
  fridaServerVersion: string;
  fridaServerPath: string;
  fridaServerDir: string;
  running: boolean;
  runningVersion?: string;
  runningPath?: string;
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
  | { type: "devices"; rows: IosDeviceRow[]; profiles: ProfileVersion[] }
  | { type: "deviceRow"; row: IosDeviceRow }
  | { type: "loading" }
  | { type: "statusResult"; id: string; ok: boolean; running: boolean; message: string }
  | { type: "progress"; id: string; message: string; percent: number; bar?: boolean }
  | { type: "progressDone"; id: string }
  | { type: "setTab"; tab: IosPanelTab }
  | { type: "keyPathPicked"; path: string; udid?: string };

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | {
      type: "addManualDeviceForm";
      nickname: string;
      host: string;
      port: number;
      user: string;
      authMode: IosSshAuthMode;
      keyPath: string;
      password: string;
      terminalManualAuth: boolean;
    }
  | { type: "browseKeyPath"; udid?: string }
  | { type: "saveNickname"; udid: string; nickname: string }
  | {
      type: "saveSshInfo";
      udid: string;
      host: string;
      port: number;
      user: string;
      authMode: IosSshAuthMode;
      keyPath: string;
      password: string;
      terminalManualAuth: boolean;
    }
  | { type: "saveFridaServerInfo"; id: string; version: string; path: string }
  | { type: "moveDevice"; id: string; dir: number }
  | { type: "saveFridaServerDir"; id: string; dir: string }
  | { type: "savePreferredProfile"; id: string; name: string }
  | { type: "openSshTerminal"; udid: string }
  | { type: "copyPassword"; udid: string }
  | { type: "pullIpa"; udid: string }
  | { type: "remove"; udid: string }
  | { type: "checkStatus"; id: string }
  | { type: "installFridaServer"; id: string }
  | { type: "runInstalledVersion"; id: string; path: string; label: string }
  | { type: "stopFridaServer"; id: string }
  | { type: "deleteInstalledVersion"; id: string; path: string; file: string }
  | { type: "cancelServerOp"; id: string }
  | { type: "copyCommand"; command: string };

function effectiveFridaServerDir(entry: IosDeviceEntry): string {
  if (entry.fridaServerDir && entry.fridaServerDir.trim().length > 0) {
    return entry.fridaServerDir.trim();
  }
  const configured = vscode.workspace.getConfiguration("frivenv").get<string>("iosFridaServerDir");
  return configured && configured.trim().length > 0 ? configured.trim() : DEFAULT_IOS_FRIDA_SERVER_DIR;
}

function sshTargetOf(entry: IosDeviceEntry): ssh.SshTarget | undefined {
  if (!entry.sshHost || entry.sshHost.trim().length === 0) {
    return undefined;
  }
  return {
    host: entry.sshHost.trim(),
    port: entry.sshPort ?? DEFAULT_SSH_PORT,
    user: entry.sshUser && entry.sshUser.trim().length > 0 ? entry.sshUser.trim() : DEFAULT_SSH_USER,
    keyPath: entry.sshKeyPath,
    password: entry.sshPassword,
  };
}

/** Manages iOS devices added by hand from SSH info, in one window (tabs): Devices / Frida Server. */
export class ManageIosDevicesPanel {
  private static current: ManageIosDevicesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  /** Abort handles for in-flight Frida Server operations, keyed by device udid. */
  private readonly serverAbort = new Map<string, AbortController>();

  static show(dataDir: string, onChanged: () => void, initialTab: IosPanelTab = "list"): void {
    if (ManageIosDevicesPanel.current) {
      ManageIosDevicesPanel.current.panel.reveal();
      ManageIosDevicesPanel.current.post({ type: "setTab", tab: initialTab });
      ManageIosDevicesPanel.current.sendDevices();
      return;
    }
    ManageIosDevicesPanel.current = new ManageIosDevicesPanel(dataDir, onChanged, initialTab);
  }

  static refreshIfOpen(): void {
    ManageIosDevicesPanel.current?.sendDevices();
  }

  /** Re-renders the open window in the new language when frivenv.language changes. */
  static relocalizeIfOpen(): void {
    const p = ManageIosDevicesPanel.current;
    if (!p) {
      return;
    }
    p.panel.title = t("iw.windowTitle");
    p.panel.webview.html = p.renderHtml();
    void p.sendDevices();
  }

  private constructor(
    private readonly dataDir: string,
    private readonly onChanged: () => void,
    private readonly initialTab: IosPanelTab
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "frivenv.manageIosDevices",
      t("iw.windowTitle"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      for (const ac of this.serverAbort.values()) {
        ac.abort();
      }
      ManageIosDevicesPanel.current = undefined;
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

  /** A registered device row straight from the registry (no SSH probing yet). */
  private shallowRow(entry: IosDeviceEntry): IosDeviceRow {
    const target = sshTargetOf(entry);
    return {
      udid: entry.udid,
      nickname: entry.nickname ?? "",
      sshHost: entry.sshHost ?? "",
      sshPort: entry.sshPort ?? DEFAULT_SSH_PORT,
      sshUser: entry.sshUser && entry.sshUser.trim().length > 0 ? entry.sshUser : DEFAULT_SSH_USER,
      sshAuthMode: entry.sshAuthMode ?? "password",
      sshKeyPath: entry.sshKeyPath ?? "",
      sshPassword: entry.sshPassword ?? "",
      terminalManualAuth: entry.terminalManualAuth ?? false,
      automation: target ? ssh.canAutomate(target) : false,
      reachable: false,
      probing: true,
      fridaServerVersion: entry.fridaServerVersion ?? "",
      fridaServerPath: entry.fridaServerPath ?? "",
      fridaServerDir: effectiveFridaServerDir(entry),
      running: false,
      installedServers: [],
      preferredProfile: entry.preferredProfile ?? "",
    };
  }

  /**
   * Re-probes ONE device and pushes a single-card update — no whole-list refresh.
   * `known` is authoritative frida-server state the caller just confirmed (e.g.
   * the run poll succeeded); it fills in if the fresh probe races a cold
   * connection and comes back "not running".
   */
  private async refreshOneDevice(
    udid: string,
    known?: {
      running?: boolean;
      version?: string;
      path?: string;
      installed?: { file: string; path: string; version?: string };
    }
  ): Promise<void> {
    const entry = loadIosDevices(this.dataDir).find((d) => d.udid === udid);
    if (!entry) {
      await this.sendDevices();
      return;
    }
    const row = this.shallowRow(entry);
    await this.probeRow(row, entry);
    if (known?.running && !row.running) {
      row.reachable = true;
      row.running = true;
      row.runningVersion = known.version;
      row.runningPath = known.path;
    }
    if (known?.installed && !row.installedServers.some((s) => s.path === known.installed!.path)) {
      // The list probe raced a cold connection; show what we just installed anyway.
      row.reachable = true;
      row.installedServers = [...row.installedServers, known.installed];
    }
    this.post({ type: "deviceRow", row });
  }

  /** Fills a shallow row in place with SSH-probed reachability / frida-server info. */
  private async probeRow(row: IosDeviceRow, entry: IosDeviceEntry): Promise<void> {
    row.probing = false;
    const target = sshTargetOf(entry);
    if (target && row.automation) {
          try {
            // getRunningFridaServerInfo throws only on a real connection failure,
            // so reaching here means the device answered.
            const info = await ssh.getRunningFridaServerInfo(target);
            row.reachable = true;
            row.running = info.running;
            row.runningVersion = info.version;
            row.runningPath = info.path;
            if (info.version && info.path && !row.fridaServerPath) {
              setIosFridaServerInfo(this.dataDir, entry.udid, info.version, info.path);
              row.fridaServerVersion = info.version;
              row.fridaServerPath = info.path;
            }
            // The running binary's own folder is the most reliable "managed folder".
            if (info.path && (!entry.fridaServerDir || entry.fridaServerDir.trim().length === 0)) {
              row.fridaServerDir = posixDirname(info.path);
            }
          } catch {
            // a connection failure is surfaced separately by the "check status" button
          }

          const autoDir = !entry.fridaServerDir || entry.fridaServerDir.trim().length === 0;
          const safeList = (dir: string) =>
            ssh.listInstalledFridaServerBinaries(target, dir).catch(() => [] as string[]);

          let dir = row.fridaServerDir;
          let files = await safeList(dir);
          // Nothing where we looked and the user hasn't pinned a folder — check the
          // other standard spots (rootless / rootful) and use whichever has files.
          if (files.length === 0 && autoDir) {
            for (const cand of [ROOTLESS_FRIDA_SERVER_DIR, DEFAULT_IOS_FRIDA_SERVER_DIR]) {
              if (cand === dir) {
                continue;
              }
              const f = await safeList(cand);
              if (f.length > 0) {
                dir = cand;
                files = f;
                break;
              }
            }
          }
          // Nothing installed anywhere yet — default to the rootless system bin on
          // a rootless jailbreak so the first "upload" lands somewhere sane.
          if (
            files.length === 0 &&
            autoDir &&
            dir !== ROOTLESS_FRIDA_SERVER_DIR &&
            (await ssh.pathExists(target, "/var/jb"))
          ) {
            dir = ROOTLESS_FRIDA_SERVER_DIR;
          }
          // A running frida-server whose filename doesn't match "frida-server*"
          // (e.g. renamed to test123) still belongs in the list.
          if (row.runningPath && posixDirname(row.runningPath) === dir) {
            const runningFile = row.runningPath.slice(row.runningPath.lastIndexOf("/") + 1);
            if (runningFile && !files.includes(runningFile)) {
              files.push(runningFile);
            }
          }
          if (autoDir && dir !== effectiveFridaServerDir(entry)) {
            setIosFridaServerDir(this.dataDir, entry.udid, dir);
          }
          row.fridaServerDir = dir;

          row.installedServers = await Promise.all(
            files.map(async (file) => {
              const filePath = `${dir}/${file}`;
              // Trust a version already in the name; probe the rest with --version.
              const version = /^frida-server-\d/.test(file)
                ? undefined
                : await ssh.getFridaServerBinaryVersion(target, filePath);
              return { file, path: filePath, version };
            })
          );
    }
  }

  private async sendDevices(): Promise<void> {
    const entries = loadIosDevices(this.dataDir);
    const profiles = this.profileVersions();

    // Phase 1: show the registered devices straight from the registry so the SSH
    // form / Unregister work immediately, without waiting for the SSH probes.
    const rows: IosDeviceRow[] = entries.map((entry) => this.shallowRow(entry));
    if (rows.length > 0) {
      this.post({ type: "devices", rows, profiles });
    } else {
      this.post({ type: "loading" });
    }

    // Phase 2: each device's status is an independent SSH round-trip; run in parallel.
    await Promise.all(entries.map((entry, i) => this.probeRow(rows[i], entry)));
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

      case "browseKeyPath": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          title: t("iw.pickKeyFile"),
        });
        if (picked && picked.length > 0) {
          this.post({ type: "keyPathPicked", path: picked[0].fsPath, udid: msg.udid });
        }
        break;
      }

      case "addManualDeviceForm": {
        if (!msg.host.trim()) {
          vscode.window.showErrorMessage(t("iw.err.enterHost"));
          return;
        }
        const { udid } = addManualIosDevice(this.dataDir, {
          nickname: msg.nickname,
          host: msg.host,
          port: msg.port || DEFAULT_SSH_PORT,
          user: msg.user || DEFAULT_SSH_USER,
          authMode: msg.authMode,
          keyPath: msg.keyPath,
          password: msg.password,
          terminalManualAuth: msg.terminalManualAuth,
        });
        vscode.window.showInformationMessage(t("iw.added", msg.nickname.trim() || udid));
        await this.sendDevices();
        this.onChanged();
        break;
      }

      case "saveNickname":
        try {
          setIosDeviceNickname(this.dataDir, msg.udid, msg.nickname);
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
          return;
        }
        await this.refreshOneDevice(msg.udid);
        this.onChanged();
        break;

      case "saveSshInfo":
        try {
          setIosSshInfo(this.dataDir, msg.udid, {
            host: msg.host,
            port: msg.port,
            user: msg.user,
            authMode: msg.authMode,
            keyPath: msg.keyPath,
            password: msg.password,
            terminalManualAuth: msg.terminalManualAuth,
          });
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
          return;
        }
        await this.refreshOneDevice(msg.udid);
        this.onChanged();
        break;

      case "saveFridaServerInfo":
        // Persist the dropdown choice, but do NOT re-render — a re-render here is
        // what made the selection jump back while the user was reaching for a button.
        setIosFridaServerInfo(this.dataDir, msg.id, msg.version.trim(), msg.path.trim());
        break;

      case "saveFridaServerDir":
        setIosFridaServerDir(this.dataDir, msg.id, msg.dir);
        await this.refreshOneDevice(msg.id);
        break;

      case "savePreferredProfile":
        // Persist, refresh the tree (companion-terminal inline icon), and re-probe
        // the one device so BOTH tabs' cards show the new pinned profile — not just
        // the tab you changed it on.
        setIosDevicePreferredProfile(this.dataDir, msg.id, msg.name);
        this.onChanged();
        await this.refreshOneDevice(msg.id);
        break;

      case "moveDevice":
        // Reorder ios-devices.json; both tabs re-render from the new order, tree follows.
        moveIosDevice(this.dataDir, msg.id, msg.dir < 0 ? -1 : 1);
        await this.sendDevices();
        this.onChanged();
        break;

      case "openSshTerminal": {
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.udid);
        const target = entry && sshTargetOf(entry);
        if (!target) {
          vscode.window.showWarningMessage(t("iw.err.saveSshFirst"));
          return;
        }
        openSshTerminal(target, `SSH (iOS ${entry!.nickname ?? entry!.udid})`, !!entry!.terminalManualAuth);
        break;
      }

      case "copyPassword": {
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.udid);
        if (!entry?.sshPassword) {
          vscode.window.showWarningMessage(t("iw.err.noPassword"));
          return;
        }
        await vscode.env.clipboard.writeText(entry.sshPassword);
        vscode.window.showInformationMessage(t("iw.pwCopied"));
        break;
      }

      case "pullIpa": {
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.udid);
        const target = entry && sshTargetOf(entry);
        if (!target) {
          vscode.window.showErrorMessage(t("iw.err.saveSshFirst"));
          return;
        }
        let apps: ssh.InstalledApp[];
        try {
          apps = await ssh.listInstalledApps(target);
        } catch (err) {
          vscode.window.showErrorMessage(t("iw.ipa.failed", (err as Error).message));
          return;
        }
        if (apps.length === 0) {
          vscode.window.showInformationMessage(t("iw.ipa.noApps"));
          return;
        }
        const pick = await vscode.window.showQuickPick(
          apps.map((a) => ({ label: a.name, description: a.bundleId, detail: a.path, app: a })),
          {
            title: t("iw.ipa.pickTitle"),
            placeHolder: t("iw.ipa.pickPlaceholder"),
            matchOnDescription: true,
          }
        );
        if (!pick) {
          return;
        }
        const dest = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: downloadsDir(),
          openLabel: t("iw.ipa.openLabel"),
          title: t("iw.ipa.saveFolder"),
        });
        if (!dest || dest.length === 0) {
          return;
        }
        const localPath = path.join(dest[0].fsPath, safeFileName(pick.app.name) + ".ipa");
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t("iw.ipa.progressTitle", pick.app.name) },
            async (progress) => {
              await ssh.extractSideloadedIpa(target, pick.app.path, localPath, (line) =>
                progress.report({ message: line })
              );
            }
          );
          vscode.window.showInformationMessage(t("iw.ipa.saved", localPath));
        } catch (err) {
          vscode.window.showErrorMessage(t("iw.ipa.failed", (err as Error).message));
        }
        break;
      }

      case "remove": {
        const unregBtn = t("wc.action.unregister");
        const confirm = await vscode.window.showWarningMessage(
          t("wc.confirm.unregister", msg.udid),
          { modal: true },
          unregBtn
        );
        if (confirm !== unregBtn) {
          return;
        }
        removeIosDevice(this.dataDir, msg.udid);
        await this.sendDevices();
        this.onChanged();
        break;
      }

      case "checkStatus": {
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.id);
        const target = entry && sshTargetOf(entry);
        if (!target) {
          this.post({ type: "statusResult", id: msg.id, ok: false, running: false, message: t("iw.status.sshNotConfigured") });
          return;
        }
        try {
          const info = await ssh.getRunningFridaServerInfo(target);
          const serverText = info.running
            ? t("wc.status.running", info.version ?? t("wc.status.versionUnknown")) + (info.path ? ` · ${info.path}` : "")
            : t("wc.status.notRunning");
          this.post({ type: "statusResult", id: msg.id, ok: true, running: info.running, message: serverText });
          // Re-probe so the card's pill / Stop button / running line all reflect
          // what the check just found (not only when a full version+path came back).
          await this.refreshOneDevice(msg.id);
        } catch (err) {
          this.post({ type: "statusResult", id: msg.id, ok: false, running: false, message: (err as Error).message });
        }
        break;
      }

      case "installFridaServer": {
        const ac = new AbortController();
        this.serverAbort.set(msg.id, ac);
        let installed: { file: string; path: string; version?: string } | undefined;
        try {
          const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.id);
          const target = entry && sshTargetOf(entry);
          if (!target) {
            vscode.window.showErrorMessage(t("iw.err.saveSshFirst"));
            return;
          }
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
          const remoteDir = effectiveFridaServerDir(entry!);
          const result = await installIosFridaServer(
            picked.profile.frida_version,
            target,
            remoteDir,
            (p) => this.post({ type: "progress", id: msg.id, message: p.message, percent: p.percent, bar: p.bar }),
            undefined,
            ac.signal
          );
          if (result) {
            setIosFridaServerInfo(this.dataDir, msg.id, result.version, result.path);
            this.onChanged();
            installed = {
              file: result.path.slice(result.path.lastIndexOf("/") + 1),
              path: result.path,
              version: result.version,
            };
          }
        } finally {
          this.serverAbort.delete(msg.id);
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id, installed ? { installed } : undefined);
        }
        break;
      }

      case "runInstalledVersion": {
        const ac = new AbortController();
        this.serverAbort.set(msg.id, ac);
        let ran: { running: boolean; version?: string; path?: string } | undefined;
        try {
          const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.id);
          const target = entry && sshTargetOf(entry);
          if (!target) {
            vscode.window.showErrorMessage(t("iw.err.saveSshFirst"));
            return;
          }
          if (!msg.path) {
            vscode.window.showInformationMessage(t("iw.err.noInstalledVersion", msg.id));
            return;
          }
          try {
            if (ac.signal.aborted) {
              throw new Error(t("nw.log.cancelled"));
            }
            this.post({ type: "progress", id: msg.id, message: t("iw.prog.runningLabel", msg.label), percent: 70, bar: true });
            // runFridaServerBinary stops any stale server itself, into this same log.
            const info = await ssh.runFridaServerBinary(target, msg.path, (line) =>
              this.post({ type: "progress", id: msg.id, message: line, percent: 70 })
            );
            ran = { running: true, version: info.version || msg.label, path: info.path || msg.path };
            setIosFridaServerInfo(this.dataDir, msg.id, ran.version ?? msg.label, ran.path ?? msg.path);
            this.post({ type: "progress", id: msg.id, message: t("iw.prog.ranLabel", msg.label), percent: 100, bar: true });
          } catch (err) {
            this.post({ type: "progress", id: msg.id, message: t("iw.prog.runFailed", (err as Error).message), percent: 0 });
          }
          this.onChanged();
        } finally {
          this.serverAbort.delete(msg.id);
          this.post({ type: "progressDone", id: msg.id });
          await this.refreshOneDevice(msg.id, ran);
        }
        break;
      }

      case "stopFridaServer": {
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.id);
        const target = entry && sshTargetOf(entry);
        if (!target) {
          vscode.window.showErrorMessage(t("iw.err.saveSshFirst"));
          return;
        }
        try {
          this.post({ type: "progress", id: msg.id, message: t("srv.prog.killExisting"), percent: 50, bar: true });
          const cur = await ssh.getRunningFridaServerInfo(target).catch(() => undefined);
          await ssh.killFridaServer(
            target,
            (line) => this.post({ type: "progress", id: msg.id, message: line, percent: 50 }),
            cur?.running ? cur.pid : undefined
          );
          const still = await ssh.getRunningFridaServerInfo(target);
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
        const entry = loadIosDevices(this.dataDir).find((d) => d.udid === msg.id);
        const target = entry && sshTargetOf(entry);
        if (!target) {
          vscode.window.showErrorMessage(t("iw.err.saveSshFirst"));
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
          // Deleting the binary of a running server leaves a zombie process
          // (still up, but no file → "version unknown"). Stop it first.
          const cur = await ssh.getRunningFridaServerInfo(target).catch(() => undefined);
          if (cur?.running && cur.path === msg.path) {
            this.post({ type: "progress", id: msg.id, message: t("srv.prog.killExisting"), percent: 40, bar: true });
            await ssh.killFridaServer(target, log, cur.pid);
          }
          await ssh.deleteFridaServerBinary(target, msg.path, log);
          if (entry!.fridaServerPath === msg.path) {
            setIosFridaServerInfo(this.dataDir, msg.id, "", "");
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
      <div class="pk-empty" id="mgEmpty">${t("wc.noDevices")}</div>
      <div id="mgList"></div>

      <div class="pk-btnrow" id="addToggleRow" style="justify-content:center; margin-top:16px">
        <button class="pk-btn pk-btn--primary pk-btn--sm" id="addToggle">${t("iw.addToggle")}</button>
      </div>

      <div class="pk-item pk-item--accent pk-hidden" id="addForm">
        <div style="display:flex; align-items:flex-start; gap:8px; margin-bottom:4px">
          <div class="pk-section__title" style="flex:1 1 auto; margin:0">${t("iw.form.title")}</div>
          <button class="pk-iconbtn" id="regCancel" title="${t("wc.close")}" aria-label="${t("wc.close")}">✕</button>
        </div>
        <div class="pk-field"><label class="pk-field__label">${t("iw.form.nick")}</label><input class="pk-input" id="regNick" placeholder="${t("iw.form.nickPlaceholder")}" /></div>
        <div class="pk-field__label" style="margin-top:12px">${t("iw.field.sshInfo")}</div>
        <div class="pk-inlab" style="margin-top:4px">
          <span class="pk-inlab__l">${t("iw.form.host")}</span>
          <input class="pk-input" id="regHost" placeholder="${t("iw.form.hostPlaceholder")}" />
          <span class="pk-inlab__l">${t("iw.form.port")}</span>
          <input class="pk-input pk-inlab__narrow" id="regPort" value="22" />
        </div>
        <div class="pk-inlab">
          <span class="pk-inlab__l">${t("iw.form.user")}</span>
          <input class="pk-input" id="regUser" value="root" placeholder="${t("iw.form.userPlaceholder")}" />
        </div>
        <div class="pk-field__label" style="margin-top:10px">${t("iw.form.authMode")}</div>
        <div class="pk-field__hint pk-warn" style="margin-top:6px">${t("iw.warn.plaintext")}</div>
        <div class="pk-btnrow" style="margin-top:6px">
          <button class="pk-btn pk-btn--sm" id="regModePw" data-mode="password">${t("iw.auth.password")}</button>
          <button class="pk-btn pk-btn--sm" id="regModeKey" data-mode="key">${t("iw.auth.key")}</button>
        </div>
        <div class="pk-inlab pk-inlab--1 pk-hidden" id="regPwWrap"><span class="pk-inlab__l">${t("iw.auth.password")}</span><input class="pk-input" type="password" id="regPw" placeholder="${t("iw.form.pwPlaceholder")}" /></div>
        <div class="pk-inlab pk-inlab--1 pk-hidden" id="regKeyWrap"><span class="pk-inlab__l">${t("iw.form.keyPath")}</span><input class="pk-input" id="regKey" placeholder="${t("iw.form.keyPlaceholder")}" /><button class="pk-btn pk-btn--sm" id="regKeyBrowse">${t("wc.find")}</button></div>
        <label class="pk-check" title="${t("iw.form.termAutoAuthHint").replace(/"/g, "&quot;").replace(/\n/g, "&#10;")}"><input type="checkbox" id="regTermAuth" checked /> ${t("iw.form.termAutoAuth")}</label>
        <div class="pk-btnrow pk-btnrow--end">
          <button class="pk-btn pk-btn--primary" id="regAdd">${t("wc.add")}</button>
        </div>
      </div>
    </section>

    <section data-page="server" hidden>
      <div class="pk-empty" id="srvEmpty">${t("wc.noDevices")}</div>
      <div id="srvList"></div>
    </section>
  </div>

<script nonce="${nonce}">
  const L = ${JSON.stringify({ ...bundleFor("pk."), ...bundleFor("iw."), ...bundleFor("wc.") })};
${PANEL_KIT_JS}
${PK_SERVER_JS}
  const root = document.getElementById('root');
  const tabs = pkTabs(root);
  document.getElementById('refreshBtn').addEventListener('click', () => {
    if (!addForm.classList.contains('pk-hidden')) { openAddForm(false); resetAddForm(); } // cancel an in-progress add
    vscode.postMessage({ type: 'refresh' });
  });

  let rows = [];

  // ===== add-device form =====
  const addForm = document.getElementById('addForm');
  const regNick = document.getElementById('regNick');
  const regHost = document.getElementById('regHost');
  const regPort = document.getElementById('regPort');
  const regUser = document.getElementById('regUser');
  const regPw = document.getElementById('regPw');
  const regKey = document.getElementById('regKey');
  const regPwWrap = document.getElementById('regPwWrap');
  const regKeyWrap = document.getElementById('regKeyWrap');
  const regModePw = document.getElementById('regModePw');
  const regModeKey = document.getElementById('regModeKey');
  const regTermAuth = document.getElementById('regTermAuth');
  let regMode = 'password';
  function updateRegMode() {
    regModePw.classList.toggle('pk-btn--primary', regMode === 'password');
    regModeKey.classList.toggle('pk-btn--primary', regMode === 'key');
    regPwWrap.classList.toggle('pk-hidden', regMode !== 'password');
    regKeyWrap.classList.toggle('pk-hidden', regMode !== 'key');
  }
  regModePw.addEventListener('click', () => { regMode = 'password'; updateRegMode(); });
  regModeKey.addEventListener('click', () => { regMode = 'key'; updateRegMode(); });
  document.getElementById('regKeyBrowse').addEventListener('click', () => vscode.postMessage({ type: 'browseKeyPath' }));
  function resetAddForm() { regNick.value=''; regHost.value=''; regPort.value='22'; regUser.value='root'; regPw.value=''; regKey.value=''; regTermAuth.checked=true; regMode='password'; updateRegMode(); }
  const addToggleRow = document.getElementById('addToggleRow');
  // Open: hide the "+ Add" button, show the (accent-bordered) form. Close: reverse.
  function openAddForm(open) {
    addForm.classList.toggle('pk-hidden', !open);
    addToggleRow.classList.toggle('pk-hidden', open);
    if (open) addForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  document.getElementById('addToggle').addEventListener('click', () => openAddForm(true));
  document.getElementById('regCancel').addEventListener('click', () => { openAddForm(false); resetAddForm(); });
  document.getElementById('regAdd').addEventListener('click', () => {
    if (!regHost.value.trim()) { regHost.focus(); return; }
    vscode.postMessage({
      type: 'addManualDeviceForm',
      nickname: regNick.value, host: regHost.value.trim(),
      port: parseInt(regPort.value, 10) || 22, user: regUser.value.trim(),
      authMode: regMode, keyPath: regKey.value.trim(), password: regPw.value,
      terminalManualAuth: !regTermAuth.checked,
    });
    openAddForm(false);
    resetAddForm();
  });
  updateRegMode();

  // ===== shared =====
  function sshPrefix(row) {
    const kp = row.sshAuthMode === 'key' && row.sshKeyPath ? ('-i ' + row.sshKeyPath + ' ') : '';
    return 'ssh ' + kp + '-p ' + row.sshPort + ' ' + row.sshUser + '@' + row.sshHost;
  }

  // ===== Devices tab =====
  function renderManage() {
    const list = document.getElementById('mgList');
    const empty = document.getElementById('mgEmpty');
    empty.textContent = rows.length === 0 ? L['wc.noDevices'] : '';
    empty.hidden = rows.length > 0;
    list.innerHTML = '';
    rows.forEach((row, i) => {
      const item = document.createElement('div');
      item.className = 'pk-item';
      item.dataset.udid = row.udid;

      const head = document.createElement('div');
      head.className = 'pk-item__head';
      const name = document.createElement('input');
      name.className = 'pk-input';
      name.style.flex = '1 1 160px';
      name.placeholder = row.sshHost || row.udid;
      name.value = row.nickname;
      const nameToast = document.createElement('span');
      nameToast.className = 'pk-toast';
      pkBindSave(name, { value: row.nickname, onSave: (v) => vscode.postMessage({ type: 'saveNickname', udid: row.udid, nickname: v }), toastEl: nameToast });
      head.appendChild(name);
      head.appendChild(nameToast);
      const cp = iosConnPill(row);
      head.appendChild(pkPill(cp.state, cp.text));
      const mp = pkServerMatchPill(srvCfg, row);
      if (mp) head.appendChild(mp);
      head.appendChild(pkMoveBtns(row.udid, i > 0, i < rows.length - 1));
      item.appendChild(head);

      const serialRow = document.createElement('div');
      serialRow.className = 'pk-item__head';
      serialRow.style.marginTop = '8px';
      const sub = document.createElement('div');
      sub.className = 'pk-item__sub';
      sub.style.flex = '1 1 auto';
      sub.textContent = row.udid;
      serialRow.appendChild(sub);
      const rm = document.createElement('button');
      rm.className = 'pk-btn pk-btn--danger pk-btn--sm';
      rm.textContent = L['wc.item.unregister'];
      rm.addEventListener('click', () => vscode.postMessage({ type: 'remove', udid: row.udid }));
      serialRow.appendChild(rm);
      item.appendChild(serialRow);

      item.appendChild(Object.assign(document.createElement('hr'), { className: 'pk-hr' }));

      // SSH connection info (compound save)
      const lab = document.createElement('div');
      lab.className = 'pk-field__label';
      lab.style.marginTop = '10px';
      lab.textContent = L['iw.field.sshInfo'];
      item.appendChild(lab);

      // Label + input on one line ("호스트 [____] 포트 [__]", "사용자 [____]"),
      // labels in regular weight (.pk-inlab).
      const mkLab = (text) => {
        const s = document.createElement('span');
        s.className = 'pk-inlab__l';
        s.textContent = text;
        return s;
      };
      const hpRow = document.createElement('div');
      hpRow.className = 'pk-inlab';
      const host = document.createElement('input');
      host.className = 'pk-input';
      host.value = row.sshHost;
      host.placeholder = L['iw.form.hostPlaceholder'];
      const port = document.createElement('input');
      port.className = 'pk-input pk-inlab__narrow';
      port.value = String(row.sshPort);
      hpRow.append(mkLab(L['iw.form.host']), host, mkLab(L['iw.form.port']), port);
      item.appendChild(hpRow);

      const uRow = document.createElement('div');
      uRow.className = 'pk-inlab';
      const user = document.createElement('input');
      user.className = 'pk-input';
      user.value = row.sshUser;
      user.placeholder = L['iw.form.userPlaceholder'];
      uRow.append(mkLab(L['iw.form.user']), user);
      item.appendChild(uRow);

      let mode = row.sshAuthMode;
      const authLab = document.createElement('div');
      authLab.className = 'pk-field__label';
      authLab.style.marginTop = '10px';
      authLab.textContent = L['iw.form.authMode'];
      item.appendChild(authLab);

      // Plain-text warning: under the "인증 방식" label, above the mode buttons,
      // and always visible (a heads-up about storage, not a password-field hint).
      const warn = document.createElement('div');
      warn.className = 'pk-field__hint pk-warn';
      warn.style.marginTop = '6px';
      warn.textContent = L['iw.warn.plaintext'];
      item.appendChild(warn);

      const modeRow = document.createElement('div');
      modeRow.className = 'pk-btnrow';
      modeRow.style.marginTop = '6px';
      const bPw = document.createElement('button'); bPw.className = 'pk-btn pk-btn--sm'; bPw.textContent = L['iw.auth.password'];
      const bKey = document.createElement('button'); bKey.className = 'pk-btn pk-btn--sm'; bKey.textContent = L['iw.auth.key'];
      modeRow.appendChild(bPw); modeRow.appendChild(bKey);
      item.appendChild(modeRow);

      const pwRow = document.createElement('div');
      pwRow.className = 'pk-inlab pk-inlab--1';
      const pw = document.createElement('input');
      pw.className = 'pk-input'; pw.type = 'password';
      pw.placeholder = L['iw.form.pwPlaceholder']; pw.value = row.sshPassword;
      pwRow.append(mkLab(L['iw.auth.password']), pw);
      item.appendChild(pwRow);

      const keyRow = document.createElement('div');
      keyRow.className = 'pk-inlab pk-inlab--1';
      const key = document.createElement('input');
      key.className = 'pk-input pk-keypath';
      key.placeholder = L['iw.form.keyPlaceholder']; key.value = row.sshKeyPath;
      const keyBrowse = document.createElement('button');
      keyBrowse.className = 'pk-btn pk-btn--sm';
      keyBrowse.textContent = L['wc.find'];
      keyBrowse.addEventListener('click', () => vscode.postMessage({ type: 'browseKeyPath', udid: row.udid }));
      keyRow.append(mkLab(L['iw.form.keyPath']), key, keyBrowse);
      item.appendChild(keyRow);

      const termAuth = document.createElement('input');
      termAuth.type = 'checkbox';
      termAuth.checked = !row.terminalManualAuth;
      const termAuthLabel = document.createElement('label');
      termAuthLabel.className = 'pk-check';
      termAuthLabel.title = L['iw.form.termAutoAuthHint']; // full explanation on hover
      termAuthLabel.appendChild(termAuth);
      termAuthLabel.appendChild(document.createTextNode(' ' + L['iw.form.termAutoAuth']));
      item.appendChild(termAuthLabel);

      const initial = [row.sshHost, row.sshPort, row.sshUser, row.sshAuthMode, row.sshKeyPath, row.sshPassword, String(!!row.terminalManualAuth)].join('|');
      const saveRow = document.createElement('div');
      saveRow.className = 'pk-btnrow pk-btnrow--end';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'pk-btn pk-btn--primary';
      saveBtn.textContent = L['wc.save'];
      saveBtn.disabled = true;
      function dirty() {
        const now = [host.value, port.value, user.value, mode, key.value, pw.value, String(!termAuth.checked)].join('|');
        saveBtn.disabled = now === initial;
      }
      function modeUi() {
        bPw.classList.toggle('pk-btn--primary', mode === 'password');
        bKey.classList.toggle('pk-btn--primary', mode === 'key');
        keyRow.classList.toggle('pk-hidden', mode !== 'key');
        pwRow.classList.toggle('pk-hidden', mode !== 'password');
        dirty();
      }
      bPw.addEventListener('click', () => { mode = 'password'; modeUi(); });
      bKey.addEventListener('click', () => { mode = 'key'; modeUi(); });
      [host, port, user, key, pw].forEach((el) => el.addEventListener('input', dirty));
      termAuth.addEventListener('change', dirty);
      saveBtn.addEventListener('click', () => {
        if (saveBtn.disabled) return;
        vscode.postMessage({
          type: 'saveSshInfo', udid: row.udid,
          host: host.value.trim(), port: parseInt(port.value, 10) || 22, user: user.value.trim(),
          authMode: mode, keyPath: key.value.trim(), password: pw.value,
          terminalManualAuth: !termAuth.checked,
        });
      });
      const term = document.createElement('button');
      term.className = 'pk-btn';
      term.textContent = L['iw.btn.sshTerminal'];
      term.disabled = !row.sshHost;
      term.addEventListener('click', () => vscode.postMessage({ type: 'openSshTerminal', udid: row.udid }));
      pkAttachCopy(term, () => sshPrefix(row));
      const copyPw = document.createElement('button');
      copyPw.className = 'pk-btn';
      copyPw.textContent = L['iw.btn.copyPassword'];
      copyPw.disabled = !(row.sshAuthMode === 'password' && row.sshPassword);
      copyPw.addEventListener('click', () => vscode.postMessage({ type: 'copyPassword', udid: row.udid }));
      const ipa = document.createElement('button');
      ipa.className = 'pk-btn';
      ipa.textContent = L['iw.btn.pullIpa'];
      ipa.disabled = !row.automation;
      ipa.addEventListener('click', () => vscode.postMessage({ type: 'pullIpa', udid: row.udid }));
      // utility buttons first, then the primary "Save" at the right end
      saveRow.appendChild(term);
      saveRow.appendChild(copyPw);
      saveRow.appendChild(ipa);
      saveRow.appendChild(saveBtn);
      item.appendChild(saveRow);
      modeUi();

      list.appendChild(item);
    });
  }

  // ===== Frida Server tab (shared renderer) =====
  const srvList = document.getElementById('srvList');
  const srvEmpty = document.getElementById('srvEmpty');

  function srvStatusText(row) {
    if (row.running) return L['wc.status.running'].replace('{0}', row.runningVersion || L['wc.status.versionUnknown']);
    return L['wc.status.notRunning'];
  }

  // Connection state pill, shared by the device list and the Frida Server card.
  function iosConnPill(row) {
    if (!row.automation) return { state: 'miss', text: L['iw.pill.noSsh'] };
    if (row.probing) return { state: 'set', text: L['wc.loading'] };
    return row.reachable
      ? { state: 'ok', text: L['iw.pill.connected'] }
      : { state: 'miss', text: L['iw.pill.disconnected'] };
  }

  const srvCfg = {
    idKey: 'udid',
    profiles: [],
    reachable: (r) => r.automation && r.reachable,
    noReachNote: (r) => (r.automation ? L['iw.note.unreachable'] : L['iw.err.saveSshFirst']),
    optDisconnected: L['iw.opt.noAutoQuery'],
    cardTitle: (r) => r.nickname || r.sshHost || r.udid,
    headPill: (r) => iosConnPill(r),
    statusLine: (r) => srvStatusText(r),
    cmdCheck: (r) => sshPrefix(r) + ' "ps -ax | grep frida-server"',
    cmdInstall: (r) => 'scp -P ' + r.sshPort + ' frida-server-<version> ' + r.sshUser + '@' + r.sshHost + ':' + r.fridaServerDir + '/',
    cmdRun: (r, p) => sshPrefix(r) + ' "nohup ' + p + ' -l 0.0.0.0 >/dev/null 2>&1 &"',
    cmdStop: (r) => sshPrefix(r) + ' "pkill -f frida-server"',
    cmdDelete: (r, p) => sshPrefix(r) + ' "rm -f ' + p + '"',
  };

  function renderServer() {
    pkRenderServerCards(srvList, srvEmpty, rows, srvCfg);
  }

  function renderAll() { renderManage(); renderServer(); }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'devices') {
      pkLoadingStop();
      rows = msg.rows;
      srvCfg.profiles = msg.profiles || [];
      renderAll();
    } else if (msg.type === 'deviceRow') {
      // Single-card update after an op on one device — keyed reconcile in renderAll().
      const i = rows.findIndex((r) => r.udid === msg.row.udid);
      if (i >= 0) rows[i] = msg.row; else rows.push(msg.row);
      renderAll();
    } else if (msg.type === 'setTab') {
      tabs.show(msg.tab);
    } else if (msg.type === 'keyPathPicked') {
      if (msg.udid) {
        const el = document.querySelector('#mgList [data-udid="' + msg.udid + '"] input.pk-keypath');
        if (el) { el.value = msg.path; el.dispatchEvent(new Event('input')); }
      } else {
        regKey.value = msg.path;
      }
    } else if (msg.type === 'loading') {
      if (document.getElementById('mgList').children.length === 0) pkLoadingStart(document.getElementById('mgEmpty'));
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
