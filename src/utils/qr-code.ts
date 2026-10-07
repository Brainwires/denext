// A dependency-free QR code encoder (ISO/IEC 18004:2015, model 2). `denext dev --lan` prints the
// dev URL as one for the terminal, and `totpQrSvg` (denext/server) renders an authenticator's
// `otpauth://` provisioning URI as SVG.
//
// Scope: byte mode (§7.4.5) — UTF-8 text, no ECI header — at any error-correction level
// (L/M/Q/H, §6.5.1) in versions 1–40. The construction follows the standard step by step: the
// data bit stream (§7.4) with its terminator and pad codewords (§7.4.9–7.4.10), Reed–Solomon
// error correction over GF(2^8) split into the blocks Table 9 prescribes and interleaved
// (§7.5–7.6), the function patterns (finders, separators, timing, alignment, §6.3), the
// codeword placement (§7.7.3), data masking with the lowest-penalty mask (§7.8), and the format
// (§7.9.1) and version (§7.10) information.

/** A QR symbol: `modules[y][x]` is `true` for a dark module. */
export type QrMatrix = boolean[][];

/** An error-correction level (ISO/IEC 18004 §6.5.1): roughly 7, 15, 25 or 30 % recovery. */
export type QrEcc = "L" | "M" | "Q" | "H";

/** Options for {@linkcode encodeQr}. */
export interface QrEncodeOptions {
  /** The error-correction level. Default `"M"`. */
  ecc?: QrEcc;
  /** Force a version (1–40); default: the smallest that fits. */
  version?: number;
  /** Force a data mask (0–7); default: the one with the lowest penalty (§7.8.3). */
  mask?: number;
}

/**
 * ISO/IEC 18004 Table 9: error-correction codewords per block, indexed `[level][version - 1]`.
 * Every version uses one block length per level (the blocks differ only in data length).
 */
// deno-fmt-ignore
const ECC_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** ISO/IEC 18004 Table 9: the number of error-correction blocks, indexed `[level][version - 1]`. */
// deno-fmt-ignore
const BLOCKS: Record<QrEcc, readonly number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** The two error-correction-level bits of the format information (§7.9.1, Table 12). */
const LEVEL_BITS: Record<QrEcc, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/** The version range of a model 2 symbol. */
const MIN_VERSION = 1;
const MAX_VERSION = 40;

// --- GF(256) Reed–Solomon (§7.5.2) -------------------------------------------

/** Multiply two field elements modulo the QR polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/**
 * The Reed–Solomon generator polynomial of `degree`, (x − α^0)(x − α^1)…(x − α^(degree−1)) with
 * α = 2 (§7.5.2, Annex A), as its coefficients from the highest power down, leading 1 omitted.
 */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error-correction codewords for `data`: the remainder of data·x^n divided by `divisor`. */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => result[i] ^= gfMultiply(coef, factor));
  }
  return result;
}

// --- capacity + codewords (§7.4, Tables 1, 3, 7, 9) ----------------------------

/** The modules available for data + EC codewords: everything but the function patterns. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** How many data codewords a version holds at `ecc` (Table 7). */
function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) -
    ECC_PER_BLOCK[ecc][version - 1] * BLOCKS[ecc][version - 1];
}

/** Byte mode's character-count indicator length (Table 3): 8 bits below version 10, else 16. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** Whether `byteLength` bytes fit `version` at `ecc` in one byte-mode segment. */
function fits(byteLength: number, version: number, ecc: QrEcc): boolean {
  return byteLength < 2 ** countBits(version) &&
    4 + countBits(version) + byteLength * 8 <= dataCodewords(version, ecc) * 8;
}

/** The forced version when it fits, else the smallest version that does. */
function pickVersion(byteLength: number, ecc: QrEcc, forced: number | undefined): number {
  if (forced !== undefined) {
    if (!Number.isInteger(forced) || forced < MIN_VERSION || forced > MAX_VERSION) {
      throw new RangeError(`qr: version must be an integer 1–40 (got ${forced})`);
    }
    if (!fits(byteLength, forced, ecc)) {
      throw new RangeError(`qr: ${byteLength} bytes do not fit version ${forced}-${ecc}`);
    }
    return forced;
  }
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) if (fits(byteLength, v, ecc)) return v;
  throw new RangeError(`qr: ${byteLength} bytes is too long for a QR code at level ${ecc}`);
}

