// The Supabase-compatible Storage API, under `/storage/v1` (what `supabase.storage` from
// `@supabase/supabase-js` v2 calls, unchanged):
//
//   GET|POST        /bucket                         list, create
//   GET|PUT|DELETE  /bucket/<id>                    get, update, delete
//   POST            /bucket/<id>/empty              empty
//   POST|PUT        /object/<bucket>/<key>          upload, update (x-upsert, cache-control, metadata)
//   GET|HEAD        /object/<bucket>/<key>          download (authenticated), exists
//   GET|HEAD        /object/authenticated/<b>/<k>   download
//   GET|HEAD        /object/public/<b>/<k>          download from a public bucket
//   DELETE          /object/<bucket>                remove { prefixes }
//   DELETE          /object/<bucket>/<key>          remove one
//   POST            /object/list/<bucket>           list { prefix, search, limit, offset, sortBy }
//   POST            /object/move | /object/copy     move, copy (also across buckets)
//   GET             /object/info/<b>/<k>            info
//   POST            /object/sign/<bucket>           signed URLs { paths, expiresIn }
//   POST|GET        /object/sign/<b>/<k>            signed URL; download through it (?token)
//   POST|PUT        /object/upload/sign/<b>/<k>     signed upload URL; upload through it (?token)
//   GET|HEAD        /render/image/{public,authenticated,sign}/<b>/<k>   image transforms
//   *               /upload/resumable…              TUS 1.0.0 (storage-tus.ts)
//
// Who is asking comes from `storage-identity.ts` (the secret key, a session, or anon); what they
// may do from the bucket's `authorize` and, under SQL-RLS, the `storage` tables' policies
// (`storage-ops.ts`). A write carrying cookies follows the Server Actions rule (`csrf()`).
// Errors are Storage's `{ statusCode, error, message }`.

import {
  csrf,
  type ImageTransform,
  isApiError,
  nativeBearerToken,
  readCappedBody,
  STALLED,
  TOO_LARGE,
  transformImageBytes,
} from "@denext/denext/server";
import { isStorageError, StorageError, type StorageErrorCode } from "./errors.ts";
import { normalizeKey } from "./keys.ts";
import { dispositionFor, essence } from "./mime.ts";
import {
  clampExpiry,
  resolveBucket,
  type ResolvedBucket,
  secretsOf,
  type StorageRuntime,
} from "./runtime.ts";
import { nowSeconds, openToken, sealToken } from "./signing.ts";
import { isIdentityError } from "./identity.ts";
import type { BucketRow, ListQuery, ObjectRow, SortColumn } from "./storage-meta.ts";
import {
  actorFor,
  authorizeOp,
  cacheControlOf,
  Caller,
  capFor,
  copyObject,
  createBucket,
  deleteBucket,
  emptyBucket,
  getBucket,
  listBuckets,
  listEntries,
  moveObject,
  putObject,
  readableRow,
  removeObjects,
  SERVICE_CALLER,
  updateBucket,
} from "./storage-ops.ts";
import {
  bucketAndKey,
  objectHeaders,
  objectResponse,
  preflight,
  transformedHeaders,
  transformError,
  transformSource,
} from "./serve.ts";
import { parseMultipart } from "./multipart.ts";
import { handleResumable } from "./storage-tus.ts";

/** A JSON request body's cap. */
const JSON_LIMIT = 1024 * 1024;
/** Multipart overhead allowed above the bucket's cap. */
const FORM_OVERHEAD = 64 * 1024;
/** A signed upload URL's lifetime (Supabase's: two hours). */
const SIGNED_UPLOAD_EXPIRY = 2 * 3600;
/** `user_metadata`'s cap, as JSON. */
const METADATA_LIMIT = 8 * 1024;
/** Paths a bulk remove or a batch of signed URLs may name at once. */
const MAX_BATCH = 1000;

