import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { t } from "./i18n";

/**
 * One profile as stored in profiles.json.
 *
 * name: internal id and venv folder name. A random slug ("frivenv-a1b2c3d4"); the
 *       user may type their own instead. Never changed once the venv exists
 *       (renaming a venv folder breaks pip's console scripts).
 * display_name: a free-form label the user picks; this is what the tree/UI shows.
 *       Mirrors the folder name unless the user types their own.
 */
export interface Profile {
  name: string;
  display_name?: string;
  python_executable: string;
  python_version: string;
  frida_version: string;
  frida_tools_version: string;
  venv_dir: string;
}

export function displayNameOf(profile: Profile): string {
  return profile.display_name && profile.display_name.trim().length > 0 ? profile.display_name : profile.name;
}

/**
 * Resolves which profile is a device's "companion" venv, given the device's
 * frida-server version and any profile the user pinned by name.
 * - `profile`: the one to open without asking (a valid pin, or a single version match)
 * - `matches`: every profile on that frida version (for a disambiguation pick)
 * `linkable` is true when there's anything to open at all.
 */
export function resolveCompanionProfile(
  profiles: Profile[],
  fridaVersion: string | undefined,
  pinnedName: string | undefined
): { profile?: Profile; matches: Profile[]; linkable: boolean } {
  const pinned = pinnedName ? profiles.find((p) => p.name === pinnedName) : undefined;
  const matches = fridaVersion ? profiles.filter((p) => p.frida_version === fridaVersion) : [];
  const profile = pinned ?? (matches.length === 1 ? matches[0] : undefined);
  return { profile, matches, linkable: !!pinned || matches.length > 0 };
}

