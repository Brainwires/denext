// The public shapes of `@denext/backend`'s storage: options, bucket rules, the driver contract
// and what the server API returns.

import type { AuthSession } from "@denext/denext/server";
import type { StorageTransform } from "./shared.ts";
import type { StorageIdentity } from "./storage-identity.ts";

/** The operation an {@link BucketConfig.authorize} call is asked about. */
export type StorageOp = "upload" | "download" | "delete" | "list";

/** What {@link BucketConfig.authorize} receives. */
export interface StorageAuthorizeContext {
  /** The current request's session (`auth()` under `denextAuth`), or `null`. */
  session: AuthSession | null;
  /**
   * Who the request acts as — `anon`, `authenticated` (with `userId` and the claims a Supabase
   * access token carries) or `service_role` (never seen here: the secret key skips `authorize`).
   */
  identity: StorageIdentity;
  /** The operation. */
  op: StorageOp;
  /** The object key (for `list`, the prefix). */
  key: string;
  /** The bucket name. */
  bucket: string;
  /** The request being served. */
  request: Request;
}

/** One bucket's rules. */
export interface BucketConfig {
  /**
   * Anyone may download (no signature, no {@link authorize} call), and download URLs are stable
   * and cacheable. Uploads, deletes and listings still need {@link authorize}. Default `false`.
   */
  public?: boolean;
  /** Largest object accepted, in bytes (default 50 MiB). */
  maxBytes?: number;
  /**
   * Allowed content types — exact (`application/pdf`) or `type/*` (`image/*`). Checked on every
   * upload; a declared raster image is also sniffed from its first bytes and must be what it
   * claims. Omitted: any type.
   */
  mime?: string[];
  /**
   * Decide one operation for the current request. Runs whenever a storage call is made inside
   * a request (the plugin's endpoints, and the server API called from a route handler, Server
   * Action or page); a call outside any request (a job, a script) is trusted and skips it.
   * Absent, every operation is denied — except downloads from a {@link public} bucket.
   */
  authorize?: (context: StorageAuthorizeContext) => boolean | Promise<boolean>;
  /**
   * Object versioning, as Supabase Storage has it: `true` keeps every overwritten or deleted
   * object as a noncurrent version (a delete leaves a delete marker); `false` suspends it
   * (history is kept, new writes replace). Omitted: off (`DISABLED`), or whatever the bucket's
   * row says once it has been turned on.
   */
  versioned?: boolean;
}

/** Options for the storage half of `backend()`. */
export interface StorageOptions {
  /** Where objects live: `s3({ … })` or `fs({ dir })`. */
  driver: StorageDriver;
  /** The buckets, by name (lowercase letters, digits, `-`, `_`). */
  buckets: Record<string, BucketConfig>;
  /**
   * The HMAC secret (≥ 32 characters) for the plugin's signed URLs and upload tokens — or a
   * list, current first, to rotate one out. Default: `DENEXT_STORAGE_SECRET`; under
   * `denext dev` a random per-process secret when neither is set.
   */
  secret?: string | string[];
  /** Uploads larger than this go multipart, when the driver supports it (default 64 MiB). */
  multipartThreshold?: number;
  /** Multipart part size in bytes (default 16 MiB, at least 5 MiB). */
  partSize?: number;
  /**
   * The rule for buckets created at runtime (`storage.createBucket`, supabase-js
   * `createBucket`) and for declared buckets without an `authorize` of their own. Absent, those
   * buckets are open only to the service role (and to downloads, when public).
   */
  authorize?: (context: StorageAuthorizeContext) => boolean | Promise<boolean>;
  /**
   * Authorize with SQL row-level security on `storage.objects` / `storage.buckets`, as Supabase
   * does: every operation runs its statement as the request's role (`anon` / `authenticated`,
   * `auth.uid()` in your policies), so the policies decide; a bucket's `authorize`, when it has
   * one, must allow it too. Needs `postgres`. Default `false` (the TypeScript rules decide).
   */
  rls?: boolean;
  /**
   * The Supabase-compatible Storage API (what `supabase.storage` from `@supabase/supabase-js`
   * talks to, and TUS resumable uploads): served under `/storage/v1` by default; a path to move
   * it, or `false` to turn it off.
   */
  api?: boolean | { basePath?: string };
  /**
   * Where the bucket and object metadata lives without Postgres: a `node:sqlite` file (default
   * `.denext-storage.db` in the project root). With `postgres`, it is the `storage` schema.
   */
  metadataPath?: string;
  /** The largest width or height the API's image render routes produce (default 2500). */
  maxTransformDimension?: number;
}