/** Storage's error names, per denext code. */
const ERROR_NAMES: Record<StorageErrorCode, string> = {
  forbidden: "Unauthorized",
  not_found: "not_found",
  invalid_key: "InvalidKey",
  invalid_bucket: "InvalidBucketName",
  unknown_bucket: "Bucket not found",
  too_large: "Payload too large",
  mime_not_allowed: "invalid_mime_type",
  mime_mismatch: "invalid_mime_type",
  bad_request: "InvalidRequest",
  expired: "InvalidJWT",
  bad_signature: "InvalidSignature",
  conflict: "InvalidRequest",
  duplicate: "Duplicate",
  not_empty: "InvalidRequest",
  not_configured: "InternalError",
  unsupported: "NotSupported",
  driver_error: "InternalError",
};

/** Storage's `{ statusCode, error, message }` for anything thrown. */
function apiError(err: unknown): Response {
  if (isIdentityError(err)) {
    // Storage answers a refused token as `InvalidJWT`, a refused key as `Unauthorized`.
    const jwt = err.code === "bad_jwt" || err.code === "jwt_expired";
    const status = jwt ? 400 : 401;
    return Response.json(
      {
        statusCode: String(status),
        error: jwt ? "InvalidJWT" : "Unauthorized",
        message: err.message,
      },
      { status },
    );
  }
  if (isApiError(err)) {
    const status = err.status;
    return Response.json({ statusCode: String(status), error: err.code, message: err.message }, {
      status,
    });
  }
  if (isStorageError(err)) {
    const status = err.code === "expired" || err.code === "bad_signature" ? 400 : err.status;
    return Response.json(
      { statusCode: String(status), error: ERROR_NAMES[err.code], message: err.message },
      { status },
    );
  }
  console.error("[@denext/backend] storage API request failed", err);
  return Response.json(
    { statusCode: "500", error: "InternalError", message: "storage request failed" },
    { status: 500 },
  );
}

const checkCsrf = csrf();

/**
 * Refuse a cross-site write that rides the page's cookies (the Server Actions rule). A request
 * whose identity is not the cookie session — an access token, an API key, a native app's bearer
 * token — is exempt: a cross-site page cannot send those headers without a CORS preflight.
 */
async function guardWrite(request: Request, caller: Caller): Promise<void> {
  if (nativeBearerToken(request) !== undefined) return;
  if ((await caller.identity()).source !== "session") return;
  await checkCsrf({ request, params: {}, ctx: {}, method: request.method as "POST" });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new StorageError("invalid_bucket", "malformed bucket name");
  }
}

/** A JSON body, capped. */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readCappedBody(request, JSON_LIMIT);
  if (bytes === TOO_LARGE) throw new StorageError("too_large", "request body too large");
  if (bytes === STALLED) throw new StorageError("bad_request", "request body stalled");
  if (bytes.byteLength === 0) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* refused below */ }
  throw new StorageError("bad_request", "the body must be a JSON object");
}

/** `user_metadata` from JSON text, capped and checked to be an object. */
function userMetadata(text: string | null): Record<string, unknown> | null {
  if (text === null || text === "") return null;
  if (text.length > METADATA_LIMIT) throw new StorageError("bad_request", "metadata too large");
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* refused below */ }
  throw new StorageError("bad_request", "metadata must be a JSON object");
}

/** `x-metadata`: base64 JSON. */
function headerMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const bin = atob(value);
    return userMetadata(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch (err) {
    if (isStorageError(err)) throw err;
    throw new StorageError("bad_request", "x-metadata must be base64 JSON");
  }
}

/** An upload's body and what came with it (a multipart form, or the raw bytes). */
interface UploadPayload {
  stream: ReadableStream<Uint8Array>;
  size?: number;
  contentType?: string;
  cacheControl: string;
  userMetadata: Record<string, unknown> | null;
}

/** Read an upload request: supabase-js sends a form for a Blob/File, else the raw body. */
async function uploadPayload(request: Request, bucket: ResolvedBucket): Promise<UploadPayload> {
  const type = request.headers.get("content-type") ?? "";
  if (essence(type) === "multipart/form-data") return await formPayload(request, bucket, type);
  const length = request.headers.get("content-length");
  const size = length !== null && /^\d{1,15}$/.test(length) ? Number(length) : undefined;
  if (size !== undefined) capFor(bucket, undefined, size);
  return {
    stream: request.body ?? new Blob([]).stream(),
    size,
    contentType: type || undefined,
    cacheControl: cacheControlOf(request.headers.get("cache-control")),
    userMetadata: headerMetadata(request.headers.get("x-metadata")),
  };
}

