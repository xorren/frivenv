import * as vscode from "vscode";
import { displayNameOf, loadProfiles, Profile } from "./profileStore";
import { t } from "./i18n";

export class ProfileTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: Profile) {
    super(displayNameOf(profile), vscode.TreeItemCollapsibleState.None);
    // The version combo overlaps the label, so it goes in the tooltip only, not the row.
    this.tooltip = `${displayNameOf(profile)}\n${t(
      "tree.profile.versions",
      profile.python_version,
      profile.frida_version,
      profile.frida_tools_version || "-"
    )}\n${t("tree.profile.folderName", profile.name)}\n${profile.venv_dir}`;
    this.contextValue = "fridaProfile";
    this.iconPath = new vscode.ThemeIcon("symbol-namespace");
  }
}

export class ProfileTreeProvider implements vscode.TreeDataProvider<ProfileTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly getDataDir: () => string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProfileTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProfileTreeItem[] {
    const profiles = loadProfiles(this.getDataDir());
    if (profiles.length === 0) {
      return [];
    }
    return profiles.map((p) => new ProfileTreeItem(p));
  }
}