/** What a stored object is. */
export interface ObjectInfo {
  /** The key. */
  key: string;
  /** Size in bytes. */
  size: number;
  /** The content type it was stored with. */
  contentType: string;
  /** An opaque version tag (the driver's ETag). */
  etag?: string;
  /** When it was last written. */
  lastModified?: Date;
}

/** A downloaded object: its {@link ObjectInfo} and its bytes, as a stream. */
export interface StoredObject extends ObjectInfo {
  /** The content (the requested range only, for a ranged read). */
  body: ReadableStream<Uint8Array>;
  /** The byte range served, inclusive, when a range was requested and satisfiable. */
  range?: { start: number; end: number };
}

/** An object in a listing (a store may not report content types there). */
export interface ListedObject extends Omit<ObjectInfo, "contentType"> {
  /** The content type, when the store reports it in listings. */
  contentType?: string;
}

/** One page of a listing. */
export interface ListResult {
  /** The objects, in key order. */
  objects: ListedObject[];
  /** Pass to the next `list()` call for the following page; absent on the last page. */
  cursor?: string;
}

/** Options for a listing. */
export interface ListOptions {
  /** Page size (default 100, at most 1000). */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
}

/** A byte range, `start`…`end` inclusive, already resolved against the object's size. */
export interface ByteRange {
  /** The first byte. */
  start: number;
  /** The last byte (inclusive). */
  end: number;
}

/** What a driver needs to store one object. */
export interface PutInfo {
  /** The content type to store. */
  contentType: string;
  /** Exact size when known (else the stream decides). */
  size?: number;
}

/**
 * A storage backend. denext ships {@link s3} and {@link fs}; a custom driver implements this.
 * Drivers receive keys already normalized and bodies already checked (size cap, type sniffing),
 * and map a bucket to their own namespace (a key prefix, a directory).
 */
export interface StorageDriver {
  /** A short name for messages (`"s3"`, `"fs"`). */
  readonly name: string;
  /** Called once at plugin setup with the project root (resolve relative paths against it). */
  init?(context: { projectRoot: string }): void | Promise<void>;
  /** Store an object. The stream errors when the body breaks a rule; the driver then stores nothing. */
  put(
    bucket: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    info: PutInfo,
  ): Promise<ObjectInfo>;
  /** Read an object (a range of it), or `null` when it does not exist. */
  get(bucket: string, key: string, range?: ByteRange): Promise<StoredObject | null>;
  /** An object's info, or `null` when it does not exist. */
  head(bucket: string, key: string): Promise<ObjectInfo | null>;
  /** Delete an object (no error when it does not exist). */
  remove(bucket: string, key: string): Promise<void>;
  /** One page of the objects whose key starts with `prefix`, in key order. */
  list(
    bucket: string,
    prefix: string,
    options: { limit: number; cursor?: string },
  ): Promise<ListResult>;
  /** Direct-to-store URLs, when the store serves clients itself (S3). */
  readonly direct?: DirectAccess;
  /**
   * Copy an object inside the store (S3 `CopyObject`), keeping its content type. Optional: without
   * it, a copy streams the object back in through `get` and `put`.
   */
  copy?(fromBucket: string, fromKey: string, toBucket: string, toKey: string): Promise<ObjectInfo>;
}

