// TUS 1.0.0 resumable uploads at `/storage/v1/upload/resumable`, as Supabase serves them (what
// `tus-js-client` and Uppy talk to): creation (and creation-with-upload), PATCH, HEAD,
// termination and expiration. `Upload-Metadata` names the object (`bucketName`, `objectName`,
// `contentType`, `cacheControl`, `metadata`); `x-upsert: true` replaces an existing one.
//
// The upload is authorized when it is created (the bucket's `authorize`, the SQL-RLS policies)
// and bound to its creator; its size cap and allow-list are checked then, and the bytes are
// sniffed and measured again when it completes. Progress lives in the metadata store, so any
// replica can take the next PATCH (a lease keeps two PATCHes off the same upload).
//
// On a driver with multipart (S3) the bytes become parts of a multipart upload on the final key
// as they arrive (a remainder below S3's 5 MiB minimum waits as a tail object); elsewhere each
// PATCH is a chunk object, concatenated through the usual checks at the end. Both live under the
// internal `.denext-tus` namespace, which no bucket name can reach. An upload by a request's user
// under SQL-RLS, or one pinned by its signed token, is assembled in the staging namespace instead
// and lands with its row, written as the caller when the last byte is in (`commitStaged`): the
// creation's policy check was only a dry run, up to a day earlier.

import { StorageError } from "./errors.ts";
import { isIdentityError } from "./identity.ts";
import { normalizeKey } from "./keys.ts";
import { checkSniffed, essence, SNIFF_BYTES } from "./mime.ts";
import { resolveBucket, type ResolvedBucket, secretsOf, type StorageRuntime } from "./runtime.ts";
import { openToken } from "./signing.ts";
import {
  commitStaged,
  type Location,
  prepareOverwrite,
  stagesWrite,
  stagingLocation,
} from "./storage-versions.ts";
import type { ResumableRow } from "./storage-meta.ts";
import {
  actorFor,
  authorizeOp,
  cacheControlOf,
  type Caller,
  capFor,
  checkContentType,
  metadataOf,
  recordObject,
  releaseObject,
  reserveObject,
  SERVICE_CALLER,
  storeChecked,
} from "./storage-ops.ts";
import { concat, limit, readAll } from "./streams.ts";
import type { ObjectInfo } from "./types.ts";

/** The TUS version spoken. */
const TUS_VERSION = "1.0.0";
/** How long an upload may take, from its creation (Supabase's: 24 hours). */
const UPLOAD_TTL = 24 * 3600 * 1000;
/** How long a PATCH holds its upload. */
const LEASE_MS = 5 * 60 * 1000;
/** The internal namespace for tails and chunks (a bucket name never starts with `.`). */
const TUS_NAMESPACE = ".denext-tus";
/** Expired uploads cleaned up per creation. */
const SWEEP = 10;

/** Headers every TUS answer carries. */
function tusHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "tus-resumable": TUS_VERSION, "cache-control": "no-store", ...extra });
}

/** A TUS error: the storage shape, with the TUS headers. */
function tusError(status: number, error: string, message: string): Response {
  return Response.json({ statusCode: String(status), error, message }, {
    status,
    headers: tusHeaders(),
  });
}

/** Parse `Upload-Metadata`: `key base64,key base64`. */
export function parseUploadMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(",")) {
    const [key, value = ""] = pair.trim().split(/\s+/, 2);
    if (!key) continue;
    if (!/^[A-Za-z0-9+/=]*$/.test(value)) {
      throw new StorageError("bad_request", "Upload-Metadata values must be base64");
    }
    try {
      out[key] = new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    } catch {
      throw new StorageError("bad_request", "Upload-Metadata values must be base64");
    }
  }
  return out;
}

/** A non-negative integer header, or `undefined` when absent. */
function intHeader(request: Request, name: string): number | undefined {
  const raw = request.headers.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new StorageError("bad_request", `invalid ${name}`);
  return Number(raw);
}

function expiresHeader(row: ResumableRow): string {
  return new Date(row.expires_at).toUTCString();
}

/**
 * The TUS endpoint. `rest` is the path below `/upload/resumable` (`""` or `/<id>`).
 *
 * @param rt The runtime.
 * @param request The request.
 * @param rest The path below the endpoint.
 * @param caller Who is asking.
 * @returns The response.
 */
