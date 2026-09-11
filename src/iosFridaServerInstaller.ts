import * as vscode from "vscode";
import * as ssh from "./ssh";
import { downloadIosFridaServer } from "./fridaServer";
import { t } from "./i18n";

export interface IosFridaServerInstallResult {
  version: string;
  path: string;
}

export interface InstallProgress {
  message: string;
  percent: number;
  /** true = a status/percent line for the progress bar only, not the copyable log. */
  bar?: boolean;
}

class CancelledError extends Error {}

/**
 * Extracts frida-server from the given frida version's .deb and uploads/runs it on
 * the iOS device over SSH. Most physical devices are 64-bit, so arch defaults to
 * "arm64". Progress is reported only through onProgress (called only once the real
 * work has started, same as the Android flow); returns undefined on cancel/failure.
 * SSH goes through the ssh2 library, so no external tool is needed.
 */
export async function installIosFridaServer(
  version: string,
  target: ssh.SshTarget,
  remoteDir: string,
  onProgress: (progress: InstallProgress) => void,
  arch: string = "arm64",
  signal?: AbortSignal
): Promise<IosFridaServerInstallResult | undefined> {
  if (!ssh.canAutomate(target)) {
    vscode.window.showErrorMessage(t("srv.err.iosNoConnInfo"));
    return undefined;
  }

  try {
    // Install just copies the binary to the device — no need to stop a running
    // server or prompt. The user starts the new one with Run when they want it.
    const files = await downloadIosFridaServer(
      version,
      arch,
      (dl) => {
        const mapped = dl.percent === undefined ? 10 : 10 + Math.round((dl.percent / 100) * 65);
        onProgress({ message: dl.message, percent: mapped });
      },
      signal
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }

    const remotePath = `${remoteDir}/frida-server-${version.replace(/[^0-9A-Za-z.]/g, "")}`;

    // Guard against clobbering a different (e.g. hand-placed) binary at this path.
    // Same version = the identical binary, so overwrite silently.
    if (await ssh.pathExists(target, remotePath)) {
      const existingVer = await ssh.getFridaServerBinaryVersion(target, remotePath).catch(() => undefined);
      if (existingVer !== version) {
        const overwrite = t("srv.action.overwrite");
        const answer = await vscode.window.showWarningMessage(
          t("srv.confirm.overwriteBinary", remotePath, existingVer || t("wc.status.versionUnknown")),
          { modal: true },
          overwrite
        );
        if (answer !== overwrite) {
          throw new CancelledError();
        }
      }
    }

    onProgress({ message: t("srv.prog.pushing"), percent: 80, bar: true });
    await ssh.pushFridaServerBinary(target, files.serverPath, remotePath, (line) =>
      onProgress({ message: line, percent: 80 })
    );

    // frida-agent.dylib is only needed for `frida -f` (spawn) — attach doesn't
    // use it. Not every .deb ships one as a standalone file; skip quietly if not.
    if (files.agentPath) {
      onProgress({ message: t("srv.prog.pushingAgent"), percent: 92, bar: true });
      await ssh.pushFridaAgent(target, files.agentPath, remoteDir, (line) =>
        onProgress({ message: line, percent: 92 })
      );
    } else {
      onProgress({ message: t("srv.warn.noAgentInDeb"), percent: 92 });
    }

    // Install only — the user starts it with Run when they want it. Auto-running
    // here just chained two failure modes together and buried the install result.
    onProgress({ message: t("srv.prog.done"), percent: 100 });
    return { version, path: remotePath };
  } catch (err) {
    if (err instanceof CancelledError || (err as Error).name === "AbortError") {
      return undefined;
    }
    const message = (err as Error).message;
    onProgress({ message: t("srv.prog.failed", message), percent: 0 });
    return undefined;
  }
}
