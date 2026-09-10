import * as fs from "fs";
import * as net from "net";
import { Client, ConnectConfig } from "ssh2";
import { t } from "./i18n";

/**
 * SSH to (jailbroken) iOS devices. Connects with the pure-JS ssh2 library, so no
 * external ssh/scp/plink/pscp. Password and private key both work, with modern crypto.
 */

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  /** Private key file path. If set, key auth; otherwise connect with `password`. */
  keyPath?: string;
  /** Password. Stored in plain text in ios-devices.json. */
  password?: string;
}

export interface RunningFridaServerInfo {
  running: boolean;
  pid?: string;
  path?: string;
  version?: string;
}

export class SshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshError";
  }
}

/** Whether we can connect to this target unattended (host + key or password). */
export function canAutomate(target: SshTarget): boolean {
  const hasHost = !!target.host && target.host.trim().length > 0;
  const hasAuth = !!(target.keyPath && target.keyPath.trim()) || !!target.password;
  return hasHost && hasAuth;
}

function friendlyMessage(raw: string): string {
  if (/all configured authentication methods failed/i.test(raw)) {
    return t("ssh.err.authFailed");
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return t("ssh.err.refused");
  }
  if (/ETIMEDOUT|timed? out/i.test(raw)) {
    return t("ssh.err.timeout");
  }
  if (/ENOTFOUND|EHOSTUNREACH|getaddrinfo/i.test(raw)) {
    return t("ssh.err.hostNotFound");
  }
  return raw;
}

function connectConfig(target: SshTarget): ConnectConfig {
  const cfg: ConnectConfig = {
    host: target.host.trim(),
    port: target.port || 22,
    username: target.user && target.user.trim() ? target.user.trim() : "root",
    readyTimeout: 12000,
    keepaliveInterval: 0,
  };
  if (target.keyPath && target.keyPath.trim()) {
    cfg.privateKey = fs.readFileSync(target.keyPath.trim());
  } else if (target.password) {
    cfg.password = target.password;
    cfg.tryKeyboard = true; // in case the server only offers keyboard-interactive
  }
  return cfg;
}

/**
 * One pooled SSH connection per target, reused across commands and closed a few
 * seconds after the last one finishes. Opening panels fires ~8 probes per device;
 * without pooling each is a fresh TCP + curve25519 handshake to a phone, and the
 * first cold one routinely blows a tight per-command timeout. With the pool the
 * whole burst rides one handshake.
 */
interface PooledConn {
  connecting: Promise<Client> | null;
  conn: Client | null;
  refs: number;
  idle: ReturnType<typeof setTimeout> | null;
}
const sshPool = new Map<string, PooledConn>();
const poolKey = (t: SshTarget) => `${(t.user || "root").trim()}@${t.host.trim()}:${t.port || 22}`;

function evictPooled(key: string): void {
  const p = sshPool.get(key);
  if (!p) return;
  sshPool.delete(key);
  if (p.idle) clearTimeout(p.idle);
  if (p.conn) {
    try {
      p.conn.end();
    } catch {
      // ignore
    }
  }
}

function acquireConn(target: SshTarget): Promise<Client> {
  const key = poolKey(target);
  let p = sshPool.get(key);
  if (!p) {
    p = { connecting: null, conn: null, refs: 0, idle: null };
    sshPool.set(key, p);
  }
  if (p.idle) {
    clearTimeout(p.idle);
    p.idle = null;
  }
  p.refs++;
  if (p.conn) return Promise.resolve(p.conn);
  if (p.connecting) return p.connecting;

  const entry = p;
  entry.connecting = new Promise<Client>((resolve, reject) => {
    let cfg: ConnectConfig;
    try {
      cfg = connectConfig(target);
    } catch (err) {
      evictPooled(key);
      reject(new SshError(t("ssh.err.keyRead", (err as Error).message)));
      return;
    }
    const conn = new Client();
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      evictPooled(key);
      reject(e instanceof SshError ? e : new SshError(friendlyMessage(e.message)));
    };
    conn.on("ready", () => {
      if (settled) return;
      settled = true;
      if (sshPool.get(key) === entry) {
        entry.conn = conn;
        entry.connecting = null;
      }
      resolve(conn);
    });
    conn.on("keyboard-interactive", (_n, _i, _l, prompts, cb) => {
      cb(prompts.map(() => target.password ?? ""));
    });
    conn.on("error", fail);
    conn.on("timeout", () => fail(new SshError(t("ssh.err.connTimeout"))));
    // Server or network dropped it — make the next acquire reconnect.
    conn.on("close", () => {
      if (sshPool.get(key) === entry) evictPooled(key);
    });
    conn.on("end", () => {
      if (sshPool.get(key) === entry) evictPooled(key);
    });
    try {
      const sock = net.connect({ host: cfg.host as string, port: cfg.port as number });
      sock.setNoDelay(true);
      sock.once("error", (e) => fail(e));
      conn.connect({ ...cfg, sock, readyTimeout: 20000, keepaliveInterval: 20000 });
    } catch (e) {
      fail(e as Error);
    }
  });
  return entry.connecting;
}