export async function handleResumable(
  rt: StorageRuntime,
  request: Request,
  rest: string,
  caller: Caller,
): Promise<Response> {
  try {
    return await route(rt, request, rest, caller);
  } catch (err) {
    if (isIdentityError(err)) return tusError(401, "Unauthorized", err.message);
    if (err instanceof StorageError) {
      const status = err.code === "expired" || err.code === "bad_signature" ? 400 : err.status;
      return tusError(status, err.code, err.message);
    }
    console.error("[@denext/backend] resumable upload failed", err);
    return tusError(500, "InternalError", "resumable upload failed");
  }
}

async function route(
  rt: StorageRuntime,
  request: Request,
  rest: string,
  caller: Caller,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: tusHeaders({
        "tus-version": TUS_VERSION,
        "tus-extension": "creation,creation-with-upload,termination,expiration",
      }),
    });
  }
  if (request.headers.get("tus-resumable") !== TUS_VERSION) {
    return tusError(412, "InvalidRequest", "Tus-Resumable 1.0.0 is required");
  }
  // `/sign`: the upload is authorized by a signed upload token (`x-signature`), not the caller.
  let signed: SignedUpload | undefined;
  if (rest === "/sign" || rest.startsWith("/sign/")) {
    signed = await openToken<SignedUpload>("ul", request.headers.get("x-signature"), secretsOf(rt));
    rest = rest.slice("/sign".length);
    caller = SERVICE_CALLER;
  }
  if (rest !== "" && rest !== "/") {
    return await existing(rt, request, rest.slice(1), caller, signed);
  }
  if (request.method !== "POST") return tusError(405, "MethodNotAllowed", "use POST");
  return await create(rt, request, caller, signed);
}

/** A signed upload token's payload (`createSignedUploadUrl`). */
interface SignedUpload {
  exp: number;
  b: string;
  k: string;
  u: boolean;
  o: string | null;
  /** Pinned: the version the object had when a policy-checked upsert was signed (`null`: none). */
  cv?: string | null;
}

/** A signed upload's token names exactly this object. */
function checkSigned(signed: SignedUpload | undefined, bucket: string, key: string): void {
  if (signed && (signed.b !== bucket || signed.k !== key)) {
    throw new StorageError("bad_signature", "the token is for another object");
  }
}

/** HEAD, PATCH or DELETE an upload in progress. */
async function existing(
  rt: StorageRuntime,
  request: Request,
  id: string,
  caller: Caller,
  signed?: SignedUpload,
): Promise<Response> {
  const row = /^[A-Za-z0-9_-]{16,64}$/.test(id) ? await rt.meta.getResumable(id) : null;
  if (!row) return tusError(404, "not_found", "Upload not found");
  checkSigned(signed, row.bucket_id, row.name);
  if (row.expires_at < Date.now()) {
    await discard(rt, row);
    return tusError(410, "Gone", "Upload expired");
  }
  await checkOwner(row, caller);
  switch (request.method) {
    case "HEAD":
      return new Response(null, {
        status: 200,
        headers: tusHeaders({
          "upload-offset": String(row.upload_offset),
          "upload-length": String(row.upload_length),
          "upload-expires": expiresHeader(row),
        }),
      });
    case "PATCH":
      return await patch(rt, request, row, caller);
    case "DELETE":
      await discard(rt, row);
      return new Response(null, { status: 204, headers: tusHeaders() });
  }
  return tusError(405, "MethodNotAllowed", "use HEAD, PATCH or DELETE");
}

/** Only the upload's creator (or the service role) may continue it. */
async function checkOwner(row: ResumableRow, caller: Caller): Promise<void> {
  if (await caller.isService()) return;
  const identity = await caller.identity();
  const who = identity.role === "authenticated" ? identity.userId ?? null : null;
  if (row.owner_id !== who) {
    throw new StorageError("forbidden", "this upload belongs to someone else");
  }
}

/** A creation request, checked: what the upload is, and who may make it. */
interface Creation {
  bucket: ResolvedBucket;
  key: string;
  length: number;
  contentType: string;
  cacheControl: string;
  userMetadata: Record<string, unknown> | null;
  upsert: boolean;
  owner: string | null;
  /** The version the object must still have when the upload completes (a pinned token's). */
  expect?: string | null;
}

