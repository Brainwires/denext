// The S3 driver: AWS S3, Cloudflare R2, MinIO and other S3-compatible stores, over plain
// `fetch` with SigV4 signing (./sigv4.ts) — no SDK, no npm. A denext bucket is a key prefix in
// one S3 bucket (`<bucket>/<key>`). Browsers upload and download directly through presigned
// URLs; uploads above the multipart threshold use presigned part URLs.

import { StorageError } from "./errors.ts";
import { type AwsCredentials, presignUrl, sha256Hex, signRequest } from "./sigv4.ts";
import { concat } from "./streams.ts";
import type {
  ByteRange,
  DirectAccess,
  ListedObject,
  ListResult,
  ObjectInfo,
  PutInfo,
  StorageDriver,
  StoredObject,
} from "./types.ts";

/** Options for {@link s3}. */
export interface S3DriverOptions {
  /**
   * The endpoint, for a store other than AWS: `https://<account>.r2.cloudflarestorage.com`,
   * `http://127.0.0.1:9000` (MinIO). Default: AWS (`https://s3.<region>.amazonaws.com`), or
   * `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` when set.
   */
  endpoint?: string;
  /** The region (`us-east-1`; R2 takes `auto`). */
  region: string;
  /** The S3 bucket every denext bucket lives in (as a key prefix). */
  bucket: string;
  /**
   * Credentials. Default: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and (for temporary
   * credentials) `AWS_SESSION_TOKEN`, read when a request is signed.
   */
  credentials?: AwsCredentials;
  /**
   * Address the bucket in the path (`https://host/<bucket>/<key>`) instead of the host
   * (`https://<bucket>.host/<key>`). Default: virtual-host style on AWS, path style with a
   * custom `endpoint` (what MinIO and most self-hosted stores expect).
   */
  pathStyle?: boolean;
  /**
   * The endpoint a BROWSER reaches the store at, when it differs from {@link endpoint} — the
   * Docker stack's MinIO is `http://minio:9000` inside the containers but `http://localhost:9000`
   * (or a public host) outside them. Every URL handed to a client (presigned uploads, downloads,
   * multipart parts) is signed for this host; the server's own calls keep `endpoint`. Default:
   * `S3_PUBLIC_ENDPOINT`, else `endpoint`.
   */
  publicEndpoint?: string;
  /** The `fetch` to call (tests, proxies). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Server-side part size for a streamed upload of unknown length (≥ S3's 5 MiB minimum). */
const SERVER_PART_SIZE = 8 * 1024 * 1024;

interface Endpoint {
  origin: string;
  /** The path prefix before the object key (`/<bucket>` path-style, `` virtual-host). */
  prefix: string;
}

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the store is: for the server's own calls, or (`publicFacing`) for the URLs handed to a
 * browser — `publicEndpoint` / `S3_PUBLIC_ENDPOINT` when set, addressed the same way.
 */
function endpointOf(options: S3DriverOptions, publicFacing = false): Endpoint {
  const server = options.endpoint ?? env("AWS_ENDPOINT_URL_S3") ?? env("AWS_ENDPOINT_URL");
  const publicUrl = publicFacing ? options.publicEndpoint ?? env("S3_PUBLIC_ENDPOINT") : undefined;
  const configured = publicUrl ?? server;
  const base = new URL(configured ?? `https://s3.${options.region}.amazonaws.com`);
  const pathStyle = options.pathStyle ?? (server !== undefined || publicUrl !== undefined);
  if (pathStyle) return { origin: base.origin, prefix: `/${options.bucket}` };
  return { origin: `${base.protocol}//${options.bucket}.${base.host}`, prefix: "" };
}

function credentialsOf(options: S3DriverOptions): AwsCredentials {
  if (options.credentials) return options.credentials;
  const accessKeyId = env("AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new StorageError(
      "not_configured",
      "s3(): no credentials — pass `credentials` or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY",
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken: env("AWS_SESSION_TOKEN") };
}

/** Decode the XML entities S3 emits. */
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (e[0] !== "#") return named[e.toLowerCase()];
    return String.fromCodePoint(
      e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
    );
  });
}