function releaseConn(target: SshTarget): void {
  const key = poolKey(target);
  const p = sshPool.get(key);
  if (!p) return;
  p.refs = Math.max(0, p.refs - 1);
  if (p.refs === 0 && p.conn) {
    if (p.idle) clearTimeout(p.idle);
    p.idle = setTimeout(() => evictPooled(key), 8000);
  }
}

/** Runs the callback on a pooled connection (opening one channel per command). */
async function withConnection<T>(target: SshTarget, run: (conn: Client) => Promise<T>): Promise<T> {
  if (!canAutomate(target)) {
    throw new SshError(t("ssh.err.needConnInfo"));
  }
  const conn = await acquireConn(target);
  try {
    return await run(conn);
  } catch (e) {
    throw e instanceof SshError ? e : new SshError((e as Error).message);
  } finally {
    releaseConn(target);
  }
}

/** Drops any pooled connection to this target (used after saving new SSH info). */
export function dropPooledConnection(target: SshTarget): void {
  evictPooled(poolKey(target));
}

/**
 * Opens an ssh2 connection and hands back the live, authenticated Client (using the
 * saved key/password). Unlike withConnection this stays open — the caller owns it
 * and must call `client.end()`. Used for the interactive shell terminal.
 */
export function connectClient(target: SshTarget): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    if (!canAutomate(target)) {
      reject(new SshError(t("ssh.err.needConnInfo")));
      return;
    }
    let cfg: ConnectConfig;
    try {
      cfg = connectConfig(target);
    } catch (err) {
      reject(new SshError(t("ssh.err.keyRead", (err as Error).message)));
      return;
    }
    const conn = new Client();
    let settled = false;
    conn.on("ready", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(conn);
    });
    conn.on("keyboard-interactive", (_name, _instr, _lang, prompts, cb) => {
      cb(prompts.map(() => target.password ?? ""));
    });
    conn.on("error", (e) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new SshError(friendlyMessage(e.message)));
    });
    conn.on("timeout", () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new SshError(t("ssh.err.connTimeout")));
    });
    try {
      // Own the socket so we can disable Nagle's algorithm — with it on, single
      // keystrokes get held ~40ms waiting for an ACK, which is exactly why typing
      // in the SSH terminal feels choppy over Wi-Fi. (Per-keystroke round-trips and
      // phone Wi-Fi power-save still add unavoidable latency; this removes the worst.)
      const sock = net.connect({ host: cfg.host as string, port: cfg.port as number });
      sock.setNoDelay(true);
      sock.once("error", (e) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new SshError(friendlyMessage(e.message)));
      });
      conn.connect({ ...cfg, sock, keepaliveInterval: 20000 });
    } catch (e) {
      if (settled) {
        return;
      }
      settled = true;
      reject(new SshError(friendlyMessage((e as Error).message)));
    }
  });
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs a remote command and returns the result. Does not throw on a non-zero exit code. */
export async function execSsh(target: SshTarget, command: string, timeout = 15000): Promise<ExecResult> {
  try {
    return await execSshOnce(target, command, timeout);
  } catch (e) {
    // The first SSH round-trip after a cold start (phone radio asleep, sshd cold,
    // several probes racing on panel open) often blows a tight per-command budget.
    // One retry hits a warm connection and almost always lands.
    if (e instanceof SshError && e.message === t("ssh.err.cmdTimeout")) {
      return execSshOnce(target, command, timeout);
    }
    throw e;
  }
}