/** The parts of an S3-style store a browser talks to directly, through presigned URLs. */
export interface DirectAccess {
  /** A presigned PUT. `size` pins `content-length`; `contentType` pins `content-type`. */
  presignPut(
    bucket: string,
    key: string,
    options: { expiresIn: number; contentType: string; size?: number },
  ): Promise<string>;
  /**
   * A presigned GET. `disposition` and `contentType`, when given, are signed in as the store's
   * `response-content-disposition` / `response-content-type` overrides, so the store serves the
   * object with them (a store without such overrides must refuse rather than drop them).
   */
  presignGet(
    bucket: string,
    key: string,
    options: { expiresIn: number; disposition?: "inline" | "attachment"; contentType?: string },
  ): Promise<string>;
  /** Start a multipart upload; returns its upload id. */
  createMultipart(bucket: string, key: string, contentType: string): Promise<string>;
  /** A presigned PUT for one part (1-based). */
  presignPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string>;
  /** Assemble the uploaded parts into the object. */
  completeMultipart(
    bucket: string,
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  /** Abandon a multipart upload and free its parts. */
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
  /**
   * Upload one part from the server (resumable uploads); returns its ETag. Optional: without it,
   * the part is sent to {@link presignPart}'s URL.
   */
  uploadPart?(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<string>;
}

/** Options for {@link StorageBucket.createSignedUploadUrl}. */
export interface SignedUploadOptions {
  /** Content type the upload must carry (checked against the bucket's `mime`). */
  contentType: string;
  /** Seconds the URL is valid (default 900, at most 7 days). */
  expiresIn?: number;
  /** A tighter size cap than the bucket's `maxBytes` for this one upload. */
  maxBytes?: number;
  /** The exact size, when known: pinned in the URL (an S3 PUT must then match it). */
  size?: number;
}

/** A signed upload: where to send the bytes, and the token that completes it. */
export interface SignedUpload {
  /** The object key. */
  key: string;
  /** The HTTP method (`PUT`). */
  method: "PUT";
  /** Where to send the bytes. */
  url: string;
  /** Headers the request must carry exactly (`content-type`). */
  headers: Record<string, string>;
  /** Hand to `POST /_denext/storage/sign` `{ op: "complete", token }` once the bytes are sent. */
  token: string;
  /** When the URL expires, epoch seconds. */
  expiresAt: number;
}

/** A multipart upload plan: one presigned URL per part. */
export interface MultipartUpload {
  /** The object key. */
  key: string;
  /** Part size in bytes (the last part may be smaller). */
  partSize: number;
  /** One presigned PUT per part, in order. */
  parts: { partNumber: number; url: string }[];
  /** Hand back with each part's ETag to complete, or alone to abort. */
  token: string;
  /** When the URLs expire, epoch seconds. */
  expiresAt: number;
}

/** Options for {@link StorageBucket.createSignedUrl}. */
export interface SignedUrlOptions {
  /** Seconds the URL is valid (default 3600, at most 7 days). Ignored for a public bucket. */
  expiresIn?: number;
  /** Resize / re-encode an image object on download. */
  transform?: StorageTransform;
}

/** Options for {@link StorageBucket.upload}. */
export interface UploadOptions {
  /** The content type (default: sniffed from the bytes, else `application/octet-stream`). */
  contentType?: string;
  /** Replace an existing object (default `true`); `false` refuses a duplicate (`duplicate`). */
  upsert?: boolean;
  /** `Cache-Control` the object is served with (default `max-age=3600`). */
  cacheControl?: string;
  /** Free-form metadata kept with the object (Supabase's `user_metadata`). */
  metadata?: Record<string, unknown>;
}

/** An object's stored facts (Supabase's `info()`). */
export interface ObjectDetails {
  /** The object's id. */
  id: string;
  /** The bucket. */
  bucket: string;
  /** The key. */
  key: string;
  /** Size in bytes. */
  size: number;
  /** Content type. */
  contentType: string;
  /** `Cache-Control` it is served with. */
  cacheControl: string;
  /** Its ETag. */
  etag: string;
  /** Free-form metadata (`user_metadata`), or `null`. */
  metadata: Record<string, unknown> | null;
  /** This version's id. */
  version: string;
  /** When this version stopped being current, or `null` for the current one. */
  archivedAt: string | null;
  /** The owner (a user id), or `null`. */
  owner: string | null;
  /** When it was created (ISO 8601). */
  createdAt: string;
  /** When it was last written (ISO 8601). */
  updatedAt: string;
}

/** One entry of {@link StorageBucket.listFolder}: a folder (`id: null`) or an object. */
export interface FolderEntry {
  /** The name below the prefix. */
  name: string;
  /** The object's id, or `null` for a folder. */
  id: string | null;
  /** Size, type and cache facts; `null` for a folder. */
  metadata: {
    size: number;
    mimetype: string;
    cacheControl: string;
    eTag: string;
    lastModified: string;
  } | null;
  /** When it was created (ISO 8601); `null` for a folder. */
  createdAt: string | null;
  /** When it was last written (ISO 8601); `null` for a folder. */
  updatedAt: string | null;
}

/** Options for {@link StorageBucket.listFolder}. */
export interface FolderListOptions {
  /** Page size (default 100, at most 1000). */
  limit?: number;
  /** Entries to skip. */
  offset?: number;
  /** Only names (below the prefix) starting with this, case-insensitively. */
  search?: string;
  /** Noncurrent versions: `exclude` (default), `include` or `only`. */
  versions?: "exclude" | "include" | "only";
  /** Delete markers: `exclude` (default), `include` or `only`. */
  deleteMarkers?: "exclude" | "include" | "only";
  /** The column and direction (default `name`, `asc`); folders always come first. */
  sortBy?: {
    column?: "name" | "created_at" | "updated_at" | "last_accessed_at";
    order?: "asc" | "desc";
  };
}

/** Options for {@link StorageBucket.copy} and {@link StorageBucket.move}. */
export interface TransferOptions {
  /** Another bucket to copy or move into. */
  destinationBucket?: string;
  /** Copy only: replace an existing destination (default `false`). */
  upsert?: boolean;
}

/** A bucket's settings ({@link Storage.createBucket}). */
export interface BucketSettings {
  /** Anyone may download (default `false`). */
  public?: boolean;
  /** Largest object, in bytes or as `"50MB"` (default 50 MiB). */
  fileSizeLimit?: number | string | null;
  /** Allowed content types (`image/*`, `application/pdf`); `null` for any. */
  allowedMimeTypes?: string[] | null;
  /**
   * Object versioning: a new bucket starts `DISABLED` or `ENABLED`; an update sets `ENABLED` or
   * `SUSPENDED` (there is no way back to `DISABLED`).
   */
  versioningStatus?: "DISABLED" | "ENABLED" | "SUSPENDED";
}

/** A bucket as {@link Storage.getBucket} returns it. */
export interface BucketInfo {
  /** The bucket's id (its name). */
  id: string;
  /** The bucket's name. */
  name: string;
  /** Anyone may download. */
  public: boolean;
  /** Bytes, or `null` for the default cap. */
  fileSizeLimit: number | null;
  /** Allowed content types, or `null` for any. */
  allowedMimeTypes: string[] | null;
  /** Declared in `denext.config.ts` (changed there, not at runtime). */
  declared: boolean;
  /** Object versioning: `DISABLED`, `ENABLED` or `SUSPENDED`. */
  versioningStatus: "DISABLED" | "ENABLED" | "SUSPENDED";
  /** When it was created (ISO 8601). */
  createdAt: string;
  /** When its settings last changed (ISO 8601). */
  updatedAt: string;
}

/** What a server-side {@link StorageBucket.upload} accepts. */
export type UploadBody = Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;

/** One bucket's operations; every one enforces the bucket's rules. */
export interface StorageBucket {
  /** The bucket name. */
  readonly name: string;
  /** A signed upload URL (op `upload`). */
  createSignedUploadUrl(key: string, options: SignedUploadOptions): Promise<SignedUpload>;
  /** A download URL (op `download`): signed and expiring, or stable for a public bucket. */
  createSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  /**
   * Delete objects (op `delete`, checked per key). In a versioned bucket a key leaves a delete
   * marker; `{ key, versionId }` deletes that version for good.
   */
  remove(keys: string | (string | { key: string; versionId?: string })[]): Promise<void>;
  /** One page of the objects under `prefix` (op `list`). */
  list(prefix?: string, options?: ListOptions): Promise<ListResult>;
  /** An object's info, or `null` (op `download`). */
  head(key: string): Promise<ObjectInfo | null>;
  /** Store bytes from the server (op `upload`); size cap, allow-list and sniffing apply. */
  upload(key: string, body: UploadBody, options?: UploadOptions): Promise<ObjectInfo>;
  /** Read an object (or one of its versions), or `null` (op `download`). */
  download(key: string, options?: VersionOptions): Promise<StoredObject | null>;
  /** An object's (or a version's) stored facts, or `null` (op `download`). */
  info(key: string, options?: VersionOptions): Promise<ObjectDetails | null>;
  /** Whether an object exists (op `download`). */
  exists(key: string): Promise<boolean>;
  /** Download URLs for several keys at once (op `download`); `null` where one is not found. */
  createSignedUrls(keys: string[], options?: SignedUrlOptions): Promise<(string | null)[]>;
  /** The stable public URL of an object in a public bucket (no request is made). */
  getPublicUrl(key: string, options?: { transform?: StorageTransform }): string;
  /** Copy an object (op `download` on the source, `upload` on the destination). */
  copy(from: string, to: string, options?: TransferOptions): Promise<ObjectDetails>;
  /** Move an object (`download` + `delete` on the source, `upload` on the destination). */
  move(from: string, to: string, options?: TransferOptions): Promise<ObjectDetails>;
  /** One page of a folder, Supabase-style: subfolders first, then the objects in it (op `list`). */
  listFolder(prefix?: string, options?: FolderListOptions): Promise<FolderEntry[]>;
}

/** Which version of an object (default: the current one). */
export interface VersionOptions {
  /** A version id (from `info()`, or a listing with `versions`). */
  versionId?: string;
}

/** A bucket's lifecycle policy (noncurrent-version expiration). */
export interface LifecyclePolicy {
  /** 1 to 1000 rules. */
  rules: {
    id?: string;
    status: "Enabled" | "Disabled";
    filter: Record<string, never>;
    noncurrentVersionExpiration: { noncurrentDays: number; newerNoncurrentVersions?: number };
  }[];
}

/** Options for {@link Storage.bucket}. */
export interface BucketAccessOptions {
  /**
   * Skip {@link BucketConfig.authorize} for this handle — the server acting for itself (a
   * webhook, an admin job) inside a request. The size cap, allow-list and sniffing still apply.
   */
  service?: boolean;
}

/** The storage server API (`storage` from `@denext/backend/server`). */
export interface Storage {
  /**
   * A bucket's operations: a bucket declared in the config or created at runtime (an unknown one
   * fails its first call with `unknown_bucket`).
   */
  bucket(name: string, options?: BucketAccessOptions): StorageBucket;
  /** Create a bucket at runtime (the service role, or a `storage.buckets` policy under SQL-RLS). */
  createBucket(
    name: string,
    settings?: BucketSettings,
    options?: BucketAccessOptions,
  ): Promise<void>;
  /** A bucket's settings. */
  getBucket(name: string, options?: BucketAccessOptions): Promise<BucketInfo>;
  /** Every bucket (declared and runtime). */
  listBuckets(options?: BucketAccessOptions): Promise<BucketInfo[]>;
  /** Change a runtime bucket's settings. */
  updateBucket(
    name: string,
    settings: BucketSettings,
    options?: BucketAccessOptions,
  ): Promise<void>;
  /** Delete an empty runtime bucket (`not_empty` otherwise). */
  deleteBucket(name: string, options?: BucketAccessOptions): Promise<void>;
  /** Delete every object in a bucket. */
  emptyBucket(name: string, options?: BucketAccessOptions): Promise<void>;
  /** A bucket's lifecycle policy, or `null`. */
  getBucketLifecycle(name: string, options?: BucketAccessOptions): Promise<LifecyclePolicy | null>;
  /** Replace a bucket's lifecycle policy (`null` removes it). */
  updateBucketLifecycle(
    name: string,
    policy: LifecyclePolicy | null,
    options?: BucketAccessOptions,
  ): Promise<void>;
}