/** A form upload: the file part (supabase-js names it `""`), `cacheControl`, `metadata`. */
async function formPayload(
  request: Request,
  bucket: ResolvedBucket,
  type: string,
): Promise<UploadPayload> {
  const bytes = await readCappedBody(request, capFor(bucket) + FORM_OVERHEAD);
  if (bytes === TOO_LARGE) {
    throw new StorageError("too_large", "The object exceeded the maximum allowed size");
  }
  if (bytes === STALLED) throw new StorageError("bad_request", "request body stalled");
  const parts = parseMultipart(bytes, type);
  const file = parts.find((p) => p.filename !== undefined) ?? parts.find((p) => p.name === "");
  if (!file) throw new StorageError("bad_request", "the form has no file");
  const field = (name: string) => {
    const part = parts.find((p) => p !== file && p.name === name);
    return part ? new TextDecoder().decode(part.body) : null;
  };
  return {
    stream: new Blob([file.body as BlobPart]).stream(),
    size: file.body.byteLength,
    contentType: file.contentType || undefined,
    cacheControl: cacheControlOf(field("cacheControl")),
    userMetadata: userMetadata(field("metadata")),
  };
}

const upsertOf = (request: Request) => request.headers.get("x-upsert") === "true";

/** The upload response: `{ Id, Key }`. */
function uploaded(row: ObjectRow): Response {
  return Response.json({ Id: row.id, Key: `${row.bucket_id}/${row.name}` });
}

// ── Serving objects ─────────────────────────────────────────────────────────

/** `Content-Disposition` for a download: `?download[=name]` makes it an attachment. */
function disposition(type: string, key: string, download: string | null): string {
  if (download === null) return dispositionFor(type);
  const name = download || key.slice(key.lastIndexOf("/") + 1);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `Cache-Control` an object is served with: its own, else revalidate. */
const cacheOf = (row: ObjectRow | null) => row?.metadata?.cacheControl ?? "no-cache";

/** Serve an object (Range, conditional GET, HEAD). */
async function serve(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  row: ObjectRow | null,
  request: Request,
  params: URLSearchParams,
): Promise<Response> {
  const info = await rt.driver.head(bucket, key);
  if (!info) throw new StorageError("not_found", "Object not found");
  const type = essence(info.contentType) || "application/octet-stream";
  const headers = objectHeaders(info, cacheOf(row), disposition(type, key, params.get("download")));
  const early = preflight(info, headers, request);
  if (early instanceof Response) return early;
  if (request.method === "HEAD") return objectResponse(info, headers, early.range, null);
  const object = await rt.driver.get(bucket, key, early.range);
  if (!object) throw new StorageError("not_found", "Object not found");
  return objectResponse(info, headers, early.range, object.body);
}

/** A Supabase image transform (`width`, `height`, `resize`, `quality`, `format`). */
export interface ApiTransform {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill";
  quality?: number;
  format?: "origin";
}

/** Read a transform from a query (or a signed token's copy of one). */
export function transformOf(params: URLSearchParams): ApiTransform {
  const int = (name: string) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    if (!/^\d{1,5}$/.test(raw)) throw new StorageError("bad_request", `invalid ${name}`);
    return Number(raw);
  };
  const resize = params.get("resize") ?? undefined;
  if (resize !== undefined && !["cover", "contain", "fill"].includes(resize)) {
    throw new StorageError("bad_request", "resize must be cover, contain or fill");
  }
  const format = params.get("format") ?? undefined;
  if (format !== undefined && format !== "origin") {
    throw new StorageError("bad_request", "format must be origin");
  }
  const out: ApiTransform = {};
  const width = int("width");
  const height = int("height");
  const quality = int("quality");
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (quality !== undefined) out.quality = quality;
  if (resize) out.resize = resize as ApiTransform["resize"];
  if (format) out.format = "origin";
  return out;
}