function execSshOnce(target: SshTarget, command: string, timeout: number): Promise<ExecResult> {
  return withConnection(target, (conn) =>
    new Promise<ExecResult>((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          reject(new SshError(err.message));
          return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          try {
            stream.close();
          } catch {
            // ignore
          }
          reject(new SshError(t("ssh.err.cmdTimeout")));
        }, timeout);
        stream.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
      });
    })
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Single-quote a string for POSIX sh (`'` -> `'\''`). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wraps `inner` to run as root on a non-root SSH user (`sudo -S`, password on
 * stdin) and returns a readable form for the log — `sudo sh -c "<inner>"` rather
 * than the noisy `printf … | sudo -S -p '' sh -c '…'` with escaped quotes. On a
 * root user (or no password) it's a pass-through.
 */
function rootRun(target: SshTarget, inner: string): { cmd: string; display: string } {
  const isRoot = (target.user || "root").trim() === "root";
  const pw = target.password || "";
  if (isRoot || !pw) return { cmd: inner, display: inner };
  return {
    cmd: `printf '%s\\n' ${shq(pw)} | sudo -S -p '' sh -c ${shq(inner)}`,
    display: `sudo sh -c ${JSON.stringify(inner)}`,
  };
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

interface ExecLogOpts {
  timeout?: number;
  secret?: string;
  allowFail?: boolean;
  /** A readable command to echo instead of the real one (e.g. drop the noisy
   *  `printf … | sudo -S sh -c '…'` wrapper and just show `sudo …`). */
  display?: string;
}

/**
 * Runs a command and streams a real terminal-style transcript to `onOutput`:
 *   $ <command>
 *   <stdout, verbatim>
 *   <stderr, verbatim>
 *   [exit N]        (only when non-zero)
 * so the panel's log box shows what actually ran, not a paraphrase. `secret`
 * (the SSH password) is blanked to *** in the echoed command line only.
 * Throws on a non-zero exit (after emitting the transcript) unless `allowFail`.
 */
async function execLog(
  target: SshTarget,
  command: string,
  onOutput: (line: string) => void,
  opts: ExecLogOpts = {}
): Promise<ExecResult> {
  const { timeout = 15000, secret, allowFail = false, display } = opts;
  let shown = display ?? command;
  // Blank the password in the echoed line — never let it reach the copyable log.
  if (secret) {
    shown = shown.split(shq(secret)).join("'***'");
    if (secret.length >= 6) shown = shown.split(secret).join("***");
  }
  onOutput("$ " + shown);
  const r = await execSsh(target, command, timeout);
  const emit = (block: string) =>
    block
      .replace(/\s+$/, "")
      .split(/\r?\n/)
      .forEach((l) => l.trim() && onOutput(l));
  if (r.stdout.trim()) emit(r.stdout);
  if (r.stderr.trim()) emit(r.stderr);
  if (r.code) {
    onOutput("[exit " + r.code + "]");
    if (!allowFail) {
      throw new SshError((r.stderr || r.stdout || t("ssh.err.exitCode", r.code)).trim());
    }
  }
  return r;
}

/** Uploads a local file to the remote over SFTP. */
export function sftpUpload(
  target: SshTarget,
  localPath: string,
  remotePath: string,
  timeout = 120000
): Promise<void> {
  return withConnection(target, (conn) =>
    new Promise<void>((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new SshError(err.message));
          return;
        }
        const timer = setTimeout(() => reject(new SshError(t("ssh.err.uploadTimeout"))), timeout);
        sftp.fastPut(localPath, remotePath, (e) => {
          clearTimeout(timer);
          if (e) {
            reject(new SshError(e.message));
          } else {
            resolve();
          }
        });
      });
    })
  );
}

/**
 * Whether this error is a connection failure (couldn't reach the host) rather than
 * a command that ran and returned nothing. Must not be swallowed as "not running".
 * Matches both language variants of the friendly message plus the raw error codes.
 */
export function isConnectionFailure(message: string): boolean {
  return /인증 실패|접속이 거부|시간이 초과|찾을 수 없|authentication failed|connection refused|timed out|host not found|couldn'?t agree|no matching|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(
    message
  );
}

