import * as vscode from "vscode";
import { t } from "./i18n";
import { ProfileTreeProvider } from "./profileTreeProvider";
import { DeviceTreeProvider } from "./deviceTreeProvider";
import { IosDeviceTreeProvider } from "./iosDeviceTreeProvider";

type Category = "profiles" | "devices" | "ios";

class CategoryItem extends vscode.TreeItem {
  constructor(public readonly category: Category, label: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = `frivenvCat.${category}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/**
 * One "Frivenv" tree for the Explorer: three category rows (Profiles / Android /
 * iOS) that expand into the real per-view providers. Keeps the Explorer copy under
 * a single collapsible header instead of three loose sections. Pure delegation —
 * it holds no list logic of its own and reuses the item objects the real providers
 * build (so their inline actions still match).
 */
export class FrivenvExplorerTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly profiles: ProfileTreeProvider,
    private readonly devices: DeviceTreeProvider,
    private readonly ios: IosDeviceTreeProvider
  ) {
    for (const child of [profiles, devices, ios]) {
      child.onDidChangeTreeData(() => this._onDidChangeTreeData.fire());
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      return [
        new CategoryItem("profiles", t("tree.cat.profiles"), "symbol-namespace"),
        new CategoryItem("devices", t("tree.cat.devices"), "device-mobile"),
        new CategoryItem("ios", t("tree.cat.iosDevices"), "device-mobile"),
      ];
    }
    if (element instanceof CategoryItem) {
      if (element.category === "profiles") {
        return this.profiles.getChildren();
      }
      if (element.category === "devices") {
        return this.devices.getChildren();
      }
      return this.ios.getChildren();
    }
    return [];
  }
}