/** A transform as query parameters (for a token's payload and a render URL). */
function transformParams(t: ApiTransform): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ["width", "height", "resize", "quality", "format"] as const) {
    if (t[name] !== undefined) params.set(name, String(t[name]));
  }
  return params;
}

/**
 * The image pipeline's transform for a Supabase one: a size → `resize` (default `cover`) into
 * it; no size → a format change only, at the source's size.
 */
function imageTransformOf(t: ApiTransform, rt: StorageRuntime): ImageTransform {
  if (!t.width && !t.height) {
    return {
      width: rt.maxTransformDimension,
      quality: t.quality,
      resize: "contain",
      format: "webp",
    };
  }
  return {
    width: t.width || undefined,
    height: t.height || undefined,
    quality: t.quality,
    resize: t.resize ?? "cover",
    format: t.format === "origin" ? "origin" : "webp",
  };
}

/** Serve an image transformed (Supabase's `render/image` routes). */
async function render(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  row: ObjectRow | null,
  transform: ApiTransform,
  request: Request,
  params: URLSearchParams,
): Promise<Response> {
  const object = await rt.driver.get(bucket, key);
  if (!object) throw new StorageError("not_found", "Object not found");
  const bytes = await transformSource(object);
  const download = params.get("download");
  const body = (b: BodyInit) => request.method === "HEAD" ? null : b;
  if (!transform.width && !transform.height && transform.format === "origin") {
    const headers = objectHeaders(
      object,
      cacheOf(row),
      disposition(essence(object.contentType), key, download),
    );
    headers.set("content-length", String(bytes.byteLength));
    return new Response(body(bytes as BodyInit), { headers });
  }
  const out = await transformImageBytes(bytes, imageTransformOf(transform, rt), {
    images: rt.images,
    maxDimension: rt.maxTransformDimension,
    cacheKey: `${bucket}/${key}@${object.etag ?? object.lastModified?.getTime() ?? ""}`,
  });
  if (!out.ok) throw await transformError(out);
  const type = essence(out.headers.get("content-type")!);
  const headers = transformedHeaders(object, out, cacheOf(row), disposition(type, key, download));
  return new Response(body(out.body!), { headers });
}

// ── Routes ──────────────────────────────────────────────────────────────────

type Handler = (ctx: RouteContext, match: RegExpMatchArray) => Promise<Response>;

interface RouteContext {
  rt: StorageRuntime;
  request: Request;
  params: URLSearchParams;
  caller: Caller;
}

const BUCKET_SORT = new Set(["id", "name", "created_at", "updated_at"]);
const OBJECT_SORT = new Set(["name", "updated_at", "created_at", "last_accessed_at"]);

/** A bucket row as Storage answers it. */
function bucketJson(row: BucketRow) {
  return { ...row, type: "STANDARD" };
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new StorageError("bad_request", "invalid number");
  return Math.min(n, max);
}

const listBucketsRoute: Handler = async ({ rt, params, caller }) => {
  const column = params.get("sortColumn") ?? "name";
  const order = params.get("sortOrder") ?? "asc";
  if (!BUCKET_SORT.has(column) || !["asc", "desc"].includes(order)) {
    throw new StorageError("bad_request", "invalid sort");
  }
  const rows = await listBuckets(rt, {
    limit: params.has("limit") ? boundedInt(params.get("limit"), 100, 1000) : undefined,
    offset: boundedInt(params.get("offset"), 0, Number.MAX_SAFE_INTEGER),
    search: params.get("search") ?? undefined,
    column: column as "name",
    order: order as "asc",
  }, caller);
  return Response.json(rows.map(bucketJson));
};

/** A bucket body's settings (`public`, `file_size_limit`, `allowed_mime_types`). */
function settingsOf(body: Record<string, unknown>) {
  return {
    public: typeof body.public === "boolean" ? body.public : undefined,
    fileSizeLimit: body.file_size_limit as number | string | null | undefined,
    allowedMimeTypes: body.allowed_mime_types as string[] | null | undefined,
  };
}

