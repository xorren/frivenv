import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { getToolPath } from "./toolPaths";
import { t } from "./i18n";

const execFileP = promisify(execFile);

export interface AdbDevice {
  serial: string;
  state: string; // "device" | "unauthorized" | "offline" ...
}

export interface RunningFridaServerInfo {
  running: boolean;
  pid?: string;
  path?: string;
  version?: string;
}

/** Default used when a device has no custom folder set. */
export const DEFAULT_FRIDA_SERVER_REMOTE_DIR = "/data/local/tmp/frida-server";

export function remoteFridaServerPath(remoteDir: string, version: string): string {
  return `${remoteDir}/frida-server-${sanitizeVersionForFilename(version)}`;
}

function sanitizeVersionForFilename(version: string): string {
  return version.replace(/[^0-9A-Za-z.]/g, "") || "unknown";
}

/** The device dropped mid-command. Thrown in place of the raw adb error text. */
export class DeviceOfflineError extends Error {
  constructor(public readonly serial: string) {
    super(t("adb.err.deviceOffline", serial));
    this.name = "DeviceOfflineError";
  }
}

function isDeviceOfflineMessage(message: string): boolean {
  return /device '.*' not found|device offline|no devices\/emulators found/i.test(message);
}

/** Runs an adb command; turns failures that look like a dropped device into DeviceOfflineError. */
async function execAdb(
  adbPath: string,
  args: string[],
  timeout: number,
  serial: string
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileP(adbPath, args, { timeout });
  } catch (err) {
    const message = (err as Error).message;
    if (isDeviceOfflineMessage(message)) {
      throw new DeviceOfflineError(serial);
    }
    throw err;
  }
}

const rootAdbSerials = new Set<string>();

/**
 * Tries to put adbd itself into root mode with `adb root`. eng/userdebug builds
 * (Android Studio emulators, etc.) allow this, and once it works, later shell
 * commands run as root without su. Production-signed builds block it and fail
 * quietly; callers then fall back to `su -c`.
 */
async function ensureAdbRoot(adbPath: string, serial: string): Promise<boolean> {
  if (rootAdbSerials.has(serial)) {
    return true;
  }
  try {
    await execFileP(adbPath, ["-s", serial, "root"], { timeout: 10000 });
    // adbd restarts and briefly drops the connection; give it time to come back.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { stdout } = await execFileP(adbPath, ["-s", serial, "shell", "id"], { timeout: 5000 });
    if (/uid=0/.test(stdout)) {
      rootAdbSerials.add(serial);
      return true;
    }
  } catch {
    // build where `adb root` isn't allowed; fall back to su
  }
  return false;
}

/**
 * Runs a shell command that needs root.
 *
 * The emulator's stock su (toybox AOSP su) doesn't support Magisk's `su -c '<cmd>'`
 * syntax; it tries to parse `-c` as a uid and errors with "su: invalid uid/gid '-c'".
 * But emulator/eng builds can put adbd itself into root via `adb root`, so su isn't
 * needed at all there. So we try `adb root` first and only wrap in `su -c` on devices
 * where that fails (a production build on a physical device rooted with Magisk, etc.).
 */
async function execAsRoot(
  adbPath: string,
  serial: string,
  command: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  const rooted = await ensureAdbRoot(adbPath, serial);
  const shellCommand = rooted ? command : `su -c '${command}'`;
  return execAdb(adbPath, ["-s", serial, "shell", shellCommand], timeout, serial);
}

/** Runs an adb command, streaming a real transcript ($ cmd + verbatim output) to
 *  `onOutput` — the log box should show what actually ran. */
async function execAdbLog(
  adbPath: string,
  args: string[],
  timeout: number,
  serial: string,
  onOutput: (line: string) => void
): Promise<{ stdout: string; stderr: string }> {
  onOutput("$ adb " + args.join(" "));
  const r = await execAdb(adbPath, args, timeout, serial);
  const emit = (b: string) =>
    b
      .replace(/\s+$/, "")
      .split(/\r?\n/)
      .forEach((l) => l.trim() && onOutput(l));
  if (r.stdout.trim()) emit(r.stdout);
  if (r.stderr.trim()) emit(r.stderr);
  return r;
}

let cachedAdbPath: string | undefined;

/** Clears the cache when the adb path setting changes. */
export function resetAdbPathCache(): void {
  cachedAdbPath = undefined;
}

function candidateAdbPaths(): string[] {
  const candidates: string[] = [];
  const configured = getToolPath("adbPath");
  if (configured) {
    candidates.push(configured);
  }
  candidates.push("adb.exe", "adb");
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(path.join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe"));
  }
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (androidHome) {
    candidates.push(path.join(androidHome, "platform-tools", "adb.exe"));
  }
  return candidates;
}

