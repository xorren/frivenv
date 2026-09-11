import * as vscode from "vscode";
import { findInterpreters } from "./pythonFinder";
import { findAdbCli } from "./adb";

export interface EnvStatus {
  /** Did the `py` launcher turn up at least one Python interpreter? (needed to create profiles) */
  pyOk: boolean;
  /** Did we find an `adb` executable? (needed for Android device management) */
  adbOk: boolean;
}

/**
 * Checks whether `py` and `adb` are present and reflects the result into context
 * keys, so a first run doesn't just dead-end. `viewsWelcome` watches
 * `frivenv:pyMissing` / `frivenv:adbMissing` and shows guidance when either is set.
 * iOS has no external tool, so it isn't checked here.
 */
export async function checkEnv(): Promise<EnvStatus> {
  const pyOk = findInterpreters().length > 0;
  const adbOk = Boolean(await findAdbCli());
  await vscode.commands.executeCommand("setContext", "frivenv:pyMissing", !pyOk);
  await vscode.commands.executeCommand("setContext", "frivenv:adbMissing", !adbOk);
  return { pyOk, adbOk };
}