const createBucketRoute: Handler = async ({ rt, request, caller }) => {
  const body = await jsonBody(request);
  const id = typeof body.id === "string" ? body.id : body.name;
  if (typeof id !== "string") throw new StorageError("bad_request", "a bucket id is required");
  await createBucket(rt, id, settingsOf(body), caller);
  return Response.json({ name: id });
};

const bucketRoute: Handler = async ({ rt, request, caller }, m) => {
  const id = decodeSegment(m[1]);
  switch (request.method) {
    case "GET":
      return Response.json(bucketJson(await getBucket(rt, id, caller)));
    case "PUT":
      await updateBucket(rt, id, settingsOf(await jsonBody(request)), caller);
      return Response.json({ message: "Successfully updated" });
    case "DELETE":
      await deleteBucket(rt, id, caller);
      return Response.json({ message: "Successfully deleted" });
  }
  return methodNotAllowed("GET, PUT, DELETE");
};

const emptyBucketRoute: Handler = async ({ rt, caller }, m) => {
  await emptyBucket(rt, decodeSegment(m[1]), caller);
  return Response.json({ message: "Successfully emptied" });
};

/** A listing body (`prefix`, `search`, `limit`, `offset`, `sortBy`), validated. */
function listQueryOf(body: Record<string, unknown>): ListQuery {
  const sortBy = (body.sortBy ?? {}) as { column?: string; order?: string };
  const column = sortBy.column ?? "name";
  const order = (sortBy.order ?? "asc").toLowerCase();
  if (!OBJECT_SORT.has(column) || (order !== "asc" && order !== "desc")) {
    throw new StorageError("bad_request", "invalid sortBy");
  }
  const raw = typeof body.prefix === "string" ? body.prefix.replace(/^\/+/, "") : "";
  const prefix = raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
  if (prefix) normalizeKey(prefix.slice(0, -1));
  return {
    prefix,
    search: typeof body.search === "string" ? body.search : "",
    limit: boundedInt(body.limit, 100, 1000),
    offset: boundedInt(body.offset, 0, Number.MAX_SAFE_INTEGER),
    column: column as SortColumn,
    order,
  };
}

const listRoute: Handler = async ({ rt, request, caller }, m) => {
  const bucket = await resolveBucket(rt, decodeSegment(m[1]));
  const query = listQueryOf(await jsonBody(request));
  return Response.json(await listEntries(rt, bucket, query, caller));
};

/** A move or copy body. */
function transferOf(body: Record<string, unknown>) {
  const { bucketId, sourceKey, destinationKey, destinationBucket } = body;
  if (
    typeof bucketId !== "string" || typeof sourceKey !== "string" ||
    typeof destinationKey !== "string"
  ) {
    throw new StorageError("bad_request", "bucketId, sourceKey and destinationKey are required");
  }
  const to = typeof destinationBucket === "string" && destinationBucket
    ? destinationBucket
    : bucketId;
  return { from: { bucket: bucketId, key: sourceKey }, to: { bucket: to, key: destinationKey } };
}

const moveRoute: Handler = async ({ rt, request, caller }) => {
  await moveObject(rt, transferOf(await jsonBody(request)), caller);
  return Response.json({ message: "Successfully moved" });
};

const copyRoute: Handler = async ({ rt, request, caller }) => {
  const row = await copyObject(rt, transferOf(await jsonBody(request)), upsertOf(request), caller);
  return uploaded(row);
};

const removeManyRoute: Handler = async ({ rt, request, caller }, m) => {
  const bucket = await resolveBucket(rt, decodeSegment(m[1]));
  const body = await jsonBody(request);
  if (!Array.isArray(body.prefixes) || body.prefixes.length > MAX_BATCH) {
    throw new StorageError("bad_request", `prefixes must be a list of at most ${MAX_BATCH} paths`);
  }
  const keys = body.prefixes.map((p) => {
    const path = typeof p === "string" ? p : (p as { path?: unknown })?.path;
    if (typeof path !== "string") throw new StorageError("bad_request", "invalid path");
    return normalizeKey(path.replace(/^\/+/, ""));
  });
  return Response.json(await removeObjects(rt, bucket, keys, caller));
};