/** Read and check a creation: the headers, the bucket's rules, the caller's right. */
async function creationOf(
  rt: StorageRuntime,
  request: Request,
  caller: Caller,
  signed?: SignedUpload,
): Promise<Creation> {
  if (request.headers.has("upload-defer-length")) {
    throw new StorageError("bad_request", "Upload-Defer-Length is not supported");
  }
  const length = intHeader(request, "upload-length");
  if (length === undefined) throw new StorageError("bad_request", "Upload-Length is required");
  const meta = parseUploadMetadata(request.headers.get("upload-metadata"));
  if (!meta.bucketName || !meta.objectName) {
    throw new StorageError("bad_request", "Upload-Metadata needs bucketName and objectName");
  }
  const bucket = await resolveBucket(rt, meta.bucketName);
  const key = normalizeKey(meta.objectName.replace(/^\/+/, ""));
  checkSigned(signed, bucket.name, key);
  await authorizeOp(rt, bucket, "upload", key, caller);
  const contentType = checkContentType(bucket, meta.contentType || "application/octet-stream");
  capFor(bucket, undefined, length);
  const identity = await caller.identity();
  return {
    bucket,
    key,
    length,
    contentType,
    cacheControl: cacheControlOf(meta.cacheControl || null),
    userMetadata: meta.metadata ? parseJsonObject(meta.metadata) : null,
    upsert: signed ? signed.u : request.headers.get("x-upsert") === "true",
    owner: signed ? signed.o : identity.role === "authenticated" ? identity.userId ?? null : null,
    ...(signed?.cv !== undefined ? { expect: signed.cv } : {}),
  };
}

/**
 * Where an upload's bytes are assembled: the object's key, or — a staged upload — its staging
 * place, moved to the key only by the authorized write of its row.
 */
function bytesAt(row: Pick<ResumableRow, "bucket_id" | "name" | "version" | "staged">): Location {
  return row.staged
    ? stagingLocation(row.bucket_id, row.version)
    : { bucket: row.bucket_id, key: row.name };
}

/** A new upload's state (an empty one is stored as a zero chunk: S3 has no empty part). */
async function newUpload(
  rt: StorageRuntime,
  c: Creation,
  version: string,
  staged: boolean,
): Promise<ResumableRow> {
  const at = bytesAt({ bucket_id: c.bucket.name, name: c.key, version, staged });
  const uploadId = rt.driver.direct && c.length > 0
    ? await rt.driver.direct.createMultipart(at.bucket, at.key, c.contentType)
    : null;
  return {
    id: crypto.randomUUID().replaceAll("-", "") + randomTail(),
    bucket_id: c.bucket.name,
    name: c.key,
    upload_length: c.length,
    upload_offset: 0,
    content_type: c.contentType,
    cache_control: c.cacheControl,
    user_metadata: c.userMetadata,
    owner_id: c.owner,
    upsert: c.upsert,
    upload_id: uploadId,
    parts: [],
    tail_size: 0,
    chunks: [],
    version,
    ...(staged ? { staged: true } : {}),
    ...(c.expect !== undefined ? { expect: c.expect } : {}),
    expires_at: Date.now() + UPLOAD_TTL,
    lease: null,
    lease_until: null,
  };
}

/** POST: create an upload (and take its first bytes, creation-with-upload). */
async function create(
  rt: StorageRuntime,
  request: Request,
  caller: Caller,
  signed?: SignedUpload,
): Promise<Response> {
  sweep(rt);
  const c = await creationOf(rt, request, caller, signed);
  const reservation = { upsert: c.upsert, owner: c.owner, userMetadata: c.userMetadata };
  const actor = await actorFor(rt, caller);
  const version = await reserveObject(rt, c.bucket, c.key, reservation, actor);
  const staged = stagesWrite(actor, c.expect);
  let row: ResumableRow | undefined;
  try {
    row = await newUpload(rt, c, version, staged);
    await rt.meta.createResumable(row);
    const location = `${rt.basePath}${rt.apiBase}/upload/resumable${
      signed ? "/sign" : ""
    }/${row.id}`;
    const headers = tusHeaders({ location, "upload-expires": expiresHeader(row) });
    const type = request.headers.get("content-type") ?? "";
    if (c.length === 0 || (request.body && essence(type) === "application/offset+octet-stream")) {
      const after = await receive(rt, request, row, c.bucket, caller);
      headers.set("upload-offset", String(after.upload_offset));
    }
    return new Response(null, { status: 201, headers });
  } catch (err) {
    // The client never got a Location to resume from: nothing of this upload is kept.
    const current = row ? await rt.meta.getResumable(row.id).catch(() => null) : null;
    if (current) await discard(rt, current);
    else await abandon(rt, c, version, row?.upload_id ?? null, staged);
    throw err;
  }
}

