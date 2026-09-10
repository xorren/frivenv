import * as vscode from "vscode";

/**
 * User-set paths to the external CLIs this extension shells out to, stored in
 * VS Code settings (`frivenv.adbPath` / `frivenv.pythonLauncherPath`) at global
 * (User) scope: adb and py live wherever they're installed on this machine, not
 * per workspace. Left empty (the default), we look them up on PATH / common
 * install locations. iOS SSH goes through the ssh2 library, so it isn't here.
 */
export type ToolKey = "adbPath" | "pythonLauncherPath";

export function getToolPath(key: ToolKey): string | undefined {
  const value = vscode.workspace.getConfiguration("frivenv").get<string>(key);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}