/** Finds adb: configured path, then PATH, then common Android SDK install locations. */
export async function findAdbCli(): Promise<string | undefined> {
  if (cachedAdbPath) {
    return cachedAdbPath;
  }
  for (const candidate of candidateAdbPaths()) {
    try {
      await execFileP(candidate, ["version"], { timeout: 5000 });
      cachedAdbPath = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export async function listDevices(adbPath: string): Promise<AdbDevice[]> {
  const { stdout } = await execFileP(adbPath, ["devices"], { timeout: 10000 });
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
}

export async function getDeviceAbi(adbPath: string, serial: string): Promise<string> {
  const { stdout } = await execAdb(adbPath, ["-s", serial, "shell", "getprop", "ro.product.cpu.abi"], 10000, serial);
  return stdout.trim();
}

const ABI_TO_FRIDA_ARCH: Record<string, string> = {
  "arm64-v8a": "arm64",
  "armeabi-v7a": "arm",
  armeabi: "arm",
  x86: "x86",
  x86_64: "x86_64",
};

export function abiToFridaArch(abi: string): string | undefined {
  return ABI_TO_FRIDA_ARCH[abi];
}

/** Finds the running frida-server PID (pidof first, ps fallback). */
async function findFridaServerPid(adbPath: string, serial: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAdb(adbPath, ["-s", serial, "shell", "pidof frida-server"], 10000, serial);
    const pid = stdout.trim().split(/\s+/)[0];
    if (pid) {
      return pid;
    }
  } catch {
    // device may not have pidof; fall back to ps
  }
  try {
    const { stdout } = await execAdb(
      adbPath,
      ["-s", serial, "shell", "ps -A 2>/dev/null | grep frida-server || ps | grep frida-server"],
      10000,
      serial
    );
    const line = stdout.split(/\r?\n/).find((l) => l.includes("frida-server"));
    const pid = line?.trim().split(/\s+/)[1];
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * Inspects the running frida-server's PID / real path / version.
 * The path comes from reading the /proc/<pid>/exe symlink as root; the version
 * comes from running that binary with `--version` (safe, independent of the daemon).
 */
export async function getRunningFridaServerInfo(adbPath: string, serial: string): Promise<RunningFridaServerInfo> {
  const pid = await findFridaServerPid(adbPath, serial);
  if (!pid) {
    return { running: false };
  }

  let realPath: string | undefined;
  try {
    const { stdout } = await execAsRoot(adbPath, serial, `readlink /proc/${pid}/exe`, 10000);
    realPath = stdout.trim() || undefined;
  } catch {
    realPath = undefined;
  }

  let version: string | undefined;
  if (realPath) {
    try {
      const { stdout } = await execAdb(adbPath, ["-s", serial, "shell", `'${realPath}' --version`], 10000, serial);
      version = stdout.trim().split(/\s+/)[0] || undefined;
    } catch {
      version = undefined;
    }
  }

  return { running: true, pid, path: realPath, version };
}

/** Lists the frida-server files in the given on-device folder. */
export async function listInstalledFridaServerBinaries(
  adbPath: string,
  serial: string,
  remoteDir: string
): Promise<string[]> {
  try {
    const { stdout } = await execAdb(
      adbPath,
      ["-s", serial, "shell", `ls ${remoteDir} 2>/dev/null`],
      10000,
      serial
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.startsWith("frida-server"));
  } catch {
    return [];
  }
}

export async function killFridaServer(
  adbPath: string,
  serial: string,
  onOutput: (line: string) => void = () => {}
): Promise<void> {
  const rooted = await ensureAdbRoot(adbPath, serial).catch(() => false);
  const kill = "pkill -f frida-server; kill -9 $(pidof frida-server) 2>/dev/null";
  const shellCommand = rooted ? kill : `su -c '${kill}'`;
  await execAdbLog(adbPath, ["-s", serial, "shell", shellCommand], 10000, serial, onOutput).catch(() => {
    // may not have been running / no root; the transcript already shows why
  });
}

/** Deletes one installed frida-server binary from the device. Throws if the file
 *  is still there afterwards (rm can report success without root). */
export async function deleteFridaServerBinary(
  adbPath: string,
  serial: string,
  remotePath: string,
  onOutput: (line: string) => void = () => {}
): Promise<void> {
  const rm = `rm -f '${remotePath}'`;
  onOutput("$ adb -s " + serial + " shell su -c " + JSON.stringify(rm));
  const res = await execAsRoot(adbPath, serial, rm, 10000);
  if (res.stdout.trim()) onOutput(res.stdout.trim());
  if (res.stderr.trim()) onOutput(res.stderr.trim());

  const { stdout } = await execAsRoot(
    adbPath,
    serial,
    `[ -e '${remotePath}' ] && echo EXISTS || echo GONE`,
    10000
  ).catch(() => ({ stdout: "GONE", stderr: "" }));
  if (stdout.includes("EXISTS")) {
    throw new Error(t("ssh.err.deleteNoPerm"));
  }
}

/** Uploads a local frida-server binary to its per-version path on the device and makes it executable. */
export async function pushFridaServerBinary(
  adbPath: string,
  serial: string,
  localBinaryPath: string,
  remotePath: string,
  onOutput: (line: string) => void
): Promise<void> {
  const remoteDir = path.posix.dirname(remotePath);
  await execAdbLog(adbPath, ["-s", serial, "shell", `mkdir -p ${remoteDir}`], 10000, serial, onOutput);
  await execAdbLog(adbPath, ["-s", serial, "push", localBinaryPath, remotePath], 60000, serial, onOutput);
  await execAdbLog(adbPath, ["-s", serial, "shell", `chmod 755 ${remotePath}`], 10000, serial, onOutput);
}

/** Runs an already-uploaded frida-server binary as root in daemon mode. */
export async function runFridaServerBinary(
  adbPath: string,
  serial: string,
  remotePath: string,
  onOutput: (line: string) => void
): Promise<void> {
  // The -D (daemonize) flag only exists on newer frida-server; older versions don't
  // recognize it and fail. Use nohup + background, which works on any version.
  const rooted = await ensureAdbRoot(adbPath, serial);
  const cmd = `nohup ${remotePath} > /dev/null 2>&1 &`;
  const shellCommand = rooted ? cmd : `su -c '${cmd}'`;
  await execAdbLog(adbPath, ["-s", serial, "shell", shellCommand], 15000, serial, onOutput);
}

/**
 * Installs a local APK on the device (`adb install -r`, so it also upgrades an
 * already-installed app). With `grantPerms`, adds `-g` to grant every runtime
 * permission up front (handy for hook testing). Throws with adb's own message on failure.
 */
export async function installApk(
  adbPath: string,
  serial: string,
  apkPath: string,
  grantPerms: boolean,
  onOutput: (line: string) => void
): Promise<void> {
  onOutput(t("dw.apk.installing", path.basename(apkPath)));
  const args = ["-s", serial, "install", "-r", ...(grantPerms ? ["-g"] : []), apkPath];
  const { stdout, stderr } = await execAdbLog(adbPath, args, 180000, serial, onOutput);
  // A non-zero exit already threw above; older adb also reports failure on stdout
  // ("Failure [INSTALL_FAILED_*]") while exiting 0, and newer adb writes it to stderr.
  const out = (stdout + "\n" + stderr).trim();
  if (/Failure|Error|Exception|failed to install/i.test(out)) {
    throw new Error(out || t("dw.apk.failedGeneric"));
  }
}

/** User-installed (non-system) package names on the device, sorted. */
export async function listUserPackages(adbPath: string, serial: string): Promise<string[]> {
  const { stdout } = await execAdb(adbPath, ["-s", serial, "shell", "pm", "list", "packages", "-3"], 15000, serial);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^package:/, ""))
    .filter(Boolean)
    .sort();
}

/**
 * Pulls a package's APK(s) into `localDir/<package>/` (split APKs come as several
 * files, so they get their own folder). Returns that folder. APKs under /data/app
 * are world-readable, so no root is needed.
 */
export async function pullApk(
  adbPath: string,
  serial: string,
  pkg: string,
  localDir: string,
  onOutput: (line: string) => void
): Promise<string> {
  const { stdout } = await execAdb(adbPath, ["-s", serial, "shell", "pm", "path", pkg], 15000, serial);
  const remotePaths = stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^package:/, ""))
    .filter(Boolean);
  if (remotePaths.length === 0) {
    throw new Error(t("dw.apkPull.notFound", pkg));
  }
  const dest = path.join(localDir, pkg);
  fs.mkdirSync(dest, { recursive: true });
  for (const rp of remotePaths) {
    onOutput(t("dw.apkPull.pulling", rp.slice(rp.lastIndexOf("/") + 1)));
    await execAdb(adbPath, ["-s", serial, "pull", rp, dest], 180000, serial);
  }
  return dest;
}

