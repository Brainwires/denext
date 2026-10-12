// The plugin's request handler, under `/_denext/storage/`:
//
//   POST     /_denext/storage/sign            sign an upload / download, complete or abort one
//   GET|HEAD /_denext/storage/o/<bucket>/<key> download (public, or a signed URL), Range, transform
//   PUT|POST /_denext/storage/o/<bucket>/<key> upload through a signed URL (fs driver)
//
// The sign route is a cookie-authenticated write, so it applies denext's `csrf()` rule (a
// cross-site request carrying cookies is refused) and validates its body before anything runs.
// The object routes are capability URLs: the HMAC signature is the authorization.

import {
  ApiError,
  apiErrorResponse,
  asyncProps,
  createApi,
  csrf,
  isApiError,
  parseRange,
  readCappedBody,
  STALLED,
  TOO_LARGE,
  transformImageBytes,
} from "@denext/denext/server";
import { isStorageError, StorageError } from "./errors.ts";
import { normalizeKey } from "./keys.ts";
import { dispositionFor, essence } from "./mime.ts";
import {
  bucketOf,
  type ResolvedBucket,
  runtime,
  secretsOf,
  type StorageRuntime,
} from "./runtime.ts";
import { readTransform, STORAGE_PREFIX, type StorageTransform } from "./shared.ts";
import { checkExpiry, nowSeconds, verifyPayload } from "./signing.ts";
import { type SignRequest, signSchema } from "./sign-schema.ts";
import {
  abortUpload,
  completeUpload,
  downloadPayload,
  planUpload,
  presignedDownload,
  storage,
  storeChecked,
  uploadPayload,
} from "./storage.ts";
import { readAll } from "./streams.ts";
import type { ByteRange, ObjectInfo, StoredObject } from "./types.ts";

/** The sign route's body cap (a multipart completion lists up to 10 000 parts). */
const SIGN_BODY_LIMIT = 1024 * 1024;
/** The largest source an image transform reads into memory. */
const TRANSFORM_SOURCE_LIMIT = 25 * 1024 * 1024;
/** Raster types the image pipeline decodes. */
const TRANSFORMABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Map anything thrown to the JSON error envelope denext's typed API uses. */
function errorResponse(err: unknown): Response {
  if (isApiError(err)) return apiErrorResponse(err);
  if (isStorageError(err)) {
    return apiErrorResponse(new ApiError(err.status, err.code, { message: err.message }));
  }
  console.error("[@denext/backend] storage request failed", err);
  return apiErrorResponse(new ApiError(500, "internal", { message: "storage request failed" }));
}

/**
 * The storage request handler (registered by the plugin). Answers only paths under
 * `/_denext/storage/`; everything else passes (`null`).
 *
 * @param request The request (app-relative: `basePath` already stripped).
 * @returns The response, or `null`.
 */
export async function handleStorageRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(STORAGE_PREFIX + "/")) return null;
  const sub = pathname.slice(STORAGE_PREFIX.length);
  try {
    if (sub === "/sign") return await signRoute(request);
    if (sub.startsWith("/o/")) return await objectRoute(request, sub.slice(3));
    throw new StorageError("not_found", "no such storage endpoint");
  } catch (err) {
    return errorResponse(err);
  }
}

// ── POST /sign ───────────────────────────────────────────────────────────────

const signEndpoint = createApi().use(csrf()).define(
  {
    body: signSchema,
    errors: { forbidden: 403, too_large: 413, mime_not_allowed: 415, unknown_bucket: 404 },
  },
  async ({ body }) => {
    try {
      return await runSignOp(body as SignRequest);
    } catch (err) {
      if (!isStorageError(err)) throw err;
      throw new ApiError(err.status, err.code, { message: err.message });
    }
  },
);

async function signRoute(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const bytes = await readCappedBody(request, SIGN_BODY_LIMIT);
  if (bytes === TOO_LARGE) throw new StorageError("too_large", "request body too large");
  if (bytes === STALLED) throw new StorageError("bad_request", "request body stalled");
  const buffered = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes as BodyInit,
  });
  return await signEndpoint(buffered, { params: asyncProps<Record<string, string>>({}) });
}

