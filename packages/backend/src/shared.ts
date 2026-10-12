// Shapes and constants shared by the server half and the browser half of `@denext/backend`'s
// storage. This module imports nothing, so the client entry can bundle it without pulling any
// server code into the browser.

/** The URL prefix the storage plugin serves under (app-relative; `basePath` is prepended). */
export const STORAGE_PREFIX = "/_denext/storage";

/**
 * An image transform applied on download: resize (fitted inside `width` × `height`, never
 * enlarged) and re-encode through denext's image pipeline. Only image objects are transformed.
 * `width` and `height` must each be one of the app's `images.deviceSizes ∪ images.imageSizes`
 * (Next's defaults: 32 … 3840), so the number of distinct encodes per object stays bounded.
 */
export interface StorageTransform {
  /** Target width in pixels. */
  width?: number;
  /** Target height in pixels. */
  height?: number;
  /** Encoder quality, coerced to the nearest of `images.qualities` (default `[75]`). */
  quality?: number;
  /** `"webp"` (the default) or `"avif"` (when `images.formats` lists `image/avif`). */
  format?: "webp" | "avif";
}

/** The short query-parameter names a transform travels under (`?w=&h=&q=&fmt=`). */
const TRANSFORM_PARAMS = [
  ["width", "w"],
  ["height", "h"],
  ["quality", "q"],
  ["format", "fmt"],
] as const;

/**
 * Append a transform's parameters to `params` in a fixed order (so a signed URL's canonical
 * string is stable).
 *
 * @param params The query to extend.
 * @param transform The transform, or `undefined` for none.
 */
export function writeTransform(params: URLSearchParams, transform?: StorageTransform): void {
  if (!transform) return;
  for (const [field, short] of TRANSFORM_PARAMS) {
    const value = transform[field];
    if (value !== undefined) params.set(short, String(value));
  }
}

/**
 * Read a transform back from a query, or `undefined` when the query names none. A numeric
 * field that is not a positive integer is returned as `NaN`, which the size allowlist refuses.
 *
 * @param params The request's query.
 * @returns The transform, or `undefined`.
 */
export function readTransform(params: URLSearchParams): StorageTransform | undefined {
  const out: Record<string, number | string> = {};
  let any = false;
  for (const [field, short] of TRANSFORM_PARAMS) {
    const raw = params.get(short);
    if (raw === null) continue;
    any = true;
    out[field] = field === "format" ? raw : /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : NaN;
  }
  return any ? out as StorageTransform : undefined;
}

/**
 * The path of an object under the plugin's prefix: `/_denext/storage/o/<bucket>/<key>`, each
 * key segment percent-encoded on its own (so `/` stays a separator and nothing else is).
 *
 * @param base The app's `basePath` (`""` for none).
 * @param bucket The bucket name.
 * @param key The normalized object key.
 * @returns The app-absolute path.
 */
export function objectPath(base: string, bucket: string, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${base}${STORAGE_PREFIX}/o/${encodeURIComponent(bucket)}/${encoded}`;
}
