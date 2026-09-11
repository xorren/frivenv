import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);
import { ProfileTreeItem, ProfileTreeProvider } from "./profileTreeProvider";
import { DeviceTreeItem, DeviceTreeProvider } from "./deviceTreeProvider";
import { IosDeviceTreeItem, IosDeviceTreeProvider } from "./iosDeviceTreeProvider";
import { FrivenvExplorerTreeProvider } from "./frivenvExplorerTreeProvider";
import { openSshTerminal } from "./sshTerminal";
import { DeviceEntry, displayNameOfDevice, moveDevice } from "./deviceStore";
import { IosDeviceEntry, displayNameOfIosDevice, iosSshTarget, loadIosDevices, moveIosDevice } from "./iosDeviceStore";
import * as adb from "./adb";
import * as ssh from "./ssh";
import { displayNameOf, loadProfiles, moveProfile, Profile, resolveCompanionProfile, resolveVenvDir } from "./profileStore";
import { getOrCreateTerminalForProfile, openTerminalForProfile, resolveScriptsDir } from "./terminalManager";
import { ManageProfilesPanel } from "./webview/manageProfilesPanel";
import { ManageDevicesPanel } from "./webview/manageDevicesPanel";
import { ManageIosDevicesPanel } from "./webview/manageIosDevicesPanel";
import { checkEnv } from "./envCheck";
import { t, onLanguageChanged } from "./i18n";

interface FridaTarget {
  /** Transport option for the frida CLI: ["-U"], ["-D", serial], or ["-H", host]. */
  args: string[];
  /** adb serial when -D is used (for the frida-server version check). */
  serial?: string;
  /** SSH target when an iOS device is chosen (version check goes over SSH; frida connects with -H). */
  iosTarget?: ssh.SshTarget;
}

/** Picks a profile: 0 -> show an error and return undefined, 1 -> that one, several -> let the user choose. */
async function pickProfile(dataDir: string, title: string): Promise<Profile | undefined> {
  const profiles = loadProfiles(dataDir);
  if (profiles.length === 0) {
    vscode.window.showErrorMessage(t("cmd.err.noProfiles"));
    return undefined;
  }
  if (profiles.length === 1) {
    return profiles[0];
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: displayNameOf(p), description: p.name, profile: p })),
    { title }
  );
  return picked?.profile;
}

/** The frida-server version actually running on a device right now, or undefined. */
async function runningFridaVersion(entry: DeviceEntry | IosDeviceEntry): Promise<string | undefined> {
  try {
    if ("udid" in entry) {
      const target = iosSshTarget(entry);
      return target ? (await ssh.getRunningFridaServerInfo(target)).version : undefined;
    }
    const adbPath = await adb.findAdbCli();
    return adbPath ? (await adb.getRunningFridaServerInfo(adbPath, entry.serial)).version : undefined;
  } catch {
    return undefined;
  }
}

/** Opens the venv terminal for a device's companion profile (its pin, or a frida-version match). */
async function openCompanionProfile(dataDir: string, entry: DeviceEntry | IosDeviceEntry): Promise<void> {
  // Auto-match against what frida-server is running now; fall back to the stored version.
  const version = (await runningFridaVersion(entry)) || entry.fridaServerVersion;
  const { profile, matches } = resolveCompanionProfile(loadProfiles(dataDir), version, entry.preferredProfile);
  let target = profile;
  if (!target) {
    if (matches.length === 0) {
      vscode.window.showWarningMessage(t("cmd.companion.none", version ?? "?"));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      matches.map((p) => ({ label: displayNameOf(p), description: `frida ${p.frida_version}`, profile: p })),
      { title: t("cmd.companion.pickTitle") }
    );
    if (!pick) {
      return;
    }
    target = pick.profile;
  }
  const venvDir = resolveVenvDir(dataDir, target);
  if (!fs.existsSync(venvDir)) {
    vscode.window.showErrorMessage(t("cmd.err.venvMissing", venvDir));
    return;
  }
  openTerminalForProfile(dataDir, target);
}