/**
 * Inspects the running frida-server's PID / path / version.
 * (Jailbroken) iOS has no `pidof` and no `/proc`, so we pull the PID and the
 * running path together out of `ps -ax`.
 * Sample line: " 1962 ??  0:10.15 /var/jb/usr/sbin/frida-server"
 */
export async function getRunningFridaServerInfo(target: SshTarget): Promise<RunningFridaServerInfo> {
  let pid: string | undefined;
  let realPath: string | undefined;

  try {
    const { stdout } = await execSsh(target, "ps -ax | grep frida-server", 10000);
    const line = stdout
      .split(/\r?\n/)
      .find((l) => l.includes("frida-server") && !l.includes("grep") && !l.includes("ps -ax"));
    if (line) {
      const cols = line.trim().split(/\s+/);
      pid = cols.find((c) => /^\d+$/.test(c));
      realPath = cols.find((c) => c.includes("/") && c.includes("frida-server"));
    }
  } catch (err) {
    if (isConnectionFailure((err as Error).message)) {
      throw err;
    }
    // grep found nothing, etc. — ignore
  }

  if (!pid) {
    return { running: false };
  }

  let version: string | undefined;
  if (realPath) {
    try {
      const { stdout } = await execSsh(target, `'${realPath}' --version`, 10000);
      version = stdout.trim().split(/\s+/)[0] || undefined;
    } catch {
      // --version not supported
    }
  }

  return { running: true, pid, path: realPath, version };
}

/** Runs `<binary> --version` and returns the version string, or undefined. */
export async function getFridaServerBinaryVersion(
  target: SshTarget,
  remotePath: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execSsh(target, `'${remotePath}' --version`, 10000);
    return stdout.trim().split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Lists the frida-server files in the managed folder. */
export async function listInstalledFridaServerBinaries(
  target: SshTarget,
  remoteDir: string
): Promise<string[]> {
  try {
    const { stdout } = await execSsh(target, `ls '${remoteDir}' 2>/dev/null`, 10000);
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.startsWith("frida-server"));
  } catch {
    return [];
  }
}

/** Deletes one installed frida-server binary from the device. Throws if the file
 *  is verified still present, or if that check couldn't run (a bad sudo password
 *  / quirky sshd can make `rm` report success without removing anything). */
export async function deleteFridaServerBinary(
  target: SshTarget,
  remotePath: string,
  onOutput: (line: string) => void = () => {}
): Promise<void> {
  const q = shq(remotePath);
  // System folders (/var/jb/usr/sbin, /usr/sbin) are root-owned, so a plain rm as
  // `mobile` fails with "Permission denied" — escalate like install / run / kill.
  const rm = rootRun(target, `rm -f ${q}`);
  await execLog(target, rm.cmd, onOutput, {
    timeout: 10000,
    secret: target.password,
    allowFail: true,
    display: rm.display,
  });
  // Verify: "gone" (ok), "still there" (rm silently failed), "?" (check errored).
  const check = await execLog(target, `[ -e ${q} ] && echo PRESENT || echo GONE`, onOutput, {
    timeout: 8000,
    allowFail: true,
  }).catch(() => null);
  if (!check || !/GONE/.test(check.stdout)) {
    throw new SshError(t("ssh.err.deleteNoPerm"));
  }
}

/** Whether a remote path exists (file or dir). */
export async function pathExists(target: SshTarget, remotePath: string): Promise<boolean> {
  try {
    const { stdout } = await execSsh(target, `[ -e ${shq(remotePath)} ] && echo yes`, 8000);
    return stdout.includes("yes");
  } catch {
    return false;
  }
}

