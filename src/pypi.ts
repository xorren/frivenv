import * as https from "https";
import * as zlib from "zlib";

/**
 * Requests the PyPI Simple API (JSON). The regular `/pypi/<pkg>/json` endpoint
 * includes full metadata for every distribution file, so for a package with many
 * releases like frida the response is several to tens of MB and used to time out
 * on slow links. The Simple API is mostly just the version list, so it's much
 * lighter, and asking for gzip cuts the transfer further.
 */
function fetchSimpleIndex(pkg: string): Promise<{ versions: string[] }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://pypi.org/simple/${pkg}/`,
      {
        headers: {
          "User-Agent": "frivenv-vscode",
          Accept: "application/vnd.pypi.simple.v1+json",
          "Accept-Encoding": "gzip",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
        let body = "";
        stream.setEncoding("utf-8");
        stream.on("data", (chunk) => (body += chunk));
        stream.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout (30s)")));
  });
}

function compareVersionsDesc(a: string, b: string): number {
  const key = (v: string) => v.split(/[.-]/).flatMap((part) => (/^\d+$/.test(part) ? [1, Number(part)] : [0, part]));
  const ka = key(a);
  const kb = key(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const va = ka[i] ?? 0;
    const vb = kb[i] ?? 0;
    if (va !== vb) {
      if (typeof va === "number" && typeof vb === "number") {
        return vb - va;
      }
      return String(vb).localeCompare(String(va));
    }
  }
  return 0;
}

/** Returns a package's released versions, newest first. Empty array on failure. */
export async function getAvailableVersions(pkg: string): Promise<string[]> {
  try {
    const data = await fetchSimpleIndex(pkg);
    const versions = [...(data.versions ?? [])];
    versions.sort(compareVersionsDesc);
    return versions;
  } catch {
    return [];
  }
}

function fetchVersionMetadata(pkg: string, version: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://pypi.org/pypi/${pkg}/${version}/json`,
      { headers: { "User-Agent": "frivenv-vscode", "Accept-Encoding": "gzip" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const stream = res.headers["content-encoding"] === "gzip" ? res.pipe(zlib.createGunzip()) : res;
        let body = "";
        stream.setEncoding("utf-8");
        stream.on("data", (chunk) => (body += chunk));
        stream.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout (10s)")));
  });
}

const COMPAT_CHECK_LIMIT = 60; // only check the newest N versions for compatibility (caps request count)

/**
 * Looks up, in parallel, the frida version spec each frida-tools version requires
 * (from its PyPI `requires_dist`). Returns { version: spec-string like ">=17.10.0,<18.0.0" }.
 * Versions with no frida dependency listed, or where the lookup failed, are left out
 * (old releases like frida-tools 12.x/13.x have `requires_dist: null` on PyPI).
 */
export async function getFridaRequirementMap(versions: string[]): Promise<Record<string, string>> {
  const targets = versions.slice(0, COMPAT_CHECK_LIMIT);
  const entries = await Promise.all(
    targets.map(async (version): Promise<[string, string | undefined]> => {
      try {
        const data = await fetchVersionMetadata("frida-tools", version);
        const requiresDist: string[] = data?.info?.requires_dist ?? [];
        for (const req of requiresDist) {
          const reqMain = req.split(";")[0].trim();
          if (!/^frida\b/i.test(reqMain)) {
            continue;
          }
          const nameMatch = /^([A-Za-z0-9_.-]+)/.exec(reqMain);
          if (!nameMatch || nameMatch[1].toLowerCase() !== "frida") {
            continue; // skip entries like "frida-tools" itself
          }
          const spec = reqMain.slice(nameMatch[1].length).trim().replace(/^\(|\)$/g, "");
          return [version, spec || undefined];
        }
        return [version, undefined];
      } catch {
        return [version, undefined];
      }
    })
  );

  const map: Record<string, string> = {};
  for (const [version, spec] of entries) {
    if (spec) {
      map[version] = spec;
    }
  }
  return map;
}

/**
 * Splits a version into its numeric release parts plus a pre-release rank. A
 * pre-release (`17.0.0rc1`, `1.2b3`) sorts *below* the matching final release, so
 * its rank is negative. Enough for the frida version specifiers we match against;
 * not a full PEP 440 implementation.
 */
function parseVersion(version: string): { release: number[]; pre: number } {
  const m = /^\s*v?(\d+(?:\.\d+)*)(?:[._-]?(a|b|c|rc|alpha|beta|pre|preview|dev)\.?(\d*))?/i.exec(version);
  if (!m) {
    return { release: [0], pre: 0 };
  }
  const release = m[1].split(".").map((p) => parseInt(p, 10) || 0);
  const pre = m[2] ? -1000 + (parseInt(m[3], 10) || 0) : 0;
  return { release, pre };
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.release.length, pb.release.length); i++) {
    const diff = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return pa.pre - pb.pre;
}

/** Checks whether `version` satisfies a comma-separated PEP 440-style spec like "17.10.0,<18.0.0". */
export function satisfiesSpecifier(version: string, specifier: string): boolean {
  const clauses = specifier.split(",").map((s) => s.trim()).filter(Boolean);
  if (clauses.length === 0) {
    return true;
  }
  return clauses.every((clause) => {
    const match = /^(>=|<=|==|!=|~=|>|<)?\s*([0-9][0-9A-Za-z.*+-]*)/.exec(clause);
    if (!match) {
      return true;
    }
    const [, opRaw, target] = match;
    const op = opRaw || "==";
    const cmp = compareVersions(version, target);
    switch (op) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case "==":
        return cmp === 0;
      case "!=":
        return cmp !== 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      case "~=": {
        // PEP 440 compatible release: `~=1.2.3` == `>=1.2.3, <1.3.0`.
        if (cmp < 0) {
          return false;
        }
        const parts = target.split(".");
        if (parts.length < 2) {
          return true;
        }
        const upper = parts.slice(0, -1);
        upper[upper.length - 1] = String((parseInt(upper[upper.length - 1], 10) || 0) + 1);
        return compareVersions(version, upper.join(".")) < 0;
      }
      default:
        return true;
    }
  });
}

export type FridaToolsCompat = "ok" | "bad" | "unknown";

/**
 * Classifies each frida-tools version against a chosen frida version:
 *   ok      - its requires_dist frida spec is satisfied
 *   bad     - its frida spec is known and NOT satisfied
 *   unknown - no frida spec on PyPI (old release), so we can't tell
 * The UI shows all three rather than hiding anything, so the user can see which
 * combos are verified vs merely unverified.
 */
export function classifyFridaToolsVersions(
  candidates: string[],
  requirementMap: Record<string, string>,
  fridaVersion: string
): Record<string, FridaToolsCompat> {
  const out: Record<string, FridaToolsCompat> = {};
  for (const v of candidates) {
    const spec = requirementMap[v];
    out[v] = !spec ? "unknown" : satisfiesSpecifier(fridaVersion, spec) ? "ok" : "bad";
  }
  return out;
}