/** A signed download token's payload. */
interface DownloadToken {
  exp: number;
  b: string;
  k: string;
  t?: string;
}

/** The token-bearing path of a signed download (the key unencoded, as Storage returns it). */
async function signedPath(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  expiresIn: unknown,
  transform: ApiTransform | undefined,
): Promise<string> {
  const seconds = clampExpiry(Number(expiresIn), 3600);
  const t = transform && Object.keys(transform).length
    ? transformParams(transform).toString()
    : undefined;
  const token = await sealToken("dl", {
    exp: nowSeconds() + seconds,
    b: bucket,
    k: key,
    ...(t ? { t } : {}),
  }, secretsOf(rt));
  return `${t ? "/render/image/sign" : "/object/sign"}/${bucket}/${key}?token=${token}`;
}

/** Whether the caller may read `key` and it exists (for signing). */
async function signable(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  caller: Caller,
): Promise<void> {
  const row = await readableRow(rt, bucket, key, caller);
  if (!row?.metadata && !(await rt.driver.head(bucket.name, key))) {
    throw new StorageError("not_found", "Object not found");
  }
}

const signManyRoute: Handler = async ({ rt, request, caller }, m) => {
  const bucket = await resolveBucket(rt, decodeSegment(m[1]));
  const body = await jsonBody(request);
  if (!Array.isArray(body.paths) || body.paths.length > MAX_BATCH) {
    throw new StorageError("bad_request", `paths must be a list of at most ${MAX_BATCH} paths`);
  }
  const out = [];
  for (const path of body.paths) {
    try {
      if (typeof path !== "string") throw new StorageError("bad_request", "invalid path");
      const key = normalizeKey(path.replace(/^\/+/, ""));
      await signable(rt, bucket, key, caller);
      out.push({
        error: null,
        path,
        signedURL: await signedPath(rt, bucket.name, key, body.expiresIn, undefined),
      });
    } catch (err) {
      if (!isStorageError(err)) throw err;
      out.push({
        error: "Either the object does not exist or you do not have access to it",
        path: typeof path === "string" ? path : null,
        signedURL: null,
      });
    }
  }
  return Response.json(out);
};

