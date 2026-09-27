/**
 * BlurHash and ThumbHash for `denext/expo/image`: decode a hash into a small RGBA image (and
 * that into a PNG data URL, without a canvas), and encode RGBA pixels into either hash.
 * Internal: not a `denext/expo/*` entrypoint. Nothing here runs at import time.
 *
 * The algorithms are BlurHash's (https://github.com/woltapp/blurhash, MIT, Copyright (c)
 * 2018 Wolt Enterprises) and ThumbHash's (https://github.com/evanw/thumbhash, MIT, Copyright
 * (c) 2023 Evan Wallace), the same ones `expo-image` decodes on the web.
 *
 * @module
 */

/** A decoded image: its size and its RGBA pixels, row by row. */
export interface RgbaImage {
  /** The width in pixels. */
  w: number;
  /** The height in pixels. */
  h: number;
  /** The pixels (`w * h * 4` bytes). */
  rgba: Uint8Array;
}

// ---- BlurHash ------------------------------------------------------------------------------

/** BlurHash's base-83 digits. */
const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

/** A base-83 string as a number (NaN on a foreign character). */
function decode83(text: string): number {
  let value = 0;
  for (const char of text) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0) return NaN;
    value = value * 83 + digit;
  }
  return value;
}

/** `value` as `length` base-83 digits. */
function encode83(value: number, length: number): string {
  let out = "";
  for (let i = 1; i <= length; i++) {
    out += DIGITS[Math.floor(value / Math.pow(83, length - i)) % 83];
  }
  return out;
}

/** An sRGB byte as a linear intensity (0–1). */
function toLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** A linear intensity as an sRGB byte. */
function toSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

/** `|value|^exp` with `value`'s sign. */
function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

/**
 * Whether `hash` is a well-formed BlurHash.
 *
 * @param hash The hash.
 */
export function isBlurhashValid(hash: string): boolean {
  if (typeof hash !== "string" || hash.length < 6) return false;
  const size = decode83(hash[0]);
  if (Number.isNaN(size)) return false;
  const count = (Math.floor(size / 9) + 1) * ((size % 9) + 1);
  return hash.length === 4 + 2 * count && !Number.isNaN(decode83(hash));
}

/**
 * Decode a BlurHash into a `w`×`h` RGBA image.
 *
 * @param hash The hash.
 * @param w The width to render (keep it small: 16–32).
 * @param h The height to render.
 * @param punch Contrast (default 1).
 * @returns The image, or null for a malformed hash.
 */
export function blurhashToRgba(hash: string, w: number, h: number, punch = 1): RgbaImage | null {
  if (!isBlurhashValid(hash)) return null;
  const size = decode83(hash[0]);
  const ny = Math.floor(size / 9) + 1;
  const nx = (size % 9) + 1;
  const maximum = ((decode83(hash[1]) + 1) / 166) * punch;
  const colors: number[][] = [];
  const dc = decode83(hash.slice(2, 6));
  colors.push([toLinear(dc >> 16), toLinear((dc >> 8) & 255), toLinear(dc & 255)]);
  for (let i = 1; i < nx * ny; i++) {
    const value = decode83(hash.slice(4 + i * 2, 6 + i * 2));
    colors.push([
      signPow((Math.floor(value / 361) - 9) / 9, 2) * maximum,
      signPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * maximum,
      signPow(((value % 19) - 9) / 9, 2) * maximum,
    ]);
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const basis = Math.cos((Math.PI * x * i) / w) * Math.cos((Math.PI * y * j) / h);
          const color = colors[i + j * nx];
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const at = 4 * (x + y * w);
      rgba[at] = toSrgb(r);
      rgba[at + 1] = toSrgb(g);
      rgba[at + 2] = toSrgb(b);
      rgba[at + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/** One BlurHash factor: the image's linear RGB weighted by the (i, j) cosine basis. */
function blurhashFactor(image: RgbaImage, i: number, j: number): number[] {
  const { w, h, rgba } = image;
  const norm = i === 0 && j === 0 ? 1 : 2;
  const sum = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const fy = Math.cos((Math.PI * j * y) / h);
    for (let x = 0; x < w; x++) {
      const basis = norm * Math.cos((Math.PI * i * x) / w) * fy;
      const at = 4 * (x + y * w);
      for (let c = 0; c < 3; c++) sum[c] += basis * toLinear(rgba[at + c]);
    }
  }
  return sum.map((v) => v / (w * h));
}

/** A BlurHash AC factor quantised against `maximum` (0–18 per channel, packed base 19). */
function quantiseAc(factor: number[], maximum: number): number {
  const q = (v: number) =>
    Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(v / maximum, 0.5) * 9 + 9.5))));
  return q(factor[0]) * 361 + q(factor[1]) * 19 + q(factor[2]);
}

