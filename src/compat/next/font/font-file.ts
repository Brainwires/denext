/**
 * Read the metrics `next/font/local`'s metric-matched fallback needs straight from a font
 * file — no npm, no fontkit. Understands bare sfnt (TrueType / OpenType `.ttf` / `.otf`),
 * WOFF (zlib per table) and WOFF2 (one Brotli stream; only untransformed tables plus the
 * advance widths of a transformed `hmtx` are read, so the `glyf` transform never needs
 * decoding). Decompression uses Deno's `node:zlib` (`inflateSync` / `brotliDecompressSync`),
 * reached through `process.getBuiltinModule` so a browser bundle never imports it.
 *
 * The numbers are the ones fontkit hands Next's `getFallbackMetricsFromFontFile`:
 * `head.unitsPerEm`, `hhea` ascender / descender / lineGap, and the average `hmtx` advance of
 * Next's sample string (`undefined` when the font lacks one of its characters).
 *
 * @module
 */

/** The metrics of one font file, in font units. */
export interface FontFileMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /** Average advance of Next's sample text, or `undefined` when a character is missing. */
  azAvgWidth: number | undefined;
}

/** Next's letter-frequency-weighted sample (`calcAverageWidth`). */
const AVG_CHARACTERS = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";

type Tables = Map<string, DataView>;

interface Zlib {
  inflateSync(buf: Uint8Array): Uint8Array;
  brotliDecompressSync(buf: Uint8Array): Uint8Array;
}

/** `node:zlib` when the runtime has it (Deno / Node), else `null` (a browser). */
function zlib(): Zlib | null {
  const proc = (globalThis as { process?: { getBuiltinModule?(id: string): unknown } }).process;
  return (proc?.getBuiltinModule?.("node:zlib") as Zlib | undefined) ?? null;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tagAt(dv: DataView, offset: number): string {
  return String.fromCharCode(
    dv.getUint8(offset),
    dv.getUint8(offset + 1),
    dv.getUint8(offset + 2),
    dv.getUint8(offset + 3),
  );
}

/** The tables of a bare sfnt (TrueType / CFF OpenType). */
function sfntTables(bytes: Uint8Array): Tables {
  const dv = view(bytes);
  const tables: Tables = new Map();
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const rec = 12 + i * 16;
    const offset = dv.getUint32(rec + 8);
    tables.set(tagAt(dv, rec), view(bytes.subarray(offset, offset + dv.getUint32(rec + 12))));
  }
  return tables;
}

/** The tables of a WOFF 1.0 file (each zlib-compressed unless stored raw). */
function woffTables(bytes: Uint8Array, z: Zlib): Tables {
  const dv = view(bytes);
  const tables: Tables = new Map();
  for (let i = 0, n = dv.getUint16(12); i < n; i++) {
    const rec = 44 + i * 20;
    const offset = dv.getUint32(rec + 4);
    const compLength = dv.getUint32(rec + 8);
    const data = bytes.subarray(offset, offset + compLength);
    const raw = compLength < dv.getUint32(rec + 12) ? new Uint8Array(z.inflateSync(data)) : data;
    tables.set(tagAt(dv, rec), view(raw));
  }
  return tables;
}

/** WOFF2's known-table index (spec §5.2), for directory entries without an explicit tag. */
const WOFF2_KNOWN_TAGS = (
  "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp " +
  "hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL " +
  "SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx " +
  "opbd prop trak Zapf Silf Glat Gloc Feat Sill"
).split(" ").map((t) => t.replace("_", " "));

/** A cursor over WOFF2's table directory. */
interface Cursor {
  dv: DataView;
  pos: number;
}

function uintBase128(c: Cursor): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = c.dv.getUint8(c.pos++);
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("bad UIntBase128");
}

/** One WOFF2 directory entry: its tag, its length in the decompressed stream, transformed? */
interface Woff2Entry {
  tag: string;
  length: number;
  transformed: boolean;
}

function woff2Entry(c: Cursor): Woff2Entry {
  const flags = c.dv.getUint8(c.pos++);
  let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
  if ((flags & 0x3f) === 63) {
    tag = tagAt(c.dv, c.pos);
    c.pos += 4;
  }
  const origLength = uintBase128(c);
  const version = flags >> 6;
  // glyf/loca: version 0 is the transform; every other table: version 0 is the null one.
  const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
  return { tag, length: transformed ? uintBase128(c) : origLength, transformed };
}

/** A transformed `hmtx` keeps the advance widths after one flags byte (spec §5.4). */
function untransformHmtx(table: DataView): DataView {
  return new DataView(table.buffer, table.byteOffset + 1, table.byteLength - 1);
}