const signRoute: Handler = async (ctx, m) => {
  const { rt, request, params, caller } = ctx;
  const { bucket: name, key } = bucketAndKey(m[1]);
  if (request.method === "POST") {
    const bucket = await resolveBucket(rt, name);
    const body = await jsonBody(request);
    await signable(rt, bucket, key, caller);
    const transform = body.transform && typeof body.transform === "object"
      ? transformOf(transformParams(body.transform as ApiTransform))
      : undefined;
    return Response.json({
      signedURL: await signedPath(rt, bucket.name, key, body.expiresIn, transform),
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD, POST");
  }
  const token = await openDownload(rt, params, name, key);
  return await serve(
    rt,
    token.b,
    token.k,
    await rt.meta.getObject(token.b, token.k, { kind: "service" }),
    request,
    params,
  );
};

async function openDownload(
  rt: StorageRuntime,
  params: URLSearchParams,
  bucket: string,
  key: string,
): Promise<DownloadToken> {
  const token = await openToken<DownloadToken>("dl", params.get("token"), secretsOf(rt));
  if (token.b !== bucket || token.k !== key) {
    throw new StorageError("bad_signature", "the token is for another object");
  }
  return token;
}

/** A signed upload token's payload. */
interface UploadToken {
  exp: number;
  b: string;
  k: string;
  u: boolean;
  o: string | null;
}

const signedUploadRoute: Handler = async ({ rt, request, params, caller }, m) => {
  const { bucket: name, key } = bucketAndKey(m[1]);
  const bucket = await resolveBucket(rt, name);
  if (request.method === "POST") {
    const upsert = upsertOf(request);
    await authorizeOp(rt, bucket, "upload", key, caller);
    if (!upsert && await rt.meta.getObject(bucket.name, key, { kind: "service" })) {
      throw new StorageError("duplicate", "The resource already exists");
    }
    const identity = await caller.identity();
    const owner = identity.role === "authenticated" ? identity.userId ?? null : null;
    await rt.meta.checkWrite(
      {
        bucket_id: bucket.name,
        name: key,
        owner_id: owner,
        version: crypto.randomUUID(),
        metadata: null,
        user_metadata: null,
      },
      upsert,
      await actorFor(rt, caller),
    );
    const token = await sealToken("ul", {
      exp: nowSeconds() + SIGNED_UPLOAD_EXPIRY,
      b: bucket.name,
      k: key,
      u: upsert,
      o: owner,
    }, secretsOf(rt));
    return Response.json({
      url: `/object/upload/sign/${bucket.name}/${key}?token=${token}`,
      token,
    });
  }
  if (request.method !== "PUT") return methodNotAllowed("POST, PUT");
  const token = await openToken<UploadToken>("ul", params.get("token"), secretsOf(rt));
  if (token.b !== bucket.name || token.k !== key) {
    throw new StorageError("bad_signature", "the token is for another object");
  }
  const payload = await uploadPayload(request, bucket);
  const row = await putObject(rt, bucket, key, payload.stream, {
    ...payload,
    upsert: token.u,
    owner: token.o,
  }, SERVICE_CALLER);
  return uploaded(row);
};

/** The `info` answer (supabase-js camelizes it). */
function infoJson(row: ObjectRow) {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    bucket_id: row.bucket_id,
    size: row.metadata?.size,
    content_type: row.metadata?.mimetype,
    cache_control: row.metadata?.cacheControl,
    etag: row.metadata?.eTag,
    metadata: row.user_metadata ?? {},
    last_modified: row.updated_at,
    created_at: row.created_at,
  };
}

/**
 * The object a `public` / `authenticated` route names, and its row: a `public` route answers only
 * for a public bucket (and needs no caller); otherwise the caller must be allowed to read it.
 */
async function scopedObject(ctx: RouteContext, scope: string, path: string) {
  const { bucket: name, key } = bucketAndKey(path);
  const bucket = await resolveBucket(ctx.rt, name);
  const isPublic = scope === "public";
  if (isPublic && !bucket.public) throw new StorageError("not_found", "Object not found");
  const row = await readableRow(ctx.rt, bucket, key, isPublic ? SERVICE_CALLER : ctx.caller);
  return { bucket, key, row };
}

const infoRoute: Handler = async (ctx, m) => {
  const { row } = await scopedObject(ctx, m[1], m[2]);
  if (!row?.metadata) throw new StorageError("not_found", "Object not found");
  return Response.json(infoJson(row));
};

const publicObjectRoute: Handler = async (ctx, m) => {
  const { bucket, key, row } = await scopedObject(ctx, m[1], m[2]);
  return await serve(ctx.rt, bucket.name, key, row, ctx.request, ctx.params);
};

const objectRoute: Handler = async (ctx, m) => {
  const { rt, request, params, caller } = ctx;
  const { bucket: name, key } = bucketAndKey(m[1]);
  const bucket = await resolveBucket(rt, name);
  switch (request.method) {
    case "GET":
    case "HEAD":
      return await serve(
        rt,
        bucket.name,
        key,
        await readableRow(rt, bucket, key, caller),
        request,
        params,
      );
    case "POST":
    case "PUT": {
      const payload = await uploadPayload(request, bucket);
      const upsert = request.method === "PUT" || upsertOf(request);
      return uploaded(
        await putObject(rt, bucket, key, payload.stream, { ...payload, upsert }, caller),
      );
    }
    case "DELETE": {
      const rows = await removeObjects(rt, bucket, [key], caller);
      if (!rows.length) throw new StorageError("not_found", "Object not found");
      return Response.json({ message: "Successfully deleted" });
    }
  }
  return methodNotAllowed("GET, HEAD, POST, PUT, DELETE");
};

const renderRoute: Handler = async ({ rt, request, params, caller }, m) => {
  const scope = m[1];
  const { bucket: name, key } = bucketAndKey(m[2]);
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const bucket = await resolveBucket(rt, name);
  if (scope === "sign") {
    const token = await openDownload(rt, params, bucket.name, key);
    if (!token.t) throw new StorageError("bad_signature", "the token carries no transform");
    const row = await rt.meta.getObject(bucket.name, key, { kind: "service" });
    return await render(
      rt,
      bucket.name,
      key,
      row,
      transformOf(new URLSearchParams(token.t)),
      request,
      params,
    );
  }
  if (scope === "public" && !bucket.public) throw new StorageError("not_found", "Object not found");
  const row = await readableRow(rt, bucket, key, scope === "public" ? SERVICE_CALLER : caller);
  return await render(rt, bucket.name, key, row, transformOf(params), request, params);
};

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { statusCode: "405", error: "MethodNotAllowed", message: "method not allowed" },
    { status: 405, headers: { allow } },
  );
}