/** Append `length` low bits of `value` to `bits`, most significant first. */
function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/**
 * The data codewords: the byte-mode indicator `0100` and character count (§7.4.5), the bytes,
 * up to four terminator zeros (§7.4.9), zero bits to the codeword boundary, then the pad
 * codewords 0xEC / 0x11 alternately (§7.4.10).
 */
function dataCodewordsFor(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const capacity = dataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, countBits(version));
  for (const b of bytes) pushBits(bits, b, 8);
  pushBits(bits, 0, Math.min(4, capacity - bits.length));
  pushBits(bits, 0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) pushBits(bits, pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  return out;
}

/**
 * Split the data into Table 9's blocks (the short ones first), append each block's EC
 * codewords, and interleave codeword by codeword (§7.6): data columns, then EC columns.
 */
function interleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = BLOCKS[ecc][version - 1];
  const eccLen = ECC_PER_BLOCK[ecc][version - 1];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = numBlocks - raw % numBlocks;
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecCodewords = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0); // a placeholder column, skipped below
    blocks.push(dat.concat(ecCodewords));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]);
    });
  }
  return out;
}

// --- the symbol (§6.3, §7.7) ---------------------------------------------------

/** A symbol under construction: its modules and which of them are function patterns. */
interface Grid {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  const blank = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, modules: blank(), reserved: blank() };
}

/** Set a function-pattern module (and reserve it from data placement). */
function setFunction(grid: Grid, x: number, y: number, dark: boolean): void {
  grid.modules[y][x] = dark;
  grid.reserved[y][x] = true;
}

/** A finder pattern (§6.3.3) plus its separator (§6.3.4), centred on (x, y); clipped. */
function drawFinder(grid: Grid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= grid.size || yy < 0 || yy >= grid.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(grid, xx, yy, dist !== 2 && dist !== 4);
    }
  }
}

/** A 5×5 alignment pattern (§6.3.6) centred on (x, y). */
function drawAlignment(grid: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/**
 * The alignment-pattern centre coordinates for a version (Annex E, Table E.1): row/column 6,
 * then evenly spaced (by an even step) up to `size - 7`. The step formula reproduces Table E.1
 * for every version, version 32's irregular 26 included.
 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** The 15 format bits: level + mask, BCH(15,5) with generator 0x537, XOR 0x5412 (§7.9.1). */
function formatBits(ecc: QrEcc, mask: number): number {
  const data = (LEVEL_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Both copies of the format information (§7.9.1, Figure 25) and the dark module at
 * (8, size − 8). Without `bits` the areas are reserved light — what the mask evaluation sees.
 */
function drawFormat(grid: Grid, bits: number | undefined): void {
  const bit = (i: number) => bits !== undefined && ((bits >>> i) & 1) === 1;
  const { size } = grid;
  for (let i = 0; i <= 5; i++) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
  setFunction(grid, 8, size - 8, bits !== undefined);
}

/**
 * The two 18-bit version-information blocks (§7.10, versions 7 and up): the version, BCH(18,6)
 * with generator 0x1F25. Without `fill` they are reserved light.
 */
function drawVersion(grid: Grid, version: number, fill: boolean): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = fill && ((bits >>> i) & 1) === 1;
    const a = grid.size - 11 + i % 3, b = Math.floor(i / 3);
    setFunction(grid, a, b, dark);
    setFunction(grid, b, a, dark);
  }
}

/** Every function pattern: timing, finders, alignment, and the (light) format/version areas. */
function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((ay, i) =>
    align.forEach((ax, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!corner) drawAlignment(grid, ax, ay);
    })
  );
  drawFormat(grid, undefined);
  drawVersion(grid, version, false);
}

/** Every module position in placement order (§7.7.3): two-column strips zigzagging up and down. */
function* zigzag(size: number): Generator<[number, number]> {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      yield [right, y];
      yield [right - 1, y];
    }
  }
}

