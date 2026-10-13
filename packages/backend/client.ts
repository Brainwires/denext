/**
 * `@denext/backend/client` — browser helpers: upload a file with progress (multipart
 * automatically for large files on S3), get a URL to show one, keep a realtime table's rows
 * live with `useTableChanges`, and query `backend({ rest })`'s tables with `from("table")`.
 *
 * ```tsx
 * "use client";
 * import { getFileUrl, uploadFile } from "@denext/backend/client";
 *
 * async function onPick(file: File) {
 *   const { key } = await uploadFile("avatars", file, {
 *     onProgress: ({ loaded, total }) => console.log(`${Math.round((loaded / total) * 100)}%`),
 *   });
 *   const src = await getFileUrl("avatars", key, { transform: { width: 256 } });
 * }
 * ```
 *
 * Both call the plugin's `POST /_denext/storage/sign` with the page's cookies, so the bucket's
 * `authorize` sees the signed-in user. `useTableChanges` rides denext's Live socket; every row it
 * receives was re-read under this viewer's row-level security. This module imports no server
 * code.
 *
 * @module
 */

import { STORAGE_PREFIX, type StorageTransform } from "./src/shared.ts";

export type { StorageTransform } from "./src/shared.ts";
export { applyTableChanges, useTableChanges } from "./src/table-changes-client.ts";
export { from, restClient, RestClientError, rpc } from "./src/rest-client.ts";
export type {
  ExplainOptions,
  RegisteredRest,
  RestClient,
  RestClientOptions,
  RestColumnName,
  RestCount,
  RestFilterValue,
  RestNegatable,
  RestQuery,
  RestReferenced,
  RestResult,
  RestTableName,
  RestTableQuery,
  RestTables,
  RestTableShape,
  RestTableShapeOf,
  RpcOptions,
  SelectColumns,
  Selected,
} from "./src/rest-client.ts";
export type {
  TableChangesError,
  TableChangesState,
  UseTableChangesOptions,
} from "./src/table-changes-client.ts";
export type {
  TableChange,
  TableChangesFrame,
  TableEvent,
  TableFilter,
} from "./src/realtime-shared.ts";

/** Upload progress, in bytes. */
export interface UploadProgress {
  /** Bytes sent so far. */
  loaded: number;
  /** Bytes in the file. */
  total: number;
}

/** Options for {@linkcode uploadFile}. */
export interface UploadFileOptions {
  /** The object key (default: a random id plus the file's extension). */
  key?: string;
  /** The content type (default: the file's `type`, else `application/octet-stream`). */
  contentType?: string;
  /** Called as bytes are sent. */
  onProgress?: (progress: UploadProgress) => void;
  /** Cancels the upload (a multipart upload is aborted on the server too). */
  signal?: AbortSignal;
  /** Parts in flight at once for a multipart upload (default 4). */
  concurrency?: number;
  /** The plugin's endpoint (default: `<basePath>/_denext/storage`). */
  endpoint?: string;
}

/** A stored file. */
export interface UploadedFile {
  /** Its key in the bucket. */
  key: string;
  /** Size in bytes. */
  size: number;
  /** The content type it was stored with. */
  contentType: string;
  /** An opaque version tag. */
  etag?: string;
}

/** Options for {@linkcode getFileUrl}. */
export interface FileUrlOptions {
  /** Resize / re-encode an image on download. */
  transform?: StorageTransform;
  /** Seconds a signed URL stays valid (default 3600; a public bucket's URL does not expire). */
  expiresIn?: number;
  /** The plugin's endpoint (default: `<basePath>/_denext/storage`). */
  endpoint?: string;
}

/** A refused or failed storage request. */
export class StorageClientError extends Error {
  /** The machine-readable reason (`forbidden`, `too_large`, `mime_not_allowed`, …). */
  readonly code: string;
  /** The HTTP status. */
  readonly status: number;

  /**
   * Create a client error.
   *
   * @param code The reason.
   * @param status The HTTP status.
   * @param message A human-readable message.
   */
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "StorageClientError";
    this.code = code;
    this.status = status;
  }
}

interface SignedPut {
  key: string;
  url: string;
  headers: Record<string, string>;
  token: string;
}

interface MultipartPlan {
  key: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
  token: string;
}

type UploadPlan = { upload: SignedPut } | { multipart: MultipartPlan };

function endpointOf(explicit?: string): string {
  if (explicit) return explicit.replace(/\/$/, "");
  const base = (globalThis as { __denextBasePath?: string }).__denextBasePath ?? "";
  return base + STORAGE_PREFIX;
}

