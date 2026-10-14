// The browser's helpers over the Storage API (`/storage/v1`), for an app that does not use
// supabase-js: folder listings, info, bulk remove, move and copy, batch signing, public URLs and
// resumable (TUS) uploads that survive a dropped connection. They send the page's cookies
// (same-origin), so the bucket's `authorize` or the SQL policies see the signed-in user. This
// module imports no server code.

/** Where the Storage API is and how to cancel a call. */
export interface StorageApiOptions {
  /** The Storage API's base (default: `<basePath>/storage/v1`). */
  apiBase?: string;
  /** Cancels the call. */
  signal?: AbortSignal;
}

/** A refused or failed Storage API call. */
export class StorageApiClientError extends Error {
  /** Storage's error name (`Duplicate`, `Unauthorized`, `not_found`, …). */
  readonly code: string;
  /** The HTTP status. */
  readonly status: number;

  /**
   * Create an error.
   *
   * @param code Storage's error name.
   * @param status The HTTP status.
   * @param message The message.
   */
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "StorageApiClientError";
    this.code = code;
    this.status = status;
  }
}

/** A file's facts in a listing. */
export interface FileMetadata {
  /** Its ETag (quoted). */
  eTag: string;
  /** Size in bytes. */
  size: number;
  /** Content type. */
  mimetype: string;
  /** `Cache-Control` it is served with. */
  cacheControl: string;
  /** When it was last written (ISO 8601). */
  lastModified: string;
  /** Size in bytes, as served. */
  contentLength: number;
  /** Always 200. */
  httpStatusCode: number;
}

/** One entry of {@linkcode listFiles}: a folder (`id: null`) or a file. */
export interface FileEntry {
  /** The name below the prefix. */
  name: string;
  /** The file's id, or `null` for a folder. */
  id: string | null;
  /** When it was last written (ISO 8601); `null` for a folder. */
  updated_at: string | null;
  /** When it was created (ISO 8601); `null` for a folder. */
  created_at: string | null;
  /** When it was last read (ISO 8601); `null` for a folder. */
  last_accessed_at: string | null;
  /** Size, type, cache and ETag facts; `null` for a folder. */
  metadata: FileMetadata | null;
  /** The version's id (listings that include versions or delete markers). */
  version?: string | null;
  /** When the version stopped being current (`null`: the current one). */
  archived_at?: string | null;
  /** A delete marker. */
  is_delete_marker?: boolean | null;
  /** Written while the bucket kept versions. */
  is_versioned?: boolean | null;
}

/** What {@linkcode getFileInfo} returns. */
export interface FileInfo {
  /** The file's id. */
  id: string;
  /** The version written last. */
  version: string;
  /** The key. */
  name: string;
  /** The bucket. */
  bucket_id: string;
  /** Size in bytes. */
  size: number;
  /** Content type. */
  content_type: string;
  /** `Cache-Control` it is served with. */
  cache_control: string;
  /** Its ETag (quoted). */
  etag: string;
  /** Free-form metadata given at upload. */
  metadata: Record<string, unknown>;
  /** When it was last written (ISO 8601). */
  last_modified: string;
  /** When it was created (ISO 8601). */
  created_at: string;
}

/** A Supabase-style image transform. */
export interface ImageTransformOptions {
  /** Target width in pixels. */
  width?: number;
  /** Target height in pixels. */
  height?: number;
  /** `cover` (default) fills the box and crops; `contain` fits inside; `fill` stretches. */
  resize?: "cover" | "contain" | "fill";
  /** Encoder quality, 1–100. */
  quality?: number;
  /** `origin` keeps the source's format (else WebP). */
  format?: "origin";
}

function apiBaseOf(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, "");
  const base = (globalThis as { __denextBasePath?: string }).__denextBasePath ?? "";
  return `${base}/storage/v1`;
}

