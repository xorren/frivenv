import * as vscode from "vscode";
import { ko } from "./i18n/ko";
import { en } from "./i18n/en";

/**
 * Runtime UI strings. `frivenv.language` ("auto" | "ko" | "en") picks the language.
 * Strings in package.json (command titles, setting descriptions, ...) are read
 * before activation, so they follow the VS Code display language instead, via
 * package.nls.json / package.nls.ko.json.
 */
export type Lang = "ko" | "en";

const bundles: Record<Lang, Record<string, string>> = { ko, en };

/** The language to use right now. "auto" checks whether the VS Code UI is Korean. */
export function currentLang(): Lang {
  const pref = vscode.workspace.getConfiguration("frivenv").get<string>("language") ?? "auto";
  if (pref === "ko" || pref === "en") {
    return pref;
  }
  return (vscode.env.language ?? "en").toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** Looks up a key in the current language, falling back to Korean then the key itself. Substitutes `{0}`, `{1}`, ... */
export function t(key: string, ...args: Array<string | number>): string {
  const lang = currentLang();
  const raw = bundles[lang][key] ?? ko[key] ?? key;
  return raw.replace(/\{(\d+)\}/g, (_, i: string) => {
    const v = args[Number(i)];
    return v === undefined ? `{${i}}` : String(v);
  });
}

/** A bundle of strings to hand to a webview whole: keys under `prefix`, current-language values. */
export function bundleFor(prefix: string): Record<string, string> {
  const lang = currentLang();
  const out: Record<string, string> = {};
  for (const k of Object.keys(ko)) {
    if (k.startsWith(prefix)) {
      out[k] = bundles[lang][k] ?? ko[k];
    }
  }
  return out;
}

/** Fires when `frivenv.language` changes; the listener refreshes trees and re-renders open panels. */
export function onLanguageChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("frivenv.language")) {
      listener();
    }
  });
}
