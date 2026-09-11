/**
 * The webview shell shared by the three manage windows (profiles / Android / iOS).
 *
 * - `PANEL_STYLE`: the `<style>` block. `.pk-*` components modeled on the VS Code
 *   settings editor. Every color is a `--vscode-*` token, so light/dark just work.
 * - `PANEL_KIT_JS`: client helpers, inserted verbatim at the top of each panel's
 *   `<script>` (webview scripts can't import, so it's shared as a string).
 * - `getNonce()`: CSP nonce.
 *
 * Rule: this file is the single visual source for all three panels. Don't write
 * per-panel CSS.
 */

export function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export const PANEL_STYLE = `<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 14px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px 24px;
    margin: 0;
  }
  a, .pk-link {
    color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer;
    background: none; border: 0; padding: 0; font: inherit;
  }
  a:hover, .pk-link:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)); }
  ::selection { background: var(--vscode-editor-selectionBackground); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 5px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
  ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }

  /* ---- tabs (VS Code style: underline, no fill) ---- */
  .pk-tabs { display: flex; align-items: stretch; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 16px; }
  .pk-tab {
    appearance: none; background: none; border: 0; border-bottom: 1px solid transparent;
    margin-bottom: -1px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
    color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground));
  }
  .pk-tab:hover { color: var(--vscode-foreground); }
  .pk-tab.pk-tab--active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
  }
  .pk-tabs__spacer { flex: 1; }
  .pk-tab-action {
    appearance: none; background: none; border: 0; padding: 7px 8px; font: inherit; font-size: 12px;
    color: var(--vscode-textLink-foreground); cursor: pointer;
  }
  .pk-tab-action:hover { text-decoration: underline; }

  /* ---- sections ---- */
  .pk-section { margin-top: 22px; }
  .pk-section:first-child { margin-top: 0; }
  .pk-section__title {
    font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin: 0 0 8px;
  }
  .pk-section__desc { font-size: 13px; color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 0 0 12px; }
  .pk-hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0 0; }

  /* ---- settings-editor row: label left, control right ---- */
  .pk-row { display: flex; gap: 14px; align-items: flex-start; padding: 9px 0; border-top: 1px solid var(--vscode-panel-border); }
  .pk-row:first-of-type { border-top: 0; }
  .pk-row__key { flex: 0 0 150px; padding-top: 3px; }
  .pk-row__label { font-size: 14px; }
  .pk-row__sub { font-size: 12.5px; color: var(--vscode-descriptionForeground); margin-top: 2px; line-height: 1.45; }
  .pk-row__ctl { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .pk-inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .pk-inline > input { flex: 1 1 180px; }
  /* input + trailing button, with the button column aligned across every such row */
  .pk-fieldrow { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 6px; align-items: center; }

  /* ---- vertical field (forms) ---- */
  .pk-field { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
  .pk-field__label { font-size: 13px; font-weight: 600; }
  .pk-field__hint { font-size: 12.5px; color: var(--vscode-descriptionForeground); line-height: 1.45; }
  .pk-check { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-top: 10px; cursor: pointer; }
  .pk-check input { margin: 0; flex: 0 0 auto; }
  .pk-field__hint.pk-warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .pk-grid2 { display: grid; grid-template-columns: 1fr 100px; gap: 8px; }
  /* label + input on one line, label in regular weight */
  .pk-inlab { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  /* single-line variant: never wraps, so toggling it against another one-line row
     (password <-> key) doesn't change the card's height */
  .pk-inlab--1 { flex-wrap: nowrap; }
  .pk-inlab--1 > input { flex: 1 1 40px; }
  .pk-inlab__l { flex: 0 0 auto; font-size: 13px; }
  .pk-inlab > input { flex: 1 1 120px; min-width: 0; }
  .pk-inlab > input.pk-inlab__narrow { flex: 0 0 68px; }
  .pk-inlab > button { flex: 0 0 auto; }

  /* ---- inputs ---- */
  .pk-input, .pk-select {
    /* explicit line-height so height doesn't depend on the font family
       (a pk-mono input must be the same height as a plain one) */
    width: 100%; padding: 5px 8px; font: inherit; font-size: 13.5px; line-height: 1.4; border-radius: 2px;
    background: var(--vscode-settings-textInputBackground, var(--vscode-input-background));
    color: var(--vscode-settings-textInputForeground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-settings-textInputBorder, var(--vscode-input-border, transparent));
  }
  .pk-input:focus, .pk-select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pk-input--invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)) !important; }
  .pk-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .pk-input:disabled, .pk-select:disabled { opacity: .5; cursor: not-allowed; }
  .pk-mono { font-family: var(--vscode-editor-font-family, monospace); }

  /* ---- buttons: filled secondary by default, one primary, danger ----
     The border is a fixed fraction of the theme's foreground colour (via
     color-mix) so it's clearly visible in EVERY theme — most themes leave
     --vscode-button-border unset, which is why the old outline was invisible. */
  .pk-btn {
    appearance: none; font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 3px; cursor: pointer;
    white-space: nowrap;
    background: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--vscode-foreground) 12%, transparent));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
  }
  .pk-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 22%, transparent));
  }
  /* only the plain button darkens its border on hover — primary/danger keep theirs */
  .pk-btn:not(.pk-btn--primary):not(.pk-btn--danger):hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--vscode-foreground) 70%, transparent);
  }
  .pk-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .pk-btn--primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent); font-weight: 600;
  }
  .pk-btn--primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .pk-btn--danger {
    background: transparent; color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
  }
  .pk-btn--danger:hover:not(:disabled) { background: var(--vscode-inputValidation-errorBackground, rgba(244,71,71,.12)); }
  .pk-btn--sm { padding: 4px 9px; font-size: 12px; }
  .pk-move { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .pk-move__b { padding: 1px 6px; font-size: 10px; line-height: 1.4; }
  .pk-btn:disabled { opacity: .4; cursor: not-allowed; }
  .pk-btnrow { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
  .pk-btnrow--end { justify-content: flex-end; }
  /* small "X" / icon button, e.g. a card's top-right close */
  .pk-iconbtn {
    appearance: none; background: none; border: 0; cursor: pointer; flex: 0 0 auto;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    font-size: 14px; line-height: 1; padding: 4px 6px; border-radius: 3px;
  }
  .pk-iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.16)); }
  .pk-btnrow__end { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }

  /* ---- list-item (one device / profile) ---- */
  /* Separate the card from the page with a fixed translucent overlay rather than a
     theme token: --vscode-editorWidget-background equals the editor background on
     many themes (no visible card), and a dark shadow is invisible on dark themes.
     A neutral-grey wash lightens the card on dark themes and darkens it on light
     ones, so every theme gets the same lift. */
  .pk-item {
    background-color: var(--vscode-editor-background);
    background-image: linear-gradient(rgba(127, 127, 127, 0.09), rgba(127, 127, 127, 0.09));
    border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.28));
    border-radius: 6px;
    padding: 12px 14px; margin-top: 12px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  /* the add-device form card — a dashed accent border (the conventional
     "creating something new" affordance) plus a faint accent wash, so it never
     reads as another saved device row */
  .pk-item--accent {
    border: 1px dashed var(--vscode-focusBorder);
    background-image: linear-gradient(
      color-mix(in srgb, var(--vscode-focusBorder) 7%, transparent),
      color-mix(in srgb, var(--vscode-focusBorder) 7%, transparent)
    );
  }
  .pk-item__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pk-item__title { font-weight: 600; flex: 1 1 auto; min-width: 120px; }
  .pk-item__sub { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-descriptionForeground); word-break: break-all; }

  /* ---- status pill ---- */
  .pk-pill {
    display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 0 7px; height: 18px;
    border-radius: 9px; border: 1px solid currentColor; white-space: nowrap;
  }
  .pk-pill { font-size: 11.5px; }
  .pk-pill--ok { color: var(--vscode-testing-iconPassed, #3f9142); }
  .pk-pill--miss { color: var(--vscode-errorForeground); }
  .pk-pill--set { color: var(--vscode-textLink-foreground); }
  .pk-pill--warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .pk-pill--muted { color: var(--vscode-foreground); opacity: .75; }

  /* ---- toast ("Saved") ---- */
  .pk-toast { font-size: 12px; color: var(--vscode-testing-iconPassed, #3f9142); opacity: 0; transition: opacity .15s ease; }
  .pk-toast.pk-toast--show { opacity: 1; }

  /* ---- progress: a 2px strip along the top of the log panel + the message in
     its header, so running an op never changes the card's height ---- */
  .pk-progress-wrap { position: absolute; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; }
  .pk-progress { height: 100%; }
  .pk-progress__fill { height: 100%; background: var(--vscode-progressBar-background, var(--vscode-button-background)); transform-origin: left center; transform: scaleX(0); transition: transform .25s ease; }
  .pk-hidden { display: none !important; }

  /* ---- console log: bordered panel with a header strip ---- */
  .pk-consolewrap {
    position: relative;
    margin-top: 10px; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; overflow: hidden;
  }
  .pk-console__bar {
    display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .pk-console__ttl {
    flex: 1 1 auto; min-width: 0; font-size: 11px; font-weight: 600; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pk-console__act {
    appearance: none; background: none; border: 0; border-radius: 3px;
    padding: 3px 7px; font: inherit; font-size: 11.5px;
    color: var(--vscode-textLink-foreground); cursor: pointer;
  }
  .pk-console__act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.16)); }
  .pk-console__act--cancel { color: var(--vscode-errorForeground); }
  .pk-console__act:disabled { opacity: .5; cursor: default; }
  .pk-console {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; line-height: 1.5;
    background: var(--vscode-textCodeBlock-background);
    padding: 6px 10px; height: 150px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-all;
  }

  .pk-empty { color: var(--vscode-descriptionForeground); padding: 20px 2px; font-size: 14px; }
  .pk-status { font-size: 12.5px; color: var(--vscode-descriptionForeground); }
  .pk-status--ok { color: var(--vscode-testing-iconPassed, #3f9142); }
  .pk-status--fail { color: var(--vscode-errorForeground); }
  [hidden] { display: none !important; }
</style>`;