/**
 * Encode RGBA pixels as a BlurHash of `cx`×`cy` components.
 *
 * @param image The pixels.
 * @param cx Horizontal components (1–9).
 * @param cy Vertical components (1–9).
 * @returns The hash.
 */
export function rgbaToBlurhash(image: RgbaImage, cx: number, cy: number): string {
  if (cx < 1 || cx > 9 || cy < 1 || cy > 9) throw new Error("BlurHash components must be 1–9");
  const factors: number[][] = [];
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) factors.push(blurhashFactor(image, i, j));
  }
  const [dc, ...ac] = factors;
  let hash = encode83(cx - 1 + (cy - 1) * 9, 1);
  let maximum = 1;
  if (ac.length > 0) {
    const actual = Math.max(...ac.flatMap((f) => f.map(Math.abs)));
    const quantised = Math.floor(Math.max(0, Math.min(82, Math.floor(actual * 166 - 0.5))));
    maximum = (quantised + 1) / 166;
    hash += encode83(quantised, 1);
  } else hash += encode83(0, 1);
  hash += encode83((toSrgb(dc[0]) << 16) + (toSrgb(dc[1]) << 8) + toSrgb(dc[2]), 4);
  for (const factor of ac) hash += encode83(quantiseAc(factor, maximum), 2);
  return hash;
}

// ---- ThumbHash -----------------------------------------------------------------------------

/** What a ThumbHash's header says. */
interface ThumbHeader {
  lDc: number;
  pDc: number;
  qDc: number;
  aDc: number;
  lScale: number;
  pScale: number;
  qScale: number;
  aScale: number;
  hasAlpha: boolean;
  lx: number;
  ly: number;
}

/** Read a ThumbHash's header. */
function thumbHeader(hash: Uint8Array): ThumbHeader {
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const hasAlpha = (header24 >> 23) === 1;
  const landscape = (header16 >> 15) === 1;
  const long = hasAlpha ? 5 : 7;
  return {
    lDc: (header24 & 63) / 63,
    pDc: ((header24 >> 6) & 63) / 31.5 - 1,
    qDc: ((header24 >> 12) & 63) / 31.5 - 1,
    lScale: ((header24 >> 18) & 31) / 31,
    pScale: ((header16 >> 3) & 63) / 63,
    qScale: ((header16 >> 9) & 63) / 63,
    aDc: hasAlpha ? (hash[5] & 15) / 15 : 1,
    aScale: (hash[5] >> 4) / 15,
    hasAlpha,
    lx: Math.max(3, landscape ? long : header16 & 7),
    ly: Math.max(3, landscape ? header16 & 7 : long),
  };
}

/** A ThumbHash's width / height ratio, from its header. */
function thumbhashRatio(hash: Uint8Array): number {
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const landscape = hash[4] & 0x80;
  const lx = landscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = landscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

/** The (cx, cy) index pairs of one channel's AC terms, in hash order. */
function acTerms(nx: number, ny: number): Array<[number, number]> {
  const terms: Array<[number, number]> = [];
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) terms.push([cx, cy]);
  }
  return terms;
}

/** Read the AC terms of the channels, nibble by nibble, from `start`. */
function readAc(
  hash: Uint8Array,
  start: number,
  channels: Array<[number, number, number]>,
): number[][] {
  let index = 0;
  return channels.map(([nx, ny, scale]) =>
    acTerms(nx, ny).map(() => {
      const byte = hash[start + (index >> 1)] ?? 0;
      return (((byte >> ((index++ & 1) << 2)) & 15) / 7.5 - 1) * scale;
    })
  );
}

/** A channel's value at a pixel: its DC plus each AC term times the pixel's cosines. */
function channelAt(
  dc: number,
  ac: number[],
  terms: Array<[number, number]>,
  fx: number[],
  fy: number[],
): number {
  let value = dc;
  for (let k = 0; k < terms.length; k++) value += ac[k] * fx[terms[k][0]] * fy[terms[k][1]] * 2;
  return value;
}

/** The cosines `cos(π / size · (at + 0.5) · c)` for c < n. */
function cosines(size: number, at: number, n: number): number[] {
  return Array.from({ length: n }, (_, c) => Math.cos((Math.PI / size) * (at + 0.5) * c));
}

/**
 * Decode a ThumbHash into an RGBA image of at most 32×32.
 *
 * @param hash The hash bytes.
 * @returns The image, or null for a hash too short to read.
 */