/**
 * Decides the target device for a frida command. Candidates are the connected
 * adb devices plus every registered iOS device (reached over the network with
 * -H). None -> -U (auto USB); one -> that one; several -> the user picks.
 * Returns undefined if cancelled.
 */
async function pickFridaTarget(dataDir: string): Promise<FridaTarget | undefined> {
  const adbPath = await adb.findAdbCli();
  let adbDevices: adb.AdbDevice[] = [];
  if (adbPath) {
    try {
      adbDevices = (await adb.listDevices(adbPath)).filter((d) => d.state === "device");
    } catch {
      // the adb daemon may be down; carry on with whatever we have
    }
  }
  const iosDevices = loadIosDevices(dataDir)
    .map((e) => ({ target: iosSshTarget(e), label: displayNameOfIosDevice(e) }))
    .filter((e): e is { target: ssh.SshTarget; label: string } => e.target !== undefined);

  const candidates: FridaTarget[] = [
    ...adbDevices.map((d) => ({ args: ["-D", d.serial], serial: d.serial })),
    ...iosDevices.map((d) => ({ args: ["-H", d.target.host], iosTarget: d.target })),
  ];

  if (candidates.length === 0) {
    return { args: ["-U"] };
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((c, i) => ({
      label: c.serial ?? c.iosTarget!.host,
      description: c.serial ? "Android" : "iOS",
      index: i,
    })),
    { title: t("cmd.pick.deviceTargetTitle") }
  );
  return picked ? candidates[picked.index] : undefined;
}

/**
 * Checks whether the chosen device's frida-server version matches the profile's.
 * If it's not running or the versions differ, shows a dialog; returns true only if
 * the user clicks Run. Passes silently (true) if the query can't be made.
 */
async function confirmFridaVersion(target: FridaTarget, profile: Profile): Promise<boolean> {
  let info: adb.RunningFridaServerInfo | ssh.RunningFridaServerInfo;
  let name: string;
  try {
    if (target.serial) {
      const adbPath = await adb.findAdbCli();
      if (!adbPath) {
        return true;
      }
      info = await adb.getRunningFridaServerInfo(adbPath, target.serial);
      name = target.serial;
    } else if (target.iosTarget) {
      info = await ssh.getRunningFridaServerInfo(target.iosTarget);
      name = target.iosTarget.host;
    } else {
      return true;
    }
  } catch {
    return true;
  }
  const want = profile.frida_version;
  const runBtn = t("cmd.action.run");
  if (!info.running) {
    const go = await vscode.window.showWarningMessage(
      t("cmd.confirm.serverNotRunning", name),
      { modal: true },
      runBtn
    );
    return go === runBtn;
  }
  if (want && info.version && info.version !== want) {
    const go = await vscode.window.showWarningMessage(
      t("cmd.confirm.versionMismatch", info.version, want),
      { modal: true },
      runBtn
    );
    return go === runBtn;
  }
  return true;
}

