// The storage core every entry point goes through: the server API (`storage.bucket(n)…`), the
// sign route and the plugin's object handler. It normalizes keys, enforces the bucket's rules
// (authorize, size cap, allow-list, sniffing) and mints the plugin's signed URLs.

import { StorageError } from "./errors.ts";
import { normalizeKey, normalizePrefix } from "./keys.ts";
import { checkSniffed, dispositionFor, essence, SNIFF_BYTES } from "./mime.ts";
import {
  clampExpiry,
  MIN_PART_SIZE,
  resolveBucket,
  type ResolvedBucket,
  runtime,
  secretsOf,
  type StorageRuntime,
} from "./runtime.ts";
import { objectPath, type StorageTransform, writeTransform } from "./shared.ts";
import { nowSeconds, openGrant, sealGrant, signPayload, type UploadGrant } from "./signing.ts";
import { readAll, toStream } from "./streams.ts";
import {
  actorFor,
  authorizeOp,
  type Caller,
  capFor,
  checkContentType,
  checkSignedWrite,
  copyObject,
  createBucket,
  deleteBucket,
  emptyBucket,
  getBucket,
  getLifecycle,
  listBuckets,
  listEntries,
  metadataOf,
  moveObject,
  putObject,
  readableRow,
  recordObject,
  removeObjects,
  serverCaller,
  SERVICE_CALLER,
  setLifecycle,
  updateBucket,
} from "./storage-ops.ts";
import { type BucketRow, type ObjectMetadata, type ObjectRow, SERVICE } from "./storage-meta.ts";
import { isVersioned, keepsCurrent, locationOf, prepareOverwrite } from "./storage-versions.ts";
import type {
  BucketAccessOptions,
  BucketInfo,
  FolderEntry,
  FolderListOptions,
  ListOptions,
  ListResult,
  MultipartUpload,
  ObjectDetails,
  ObjectInfo,
  SignedUpload,
  SignedUploadOptions,
  SignedUrlOptions,
  Storage,
  StorageBucket,
  StoredObject,
  UploadBody,
  UploadOptions,
} from "./types.ts";

export { storeChecked } from "./storage-ops.ts";

/** Default lifetime of a signed upload URL (seconds). */
const UPLOAD_EXPIRY = 900;
/** Default lifetime of a signed download URL (seconds). */
const DOWNLOAD_EXPIRY = 3600;
/** `Cache-Control` recorded for a client upload. */
const DEFAULT_CACHE = "max-age=3600";
/** S3's part-count ceiling. */
const MAX_PARTS = 10_000;
/**
 * How long after its URLs expire an upload may still be completed (seconds): a store accepts a
 * PUT that STARTED before the expiry, so a large upload can finish after it.
 */
const COMPLETE_GRACE = 3600;

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
 * A signed upload URL for `key` (after `authorize`).
 *
 * @param rt The runtime.
 * @param bucket The bucket.
 * @param key The requested key.
 * @param options Content type, lifetime, size.
 * @param caller Who is asking.
 * @returns The upload.
 */