export function thumbhashToRgba(hash: Uint8Array): RgbaImage | null {
  if (hash.length < 5) return null;
  const head = thumbHeader(hash);
  const channels: Array<[number, number, number]> = [
    [head.lx, head.ly, head.lScale],
    [3, 3, head.pScale * 1.25],
    [3, 3, head.qScale * 1.25],
  ];
  if (head.hasAlpha) channels.push([5, 5, head.aScale]);
  const [lAc, pAc, qAc, aAc] = readAc(hash, head.hasAlpha ? 6 : 5, channels);
  const lTerms = acTerms(head.lx, head.ly);
  const pqTerms = acTerms(3, 3);
  const aTerms = acTerms(5, 5);
  const ratio = thumbhashRatio(hash);
  const w = Math.round(ratio > 1 ? 32 : 32 * ratio);
  const h = Math.round(ratio > 1 ? 32 / ratio : 32);
  const n = Math.max(head.lx, head.ly, head.hasAlpha ? 5 : 3);
  const rgba = new Uint8Array(w * h * 4);
  const byte = (v: number) => Math.max(0, 255 * Math.min(1, v));
  for (let y = 0, i = 0; y < h; y++) {
    const fy = cosines(h, y, n);
    for (let x = 0; x < w; x++, i += 4) {
      const fx = cosines(w, x, n);
      const l = channelAt(head.lDc, lAc, lTerms, fx, fy);
      const p = channelAt(head.pDc, pAc, pqTerms, fx, fy);
      const q = channelAt(head.qDc, qAc, pqTerms, fx, fy);
      const a = aAc ? channelAt(head.aDc, aAc, aTerms, fx, fy) : head.aDc;
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      rgba.set([byte(r), byte(r - q), byte(b), byte(a)], i);
    }
  }
  return { w, h, rgba };
}

/** One DCT coefficient of a channel. */
function dctCoefficient(values: number[], w: number, h: number, cx: number, cy: number): number {
  let f = 0;
  for (let y = 0; y < h; y++) {
    const fy = Math.cos((Math.PI / h) * cy * (y + 0.5));
    for (let x = 0; x < w; x++) {
      f += values[x + y * w] * Math.cos((Math.PI / w) * cx * (x + 0.5)) * fy;
    }
  }
  return f / (w * h);
}

/** One channel's DCT: its constant term, its normalized varying terms and their scale. */
function encodeChannel(
  values: number[],
  w: number,
  h: number,
  nx: number,
  ny: number,
): [number, number[], number] {
  const dc = dctCoefficient(values, w, h, 0, 0);
  const ac = acTerms(nx, ny).map(([cx, cy]) => dctCoefficient(values, w, h, cx, cy));
  const scale = Math.max(0, ...ac.map(Math.abs));
  return [dc, scale ? ac.map((f) => 0.5 + (0.5 / scale) * f) : ac, scale];
}

/** The alpha-weighted average color and the total alpha of an image. */
function averageColor(image: RgbaImage): { r: number; g: number; b: number; a: number } {
  const { w, h, rgba } = image;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < w * h * 4; j += 4) {
    const alpha = rgba[j + 3] / 255;
    r += (alpha / 255) * rgba[j];
    g += (alpha / 255) * rgba[j + 1];
    b += (alpha / 255) * rgba[j + 2];
    a += alpha;
  }
  return a ? { r: r / a, g: g / a, b: b / a, a } : { r, g, b, a };
}

/** The image as luminance, yellow-blue, red-green and alpha channels over its average. */
function toLpqa(image: RgbaImage): { l: number[]; p: number[]; q: number[]; a: number[] } {
  const avg = averageColor(image);
  const out = { l: [] as number[], p: [] as number[], q: [] as number[], a: [] as number[] };
  const { rgba } = image;
  for (let i = 0, j = 0; j < rgba.length; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avg.r * (1 - alpha) + (alpha / 255) * rgba[j];
    const g = avg.g * (1 - alpha) + (alpha / 255) * rgba[j + 1];
    const b = avg.b * (1 - alpha) + (alpha / 255) * rgba[j + 2];
    out.l[i] = (r + g + b) / 3;
    out.p[i] = (r + g) / 2 - b;
    out.q[i] = r - g;
    out.a[i] = alpha;
  }
  return out;
}

/**
 * Encode RGBA pixels (at most 100×100) as a ThumbHash.
 *
 * @param image The pixels (RGB not premultiplied by A).
 * @returns The hash bytes.
 */
