// A dependency-free QR code encoder for the terminal (`denext dev --lan` prints the dev URL as
// one so a phone can open it by pointing its camera at the screen).
//
// Scope is deliberately small: byte mode, error-correction level M, versions 1–10 (up to 213
// bytes, far more than any URL this prints). The construction follows ISO/IEC 18004: data
// codewords, Reed–Solomon error correction over GF(256) split into blocks and interleaved, the
// function patterns (finders, separators, timing, alignment, format and version information),
// the zigzag data placement, and the mask with the lowest penalty score.

/** A QR symbol: `modules[y][x]` is `true` for a dark module. */
export type QrMatrix = boolean[][];

/** EC level M: error-correction codewords per block, indexed by version (1–10). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** EC level M: number of error-correction blocks, indexed by version (1–10). */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** The highest version this encoder builds. */
const MAX_VERSION = 10;
/** The format-information bits for EC level M (ISO/IEC 18004 table 12: M = 00). */
const LEVEL_M_BITS = 0;

// --- GF(256) Reed–Solomon ---------------------------------------------------

/** Multiply two field elements modulo the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed–Solomon generator polynomial of `degree` (leading 1 omitted). */
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

/** The error-correction codewords for `data` under `divisor`. */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => result[i] ^= gfMultiply(coef, factor));
  }
  return result;
}

// --- capacity + codewords ---------------------------------------------------

/** The modules available for data + EC codewords (everything but function patterns). */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** How many data codewords a version holds at level M. */
function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

/** The smallest version whose capacity fits `byteLength` bytes in byte mode. */
function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewords(v) * 8) return v;
  }
  throw new RangeError(`qr: ${byteLength} bytes is too long (at most version ${MAX_VERSION})`);
}

/** Append `length` low bits of `value` to `bits`, most significant first. */
function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** The data codewords: mode, count, bytes, terminator, then the 0xEC/0x11 padding. */
function dataCodewordsFor(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version < 10 ? 8 : 16);
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

/** Split the data into blocks, append each block's EC codewords, and interleave. */
function interleave(data: readonly number[], version: number): number[] {
  const numBlocks = BLOCKS[version];
  const eccLen = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = numBlocks - raw % numBlocks;
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0); // placeholder, skipped below
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]);
    });
  }
  return out;
}

// --- the symbol -------------------------------------------------------------

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

/** A finder pattern plus its separator, centred on (x, y); clipped at the edges. */
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

/** A 5×5 alignment pattern centred on (x, y). */
function drawAlignment(grid: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** The alignment-pattern centre coordinates for a version. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Both copies of the 15-bit format information for `mask`, plus the dark module. */
function drawFormat(grid: Grid, mask: number): void {
  const data = (LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = grid;
  for (let i = 0; i <= 5; i++) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
  setFunction(grid, 8, size - 8, true);
}

/** The two 18-bit version-information blocks (versions 7 and up). */
function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = grid.size - 11 + i % 3, b = Math.floor(i / 3);
    setFunction(grid, a, b, dark);
    setFunction(grid, b, a, dark);
  }
}

/** Every function pattern: timing, finders, alignment, and placeholder format/version bits. */
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
  drawFormat(grid, 0); // reserved now, rewritten once the mask is chosen
  drawVersion(grid, version);
}

/** Every module position in data-placement order: two-column strips, zigzagging up and down. */
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

/** Place the codewords along the zigzag, skipping reserved modules. */
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

/** The eight data masks (ISO/IEC 18004 table 10), as "invert this module" predicates. */
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

// --- mask penalty (ISO/IEC 18004 §7.8.3) -------------------------------------

/** Rules 1 and 3 over one line: runs of 5+ same-colour modules, and finder-like 1:1:3:1:1. */
function linePenalty(line: readonly boolean[]): number {
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
  const text = line.map((d) => (d ? "1" : "0")).join("");
  for (const pattern of ["10111010000", "00001011101"]) {
    for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
  }
  return score;
}

/** The total penalty of the current modules (lower scans more reliably). */
function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    score += linePenalty(modules[y]);
    score += linePenalty(modules.map((row) => row[y]));
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
  return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/** Try every mask and keep the one with the lowest penalty. */
function chooseMask(grid: Grid): number {
  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < MASKS.length; m++) {
    applyMask(grid, m);
    drawFormat(grid, m);
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
 * Encode `text` (UTF-8, byte mode, error-correction level M) as a QR symbol.
 *
 * @param text What the code carries — a URL, typically.
 * @returns The module matrix, `modules[y][x]` dark when `true`, without a quiet zone.
 * @throws {RangeError} When the text needs more than version 10 (213 bytes).
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const grid = newGrid(version);
  drawFunctionPatterns(grid, version);
  drawCodewords(grid, interleave(dataCodewordsFor(bytes, version), version));
  const mask = chooseMask(grid);
  applyMask(grid, mask);
  drawFormat(grid, mask);
  return grid.modules;
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
