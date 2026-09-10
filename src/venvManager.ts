import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type OutputSink = (line: string) => void;

function runStreaming(
  cmd: string,
  args: string[],
  onOutput: OutputSink,
  onProcessStarted?: (proc: ChildProcess) => void
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    onProcessStarted?.(proc);

    const forward = (chunk: Buffer) => {
      chunk
        .toString("utf-8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .forEach(onOutput);
    };

    proc.stdout.on("data", forward);
    proc.stderr.on("data", forward);
    proc.on("close", (code) => resolve(code ?? -1));
    proc.on("error", () => resolve(-1));
  });
}

export function venvPython(venvDir: string): string {
  return path.join(venvDir, "Scripts", "python.exe");
}

/**
 * Stops a spawned process and everything it started. On Windows `proc.kill()` only
 * ends the direct child (python.exe), leaving the `pip` download it spawned running,
 * so cancelling a create would appear to hang. `taskkill /T` takes the whole tree.
 */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
  } else {
    proc.kill();
  }
}

export async function createVenv(
  pythonExe: string,
  venvDir: string,
  prompt: string,
  onOutput: OutputSink,
  onProcessStarted?: (proc: ChildProcess) => void
): Promise<number> {
  fs.mkdirSync(path.dirname(venvDir), { recursive: true });
  // --prompt bakes the label into activate.bat so `(<label>)` shows even outside VS Code.
  return runStreaming(pythonExe, ["-m", "venv", "--prompt", prompt, venvDir], onOutput, onProcessStarted);
}

export async function installPackages(
  venvDir: string,
  packages: string[],
  onOutput: OutputSink,
  onProcessStarted?: (proc: ChildProcess) => void
): Promise<number> {
  const python = venvPython(venvDir);
  let rc = await runStreaming(python, ["-m", "pip", "install", "--upgrade", "pip"], onOutput, onProcessStarted);
  if (rc !== 0) {
    return rc;
  }
  rc = await runStreaming(python, ["-m", "pip", "install", ...packages], onOutput, onProcessStarted);
  return rc;
}