async function signedUpload(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  options: SignedUploadOptions,
  caller: Caller,
): Promise<SignedUpload> {
  const k = normalizeKey(key);
  const { owner, pin } = await checkUpload(rt, bucket, k, caller);
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
    o: owner,
    ...pin,
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

/**
 * Authorize a client upload now (it completes later, with only the token): the TypeScript rule,
 * and under SQL-RLS a dry run of the upsert under the caller's policies — pinned to the object's
 * version as it was checked, so the completion records the row only while it still has it.
 *
 * @returns The owner to record, and the pin (`{}` when the caller's policies were not checked).
 */
async function checkUpload(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  key: string,
  caller: Caller,
): Promise<{ owner: string | null; pin: { cv?: string | null } }> {
  await authorizeOp(rt, bucket, "upload", key, caller);
  const owner = caller.service || !caller.request ? null : (await caller.identity()).userId ?? null;
  const pin = await checkSignedWrite(rt, bucket, key, owner, true, await actorFor(rt, caller));
  // A versioned bucket keeps the current version's bytes before the client's PUT replaces them.
  await prepareOverwrite(rt, bucket, key);
  return { owner, pin };
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
  const bucket = await resolveBucket(rt, bucketName);
  const caller = serverCaller(false);
  const direct = rt.driver.direct;
  if (!direct || size <= rt.multipartThreshold) {
    return { upload: await signedUpload(rt, bucket, key, { contentType, size }, caller) };
  }
  const k = normalizeKey(key);
  const { owner, pin } = await checkUpload(rt, bucket, k, caller);
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
    o: owner,
    ...pin,
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
  const bucket = await resolveBucket(rt, grant.b);
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
  const row = { upsert: true, owner: grant.o ?? null };
  const meta = metadataOf(info, DEFAULT_CACHE);
  if (grant.cv !== undefined) {
    // Authorized against the object as it was when signed: the row is recorded only while it
    // still is (an object someone else created or replaced since is `conflict`).
    await recordPinned(rt, bucket, grant, row.owner, meta);
    return info;
  }
  await recordObject(rt, grant.b, grant.k, crypto.randomUUID(), row, meta);
  return info;
}

/** Record a pinned client upload's row: only while the object is at the grant's version. */
async function recordPinned(
  rt: StorageRuntime,
  bucket: ResolvedBucket,
  grant: UploadGrant,
  owner: string | null,
  metadata: ObjectMetadata,
): Promise<void> {
  const versioned = isVersioned(bucket);
  await rt.meta.commitObject(
    {
      row: {
        bucket_id: grant.b,
        name: grant.k,
        owner_id: owner,
        version: crypto.randomUUID(),
        metadata,
        user_metadata: null,
        ...(versioned ? { is_versioned: bucket.versioning === "ENABLED" } : {}),
      },
      upsert: true,
      reserved: false,
      keep: versioned ? (current) => keepsCurrent(bucket, current) : null,
      expect: grant.cv ?? null,
    },
    SERVICE,
    // The client's PUT already put the bytes at the key (and signing kept the old version's).
    () => Promise.resolve(),
  );
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
  caller: Caller,
): Promise<string> {
  const k = normalizeKey(key);
  await readableRow(rt, bucket, k, caller);
  const params = new URLSearchParams();
  const path = objectPath(rt.basePath, bucket.name, k);
  if (bucket.public) {
    writeTransform(params, options.transform);
    return params.size ? `${path}?${params}` : path;
  }
  const expiresIn = clampExpiry(options.expiresIn, DOWNLOAD_EXPIRY);
  if (!options.transform && rt.driver.direct) {
    return await presignedDownload(rt, bucket.name, k, expiresIn);
  }
  const exp = nowSeconds() + expiresIn;
  params.set("exp", String(exp));
  writeTransform(params, options.transform);
  const payload = downloadPayload(bucket.name, k, exp, options.transform);
  params.set("sig", await signPayload(payload, secretsOf(rt)));
  return `${path}?${params}`;
}

/**
 * A presigned GET on a direct store that the store answers the way the app's own object route
 * does: `response-content-type` from the stored metadata and `response-content-disposition`
 * `attachment` for every type that is not safe inline (`dispositionFor`). The browser fetches
 * from the store's origin, which sends no `nosniff` or sandbox CSP of its own, so an HTML, SVG
 * or unknown object — including one a client PUT but never completed, whose bytes were never
 * sniffed — downloads instead of rendering.
 *
 * @param rt The runtime (its driver has `direct`).
 * @param bucket The bucket.
 * @param key The normalized key.
 * @param expiresIn The URL's lifetime (seconds).
 * @returns The URL.
 */
export async function presignedDownload(
  rt: StorageRuntime,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  const info = await rt.driver.head(bucket, key);
  const type = info ? essence(info.contentType) : "";
  return await rt.driver.direct!.presignGet(bucket, key, {
    expiresIn,
    disposition: type ? dispositionFor(type) : "attachment",
    ...(type ? { contentType: type } : {}),
  });
}

/** An object row as the server API returns it. */
function detailsOf(row: ObjectRow): ObjectDetails {
  return {
    id: row.id,
    bucket: row.bucket_id,
    key: row.name,
    size: row.metadata?.size ?? 0,
    contentType: row.metadata?.mimetype ?? "application/octet-stream",
    cacheControl: row.metadata?.cacheControl ?? DEFAULT_CACHE,
    etag: (row.metadata?.eTag ?? "").replace(/^"|"$/g, ""),
    metadata: row.user_metadata,
    version: row.version,
    archivedAt: row.archived_at,
    owner: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A bucket row as the server API returns it. */
function bucketInfoOf(rt: StorageRuntime, row: BucketRow): BucketInfo {
  return {
    id: row.id,
    name: row.name,
    public: row.public,
    fileSizeLimit: row.file_size_limit,
    allowedMimeTypes: row.allowed_mime_types,
    declared: rt.buckets.has(row.id),
    versioningStatus: row.versioning_status ?? "DISABLED",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One bucket handle (the {@link StorageBucket} implementation). */
function bucketHandle(name: string, service: boolean): StorageBucket {
  const ctx = async () => {
    const rt = runtime();
    return { rt, bucket: await resolveBucket(rt, name), caller: serverCaller(service) };
  };
  const handle: StorageBucket = {
    name,
    async createSignedUploadUrl(key, options) {
      const { rt, bucket, caller } = await ctx();
      return await signedUpload(rt, bucket, key, options, caller);
    },
    async createSignedUrl(key, options = {}) {
      const { rt, bucket, caller } = await ctx();
      return await signedUrl(rt, bucket, key, options, caller);
    },
    async createSignedUrls(keys, options = {}) {
      const { rt, bucket, caller } = await ctx();
      return await Promise.all(keys.map(async (key) => {
        try {
          const k = normalizeKey(key);
          const row = await readableRow(rt, bucket, k, caller);
          if (!row && !(await rt.driver.head(bucket.name, k))) return null;
          return await signedUrl(rt, bucket, k, options, caller);
        } catch (err) {
          if (err instanceof StorageError && ["not_found", "forbidden"].includes(err.code)) {
            return null;
          }
          throw err;
        }
      }));
    },
    getPublicUrl(key, options = {}) {
      const rt = runtime();
      const params = new URLSearchParams();
      writeTransform(params, options.transform);
      const path = objectPath(rt.basePath, name, normalizeKey(key));
      return params.size ? `${path}?${params}` : path;
    },
    async remove(keys) {
      const { rt, bucket, caller } = await ctx();
      const list = (Array.isArray(keys) ? keys : [keys]).map((k) =>
        typeof k === "string"
          ? { key: normalizeKey(k) }
          : { key: normalizeKey(k.key), versionId: k.versionId }
      );
      await removeObjects(rt, bucket, list, caller);
    },
    async list(prefix = "", options: ListOptions = {}): Promise<ListResult> {
      const { rt, bucket, caller } = await ctx();
      const p = normalizePrefix(prefix);
      await authorizeOp(rt, bucket, "list", p, caller);
      const limitN = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000);
      const page = await rt.driver.list(bucket.name, p, { limit: limitN, cursor: options.cursor });
      const actor = await actorFor(rt, caller);
      if (actor.kind === "service" || bucket.public) return page;
      // SQL-RLS: only the objects the policies let this caller see.
      const visible = new Set<string>();
      for (const object of page.objects) {
        if (await rt.meta.getObject(bucket.name, object.key, actor)) visible.add(object.key);
      }
      return { ...page, objects: page.objects.filter((o) => visible.has(o.key)) };
    },
    async listFolder(prefix = "", options: FolderListOptions = {}): Promise<FolderEntry[]> {
      const { rt, bucket, caller } = await ctx();
      const trimmed = prefix.replace(/^\/+|\/+$/g, "");
      const p = trimmed ? normalizePrefix(trimmed + "/") : "";
      const entries = await listEntries(rt, bucket, {
        prefix: p,
        search: options.search ?? "",
        limit: Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000),
        offset: Math.max(Math.trunc(options.offset ?? 0), 0),
        column: options.sortBy?.column ?? "name",
        order: options.sortBy?.order === "desc" ? "desc" : "asc",
        versions: options.versions,
        markers: options.deleteMarkers,
      }, caller);
      return entries.map((e) => ({
        name: e.name,
        id: e.id,
        metadata: e.metadata
          ? {
            size: e.metadata.size,
            mimetype: e.metadata.mimetype,
            cacheControl: e.metadata.cacheControl,
            eTag: e.metadata.eTag,
            lastModified: e.metadata.lastModified,
          }
          : null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      }));
    },
    async head(key) {
      const { rt, bucket, caller } = await ctx();
      const k = normalizeKey(key);
      await readableRow(rt, bucket, k, caller);
      return await rt.driver.head(bucket.name, k);
    },
    async info(key, options = {}) {
      const { rt, bucket, caller } = await ctx();
      const k = normalizeKey(key);
      try {
        const row = await readableRow(rt, bucket, k, caller, options.versionId);
        return row?.metadata ? detailsOf(row) : null;
      } catch (err) {
        if (err instanceof StorageError && err.code === "not_found") return null;
        throw err;
      }
    },
    async exists(key) {
      try {
        return (await handle.head(key)) !== null;
      } catch (err) {
        if (err instanceof StorageError && err.code === "not_found") return false;
        throw err;
      }
    },
    async upload(key, body: UploadBody, options: UploadOptions = {}) {
      const { rt, bucket, caller } = await ctx();
      const { stream, size } = toStream(body);
      const row = await putObject(rt, bucket, normalizeKey(key), stream, {
        contentType: options.contentType,
        cacheControl: options.cacheControl,
        userMetadata: options.metadata ?? null,
        upsert: options.upsert ?? true,
        size,
      }, caller);
      return {
        key: row.name,
        size: row.metadata!.size,
        contentType: row.metadata!.mimetype,
        etag: row.metadata!.eTag.replace(/^"|"$/g, ""),
        lastModified: new Date(row.metadata!.lastModified),
      };
    },
    async download(key, options = {}): Promise<StoredObject | null> {
      const { rt, bucket, caller } = await ctx();
      const k = normalizeKey(key);
      let row: ObjectRow | null;
      try {
        row = await readableRow(rt, bucket, k, caller, options.versionId);
      } catch (err) {
        if (options.versionId && err instanceof StorageError && err.code === "not_found") {
          return null;
        }
        throw err;
      }
      const at = locationOf(bucket.name, k, row);
      return await rt.driver.get(at.bucket, at.key);
    },
    async copy(from, to, options = {}) {
      const { rt, caller } = await ctx();
      const row = await copyObject(
        rt,
        {
          from: { bucket: name, key: from },
          to: { bucket: options.destinationBucket ?? name, key: to },
        },
        options.upsert === true,
        caller,
      );
      return detailsOf(row);
    },
    async move(from, to, options = {}) {
      const { rt, caller } = await ctx();
      const row = await moveObject(rt, {
        from: { bucket: name, key: from },
        to: { bucket: options.destinationBucket ?? name, key: to },
      }, caller);
      return detailsOf(row);
    },
  };
  return handle;
}

/** The caller for a bucket administration call. */
function adminCaller(options?: BucketAccessOptions): Caller {
  return options?.service ? SERVICE_CALLER : serverCaller(false);
}

/**
 * The storage server API: `storage.bucket("avatars").createSignedUploadUrl(…)`. Every
 * operation enforces the bucket's rules; inside a request, `authorize` runs with that
 * request's session (and, under SQL-RLS, the policies with its role).
 */
export const storage: Storage = {
  bucket(name: string, options: BucketAccessOptions = {}): StorageBucket {
    return bucketHandle(name, options.service === true);
  },
  async createBucket(name, settings = {}, options) {
    await createBucket(runtime(), name, settings, adminCaller(options));
  },
  async getBucket(name, options) {
    const rt = runtime();
    return bucketInfoOf(rt, await getBucket(rt, name, adminCaller(options)));
  },
  async listBuckets(options) {
    const rt = runtime();
    const rows = await listBuckets(rt, { column: "name", order: "asc" }, adminCaller(options));
    return rows.map((row) => bucketInfoOf(rt, row));
  },
  async updateBucket(name, settings, options) {
    await updateBucket(runtime(), name, settings, adminCaller(options));
  },
  async deleteBucket(name, options) {
    await deleteBucket(runtime(), name, adminCaller(options));
  },
  async emptyBucket(name, options) {
    await emptyBucket(runtime(), name, adminCaller(options));
  },
  async getBucketLifecycle(name, options) {
    try {
      return await getLifecycle(runtime(), name, adminCaller(options));
    } catch (err) {
      if (err instanceof StorageError && err.code === "not_found") return null;
      throw err;
    }
  },
  async updateBucketLifecycle(name, policy, options) {
    await setLifecycle(runtime(), name, policy, adminCaller(options));
  },
};