export function rgbaToThumbhash(image: RgbaImage): Uint8Array {
  const { w, h } = image;
  if (w > 100 || h > 100) throw new Error(`${w}x${h} doesn't fit in 100x100`);
  const { round, max } = Math;
  const hasAlpha = averageColor(image).a < w * h;
  const limit = hasAlpha ? 5 : 7;
  const lx = max(1, round((limit * w) / max(w, h)));
  const ly = max(1, round((limit * h) / max(w, h)));
  const { l, p, q, a } = toLpqa(image);
  const [lDc, lAc, lScale] = encodeChannel(l, w, h, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, w, h, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, w, h, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, w, h, 5, 5) : [0, [], 0];
  const landscape = w > h;
  const header24 = round(63 * lDc) | (round(31.5 + 31.5 * pDc) << 6) |
    (round(31.5 + 31.5 * qDc) << 12) | (round(31 * lScale) << 18) | (Number(hasAlpha) << 23);
  const header16 = (landscape ? ly : lx) | (round(63 * pScale) << 3) |
    (round(63 * qScale) << 9) | (Number(landscape) << 15);
  const hash = [
    header24 & 255,
    (header24 >> 8) & 255,
    header24 >> 16,
    header16 & 255,
    header16 >> 8,
  ];
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));
  const start = hash.length;
  const terms = (hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]).flat();
  terms.forEach((f, index) => {
    const at = start + (index >> 1);
    hash[at] = (hash[at] ?? 0) | (round(15 * f) << ((index & 1) << 2));
  });
  return new Uint8Array(hash);
}

// ---- PNG -----------------------------------------------------------------------------------

/** The CRC-32 table's 16 nibble entries. */
const CRC_NIBBLES = [
  0,
  498536548,
  997073096,
  651767980,
  1994146192,
  1802195444,
  1303535960,
  1342533948,
  -306674912,
  -267414716,
  -690576408,
  -882789492,
  -1687895376,
  -2032938284,
  -1609899400,
  -1111625188,
];

/**
 * An RGBA image as an uncompressed PNG `data:` URL (stored deflate blocks, no canvas).
 *
 * @param image The image (small: a placeholder).
 * @returns The data URL.
 */
export function rgbaToDataUrl(image: RgbaImage): string {
  const { w, h, rgba } = image;
  const row = w * 4 + 1;
  const idat = 6 + h * (5 + row);
  const bytes: number[] = [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10, // signature
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    w >> 8,
    w & 255,
    0,
    0,
    h >> 8,
    h & 255,
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // IHDR CRC, filled below
    idat >>> 24,
    (idat >> 16) & 255,
    (idat >> 8) & 255,
    idat & 255,
    73,
    68,
    65,
    84,
    120,
    1,
  ];
  let a = 1, b = 0;
  for (let y = 0, i = 0, end = row - 1; y < h; y++, end += row - 1) {
    bytes.push(y + 1 < h ? 0 : 1, row & 255, row >> 8, ~row & 255, (row >> 8) ^ 255, 0);
    for (b = (b + a) % 65521; i < end; i++) {
      const u = rgba[i] & 255;
      bytes.push(u);
      a = (a + u) % 65521;
      b = (b + a) % 65521;
    }
  }
  bytes.push(
    b >> 8,
    b & 255,
    a >> 8,
    a & 255,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    73,
    69,
    78,
    68,
    174,
    66,
    96,
    130,
  );
  for (let [start, end] of [[12, 29], [37, 41 + idat]]) {
    let c = ~0;
    for (let i = start; i < end; i++) {
      c ^= bytes[i];
      c = (c >>> 4) ^ CRC_NIBBLES[c & 15];
      c = (c >>> 4) ^ CRC_NIBBLES[c & 15];
    }
    c = ~c;
    bytes[end++] = c >>> 24;
    bytes[end++] = (c >> 16) & 255;
    bytes[end++] = (c >> 8) & 255;
    bytes[end++] = c & 255;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

/** Base64 (standard or URL-safe, padding optional) as bytes, or null when malformed. */
function base64Bytes(text: string): Uint8Array | null {
  try {
    const normal = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(
      atob(normal + "=".repeat((4 - normal.length % 4) % 4)),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

/** Bytes as standard base64. */
export function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The placeholder data URL of a `blurhash:/<hash>[/<w>/<h>]` or `thumbhash:/<hash>` source (the
 * forms `expo-image` accepts as a placeholder string), or of a bare hash with `kind`.
 *
 * @param value The hash string.
 * @param kind How to read a bare hash (default: by its scheme; a bare string is a BlurHash).
 * @returns The data URL, or null for a malformed hash.
 */
export function hashPlaceholderUrl(value: string, kind?: "blurhash" | "thumbhash"): string | null {
  if (kind === "thumbhash" || value.startsWith("thumbhash:/")) {
    const bytes = base64Bytes(value.replace(/^thumbhash:\//, ""));
    const image = bytes && thumbhashToRgba(bytes);
    return image ? rgbaToDataUrl(image) : null;
  }
  const [hash, width = "", height = ""] = value.replace(/^blurhash:\//, "").split("/");
  const w = Math.min(64, parseInt(width, 10) || 16);
  const h = Math.min(64, parseInt(height, 10) || 16);
  const image = blurhashToRgba(decodeURIComponent(hash), w, h);
  return image ? rgbaToDataUrl(image) : null;
}
