import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { XzReadableStream } from "xz-decompress";
import { extractFridaFilesFromDeb } from "./debExtract";
import { t } from "./i18n";

export interface DownloadProgress {
  message: string;
  /** Progress 0-100, or undefined when unknown (no content-length in the response). */
  percent?: number;
}

export function fridaServerDownloadUrl(version: string, arch: string): string {
  return `https://github.com/frida/frida/releases/download/${version}/frida-server-${version}-android-${arch}.xz`;
}

/**
 * For iOS the releases don't ship a raw xz binary like Android; frida-server is
 * only distributed as a Cydia/Sileo .deb (frida_<version>_iphoneos-<arch>.deb).
 * arch is "arm64" (most physical devices) or "arm" for older 32-bit devices.
 */
export function iosFridaDebDownloadUrl(version: string, arch: string): string {
  return `https://github.com/frida/frida/releases/download/${version}/frida_${version}_iphoneos-${arch}.deb`;
}

/** Fetches bytes from a URL in chunks, reporting real progress. Decompression, etc. is up to the caller. */
async function fetchBytesWithProgress(
  url: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<Buffer> {
  onProgress({ message: t("dl.start", url) });

  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(t("dl.failedHttp", res.status, url));
  }

  const totalBytes = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    receivedBytes += value.length;

    const receivedMb = (receivedBytes / 1024 / 1024).toFixed(1);
    if (totalBytes > 0) {
      const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
      const percent = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
      onProgress({ message: t("dl.progressMb", receivedMb, totalMb), percent });
    } else {
      onProgress({ message: t("dl.progressMbNoTotal", receivedMb) });
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Extracted frida-server binaries are cached here by name, so re-installing the
 * same version on another device is instant and works offline. Safe to delete;
 * a missing entry just re-downloads.
 */
function cacheDir(): string {
  const dir = path.join(os.tmpdir(), "frivenv-cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Downloads the frida-server .xz from a GitHub release, decompresses it, and returns
 * a local file path (cached — see cacheDir). Uses the global fetch built into the VS
 * Code extension host (Node 18+), which follows redirects. The download is read chunk
 * by chunk to report real byte progress; decompression is CPU work and finishes quickly.
 */
export async function downloadFridaServer(
  version: string,
  arch: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const cachePath = path.join(cacheDir(), `frida-server-${version}-${arch}`);
  if (fs.existsSync(cachePath)) {
    onProgress({ message: t("dl.cached", cachePath), percent: 100 });
    return cachePath;
  }

  const url = fridaServerDownloadUrl(version, arch);
  const compressed = await fetchBytesWithProgress(url, onProgress, signal);

  onProgress({ message: t("dl.decompressing"), percent: 99 });
  const compressedBody = new Response(new Blob([compressed])).body;
  const xzStream = new XzReadableStream(compressedBody!);
  const xzReader = xzStream.getReader();
  const outChunks: Buffer[] = [];
  while (true) {
    const { done, value } = await xzReader.read();
    if (done) {
      break;
    }
    outChunks.push(Buffer.from(value));
  }
  const binary = Buffer.concat(outChunks);

  fs.writeFileSync(cachePath, binary);
  onProgress({ message: t("dl.decompressed", (binary.length / 1024 / 1024).toFixed(1)), percent: 100 });
  return cachePath;
}

export interface IosFridaFiles {
  serverPath: string;
  /** Local path to frida-agent.dylib, when the .deb shipped one (needed for `frida -f` spawn). */
  agentPath?: string;
}

/**
 * Downloads the iOS .deb, extracts frida-server (+ frida-agent.dylib, when the
 * .deb ships one) inside it, and returns local file paths (cached — both files
 * must be cached for a cache hit, so upgrading from an older Frivenv that only
 * cached the server re-extracts once to pick up the agent too).
 */
export async function downloadIosFridaServer(
  version: string,
  arch: string,
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<IosFridaFiles> {
  const cachePath = path.join(cacheDir(), `frida-server-ios-${version}-${arch}`);
  const agentCachePath = path.join(cacheDir(), `frida-agent-ios-${version}-${arch}.dylib`);
  if (fs.existsSync(cachePath) && fs.existsSync(agentCachePath)) {
    onProgress({ message: t("dl.cached", cachePath), percent: 100 });
    return { serverPath: cachePath, agentPath: agentCachePath };
  }

  const url = iosFridaDebDownloadUrl(version, arch);
  const debBuffer = await fetchBytesWithProgress(url, onProgress, signal);

  onProgress({ message: t("dl.extractingFromDeb"), percent: 99 });
  const files = await extractFridaFilesFromDeb(debBuffer);

  fs.writeFileSync(cachePath, files.server);
  let agentPath: string | undefined;
  if (files.agent) {
    fs.writeFileSync(agentCachePath, files.agent);
    agentPath = agentCachePath;
  }
  onProgress({ message: t("dl.extracted", (files.server.length / 1024 / 1024).toFixed(1)), percent: 100 });
  return { serverPath: cachePath, agentPath };
}
