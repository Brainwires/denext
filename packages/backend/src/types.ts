// The public shapes of `@denext/backend`'s storage: options, bucket rules, the driver contract
// and what the server API returns.

import type { AuthSession } from "@denext/denext/server";
import type { StorageTransform } from "./shared.ts";

/** The operation an {@link BucketConfig.authorize} call is asked about. */
export type StorageOp = "upload" | "download" | "delete" | "list";

/** What {@link BucketConfig.authorize} receives. */
export interface StorageAuthorizeContext {
  /** The current request's session (`auth()` under `denextAuth`), or `null`. */
  session: AuthSession | null;
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
   * Action or page); a call outside any request (a task, a script) is trusted and skips it.
   * Absent, every operation is denied — except downloads from a {@link public} bucket.
   */
  authorize?: (context: StorageAuthorizeContext) => boolean | Promise<boolean>;
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
  /** Delete objects (op `delete`, checked per key). */
  remove(keys: string | string[]): Promise<void>;
  /** One page of the objects under `prefix` (op `list`). */
  list(prefix?: string, options?: ListOptions): Promise<ListResult>;
  /** An object's info, or `null` (op `download`). */
  head(key: string): Promise<ObjectInfo | null>;
  /** Store bytes from the server (op `upload`); size cap, allow-list and sniffing apply. */
  upload(key: string, body: UploadBody, options?: UploadOptions): Promise<ObjectInfo>;
  /** Read an object, or `null` (op `download`). */
  download(key: string): Promise<StoredObject | null>;
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
  /** A bucket's operations. Throws `unknown_bucket` for a bucket not in the config. */
  bucket(name: string, options?: BucketAccessOptions): StorageBucket;
}