/** Undo a creation that failed before its state was stored. */
async function abandon(
  rt: StorageRuntime,
  c: Creation,
  version: string,
  uploadId: string | null,
  staged: boolean,
) {
  if (uploadId) {
    const at = bytesAt({ bucket_id: c.bucket.name, name: c.key, version, staged });
    await rt.driver.direct?.abortMultipart(at.bucket, at.key, uploadId).catch(() => {});
  }
  if (!c.upsert) await releaseObject(rt, c.bucket.name, c.key, version);
}

function randomTail(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* refused below */ }
  throw new StorageError("bad_request", "metadata must be a JSON object");
}

/** PATCH: append bytes at the upload's offset. */
async function patch(
  rt: StorageRuntime,
  request: Request,
  row: ResumableRow,
  caller: Caller,
): Promise<Response> {
  if (essence(request.headers.get("content-type") ?? "") !== "application/offset+octet-stream") {
    return tusError(
      415,
      "invalid_mime_type",
      "Content-Type must be application/offset+octet-stream",
    );
  }
  const offset = intHeader(request, "upload-offset");
  if (offset === undefined) throw new StorageError("bad_request", "Upload-Offset is required");
  if (offset !== row.upload_offset) {
    return tusError(409, "Conflict", `Upload-Offset is ${row.upload_offset}`);
  }
  const bucket = await resolveBucket(rt, row.bucket_id);
  const after = await receive(rt, request, row, bucket, caller);
  return new Response(null, {
    status: 204,
    headers: tusHeaders({
      "upload-offset": String(after.upload_offset),
      "upload-expires": expiresHeader(after),
    }),
  });
}

/** Take the lease, store the request's bytes, save progress; complete when the last byte is in. */
async function receive(
  rt: StorageRuntime,
  request: Request,
  row: ResumableRow,
  bucket: ResolvedBucket,
  caller: Caller,
): Promise<ResumableRow> {
  const remaining = row.upload_length - row.upload_offset;
  const declared = intHeader(request, "content-length");
  if (declared !== undefined && declared > remaining) {
    throw new StorageError("too_large", "the body runs past Upload-Length");
  }
  const lease = crypto.randomUUID();
  if (!(await rt.meta.leaseResumable(row.id, row.upload_offset, lease, Date.now() + LEASE_MS))) {
    throw new StorageError("conflict", "another request is writing this upload");
  }
  let next = row;
  try {
    const body = limit(request.body ?? new Blob([]).stream(), remaining);
    next = row.upload_id ? await receiveParts(rt, row, body) : await receiveChunk(rt, row, body);
    if (next.upload_offset === next.upload_length) {
      await complete(rt, next, bucket, caller);
      return next;
    }
  } finally {
    if (next.upload_offset !== next.upload_length) await rt.meta.saveResumable(next);
  }
  return next;
}

/** A driver without multipart: the PATCH's bytes as one chunk object (all or nothing). */
async function receiveChunk(
  rt: StorageRuntime,
  row: ResumableRow,
  body: ReadableStream<Uint8Array>,
): Promise<ResumableRow> {
  const key = `${row.id}/${row.upload_offset}`;
  const info = await rt.driver.put(TUS_NAMESPACE, key, body, {
    contentType: "application/octet-stream",
  });
  if (info.size === 0) {
    await rt.driver.remove(TUS_NAMESPACE, key);
    return row;
  }
  return {
    ...row,
    upload_offset: row.upload_offset + info.size,
    chunks: [...row.chunks, { offset: row.upload_offset, size: info.size }],
  };
}

/** The bytes held back from earlier PATCHes (S3), to lead the next part. */
async function loadTail(rt: StorageRuntime, row: ResumableRow): Promise<Uint8Array[]> {
  if (row.tail_size === 0) return [];
  const tail = await rt.driver.get(TUS_NAMESPACE, `${row.id}/tail`);
  if (!tail) throw new StorageError("driver_error", "the upload's tail is missing");
  return [await readAll(tail.body, row.tail_size)];
}

/** The next chunk of a PATCH body, or `null` at its end — or when the client dropped it. */
async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
  try {
    const next = await reader.read();
    return next.done ? null : next.value;
  } catch (err) {
    if (err instanceof StorageError) throw err; // the size cap
    return null; // an interrupted PATCH keeps the bytes that arrived
  }
}

