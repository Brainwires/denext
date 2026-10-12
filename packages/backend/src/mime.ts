// Content types: the bucket allow-list match, and magic-byte sniffing of the first bytes of an
// upload, so a file declared as an image really is that image (an HTML or script payload
// declared `image/png` is refused before it is stored).

import { StorageError } from "./errors.ts";

/** How many leading bytes {@link sniffMime} needs. */
export const SNIFF_BYTES = 64;

/** The raster image types sniffing recognizes, by their leading bytes. */
const SIGNATURES: { type: string; test: (b: Uint8Array) => boolean }[] = [
  {
    type: "image/png",
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { type: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { type: "image/gif", test: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
  { type: "image/webp", test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { type: "image/avif", test: (b) => isFtyp(b, ["avif", "avis"]) },
  { type: "image/heic", test: (b) => isFtyp(b, ["heic", "heix", "hevc", "heim", "heis", "mif1"]) },
  { type: "image/bmp", test: (b) => ascii(b, 0, 2) === "BM" },
  { type: "image/x-icon", test: (b) => startsWith(b, [0x00, 0x00, 0x01, 0x00]) },
  {
    type: "image/tiff",
    test: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  },
];

/** Declared spellings that name the same sniffed type. */
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/vnd.microsoft.icon": "image/x-icon",
  "image/heif": "image/heic",
};

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return b.length >= to ? String.fromCharCode(...b.subarray(from, to)) : "";
}

/** An ISO-BMFF `ftyp` box naming one of `brands` as its major brand. */
function isFtyp(b: Uint8Array, brands: string[]): boolean {
  return ascii(b, 4, 8) === "ftyp" && brands.includes(ascii(b, 8, 12));
}

/** Types a browser may render inline (everything else downloads as an attachment). */
const INLINE =
  /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|video\/|audio\/|application\/pdf$|text\/plain$)/;

/**
 * How an object of this type is served: `inline` only for the types a browser renders without
 * running anything (raster images, audio, video, PDF, plain text) — an HTML, SVG or unknown file
 * is always an attachment, so it never runs script with the serving origin.
 *
 * @param type The content type's essence.
 * @returns The `Content-Disposition` type.
 */
export function dispositionFor(type: string): "inline" | "attachment" {
  return INLINE.test(type) ? "inline" : "attachment";
}

/**
 * The essence of a content type: lowercased, without parameters (`Image/PNG; x=1` → `image/png`).
 *
 * @param contentType A `Content-Type` value.
 * @returns The bare `type/subtype`, or `""` when it is not one.
 */
export function essence(contentType: string): string {
  const bare = contentType.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare) ? bare : "";
}

/**
 * Whether `contentType` is on a bucket's allow-list. Entries are exact types
 * (`application/pdf`) or a top-level wildcard (`image/*`); no list allows everything.
 *
 * @param contentType The declared content type (already an {@link essence}).
 * @param allowList The bucket's `mime` list.
 * @returns Whether it is allowed.
 */
export function mimeAllowed(contentType: string, allowList?: readonly string[]): boolean {
  if (!allowList) return true;
  return allowList.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e === "*/*") return true;
    if (e.endsWith("/*")) return contentType.startsWith(e.slice(0, -1));
    return e === contentType;
  });
}

/**
 * The image type the leading bytes carry, or `null` when they match no known raster
 * signature.
 *
 * @param head The first bytes of the content (at least {@link SNIFF_BYTES} when available).
 * @returns The sniffed `image/*` type, or `null`.
 */
export function sniffMime(head: Uint8Array): string | null {
  return SIGNATURES.find((s) => s.test(head))?.type ?? null;
}

/** Whether the head is SVG/XML text (a BOM and whitespace skipped). */
function looksLikeSvg(head: Uint8Array): boolean {
  const text = new TextDecoder().decode(head).replace(/^﻿/, "").trimStart().toLowerCase();
  return text.startsWith("<svg") || text.startsWith("<?xml");
}

/**
 * Check an upload's content against its declared type: a declared raster image type sniffing
 * knows (PNG, JPEG, GIF, WebP, AVIF, HEIC, BMP, ICO, TIFF) must sniff as that same type, and a
 * declared SVG must start like an SVG/XML document. Other declared types are not sniffed (only
 * images have reliable signatures), but content that sniffs as an image the allow-list does not
 * cover is refused whatever it is declared as.
 *
 * @param declared The declared content type (an {@link essence}).
 * @param head The first bytes of the content.
 * @param allowList The bucket's `mime` allow-list.
 * @throws {StorageError} `mime_mismatch` when the content contradicts the declared type.
 */
export function checkSniffed(
  declared: string,
  head: Uint8Array,
  allowList?: readonly string[],
): void {
  const sniffed = sniffMime(head);
  const want = ALIASES[declared] ?? declared;
  if (want === "image/svg+xml") {
    if (!looksLikeSvg(head)) throw mismatch(declared, "not an SVG document");
    return;
  }
  if (SIGNATURES.some((s) => s.type === want)) {
    if (sniffed !== want) throw mismatch(declared, sniffed ?? "no image signature");
    return;
  }
  if (sniffed && !mimeAllowed(sniffed, allowList)) throw mismatch(declared, sniffed);
}

function mismatch(declared: string, found: string): StorageError {
  return new StorageError(
    "mime_mismatch",
    `content does not match its declared type ${declared} (found ${found})`,
  );
}