export const PANEL_KIT_JS = `
  const vscode = acquireVsCodeApi();

  // Right-click: on a [data-pk-copy] button, copy the command; over an input or selected
  // text, keep the native menu; otherwise suppress it.
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const cp = t && t.closest ? t.closest('[data-pk-copy]') : null;
    if (cp && cp.__pkCmd) { e.preventDefault(); vscode.postMessage({ type: 'copyCommand', command: cp.__pkCmd() }); return; }
    if (t && t.closest && t.closest('input, textarea, select')) return;
    const sel = window.getSelection && window.getSelection().toString();
    if (sel && sel.length > 0) return;
    e.preventDefault();
  });

  function pkTabs(root) {
    const bar = root.querySelector('.pk-tabs');
    const pages = Array.prototype.slice.call(root.querySelectorAll('[data-page]'));
    function show(id) {
      bar.querySelectorAll('.pk-tab').forEach((b) => b.classList.toggle('pk-tab--active', b.dataset.tab === id));
      pages.forEach((p) => { p.hidden = p.dataset.page !== id; });
    }
    bar.querySelectorAll('.pk-tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    return { show };
  }

  function pkToast(el, text) {
    el.textContent = text || L['pk.saved'];
    el.classList.add('pk-toast--show');
    clearTimeout(el.__pkT);
    el.__pkT = setTimeout(() => el.classList.remove('pk-toast--show'), 1200);
  }

  // opts: { value, required, validate(v)->bool, onSave(v), toastEl }
  // Rules: unchanged value doesn't save / clearing a required field restores the old
  //   value / invalid -> red border, no save / Enter -> save / toast shows for 1.2s
  function pkBindSave(input, opts) {
    let initial = String(opts.value == null ? '' : opts.value);
    input.value = initial;
    function commit() {
      const v = input.value;
      if (v === initial) return;
      if (opts.required && v.trim() === '') { input.value = initial; input.classList.remove('pk-input--invalid'); return; }
      if (opts.validate && !opts.validate(v)) { input.classList.add('pk-input--invalid'); return; }
      input.classList.remove('pk-input--invalid');
      initial = v;
      opts.onSave(v);
      if (opts.toastEl) pkToast(opts.toastEl);
    }
    input.addEventListener('blur', commit);
    input.addEventListener('input', () => input.classList.remove('pk-input--invalid'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  }

  function pkPill(state, text) {
    const s = document.createElement('span');
    s.className = 'pk-pill pk-pill--' + state;
    const glyph = { ok: '✓ ', miss: '✗ ', warn: '⚠ ', muted: '● ' }[state] || '● ';
    s.textContent = glyph + text;
    return s;
  }

  // Finds the .pk-item with data-<attr>="<val>" in a list (used to target a progress bar / status line).
  function pkFindItem(listEl, attr, val) {
    for (const it of listEl.querySelectorAll('.pk-item')) {
      if (it.dataset[attr] === val) return it;
    }
    return null;
  }

  // Disables a card's buttons while it's busy, then restores them.
  function pkSetBusy(item, busy) {
    item.querySelectorAll('button').forEach((b) => {
      if (busy) { b.dataset.pkWas = b.disabled ? '' : '1'; b.disabled = true; }
      else { if (b.dataset.pkWas === '1') b.disabled = false; delete b.dataset.pkWas; }
    });
  }

  // Marks a button so right-clicking it copies the shell command it runs.
  function pkAttachCopy(btn, getCmd) { btn.setAttribute('data-pk-copy', ''); btn.__pkCmd = getCmd; }

  // ▲▼ reorder buttons for a list card. Post {type:<msgType>, id, dir} (msgType
  // defaults to 'moveDevice'); the up/down button is disabled at the list ends.
  function pkMoveBtns(id, canUp, canDown, msgType) {
    const type = msgType || 'moveDevice';
    const wrap = document.createElement('span');
    wrap.className = 'pk-move';
    const mk = (glyph, dir, enabled) => {
      const b = document.createElement('button');
      b.className = 'pk-btn pk-btn--sm pk-move__b';
      b.textContent = glyph;
      b.title = dir < 0 ? L['wc.move.up'] : L['wc.move.down'];
      b.disabled = !enabled;
      b.addEventListener('click', () => vscode.postMessage({ type: type, id: id, dir: dir }));
      return b;
    };
    wrap.appendChild(mk('▲', -1, canUp));
    wrap.appendChild(mk('▼', 1, canDown));
    return wrap;
  }

  // The progress bar is a fixed 2px strip on the log panel and never toggles
  // display, so these only move the fill and (optionally) the header label.
  function pkProgress(item, ratio, message) {
    const fill = item.querySelector('.pk-progress__fill');
    if (fill) fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio)) + ')';
    const ttl = item.querySelector('[data-role="constitle"]');
    if (ttl && message != null && message !== '') ttl.textContent = message;
  }
  function pkProgressDone(item) {
    const fill = item.querySelector('.pk-progress__fill');
    if (fill) fill.style.transform = 'scaleX(1)';
    setTimeout(() => { if (fill) fill.style.transform = 'scaleX(0)'; }, 500);
    const ttl = item.querySelector('[data-role="constitle"]');
    if (ttl) ttl.textContent = L['wc.log.title'];
  }
`;