/** A generated key: a random id, keeping a short, safe extension from the file name. */
function generatedKey(filename?: string): string {
  const ext = filename?.match(/\.[A-Za-z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  return crypto.randomUUID() + ext;
}

async function runSignOp(body: SignRequest): Promise<unknown> {
  switch (body.op) {
    case "upload":
      return await planUpload(
        body.bucket,
        body.key ?? generatedKey(body.filename),
        body.contentType,
        body.size,
      );
    case "complete":
      return { object: await completeUpload(body.token, body.parts) };
    case "abort":
      await abortUpload(body.token);
      return { ok: true };
    case "download":
      return {
        url: await storage.bucket(body.bucket).createSignedUrl(body.key, {
          expiresIn: body.expiresIn,
          transform: body.transform,
        }),
      };
  }
}

// ── /o/<bucket>/<key> ────────────────────────────────────────────────────────

/** Split `<bucket>/<key…>` (percent-encoded) into a bucket and a normalized key. */
function parseObjectPath(rest: string): { bucket: string; key: string } {
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new StorageError("not_found", "no such object");
  try {
    const bucket = decodeURIComponent(rest.slice(0, slash));
    const key = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
    return { bucket, key: normalizeKey(key) };
  } catch (err) {
    if (isStorageError(err)) throw err;
    throw new StorageError("invalid_key", "malformed object path");
  }
}

async function objectRoute(request: Request, rest: string): Promise<Response> {
  const rt = runtime();
  const { bucket: name, key } = parseObjectPath(rest);
  const bucket = bucketOf(rt, name);
  const params = new URL(request.url).searchParams;
  switch (request.method) {
    case "GET":
    case "HEAD":
      return await download(rt, bucket, key, params, request);
    case "PUT":
    case "POST":
      return await upload(rt, bucket, key, params, request);
    default:
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "GET, HEAD, PUT, POST" },
      });
  }
}

/** Check a download URL's signature (a public bucket needs none); returns its expiry. */
async function checkDownloadSignature(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  params: URLSearchParams,
  transform?: StorageTransform,
): Promise<number | null> {
  if (bucket.public) return null;
  const exp = checkExpiry(params.get("exp"));
  const payload = downloadPayload(bucket.name, key, exp, transform);
  if (!(await verifyPayload(payload, params.get("sig") ?? "", secretsOf(rt)))) {
    throw new StorageError("bad_signature", "signature mismatch");
  }
  return exp;
}

async function download(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  params: URLSearchParams,
  request: Request,
): Promise<Response> {
  const transform = readTransform(params);
  const exp = await checkDownloadSignature(rt, bucket, key, params, transform);
  const cache = exp === null
    ? "public, max-age=3600"
    : `private, max-age=${Math.max(0, Math.min(exp - nowSeconds(), 3600))}`;
  if (transform) return await transformed(rt, bucket, key, transform, cache, request);
  if (rt.driver.direct) {
    // A public object on a direct store: hand the client a short-lived presigned GET.
    const url = await presignedDownload(rt, bucket.name, key, 300);
    return new Response(null, {
      status: 302,
      headers: { location: url, "cache-control": "private, max-age=60" },
    });
  }
  return await serveObject(rt, bucket, key, cache, request);
}

/** Security and caching headers for an object served from the app's own origin. */
function objectHeaders(info: ObjectInfo, cache: string): Headers {
  const type = essence(info.contentType) || "application/octet-stream";
  const headers = new Headers({
    "content-type": info.contentType,
    "cache-control": cache,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    // An uploaded HTML or SVG file must never run script with the app's origin.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "content-disposition": dispositionFor(type),
  });
  if (info.etag) headers.set("etag", `"${info.etag}"`);
  if (info.lastModified) headers.set("last-modified", info.lastModified.toUTCString());
  return headers;
}

