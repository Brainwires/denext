// AVIF as an image-optimizer SOURCE: recognise the file (an ISOBMFF `ftyp` box naming the
// `avif` / `avis` brand), read its dimensions from the item properties (`meta` → `iprp` →
// `ipco` → `ispe`) BEFORE anything is decoded — the decompression-bomb check every other source
// format gets from its header — and decode it to RGBA with denext's first-party `@denext/avif`
// (libavif). Photon, which decodes the other formats, has no AVIF decoder.
//
// The codec is imported lazily, at call time, like every wasm codec of the optimizer (see the
// header note in `image-optimizer.ts`).

import { inRootContext } from "./root-context.ts";

/** One ISOBMFF box: its type and its payload's span. */
interface Box {
  type: string;
  start: number;
  end: number;
}

/** The boxes in `[start, end)` of `b`, stopping at a malformed one. */
function* boxesIn(b: Uint8Array, dv: DataView, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      const big = dv.getBigUint64(at + 8);
      if (big > BigInt(end - at)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at; // to the end of the enclosing box (or the file)
    }
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

/** The first child box of `type` in `[start, end)`. */
function child(b: Uint8Array, dv: DataView, start: number, end: number, type: string) {
  for (const box of boxesIn(b, dv, start, end)) if (box.type === type) return box;
  return undefined;
}

/** The AVIF brands: a still image (`avif`) or an image sequence (`avis`). */
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Whether `b` is an AVIF file: its first box is `ftyp` and names the `avif` or `avis` brand
 * (major or compatible) — the sniff the storage layer uses too.
 *
 * @param b The file's bytes.
 * @returns `true` for AVIF.
 */
export function isAvif(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ftyp = boxesIn(b, dv, 0, b.length).next().value;
  if (!ftyp || ftyp.type !== "ftyp" || ftyp.end - ftyp.start < 8) return false;
  for (let at = ftyp.start; at + 4 <= ftyp.end; at += 4) {
    if (at === ftyp.start + 4) continue; // minor_version
    if (AVIF_BRANDS.has(String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]))) return true;
  }
  return false;
}

/**
 * An AVIF file's dimensions from its `ispe` (image spatial extents) properties, without
 * decoding: the largest width and height any of its items declares (a grid's own `ispe` is
 * the whole image; its tiles' are smaller). `null` when `b` is not AVIF or declares none — a
 * file libavif would refuse anyway (`ispe` is mandatory for an image item).
 *
 * @param b The file's bytes.
 * @returns The dimensions, or `null`.
 */
export function probeAvif(b: Uint8Array): { width: number; height: number } | null {
  if (!isAvif(b)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const meta = child(b, dv, 0, b.length, "meta");
  // `meta` is a full box: version + flags precede its children.
  const iprp = meta && child(b, dv, meta.start + 4, meta.end, "iprp");
  const ipco = iprp && child(b, dv, iprp.start, iprp.end, "ipco");
  if (!ipco) return null;
  let width = 0;
  let height = 0;
  for (const box of boxesIn(b, dv, ipco.start, ipco.end)) {
    // `ispe`: version + flags, then image_width and image_height (u32 each).
    if (box.type !== "ispe" || box.end - box.start < 12) continue;
    width = Math.max(width, dv.getUint32(box.start + 4));
    height = Math.max(height, dv.getUint32(box.start + 8));
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The subset of `@denext/avif` the decode path calls (typed here: the import is lazy). */
interface AvifDecoder {
  decode(bytes: Uint8Array): Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
}

/**
 * Decode an AVIF file to RGBA with `@denext/avif`. The caller has checked {@link probeAvif}'s
 * dimensions first: the decoder allocates the whole raster.
 *
 * @param b The file's bytes.
 * @returns Its RGBA pixels and dimensions.
 * @throws {Error} When libavif cannot decode it.
 */
export async function decodeAvif(
  b: Uint8Array,
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  // Loaded outside the request: the codec is shared by every request (root-context.ts).
  const { decode } = await inRootContext(() => import("@denext/avif")) as unknown as AvifDecoder;
  const image = await decode(b);
  return {
    rgba: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    width: image.width,
    height: image.height,
  };
}