/** The routes, in match order: [methods, pattern, handler]. */
const ROUTES: [Set<string>, RegExp, Handler][] = [
  [new Set(["GET"]), /^\/bucket\/?$/, listBucketsRoute],
  [new Set(["POST"]), /^\/bucket\/?$/, createBucketRoute],
  [new Set(["POST"]), /^\/bucket\/([^/]+)\/empty\/?$/, emptyBucketRoute],
  [new Set(["GET", "PUT", "DELETE"]), /^\/bucket\/([^/]+)\/?$/, bucketRoute],
  [new Set(["POST"]), /^\/object\/list\/([^/]+)\/?$/, listRoute],
  [new Set(["POST"]), /^\/object\/move\/?$/, moveRoute],
  [new Set(["POST"]), /^\/object\/copy\/?$/, copyRoute],
  [new Set(["POST"]), /^\/object\/sign\/([^/]+)\/?$/, signManyRoute],
  [new Set(["POST", "GET", "HEAD"]), /^\/object\/sign\/(.+)$/, signRoute],
  [new Set(["POST", "PUT"]), /^\/object\/upload\/sign\/(.+)$/, signedUploadRoute],
  [new Set(["GET"]), /^\/object\/info\/(public|authenticated)\/(.+)$/, infoRoute],
  [new Set(["GET"]), /^\/object\/info\/()(.+)$/, infoRoute],
  [new Set(["GET", "HEAD"]), /^\/object\/(public|authenticated)\/(.+)$/, publicObjectRoute],
  [new Set(["DELETE"]), /^\/object\/([^/]+)\/?$/, removeManyRoute],
  [new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]), /^\/object\/(.+)$/, objectRoute],
  [new Set(["GET", "HEAD"]), /^\/render\/image\/(public|authenticated|sign)\/(.+)$/, renderRoute],
];

/**
 * The Storage API handler (registered by the plugin when `storage.api` is on). Answers only
 * paths under the API's base; everything else passes (`null`).
 *
 * @param rt The runtime.
 * @param request The request (app-relative).
 * @returns The response, or `null`.
 */
export async function handleStorageApi(
  rt: StorageRuntime,
  request: Request,
): Promise<Response | null> {
  if (!rt.apiBase) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith(rt.apiBase + "/")) return null;
  const sub = url.pathname.slice(rt.apiBase.length);
  try {
    if (sub === "/upload/resumable" || sub.startsWith("/upload/resumable/")) {
      return await handleResumable(
        rt,
        request,
        sub.slice("/upload/resumable".length),
        new Caller(false, request),
      );
    }
    const caller = new Caller(false, request);
    if (request.method !== "GET" && request.method !== "HEAD") await guardWrite(request, caller);
    const ctx: RouteContext = { rt, request, params: url.searchParams, caller };
    for (const [methods, pattern, handler] of ROUTES) {
      const match = sub.match(pattern);
      if (match && methods.has(request.method)) return await handler(ctx, match);
    }
    return Response.json(
      { statusCode: "404", error: "not_found", message: "no such storage endpoint" },
      { status: 404 },
    );
  } catch (err) {
    return apiError(err);
  }
}
