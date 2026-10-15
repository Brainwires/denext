// Serving objects from the app's own origin, shared by the plugin's object route
// (`/_denext/storage/o/…`) and the Storage API (`/storage/v1/…`): the object path parser, the
// security and caching headers, conditional and ranged answers, and the transformable-source
// check.

import { parseRange } from "@denext/denext/server";
import { isStorageError, StorageError } from "./errors.ts";
import { normalizeKey } from "./keys.ts";
import { essence } from "./mime.ts";
import { readAll } from "./streams.ts";
import type { ByteRange, ObjectInfo, StoredObject } from "./types.ts";

/** The largest source an image transform reads into memory. */
const TRANSFORM_SOURCE_LIMIT = 25 * 1024 * 1024;
/** Raster types the image pipeline decodes. */
const TRANSFORMABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/**
 * Split `<bucket>/<key…>` (percent-encoded) into a bucket and a normalized key.
 *
 * @param rest The path below the route's prefix.
 * @returns The bucket and key.
 * @throws {StorageError} `not_found` without a key; `invalid_key` for a malformed one.
 */
export function bucketAndKey(rest: string): { bucket: string; key: string } {
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new StorageError("not_found", "Object not found");
  try {
    const bucket = decodeURIComponent(rest.slice(0, slash));
    const key = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
    return { bucket, key: normalizeKey(key) };
  } catch (err) {
    if (isStorageError(err)) throw err;
    throw new StorageError("invalid_key", "malformed object path");
  }
}

/**
 * Security and caching headers for an object served from the app's own origin: `nosniff`, a
 * sandboxing CSP (an uploaded HTML or SVG file never runs script with the app's origin), and the
 * `Content-Disposition` given.
 *
 * @param info The object's type, ETag and modification time.
 * @param cache `Cache-Control`.
 * @param disposition `Content-Disposition`.
 * @returns The headers.
 */
export function objectHeaders(
  info: { contentType: string; etag?: string; lastModified?: Date },
  cache: string,
  disposition: string,
): Headers {
  const headers = new Headers({
    "content-type": info.contentType,
    "cache-control": cache,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "content-disposition": disposition,
  });
  if (info.etag) headers.set("etag", `"${info.etag}"`);
  if (info.lastModified) headers.set("last-modified", info.lastModified.toUTCString());
  return headers;
}

/**
 * The answer an object request gets before its body is read: `304` for a matching
 * `If-None-Match`, `416` for an unsatisfiable range — else the range to read (or none).
 *
 * @param info The object.
 * @param headers Its headers (a 416 adds `Content-Range`).
 * @param request The request.
 * @returns A response to send now, or the range.
 */
export function preflight(
  info: ObjectInfo,
  headers: Headers,
  request: Request,
): Response | { range?: ByteRange } {
  if (info.etag && request.headers.get("if-none-match") === `"${info.etag}"`) {
    return new Response(null, { status: 304, headers });
  }
  const header = request.headers.get("range");
  const range = header === null ? undefined : parseRange(header, info.size);
  if (range === null) {
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  return { range };
}

/**
 * A `200` with the whole object, or a `206` with the range.
 *
 * @param info The object.
 * @param headers Its headers.
 * @param range The range served, if any.
 * @param body The bytes (`null` for HEAD).
 * @returns The response.
 */
export function objectResponse(
  info: ObjectInfo,
  headers: Headers,
  range: ByteRange | undefined,
  body: ReadableStream<Uint8Array> | null,
): Response {
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(info.size));
  return new Response(body, { status: 200, headers });
}

/**
 * Read an image object to transform: PNG, JPEG, GIF, WebP or AVIF, at most 25 MiB.
 *
 * @param object The object.
 * @returns Its bytes.
 * @throws {StorageError} `bad_request` for another type, `too_large` for a big source.
 */
export async function transformSource(object: StoredObject): Promise<Uint8Array> {
  if (!TRANSFORMABLE.has(essence(object.contentType))) {
    await object.body.cancel();
    throw new StorageError(
      "bad_request",
      "only PNG, JPEG, GIF, WebP and AVIF images can be transformed",
    );
  }
  if (object.size > TRANSFORM_SOURCE_LIMIT) {
    await object.body.cancel();
    throw new StorageError("too_large", "image too large to transform");
  }
  return await readAll(object.body, TRANSFORM_SOURCE_LIMIT);
}

/**
 * The headers of a transformed image: the object's, with the encoder's type and no ETag or
 * ranges (the bytes are not the stored ones).
 *
 * @param object The source object.
 * @param out The encoder's response.
 * @param cache `Cache-Control`.
 * @param disposition `Content-Disposition`.
 * @returns The headers.
 */
export function transformedHeaders(
  object: ObjectInfo,
  out: Response,
  cache: string,
  disposition: string,
): Headers {
  const headers = objectHeaders(
    { ...object, contentType: out.headers.get("content-type")! },
    cache,
    disposition,
  );
  headers.delete("etag");
  headers.delete("accept-ranges");
  return headers;
}

/** The storage error a failed transform answer stands for. */
export async function transformError(out: Response): Promise<StorageError> {
  return new StorageError(out.status === 413 ? "too_large" : "bad_request", await out.text());
}
