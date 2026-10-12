// The storage core every entry point goes through: the server API (`storage.bucket(n)…`), the
// sign route and the plugin's object handler. It normalizes keys, enforces the bucket's rules
// (authorize, size cap, allow-list, sniffing) and mints the plugin's signed URLs.

import { auth } from "@denext/denext/server";
import { StorageError } from "./errors.ts";
import { normalizeKey, normalizePrefix } from "./keys.ts";
import { checkSniffed, essence, mimeAllowed, SNIFF_BYTES, sniffMime } from "./mime.ts";
import {
  bucketOf,
  clampExpiry,
  MIN_PART_SIZE,
  type ResolvedBucket,
  runtime,
  secretsOf,
  type StorageRuntime,
} from "./runtime.ts";
import { objectPath, type StorageTransform, writeTransform } from "./shared.ts";
import { nowSeconds, openGrant, sealGrant, signPayload, type UploadGrant } from "./signing.ts";
import { limit, peek, readAll, toStream } from "./streams.ts";
import type {
  BucketAccessOptions,
  ListOptions,
  ListResult,
  MultipartUpload,
  ObjectInfo,
  SignedUpload,
  SignedUploadOptions,
  SignedUrlOptions,
  Storage,
  StorageBucket,
  StorageOp,
  StoredObject,
  UploadBody,
  UploadOptions,
} from "./types.ts";

/** Default lifetime of a signed upload URL (seconds). */
const UPLOAD_EXPIRY = 900;
/** Default lifetime of a signed download URL (seconds). */
const DOWNLOAD_EXPIRY = 3600;
/** S3's part-count ceiling. */
const MAX_PARTS = 10_000;
/**
 * How long after its URLs expire an upload may still be completed (seconds): a store accepts a
 * PUT that STARTED before the expiry, so a large upload can finish after it.
 */
const COMPLETE_GRACE = 3600;

type ContextBridge = { __denextCurrentRequestContext?: () => { request?: Request } | undefined };

/**
 * The request being served, or `null` outside any request (a task, a script, module load).
 *
 * @returns The current request.
 */
function currentRequest(): Request | null {
  return (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request ?? null;
}

/**
 * Enforce `authorize` for one operation. Outside a request, and for a service handle, nothing
 * is checked; a public bucket's downloads are open; otherwise `authorize` must return `true`
 * (absent → denied).
 *
 * @param bucket The bucket's rules.
 * @param op The operation.
 * @param key The key (or prefix).
 * @param service Whether this is a service handle.
 * @throws {StorageError} `forbidden`.
 */
async function authorizeOp(
  bucket: ResolvedBucket,
  op: StorageOp,
  key: string,
  service = false,
): Promise<void> {
  const request = currentRequest();
  if (!request || service) return;
  if (op === "download" && bucket.public) return;
  const allowed = bucket.authorize
    ? await bucket.authorize({ session: await auth(), op, key, bucket: bucket.name, request })
    : false;
  if (allowed !== true) {
    throw new StorageError("forbidden", `${op} is not allowed on ${bucket.name}/${key}`);
  }
}

/**
 * Check a declared content type against the bucket's allow-list.
 *
 * @param bucket The bucket's rules.
 * @param contentType The declared type.
 * @returns The type's essence.
 */
function checkContentType(bucket: ResolvedBucket, contentType: string): string {
  const type = typeof contentType === "string" ? essence(contentType) : "";
  if (!type) throw new StorageError("bad_request", "a valid content type is required");
  if (!mimeAllowed(type, bucket.mime)) {
    throw new StorageError("mime_not_allowed", `${type} is not allowed in ${bucket.name}`);
  }
  return type;
}

/** The size cap for one upload: the bucket's, tightened by the caller's. */
function capFor(bucket: ResolvedBucket, maxBytes?: number, size?: number): number {
  const cap = Math.min(bucket.maxBytes, maxBytes ?? Infinity);
  if (size !== undefined) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new StorageError("bad_request", "size must be a non-negative integer");
    }
    if (size > cap) throw new StorageError("too_large", `${size} bytes exceeds ${cap}`);
  }
  return cap;
}