/** The text of the first `<name>` element in `xml`, or `undefined`. */
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlText(m[1]) : undefined;
}

/** Every `<name>…</name>` block in `xml`. */
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

function unquote(etag: string | null | undefined): string | undefined {
  return etag ? etag.replace(/^(W\/)?"|"$/g, "") : undefined;
}

/** Decode a key S3 returned with `encoding-type=url` (form-encoded: `+` is a space). */
function urlDecodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, "%20"));
}

/**
 * The S3 storage driver: `s3({ region, bucket })` (AWS), or with an `endpoint` for R2 / MinIO.
 * Uploads from the browser go straight to the store with presigned URLs (multipart above the
 * plugin's threshold); downloads are presigned GETs, or go through the plugin when an image
 * transform is asked for. The bucket's CORS must allow the app's origin to `PUT` (and expose
 * the `ETag` header, for multipart).
 *
 * @param options Endpoint, region, bucket, credentials.
 * @returns The driver.
 */
export function s3(options: S3DriverOptions): StorageDriver {
  if (!options?.bucket || !options.region) {
    throw new TypeError("s3(): `region` and `bucket` are required");
  }
  const client = new S3Client(options);
  return {
    name: "s3",
    get location() {
      return endpointOf(options).origin;
    },
    put: (bucket, key, body, info) => client.put(`${bucket}/${key}`, key, body, info),
    get: (bucket, key, range) => client.get(`${bucket}/${key}`, key, range),
    head: (bucket, key) => client.head(`${bucket}/${key}`, key),
    remove: (bucket, key) => client.remove(`${bucket}/${key}`),
    list: (bucket, prefix, opts) => client.list(bucket, prefix, opts),
    copy: (fromBucket, fromKey, toBucket, toKey) =>
      client.copy(`${fromBucket}/${fromKey}`, `${toBucket}/${toKey}`, toKey),
    direct: client.direct(),
  };
}

interface Call {
  method: string;
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/** The S3 REST calls the driver makes, signed. */
class S3Client {
  readonly #options: S3DriverOptions;
  readonly #fetch: typeof fetch;

  constructor(options: S3DriverOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  #scope() {
    return {
      region: this.#options.region,
      service: "s3",
      credentials: credentialsOf(this.#options),
    };
  }

  #path(objectKey?: string, publicFacing = false): { origin: string; path: string } {
    const { origin, prefix } = endpointOf(this.#options, publicFacing);
    return { origin, path: objectKey === undefined ? prefix || "/" : `${prefix}/${objectKey}` };
  }

  /** Make one signed call; a non-2xx answer (other than 404 when `allow404`) throws. */
  async call(c: Call, allow404 = false): Promise<Response | null> {
    const { origin, path } = this.#path(c.key);
    const body = c.body ?? new Uint8Array();
    const payloadHash = await sha256Hex(body);
    const signed = await signRequest(
      { method: c.method, origin, path, query: c.query, headers: c.headers },
      this.#scope(),
      payloadHash,
    );
    delete signed.headers.host; // fetch sets it
    const res = await this.#fetch(signed.url, {
      method: c.method,
      headers: signed.headers,
      body: c.body && c.method !== "GET" && c.method !== "HEAD" ? c.body as BodyInit : undefined,
    });
    if (res.ok) return res;
    if (res.status === 404 && allow404) {
      await res.body?.cancel();
      return null;
    }
    throw await s3Error(res, c.method);
  }