/** Place the codewords along the zigzag, skipping function modules; remainder bits stay 0. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const total = codewords.length * 8;
  let i = 0;
  for (const [x, y] of zigzag(grid.size)) {
    if (i >= total) return;
    if (grid.reserved[y][x]) continue;
    grid.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
    i++;
  }
}

/** The eight data masks (§7.8.2, Table 10; i = row = y, j = column = x), as predicates. */
const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/** XOR mask `m` onto every data module (applying it twice undoes it). */
function applyMask(grid: Grid, m: number): void {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.reserved[y][x] && MASKS[m](x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

// --- mask evaluation (§7.8.3.1, Table 11) ----------------------------------------

/** N1 (3) + (run − 5) for every run of ≥ 5 same-colour modules in one row or column. */
function runPenalty(line: readonly boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) score += run - 2;
    run = 1;
  }
  return score;
}

/** Whether `line[from, to)` is all light, modules beyond the symbol counting as light. */
function lightSpan(line: readonly boolean[], from: number, to: number): boolean {
  for (let i = Math.max(from, 0); i < Math.min(to, line.length); i++) if (line[i]) return false;
  return true;
}

/** The 1:1:3:1:1 (dark:light:dark:light:dark) finder-like pattern. */
const FINDER_LIKE = [true, false, true, true, true, false, true];

/** Whether the finder-like pattern starts at `at`. */
function finderLikeAt(line: readonly boolean[], at: number): boolean {
  return FINDER_LIKE.every((dark, k) => line[at + k] === dark);
}

/**
 * N3 (40) for every 1:1:3:1:1 pattern preceded or followed by a light area 4 modules wide —
 * the quiet zone beyond the symbol's edge counting as light. A counted pattern resumes the
 * scan after itself; an uncounted one at its middle dark run (where the next could start).
 */
function finderPenalty(line: readonly boolean[]): number {
  let score = 0;
  for (let at = 0; at + FINDER_LIKE.length <= line.length;) {
    if (!finderLikeAt(line, at)) {
      at++;
      continue;
    }
    const counted = lightSpan(line, at - 4, at) || lightSpan(line, at + 7, at + 11);
    if (counted) score += 40;
    at += counted ? 7 : 4;
  }
  return score;
}

/**
 * The symbol's penalty under Table 11 — N1 runs, N2 (3) per 2×2 same-colour block, N3
 * finder-like patterns, and N4 (10 per 5 % the dark proportion strays from 50 %) — evaluated,
 * as §7.8 orders the steps, before the format and version information is placed.
 */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    const column = modules.map((row) => row[y]);
    score += runPenalty(modules[y]) + runPenalty(column);
    score += finderPenalty(modules[y]) + finderPenalty(column);
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x === size - 1 || y === size - 1) continue;
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }
  const total = size * size;
  // k = ⌊|dark% − 50| / 5⌋, in integers: |20·dark − 10·total| / total.
  return score + Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
}

/** Try every mask and keep the first with the lowest penalty (§7.8.3: lowest score wins). */
function chooseMask(grid: Grid): number {
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < MASKS.length; m++) {
    applyMask(grid, m);
    const score = penalty(grid);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
    applyMask(grid, m);
  }
  return best;
}

// --- public API -------------------------------------------------------------

/**
 * Encode `text` (UTF-8, one byte-mode segment) as a QR symbol.
 *
 * @param text What the code carries — a URL, typically.
 * @param options The error-correction level (default `"M"`), and optionally a fixed version or mask.
 * @returns The module matrix, `modules[y][x]` dark when `true`, without a quiet zone.
 * @throws {RangeError} When the text doesn't fit (2331 bytes at most at level M, 2953 at L), or
 * a forced version / mask is out of range or too small.
 */
export function encodeQr(text: string, options: QrEncodeOptions = {}): QrMatrix {
  const ecc = options.ecc ?? "M";
  if (!(ecc in LEVEL_BITS)) throw new RangeError(`qr: unknown error-correction level ${ecc}`);
  const forcedMask = options.mask;
  if (
    forcedMask !== undefined &&
    !(Number.isInteger(forcedMask) && forcedMask >= 0 && forcedMask <= 7)
  ) {
    throw new RangeError(`qr: mask must be an integer 0–7 (got ${forcedMask})`);
  }
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length, ecc, options.version);
  const grid = newGrid(version);
  drawFunctionPatterns(grid, version);
  drawCodewords(grid, interleave(dataCodewordsFor(bytes, version, ecc), version, ecc));
  const mask = forcedMask ?? chooseMask(grid);
  applyMask(grid, mask);
  drawFormat(grid, formatBits(ecc, mask));
  drawVersion(grid, version, true);
  return grid.modules;
}

