// Hand-built tar.gz / zip archives for the safe-extract and desktop-runtime tests — including the
// hostile entries (traversal, absolute paths, escaping links, devices) a real archiver won't write.

/** One tar entry. `type`: "0" file, "5" dir, "2" symlink, "1" hard link, "3"/"4" device, "6" FIFO. */
export interface TarEntry {
  name: string;
  type?: string;
  data?: Uint8Array | string;
  mode?: number;
  link?: string;
}

import { gzipBytes } from "../src/build/precompress.ts";

const enc = new TextEncoder();

function put(h: Uint8Array, off: number, len: number, s: string): void {
  h.set(enc.encode(s).subarray(0, len), off);
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function tarHeader(e: TarEntry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  put(h, 0, 100, e.name);
  put(h, 100, 8, octal(e.mode ?? 0o644, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  put(h, 124, 12, octal(size, 12));
  put(h, 136, 12, octal(0, 12));
  put(h, 148, 8, "        ");
  put(h, 156, 1, e.type ?? "0");
  put(h, 157, 100, e.link ?? "");
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** An uncompressed tar of `entries` (with the end-of-archive marker). */
function tar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data ?? new Uint8Array(0);
    parts.push(tarHeader(e, data.byteLength), data);
    const pad = (512 - (data.byteLength % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

/** A `.tar.gz` of `entries`. */
export async function tarGz(entries: TarEntry[]): Promise<Uint8Array> {
  return await gzipBytes(tar(entries));
}

/** One zip entry; `unixMode` (with the S_IF* type bits) marks it Unix-made. */
export interface ZipEntry {
  name: string;
  data?: Uint8Array | string;
  deflate?: boolean;
  unixMode?: number;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const deflate = new CompressionStream("deflate-raw");
  return await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(deflate)).bytes();
}

/** A zip of `entries` (CRC fields are zero: the extractor reads sizes from the directory). */
export async function zip(entries: ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data ?? new Uint8Array(0);
    const body = e.deflate ? await deflateRaw(raw) : raw;
    const name = enc.encode(e.name);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true);
    loc.setUint16(4, 20, true);
    loc.setUint16(8, e.deflate ? 8 : 0, true);
    loc.setUint32(18, body.byteLength, true);
    loc.setUint32(22, raw.byteLength, true);
    loc.setUint16(26, name.byteLength, true);
    locals.push(new Uint8Array(loc.buffer), name, body);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, e.unixMode !== undefined ? (3 << 8) | 20 : 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(10, e.deflate ? 8 : 0, true);
    cen.setUint32(20, body.byteLength, true);
    cen.setUint32(24, raw.byteLength, true);
    cen.setUint16(28, name.byteLength, true);
    cen.setUint32(38, e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.byteLength + body.byteLength;
  }
  const cenBytes = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cenBytes.byteLength, true);
  end.setUint32(16, offset, true);
  return concat([...locals, cenBytes, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Lowercase hex SHA-256. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