/** Keep what did not become a part as the tail object (or drop an old tail). */
async function saveTail(
  rt: StorageRuntime,
  row: ResumableRow,
  pending: Uint8Array,
): Promise<number> {
  const key = `${row.id}/tail`;
  if (pending.byteLength > 0) {
    await rt.driver.put(TUS_NAMESPACE, key, new Blob([pending as BlobPart]).stream(), {
      contentType: "application/octet-stream",
      size: pending.byteLength,
    });
  } else if (row.tail_size > 0) {
    await rt.driver.remove(TUS_NAMESPACE, key);
  }
  return pending.byteLength;
}

/** S3: the bytes become parts as they arrive; a short remainder waits as the tail object. */
async function receiveParts(
  rt: StorageRuntime,
  row: ResumableRow,
  body: ReadableStream<Uint8Array>,
): Promise<ResumableRow> {
  const pending = await loadTail(rt, row);
  let pendingSize = row.tail_size;
  let state = { ...row, parts: [...row.parts] };
  // A part is dropped from `pending` only once the store has it, so a failed part upload leaves
  // the saved state (offset, tail) as it was and the client resends from there.
  const flush = async () => {
    const partNumber = state.parts.length + 1;
    const etag = await uploadPart(rt, state, partNumber, concat(pending, pendingSize));
    pending.length = 0;
    pendingSize = 0;
    state = { ...state, parts: [...state.parts, { partNumber, etag }] };
  };
  let received = 0;
  const reader = body.getReader();
  for (let chunk = await nextChunk(reader); chunk; chunk = await nextChunk(reader)) {
    pending.push(chunk);
    pendingSize += chunk.byteLength;
    received += chunk.byteLength;
    if (pendingSize >= rt.partSize) await flush();
  }
  state = { ...state, upload_offset: row.upload_offset + received };
  if (state.upload_offset === state.upload_length) {
    if (pendingSize > 0 || state.parts.length === 0) await flush();
    if (row.tail_size > 0) await rt.driver.remove(TUS_NAMESPACE, `${row.id}/tail`);
    return state;
  }
  return { ...state, tail_size: await saveTail(rt, row, concat(pending, pendingSize)) };
}

/** Upload one part from the server: the driver's own call, else its presigned URL. */
async function uploadPart(
  rt: StorageRuntime,
  row: ResumableRow,
  partNumber: number,
  bytes: Uint8Array,
): Promise<string> {
  const direct = rt.driver.direct!;
  const at = bytesAt(row);
  if (direct.uploadPart) {
    return await direct.uploadPart(at.bucket, at.key, row.upload_id!, partNumber, bytes);
  }
  const url = await direct.presignPart(at.bucket, at.key, row.upload_id!, partNumber, 900);
  const res = await fetch(url, { method: "PUT", body: bytes as BodyInit });
  await res.body?.cancel();
  if (!res.ok) throw new StorageError("driver_error", `part upload failed: HTTP ${res.status}`);
  return res.headers.get("etag") ?? "";
}

/** The last byte is in: assemble, check (size, type, sniffed head), record the row. */
async function complete(
  rt: StorageRuntime,
  row: ResumableRow,
  bucket: ResolvedBucket,
  caller: Caller,
) {
  const reservation = { upsert: row.upsert, owner: row.owner_id, userMetadata: row.user_metadata };
  if (row.staged) return await completeStaged(rt, row, bucket, caller);
  // A versioned bucket keeps the current version's bytes before the assembly replaces them.
  const undo = await prepareOverwrite(rt, bucket, row.name);
  let info: ObjectInfo;
  try {
    info = row.upload_id
      ? await assembleParts(rt, row, bucket)
      : await assembleChunks(rt, row, bucket);
  } catch (err) {
    await undo();
    await discard(rt, row);
    throw err;
  }
  await rt.meta.deleteResumable(row.id);
  await recordObject(
    rt,
    row.bucket_id,
    row.name,
    row.version,
    reservation,
    metadataOf(info, row.cache_control),
  );
}

/**
 * A staged upload's last byte is in: assembled in its staging place, then landed with its row,
 * written as the caller (the upload's creator, checked by `checkOwner`) against the object as it
 * is now — the creation's policy check was only a dry run, up to a day ago.
 */