/** The canonical string a download URL signs. */
export function downloadPayload(
  bucket: string,
  key: string,
  exp: number,
  transform?: StorageTransform,
): string {
  const params = new URLSearchParams();
  writeTransform(params, transform);
  return ["GET", bucket, key, String(exp), params.toString()].join("\n");
}

/** The canonical string an fs upload URL signs. */
export function uploadPayload(
  bucket: string,
  key: string,
  exp: number,
  contentType: string,
  max: number,
  size?: number,
): string {
  return ["PUT", bucket, key, String(exp), contentType, String(max), String(size ?? "")].join("\n");
}

/**
 * Store a body after checking its content: sniff the head against the declared type, then
 * stream it through the size cap (and the exact size, when declared) into the driver.
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The normalized key.
 * @param stream The body.
 * @param contentType The declared type (essence), or `undefined` to sniff one.
 * @param max The size cap.
 * @param size The exact size, if declared.
 * @returns The stored object's info.
 */
export async function storeChecked(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  contentType: string | undefined,
  max: number,
  size?: number,
): Promise<ObjectInfo> {
  const peeked = await peek(stream, SNIFF_BYTES);
  const type = contentType ??
    checkContentType(bucket, sniffMime(peeked.head) ?? "application/octet-stream");
  checkSniffed(type, peeked.head, bucket.mime);
  return await rt.driver.put(bucket.name, key, limit(peeked.stream, max, size), {
    contentType: type,
    size,
  });
}

/**
 * A signed upload URL for `key` (after `authorize`).
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The requested key.
 * @param options Content type, lifetime, size.
 * @param service Skip `authorize`.
 * @returns The upload.
 */
async function signedUpload(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  options: SignedUploadOptions,
  service: boolean,
): Promise<SignedUpload> {
  const k = normalizeKey(key);
  await authorizeOp(bucket, "upload", k, service);
  const contentType = checkContentType(bucket, options.contentType);
  const max = capFor(bucket, options.maxBytes, options.size);
  const expiresIn = clampExpiry(options.expiresIn, UPLOAD_EXPIRY);
  const exp = nowSeconds() + expiresIn;
  const secrets = secretsOf(rt);
  const url = rt.driver.direct
    ? await rt.driver.direct.presignPut(bucket.name, k, {
      expiresIn,
      contentType,
      size: options.size,
    })
    : await localUploadUrl(rt, bucket.name, k, exp, contentType, max, options.size);
  const grant: UploadGrant = {
    b: bucket.name,
    k,
    ct: contentType,
    max,
    exp: exp + COMPLETE_GRACE,
    n: options.size,
  };
  return {
    key: k,
    method: "PUT",
    url,
    headers: { "content-type": contentType },
    token: await sealGrant(grant, secrets),
    expiresAt: exp,
  };
}

async function localUploadUrl(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  exp: number,
  contentType: string,
  max: number,
  size?: number,
): Promise<string> {
  const params = new URLSearchParams({ exp: String(exp), ct: contentType, max: String(max) });
  if (size !== undefined) params.set("n", String(size));
  const payload = uploadPayload(bucket, key, exp, contentType, max, size);
  params.set("sig", await signPayload(payload, secretsOf(rt)));
  return `${objectPath(rt.basePath, bucket, key)}?${params}`;
}

/**
 * Plan a client upload of `size` bytes: one signed PUT, or — on a driver with direct access
 * and above the multipart threshold — a multipart upload with one presigned URL per part.
 *
 * @param bucketName The bucket.
 * @param key The key.
 * @param contentType The declared type.
 * @param size The exact size.
 * @returns The plan.
 */