export async function killFridaServer(
  target: SshTarget,
  onOutput: (line: string) => void = () => {},
  pid?: string
): Promise<void> {
  // The process is named after its file (`frida-server-16.4.2`), so `killall
  // frida-server` misses it; `pkill` and `awk` aren't installed on some
  // jailbreaks. Kill the known pid directly, and sweep the rest with only
  // `ps`/`grep`/shell `read` (the `[f]` stops grep matching its own line).
  const batch = [
    ...(pid && /^\d+$/.test(pid) ? [`kill -9 ${pid}`] : []),
    // in case it's the .deb's LaunchDaemon (respawns otherwise)
    "launchctl bootout system/re.frida.server",
    "launchctl unload -w /Library/LaunchDaemons/re.frida.server.plist",
    "launchctl unload -w /var/jb/Library/LaunchDaemons/re.frida.server.plist",
    `ps ax | grep '[f]rida-server' | while read p _r; do kill -9 "$p"; done`,
  ].join("; ");

  const k = rootRun(target, batch);
  // allowFail: individual sub-commands fail even on a clean stop (nothing to
  // unload, no such process), so a non-zero exit isn't itself a failure. The
  // transcript still shows what happened — including "Operation not permitted".
  await execLog(target, k.cmd, onOutput, {
    timeout: 15000,
    secret: target.password,
    allowFail: true,
    display: k.display,
  }).catch(() => undefined);
}

/**
 * Default frida-server launch command. Jailbreak layouts differ (rootful /
 * rootless / custom), so the iOS panel lets the user override this per device.
 * Placeholders: {path} full binary path, {dir} its folder, {pw} the SSH password.
 * -l 0.0.0.0 so `frida -H <host>` can reach it from this machine (the default
 * binds to 127.0.0.1 on the device only). The `> /dev/null 2>&1 < /dev/null`
 * detaches stdio so sshd closes the exec channel immediately (otherwise a
 * *successful* launch hangs until the command timeout); `nohup … &` works on
 * every frida-server version, unlike `-D`, which older builds reject.
 * On a non-root SSH user runFridaServerBinary wraps this in `sudo -S`.
 */
export const DEFAULT_IOS_RUN_CMD = "nohup '{path}' -l 0.0.0.0 > /dev/null 2>&1 < /dev/null &";

/**
 * Substitutes {path} / {dir} / {pw} in the user-editable run command. Function
 * replacers, so a password with `$&`, `$1`, etc. isn't mangled by String.replace.
 */
function fillCmd(template: string, remotePath: string, password: string): string {
  const dir = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
  return template
    .replace(/\{path\}/g, () => remotePath)
    .replace(/\{dir\}/g, () => dir)
    .replace(/\{pw\}/g, () => password);
}

export async function pushFridaServerBinary(
  target: SshTarget,
  localBinaryPath: string,
  remotePath: string,
  onOutput: (line: string) => void
): Promise<void> {
  const remoteDir = remotePath.slice(0, remotePath.lastIndexOf("/")) || "/";
  const isRoot = (target.user || "root").trim() === "root";
  const pw = target.password || "";
  const q = shq;

  if (isRoot) {
    await execLog(target, `mkdir -p ${q(remoteDir)}`, onOutput, { timeout: 10000 });
    onOutput("# upload " + baseName(localBinaryPath) + " -> " + remotePath);
    await sftpUpload(target, localBinaryPath, remotePath, 120000);
    await execLog(target, `chmod 755 ${q(remotePath)}`, onOutput, { timeout: 10000 });
    return;
  }

  // Non-root SSH user (e.g. `mobile` on a rootless jailbreak): system folders like
  // /var/jb/usr/sbin are root-owned, so SFTP straight there fails with "Permission
  // denied". Land the binary in the user's home first, then move it into place
  // with sudo (same trick as killFridaServer).
  const stageName = `frivenv-${remotePath.slice(remotePath.lastIndexOf("/") + 1)}`;
  onOutput("# upload " + baseName(localBinaryPath) + " -> " + remotePath);
  await sftpUpload(target, localBinaryPath, stageName, 120000); // relative path -> lands in $HOME
  const { stdout } = await execSsh(target, `printf '%s' "$HOME/${stageName}"`, 8000);
  const staged = stdout.trim() || `/var/mobile/${stageName}`;

  const move = rootRun(
    target,
    `mkdir -p ${q(remoteDir)} && mv ${q(staged)} ${q(remotePath)} && chmod 755 ${q(remotePath)}`
  );
  await execLog(target, move.cmd, onOutput, { timeout: 20000, secret: pw || undefined, display: move.display });
  await execSsh(target, `rm -f ${q(staged)} 2>/dev/null`, 8000).catch(() => {});
}

