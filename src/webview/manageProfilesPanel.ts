import { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  addOrUpdateProfile,
  displayNameOf,
  ensureUniqueFolderName,
  findImportableVenvs,
  ImportableVenv,
  loadProfiles,
  moveProfile,
  Profile,
  readVenvInfo,
  removeProfile,
  resolveVenvDir,
  sanitizePromptLabel,
  setDisplayName,
  suggestFolderName,
  venvsDir,
} from "../profileStore";
import { openTerminalForProfile } from "../terminalManager";
import { findInterpreters, PythonInterpreter } from "../pythonFinder";
import {
  classifyFridaToolsVersions,
  FridaToolsCompat,
  getAvailableVersions,
  getFridaRequirementMap,
} from "../pypi";
import { createVenv, installPackages, killProcessTree } from "../venvManager";
import { PANEL_STYLE, PANEL_KIT_JS, getNonce } from "./panelKit";
import { t, bundleFor, currentLang } from "../i18n";

export type ProfilesPanelTab = "list" | "new";

interface ProfileRow {
  name: string;
  displayName: string;
  pythonVersion: string;
  fridaVersion: string;
  fridaToolsVersion: string;
  venvDir: string;
  venvExists: boolean;
}

type HostToWebviewMessage =
  | { type: "profiles"; rows: ProfileRow[] }
  | { type: "importable"; venvs: ImportableVenv[] }
  | { type: "setTab"; tab: ProfilesPanelTab }
  | { type: "interpreters"; interpreters: PythonInterpreter[] }
  | {
      type: "versions";
      pkg: "frida" | "frida-tools";
      versions: string[];
      filtered: boolean;
      /** Per-version compatibility with the chosen frida version (frida-tools only). */
      compat?: Record<string, FridaToolsCompat>;
    }
  | { type: "compatReady" }
  | { type: "pickedVenv"; venv: ImportableVenv | null }
  | { type: "suggestedFolderName"; folderName: string }
  | { type: "venvsBaseDir"; path: string }
  | { type: "log"; line: string }
  | { type: "progress"; percent: number }
  | { type: "state"; state: "running" | "done" | "failed" | "cancelled" };

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "openTerminal"; name: string }
  | { type: "saveDisplayName"; name: string; displayName: string }
  | { type: "moveProfile"; id: string; dir: number }
  | { type: "removeFromList"; name: string }
  | { type: "deleteVenv"; name: string }
  | { type: "browsePickVenv" }
  | {
      type: "setupExisting";
      venvDir: string;
      displayName: string;
      fridaVersion: string;
      fridaToolsVersion: string;
    }
  | { type: "requestSuggestedFolderName"; pythonVersion: string; fridaVersion: string; fridaToolsVersion: string }
  | { type: "requestCompatibleFridaTools"; fridaVersion: string }
  | {
      type: "create";
      pythonExecutable: string;
      pythonVersion: string;
      fridaVersion: string;
      fridaToolsVersion: string;
      folderName: string;
      displayName: string;
    }
  | { type: "cancelCreate" };

/** Webview panel handling New profile / Profiles in one window (tabs). */
export class ManageProfilesPanel {
  private static current: ManageProfilesPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  // new-profile creation progress state
  private currentProcess: ChildProcess | undefined;
  private cancelled = false;
  private running = false;
  private allFridaToolsVersions: string[] = [];
  private fridaToolsRequirementMap: Record<string, string> = {};

  static show(dataDir: string, onChanged: () => void, initialTab: ProfilesPanelTab = "list"): void {
    if (ManageProfilesPanel.current) {
      ManageProfilesPanel.current.panel.reveal();
      ManageProfilesPanel.current.post({ type: "setTab", tab: initialTab });
      ManageProfilesPanel.current.sendProfiles();
      return;
    }
    ManageProfilesPanel.current = new ManageProfilesPanel(dataDir, onChanged, initialTab);
  }

  /** Re-renders the open window in the new language when frivenv.language changes. */
  static relocalizeIfOpen(): void {
    const p = ManageProfilesPanel.current;
    if (!p) {
      return;
    }
    p.panel.webview.html = p.renderHtml();
    p.sendProfiles();
  }

  /** Re-sends the profile list to the open window (e.g. after a tree-side reorder). */
  static refreshIfOpen(): void {
    ManageProfilesPanel.current?.sendProfiles();
  }

