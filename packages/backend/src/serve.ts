// Serving objects from the app's own origin, shared by the plugin's object route
// (`/_denext/storage/o/…`) and the Storage API (`/storage/v1/…`): the object path parser, the
// security and caching headers, conditional and ranged answers, and the transformable-source
// check.

import { parseRanges } from "@denext/denext/server";
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
 * `If-None-Match`, `416` when none of the requested ranges can be satisfied — else the ranges to
 * read (none for the whole object). `Range` is read as the static file handler reads it (several
 * ranges, sorted and coalesced; {@linkcode parseRanges}), and an `If-Range` that no longer names
 * the object asks for all of it.
 *
 * @param info The object.
 * @param headers Its headers (a 416 adds `Content-Range`).
 * @param request The request.
 * @returns A response to send now, or the ranges.
 */
export function preflight(
  info: ObjectInfo,
  headers: Headers,
  request: Request,
): Response | { ranges?: ByteRange[] } {
  if (info.etag && request.headers.get("if-none-match") === `"${info.etag}"`) {
    return new Response(null, { status: 304, headers });
  }
  const header = request.headers.get("range");
  const ranges = header === null || !ifRangeHolds(request.headers, info)
    ? undefined
    : parseRanges(header, info.size);
  if (ranges === null) {
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  return { ranges };
}

/**
 * `If-Range` (RFC 9110 §13.1.5): absent, or a validator that still names this object, lets the
 * range through; anything else asks for the whole object. An entity tag must match strongly (a
 * weak one never does), a date must equal `Last-Modified` to the second.
 */
function ifRangeHolds(req: Headers, info: ObjectInfo): boolean {
  const value = req.get("if-range")?.trim();
  if (value === undefined) return true;
  if (value.startsWith("W/")) return false;
  if (value.startsWith('"')) return info.etag !== undefined && value === `"${info.etag}"`;
  const date = Date.parse(value);
  return info.lastModified !== undefined && Number.isFinite(date) &&
    Math.floor(info.lastModified.getTime() / 1000) === Math.floor(date / 1000);
}

/** Reads an object's bytes, or one range of them; rejects when the object is gone. */
export type ObjectReader = (range?: ByteRange) => Promise<ReadableStream<Uint8Array>>;

/**
 * A `200` with the whole object, a `206` with one range, or a `206` with several as one
 * `multipart/byteranges` body (RFC 9110 §14.6), each part read in turn.
 *
 * @param info The object.
 * @param headers Its headers.
 * @param ranges The ranges served ({@linkcode preflight}'s), if any.
 * @param read Reads the bytes (`null` for HEAD).
 * @returns The response.
 */
export async function objectResponse(
  info: ObjectInfo,
  headers: Headers,
  ranges: ByteRange[] | undefined,
  read: ObjectReader | null,
): Promise<Response> {
  if (ranges && ranges.length > 1) return await multipartResponse(info, headers, ranges, read);
  const range = ranges?.[0];
  const body = read ? await read(range) : null;
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(info.size));
  return new Response(body, { status: 200, headers });
}

/** Several ranges as `multipart/byteranges`: the first part is read before the answer starts. */
async function multipartResponse(
  info: ObjectInfo,
  headers: Headers,
  ranges: ByteRange[],
  read: ObjectReader | null,
): Promise<Response> {
  const type = headers.get("content-type") ?? "application/octet-stream";
  const dash = `--denext-${crypto.randomUUID().replaceAll("-", "")}`;
  const bytes = (text: string) => new TextEncoder().encode(text);
  // Each part: its delimiter line (CRLF-led after the first), its headers, a blank line.
  const heads = ranges.map(({ start, end }, i) =>
    bytes(
      [i > 0 ? "\r\n" : "", dash, "\r\n", "content-type: ", type, "\r\n"].join("") +
        `content-range: bytes ${start}-${end}/${info.size}\r\n\r\n`,
    )
  );
  const tail = bytes(`\r\n${dash}--\r\n`);
  let length = tail.byteLength;
  for (const [i, { start, end }] of ranges.entries()) {
    length += heads[i].byteLength + end - start + 1;
  }
  headers.set("content-type", `multipart/byteranges; boundary=${dash.slice(2)}`);
  headers.set("content-length", String(length));
  if (!read) return new Response(null, { status: 206, headers });
  const first = await read(ranges[0]);
  async function* parts(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < ranges.length; i++) {
      yield heads[i];
      yield* i === 0 ? first : await read!(ranges[i]);
    }
    yield tail;
  }
  return new Response(ReadableStream.from(parts()), { status: 206, headers });
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
