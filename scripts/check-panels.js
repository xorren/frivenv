// Checks that the <script> block inside each of the three webview panels' renderHtml()
// is syntactically valid. Panel scripts are assembled as strings, so tsc can't see them.
// `npm run check` runs this after tsc. (It requires tsc's emitted output in out/.)
const path = require("path");
const Module = require("module");

const OUT = path.join(__dirname, "..", "out");

// vscode module stub (just enough to call renderHtml).
const vscodeStub = new Proxy(
  {
    window: new Proxy({}, { get: () => () => ({}) }),
    ViewColumn: { Active: 1 },
    Uri: { parse: (s) => s },
    env: {},
    commands: {},
    workspace: { getConfiguration: () => ({ get: () => "", update: () => {} }) },
  },
  { get: (t, p) => (p in t ? t[p] : new Proxy({}, { get: () => () => {} })) }
);

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return origLoad.call(this, request, ...rest);
};

const panels = [
  ["manageProfilesPanel.js", "ManageProfilesPanel"],
  ["manageDevicesPanel.js", "ManageDevicesPanel"],
  ["manageIosDevicesPanel.js", "ManageIosDevicesPanel"],
];

let failed = false;
for (const [file, cls] of panels) {
  const mod = require(path.join(OUT, "webview", file));
  const proto = mod[cls].prototype;
  const fake = Object.create(proto);
  fake.panel = { webview: { cspSource: "vscode-resource:" } };
  let html;
  try {
    html = proto.renderHtml.call(fake);
  } catch (e) {
    console.error(`[${file}] renderHtml threw: ${e.message}`);
    failed = true;
    continue;
  }
  const m = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  if (!m) {
    console.error(`[${file}] no <script> block found`);
    failed = true;
    continue;
  }
  try {
    new Function("acquireVsCodeApi", "window", "document", m[1]);
    console.log(`[${file}] OK`);
  } catch (e) {
    console.error(`[${file}] script syntax error: ${e.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