  private constructor(
    private readonly dataDir: string,
    private readonly onChanged: () => void,
    private readonly initialTab: ProfilesPanelTab
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "frivenv.manageProfiles",
      t("nw.windowTitle"),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.running) {
        this.currentProcess?.kill();
      }
      ManageProfilesPanel.current = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => this.handleMessage(msg));
  }

  private post(msg: HostToWebviewMessage): void {
    if (this.disposed) {
      return;
    }
    this.panel.webview.postMessage(msg);
  }

  private sendProfiles(): void {
    const rows: ProfileRow[] = loadProfiles(this.dataDir).map((p) => {
      const venvDir = resolveVenvDir(this.dataDir, p);
      return {
        name: p.name,
        displayName: displayNameOf(p),
        pythonVersion: p.python_version,
        fridaVersion: p.frida_version,
        fridaToolsVersion: p.frida_tools_version,
        venvDir,
        venvExists: fs.existsSync(venvDir),
      };
    });
    this.post({ type: "profiles", rows });
    this.post({ type: "importable", venvs: findImportableVenvs(this.dataDir) });
  }

  private findProfile(name: string): Profile | undefined {
    return loadProfiles(this.dataDir).find((p) => p.name === name);
  }

  /** (Re)fetches the frida / frida-tools version lists from PyPI. Called on open and on Refresh. */
  private loadVersions(): void {
    getAvailableVersions("frida").then((versions) =>
      this.post({ type: "versions", pkg: "frida", versions, filtered: false })
    );
    getAvailableVersions("frida-tools").then(async (versions) => {
      this.allFridaToolsVersions = versions;
      this.post({ type: "versions", pkg: "frida-tools", versions, filtered: false });
      this.fridaToolsRequirementMap = await getFridaRequirementMap(versions);
      // The requirement lookup finishes after the first list is sent; tell the
      // webview so it can re-request compat for whatever frida is selected.
      this.post({ type: "compatReady" });
    });
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "setTab", tab: this.initialTab });
        this.sendProfiles();
        this.post({ type: "interpreters", interpreters: findInterpreters() });
        this.post({ type: "venvsBaseDir", path: venvsDir(this.dataDir) });
        this.loadVersions();
        break;

      case "refresh":
        this.sendProfiles();
        this.post({ type: "interpreters", interpreters: findInterpreters() });
        this.loadVersions();
        this.onChanged(); // keep the sidebar tree in sync with the window
        break;

      case "openTerminal": {
        const profile = this.findProfile(msg.name);
        if (!profile) {
          return;
        }
        const venvDir = resolveVenvDir(this.dataDir, profile);
        if (!fs.existsSync(venvDir)) {
          vscode.window.showErrorMessage(t("cmd.err.venvMissing", venvDir));
          return;
        }
        openTerminalForProfile(this.dataDir, profile);
        break;
      }

      case "saveDisplayName": {
        try {
          setDisplayName(this.dataDir, msg.name, msg.displayName);
        } catch (err) {
          vscode.window.showErrorMessage((err as Error).message);
          return;
        }
        this.sendProfiles();
        this.onChanged();
        break;
      }

      case "moveProfile":
        moveProfile(this.dataDir, msg.id, msg.dir < 0 ? -1 : 1);
        this.sendProfiles();
        this.onChanged(); // keep the sidebar tree in sync
        break;

      case "removeFromList": {
        const profile = this.findProfile(msg.name);
        if (!profile) {
          return;
        }
        const removeBtn = t("nw.action.removeFromList");
        const confirm = await vscode.window.showWarningMessage(
          t("nw.confirm.removeFromList", displayNameOf(profile)),
          { modal: true },
          removeBtn
        );
        if (confirm !== removeBtn) {
          return;
        }
        removeProfile(this.dataDir, profile.name);
        this.sendProfiles();
        this.onChanged();
        break;
      }

      case "deleteVenv": {
        const profile = this.findProfile(msg.name);
        if (!profile) {
          return;
        }
        const venvDir = resolveVenvDir(this.dataDir, profile);
        const deleteBtn = t("nw.action.delete");
        const confirm = await vscode.window.showWarningMessage(
          t("nw.confirm.deleteFolder", displayNameOf(profile), venvDir),
          { modal: true },
          deleteBtn
        );
        if (confirm !== deleteBtn) {
          return;
        }
        try {
          if (fs.existsSync(venvDir)) {
            fs.rmSync(venvDir, { recursive: true, force: true });
          }
        } catch (err) {
          vscode.window.showErrorMessage(t("nw.err.deleteFailed", (err as Error).message));
          return;
        }
        removeProfile(this.dataDir, profile.name);
        this.sendProfiles();
        this.onChanged();
        break;
      }

      case "browsePickVenv": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(venvsDir(this.dataDir)),
          title: t("nw.import.browseTitle"),
          openLabel: t("nw.existingVenv.browse"),
        });
        if (!picked || picked.length === 0) {
          this.post({ type: "pickedVenv", venv: null });
          break;
        }
        const venvDir = picked[0].fsPath;
        const info = readVenvInfo(venvDir);
        if (!info) {
          vscode.window.showErrorMessage(t("nw.import.notVenv", venvDir));
          this.post({ type: "pickedVenv", venv: null });
          break;
        }
        this.post({ type: "pickedVenv", venv: { name: path.basename(venvDir), venvDir, ...info } });
        break;
      }

      case "setupExisting":
        await this.setupExistingVenv(msg);
        break;

      case "requestSuggestedFolderName":
        this.post({ type: "suggestedFolderName", folderName: suggestFolderName() });
        break;

      case "requestCompatibleFridaTools": {
        if (this.allFridaToolsVersions.length === 0) {
          break;
        }
        const compat = classifyFridaToolsVersions(
          this.allFridaToolsVersions,
          this.fridaToolsRequirementMap,
          msg.fridaVersion
        );
        this.post({
          type: "versions",
          pkg: "frida-tools",
          versions: this.allFridaToolsVersions,
          filtered: false,
          compat,
        });
        break;
      }

      case "create":
        await this.createProfile(msg);
        break;

      case "cancelCreate":
        this.cancelled = true;
        if (this.currentProcess) {
          killProcessTree(this.currentProcess);
        }
        break;
    }
  }

  private async createProfile(msg: Extract<WebviewToHostMessage, { type: "create" }>): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.post({ type: "state", state: "running" });

    const rawFolderName = msg.folderName.trim() || suggestFolderName();
    const internalName = ensureUniqueFolderName(this.dataDir, rawFolderName);
    if (internalName !== rawFolderName) {
      this.post({ type: "log", line: t("nw.log.folderExists", rawFolderName, internalName) });
    }

    const venvDir = path.join(venvsDir(this.dataDir), internalName);
    const displayName = msg.displayName.trim() || internalName;

    this.post({ type: "log", line: t("nw.log.start", msg.pythonExecutable, venvDir) });
    this.post({ type: "progress", percent: 5 });

    let rc = await createVenv(
      msg.pythonExecutable,
      venvDir,
      sanitizePromptLabel(displayName) || internalName,
      (line) => this.post({ type: "log", line }),
      (proc) => (this.currentProcess = proc)
    );

    if (rc === 0) {
      const packages: string[] = [];
      if (msg.fridaVersion) {
        packages.push(`frida==${msg.fridaVersion}`);
      }
      if (msg.fridaToolsVersion) {
        packages.push(`frida-tools==${msg.fridaToolsVersion}`);
      }
      this.post({ type: "log", line: t("nw.log.installing") });
      this.post({ type: "progress", percent: 40 });
      rc = await installPackages(
        venvDir,
        packages,
        (line) => this.post({ type: "log", line }),
        (proc) => (this.currentProcess = proc)
      );
    }

    this.running = false;

    if (rc !== 0) {
      if (fs.existsSync(venvDir)) {
        fs.rmSync(venvDir, { recursive: true, force: true });
        this.post({ type: "log", line: t("nw.log.cleanedUp", venvDir) });
      }
      if (this.cancelled) {
        this.post({ type: "log", line: t("nw.log.cancelled") });
        this.post({ type: "state", state: "cancelled" });
      } else {
        this.post({ type: "log", line: t("nw.log.failed") });
        this.post({ type: "state", state: "failed" });
      }
      return;
    }

    const profile: Profile = {
      name: internalName,
      display_name: displayName,
      python_executable: msg.pythonExecutable,
      python_version: msg.pythonVersion,
      frida_version: msg.fridaVersion,
      frida_tools_version: msg.fridaToolsVersion,
      venv_dir: venvDir,
    };
    addOrUpdateProfile(this.dataDir, profile);
    this.post({ type: "log", line: t("nw.log.done", displayName, internalName) });
    this.post({ type: "state", state: "done" });
    this.sendProfiles();
    this.onChanged();
  }

  /**
   * Registers a venv that already exists. Installs frida / frida-tools into it only
   * when the requested version differs from what's there. Unlike createProfile it
   * NEVER deletes the folder on failure — it's the user's own venv.
   */
  private async setupExistingVenv(
    msg: Extract<WebviewToHostMessage, { type: "setupExisting" }>
  ): Promise<void> {
    if (this.running) {
      return;
    }
    const before = readVenvInfo(msg.venvDir);
    if (!before) {
      vscode.window.showErrorMessage(t("nw.import.notVenv", msg.venvDir));
      this.post({ type: "state", state: "failed" });
      return;
    }

    this.running = true;
    this.cancelled = false;
    this.post({ type: "state", state: "running" });

    const existing = loadProfiles(this.dataDir).find(
      (p) => resolveVenvDir(this.dataDir, p) === msg.venvDir
    );
    const name = existing ? existing.name : ensureUniqueFolderName(this.dataDir, path.basename(msg.venvDir));

    const packages: string[] = [];
    if (msg.fridaVersion && msg.fridaVersion !== before.fridaVersion) {
      packages.push(`frida==${msg.fridaVersion}`);
    }
    if (msg.fridaToolsVersion && msg.fridaToolsVersion !== before.fridaToolsVersion) {
      packages.push(`frida-tools==${msg.fridaToolsVersion}`);
    }

    let rc = 0;
    if (packages.length > 0) {
      this.post({ type: "log", line: t("nw.log.installingInto", msg.venvDir) });
      this.post({ type: "progress", percent: 20 });
      rc = await installPackages(
        msg.venvDir,
        packages,
        (line) => this.post({ type: "log", line }),
        (proc) => (this.currentProcess = proc)
      );
    }

    this.running = false;

    if (rc !== 0) {
      this.post({ type: "log", line: t(this.cancelled ? "nw.log.cancelled" : "nw.log.failed") });
      this.post({ type: "state", state: this.cancelled ? "cancelled" : "failed" });
      return;
    }

    const after = readVenvInfo(msg.venvDir) ?? before;
    addOrUpdateProfile(this.dataDir, {
      name,
      display_name: msg.displayName.trim() || existing?.display_name || path.basename(msg.venvDir),
      python_executable: after.pythonExecutable,
      python_version: after.pythonVersion,
      frida_version: msg.fridaVersion || after.fridaVersion,
      frida_tools_version: msg.fridaToolsVersion || after.fridaToolsVersion,
      venv_dir: msg.venvDir,
    });
    this.post({ type: "log", line: t("nw.log.doneExisting", name) });
    this.post({ type: "state", state: "done" });
    this.sendProfiles();
    this.onChanged();
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
${PANEL_STYLE}
</head>
<body>
  <div id="root">
    <div class="pk-tabs">
      <button class="pk-tab pk-tab--active" data-tab="list">${t("nw.tab.manage")}</button>
      <button class="pk-tab" data-tab="new">${t("nw.tab.new")}</button>
      <span class="pk-tabs__spacer"></span>
      <button class="pk-tab-action" id="refreshBtn">${t("wc.refresh")}</button>
    </div>

    <!-- create / register / modify a profile -->
    <section data-page="new" hidden>
      <div class="pk-btnrow" style="margin-top:0" id="newModeRow">
        <button class="pk-btn pk-btn--sm pk-btn--primary" id="modeCreate">${t("nw.mode.create")}</button>
        <button class="pk-btn pk-btn--sm" id="modeRegister">${t("nw.mode.register")}</button>
        <button class="pk-btn pk-btn--sm" id="modeModify">${t("nw.mode.modify")}</button>
      </div>

      <div class="pk-field__hint pk-warn" id="lookupError" hidden>${t("nw.err.pypiUnreachable")}</div>

      <div class="pk-field" id="existingVenvField" hidden>
        <label class="pk-field__label" id="existingVenvLabel" for="existingVenv">${t("nw.label.registerVenv")}</label>
        <div class="pk-inline">
          <select class="pk-select" id="existingVenv" style="flex:1 1 auto"></select>
          <button class="pk-btn pk-btn--sm" id="existingBrowse">${t("nw.existingVenv.browse")}</button>
        </div>
        <div class="pk-field__hint pk-mono" id="existingVenvInfo"></div>
      </div>

      <div class="pk-field" id="pythonField">
        <label class="pk-field__label" for="python">${t("nw.label.python")}</label>
        <select class="pk-select" id="python"><option>${t("nw.opt.loading")}</option></select>
      </div>
      <div class="pk-field">
        <label class="pk-field__label" for="frida">${t("nw.label.frida")}</label>
        <select class="pk-select" id="frida"><option>${t("nw.opt.loading")}</option></select>
      </div>
      <div class="pk-field">
        <label class="pk-field__label" for="fridaTools">${t("nw.label.fridaTools")}</label>
        <select class="pk-select" id="fridaTools"><option>${t("nw.opt.loading")}</option></select>
        <div class="pk-field__hint" id="fridaToolsHint"></div>
      </div>

      <hr class="pk-hr" />

      <div class="pk-field" id="folderNameField">
        <label class="pk-field__label" for="folderName">${t("nw.label.folderName")}</label>
        <input class="pk-input pk-mono" id="folderName" placeholder="${t("nw.placeholder.folderName")}" />
        <div class="pk-field__hint pk-mono" id="pathPreview"></div>
      </div>
      <div class="pk-field">
        <label class="pk-field__label" for="displayName">${t("nw.label.displayName")}</label>
        <input class="pk-input" id="displayName" placeholder="${t("nw.placeholder.displayName")}" />
      </div>

      <div class="pk-btnrow pk-btnrow--end">
        <button class="pk-btn pk-btn--primary" id="createBtn">${t("nw.btn.create")}</button>
        <button class="pk-btn" id="cancelBtn" disabled>${t("nw.btn.cancel")}</button>
      </div>
      <div class="pk-status" id="status" style="margin-top:8px"></div>
      <div class="pk-progress-wrap pk-hidden" id="progressBlock">
        <div class="pk-progress"><div class="pk-progress__fill"></div></div>
        <div class="pk-progress__msg"></div>
      </div>
      <div class="pk-console" id="log"></div>
    </section>

    <!-- profile list -->
    <section data-page="list">
      <div class="pk-empty" id="pfEmpty">${t("nw.empty")}</div>
      <div id="pfList"></div>
    </section>
  </div>

<script nonce="${nonce}">
  const L = ${JSON.stringify({ ...bundleFor("pk."), ...bundleFor("nw."), ...bundleFor("wc.") })};
${PANEL_KIT_JS}
  const root = document.getElementById('root');
  const tabs = pkTabs(root);
  document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  // ===== Profiles tab =====
  const pfList = document.getElementById('pfList');
  const pfEmpty = document.getElementById('pfEmpty');
  let rows = [];

  function renderProfiles() {
    pfEmpty.hidden = rows.length > 0;
    pfList.innerHTML = '';
    rows.forEach((row, i) => {
      const item = document.createElement('div');
      item.className = 'pk-item';

      const head = document.createElement('div');
      head.className = 'pk-item__head';
      const name = document.createElement('input');
      name.className = 'pk-input';
      name.style.flex = '1 1 200px';
      name.value = row.displayName;
      const nameToast = document.createElement('span');
      nameToast.className = 'pk-toast';
      pkBindSave(name, {
        value: row.displayName,
        onSave: (v) => vscode.postMessage({ type: 'saveDisplayName', name: row.name, displayName: v }),
        toastEl: nameToast,
      });
      head.appendChild(name);
      head.appendChild(nameToast);
      const pill = pkPill(row.venvExists ? 'ok' : 'miss', row.venvExists ? 'venv' : L['nw.pill.venvMissing']);
      head.appendChild(pill);
      head.appendChild(pkMoveBtns(row.name, i > 0, i < rows.length - 1, 'moveProfile'));
      item.appendChild(head);

      const sub = document.createElement('div');
      sub.className = 'pk-item__sub';
      sub.style.marginTop = '8px';
      sub.textContent = row.venvDir;
      item.appendChild(sub);

      const ver = document.createElement('div');
      ver.className = 'pk-row__sub';
      ver.style.marginTop = '4px';
      ver.textContent = 'py' + row.pythonVersion + ' / frida ' + row.fridaVersion +
        (row.fridaToolsVersion ? ' / tools ' + row.fridaToolsVersion : '');
      item.appendChild(ver);

      const btns = document.createElement('div');
      btns.className = 'pk-btnrow pk-btnrow--end';
      const term = document.createElement('button');
      term.className = 'pk-btn pk-btn--primary';
      term.textContent = L['nw.btn.openTerminal'];
      term.disabled = !row.venvExists;
      term.addEventListener('click', () => vscode.postMessage({ type: 'openTerminal', name: row.name }));
      btns.appendChild(term);
      const rm = document.createElement('button');
      rm.className = 'pk-btn';
      rm.textContent = L['nw.btn.removeFromList'];
      rm.addEventListener('click', () => vscode.postMessage({ type: 'removeFromList', name: row.name }));
      btns.appendChild(rm);
      const del = document.createElement('button');
      del.className = 'pk-btn pk-btn--danger';
      del.textContent = L['nw.btn.deleteFolder'];
      del.addEventListener('click', () => vscode.postMessage({ type: 'deleteVenv', name: row.name }));
      btns.appendChild(del);
      item.appendChild(btns);

      pfList.appendChild(item);
    });
  }

  // ===== New profile tab =====
  const pythonSelect = document.getElementById('python');
  const fridaSelect = document.getElementById('frida');
  const fridaToolsSelect = document.getElementById('fridaTools');
  const folderNameInput = document.getElementById('folderName');
  const displayNameInput = document.getElementById('displayName');
  const pathPreviewEl = document.getElementById('pathPreview');
  const createBtn = document.getElementById('createBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const statusEl = document.getElementById('status');
  const logEl = document.getElementById('log');
  const progressBlock = document.getElementById('progressBlock');
  const fridaToolsHint = document.getElementById('fridaToolsHint');

  let userEditedFolderName = false;
  let userEditedDisplayName = false;
  let venvsBaseDir = '';
  const lookupFailed = { frida: false, tools: false };

  // ===== mode: 생성 (new venv) / 등록 (register an existing venv) / 수정 (change a profile's versions) =====
  const modeCreateBtn = document.getElementById('modeCreate');
  const modeRegisterBtn = document.getElementById('modeRegister');
  const modeModifyBtn = document.getElementById('modeModify');
  const existingVenvField = document.getElementById('existingVenvField');
  const existingVenvLabel = document.getElementById('existingVenvLabel');
  const existingVenvSelect = document.getElementById('existingVenv');
  const existingVenvInfo = document.getElementById('existingVenvInfo');
  const existingBrowseBtn = document.getElementById('existingBrowse');
  const pythonField = document.getElementById('pythonField');
  const folderNameField = document.getElementById('folderNameField');
  let newMode = 'create';
  let importables = [];        // auto-scanned venvs/ folders not yet registered (from the host)
  let browsedVenvs = [];       // folders the user picked with "불러오기" this session
  let pickedVenv = null;

  // The venv/profile choices for the current non-create mode.
  function venvChoices() {
    if (newMode === 'modify') {
      return rows.map((r) => ({
        name: r.name, venvDir: r.venvDir, displayName: r.displayName,
        pythonVersion: r.pythonVersion, fridaVersion: r.fridaVersion, fridaToolsVersion: r.fridaToolsVersion,
      }));
    }
    const seen = new Set(importables.map((v) => v.venvDir));
    return importables.concat(browsedVenvs.filter((v) => !seen.has(v.venvDir)));
  }

  function setNewMode(m) {
    newMode = m;
    modeCreateBtn.classList.toggle('pk-btn--primary', m === 'create');
    modeRegisterBtn.classList.toggle('pk-btn--primary', m === 'register');
    modeModifyBtn.classList.toggle('pk-btn--primary', m === 'modify');
    pythonField.hidden = m !== 'create';
    folderNameField.hidden = m !== 'create';
    existingVenvField.hidden = m === 'create';
    existingBrowseBtn.hidden = m !== 'register';
    existingVenvLabel.textContent = m === 'modify' ? L['nw.label.modifyProfile'] : L['nw.label.registerVenv'];
    createBtn.textContent = m === 'create' ? L['nw.btn.create'] : m === 'register' ? L['nw.btn.setupExisting'] : L['nw.btn.modify'];
    if (m !== 'create') renderVenvChoices();
  }
  modeCreateBtn.addEventListener('click', () => setNewMode('create'));
  modeRegisterBtn.addEventListener('click', () => setNewMode('register'));
  modeModifyBtn.addEventListener('click', () => setNewMode('modify'));
  existingBrowseBtn.addEventListener('click', () => vscode.postMessage({ type: 'browsePickVenv' }));

  function renderVenvChoices() {
    const list = venvChoices();
    const prev = existingVenvSelect.value;
    existingVenvSelect.innerHTML = '';
    if (list.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = newMode === 'modify' ? L['nw.modify.none'] : L['nw.existingVenv.none'];
      existingVenvSelect.appendChild(o);
    } else {
      for (const v of list) {
        const o = document.createElement('option');
        o.value = v.venvDir;
        const label = newMode === 'modify' ? (v.displayName || v.name) : v.name;
        o.textContent = label + '  (py' + (v.pythonVersion || '-') + (v.fridaVersion ? ' · frida ' + v.fridaVersion : ' · ' + L['nw.existingVenv.noFrida']) + ')';
        existingVenvSelect.appendChild(o);
      }
      if (list.some((v) => v.venvDir === prev)) existingVenvSelect.value = prev;
    }
    if (newMode !== 'create') onVenvPicked(existingVenvSelect.value);
  }
  existingVenvSelect.addEventListener('change', () => onVenvPicked(existingVenvSelect.value));

  function onVenvPicked(venvDir) {
    pickedVenv = venvChoices().find((v) => v.venvDir === venvDir) || null;
    existingVenvInfo.style.whiteSpace = 'pre-line';
    if (!pickedVenv) { existingVenvInfo.textContent = ''; return; }
    if (!userEditedDisplayName) displayNameInput.value = pickedVenv.displayName || pickedVenv.name;
    if (pickedVenv.fridaVersion && [].slice.call(fridaSelect.options).some((o) => o.value === pickedVenv.fridaVersion)) {
      fridaSelect.value = pickedVenv.fridaVersion;
      requestCompatibleFridaTools();
    }
    if (pickedVenv.fridaToolsVersion && [].slice.call(fridaToolsSelect.options).some((o) => o.value === pickedVenv.fridaToolsVersion)) {
      fridaToolsSelect.value = pickedVenv.fridaToolsVersion;
    }
    updateExistingPlan();
  }

  // Spell out exactly what the button will do before it's pressed.
  function updateExistingPlan() {
    if (newMode === 'create' || !pickedVenv) { return; }
    const willInstall = [];
    if (fridaSelect.value && fridaSelect.value !== pickedVenv.fridaVersion) willInstall.push('frida ' + fridaSelect.value);
    if (fridaToolsSelect.value && fridaToolsSelect.value !== pickedVenv.fridaToolsVersion) willInstall.push('frida-tools ' + fridaToolsSelect.value);
    const plan = willInstall.length
      ? L['nw.existingVenv.willInstall'].replace('{0}', willInstall.join(', '))
      : (newMode === 'modify' ? L['nw.modify.noChange'] : L['nw.existingVenv.willRegister']);
    existingVenvInfo.textContent = pickedVenv.venvDir + '\\n'
      + 'py' + (pickedVenv.pythonVersion || '-')
      + ' · frida ' + (pickedVenv.fridaVersion || L['nw.existingVenv.noFrida'])
      + ' · tools ' + (pickedVenv.fridaToolsVersion || '-')
      + '\\n' + plan;
  }
  setNewMode('create');

  function updatePathPreview() {
    const nm = folderNameInput.value.trim() || L['nw.placeholder.folderNameShort'];
    pathPreviewEl.textContent = venvsBaseDir ? (venvsBaseDir + '\\\\' + nm) : '';
  }
  folderNameInput.addEventListener('input', () => {
    userEditedFolderName = true;
    // Display name mirrors the folder name until the user types their own.
    if (!userEditedDisplayName) displayNameInput.value = folderNameInput.value;
    updatePathPreview();
  });
  displayNameInput.addEventListener('input', () => { userEditedDisplayName = true; });

  function fillSelect(select, values, placeholder) {
    select.innerHTML = '';
    if (values.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = placeholder;
      select.appendChild(opt);
      return;
    }
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }
  }

  // frida-tools list, tagged per version against the chosen frida version:
  //   ✓ verified compatible   · no metadata (unverified)   ✗ known incompatible
  // ✗ stays selectable on purpose — someone may want to test a mismatched combo.
  function renderFridaToolsOptions(versions, compat) {
    const prev = fridaToolsSelect.value;
    const hasCompat = Object.keys(compat).length > 0;
    const rank = { ok: 0, unknown: 1, bad: 2 };
    const ordered = versions.slice().sort((a, b) => (rank[compat[a] || 'unknown'] - rank[compat[b] || 'unknown']));
    fridaToolsSelect.innerHTML = '';
    if (ordered.length === 0) {
      const o = document.createElement('option');
      o.textContent = L['nw.opt.lookupFailed'];
      fridaToolsSelect.appendChild(o);
    } else {
      for (const v of ordered) {
        const st = hasCompat ? (compat[v] || 'unknown') : '';
        const o = document.createElement('option');
        o.value = v;
        o.textContent = (st === 'ok' ? '✓ ' : st === 'bad' ? '✗ ' : st === 'unknown' ? '· ' : '') + v;
        // ✓ compatible = bold, ✗ incompatible = dimmed (still selectable), · = normal.
        if (st === 'ok') o.style.fontWeight = '700';
        else if (st === 'bad') o.style.color = 'var(--vscode-descriptionForeground)';
        fridaToolsSelect.appendChild(o);
      }
    }
    // Keep the user's current pick even if it just turned ✗; only auto-pick when
    // there is nothing selected (first load, or the old value disappeared).
    if (versions.includes(prev)) {
      fridaToolsSelect.value = prev;
    }
    if (!fridaToolsSelect.value) {
      fridaToolsSelect.value = ordered.find((v) => (compat[v] || 'unknown') === 'ok') || ordered[0] || '';
    }
    fridaToolsHint.style.whiteSpace = 'pre-line';
    fridaToolsHint.textContent = hasCompat ? L['nw.hint.compatLegend'].replace('{0}', fridaSelect.value || '?') : '';
    updateExistingPlan();
  }

  function requestSuggestedFolderName() {
    const pyOpt = pythonSelect.selectedOptions[0];
    if (!pyOpt) return;
    vscode.postMessage({
      type: 'requestSuggestedFolderName',
      pythonVersion: pyOpt.dataset.version || '',
      fridaVersion: fridaSelect.value || '',
      fridaToolsVersion: fridaToolsSelect.value || '',
    });
  }
  function requestCompatibleFridaTools() {
    if (!fridaSelect.value) return;
    fridaToolsHint.textContent = L['nw.hint.checkingCompat'];
    vscode.postMessage({ type: 'requestCompatibleFridaTools', fridaVersion: fridaSelect.value });
  }

  pythonSelect.addEventListener('change', requestSuggestedFolderName);
  fridaSelect.addEventListener('change', () => { requestSuggestedFolderName(); requestCompatibleFridaTools(); updateExistingPlan(); });
  fridaToolsSelect.addEventListener('change', () => { requestSuggestedFolderName(); updateExistingPlan(); });

  function setFormEnabled(enabled) {
    pythonSelect.disabled = !enabled;
    fridaSelect.disabled = !enabled;
    fridaToolsSelect.disabled = !enabled;
    folderNameInput.disabled = !enabled;
    displayNameInput.disabled = !enabled;
    existingVenvSelect.disabled = !enabled;
    modeCreateBtn.disabled = !enabled;
    modeRegisterBtn.disabled = !enabled;
    modeModifyBtn.disabled = !enabled;
    existingBrowseBtn.disabled = !enabled;
    createBtn.disabled = !enabled;
    cancelBtn.disabled = enabled;
  }

  createBtn.addEventListener('click', () => {
    if (newMode !== 'create') {
      if (!pickedVenv) { statusEl.textContent = L['nw.import.pickVenvFirst']; return; }
      setFormEnabled(false);
      logEl.textContent = '';
      statusEl.textContent = '';
      vscode.postMessage({
        type: 'setupExisting',
        venvDir: pickedVenv.venvDir,
        displayName: displayNameInput.value,
        fridaVersion: fridaSelect.value || '',
        fridaToolsVersion: fridaToolsSelect.value || '',
      });
      return;
    }
    const pyOpt = pythonSelect.selectedOptions[0];
    if (!pyOpt || !pyOpt.value) {
      statusEl.textContent = L['nw.status.pyNotFound'];
      return;
    }
    setFormEnabled(false);
    logEl.textContent = '';
    statusEl.textContent = '';
    vscode.postMessage({
      type: 'create',
      pythonExecutable: pyOpt.value,
      pythonVersion: pyOpt.dataset.version || '',
      fridaVersion: fridaSelect.value || '',
      fridaToolsVersion: fridaToolsSelect.value || '',
      folderName: folderNameInput.value,
      displayName: displayNameInput.value,
    });
  });
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelCreate' });
    cancelBtn.disabled = true;
    statusEl.textContent = L['nw.status.cancelling'];
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'profiles') {
      rows = msg.rows;
      renderProfiles();
      if (newMode === 'modify') renderVenvChoices();
    } else if (msg.type === 'importable') {
      importables = msg.venvs || [];
      if (newMode === 'register') renderVenvChoices();
    } else if (msg.type === 'pickedVenv') {
      if (msg.venv) {
        if (!browsedVenvs.some((v) => v.venvDir === msg.venv.venvDir)) browsedVenvs.push(msg.venv);
        if (newMode !== 'register') setNewMode('register');
        renderVenvChoices();
        existingVenvSelect.value = msg.venv.venvDir;
        onVenvPicked(msg.venv.venvDir);
      }
    } else if (msg.type === 'setTab') {
      tabs.show(msg.tab);
    } else if (msg.type === 'interpreters') {
      pythonSelect.innerHTML = '';
      for (const i of msg.interpreters) {
        const opt = document.createElement('option');
        opt.value = i.executable;
        opt.dataset.version = i.version;
        opt.textContent = L['nw.opt.pythonItem'].replace('{0}', i.version).replace('{1}', i.isDefault ? L['nw.opt.default'] : '').replace('{2}', i.executable);
        if (i.isDefault) opt.selected = true;
        pythonSelect.appendChild(opt);
      }
      requestSuggestedFolderName();
    } else if (msg.type === 'versions') {
      if (msg.pkg === 'frida') {
        fillSelect(fridaSelect, msg.versions, L['nw.opt.lookupFailed']);
        lookupFailed.frida = msg.versions.length === 0;
        requestCompatibleFridaTools();
      } else {
        renderFridaToolsOptions(msg.versions, msg.compat || {});
        lookupFailed.tools = msg.versions.length === 0;
      }
      document.getElementById('lookupError').hidden = !(lookupFailed.frida || lookupFailed.tools);
      requestSuggestedFolderName();
    } else if (msg.type === 'compatReady') {
      requestCompatibleFridaTools();
    } else if (msg.type === 'suggestedFolderName') {
      if (!userEditedFolderName) folderNameInput.value = msg.folderName;
      if (!userEditedDisplayName) displayNameInput.value = folderNameInput.value;
      updatePathPreview();
    } else if (msg.type === 'venvsBaseDir') {
      venvsBaseDir = msg.path;
      updatePathPreview();
    } else if (msg.type === 'log') {
      logEl.textContent += msg.line + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    } else if (msg.type === 'progress') {
      pkProgress(progressBlock, msg.percent / 100, null);
    } else if (msg.type === 'state') {
      if (msg.state === 'running') {
        statusEl.textContent = L['nw.status.installing'];
        pkProgress(progressBlock, 0.05, null);
      } else if (msg.state === 'done') {
        statusEl.textContent = L['nw.status.doneShort'];
        cancelBtn.disabled = true;
        pkProgressDone(progressBlock);
        userEditedFolderName = false;
        userEditedDisplayName = false;
        pickedVenv = null;
        setFormEnabled(true);
        setNewMode('create');
        requestSuggestedFolderName();
        tabs.show("list");
      } else if (msg.state === 'failed') {
        statusEl.textContent = L['nw.status.failedSeeLog'];
        statusEl.className = 'pk-status pk-status--fail';
        setFormEnabled(true);
        progressBlock.classList.add('pk-hidden');
      } else if (msg.state === 'cancelled') {
        statusEl.textContent = L['nw.status.cancelled'];
        setFormEnabled(true);
        progressBlock.classList.add('pk-hidden');
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
