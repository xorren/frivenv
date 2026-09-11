import * as vscode from "vscode";
import * as adb from "./adb";
import { downloadFridaServer } from "./fridaServer";
import { Profile } from "./profileStore";
import { t } from "./i18n";

export interface FridaServerInstallResult {
  serial: string;
  version: string;
  path: string;
}

export interface InstallProgress {
  message: string;
  /** Always a real 0-100 value for the current step; no fake filler animation. */
  percent: number;
  /** true = a status/percent line for the progress bar only, not the copyable log. */
  bar?: boolean;
}

/**
 * Installs and starts the frida-server matching the selected profile's frida
 * version on a connected rooted phone. Pass preselectedSerial to skip the device
 * picker and target that device directly (an error if it's disconnected).
 * Progress is reported only through onProgress (no repeated logging); the caller
 * (a webview, etc.) displays it however it wants.
 *
 * Returns the installed version/path on success, or undefined on cancel/failure.
 */
export async function installFridaServerForProfile(
  profile: Profile,
  onProgress: (progress: InstallProgress) => void,
  preselectedSerial?: string,
  remoteDir: string = adb.DEFAULT_FRIDA_SERVER_REMOTE_DIR,
  signal?: AbortSignal
): Promise<FridaServerInstallResult | undefined> {
  if (!profile.frida_version) {
    vscode.window.showErrorMessage(t("srv.err.noFridaVersion"));
    return undefined;
  }

  const adbPath = await adb.findAdbCli();
  if (!adbPath) {
    vscode.window.showErrorMessage(
      t("srv.err.adbNotFoundHint")
    );
    return undefined;
  }

  const devices = await adb.listDevices(adbPath);
  const online = devices.filter((d) => d.state === "device");

  let target: adb.AdbDevice | undefined;
  if (preselectedSerial) {
    target = online.find((d) => d.serial === preselectedSerial);
    if (!target) {
      vscode.window.showErrorMessage(t("srv.err.deviceNotReady", preselectedSerial));
      return undefined;
    }
  } else if (online.length === 0) {
    const hint =
      devices.length > 0
        ? t("srv.err.detectedHint", devices.map((d) => `${d.serial}:${d.state}`).join(", "))
        : "";
    vscode.window.showErrorMessage(t("srv.err.noAuthorizedDevice", hint));
    return undefined;
  } else if (online.length === 1) {
    target = online[0];
  } else {
    const picked = await vscode.window.showQuickPick(
      online.map((d) => ({ label: d.serial, description: d.state, device: d })),
      { title: t("srv.pick.installDeviceTitle") }
    );
    if (!picked) {
      return undefined;
    }
    target = picked.device;
  }

  try {
    // Don't call onProgress until the arch check is done — the real install work
    // hasn't started yet. Install just copies the binary; it doesn't stop a
    // running server or prompt (the user starts the new one with Run).
    const abi = await adb.getDeviceAbi(adbPath, target.serial);
    const arch = adb.abiToFridaArch(abi);
    if (!arch) {
      throw new Error(t("srv.err.badArch", abi));
    }

    // Real work starts here. The download maps its actual byte ratio onto the 10-85% band.
    const localPath = await downloadFridaServer(
      profile.frida_version,
      arch,
      (dl) => {
        const mapped = dl.percent === undefined ? 10 : 10 + Math.round((dl.percent / 100) * 75);
        onProgress({ message: dl.message, percent: mapped });
      },
      signal
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }

    const remotePath = adb.remoteFridaServerPath(remoteDir, profile.frida_version);
    onProgress({ message: t("srv.prog.pushing"), percent: 95, bar: true });
    await adb.pushFridaServerBinary(adbPath, target.serial, localPath, remotePath, (line) =>
      onProgress({ message: line, percent: 95 })
    );

    // Install only — the user starts it with Run. (Matches the iOS flow.)
    onProgress({ message: t("srv.prog.done"), percent: 100 });
    return { serial: target.serial, version: profile.frida_version, path: remotePath };
  } catch (err) {
    if (err instanceof CancelledError || (err as Error).name === "AbortError") {
      return undefined;
    }
    if (err instanceof adb.DeviceOfflineError) {
      vscode.window.showInformationMessage(t("srv.info.retryAfterRefresh", err.message));
      return undefined;
    }
    const message = (err as Error).message;
    onProgress({ message: t("srv.prog.failed", message), percent: 0 });
    return undefined;
  }
}

class CancelledError extends Error {}
