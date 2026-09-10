import * as fs from "fs";
import * as vscode from "vscode";
import { Profile, displayNameOf, scriptsDir, venvActivateBat, venvPromptLabel } from "./profileStore";

/** The VS Code terminal tab label for a profile's terminal. */
function terminalNameFor(profile: Profile): string {
  return `Frivenv (${displayNameOf(profile)})`;
}

/**
 * The folder a profile terminal starts in, so `frida -l hook.js` takes a short
 * relative path instead of a long absolute one. In order of preference:
 *   1. the `frivenv.scriptsDir` setting, when set and it exists;
 *   2. the first open workspace folder;
 *   3. `dataDir/scripts` (created on demand) when neither is available.
 */
export function resolveScriptsDir(dataDir: string): string {
  const configured = vscode.workspace.getConfiguration("frivenv").get<string>("scriptsDir")?.trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspace) {
    return workspace;
  }
  const fallback = scriptsDir(dataDir);
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Opens a new integrated terminal with the profile's venv already activated.
 *
 * Rather than relying on a default terminal profile in settings.json, we set
 * shellPath/shellArgs at creation time, so the shell always comes up activated
 * regardless of any existing window/terminal state. The starting directory comes
 * from resolveScriptsDir, so `frida -l` can take a script by relative path.
 */
export function openTerminalForProfile(dataDir: string, profile: Profile): vscode.Terminal {
  const activateBat = venvActivateBat(dataDir, profile);
  const cwd = resolveScriptsDir(dataDir);

  // activate.bat puts the venv *folder* name in the prompt's `(...)`. Re-set PROMPT
  // right after so it shows the profile's display name instead (recomputed here, so
  // a later rename takes effect on the next terminal). $P$G = "<path>>".
  const activate = `${activateBat} & set PROMPT=(${venvPromptLabel(profile)}) $P$G`;

  const terminal = vscode.window.createTerminal({
    name: terminalNameFor(profile),
    shellPath: "cmd.exe",
    shellArgs: ["/K", activate],
    cwd,
  });
  terminal.show();
  return terminal;
}

/** Reuses an open terminal for this profile if there is one, otherwise opens a new one. */
export function getOrCreateTerminalForProfile(dataDir: string, profile: Profile): vscode.Terminal {
  const name = terminalNameFor(profile);
  const existing = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined);
  if (existing) {
    existing.show();
    return existing;
  }
  return openTerminalForProfile(dataDir, profile);
}