export async function planUpload(
  bucketName: string,
  key: string,
  contentType: string,
  size: number,
): Promise<{ upload: SignedUpload } | { multipart: MultipartUpload }> {
  const rt = runtime();
  const bucket = bucketOf(rt, bucketName);
  const direct = rt.driver.direct;
  if (!direct || size <= rt.multipartThreshold) {
    return { upload: await signedUpload(rt, bucket, key, { contentType, size }, false) };
  }
  const k = normalizeKey(key);
  await authorizeOp(bucket, "upload", k);
  const type = checkContentType(bucket, contentType);
  const max = capFor(bucket, undefined, size);
  const secrets = secretsOf(rt);
  const partSize = Math.max(rt.partSize, MIN_PART_SIZE, Math.ceil(size / MAX_PARTS));
  const count = Math.max(1, Math.ceil(size / partSize));
  const expiresIn = clampExpiry(undefined, UPLOAD_EXPIRY * 4);
  const uploadId = await direct.createMultipart(bucket.name, k, type);
  const parts = await Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      partNumber: i + 1,
      url: await direct.presignPart(bucket.name, k, uploadId, i + 1, expiresIn),
    })),
  );
  const exp = nowSeconds() + expiresIn;
  const grant: UploadGrant = {
    b: bucket.name,
    k,
    ct: type,
    n: size,
    max,
    u: uploadId,
    exp: exp + COMPLETE_GRACE,
  };
  return {
    multipart: { key: k, partSize, parts, token: await sealGrant(grant, secrets), expiresAt: exp },
  };
}

/** One uploaded part, as the client reports it. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * Finish a client upload: assemble a multipart upload, then verify what was stored — its size
 * against the grant, and (for a store the bytes did not pass through) its first bytes against
 * the declared type. A failed check deletes the object.
 *
 * @param token The upload token.
 * @param parts The parts (multipart only).
 * @returns The stored object's info.
 */
export async function completeUpload(token: unknown, parts?: CompletedPart[]): Promise<ObjectInfo> {
  const rt = runtime();
  const grant = await openGrant(token, secretsOf(rt));
  const bucket = bucketOf(rt, grant.b);
  if (grant.u) {
    if (!parts?.length) throw new StorageError("bad_request", "parts are required");
    await rt.driver.direct!.completeMultipart(grant.b, grant.k, grant.u, checkParts(parts));
  }
  const info = await rt.driver.head(grant.b, grant.k);
  if (!info) throw new StorageError("not_found", "the upload was not received");
  try {
    verifyStored(info, grant);
    if (rt.driver.direct) await verifyContent(rt, bucket, grant);
  } catch (err) {
    await rt.driver.remove(grant.b, grant.k);
    throw err;
  }
  return info;
}

function checkParts(parts: CompletedPart[]): CompletedPart[] {
  parts.forEach((p, i) => {
    if (p.partNumber !== i + 1 || typeof p.etag !== "string" || !p.etag) {
      throw new StorageError("bad_request", "parts must be numbered 1…n in order, with ETags");
    }
  });
  return parts;
}

function verifyStored(info: ObjectInfo, grant: UploadGrant): void {
  if (info.size > grant.max) {
    throw new StorageError("too_large", `object exceeds ${grant.max} bytes`);
  }
  if (grant.n !== undefined && info.size !== grant.n) {
    throw new StorageError("bad_request", `stored ${info.size} bytes, ${grant.n} were declared`);
  }
  if (essence(info.contentType) !== grant.ct) {
    throw new StorageError("mime_mismatch", `stored as ${info.contentType}, not ${grant.ct}`);
  }
}

async function verifyContent(rt: StorageRuntime, bucket: ResolvedBucket, grant: UploadGrant) {
  const object = await rt.driver.get(grant.b, grant.k, { start: 0, end: SNIFF_BYTES - 1 });
  const head = object ? await readAll(object.body, Infinity) : new Uint8Array();
  checkSniffed(grant.ct, head.subarray(0, SNIFF_BYTES), bucket.mime);
}

/**
 * Abandon a client upload (frees a multipart upload's parts; a single PUT needs nothing).
 *
 * @param token The upload token.
 */
