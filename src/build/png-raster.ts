// RGBA rasters for `denext mobile assets`: decode and resize through `@denext/photon` (wasm),
// compose in plain TypeScript, and encode PNGs here (RGB or RGBA) with the web-standard
// CompressionStream. Nothing in it reaches npm, and the encoder writes an RGB PNG (colour type 2)
// when asked to, which Apple requires of the App Store icon (it refuses an icon with an alpha
// channel even when every pixel is opaque, and photon's encoder always writes RGBA).

/** An RGBA image: `px` holds `width * height * 4` bytes, row-major, not premultiplied. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly px: Uint8Array;
}

/** An opaque colour. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse `#rgb` / `#rrggbb` (the `#` optional).
 *
 * @param value The colour as written on the command line or in the config.
 * @returns The colour, or null when it is not hex.
 */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: n >> 16, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** `#RRGGBB` for Android's colour resources. */
export function hexOf(color: Rgb): string {
  return "#" + [color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, "0")).join("")
    .toUpperCase();
}

/** A `width`×`height` raster filled with `color` (transparent when omitted). */
export function solid(width: number, height: number, color?: Rgb): Raster {
  const px = new Uint8Array(width * height * 4);
  if (color) {
    new Uint32Array(px.buffer).fill(
      new Uint32Array(new Uint8Array([color.r, color.g, color.b, 255]).buffer)[0],
    );
  }
  return { width, height, px };
}

/**
 * Decode PNG / JPEG / WebP bytes.
 *
 * @throws {Error} When photon cannot decode them (SVG, ICO, a truncated file, …).
 */
export async function decodeImage(bytes: Uint8Array): Promise<Raster> {
  const { PhotonImage } = await import("@denext/photon");
  const img = PhotonImage.new_from_byteslice(bytes);
  try {
    return { width: img.get_width(), height: img.get_height(), px: img.get_raw_pixels() };
  } finally {
    img.free();
  }
}

/** `src` resampled (Lanczos3) to exactly `width`×`height`. */
export async function resizeRaster(src: Raster, width: number, height: number): Promise<Raster> {
  if (src.width === width && src.height === height) return src;
  const { PhotonImage, resize, SamplingFilter } = await import("@denext/photon");
  const img = new PhotonImage(src.px, src.width, src.height);
  const out = resize(img, width, height, SamplingFilter.Lanczos3);
  try {
    return { width, height, px: out.get_raw_pixels() };
  } finally {
    img.free();
    out.free();
  }
}

/** `src` scaled (aspect kept) to fit inside `box`×`box`, then centred on it. */
export async function fitInto(src: Raster, box: number): Promise<Raster> {
  const scale = box / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = solid(box, box);
  drawOver(canvas, await resizeRaster(src, w, h), (box - w) >> 1, (box - h) >> 1);
  return canvas;
}

/** `src` scaled (aspect kept) to cover `width`×`height`, centre-cropped to it. */
export async function coverInto(src: Raster, width: number, height: number): Promise<Raster> {
  const scale = Math.max(width / src.width, height / src.height);
  const w = Math.max(width, Math.round(src.width * scale));
  const h = Math.max(height, Math.round(src.height * scale));
  const big = await resizeRaster(src, w, h);
  const out = solid(width, height);
  const x0 = (w - width) >> 1;
  const y0 = (h - height) >> 1;
  for (let y = 0; y < height; y++) {
    const s = ((y + y0) * w + x0) * 4;
    out.px.set(big.px.subarray(s, s + width * 4), y * width * 4);
  }
  return out;
}

/** Composite `top` over `base` at (`x`, `y`) with source-over alpha blending, in place. */
export function drawOver(base: Raster, top: Raster, x: number, y: number): void {
  for (let ty = 0; ty < top.height; ty++) {
    const by = ty + y;
    if (by < 0 || by >= base.height) continue;
    for (let tx = 0; tx < top.width; tx++) {
      const bx = tx + x;
      if (bx < 0 || bx >= base.width) continue;
      blendPixel(base.px, (by * base.width + bx) * 4, top.px, (ty * top.width + tx) * 4);
    }
  }
}

/** Source-over one pixel of `s` (at `si`) onto `d` (at `di`). */
function blendPixel(d: Uint8Array, di: number, s: Uint8Array, si: number): void {
  const sa = s[si + 3] / 255;
  if (sa === 0) return;
  const da = d[di + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let c = 0; c < 3; c++) {
    d[di + c] = Math.round((s[si + c] * sa + d[di + c] * da * (1 - sa)) / oa);
  }
  d[di + 3] = Math.round(oa * 255);
}

/** A copy of `src` with every pixel outside the inscribed circle made transparent. */
export function circleMasked(src: Raster): Raster {
  const px = src.px.slice();
  const r = Math.min(src.width, src.height) / 2;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const dx = x + 0.5 - src.width / 2;
      const dy = y + 0.5 - src.height / 2;
      // A one-pixel anti-aliased edge.
      const cover = Math.max(0, Math.min(1, r - Math.sqrt(dx * dx + dy * dy) + 0.5));
      const i = (y * src.width + x) * 4 + 3;
      px[i] = Math.round(px[i] * cover);
    }
  }
  return { width: src.width, height: src.height, px };
}

/** A copy of `src` with its colour replaced by white, alpha kept (Android's monochrome layer). */
export function silhouette(src: Raster): Raster {
  const px = src.px.slice();
  for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255;
  return { width: src.width, height: src.height, px };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the PNG / zip polynomial) of `bytes`. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type + data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-deflate `bytes` with the web-standard CompressionStream. */
async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The scanlines of `src` as `channels`-byte pixels, each row prefixed with filter 0 (None). */
function scanlines(src: Raster, channels: 3 | 4): Uint8Array {
  const stride = src.width * channels;
  const raw = new Uint8Array((stride + 1) * src.height);
  for (let y = 0; y < src.height; y++) {
    const row = src.px.subarray(y * src.width * 4, (y + 1) * src.width * 4);
    const o = y * (stride + 1) + 1;
    if (channels === 4) raw.set(row, o);
    else {
      for (let x = 0, d = o; x < row.length; x += 4, d += 3) {
        raw[d] = row[x];
        raw[d + 1] = row[x + 1];
        raw[d + 2] = row[x + 2];
      }
    }
  }
  return raw;
}

/**
 * Encode `src` as a PNG.
 *
 * @param src The image.
 * @param opts `alpha: false` writes RGB (colour type 2), dropping the alpha channel; flatten
 *   the image onto a background first ({@linkcode flatten}).
 * @returns The PNG bytes.
 */
export async function encodePng(src: Raster, opts: { alpha?: boolean } = {}): Promise<Uint8Array> {
  const alpha = opts.alpha !== false;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, src.width);
  view.setUint32(4, src.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA : RGB
  const idat = await zlib(scanlines(src, alpha ? 4 : 3));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `src` composited over an opaque `background` (every pixel ends fully opaque). */
export function flatten(src: Raster, background: Rgb): Raster {
  const base = solid(src.width, src.height, background);
  drawOver(base, src, 0, 0);
  return base;
}
