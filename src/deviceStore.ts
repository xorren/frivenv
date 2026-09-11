import * as fs from "fs";
import * as path from "path";
import { t } from "./i18n";

/** Registry of Android devices adb has seen at least once. */
export interface DeviceEntry {
  serial: string;
  nickname?: string;
  /** Last frida-server version installed on this device (auto-recorded on install, also editable). */
  fridaServerVersion?: string;
  /** On-device path to the frida-server binary. */
  fridaServerPath?: string;
  /** On-device folder where frida-server versions for this device are kept. Empty = use the default. */
  fridaServerDir?: string;
  /**
   * Profile (by `name`) the user pinned as this device's companion venv terminal.
   * Overrides the automatic frida-version match, which is ambiguous when two
   * profiles share a frida version (e.g. different extra pip packages).
   */
  preferredProfile?: string;
}

export function displayNameOfDevice(entry: DeviceEntry): string {
  return entry.nickname && entry.nickname.trim().length > 0 ? entry.nickname : entry.serial;
}

function devicesJsonPath(dataDir: string): string {
  return path.join(dataDir, "devices.json");
}

export function loadDevices(dataDir: string): DeviceEntry[] {
  const file = devicesJsonPath(dataDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as DeviceEntry[];
  } catch {
    return [];
  }
}

export function saveDevices(dataDir: string, devices: DeviceEntry[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(devicesJsonPath(dataDir), JSON.stringify(devices, null, 2), "utf-8");
}

/** Adds an unseen serial to the registry with no nickname. Leaves an existing one alone. */
export function registerSeenDevice(dataDir: string, serial: string): DeviceEntry[] {
  const devices = loadDevices(dataDir);
  if (devices.some((d) => d.serial === serial)) {
    return devices;
  }
  devices.push({ serial });
  saveDevices(dataDir, devices);
  return devices;
}

function updateDevice(dataDir: string, serial: string, mutate: (entry: DeviceEntry) => void): DeviceEntry[] {
  const devices = loadDevices(dataDir);
  const target = devices.find((d) => d.serial === serial);
  if (!target) {
    throw new Error(t("store.err.deviceNotFound", serial));
  }
  mutate(target);
  saveDevices(dataDir, devices);
  return devices;
}

export function setDeviceNickname(dataDir: string, serial: string, nickname: string): DeviceEntry[] {
  return updateDevice(dataDir, serial, (d) => (d.nickname = nickname.trim()));
}

export function setFridaServerInfo(
  dataDir: string,
  serial: string,
  fridaServerVersion: string,
  fridaServerPath: string
): DeviceEntry[] {
  return updateDevice(dataDir, serial, (d) => {
    d.fridaServerVersion = fridaServerVersion;
    d.fridaServerPath = fridaServerPath;
  });
}

export function setFridaServerDir(dataDir: string, serial: string, fridaServerDir: string): DeviceEntry[] {
  return updateDevice(dataDir, serial, (d) => {
    d.fridaServerDir = fridaServerDir.trim();
  });
}

/** Pins (name) or clears (undefined) the companion profile for a device. */
export function setDevicePreferredProfile(dataDir: string, serial: string, profileName: string | undefined): DeviceEntry[] {
  return updateDevice(dataDir, serial, (d) => {
    d.preferredProfile = profileName || undefined;
  });
}

export function removeDevice(dataDir: string, serial: string): DeviceEntry[] {
  const devices = loadDevices(dataDir).filter((d) => d.serial !== serial);
  saveDevices(dataDir, devices);
  return devices;
}

/** Swaps a device with its neighbour toward the top (dir -1) or bottom (dir +1). */
export function moveDevice(dataDir: string, serial: string, dir: -1 | 1): DeviceEntry[] {
  const devices = loadDevices(dataDir);
  const i = devices.findIndex((d) => d.serial === serial);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= devices.length) {
    return devices;
  }
  [devices[i], devices[j]] = [devices[j], devices[i]];
  saveDevices(dataDir, devices);
  return devices;
}