/** The tables of a WOFF2 file (single-font only; `glyf`/`loca` left transformed, unread). */
function woff2Tables(bytes: Uint8Array, z: Zlib): Tables {
  const dv = view(bytes);
  if (tagAt(dv, 4) === "ttcf") throw new Error("WOFF2 collections are not supported");
  const cursor: Cursor = { dv, pos: 48 };
  const entries = Array.from({ length: dv.getUint16(12) }, () => woff2Entry(cursor));
  const compressed = bytes.subarray(cursor.pos, cursor.pos + dv.getUint32(20));
  const stream = new Uint8Array(z.brotliDecompressSync(compressed));
  const tables: Tables = new Map();
  let offset = 0;
  for (const e of entries) {
    const table = view(stream.subarray(offset, offset + e.length));
    tables.set(e.tag, e.tag === "hmtx" && e.transformed ? untransformHmtx(table) : table);
    offset += e.length;
  }
  return tables;
}

/** Split a font file into its tables by container signature. */
function fontTables(bytes: Uint8Array): Tables | null {
  const sig = tagAt(view(bytes), 0);
  if (sig === "wOFF" || sig === "wOF2") {
    const z = zlib();
    if (!z) return null;
    return sig === "wOFF" ? woffTables(bytes, z) : woff2Tables(bytes, z);
  }
  if (sig === "true" || sig === "OTTO" || sig === "\0\x01\0\0") return sfntTables(bytes);
  return null;
}

/** cmap format 4 (segmented BMP) lookup. */
function cmapFormat4(dv: DataView, cp: number): number {
  const segX2 = dv.getUint16(6);
  for (let s = 0; s < segX2; s += 2) {
    const end = dv.getUint16(14 + s);
    if (cp > end) continue;
    const startAt = 16 + segX2 + s;
    if (cp < dv.getUint16(startAt)) return 0;
    const delta = dv.getUint16(startAt + segX2);
    const rangeAt = startAt + 2 * segX2;
    const rangeOffset = dv.getUint16(rangeAt);
    if (rangeOffset === 0) return (cp + delta) & 0xffff;
    const glyph = dv.getUint16(rangeAt + rangeOffset + 2 * (cp - dv.getUint16(startAt)));
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  }
  return 0;
}

/** cmap format 12 (segmented coverage) lookup. */
function cmapFormat12(dv: DataView, cp: number): number {
  for (let g = 0, n = dv.getUint32(12); g < n; g++) {
    const at = 16 + g * 12;
    const start = dv.getUint32(at);
    if (cp >= start && cp <= dv.getUint32(at + 4)) return dv.getUint32(at + 8) + cp - start;
  }
  return 0;
}

/** The Unicode cmap subtable fontkit would use: a full-repertoire one first, then BMP. */
function unicodeCmap(cmap: DataView): DataView | null {
  const preference = ["3,10", "0,6", "0,4", "3,1", "0,3", "0,2", "0,1", "0,0"];
  let best: DataView | null = null;
  let bestRank = preference.length;
  for (let i = 0, n = cmap.getUint16(2); i < n; i++) {
    const rec = 4 + i * 8;
    const rank = preference.indexOf(`${cmap.getUint16(rec)},${cmap.getUint16(rec + 2)}`);
    const offset = cmap.getUint32(rec + 4);
    const format = cmap.getUint16(offset);
    if (rank >= 0 && rank < bestRank && (format === 4 || format === 12)) {
      bestRank = rank;
      best = new DataView(cmap.buffer, cmap.byteOffset + offset, cmap.byteLength - offset);
    }
  }
  return best;
}

function glyphFor(sub: DataView, cp: number): number {
  return sub.getUint16(0) === 12 ? cmapFormat12(sub, cp) : cmapFormat4(sub, cp);
}

/** Next's `calcAverageWidth`: the mean `hmtx` advance over the sample string. */
function averageWidth(tables: Tables): number | undefined {
  const cmap = tables.get("cmap");
  const hmtx = tables.get("hmtx");
  const hhea = tables.get("hhea");
  const sub = cmap && unicodeCmap(cmap);
  if (!sub || !hmtx || !hhea) return undefined;
  const longMetrics = hhea.getUint16(34);
  let total = 0;
  for (const ch of AVG_CHARACTERS) {
    const glyph = glyphFor(sub, ch.codePointAt(0)!);
    if (glyph === 0) return undefined;
    total += hmtx.getUint16(4 * Math.min(glyph, longMetrics - 1));
  }
  return total / AVG_CHARACTERS.length;
}

/**
 * Parse a font file's fallback metrics.
 *
 * @param bytes The font file (`.ttf`, `.otf`, `.woff` or `.woff2`).
 * @returns Its metrics, or `null` when the file can't be read (unknown format, a WOFF on a
 *   runtime without `node:zlib`, a WOFF2 collection, or a malformed file).
 */
export function fontFileMetrics(bytes: Uint8Array): FontFileMetrics | null {
  try {
    const tables = fontTables(bytes);
    const head = tables?.get("head");
    const hhea = tables?.get("hhea");
    if (!tables || !head || !hhea) return null;
    return {
      unitsPerEm: head.getUint16(18),
      ascent: hhea.getInt16(4),
      descent: hhea.getInt16(6),
      lineGap: hhea.getInt16(8),
      azAvgWidth: averageWidth(tables),
    };
  } catch {
    return null;
  }
}