async function serveObject(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  cache: string,
  request: Request,
): Promise<Response> {
  const info = await rt.driver.head(bucket.name, key);
  if (!info) throw new StorageError("not_found", "no such object");
  const headers = objectHeaders(info, cache);
  if (info.etag && request.headers.get("if-none-match") === `"${info.etag}"`) {
    return new Response(null, { status: 304, headers });
  }
  const header = request.headers.get("range");
  const range = header === null ? undefined : parseRange(header, info.size);
  if (range === null) {
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = request.method === "HEAD" ? null : await rt.driver.get(bucket.name, key, range);
  if (request.method !== "HEAD" && !object) throw new StorageError("not_found", "no such object");
  return objectResponse(info, headers, range, object);
}

function objectResponse(
  info: ObjectInfo,
  headers: Headers,
  range: ByteRange | undefined,
  object: StoredObject | null,
): Response {
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(object?.body ?? null, { status: 206, headers });
  }
  headers.set("content-length", String(info.size));
  return new Response(object?.body ?? null, { status: 200, headers });
}

async function transformed(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  transform: StorageTransform,
  cache: string,
  request: Request,
): Promise<Response> {
  const object = await rt.driver.get(bucket.name, key);
  if (!object) throw new StorageError("not_found", "no such object");
  if (!TRANSFORMABLE.has(essence(object.contentType))) {
    await object.body.cancel();
    throw new StorageError("bad_request", "only PNG, JPEG, GIF and WebP images can be transformed");
  }
  if (object.size > TRANSFORM_SOURCE_LIMIT) {
    await object.body.cancel();
    throw new StorageError("too_large", "image too large to transform");
  }
  const bytes = await readAll(object.body, TRANSFORM_SOURCE_LIMIT);
  const out = await transformImageBytes(bytes, transform, {
    images: rt.images,
    cacheKey: `${bucket.name}/${key}@${object.etag ?? object.lastModified?.getTime() ?? ""}`,
  });
  if (!out.ok) {
    throw new StorageError(out.status === 413 ? "too_large" : "bad_request", await out.text());
  }
  const headers = objectHeaders(
    { ...object, contentType: out.headers.get("content-type")! },
    cache,
  );
  headers.delete("etag");
  headers.delete("accept-ranges");
  return new Response(request.method === "HEAD" ? null : out.body, { headers });
}

/** An upload through a signed URL — the fs driver's path (a direct store takes PUTs itself). */
async function upload(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  params: URLSearchParams,
  request: Request,
): Promise<Response> {
  if (rt.driver.direct) throw new StorageError("unsupported", "upload to the store's own URL");
  const exp = checkExpiry(params.get("exp"));
  const ct = params.get("ct") ?? "";
  const max = Number(params.get("max"));
  const n = params.get("n");
  const size = n === null ? undefined : Number(n);
  const payload = uploadPayload(bucket.name, key, exp, ct, max, size);
  if (!(await verifyPayload(payload, params.get("sig") ?? "", secretsOf(rt)))) {
    throw new StorageError("bad_signature", "signature mismatch");
  }
  if (essence(request.headers.get("content-type") ?? "") !== ct) {
    throw new StorageError("mime_mismatch", `the upload must be sent as ${ct}`);
  }
  checkDeclaredLength(request, Math.min(max, bucket.maxBytes), size);
  if (!request.body) throw new StorageError("bad_request", "missing body");
  const info = await storeChecked(
    rt,
    bucket,
    key,
    request.body,
    ct,
    Math.min(max, bucket.maxBytes),
    size,
  );
  return Response.json({ object: info }, { headers: info.etag ? { etag: `"${info.etag}"` } : {} });
}

function checkDeclaredLength(request: Request, max: number, size?: number): void {
  const declared = request.headers.get("content-length");
  if (declared === null) return;
  const length = Number(declared);
  if (length > max) throw new StorageError("too_large", `object exceeds ${max} bytes`);
  if (size !== undefined && length !== size) {
    throw new StorageError("bad_request", `body is ${length} bytes, ${size} were declared`);
  }
}