/** Each path segment percent-encoded on its own. */
function encodePath(bucket: string, key: string): string {
  return [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
}

async function failure(res: Response): Promise<StorageApiClientError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    return new StorageApiClientError(body.error ?? "http_error", res.status, body.message ?? text);
  } catch {
    return new StorageApiClientError("http_error", res.status, text || `HTTP ${res.status}`);
  }
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
  options: StorageApiOptions,
): Promise<T> {
  const res = await fetch(`${apiBaseOf(options.apiBase)}${path}`, {
    method: init.method,
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: options.signal,
  });
  if (!res.ok) throw await failure(res);
  return await res.json() as T;
}

/**
 * One level of a folder: subfolders first, then the files in it.
 *
 * @param bucket The bucket.
 * @param prefix The folder (`""` for the bucket's root).
 * @param options Paging, search, sort.
 * @returns The entries.
 */
export function listFiles(
  bucket: string,
  prefix = "",
  options: StorageApiOptions & {
    limit?: number;
    offset?: number;
    search?: string;
    sortBy?: {
      column: "name" | "created_at" | "updated_at" | "last_accessed_at";
      order?: "asc" | "desc";
    };
    /** Noncurrent versions (versioned buckets): `exclude` (default), `include` or `only`. */
    noncurrentVersions?: "exclude" | "include" | "only";
    /** Delete markers: `exclude` (default), `include` or `only`. */
    deleteMarkers?: "exclude" | "include" | "only";
    /** Only the object named exactly `prefix` (all its versions). */
    exactMatch?: boolean;
  } = {},
): Promise<FileEntry[]> {
  const { apiBase: _a, signal: _s, ...query } = options;
  return call(`/object/list/${encodeURIComponent(bucket)}`, {
    method: "POST",
    body: { prefix, ...query },
  }, options);
}

/**
 * A file's stored facts.
 *
 * @param bucket The bucket.
 * @param key The key.
 * @param options Where the API is.
 * @returns The info.
 */
export function getFileInfo(
  bucket: string,
  key: string,
  options: StorageApiOptions & { versionId?: string } = {},
): Promise<FileInfo> {
  const query = options.versionId ? `?versionId=${encodeURIComponent(options.versionId)}` : "";
  return call(`/object/info/${encodePath(bucket, key)}${query}`, { method: "GET" }, options);
}

/** One page of {@linkcode listFilesV2}. */
export interface FilePage {
  /** Whether another page follows (pass `nextCursor` for it). */
  hasNext: boolean;
  /** The folders at this level (with `withDelimiter`). */
  folders: { name: string; key: string }[];
  /** The files. */
  objects: (FileEntry & { key: string })[];
  /** The next page's cursor. */
  nextCursor?: string;
}

/**
 * List files with a cursor (Supabase's `listV2`): every file under `prefix`, or — with
 * `withDelimiter` — one level of it, folders apart.
 *
 * @param bucket The bucket.
 * @param options Prefix, cursor, page size, delimiter, sort and version filters.
 * @returns One page.
 */
export function listFilesV2(
  bucket: string,
  options: StorageApiOptions & {
    prefix?: string;
    cursor?: string;
    limit?: number;
    withDelimiter?: boolean;
    sortBy?: { column: "name" | "created_at" | "updated_at"; order?: "asc" | "desc" };
    noncurrentVersions?: "exclude" | "include" | "only";
    deleteMarkers?: "exclude" | "include" | "only";
  } = {},
): Promise<FilePage> {
  const { apiBase: _a, signal: _s, withDelimiter, ...query } = options;
  return call(`/object/list-v2/${encodeURIComponent(bucket)}`, {
    method: "POST",
    body: { ...query, with_delimiter: withDelimiter === true },
  }, options);
}

/**
 * Delete files; returns the ones deleted (a key the caller may not delete, or that does not
 * exist, is skipped).
 *
 * @param bucket The bucket.
 * @param keys The keys (at most 1000).
 * @param options Where the API is.
 * @returns The deleted files' rows.
 */