/**
 * Pulls an on-device path (file or folder) to the local machine. To reach
 * app-private folders that shell can't read (`/data/data/<package>`, etc.), it
 * first checks whether adb root works and pulls directly if so; otherwise (a
 * physical rooted phone, etc.) it copies to a staging folder under /sdcard with
 * su, pulls from there, and cleans up.
 */
export async function pullPath(
  adbPath: string,
  serial: string,
  remotePath: string,
  localDir: string,
  onOutput: (line: string) => void
): Promise<void> {
  const rooted = await ensureAdbRoot(adbPath, serial);
  if (rooted) {
    onOutput(t("srv.prog.pulling", remotePath));
    await execAdb(adbPath, ["-s", serial, "pull", remotePath, localDir], 180000, serial);
    return;
  }

  const stagingPath = `/sdcard/frivenv_pull_${Date.now()}`;
  onOutput(t("srv.prog.copyTmpRoot"));
  await execAsRoot(adbPath, serial, `cp -r '${remotePath}' '${stagingPath}'`, 60000);
  try {
    onOutput(t("srv.prog.pulling", remotePath));
    await execAdb(adbPath, ["-s", serial, "pull", stagingPath, localDir], 180000, serial);
  } finally {
    await execAsRoot(adbPath, serial, `rm -rf '${stagingPath}'`, 15000).catch(() => {
      // ignore failure to clean up the staging file
    });
  }
}
