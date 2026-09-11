import { execFileSync } from "child_process";
import * as fs from "fs";
import { getToolPath } from "./toolPaths";

export interface PythonInterpreter {
  version: string;
  executable: string;
  isDefault: boolean;
}

const PY_LIST_RE = /^\s*-V:(\S+)\s+(\*)?\s*([A-Za-z]:\\.+python\.exe)\s*$/gm;

/** Runs `py -0p` (configured path, or `py` on PATH) and returns the installed Python interpreters. */
export function findInterpreters(): PythonInterpreter[] {
  const launcher = getToolPath("pythonLauncherPath") ?? "py";
  let output = "";
  try {
    output = execFileSync(launcher, ["-0p"], { encoding: "utf-8", timeout: 10000 });
  } catch {
    return [];
  }

  const interpreters: PythonInterpreter[] = [];
  let match: RegExpExecArray | null;
  PY_LIST_RE.lastIndex = 0;
  while ((match = PY_LIST_RE.exec(output)) !== null) {
    const [, tag, star, rawPath] = match;
    const executable = rawPath.trim();
    if (!fs.existsSync(executable)) {
      continue;
    }
    const versionMatch = tag.match(/(\d+\.\d+(?:\.\d+)?)/);
    interpreters.push({
      version: versionMatch ? versionMatch[1] : tag,
      executable,
      isDefault: Boolean(star),
    });
  }
  return interpreters;
}