/** Options for {@linkcode renderQrSvg}. */
export interface QrSvgOptions {
  /** Light modules around the symbol. Default 4 — the quiet zone §6.3.8 requires. */
  margin?: number;
  /** The rendered width and height in CSS pixels; default: none (the SVG scales to its box). */
  size?: number;
  /** The dark-module colour. Default `"#000"`. */
  color?: string;
  /** The light-module colour (and the quiet zone). Default `"#fff"`. */
  background?: string;
  /** An accessible name (`<title>`), XML-escaped. Default: none. */
  title?: string;
}

/** A hex colour or a CSS colour keyword — nothing that can break out of an attribute. */
const SAFE_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32})$/;

/** Escape text for an XML text node or attribute. */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A colour option, validated. */
function svgColor(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (!SAFE_COLOR.test(value)) {
    throw new TypeError(`qr: ${name} must be a hex colour or a colour keyword (got ${value})`);
  }
  return value;
}

/**
 * Render a QR matrix as a standalone SVG document: one `<path>` of dark modules (each row's
 * runs merged) on a light background, with `shape-rendering="crispEdges"` so the modules stay
 * sharp at any size. No scripts, no external references — safe to inline.
 *
 * @param modules The symbol from {@linkcode encodeQr}.
 * @param options Quiet zone, size, colours and accessible title.
 * @returns The SVG markup.
 * @throws {RangeError} When `margin` or `size` is not a non-negative integer / positive number.
 * @throws {TypeError} When a colour is not a hex colour or a keyword.
 */
export function renderQrSvg(modules: QrMatrix, options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 4;
  if (!Number.isInteger(margin) || margin < 0 || margin > 64) {
    throw new RangeError(`qr: margin must be an integer 0–64 (got ${margin})`);
  }
  const size = options.size;
  if (size !== undefined && !(Number.isFinite(size) && size > 0)) {
    throw new RangeError(`qr: size must be a positive number (got ${size})`);
  }
  const color = svgColor(options.color, "#000", "color");
  const background = svgColor(options.background, "#fff", "background");
  const extent = modules.length + margin * 2;
  let path = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      const start = x;
      while (x + 1 < row.length && row[x + 1]) x++;
      path += `M${start + margin} ${y + margin}h${x - start + 1}v1h${start - x - 1}z`;
    }
  });
  const dims = size === undefined ? "" : ` width="${size}" height="${size}"`;
  const title = options.title === undefined ? "" : `<title>${escapeXml(options.title)}</title>`;
  const role = options.title === undefined ? "" : ' role="img"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}"${dims}${role}` +
    ` shape-rendering="crispEdges">${title}<rect width="${extent}" height="${extent}"` +
    ` fill="${background}"/><path fill="${color}" d="${path}"/></svg>`;
}

/**
 * Render a QR matrix for a terminal, two module rows per text line with half-block
 * characters, inside a quiet zone.
 *
 * The code is drawn light-on-dark: a dark module is a space (the terminal background) and a
 * light one is a block (the text colour), which is what a dark-themed terminal needs; phone
 * cameras (iOS Camera, Google Lens) read the inverted form either way.
 *
 * @param modules The symbol from {@linkcode encodeQr}.
 * @param quiet Light modules around the symbol (default 2; the standard asks for 4).
 * @returns The lines, joined with `\n`.
 */
export function renderQrTerminal(modules: QrMatrix, quiet = 2): string {
  const size = modules.length;
  const light = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= size || y >= size || !modules[y][x];
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < size + quiet; x++) line += halfBlock(light(x, y), light(x, y + 1));
    lines.push(line);
  }
  return lines.join("\n");
}

/** One text cell for two stacked modules, `true` meaning light (drawn in the text colour). */
function halfBlock(top: boolean, bottom: boolean): string {
  if (top) return bottom ? "█" : "▀";
  return bottom ? "▄" : " ";
}