/**
 * The "Frida Server" tab, shared verbatim by the Android and iOS manage panels.
 * Each panel builds a `cfg` with the handful of per-platform differences and calls
 * `pkRenderServerCards` / `pkServerOnMessage`; the card markup, progress bar,
 * cancel button, console log and version-match pill are identical on both.
 *
 * cfg fields:
 *   idKey          "serial" | "udid" — the dataset key the host addresses cards by
 *   profiles       [{ version, name }] — registered profiles, for the match pill
 *   reachable(row) whether this device can be driven right now (adb online / ssh ok)
 *   noReachNote    line shown under the title when !reachable — string, (row)=>string, or null
 *   optDisconnected  <select> placeholder when unreachable and nothing installed
 *   cardTitle(row) heading text
 *   headPill(row)  { state, text } for the connection pill
 *   statusLine(row)  running / not-running text (any arch prefix already applied)
 *   cmdCheck/cmdInstall/cmdStop(row), cmdRun/cmdDelete(row, path) — copyable shell commands
 */
export const PK_SERVER_JS = `
  // Console output survives the list re-render that follows each operation, so the
  // log of the last install / run stays readable until a new one starts.
  const pkServerLogs = Object.create(null);

  function pkServerMatchPill(cfg, row) {
    const nameOf = (p) => p.displayName || p.name;
    // Pinned companion profile — shown always, but the colour reflects whether its
    // frida version actually lines up with what's running:
    //   green = pinned AND versions match, muted = can't tell (nothing running),
    //   amber = pinned but the running frida-server is a different version.
    if (row.preferredProfile) {
      const p = (cfg.profiles || []).find((x) => x.name === row.preferredProfile);
      if (p) {
        const runVer = row.running ? (row.runningVersion || '') : '';
        if (!runVer) return pkPill('muted', L['wc.pill.pinnedUnverified'].replace('{0}', nameOf(p)));
        if (p.version === runVer) return pkPill('ok', L['wc.pill.match'].replace('{0}', nameOf(p)));
        return pkPill('warn', L['wc.pill.pinnedMismatch'].replace('{0}', nameOf(p)).replace('{1}', runVer));
      }
    }
    // Auto: only match against the version frida-server is actually running right
    // now. Nothing running (or unreachable) = no companion, so no pill.
    if (!row.running || !row.runningVersion) return null;
    const hits = (cfg.profiles || []).filter((p) => p.version === row.runningVersion).map(nameOf);
    if (hits.length) return pkPill('ok', L['wc.pill.match'].replace('{0}', hits.join(', ')));
    return pkPill('set', L['wc.pill.noProfile']);
  }

  function pkServerConsoleLine(item, line) {
    const cons = item.querySelector('[data-role="console"]');
    if (!cons || cons.__last === line) return;
    const wrap = item.querySelector('[data-role="consolewrap"]');
    if (wrap) wrap.classList.remove('pk-hidden');
    // Collapse consecutive progress ticks ("... 5.2 / 12.4 MB" -> "... 6.1 / 12.4
    // MB") onto one live line by comparing the line with its numbers masked;
    // every genuinely different line still appends.
    const tmpl = line.replace(/[\\d.,]+/g, '#');
    if (cons.__tmpl === tmpl && cons.textContent) {
      const nl = cons.textContent.lastIndexOf('\\n');
      cons.textContent = (nl >= 0 ? cons.textContent.slice(0, nl + 1) : '') + line;
    } else {
      cons.textContent += (cons.textContent ? '\\n' : '') + line;
    }
    cons.__last = line;
    cons.__tmpl = tmpl;
    cons.scrollTop = cons.scrollHeight;
    pkServerLogs[item.dataset.id] = cons.textContent;
  }

  function pkServerCard(cfg, row) {
    const id = row[cfg.idKey];
    const reachable = cfg.reachable(row);
    const installed = row.installedServers || [];

    const item = document.createElement('div');
    item.className = 'pk-item';
    item.dataset.id = id;

    const head = document.createElement('div');
    head.className = 'pk-item__head';
    const title = document.createElement('div');
    title.className = 'pk-item__title';
    title.textContent = cfg.cardTitle(row);
    head.appendChild(title);
    const hp = cfg.headPill(row);
    head.appendChild(pkPill(hp.state, hp.text));
    // Swap just this pill in place when the companion changes — no full re-render.
    const setMatchPill = () => {
      const old = head.querySelector('[data-role="matchpill"]');
      const fresh = pkServerMatchPill(cfg, row);
      if (fresh) fresh.dataset.role = 'matchpill';
      if (fresh && old) head.replaceChild(fresh, old);
      else if (fresh) head.appendChild(fresh);
      else if (old) old.remove();
    };
    setMatchPill();
    item.appendChild(head);

    const reachNote = typeof cfg.noReachNote === 'function' ? cfg.noReachNote(row) : cfg.noReachNote;
    // While the probe is still in flight the head pill already says "checking…";
    // don't also show the "couldn't reach the device" note until it's confirmed.
    if (!reachable && reachNote && !row.probing) {
      const note = document.createElement('div');
      note.className = 'pk-row__sub';
      note.style.marginTop = '6px';
      note.textContent = reachNote;
      item.appendChild(note);
    }

    // Companion profile — the venv this device's shell / rocket icon opens. Kept
    // at the top of the card because it's the day-to-day pairing, not a setting.
    if (cfg.profiles && cfg.profiles.length) {
      const cpLabel = document.createElement('div');
      cpLabel.className = 'pk-field__label';
      cpLabel.style.marginTop = '12px';
      cpLabel.textContent = L['wc.companion.label'];
      cpLabel.title = L['wc.companion.hint']; // full explanation on hover, not inline
      item.appendChild(cpLabel);

      const cpSel = document.createElement('select');
      cpSel.className = 'pk-select';
      cpSel.style.marginTop = '4px';
      cpSel.title = L['wc.companion.hint'];
      // Same ✓ / ✗ / · marks as the new-profile frida-tools picker: ✓ this profile's
      // frida version equals what's running, ✗ it differs, · nothing running to check.
      const runVer = row.running ? (row.runningVersion || '') : '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = L['wc.companion.auto'];
      cpSel.appendChild(auto);
      for (const p of cfg.profiles) {
        const o = document.createElement('option');
        o.value = p.name;
        const mark = !runVer ? '·' : (p.version === runVer ? '✓' : '✗');
        o.textContent = mark + ' ' + (p.displayName || p.name) + ' · frida ' + p.version;
        // ✓ match = bold, ✗ mismatch = dimmed (still selectable), · unverified = normal.
        if (mark === '✓') o.style.fontWeight = '700';
        else if (mark === '✗') o.style.color = 'var(--vscode-descriptionForeground)';
        if (p.name === (row.preferredProfile || '')) o.selected = true;
        cpSel.appendChild(o);
      }
      cpSel.addEventListener('change', () => {
        row.preferredProfile = cpSel.value; // keep the card's model in sync across re-renders
        setMatchPill(); // update only this card's pill; host just persists + refreshes the tree
        vscode.postMessage({ type: 'savePreferredProfile', id: id, name: cpSel.value });
      });
      item.appendChild(cpSel);
    }

    const grid = document.createElement('div');
    grid.style.marginTop = '12px';

    const dirLabel = document.createElement('div');
    dirLabel.className = 'pk-field__label';
    dirLabel.textContent = L['wc.field.serverDir'];
    grid.appendChild(dirLabel);
    const dirRow = document.createElement('div');
    dirRow.className = 'pk-fieldrow';
    dirRow.style.marginTop = '4px';
    const dirInput = document.createElement('input');
    dirInput.className = 'pk-input pk-mono';
    const dirToast = document.createElement('span');
    dirToast.className = 'pk-toast';
    pkBindSave(dirInput, {
      value: row.fridaServerDir, required: true,
      onSave: (v) => vscode.postMessage({ type: 'saveFridaServerDir', id: id, dir: v.trim() }),
      toastEl: dirToast,
    });
    dirRow.appendChild(dirInput);
    // Reset to the built-in default — a recovery for a mistyped path when the user
    // doesn't remember what it should be. Sends "" so the host re-derives it.
    const dirReset = document.createElement('button');
    dirReset.className = 'pk-btn pk-btn--sm';
    dirReset.textContent = L['wc.adv.reset'];
    dirReset.title = L['wc.field.serverDirResetHint'];
    dirReset.addEventListener('click', () => vscode.postMessage({ type: 'saveFridaServerDir', id: id, dir: '' }));
    dirRow.appendChild(dirReset);
    grid.appendChild(dirRow);
    grid.appendChild(dirToast);

    const verLabel = document.createElement('div');
    verLabel.className = 'pk-field__label';
    verLabel.style.marginTop = '10px';
    verLabel.textContent = L['wc.field.installedVersion'];
    verLabel.title = L['wc.field.installedVersionHint'];
    grid.appendChild(verLabel);
    const verRow = document.createElement('div');
    verRow.className = 'pk-inline';
    verRow.style.marginTop = '4px';
    const verSelect = document.createElement('select');
    verSelect.className = 'pk-select';
    verSelect.style.flex = '1 1 auto';
    if (installed.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = !reachable
        ? (cfg.optDisconnected || L['wc.opt.noFiles'])
        : row.running
          ? L['wc.opt.noFilesButRunning']
          : L['wc.opt.noFiles'];
      verSelect.appendChild(o);
      verSelect.disabled = true;
    } else {
      // Show what's actually running; fall back to the last stored choice only
      // when nothing is running (so reopening the panel reflects reality).
      const preselect = row.runningPath || row.fridaServerPath || '';
      for (const s of installed) {
        const o = document.createElement('option');
        o.value = s.path;
        // Version first (that's what the user picks by); show the filename after it
        // only when the name isn't the plain "frida-server-<ver>" Frivenv installs.
        // Just the filename — the running version shows in the status line below.
        // dataset.ver (from the name or a --version probe) is what gets stored/matched.
        o.textContent = s.file;
        o.dataset.ver = s.version || (/^frida-server-[\\d.]+$/.test(s.file) ? s.file.replace(/^frida-server-/, '') : '');
        if (s.path === preselect) o.selected = true;
        verSelect.appendChild(o);
      }
    }
    verSelect.addEventListener('change', () => {
      const sel = verSelect.selectedOptions[0];
      vscode.postMessage({ type: 'saveFridaServerInfo', id: id, version: sel ? (sel.dataset.ver || '') : '', path: verSelect.value });
    });
    const del = document.createElement('button');
    del.className = 'pk-btn pk-btn--danger';
    del.textContent = L['wc.btn.deleteBinary'];
    del.disabled = !reachable || installed.length === 0;
    del.addEventListener('click', () => {
      if (!verSelect.value) return;
      const sel = verSelect.selectedOptions[0];
      vscode.postMessage({ type: 'deleteInstalledVersion', id: id, path: verSelect.value, file: sel ? sel.textContent : verSelect.value });
    });
    pkAttachCopy(del, () => cfg.cmdDelete(row, verSelect.value || '<version-path>'));
    verRow.appendChild(verSelect);
    grid.appendChild(verRow);

    // Install / Delete act on the file list above, so they sit right under it
    // (not down in the Run/Stop action row). Install is the common action and
    // gets full weight; Delete stays small + destructive-styled.
    const install = document.createElement('button');
    install.className = 'pk-btn';
    install.textContent = L['wc.btn.upload'];
    install.disabled = !reachable;
    install.addEventListener('click', () => vscode.postMessage({ type: 'installFridaServer', id: id }));
    pkAttachCopy(install, () => cfg.cmdInstall(row));
    del.classList.add('pk-btn--sm');
    const verBtns = document.createElement('div');
    verBtns.className = 'pk-inline';
    verBtns.style.marginTop = '8px';
    verBtns.appendChild(install);
    verBtns.appendChild(del);
    grid.appendChild(verBtns);
    item.appendChild(grid);

    // Status line ("Running · <ver> · <path>") shares the button row: it fills the
    // space to the left of the buttons and ellipsises when long (full text on
    // hover), and is hidden entirely when there's nothing to say.
    const statusEl = document.createElement('div');
    statusEl.className = 'pk-status';
    statusEl.style.cssText = 'flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    statusEl.textContent = reachable
      ? cfg.statusLine(row) + (row.running && row.runningPath ? ' · ' + row.runningPath : '')
      : '';
    statusEl.title = statusEl.textContent;
    if (reachable && row.running) statusEl.classList.add('pk-status--ok');
    statusEl.hidden = !statusEl.textContent;

    const btns = document.createElement('div');
    btns.className = 'pk-btnrow';
    btns.appendChild(statusEl);

    const setStatus = (text, cls) => {
      statusEl.hidden = !text;
      statusEl.textContent = text;
      statusEl.title = text;
      statusEl.className = 'pk-status' + (cls ? ' ' + cls : '');
    };

    const check = document.createElement('button');
    check.className = 'pk-btn';
    check.textContent = L['wc.btn.checkStatus'];
    check.disabled = !reachable;
    check.addEventListener('click', () => {
      setStatus(L['wc.status.checking']);
      vscode.postMessage({ type: 'checkStatus', id: id });
    });
    pkAttachCopy(check, () => cfg.cmdCheck(row));

    // check sits immediately left of Run; Run/Stop keep their danger/primary look.
    const end = document.createElement('div');
    end.className = 'pk-btnrow__end';
    end.appendChild(check);
    const run = document.createElement('button');
    run.className = 'pk-btn pk-btn--primary';
    run.textContent = L['wc.btn.run'];
    run.disabled = !reachable || installed.length === 0;
    run.addEventListener('click', () => {
      const sel = verSelect.selectedOptions[0];
      vscode.postMessage({ type: 'runInstalledVersion', id: id, path: verSelect.value, label: sel ? (sel.dataset.ver || '') : '' });
    });
    pkAttachCopy(run, () => cfg.cmdRun(row, verSelect.value || '<version-path>'));
    end.appendChild(run);
    const stop = document.createElement('button');
    stop.className = 'pk-btn pk-btn--danger';
    stop.textContent = L['wc.btn.stop'];
    stop.disabled = !reachable || !row.running;
    stop.addEventListener('click', () => {
      setStatus(L['wc.status.stopping']);
      vscode.postMessage({ type: 'stopFridaServer', id: id });
    });
    pkAttachCopy(stop, () => cfg.cmdStop(row));
    end.appendChild(stop);
    btns.appendChild(end);
    item.appendChild(btns);

    // Everything that toggles during an op lives ON the log panel: the progress
    // bar is a 2px strip on its top edge, the message rides in its header, and
    // Cancel is a header button. So running an op never resizes the card.
    const cancel = document.createElement('button');
    cancel.className = 'pk-console__act pk-console__act--cancel pk-hidden';
    cancel.dataset.role = 'cancel';
    cancel.textContent = L['wc.cancel'];
    cancel.addEventListener('click', () => { cancel.disabled = true; vscode.postMessage({ type: 'cancelServerOp', id: id }); });

    const prog = document.createElement('div');
    prog.className = 'pk-progress-wrap';
    prog.innerHTML = '<div class="pk-progress"><div class="pk-progress__fill"></div></div>';

    const consWrap = document.createElement('div');
    consWrap.className = 'pk-consolewrap pk-hidden';
    consWrap.dataset.role = 'consolewrap';
    const consBar = document.createElement('div');
    consBar.className = 'pk-console__bar';
    const consTtl = document.createElement('span');
    consTtl.className = 'pk-console__ttl';
    consTtl.dataset.role = 'constitle';
    consTtl.textContent = L['wc.log.title'];
    const consCopy = document.createElement('button');
    consCopy.className = 'pk-console__act';
    consCopy.textContent = L['wc.log.copy'];
    const consClear = document.createElement('button');
    consClear.className = 'pk-console__act';
    consClear.textContent = L['wc.log.clear'];
    consBar.appendChild(consTtl);
    consBar.appendChild(cancel);
    consBar.appendChild(consCopy);
    consBar.appendChild(consClear);
    const cons = document.createElement('div');
    cons.className = 'pk-console';
    cons.dataset.role = 'console';
    consCopy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyCommand', command: cons.textContent || '' });
    });
    consClear.addEventListener('click', () => {
      cons.textContent = '';
      cons.__last = null;
      pkServerLogs[id] = '';
      consWrap.classList.add('pk-hidden');
    });
    consWrap.appendChild(prog); // 2px bar on the panel's top edge
    consWrap.appendChild(consBar);
    consWrap.appendChild(cons);
    if (pkServerLogs[id]) {
      cons.textContent = pkServerLogs[id];
      cons.__last = pkServerLogs[id].split('\\n').pop() || null; // keep dedup across rebuilds
      consWrap.classList.remove('pk-hidden');
    }
    item.appendChild(consWrap);

    return item;
  }

  // Keyed reconcile: only the cards whose row data actually changed are rebuilt,
  // so an operation on one device doesn't flash the whole list. Cards are matched
  // by data-id; a card whose serialised row is unchanged is left in the DOM as-is
  // (keeping its scroll position, console log, focus).
  const pkRowCache = Object.create(null);
  function pkRenderServerCards(listEl, emptyEl, rows, cfg) {
    emptyEl.textContent = cfg.emptyText || L['wc.noDevices'];
    emptyEl.hidden = rows.length > 0;
    const seen = Object.create(null);
    rows.forEach((row, i) => {
      const rid = String(row[cfg.idKey]);
      seen[rid] = 1;
      const json = JSON.stringify(row) + '|' + JSON.stringify(cfg.profiles || []);
      const existing = pkFindItem(listEl, 'id', rid);
      let node = existing;
      if (!existing || pkRowCache[rid] !== json) {
        node = pkServerCard(cfg, row);
        if (existing) listEl.replaceChild(node, existing);
        pkRowCache[rid] = json;
      }
      if (listEl.children[i] !== node) listEl.insertBefore(node, listEl.children[i] || null);
    });
    for (const child of Array.prototype.slice.call(listEl.children)) {
      if (!seen[child.dataset.id]) { delete pkRowCache[child.dataset.id]; child.remove(); }
    }
  }

  // A "Checking… (Ns)" ticker so a slow enumeration doesn't look frozen. Shared by
  // both device panels (list + server empty states); one timer drives every element.
  let pkLoadingEls = [];
  let pkLoadingTimer = null;
  let pkLoadingT0 = 0;
  function pkLoadingTick() {
    const secs = Math.round((Date.now() - pkLoadingT0) / 1000);
    if (secs >= 60) {
      // Give up counting after a minute and tell the user to check their network / retry.
      for (const el of pkLoadingEls) el.textContent = L['wc.loadingTimeout'];
      if (pkLoadingTimer) { clearInterval(pkLoadingTimer); pkLoadingTimer = null; }
      return;
    }
    const txt = L['wc.loadingElapsed'].replace('{0}', String(secs));
    for (const el of pkLoadingEls) el.textContent = txt;
  }
  function pkLoadingStart(el) {
    if (pkLoadingEls.indexOf(el) < 0) pkLoadingEls.push(el);
    el.hidden = false;
    if (!pkLoadingTimer) { pkLoadingT0 = Date.now(); pkLoadingTick(); pkLoadingTimer = setInterval(pkLoadingTick, 1000); }
  }
  function pkLoadingStop() {
    if (pkLoadingTimer) { clearInterval(pkLoadingTimer); pkLoadingTimer = null; }
    pkLoadingEls = [];
  }

  // Handles the host messages the server tab cares about. Returns true when handled.
  function pkServerOnMessage(listEl, emptyEl, cfg, msg) {
    if (msg.type === 'loading') {
      if (listEl.children.length === 0) pkLoadingStart(emptyEl);
      return true;
    }
    if (msg.type === 'statusResult') {
      const it = pkFindItem(listEl, 'id', msg.id);
      if (it) {
        const el = it.querySelector('.pk-status');
        if (el) {
          el.hidden = !msg.message;
          el.textContent = msg.message;
          el.title = msg.message || '';
          el.className = 'pk-status' + (!msg.ok ? ' pk-status--fail' : msg.running ? ' pk-status--ok' : '');
        }
      }
      return true;
    }
    if (msg.type === 'progress') {
      const it = pkFindItem(listEl, 'id', msg.id);
      if (it) {
        if (!it.dataset.pkBusy) {
          it.dataset.pkBusy = '1';
          pkSetBusy(it, true);
          const cr = it.querySelector('[data-role="cancel"]');
          if (cr) { cr.classList.remove('pk-hidden'); cr.disabled = false; }
          // Reveal the log panel now so its header (progress message + Cancel)
          // has a home even before the first line lands.
          const cw = it.querySelector('[data-role="consolewrap"]');
          if (cw) cw.classList.remove('pk-hidden');
          // fresh operation: drop the previous run's log
          const cons = it.querySelector('[data-role="console"]');
          if (cons) { cons.textContent = ''; cons.__last = null; }
          pkServerLogs[msg.id] = '';
        }
        // bar:true = a status header — shown in the log panel's header, not the
        // log body. Everything else is real command output: it goes to the
        // copyable log and just advances the bar.
        pkProgress(it, msg.percent / 100, msg.bar ? msg.message : null);
        if (msg.message && !msg.bar) pkServerConsoleLine(it, msg.message);
      }
      return true;
    }
    if (msg.type === 'progressDone') {
      const it = pkFindItem(listEl, 'id', msg.id);
      if (it) {
        delete it.dataset.pkBusy;
        pkSetBusy(it, false);
        pkProgressDone(it);
        const cr = it.querySelector('[data-role="cancel"]');
        if (cr) cr.classList.add('pk-hidden');
      }
      return true;
    }
    return false;
  }
`;