export async function runFridaServerBinary(
  target: SshTarget,
  remotePath: string,
  onOutput: (line: string) => void
): Promise<RunningFridaServerInfo> {
  const tpl = DEFAULT_IOS_RUN_CMD;
  const isRoot = (target.user || "root").trim() === "root";
  const pw = target.password || "";

  const escalate = !isRoot && !!pw;
  if (!isRoot && !pw) {
    onOutput("# SSH user is not root and no password is stored for sudo — frida-server will run unprivileged and probably fail");
  }
  const sudoWrap = (inner: string): { cmd: string; display: string } =>
    escalate
      ? {
          cmd: `printf '%s\\n' ${shq(pw)} | sudo -S -p '' sh -c ${shq(inner)}`,
          display: `sudo sh -c ${JSON.stringify(inner)}`,
        }
      : { cmd: inner, display: inner };

  // A stale frida-server holding port 27042 makes the new one die with "Address
  // already in use", so make sure the old one is really gone first.
  const before = await getRunningFridaServerInfo(target).catch(
    () => ({ running: false }) as RunningFridaServerInfo
  );
  if (before.running) {
    onOutput("# frida-server already running (pid " + (before.pid || "?") + ") — stopping it first");
    await killFridaServer(target, onOutput, before.pid);
    let stillUp = true;
    for (let i = 0; i < 4 && stillUp; i++) {
      await sleep(700);
      stillUp = (
        await getRunningFridaServerInfo(target).catch(() => ({ running: false }) as RunningFridaServerInfo)
      ).running;
    }
    if (stillUp) {
      await execLog(target, "ps -ax | grep frida-server | grep -v grep", onOutput, {
        timeout: 8000,
        allowFail: true,
      }).catch(() => undefined);
      throw new SshError(t("ssh.err.killFailed"));
    }
  }

  const launch = sudoWrap(fillCmd(tpl, remotePath, pw));
  await execLog(target, launch.cmd, onOutput, { timeout: 15000, secret: pw || undefined, display: launch.display });

  // A backgrounded launch exits 0 before the server has bound. Require the poll to
  // see THIS binary with a pid different from whatever was running before.
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    const info = await getRunningFridaServerInfo(target).catch(
      () => ({ running: false }) as RunningFridaServerInfo
    );
    if (info.running && info.pid !== before.pid && (!info.path || info.path === remotePath)) {
      onOutput(
        "# frida-server up" +
          (info.version ? " (" + info.version + ")" : "") +
          (info.pid ? " pid " + info.pid : "")
      );
      // Hand back what we confirmed so the caller can update the card even if a
      // fresh probe right after this races a cold connection.
      return { running: true, pid: info.pid, path: info.path || remotePath, version: info.version };
    }
  }

  // Not detected — dump the real reason into the log: what (if anything) is
  // running, and what the binary says when run in the foreground (this is where
  // an arch mismatch / missing dylib / bad sudo password actually shows up).
  onOutput("# frida-server not detected after 6s — diagnostics:");
  await execLog(target, "ps -ax | grep frida-server | grep -v grep", onOutput, {
    timeout: 8000,
    allowFail: true,
  }).catch(() => undefined);
  const ver = sudoWrap(shq(remotePath) + " --version");
  await execLog(target, ver.cmd, onOutput, {
    timeout: 8000,
    secret: pw || undefined,
    allowFail: true,
    display: ver.display,
  }).catch(() => undefined);
  throw new SshError(t("ssh.err.serverDidNotStart"));
}

/**
 * Builds the command for an interactive SSH shell to open in a VS Code terminal.
 * Unlike the automation (status check / upload / run), an interactive shell is
 * awkward to do through ssh2, so we just use the OpenSSH `ssh` that ships with
 * Windows 10/11. With password auth the user types the password in the terminal.
 * If `ssh` is missing, the terminal shows an error.
 */
export function buildInteractiveShell(target: SshTarget): { shellPath: string; shellArgs: string[] } {
  const user = target.user && target.user.trim() ? target.user.trim() : "root";
  const args: string[] = ["-p", String(target.port || 22), "-o", "StrictHostKeyChecking=accept-new"];
  if (target.keyPath && target.keyPath.trim()) {
    args.push("-i", target.keyPath.trim());
  }
  args.push(`${user}@${target.host.trim()}`);
  return { shellPath: "ssh", shellArgs: args };
}