/** Call the sign route; a non-2xx answer throws its error envelope as a StorageClientError. */
async function sign<T>(endpoint: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${endpoint}/sign`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (res.ok) return await res.json() as T;
  throw await clientError(res);
}

async function clientError(res: Response): Promise<StorageClientError> {
  const text = await res.text().catch(() => "");
  try {
    const { error } = JSON.parse(text) as { error: { code: string; message: string } };
    return new StorageClientError(error.code, res.status, error.message);
  } catch {
    return new StorageClientError("http_error", res.status, text || `HTTP ${res.status}`);
  }
}

/** What one PUT answered. */
interface PutResult {
  etag: string | null;
}

/** PUT `body` with progress: XMLHttpRequest in a browser, `fetch` (no progress) elsewhere. */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onSent: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<PutResult> {
  if (typeof XMLHttpRequest === "undefined") {
    return putWithFetch(url, body, headers, onSent, signal);
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onSent(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onSent(body.size);
        resolve({ etag: xhr.getResponseHeader("etag") });
      } else {
        reject(xhrError(xhr));
      }
    };
    xhr.onerror = () => reject(new StorageClientError("network_error", 0, "upload failed"));
    xhr.onabort = () => reject(new DOMException("upload aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function xhrError(xhr: XMLHttpRequest): StorageClientError {
  try {
    const { error } = JSON.parse(xhr.responseText) as { error: { code: string; message: string } };
    return new StorageClientError(error.code, xhr.status, error.message);
  } catch {
    return new StorageClientError("http_error", xhr.status, `upload failed (HTTP ${xhr.status})`);
  }
}

async function putWithFetch(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onSent: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<PutResult> {
  const res = await fetch(url, { method: "PUT", headers, body, signal });
  if (!res.ok) throw await clientError(res);
  await res.body?.cancel();
  onSent(body.size);
  return { etag: res.headers.get("etag") };
}

/** Upload every part, `concurrency` at a time, reporting the summed progress. */
async function putParts(
  file: Blob,
  plan: MultipartPlan,
  concurrency: number,
  report: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ partNumber: number; etag: string }[]> {
  const sent = new Array<number>(plan.parts.length).fill(0);
  const etags = new Array<string>(plan.parts.length);
  let next = 0;
  const worker = async () => {
    while (next < plan.parts.length) {
      const i = next++;
      const start = i * plan.partSize;
      const chunk = file.slice(start, Math.min(start + plan.partSize, file.size));
      const { etag } = await put(plan.parts[i].url, chunk, {}, (n) => {
        sent[i] = n;
        report(sent.reduce((a, b) => a + b, 0));
      }, signal);
      if (!etag) {
        throw new StorageClientError(
          "missing_etag",
          0,
          "the store did not expose the ETag header (add it to the bucket's CORS ExposeHeaders)",
        );
      }
      etags[i] = etag;
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, plan.parts.length)) }, worker),
  );
  return etags.map((etag, i) => ({ partNumber: i + 1, etag }));
}

/**
 * Upload a file to a bucket: ask the server for a signed upload (the bucket's `authorize`,
 * size cap and allow-list decide), send the bytes straight to the store with progress, then
 * have the server verify what arrived. Files above the server's multipart threshold on S3 go
 * up in parts.
 *
 * @param bucket The bucket name.
 * @param file The file (or any Blob).
 * @param options Key, content type, progress, cancellation.
 * @returns The stored file.
 */
export async function uploadFile(
  bucket: string,
  file: Blob,
  options: UploadFileOptions = {},
): Promise<UploadedFile> {
  const endpoint = endpointOf(options.endpoint);
  const contentType = options.contentType ?? (file.type || "application/octet-stream");
  const filename = (file as { name?: string }).name;
  const plan = await sign<UploadPlan>(endpoint, {
    op: "upload",
    bucket,
    contentType,
    size: file.size,
    ...(options.key !== undefined ? { key: options.key } : {}),
    ...(filename ? { filename } : {}),
  }, options.signal);
  const report = (loaded: number) => options.onProgress?.({ loaded, total: file.size });
  if ("upload" in plan) {
    await put(plan.upload.url, file, plan.upload.headers, report, options.signal);
    return await complete(endpoint, plan.upload.token, undefined, options.signal);
  }
  try {
    const parts = await putParts(
      file,
      plan.multipart,
      options.concurrency ?? 4,
      report,
      options.signal,
    );
    return await complete(endpoint, plan.multipart.token, parts, options.signal);
  } catch (err) {
    await sign(endpoint, { op: "abort", token: plan.multipart.token }).catch(() => {});
    throw err;
  }
}

async function complete(
  endpoint: string,
  token: string,
  parts: { partNumber: number; etag: string }[] | undefined,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const { object } = await sign<{ object: UploadedFile }>(endpoint, {
    op: "complete",
    token,
    ...(parts ? { parts } : {}),
  }, signal);
  return { key: object.key, size: object.size, contentType: object.contentType, etag: object.etag };
}

/**
 * A URL to display or download an object: stable for a public bucket, signed and expiring
 * otherwise (the bucket's `authorize` decides, for op `download`). With `transform`, an image
 * is resized and re-encoded on the way out.
 *
 * @param bucket The bucket name.
 * @param key The object key.
 * @param options Transform, lifetime.
 * @returns The URL.
 */
export async function getFileUrl(
  bucket: string,
  key: string,
  options: FileUrlOptions = {},
): Promise<string> {
  const { url } = await sign<{ url: string }>(endpointOf(options.endpoint), {
    op: "download",
    bucket,
    key,
    ...(options.transform ? { transform: options.transform } : {}),
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
  });
  return url;
}
