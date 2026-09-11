import * as vscode from "vscode";
import * as adb from "./adb";
import { DeviceEntry, displayNameOfDevice, loadDevices } from "./deviceStore";
import { loadProfiles, resolveCompanionProfile } from "./profileStore";
import { t } from "./i18n";

export class DeviceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: DeviceEntry,
    public readonly liveState: string | undefined,
    public readonly registered: boolean,
    /** true when a companion profile can be opened (pinned, or a frida-version match exists). */
    linkable = false
  ) {
    super(displayNameOfDevice(entry), vscode.TreeItemCollapsibleState.None);
    const connected = liveState === "device";
    this.description = connected
      ? registered
        ? t("tree.dev.connected")
        : t("tree.dev.connectedUnreg")
      : t("tree.dev.disconnected");
    this.tooltip = [
      displayNameOfDevice(entry),
      t("tree.dev.serial", entry.serial),
      t("tree.dev.state", liveState ?? t("tree.dev.disconnected")),
      registered ? undefined : t("tree.dev.unregisteredHint"),
      entry.fridaServerVersion
        ? t("tree.dev.fridaServer", entry.fridaServerVersion, entry.fridaServerPath ?? "-")
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    // contextValue is split so each connected/registered combo gets its own inline icons:
    // - connected + unregistered: just the "register" icon
    // - connected + registered:   just the "adb shell (su)" icon (the register icon is hidden,
    //   which stands in for "disabled" since it's already registered)
    // - disconnected:             no icons
    const base = !connected
      ? "frivenvDeviceDisconnected"
      : registered
        ? "frivenvDeviceConnectedRegistered"
        : "frivenvDeviceConnectedUnregistered";
    // "...Linked" suffix adds the "open companion profile terminal" inline icon.
    this.contextValue = linkable ? base + "Linked" : base;
    // Green phone when connected, dim phone otherwise.
    this.iconPath = connected
      ? new vscode.ThemeIcon("device-mobile", new vscode.ThemeColor("terminal.ansiGreen"))
      : new vscode.ThemeIcon("device-mobile", new vscode.ThemeColor("descriptionForeground"));
  }
}

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Latch so the "multiple devices" notice fires only on the transition, not every refresh. */
  private wasMultipleConnected = false;

  constructor(private readonly getDataDir: () => string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(): Promise<DeviceTreeItem[]> {
    const dataDir = this.getDataDir();
    const liveBySerial = new Map<string, string>();

    const adbPath = await adb.findAdbCli();
    if (adbPath) {
      try {
        const live = await adb.listDevices(adbPath);
        for (const d of live) {
          liveBySerial.set(d.serial, d.state);
        }
      } catch {
        // adb list failed; show registered devices only
      }
    }

    // Show registered devices plus any that are connected right now but not yet registered.
    // Devices no longer land in the registry the moment they connect; the user has to press
    // the inline "register" icon.
    const devices = loadDevices(dataDir);
    const profiles = loadProfiles(dataDir);
    const registeredSerials = new Set(devices.map((d) => d.serial));
    const items = devices.map(
      (entry) =>
        new DeviceTreeItem(
          entry,
          liveBySerial.get(entry.serial),
          true,
          resolveCompanionProfile(profiles, entry.fridaServerVersion, entry.preferredProfile).linkable
        )
    );
    // Registered devices stay in their devices.json order (reorder it from the
    // manage window / the row's right-click menu). Only unregistered-but-connected
    // devices are appended after, since they have no stored slot.
    for (const [serial, state] of liveBySerial) {
      if (!registeredSerials.has(serial)) {
        items.push(new DeviceTreeItem({ serial }, state, false));
      }
    }

    // With two or more devices connected, a hand-typed adb command without -s <serial> fails
    // with "more than one device/emulator", so notify once. To avoid repeating it on every
    // refresh, only fire on the transition from fewer-than-two to two-or-more.
    const connectedCount = Array.from(liveBySerial.values()).filter((state) => state === "device").length;
    if (connectedCount >= 2) {
      if (!this.wasMultipleConnected) {
        vscode.window.showInformationMessage(t("tree.dev.multipleConnected", connectedCount));
      }
      this.wasMultipleConnected = true;
    } else {
      this.wasMultipleConnected = false;
    }

    return items;
  }

  getTreeItem(element: DeviceTreeItem): vscode.TreeItem {
    return element;
  }
}
