import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { t } from "./i18n";
import { type SshTarget } from "./ssh";

/**
 * key: connect with a private key.
 * password: connect with a username/password. The password is stored in plain
 *           text in sshPassword (ios-devices.json).
 * Either mode automates status check / upload / run / stop over the ssh2 library.
 */
export type IosSshAuthMode = "key" | "password";

/** Registry of registered iOS devices. */
export interface IosDeviceEntry {
  /** Synthetic id, "manual-<hex>". */
  udid: string;
  nickname?: string;
  /** SSH connection info. An empty host means it hasn't been set up yet. */
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthMode?: IosSshAuthMode;
  /** Used only when authMode is "key". */
  sshKeyPath?: string;
  /** Used only when authMode is "password". Note: stored in plain text. */
  sshPassword?: string;
  fridaServerVersion?: string;
  fridaServerPath?: string;
  fridaServerDir?: string;
  /** Profile (by `name`) the user pinned as this device's companion venv terminal. */
  preferredProfile?: string;
  /**
   * When true, the SSH terminal opens via the OS `ssh` client (the user types the
   * password each time) instead of the built-in ssh2 pty. The OS client gets
   * VS Code's predictive local echo, so typing feels smoother over Wi-Fi.
   * Absent / false = auto-login with the saved credentials (the default).
   */
  terminalManualAuth?: boolean;
}

export interface IosSshInfoInput {
  host: string;
  port: number;
  user: string;
  authMode: IosSshAuthMode;
  keyPath: string;
  password: string;
  terminalManualAuth: boolean;
}

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_USER = "root";

export function displayNameOfIosDevice(entry: IosDeviceEntry): string {
  if (entry.nickname && entry.nickname.trim().length > 0) {
    return entry.nickname;
  }
  // The udid ("manual-xxxx") is meaningless, so fall back to the connection info.
  if (entry.sshHost) {
    return `${entry.sshUser || DEFAULT_SSH_USER}@${entry.sshHost}`;
  }
  return entry.udid;
}

/** The SSH target for an entry, or undefined when no host is set yet. */
export function iosSshTarget(entry: IosDeviceEntry): SshTarget | undefined {
  if (!entry.sshHost || entry.sshHost.trim().length === 0) {
    return undefined;
  }
  return {
    host: entry.sshHost.trim(),
    port: entry.sshPort ?? DEFAULT_SSH_PORT,
    user: entry.sshUser && entry.sshUser.trim().length > 0 ? entry.sshUser.trim() : DEFAULT_SSH_USER,
    keyPath: entry.sshKeyPath,
    password: entry.sshPassword,
  };
}

function iosDevicesJsonPath(dataDir: string): string {
  return path.join(dataDir, "ios-devices.json");
}

export function loadIosDevices(dataDir: string): IosDeviceEntry[] {
  const file = iosDevicesJsonPath(dataDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as IosDeviceEntry[];
  } catch {
    return [];
  }
}

export function saveIosDevices(dataDir: string, devices: IosDeviceEntry[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(iosDevicesJsonPath(dataDir), JSON.stringify(devices, null, 2), "utf-8");
}

/**
 * Adds a device from SSH info alone (the only way iOS devices get registered).
 * The udid is synthesized as "manual-<hex>" and used as the unique key.
 */
export function addManualIosDevice(
  dataDir: string,
  info: IosSshInfoInput & { nickname: string }
): { devices: IosDeviceEntry[]; udid: string } {
  const devices = loadIosDevices(dataDir);
  const udid = `manual-${crypto.randomBytes(4).toString("hex")}`;
  const entry: IosDeviceEntry = {
    udid,
    nickname: info.nickname.trim() || undefined,
    sshHost: info.host.trim(),
    sshPort: info.port,
    sshUser: info.user.trim(),
    sshAuthMode: info.authMode,
    sshKeyPath: info.authMode === "key" ? info.keyPath.trim() || undefined : undefined,
    sshPassword: info.authMode === "password" ? info.password || undefined : undefined,
  };
  devices.push(entry);
  saveIosDevices(dataDir, devices);
  return { devices, udid };
}

function updateIosDevice(
  dataDir: string,
  udid: string,
  mutate: (entry: IosDeviceEntry) => void
): IosDeviceEntry[] {
  const devices = loadIosDevices(dataDir);
  const target = devices.find((d) => d.udid === udid);
  if (!target) {
    throw new Error(t("store.err.iosDeviceNotFound", udid));
  }
  mutate(target);
  saveIosDevices(dataDir, devices);
  return devices;
}

export function setIosDeviceNickname(dataDir: string, udid: string, nickname: string): IosDeviceEntry[] {
  return updateIosDevice(dataDir, udid, (d) => (d.nickname = nickname.trim()));
}

export function setIosSshInfo(dataDir: string, udid: string, info: IosSshInfoInput): IosDeviceEntry[] {
  return updateIosDevice(dataDir, udid, (d) => {
    d.sshHost = info.host.trim();
    d.sshPort = info.port;
    d.sshUser = info.user.trim();
    d.sshAuthMode = info.authMode;
    // Clear the credential the current mode doesn't use, so nothing stale or plain-text lingers.
    d.sshKeyPath = info.authMode === "key" ? info.keyPath.trim() || undefined : undefined;
    d.sshPassword = info.authMode === "password" ? info.password || undefined : undefined;
    d.terminalManualAuth = info.terminalManualAuth || undefined;
  });
}

export function setIosFridaServerInfo(
  dataDir: string,
  udid: string,
  fridaServerVersion: string,
  fridaServerPath: string
): IosDeviceEntry[] {
  return updateIosDevice(dataDir, udid, (d) => {
    d.fridaServerVersion = fridaServerVersion;
    d.fridaServerPath = fridaServerPath;
  });
}

export function setIosFridaServerDir(dataDir: string, udid: string, fridaServerDir: string): IosDeviceEntry[] {
  return updateIosDevice(dataDir, udid, (d) => {
    d.fridaServerDir = fridaServerDir.trim();
  });
}

/** Pins (name) or clears (undefined) the companion profile for a device. */
export function setIosDevicePreferredProfile(
  dataDir: string,
  udid: string,
  profileName: string | undefined
): IosDeviceEntry[] {
  return updateIosDevice(dataDir, udid, (d) => {
    d.preferredProfile = profileName || undefined;
  });
}

export function removeIosDevice(dataDir: string, udid: string): IosDeviceEntry[] {
  const devices = loadIosDevices(dataDir).filter((d) => d.udid !== udid);
  saveIosDevices(dataDir, devices);
  return devices;
}

/** Swaps a device with its neighbour toward the top (dir -1) or bottom (dir +1). */
export function moveIosDevice(dataDir: string, udid: string, dir: -1 | 1): IosDeviceEntry[] {
  const devices = loadIosDevices(dataDir);
  const i = devices.findIndex((d) => d.udid === udid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= devices.length) {
    return devices;
  }
  [devices[i], devices[j]] = [devices[j], devices[i]];
  saveIosDevices(dataDir, devices);
  return devices;
}