export function removeFiles(
  bucket: string,
  keys: (string | { path: string; versionId: string })[],
  options: StorageApiOptions = {},
): Promise<{ name: string }[]> {
  return call(`/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    body: { prefixes: keys },
  }, options);
}

/**
 * Move (rename) a file, within the bucket or into `destinationBucket`.
 *
 * @param bucket The bucket.
 * @param from The source key.
 * @param to The destination key (must not exist).
 * @param options The destination bucket; where the API is.
 */
export async function moveFile(
  bucket: string,
  from: string,
  to: string,
  options: StorageApiOptions & { destinationBucket?: string } = {},
): Promise<void> {
  await call("/object/move", {
    method: "POST",
    body: {
      bucketId: bucket,
      sourceKey: from,
      destinationKey: to,
      destinationBucket: options.destinationBucket,
    },
  }, options);
}

/**
 * Copy a file, within the bucket or into `destinationBucket`.
 *
 * @param bucket The bucket.
 * @param from The source key.
 * @param to The destination key.
 * @param options The destination bucket; where the API is.
 * @returns The new file's `bucket/key`.
 */
export async function copyFile(
  bucket: string,
  from: string,
  to: string,
  options: StorageApiOptions & { destinationBucket?: string } = {},
): Promise<string> {
  const { Key } = await call<{ Key: string }>("/object/copy", {
    method: "POST",
    body: {
      bucketId: bucket,
      sourceKey: from,
      destinationKey: to,
      destinationBucket: options.destinationBucket,
    },
  }, options);
  return Key;
}

/**
 * Signed download URLs for several files; `null` where one is missing or not readable.
 *
 * @param bucket The bucket.
 * @param keys The keys (at most 1000).
 * @param options Lifetime (seconds, default 3600); where the API is.
 * @returns The URLs, in order.
 */
export async function getSignedUrls(
  bucket: string,
  keys: string[],
  options: StorageApiOptions & { expiresIn?: number } = {},
): Promise<(string | null)[]> {
  const signed = await call<{ signedURL: string | null }[]>(
    `/object/sign/${encodeURIComponent(bucket)}`,
    { method: "POST", body: { paths: keys, expiresIn: options.expiresIn ?? 3600 } },
    options,
  );
  const base = apiBaseOf(options.apiBase);
  return signed.map((s) => s.signedURL ? encodeURI(base + s.signedURL) : null);
}

/**
 * The stable URL of a file in a public bucket (no request is made).
 *
 * @param bucket The bucket.
 * @param key The key.
 * @param options An image transform; `download` to serve it as an attachment.
 * @returns The URL.
 */
export function getPublicUrl(
  bucket: string,
  key: string,
  options: { apiBase?: string; transform?: ImageTransformOptions; download?: boolean | string } =
    {},
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.transform ?? {})) {
    if (value !== undefined) query.set(name, String(value));
  }
  if (options.download) query.set("download", options.download === true ? "" : options.download);
  const route = options.transform ? "/render/image/public/" : "/object/public/";
  const path = `${apiBaseOf(options.apiBase)}${route}${encodePath(bucket, key)}`;
  return query.size ? `${path}?${query}` : path;
}

/** Options for {@linkcode uploadResumable}. */
export interface ResumableUploadOptions extends StorageApiOptions {
  /** The content type (default: the file's `type`, else `application/octet-stream`). */
  contentType?: string;
  /** `Cache-Control` seconds or directives (default `3600`). */
  cacheControl?: string;
  /** Replace an existing file. */
  upsert?: boolean;
  /** Bytes per `PATCH` (default 6 MiB). */
  chunkSize?: number;
  /** Retries of a failed chunk, after asking the server where it got to (default 3). */
  retries?: number;
  /** Called as chunks are accepted. */
  onProgress?: (progress: { loaded: number; total: number }) => void;
  /**
   * A signed upload token (`createSignedUploadUrl`'s): the upload is authorized by it rather than
   * the page's session (sent as `x-signature` to `/upload/resumable/sign`).
   */
  signature?: string;
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** The headers every TUS request carries (and a signed upload's token). */
function tus(options: ResumableUploadOptions): Record<string, string> {
  return {
    "tus-resumable": "1.0.0",
    ...(options.signature ? { "x-signature": options.signature } : {}),
  };
}

/**
 * Upload a file resumably (TUS 1.0.0), chunk by chunk: a dropped chunk is retried from the
 * offset the server reports, and a cancelled upload is terminated on the server.
 *
 * @param bucket The bucket.
 * @param key The key.
 * @param file The file (any Blob).
 * @param options Type, cache control, upsert, chunking, progress, cancellation.
 * @returns The key.
 */
export async function uploadResumable(
  bucket: string,
  key: string,
  file: Blob,
  options: ResumableUploadOptions = {},
): Promise<{ key: string }> {
  const url = await createUpload(bucket, key, file, options);
  try {
    await sendChunks(url, file, options);
  } catch (err) {
    if (options.signal?.aborted) {
      await fetch(url, { method: "DELETE", credentials: "same-origin", headers: tus(options) })
        .then((r) => r.body?.cancel(), () => {});
    }
    throw err;
  }
  return { key };
}

/** POST the upload; returns its URL. */
async function createUpload(
  bucket: string,
  key: string,
  file: Blob,
  options: ResumableUploadOptions,
): Promise<string> {
  const endpoint = `${apiBaseOf(options.apiBase)}/upload/resumable${
    options.signature ? "/sign" : ""
  }`;
  const metadata = [
    ["bucketName", bucket],
    ["objectName", key],
    ["contentType", options.contentType ?? (file.type || "application/octet-stream")],
    ["cacheControl", options.cacheControl ?? "3600"],
  ].map(([k, v]) => `${k} ${base64(v)}`).join(",");
  const created = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...tus(options),
      "upload-length": String(file.size),
      "upload-metadata": metadata,
      ...(options.upsert ? { "x-upsert": "true" } : {}),
    },
    signal: options.signal,
  });
  if (created.status !== 201) throw await failure(created);
  const location = created.headers.get("location")!;
  const origin = (globalThis as { location?: { href: string } }).location?.href;
  return /^https?:/.test(location) || !origin ? location : new URL(location, origin).href;
}

/** PATCH one chunk at `offset`; returns the server's new offset. */
async function patchChunk(
  url: string,
  file: Blob,
  offset: number,
  options: ResumableUploadOptions,
): Promise<number> {
  const chunkSize = Math.max(1, options.chunkSize ?? 6 * 1024 * 1024);
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      ...tus(options),
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
    },
    body: file.slice(offset, offset + chunkSize),
    signal: options.signal,
  });
  if (res.status === 409) {
    await res.body?.cancel();
    return await serverOffset(url, options);
  }
  if (res.status !== 204) throw await failure(res);
  return Number(res.headers.get("upload-offset"));
}

/** Send the chunks; a dropped one is retried from the offset the server reports. */
async function sendChunks(url: string, file: Blob, options: ResumableUploadOptions) {
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    options.signal?.throwIfAborted();
    try {
      offset = await patchChunk(url, file, offset, options);
      failures = 0;
      options.onProgress?.({ loaded: offset, total: file.size });
    } catch (err) {
      if (err instanceof StorageApiClientError || options.signal?.aborted) throw err;
      if (++failures > (options.retries ?? 3)) throw err;
      offset = await serverOffset(url, options);
    }
  }
}

async function serverOffset(url: string, options: ResumableUploadOptions): Promise<number> {
  const signal = options.signal;
  const res = await fetch(url, {
    method: "HEAD",
    credentials: "same-origin",
    headers: tus(options),
    signal,
  });
  if (!res.ok) throw new StorageApiClientError("resume_failed", res.status, "the upload is gone");
  return Number(res.headers.get("upload-offset"));
}
