import * as net from "net";
import * as vscode from "vscode";
import { IosDeviceEntry, displayNameOfIosDevice, loadIosDevices } from "./iosDeviceStore";
import { loadProfiles, resolveCompanionProfile } from "./profileStore";
import { t } from "./i18n";

/**
 * The iOS list only shows devices added by hand with SSH info in the "iOS devices"
 * window (no libimobiledevice auto-detect). The only inline icon is "open SSH shell".
 *
 * Like Android it shows connected / not-connected, but there's no local lookup like
 * adb, so we make a short TCP connection to the SSH port to decide. This only checks
 * that the port is open; it does not check auth.
 */
function probeSshPort(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(hardTimer);
      socket.destroy();
      resolve(ok);
    };
    const socket = net.createConnection({ host, port });
    const hardTimer = setTimeout(() => finish(false), timeoutMs + 300);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export class IosDeviceTreeItem extends vscode.TreeItem {
  /** reachable: true = port open, false = no response, undefined = SSH not set up so not checked. */
  constructor(
    public readonly entry: IosDeviceEntry,
    reachable: boolean | undefined,
    /** true when a companion profile can be opened (pinned, or a frida-version match exists). */
    linkable = false
  ) {
    super(displayNameOfIosDevice(entry), vscode.TreeItemCollapsibleState.None);
    this.description = !entry.sshHost
      ? t("tree.ios.sshNotSet")
      : reachable === undefined
        ? ""
        : reachable
          ? t("tree.dev.connected")
          : t("tree.dev.disconnected");
    this.tooltip = [
      displayNameOfIosDevice(entry),
      entry.sshHost
        ? t("tree.ios.sshTooltip", `${entry.sshUser ?? "root"}@${entry.sshHost}:${entry.sshPort ?? 22}`)
        : t("tree.ios.sshNotSet"),
      entry.fridaServerVersion
        ? t("tree.dev.fridaServer", entry.fridaServerVersion, entry.fridaServerPath ?? "-")
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    this.contextValue = linkable ? "frivenvIosDeviceLinked" : "frivenvIosDevice";
    // Same as Android: green phone if the port is open, dim phone otherwise.
    this.iconPath =
      entry.sshHost && reachable
        ? new vscode.ThemeIcon("device-mobile", new vscode.ThemeColor("terminal.ansiGreen"))
        : new vscode.ThemeIcon("device-mobile", new vscode.ThemeColor("descriptionForeground"));
  }
}

export class IosDeviceTreeProvider implements vscode.TreeDataProvider<IosDeviceTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getDataDir: () => string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(): Promise<IosDeviceTreeItem[]> {
    const entries = loadIosDevices(this.getDataDir());
    const profiles = loadProfiles(this.getDataDir());
    const reachable = await Promise.all(
      entries.map((e) =>
        e.sshHost ? probeSshPort(e.sshHost, e.sshPort ?? 22) : Promise.resolve<boolean | undefined>(undefined)
      )
    );
    return entries.map(
      (entry, i) =>
        new IosDeviceTreeItem(
          entry,
          reachable[i],
          resolveCompanionProfile(profiles, entry.fridaServerVersion, entry.preferredProfile).linkable
        )
    );
  }

  getTreeItem(element: IosDeviceTreeItem): vscode.TreeItem {
    return element;
  }
}