  #info(res: Response, key: string, size: number): ObjectInfo {
    const modified = res.headers.get("last-modified");
    return {
      key,
      size,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      etag: unquote(res.headers.get("etag")),
      lastModified: modified ? new Date(modified) : undefined,
    };
  }

  async put(
    objectKey: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    info: PutInfo,
  ): Promise<ObjectInfo> {
    const reader = body.getReader();
    const first = await readChunk(reader, SERVER_PART_SIZE);
    if (first.done) {
      const res = await this.call({
        method: "PUT",
        key: objectKey,
        headers: { "content-type": info.contentType },
        body: first.bytes,
      });
      await res!.body?.cancel();
      return { ...this.#info(res!, key, first.bytes.byteLength), contentType: info.contentType };
    }
    return await this.#putMultipart(objectKey, key, reader, first.bytes, info);
  }

  async #putMultipart(
    objectKey: string,
    key: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    firstPart: Uint8Array,
    info: PutInfo,
  ): Promise<ObjectInfo> {
    const uploadId = await this.createMultipart(objectKey, info.contentType);
    const parts: { partNumber: number; etag: string }[] = [];
    let size = 0;
    try {
      let chunk: { bytes: Uint8Array; done: boolean } = { bytes: firstPart, done: false };
      while (chunk.bytes.byteLength > 0) {
        const res = await this.call({
          method: "PUT",
          key: objectKey,
          query: { partNumber: String(parts.length + 1), uploadId },
          body: chunk.bytes,
        });
        await res!.body?.cancel();
        parts.push({ partNumber: parts.length + 1, etag: res!.headers.get("etag") ?? "" });
        size += chunk.bytes.byteLength;
        if (chunk.done) break;
        chunk = await readChunk(reader, SERVER_PART_SIZE);
      }
      await this.completeMultipart(objectKey, uploadId, parts);
    } catch (err) {
      await reader.cancel().catch(() => {});
      await this.abortMultipart(objectKey, uploadId).catch(() => {});
      throw err;
    }
    return { key, size, contentType: info.contentType, lastModified: new Date() };
  }

  async get(objectKey: string, key: string, range?: ByteRange): Promise<StoredObject | null> {
    const headers: Record<string, string> = range
      ? { range: `bytes=${range.start}-${range.end}` }
      : {};
    const res = await this.call({ method: "GET", key: objectKey, headers }, true);
    if (!res) return null;
    const total = res.status === 206
      ? Number(res.headers.get("content-range")?.split("/")[1])
      : Number(res.headers.get("content-length"));
    return {
      ...this.#info(res, key, total),
      body: res.body ?? new Blob([]).stream(),
      ...(range && res.status === 206 ? { range } : {}),
    };
  }

  async head(objectKey: string, key: string): Promise<ObjectInfo | null> {
    const res = await this.call({ method: "HEAD", key: objectKey }, true);
    return res ? this.#info(res, key, Number(res.headers.get("content-length") ?? 0)) : null;
  }

  async remove(objectKey: string): Promise<void> {
    const res = await this.call({ method: "DELETE", key: objectKey }, true);
    await res?.body?.cancel();
  }

  async list(
    bucket: string,
    prefix: string,
    options: { limit: number; cursor?: string },
  ): Promise<ListResult> {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: `${bucket}/${prefix}`,
      "max-keys": String(options.limit),
      "encoding-type": "url",
    };
    if (options.cursor) query["continuation-token"] = options.cursor;
    const xml = await (await this.call({ method: "GET", query }))!.text();
    const strip = bucket.length + 1;
    const objects: ListedObject[] = blocks(xml, "Contents").map((c) => {
      const modified = tag(c, "LastModified");
      return {
        key: urlDecodeKey(tag(c, "Key") ?? "").slice(strip),
        size: Number(tag(c, "Size") ?? 0),
        etag: unquote(tag(c, "ETag")),
        lastModified: modified ? new Date(modified) : undefined,
      };
    });
    const next = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    return next ? { objects, cursor: next } : { objects };
  }

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    const res = await this.call({
      method: "POST",
      key: objectKey,
      query: { uploads: "" },
      headers: { "content-type": contentType },
    });
    const id = tag(await res!.text(), "UploadId");
    if (!id) {
      throw new StorageError("driver_error", "s3: CreateMultipartUpload returned no UploadId");
    }
    return id;
  }

  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    const escape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const xml = `<CompleteMultipartUpload>${
      parts.map((p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escape(p.etag)}</ETag></Part>`
      ).join("")
    }</CompleteMultipartUpload>`;
    const res = await this.call({
      method: "POST",
      key: objectKey,
      query: { uploadId },
      headers: { "content-type": "application/xml" },
      body: new TextEncoder().encode(xml),
    });
    // S3 can answer 200 with an <Error> body when the assembly fails late.
    const text = await res!.text();
    if (text.includes("<Error>")) throw s3ErrorFromXml(text, 500, "POST");
  }

  /** `CopyObject` (up to 5 GiB): the content type travels with it. */
  async copy(fromObjectKey: string, toObjectKey: string, key: string): Promise<ObjectInfo> {
    const encoded = fromObjectKey.split("/").map(encodeURIComponent).join("/");
    const res = await this.call({
      method: "PUT",
      key: toObjectKey,
      headers: { "x-amz-copy-source": `/${this.#options.bucket}/${encoded}` },
    });
    // S3 can answer 200 with an <Error> body when the copy fails late.
    const text = await res!.text();
    if (text.includes("<Error>")) throw s3ErrorFromXml(text, 500, "PUT");
    const info = await this.head(toObjectKey, key);
    if (!info) throw new StorageError("driver_error", "s3: the copied object is missing");
    return info;
  }

  /** Upload one part of a multipart upload from the server; returns its ETag. */
  async uploadPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<string> {
    const res = await this.call({
      method: "PUT",
      key: objectKey,
      query: { partNumber: String(partNumber), uploadId },
      body,
    });
    await res!.body?.cancel();
    return res!.headers.get("etag") ?? "";
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    const res = await this.call({ method: "DELETE", key: objectKey, query: { uploadId } }, true);
    await res?.body?.cancel();
  }

  async presign(
    method: string,
    objectKey: string,
    expiresIn: number,
    extra: { query?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<string> {
    // Signed for the host the browser will send (SigV4 signs `Host`).
    const { origin, path } = this.#path(objectKey, true);
    return await presignUrl(
      { method, origin, path, query: extra.query, headers: extra.headers },
      this.#scope(),
      expiresIn,
    );
  }

  direct(): DirectAccess {
    const k = (bucket: string, key: string) => `${bucket}/${key}`;
    return {
      presignPut: (bucket, key, { expiresIn, contentType, size }) =>
        this.presign("PUT", k(bucket, key), expiresIn, {
          headers: {
            "content-type": contentType,
            ...(size !== undefined ? { "content-length": String(size) } : {}),
          },
        }),
      presignGet: (bucket, key, { expiresIn, disposition, contentType }) =>
        this.presign("GET", k(bucket, key), expiresIn, {
          query: {
            ...(disposition ? { "response-content-disposition": disposition } : {}),
            ...(contentType ? { "response-content-type": contentType } : {}),
          },
        }),
      createMultipart: (bucket, key, contentType) =>
        this.createMultipart(k(bucket, key), contentType),
      presignPart: (bucket, key, uploadId, partNumber, expiresIn, size) =>
        this.presign("PUT", k(bucket, key), expiresIn, {
          query: { partNumber: String(partNumber), uploadId },
          ...(size !== undefined ? { headers: { "content-length": String(size) } } : {}),
        }),
      completeMultipart: (bucket, key, uploadId, parts) =>
        this.completeMultipart(k(bucket, key), uploadId, parts),
      abortMultipart: (bucket, key, uploadId) => this.abortMultipart(k(bucket, key), uploadId),
      uploadPart: (bucket, key, uploadId, partNumber, body) =>
        this.uploadPart(k(bucket, key), uploadId, partNumber, body),
    };
  }
}

/** Read at least `size` bytes; `done` when the stream ended first. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  size: number,
): Promise<{ bytes: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < size) {
    const next = await reader.read();
    if (next.done) return { bytes: concat(chunks, got), done: true };
    chunks.push(next.value);
    got += next.value.byteLength;
  }
  // A part may run past `size` by the last chunk's overshoot: S3 caps parts at 5 GiB, not
  // at a fixed size, so the excess simply rides in this part.
  return { bytes: concat(chunks, got), done: false };
}

function s3ErrorFromXml(xml: string, status: number, method: string): StorageError {
  const code = tag(xml, "Code") ?? `HTTP ${status}`;
  const message = tag(xml, "Message") ?? "";
  const mapped = status === 404 ? "not_found" : "driver_error";
  return new StorageError(mapped, `s3 ${method}: ${code}${message ? ` — ${message}` : ""}`);
}

async function s3Error(res: Response, method: string): Promise<StorageError> {
  const text = method === "HEAD" ? "" : await res.text().catch(() => "");
  return s3ErrorFromXml(text, res.status, method);
}
