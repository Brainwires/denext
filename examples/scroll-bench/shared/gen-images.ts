/**
 * Writes the placeholder images the `images` kind shows, identically into both apps:
 * web/public/img/ and native/assets/img/. Local files, so no network in any run.
 *
 *   deno run -A shared/gen-images.ts     (from examples/scroll-bench/)
 *
 * A small PNG encoder (truecolor, zlib via CompressionStream) so nothing is installed.
 */

import { IMAGE_ASSETS, mix, rng } from "./data.ts";
import { PALETTE } from "./theme.ts";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A `w`×`h` truecolor PNG: a diagonal two-colour gradient with stripes and a disc. */
export async function png(w: number, h: number, seed: number): Promise<Uint8Array> {
  const r = rng(mix(seed, 0x1a6e));
  const a = rgb(PALETTE[Math.floor(r() * PALETTE.length)]);
  const b = rgb(PALETTE[Math.floor(r() * PALETTE.length)]);
  const cx = w * (0.25 + r() * 0.5),
    cy = h * (0.25 + r() * 0.5),
    rad = Math.min(w, h) * 0.22;
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < rad * rad;
      const stripe = ((x + y) >> 4) & 1 ? 1 : 0.92;
      for (let c = 0; c < 3; c++) {
        const base = a[c] * (1 - t) + b[c] * t;
        raw[row + 1 + x * 3 + c] = inCircle ? 255 - base * 0.3 : Math.round(base * stripe);
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter, no interlace
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const dirs = [
    new URL("web/public/img/", root),
    new URL("native/assets/img/", root),
  ];
  for (const d of dirs) await Deno.mkdir(d, { recursive: true });
  for (let i = 0; i < IMAGE_ASSETS.length; i++) {
    const { file, w, h } = IMAGE_ASSETS[i];
    const bytes = await png(w, h, i + 1);
    for (const d of dirs) await Deno.writeFile(new URL(file, d), bytes);
    console.log(`${file} ${w}x${h} ${bytes.length} B`);
  }
}