/** Resolves a bare command name to its full path via `where`, or undefined. */
async function whichPath(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where", [command], { timeout: 5000, windowsHide: true });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * On activation, writes the detected adb / py / storage paths into any blank
 * `frivenv.*` setting so the Settings UI shows what's actually in use. Only writes
 * an absolute path (never a bare "adb.exe"); a blank field keeps auto-detecting.
 * scriptsDir is left alone — it follows the open workspace and shouldn't be pinned.
 */
async function seedDetectedPaths(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("frivenv");
  const blank = (key: string): boolean => !(cfg.get<string>(key) ?? "").trim();

  // Migrate the tool paths out of the old `frivenv.tools.*` namespace (dropped so
  // the Settings screen shows one flat, ordered list).
  for (const key of ["adbPath", "pythonLauncherPath"] as const) {
    const legacy = (cfg.get<string>(`tools.${key}`) ?? "").trim();
    if (legacy && blank(key)) {
      await cfg.update(key, legacy, vscode.ConfigurationTarget.Global);
    }
  }

  if (blank("dataDir")) {
    await cfg.update("dataDir", context.globalStorageUri.fsPath, vscode.ConfigurationTarget.Global);
  }

  if (blank("adbPath")) {
    let adbPath = await adb.findAdbCli();
    if (adbPath && !path.isAbsolute(adbPath)) {
      adbPath = await whichPath(adbPath);
    }
    if (adbPath && path.isAbsolute(adbPath)) {
      await cfg.update("adbPath", adbPath, vscode.ConfigurationTarget.Global);
    }
  }

  if (blank("pythonLauncherPath")) {
    const pyPath = await whichPath("py");
    if (pyPath) {
      await cfg.update("pythonLauncherPath", pyPath, vscode.ConfigurationTarget.Global);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  /** Default location when the user has not set dataDir (the VS Code-recommended approach). */
  function getDataDir(): string {
    const configured = vscode.workspace.getConfiguration("frivenv").get<string>("dataDir");
    return configured && configured.trim().length > 0 ? configured : context.globalStorageUri.fsPath;
  }

  const treeProvider = new ProfileTreeProvider(getDataDir);
  vscode.window.registerTreeDataProvider("frivenvProfiles", treeProvider);

  const deviceTreeProvider = new DeviceTreeProvider(getDataDir);
  vscode.window.registerTreeDataProvider("frivenvDevices", deviceTreeProvider);

  const iosDeviceTreeProvider = new IosDeviceTreeProvider(getDataDir);
  vscode.window.registerTreeDataProvider("frivenvIosDevices", iosDeviceTreeProvider);

  // Optional single "Frivenv" tree in the Explorer (frivenv.showInExplorer): the
  // three views nested under one collapsible header. Delegates to the providers
  // above, so it follows their refreshes automatically.
  const explorerTreeProvider = new FrivenvExplorerTreeProvider(
    treeProvider,
    deviceTreeProvider,
    iosDeviceTreeProvider
  );
  vscode.window.registerTreeDataProvider("frivenvExplorer", explorerTreeProvider);

  // Fill blank tool-path settings with the paths we detected, so `Ctrl+,` shows
  // which adb / py / storage folder is actually in use. Clearing a field restores
  // auto-detection.
  void seedDetectedPaths(context);

  // Environment check for the first-run guidance (viewsWelcome). Fire-and-forget so activate isn't blocked.
  void checkEnv();

  // Redraw trees and re-render open manage windows when frivenv.language changes.
  context.subscriptions.push(
    onLanguageChanged(() => {
      treeProvider.refresh();
      deviceTreeProvider.refresh();
      iosDeviceTreeProvider.refresh();
      ManageProfilesPanel.relocalizeIfOpen();
      ManageDevicesPanel.relocalizeIfOpen();
      ManageIosDevicesPanel.relocalizeIfOpen();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("frivenv.dataDir")) {
        treeProvider.refresh();
      }
      if (e.affectsConfiguration("frivenv.adbPath") || e.affectsConfiguration("frivenv.pythonLauncherPath")) {
        adb.resetAdbPathCache();
        void checkEnv().then(() => {
          treeProvider.refresh();
          deviceTreeProvider.refresh();
          ManageProfilesPanel.relocalizeIfOpen();
          ManageDevicesPanel.relocalizeIfOpen();
        });
      }
    })
  );

  // Move a profile / device one slot up or down in its stored list, keeping the
  // sidebar tree and any open manage window in sync.
  const moveTreeItem = (item: unknown, dir: -1 | 1): void => {
    const d = getDataDir();
    if (item instanceof ProfileTreeItem) {
      moveProfile(d, item.profile.name, dir);
      treeProvider.refresh();
      ManageProfilesPanel.refreshIfOpen();
    } else if (item instanceof DeviceTreeItem && item.registered) {
      moveDevice(d, item.entry.serial, dir);
      deviceTreeProvider.refresh();
      ManageDevicesPanel.refreshIfOpen();
    } else if (item instanceof IosDeviceTreeItem) {
      moveIosDevice(d, item.entry.udid, dir);
      iosDeviceTreeProvider.refresh();
      ManageIosDevicesPanel.refreshIfOpen();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("frivenv.refresh", () => treeProvider.refresh()),

    vscode.commands.registerCommand("frivenv.moveItemUp", (item: unknown) => moveTreeItem(item, -1)),
    vscode.commands.registerCommand("frivenv.moveItemDown", (item: unknown) => moveTreeItem(item, 1)),

    vscode.commands.registerCommand("frivenv.showInExplorer", () =>
      vscode.workspace
        .getConfiguration("frivenv")
        .update("showInExplorer", true, vscode.ConfigurationTarget.Global)
    ),
    vscode.commands.registerCommand("frivenv.hideFromExplorer", () =>
      vscode.workspace
        .getConfiguration("frivenv")
        .update("showInExplorer", false, vscode.ConfigurationTarget.Global)
    ),

    vscode.commands.registerCommand("frivenv.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:local.frivenv")
    ),

    vscode.commands.registerCommand("frivenv.recheckEnv", async () => {
      const { pyOk, adbOk } = await checkEnv();
      treeProvider.refresh();
      deviceTreeProvider.refresh();
      const missing = [!pyOk ? "py" : undefined, !adbOk ? "adb" : undefined].filter(Boolean);
      vscode.window.showInformationMessage(
        missing.length > 0 ? t("env.recheck.stillMissing", missing.join(", ")) : t("env.recheck.allFound")
      );
    }),

    vscode.commands.registerCommand("frivenv.newProfile", () =>
      ManageProfilesPanel.show(getDataDir(), () => treeProvider.refresh(), "new")
    ),

    vscode.commands.registerCommand("frivenv.manageProfiles", () =>
      ManageProfilesPanel.show(getDataDir(), () => treeProvider.refresh())
    ),

    // The tool paths (py/adb) live directly in VS Code settings, so open the settings UI at that entry.
    vscode.commands.registerCommand("frivenv.configureProfileTools", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "frivenv.pythonLauncherPath")
    ),

    vscode.commands.registerCommand("frivenv.refreshDevices", () => deviceTreeProvider.refresh()),

    vscode.commands.registerCommand("frivenv.manageDevices", () =>
      ManageDevicesPanel.show(getDataDir(), () => deviceTreeProvider.refresh())
    ),

    vscode.commands.registerCommand("frivenv.configureDeviceTools", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "frivenv.adbPath")
    ),

    vscode.commands.registerCommand("frivenv.openDeviceShell", async (item?: DeviceTreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        vscode.window.showWarningMessage(t("cmd.err.noDeviceSelected"));
        return;
      }
      const adbPath = await adb.findAdbCli();
      if (!adbPath) {
        vscode.window.showErrorMessage(t("cmd.err.adbNotFound"));
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: `adb shell su (${displayNameOfDevice(entry)})`,
        shellPath: adbPath,
        shellArgs: ["-s", entry.serial, "shell"],
        // Don't let VS Code restore this on window reload — the device may be gone
        // by then, and `adb shell` just exits 1 with a scary notification.
        isTransient: true,
      });
      terminal.show();
      // Escalate to root with su as soon as the shell opens (assumes a rooted device).
      terminal.sendText("su");
    }),

    vscode.commands.registerCommand("frivenv.refreshIosDevices", () => iosDeviceTreeProvider.refresh()),

    vscode.commands.registerCommand("frivenv.manageIosDevices", () =>
      ManageIosDevicesPanel.show(getDataDir(), () => iosDeviceTreeProvider.refresh())
    ),

    vscode.commands.registerCommand("frivenv.openIosDeviceShell", async (item?: IosDeviceTreeItem) => {
      const entry = item?.entry;
      if (!entry || !entry.sshHost) {
        vscode.window.showWarningMessage(t("cmd.err.iosNoSsh"));
        return;
      }
      openSshTerminal(
        {
          host: entry.sshHost,
          port: entry.sshPort ?? 22,
          user: entry.sshUser && entry.sshUser.trim().length > 0 ? entry.sshUser : "root",
          keyPath: entry.sshKeyPath,
          password: entry.sshPassword,
        },
        `SSH (${displayNameOfIosDevice(entry)})`,
        !!entry.terminalManualAuth
      );
    }),

    vscode.commands.registerCommand("frivenv.runScript", async (uri?: vscode.Uri) => {
      const scriptUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!scriptUri) {
        vscode.window.showWarningMessage(t("cmd.err.noJsFile"));
        return;
      }

      const dataDir = getDataDir();
      const profile = await pickProfile(dataDir, t("cmd.pick.runProfileTitle"));
      if (!profile) {
        return;
      }

      const venvDir = resolveVenvDir(dataDir, profile);
      if (!fs.existsSync(venvDir)) {
        vscode.window.showErrorMessage(t("cmd.err.venvMissing", venvDir));
        return;
      }

      const mode = await vscode.window.showQuickPick(
        [
          { label: "spawn (-f)", description: t("cmd.pick.modeSpawnDesc"), value: "-f" as const },
          { label: "attach (-n)", description: t("cmd.pick.modeAttachDesc"), value: "-n" as const },
        ],
        { title: t("cmd.pick.modeTitle") }
      );
      if (!mode) {
        return;
      }

      const target = await vscode.window.showInputBox({
        prompt: mode.value === "-f" ? t("cmd.input.spawnTarget") : t("cmd.input.attachTarget"),
      });
      if (!target) {
        return;
      }

      const fridaTarget = await pickFridaTarget(dataDir);
      if (!fridaTarget) {
        return;
      }
      if (!(await confirmFridaVersion(fridaTarget, profile))) {
        return;
      }

      // Pass the script as a path relative to the terminal's start folder when it
      // sits under it, so the command stays short and re-runnable from history.
      const terminalCwd = resolveScriptsDir(dataDir);
      const rel = path.relative(terminalCwd, scriptUri.fsPath);
      const scriptArg = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : scriptUri.fsPath;

      const terminal = getOrCreateTerminalForProfile(dataDir, profile);
      terminal.sendText(
        `frida ${fridaTarget.args.join(" ")} ${mode.value} "${target}" -l "${scriptArg}"`
      );
    }),

    vscode.commands.registerCommand("frivenv.checkConnection", async () => {
      const dataDir = getDataDir();
      const profile = await pickProfile(dataDir, t("cmd.pick.connProfileTitle"));
      if (!profile) {
        return;
      }
      const venvDir = resolveVenvDir(dataDir, profile);
      if (!fs.existsSync(venvDir)) {
        vscode.window.showErrorMessage(t("cmd.err.venvMissing", venvDir));
        return;
      }
      const fridaTarget = await pickFridaTarget(dataDir);
      if (!fridaTarget) {
        return;
      }
      if (!(await confirmFridaVersion(fridaTarget, profile))) {
        return;
      }
      const terminal = getOrCreateTerminalForProfile(dataDir, profile);
      terminal.show();
      terminal.sendText(`frida-ps ${fridaTarget.args.join(" ")}`);
    }),

    vscode.commands.registerCommand("frivenv.openTerminal", (item?: ProfileTreeItem) => {
      const profile = item?.profile;
      if (!profile) {
        vscode.window.showWarningMessage(t("cmd.err.selectProfile"));
        return;
      }
      const venvDir = resolveVenvDir(getDataDir(), profile);
      if (!fs.existsSync(venvDir)) {
        vscode.window.showErrorMessage(t("cmd.err.venvMissing", venvDir));
        return;
      }
      openTerminalForProfile(getDataDir(), profile);
    }),

    vscode.commands.registerCommand(
      "frivenv.openProfileTerminalForDevice",
      async (item?: DeviceTreeItem | IosDeviceTreeItem) => {
        if (!item?.entry) {
          vscode.window.showWarningMessage(t("cmd.err.noDeviceSelected"));
          return;
        }
        await openCompanionProfile(getDataDir(), item.entry);
      }
    )
  );
}

export function deactivate(): void {}