async function completeStaged(
  rt: StorageRuntime,
  row: ResumableRow,
  bucket: ResolvedBucket,
  caller: Caller,
): Promise<void> {
  let info: ObjectInfo;
  try {
    info = row.upload_id
      ? await assembleParts(rt, row, bucket)
      : await assembleChunks(rt, row, bucket);
  } catch (err) {
    await discard(rt, row);
    throw err;
  }
  await rt.meta.deleteResumable(row.id);
  const options = {
    upsert: row.upsert,
    owner: row.owner_id,
    userMetadata: row.user_metadata,
    ...(row.expect !== undefined ? { expect: row.expect } : {}),
  };
  try {
    await commitStaged(
      rt,
      bucket,
      row.name,
      row.version,
      options,
      metadataOf(info, row.cache_control),
      await actorFor(rt, caller),
      bytesAt(row),
    );
  } catch (err) {
    if (!row.upsert) await releaseObject(rt, row.bucket_id, row.name, row.version);
    throw err;
  }
}

async function assembleParts(
  rt: StorageRuntime,
  row: ResumableRow,
  bucket: ResolvedBucket,
): Promise<ObjectInfo> {
  const at = bytesAt(row);
  await rt.driver.direct!.completeMultipart(at.bucket, at.key, row.upload_id!, row.parts);
  const info = await rt.driver.head(at.bucket, at.key);
  try {
    if (!info) throw new StorageError("not_found", "the upload was not assembled");
    if (info.size !== row.upload_length) {
      throw new StorageError(
        "bad_request",
        `stored ${info.size} bytes, ${row.upload_length} were declared`,
      );
    }
    if (info.size > bucket.maxBytes) {
      throw new StorageError("too_large", "The object exceeded the maximum allowed size");
    }
    const head = await rt.driver.get(at.bucket, at.key, { start: 0, end: SNIFF_BYTES - 1 });
    const bytes = head ? await readAll(head.body, Infinity) : new Uint8Array();
    checkSniffed(row.content_type, bytes.subarray(0, SNIFF_BYTES), bucket.mime);
  } catch (err) {
    await rt.driver.remove(at.bucket, at.key);
    throw err;
  }
  return { ...info, contentType: row.content_type };
}

async function assembleChunks(
  rt: StorageRuntime,
  row: ResumableRow,
  bucket: ResolvedBucket,
): Promise<ObjectInfo> {
  const keys = row.chunks.map((c) => `${row.id}/${c.offset}`);
  let i = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const joined = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (!current) {
          if (i >= keys.length) return controller.close();
          const object = await rt.driver.get(TUS_NAMESPACE, keys[i++]);
          if (!object) {
            return controller.error(new StorageError("driver_error", "a chunk is missing"));
          }
          current = object.body.getReader();
        }
        const next = await current.read();
        if (next.done) {
          current = undefined;
          continue;
        }
        controller.enqueue(next.value);
        return;
      }
    },
    cancel(reason) {
      return current?.cancel(reason);
    },
  });
  const info = await storeChecked(
    rt,
    bucket,
    row.name,
    joined,
    row.content_type,
    bucket.maxBytes,
    row.upload_length,
    row.staged ? bytesAt(row) : undefined,
  );
  await removeChunks(rt, row);
  return info;
}

async function removeChunks(rt: StorageRuntime, row: ResumableRow): Promise<void> {
  for (const c of row.chunks) await rt.driver.remove(TUS_NAMESPACE, `${row.id}/${c.offset}`);
  if (row.tail_size > 0) await rt.driver.remove(TUS_NAMESPACE, `${row.id}/tail`);
}

/** Abandon an upload: free its parts or chunks, release its reservation, drop its state. */
async function discard(rt: StorageRuntime, row: ResumableRow): Promise<void> {
  if (row.upload_id) {
    const at = bytesAt(row);
    await rt.driver.direct?.abortMultipart(at.bucket, at.key, row.upload_id).catch(() => {});
  }
  await removeChunks(rt, row).catch(() => {});
  if (!row.upsert) await releaseObject(rt, row.bucket_id, row.name, row.version);
  await rt.meta.deleteResumable(row.id);
}

/** Clean up a few expired uploads (in the background of a creation). */
function sweep(rt: StorageRuntime): void {
  rt.meta.expiredResumables(Date.now(), SWEEP).then(async (rows) => {
    for (const row of rows) await discard(rt, row);
  }).catch(() => {});
}
