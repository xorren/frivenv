import * as vscode from "vscode";
import type { Client, ClientChannel } from "ssh2";
import { SshTarget, canAutomate, buildInteractiveShell, connectClient } from "./ssh";
import { t } from "./i18n";

/**
 * A VS Code terminal backed by an ssh2 shell channel. The connection authenticates
 * with the saved key/password, so — unlike shelling out to the OS `ssh` — the user
 * never re-types the password. Falls back to the OS client when no credentials are
 * saved (see openSshTerminal).
 */
class SshPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;

  private client: Client | undefined;
  private channel: ClientChannel | undefined;
  private cols = 80;
  private rows = 30;
  private closed = false;

  constructor(private readonly target: SshTarget) {}

  async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    if (initialDimensions) {
      this.cols = initialDimensions.columns;
      this.rows = initialDimensions.rows;
    }
    const who = `${this.target.user || "root"}@${this.target.host}`;
    this.writeEmitter.fire(`${t("sshpty.connecting", who)}\r\n`);

    try {
      this.client = await connectClient(this.target);
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }
    if (this.closed) {
      this.client.end();
      return;
    }

    this.client.shell({ term: "xterm-256color", cols: this.cols, rows: this.rows }, (err, channel) => {
      if (err || !channel) {
        this.fail(err ? err.message : t("sshpty.shellFailed"));
        return;
      }
      this.channel = channel;
      channel.on("data", (d: Buffer) => this.writeEmitter.fire(d.toString("utf8")));
      channel.stderr.on("data", (d: Buffer) => this.writeEmitter.fire(d.toString("utf8")));
      channel.on("close", () => {
        this.writeEmitter.fire(`\r\n${t("sshpty.disconnected")}\r\n`);
        this.dispose(0);
      });
    });
  }

  close(): void {
    this.dispose();
  }

  handleInput(data: string): void {
    this.channel?.write(data);
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.cols = dims.columns;
    this.rows = dims.rows;
    try {
      this.channel?.setWindow(dims.rows, dims.columns, 0, 0);
    } catch {
      // channel not up yet — shell() already opened with the latest size
    }
  }

  private fail(message: string): void {
    this.writeEmitter.fire(`\r\n${t("sshpty.failed", message)}\r\n`);
    this.dispose(1);
  }

  private dispose(exitCode?: number): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.channel?.end();
    } catch {
      // ignore
    }
    try {
      this.client?.end();
    } catch {
      // ignore
    }
    this.closeEmitter.fire(exitCode);
  }
}

/**
 * Opens an interactive SSH terminal. With a saved key or password it goes through
 * the ssh2 library (no manual auth). With no saved credentials — or when
 * `preferOsShell` is set — it uses the OS `ssh` instead: the user types the
 * password, but the terminal gets VS Code's predictive local echo, so typing
 * feels smoother over a laggy link (the ssh2 pty echoes every keystroke round-trip).
 */
export function openSshTerminal(target: SshTarget, name: string, preferOsShell = false): vscode.Terminal {
  if (preferOsShell || !canAutomate(target)) {
    const shell = buildInteractiveShell(target);
    const term = vscode.window.createTerminal({
      name,
      shellPath: shell.shellPath,
      shellArgs: shell.shellArgs,
      isTransient: true,
    });
    term.show();
    return term;
  }
  // isTransient: a restored SSH session on window reload is dead anyway.
  const term = vscode.window.createTerminal({ name, pty: new SshPty(target), isTransient: true });
  term.show();
  return term;
}