/** A label safe to drop into a cmd.exe PROMPT / `venv --prompt` (no shell metacharacters). */
export function sanitizePromptLabel(label: string): string {
  return label.replace(/[()%"&|<>^]/g, "").replace(/\s+/g, " ").trim();
}

/** What should appear in `(...)` on the venv terminal prompt — the display name, not the folder id. */
export function venvPromptLabel(profile: Profile): string {
  return sanitizePromptLabel(displayNameOf(profile)) || profile.name;
}

export function profilesJsonPath(dataDir: string): string {
  return path.join(dataDir, "profiles.json");
}

export function venvsDir(dataDir: string): string {
  return path.join(dataDir, "venvs");
}

export function scriptsDir(dataDir: string): string {
  return path.join(dataDir, "scripts");
}

export function loadProfiles(dataDir: string): Profile[] {
  const file = profilesJsonPath(dataDir);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as Profile[];
  } catch {
    return [];
  }
}

export function saveProfiles(dataDir: string, profiles: Profile[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(profilesJsonPath(dataDir), JSON.stringify(profiles, null, 2), "utf-8");
}

export function addOrUpdateProfile(dataDir: string, profile: Profile): Profile[] {
  const profiles = loadProfiles(dataDir).filter((p) => p.name !== profile.name);
  profiles.push(profile);
  saveProfiles(dataDir, profiles);
  return profiles;
}

export function removeProfile(dataDir: string, name: string): Profile[] {
  const profiles = loadProfiles(dataDir).filter((p) => p.name !== name);
  saveProfiles(dataDir, profiles);
  return profiles;
}

/** Swaps a profile with its neighbour toward the top (dir -1) or bottom (dir +1). */
export function moveProfile(dataDir: string, name: string, dir: -1 | 1): Profile[] {
  const profiles = loadProfiles(dataDir);
  const i = profiles.findIndex((p) => p.name === name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= profiles.length) {
    return profiles;
  }
  [profiles[i], profiles[j]] = [profiles[j], profiles[i]];
  saveProfiles(dataDir, profiles);
  return profiles;
}

/**
 * Changes only the display name. The internal name / venv_dir (the real folder)
 * are never touched: pip's console scripts on Windows (frida.exe, ...) bake in an
 * absolute path at install time and break if the folder is moved or renamed. So
 * the physical folder name is fixed at creation and only the user-facing label
 * lives in display_name.
 */
export function setDisplayName(dataDir: string, name: string, newDisplayName: string): Profile[] {
  const profiles = loadProfiles(dataDir);
  const target = profiles.find((p) => p.name === name);
  if (!target) {
    throw new Error(t("store.err.profileNotFound", name));
  }
  target.display_name = newDisplayName.trim();
  saveProfiles(dataDir, profiles);
  return profiles;
}

/**
 * A random, opaque folder name (`frivenv-a1b2c3d4`). The folder is just an id — the
 * Python / frida / frida-tools versions live in their own fields on the profile —
 * so there's no reason to encode them in a path that can never be renamed.
 * `ensureUniqueFolderName` still guards against the (astronomically unlikely) clash.
 */
export function suggestFolderName(): string {
  return `frivenv-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Sanitizes a name (which the user may have typed) into something usable as a folder
 * name, and appends -2, -3, ... to dodge collisions with an existing profile name or
 * venv folder.
 */
export function ensureUniqueFolderName(dataDir: string, rawName: string): string {
  const cleaned = rawName.trim().replace(/[^0-9A-Za-z.\-]/g, "");
  const base = cleaned || "profile";
  const existingNames = new Set(loadProfiles(dataDir).map((p) => p.name));
  let candidate = base;
  let suffix = 2;
  while (existingNames.has(candidate) || fs.existsSync(path.join(venvsDir(dataDir), candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function resolveVenvDir(dataDir: string, profile: Profile): string {
  return profile.venv_dir || path.join(venvsDir(dataDir), profile.name);
}

/** A venv folder under venvs/ that isn't registered as a profile, with what we can read back off disk. */
export interface ImportableVenv {
  name: string;
  venvDir: string;
  pythonExecutable: string;
  pythonVersion: string;
  fridaVersion: string;
  fridaToolsVersion: string;
}

function readPyvenvCfg(venvDir: string): { home?: string; executable?: string; version?: string } {
  try {
    const txt = fs.readFileSync(path.join(venvDir, "pyvenv.cfg"), "utf-8");
    const get = (k: string): string | undefined => {
      const m = new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, "im").exec(txt);
      return m ? m[1] : undefined;
    };
    return { home: get("home"), executable: get("executable"), version: get("version") };
  } catch {
    return {};
  }
}

/** Reads an installed package version from its `<pkg>-<ver>.dist-info` folder name. */
function distInfoVersion(venvDir: string, distName: string): string {
  try {
    const re = new RegExp(`^${distName}-(\\d[^-]*)\\.dist-info$`, "i");
    for (const d of fs.readdirSync(path.join(venvDir, "Lib", "site-packages"))) {
      const m = re.exec(d);
      if (m) {
        return m[1];
      }
    }
  } catch {
    // no site-packages / can't read — leave blank
  }
  return "";
}

export interface VenvInfo {
  pythonExecutable: string;
  pythonVersion: string;
  fridaVersion: string;
  fridaToolsVersion: string;
}

/**
 * Reads back what we can about a venv folder (versions from pyvenv.cfg + the
 * dist-info folders — no network, no running pip). Returns null if `venvDir`
 * doesn't look like a venv.
 */
export function readVenvInfo(venvDir: string): VenvInfo | null {
  const python = path.join(venvDir, "Scripts", "python.exe");
  if (!fs.existsSync(python)) {
    return null;
  }
  const cfg = readPyvenvCfg(venvDir);
  return {
    pythonExecutable: cfg.executable || (cfg.home ? path.join(cfg.home, "python.exe") : python),
    pythonVersion: cfg.version ? cfg.version.split(".").slice(0, 2).join(".") : "",
    fridaVersion: distInfoVersion(venvDir, "frida"),
    fridaToolsVersion: distInfoVersion(venvDir, "frida_tools"),
  };
}

/**
 * Finds venv folders under venvs/ that have a Python but no matching profile entry
 * (e.g. a profile that was removed from the list, or a venv made by hand).
 */
export function findImportableVenvs(dataDir: string): ImportableVenv[] {
  const base = venvsDir(dataDir);
  if (!fs.existsSync(base)) {
    return [];
  }
  const known = new Set(loadProfiles(dataDir).map((p) => p.name));
  const out: ImportableVenv[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) {
      continue;
    }
    const venvDir = path.join(base, entry.name);
    const info = readVenvInfo(venvDir);
    if (info) {
      out.push({ name: entry.name, venvDir, ...info });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function venvActivateBat(dataDir: string, profile: Profile): string {
  return path.join(resolveVenvDir(dataDir, profile), "Scripts", "activate.bat");
}