export async function abortUpload(token: unknown): Promise<void> {
  const rt = runtime();
  const grant = await openGrant(token, secretsOf(rt));
  if (grant.u) await rt.driver.direct!.abortMultipart(grant.b, grant.k, grant.u);
}

/** A download URL (after `authorize`). */
async function signedUrl(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  options: SignedUrlOptions,
  service: boolean,
): Promise<string> {
  const k = normalizeKey(key);
  await authorizeOp(bucket, "download", k, service);
  const params = new URLSearchParams();
  const path = objectPath(rt.basePath, bucket.name, k);
  if (bucket.public) {
    writeTransform(params, options.transform);
    return params.size ? `${path}?${params}` : path;
  }
  const expiresIn = clampExpiry(options.expiresIn, DOWNLOAD_EXPIRY);
  if (!options.transform && rt.driver.direct) {
    return await rt.driver.direct.presignGet(bucket.name, k, { expiresIn });
  }
  const exp = nowSeconds() + expiresIn;
  params.set("exp", String(exp));
  writeTransform(params, options.transform);
  const payload = downloadPayload(bucket.name, k, exp, options.transform);
  params.set("sig", await signPayload(payload, secretsOf(rt)));
  return `${path}?${params}`;
}

/** Run `fn` over `items`, at most `width` at a time. */
async function eachLimited<T>(items: T[], width: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
}

/** One bucket handle (the {@link StorageBucket} implementation). */
function bucketHandle(name: string, service: boolean): StorageBucket {
  const ctx = () => {
    const rt = runtime();
    return { rt, bucket: bucketOf(rt, name) };
  };
  return {
    name,
    createSignedUploadUrl(key, options) {
      const { rt, bucket } = ctx();
      return signedUpload(rt, bucket, key, options, service);
    },
    createSignedUrl(key, options = {}) {
      const { rt, bucket } = ctx();
      return signedUrl(rt, bucket, key, options, service);
    },
    async remove(keys) {
      const { rt, bucket } = ctx();
      const list = (Array.isArray(keys) ? keys : [keys]).map(normalizeKey);
      for (const k of list) await authorizeOp(bucket, "delete", k, service);
      await eachLimited(list, 8, (k) => rt.driver.remove(bucket.name, k));
    },
    async list(prefix = "", options: ListOptions = {}): Promise<ListResult> {
      const { rt, bucket } = ctx();
      const p = normalizePrefix(prefix);
      await authorizeOp(bucket, "list", p, service);
      const limitN = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
      return await rt.driver.list(bucket.name, p, { limit: limitN, cursor: options.cursor });
    },
    async head(key) {
      const { rt, bucket } = ctx();
      const k = normalizeKey(key);
      await authorizeOp(bucket, "download", k, service);
      return await rt.driver.head(bucket.name, k);
    },
    async upload(key, body: UploadBody, options: UploadOptions = {}) {
      const { rt, bucket } = ctx();
      const k = normalizeKey(key);
      await authorizeOp(bucket, "upload", k, service);
      const type = options.contentType === undefined
        ? undefined
        : checkContentType(bucket, options.contentType);
      const { stream, size } = toStream(body);
      const max = capFor(bucket, undefined, size);
      return await storeChecked(rt, bucket, k, stream, type, max, size);
    },
    async download(key): Promise<StoredObject | null> {
      const { rt, bucket } = ctx();
      const k = normalizeKey(key);
      await authorizeOp(bucket, "download", k, service);
      return await rt.driver.get(bucket.name, k);
    },
  };
}

/**
 * The storage server API: `storage.bucket("avatars").createSignedUploadUrl(…)`. Every
 * operation enforces the bucket's rules; inside a request, `authorize` runs with that
 * request's session.
 */
export const storage: Storage = {
  bucket(name: string, options: BucketAccessOptions = {}): StorageBucket {
    return bucketHandle(name, options.service === true);
  },
};
