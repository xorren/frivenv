import * as zlib from "zlib";
import { XzReadableStream } from "xz-decompress";
import { t } from "./i18n";

interface ArEntry {
  name: string;
  data: Buffer;
}

/**
 * A .deb is just an ar(1) archive (three members: debian-binary, control.tar.*,
 * data.tar.*). We parse the minimum ourselves to avoid another npm dependency —
 * .deb member names are short enough that the GNU extended-filename table never
 * applies, so plain ar parsing is enough.
 */
function parseAr(buf: Buffer): ArEntry[] {
  const MAGIC = "!<arch>\n";
  if (buf.toString("latin1", 0, MAGIC.length) !== MAGIC) {
    throw new Error(t("dl.badDeb"));
  }
  const entries: ArEntry[] = [];
  let offset = MAGIC.length;
  while (offset + 60 <= buf.length) {
    const header = buf.toString("latin1", offset, offset + 60);
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    const sizeStr = header.slice(48, 58).trim();
    const size = parseInt(sizeStr, 10);
    if (!name || Number.isNaN(size)) {
      break;
    }
    const dataStart = offset + 60;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, data: Buffer.from(data) });
    offset = dataStart + size + (size % 2 === 1 ? 1 : 0);
  }
  return entries;
}

/** Minimal POSIX/GNU tar parse; returns the (already-decompressed) member list. */
function parseTar(buf: Buffer): ArEntry[] {
  const entries: ArEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    let name = header.toString("latin1", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("latin1", 345, 500).replace(/\0.*$/, "");
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    const sizeOctal = header.toString("latin1", 124, 136).replace(/\0.*$/, "").trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const dataStart = offset + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    entries.push({ name, data: Buffer.from(data) });
    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;
  }
  return entries;
}

function decompressXzOrGz(buf: Buffer, isXz: boolean): Promise<Buffer> | Buffer {
  if (!isXz) {
    return zlib.gunzipSync(buf);
  }
  return (async () => {
    const compressedBody = new Response(new Blob([buf])).body;
    const xzStream = new XzReadableStream(compressedBody!);
    const reader = xzStream.getReader();
    const chunks: Buffer[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  })();
}

/**
 * Finds and extracts the frida-server binary inside frida's iOS .deb
 * (frida_<version>_iphoneos-<arch>.deb). This step is needed because the GitHub
 * releases don't provide a raw xz-compressed binary for iOS the way they do for
 * Android; iOS is only shipped as a Cydia/Sileo .deb.
 */
export async function extractFridaServerFromDeb(debBuffer: Buffer): Promise<Buffer> {
  const arEntries = parseAr(debBuffer);
  const dataEntry = arEntries.find((e) => e.name.startsWith("data.tar"));
  if (!dataEntry) {
    throw new Error(t("dl.noDataTar"));
  }
  const isXz = dataEntry.name.endsWith(".xz");
  const isGz = dataEntry.name.endsWith(".gz");
  if (!isXz && !isGz) {
    throw new Error(t("dl.badDataTar", dataEntry.name));
  }
  const tarBuf = await decompressXzOrGz(dataEntry.data, isXz);
  const tarEntries = parseTar(tarBuf);
  const binEntry = tarEntries.find((e) => {
    const base = e.name.split("/").pop();
    return base === "frida-server" && e.data.length > 0;
  });
  if (!binEntry) {
    throw new Error(t("dl.noBinaryInDeb"));
  }
  return binEntry.data;
}
