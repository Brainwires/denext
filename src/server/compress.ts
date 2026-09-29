// Response compression for dynamic responses — denext's equivalent of Next.js's `compress`
// (on by default, gzip; `compress: false` in denext.config turns it off, and
// `compress: { encodings: ["br", "gzip"] }` adds brotli).
//
// `createApp` runs every response it produces through {@link compressResponse}: rendered
// HTML (buffered or streamed), Flight/JSON soft-navigation payloads, and route-handler
// bodies of a compressible type. The encoder is `node:zlib` (gzip, and brotli → `Content-Encoding:
// br` when configured), flushed EXPLICITLY after every burst (`Z_SYNC_FLUSH` /
// `BROTLI_OPERATION_FLUSH`), so a streamed Suspense/PPR document stays progressive: each chunk
// the renderer emits is decodable by the browser as soon as it arrives. Not the web
// `CompressionStream`: whether it flushes per written chunk is unspecified, and Deno 2.9.7's
// does not (gzip emits its header, brotli nothing, until the stream closes), which held a
// streamed page back until its last Suspense hole resolved. Chunks that arrive in the same tick
// are coalesced first (up to {@link COALESCE_MAX_BYTES}) so a renderer that emits many tiny
// chunks does not pay a flush — and its ratio cost — per chunk.
//
// BREACH: like Next.js (whose server gzips everything compressible) and nginx/Cloudflare
// defaults, denext does not try to detect "secret reflected next to user input" — no
// server can tell which bytes are secret. denext's own surfaces carry no per-request secret
// in the HTML (the CSP is hash-based, not nonce-based; Server Actions are CSRF-gated by
// Origin, not by an embedded token). A route that does embed one next to reflected input
// opts out with `export const compress = false`, or the whole app with `compress: false`.

import zlib from "node:zlib";

/** A body chunk: bytes over a plain (non-shared) `ArrayBuffer`, as streams carry them. */
type Bytes = Uint8Array<ArrayBuffer>;

/** A content coding denext produces. */
export type ContentCoding = "br" | "gzip";

/** Bodies of a known length below this many bytes are sent as-is (the framing costs more). */
export const COMPRESS_THRESHOLD = 1024;

/** Coalesce same-tick chunks up to this many bytes before one compress-and-flush. */
const COALESCE_MAX_BYTES = 64 * 1024;

/**
 * Brotli quality for dynamic bodies. zlib's default (11) is an offline setting, far too slow
 * per request; 5 is in the range CDNs use for on-the-fly brotli.
 */
const BROTLI_QUALITY = 5;

/** Statuses whose response has no body to encode, or a body that must not be re-encoded. */
const NO_BODY_STATUS = new Set([101, 204, 205, 206, 304]);

/**
 * The codings produced when `compress` is on without `{ encodings }`: gzip only, as Next.js's
 * `compress`. Brotli (at {@link BROTLI_QUALITY}) is opt-in: markedly smaller output for about two
 * to three times gzip's CPU per dynamic response.
 */
const DEFAULT_ENCODINGS: readonly ContentCoding[] = ["gzip"];

/**
 * Pick the content coding for an `Accept-Encoding` header: among `encodings` (the server's
 * preference order, default {@link DEFAULT_ENCODINGS}), the acceptable one (`q > 0`) with the
 * highest q-value, the earlier listed winning a tie. `*` covers a coding the header does not
 * name; `x-gzip` is an alias of `gzip`. Null when none is acceptable (identity is sent).
 *
 * @param header The request's `Accept-Encoding`, or null.
 * @param encodings The codings the server may produce, most preferred first.
 * @returns `"br"`, `"gzip"`, or null.
 */
export function negotiateEncoding(
  header: string | null,
  encodings: readonly ContentCoding[] = DEFAULT_ENCODINGS,
): ContentCoding | null {
  if (!header) return null;
  const q = parseAcceptEncoding(header);
  const star = q.get("*");
  let best: ContentCoding | null = null;
  let bestQ = 0;
  for (const coding of encodings) {
    const value = coding === "gzip"
      ? q.get("gzip") ?? q.get("x-gzip") ?? star ?? 0
      : q.get(coding) ?? star ?? 0;
    if (value > bestQ) {
      best = coding;
      bestQ = value;
    }
  }
  return best;
}

/**
 * The codings a `compress` setting produces: {@link DEFAULT_ENCODINGS} for `true` / omitted,
 * the listed ones (unknown names and duplicates dropped) for `{ encodings }`, none for
 * `false`.
 *
 * @param setting The `compress` config value.
 * @returns The codings, most preferred first.
 */
export function compressEncodings(
  setting: boolean | { encodings?: readonly string[] } | undefined,
): readonly ContentCoding[] {
  if (setting === false) return [];
  if (setting === undefined || setting === true || setting.encodings === undefined) {
    return DEFAULT_ENCODINGS;
  }
  const out: ContentCoding[] = [];
  for (const name of setting.encodings) {
    if ((name === "gzip" || name === "br") && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Whether the header forbids the identity coding (`identity;q=0`, or `*;q=0` without it). */
function identityForbidden(header: string | null): boolean {
  if (!header) return false;
  const q = parseAcceptEncoding(header);
  const identity = q.get("identity") ?? q.get("*");
  return identity === 0;
}

/** `Accept-Encoding` → coding → q-value (lower-cased names; a malformed q counts as 0). */
function parseAcceptEncoding(header: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [k, v] = param.split("=");
      if (k.trim().toLowerCase() !== "q") continue;
      const n = Number(v?.trim());
      q = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
    }
    out.set(name, q);
  }
  return out;
}

/**
 * Whether a `Content-Type` is worth compressing: text (except `text/event-stream`, which
 * must reach the client unbuffered), JSON / JavaScript / XML (and their `+json` / `+xml`
 * structured-syntax suffixes), WebAssembly and SVG. Everything else — images, fonts, audio,
 * video, archives, `application/octet-stream`, or no type at all — is already compressed or
 * unknown, and is sent as-is.
 *
 * @param contentType The response's `Content-Type`, or null.
 */
export function isCompressibleType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "text/event-stream") return false;
  if (type.startsWith("text/")) return true;
  if (type === "image/svg+xml") return true;
  if (!type.startsWith("application/")) return false;
  const sub = type.slice("application/".length);
  return sub.endsWith("+json") || sub.endsWith("+xml") || COMPRESSIBLE_APPLICATION.has(sub);
}

/** `application/*` subtypes that compress well (the `+json`/`+xml` suffixes are separate). */
const COMPRESSIBLE_APPLICATION = new Set([
  "json",
  "javascript",
  "x-javascript",
  "ecmascript",
  "xml",
  "x-ndjson",
  "wasm",
  "x-www-form-urlencoded",
  "rtf",
]);

/** Why a response is sent uncompressed — `null` when it may be compressed. */
function skipReason(request: Request, response: Response): string | null {
  if (request.method === "HEAD") return "head";
  if (!response.body) return "no-body";
  if (NO_BODY_STATUS.has(response.status) || response.status < 200) return "status";
  const h = response.headers;
  if (h.has("content-encoding")) return "encoded";
  if (h.has("content-range")) return "range";
  if (h.get("upgrade")) return "upgrade";
  if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(h.get("cache-control") ?? "")) {
    return "no-transform";
  }
  if (!isCompressibleType(h.get("content-type"))) return "type";
  return null;
}

/** Options for {@linkcode compressResponse}. */
export interface CompressOptions {
  /**
   * Compress bodies of unknown length only when at least this many bytes are available
   * within the first tick, and skip known-length bodies below it. Default
   * {@link COMPRESS_THRESHOLD}.
   */
  threshold?: number;
  /**
   * The codings to produce, most preferred first (see {@link negotiateEncoding}). Default
   * {@link DEFAULT_ENCODINGS} (gzip). Empty: nothing is encoded.
   */
  encodings?: readonly ContentCoding[];
}

/**
 * Compress `response` for `request` when the client accepts one of `options.encodings` (gzip
 * by default) and nothing
 * rules it out (see the module header and {@link skipReason}): the body is piped through a
 * flushing encoder ({@link encoderStream}), `Content-Encoding` is set, `Content-Length` and `Accept-Ranges`
 * are dropped, a strong `ETag` is weakened (the bytes changed), and `Vary: Accept-Encoding`
 * is added whenever the representation depends on the header. Anything else returns the
 * response untouched (a body of unknown length that turns out to be tiny is re-wrapped
 * with the bytes it already read).
 *
 * @param request The request the response answers (method + `Accept-Encoding`).
 * @param response The response to encode.
 * @param options Tuning (the size threshold, the codings to produce).
 * @returns The (possibly) compressed response.
 */
export async function compressResponse(
  request: Request,
  response: Response,
  options: CompressOptions = {},
): Promise<Response> {
  const encodings = options.encodings ?? DEFAULT_ENCODINGS;
  if (encodings.length === 0 || skipReason(request, response) !== null) return response;
  const threshold = options.threshold ?? COMPRESS_THRESHOLD;
  const accept = request.headers.get("accept-encoding");
  const mustEncode = identityForbidden(accept);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) < threshold && !mustEncode) return response;
  // From here the representation depends on Accept-Encoding, compressed or not.
  const coding = negotiateEncoding(accept, encodings);
  if (!coding) return withVary(response);
  let body = response.body!;
  if (declared === null && !mustEncode) {
    const sniffed = await sniffSmallBody(body, threshold);
    if (sniffed.small) return rewrap(response, sniffed.small);
    body = sniffed.stream;
  }
  const headers = new Headers(response.headers);
  headers.set("content-encoding", coding);
  headers.delete("content-length");
  headers.delete("accept-ranges");
  appendVary(headers);
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  const encoded = body
    .pipeThrough(coalesceChunks())
    .pipeThrough(encoderStream(coding));
  return new Response(encoded, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * {@link compressResponse}, but a compressor failure never fails the request: the identity
 * response goes out instead. The shape every server path (createApp, the SPA servers) uses.
 *
 * @param request The request the response answers.
 * @param response The response to encode.
 * @param encodings The codings to produce, most preferred first (default gzip).
 * @returns The (possibly) compressed response.
 */
export async function compressOrPassThrough(
  request: Request,
  response: Response,
  encodings: readonly ContentCoding[] = DEFAULT_ENCODINGS,
): Promise<Response> {
  try {
    return await compressResponse(request, response, { encodings });
  } catch {
    return response;
  }
}

/** The response with `Vary: Accept-Encoding` added (mutating in place when it can). */
function withVary(response: Response): Response {
  try {
    appendVary(response.headers);
    return response;
  } catch {
    // Immutable headers (a `Response.redirect`, a proxied fetch response): re-wrap.
    const headers = new Headers(response.headers);
    appendVary(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Add `Accept-Encoding` to `Vary` unless it (or `*`) is already there. */
function appendVary(headers: Headers): void {
  const vary = headers.get("vary");
  if (!vary) return headers.set("vary", "Accept-Encoding");
  const names = vary.split(",").map((v) => v.trim().toLowerCase());
  if (names.includes("*") || names.includes("accept-encoding")) return;
  headers.set("vary", `${vary}, Accept-Encoding`);
}

/**
 * A new response carrying `bytes` (already read from `response`'s body) as its body. No
 * `Vary`: a body this small is sent as identity to every client.
 */
function rewrap(response: Response, bytes: Bytes): Response {
  return new Response(bytes.byteLength === 0 ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

/** The outcome of {@link sniffSmallBody}. */
type Sniffed =
  | { small: Bytes; stream?: undefined }
  | { small?: undefined; stream: ReadableStream<Bytes> };

/** Settles on the next macrotask — "whatever the body has ready right now". */
const TICK = Symbol("tick");

/**
 * Read what a body of unknown length has ready — chunks only while each arrives within the
 * current tick (the response is never held back waiting on its body) — until `threshold`
 * bytes. A body that
 * ends below the threshold comes back whole (`small`: not worth compressing, e.g. a
 * `Response.json({ ok: true })`); otherwise a stream that replays the bytes read and
 * continues the source.
 */
async function sniffSmallBody(
  body: ReadableStream<Bytes>,
  threshold: number,
): Promise<Sniffed> {
  const reader = body.getReader();
  const head: Bytes[] = [];
  let total = 0;
  let pending: Promise<ReadableStreamReadResult<Bytes>> = reader.read();
  while (total < threshold) {
    // Never wait on the body: headers go out now, even when the first byte is still coming.
    // A source that errors is handled like one still pending: the replay stream below re-awaits
    // `pending` and errors with it, exactly as the identity body would have. (Throwing here
    // instead would hand the caller back a response whose body this reader has locked.)
    const result = await raceTick(pending).catch((): typeof TICK => TICK);
    if (result === TICK) break; // more is coming, just not yet: compress the stream
    if (result.done) return { small: concat(head, total) };
    head.push(toBytes(result.value));
    total += result.value.byteLength;
    pending = reader.read();
  }
  let next: Promise<ReadableStreamReadResult<Bytes>> | null = pending;
  let i = 0;
  const stream = new ReadableStream<Bytes>({
    async pull(controller) {
      if (i < head.length) {
        controller.enqueue(head[i++]);
        return;
      }
      const result = await (next ?? reader.read());
      next = null;
      if (result.done) controller.close();
      else controller.enqueue(toBytes(result.value));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream };
}

/** `promise`, or {@link TICK} if it has not settled by the next macrotask. */
function raceTick<T>(promise: Promise<T>): Promise<T | typeof TICK> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<typeof TICK>((resolve) => {
    timer = setTimeout(() => resolve(TICK), 0);
  });
  return Promise.race([promise, tick]).finally(() => clearTimeout(timer));
}

/** A body chunk as bytes (a hand-built stream may enqueue strings). */
function toBytes(chunk: Bytes | string): Bytes {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
}

/** Concatenate `chunks` (`total` bytes) into one array. */
function concat(chunks: Bytes[], total: number): Bytes {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Merge chunks that arrive in the same tick into one (flushed on the next macrotask, or at
 * {@link COALESCE_MAX_BYTES}), so the per-chunk flush of the compressor runs once per burst
 * rather than once per tiny renderer write. A chunk after a real wait (a Suspense hole that
 * resolved later) is flushed on its own tick — the stream stays progressive. Exported for tests.
 *
 * @returns The coalescing transform.
 */
export function coalesceChunks(): TransformStream<Bytes, Bytes> {
  let buffered: Bytes[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = (controller: TransformStreamDefaultController<Bytes>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (size === 0) return;
    const merged = concat(buffered, size);
    buffered = [];
    size = 0;
    try {
      controller.enqueue(merged);
    } catch { /* the reader went away (client disconnect) — nothing left to deliver */ }
  };
  return new TransformStream<Bytes, Bytes>({
    transform(chunk, controller) {
      const bytes = toBytes(chunk);
      if (bytes.byteLength === 0) return;
      buffered.push(bytes);
      size += bytes.byteLength;
      if (size >= COALESCE_MAX_BYTES) drain(controller);
      else if (timer === undefined) timer = setTimeout(() => drain(controller), 0);
    },
    flush(controller) {
      drain(controller);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}

/**
 * A gzip or brotli encoder (`node:zlib`) that flushes after every chunk it is given, so each
 * chunk is decodable on arrival (chunks come from {@link coalesceChunks}: one per burst).
 *
 * @param coding The content coding.
 * @returns The encoding transform.
 */
function encoderStream(coding: ContentCoding): TransformStream<Bytes, Bytes> {
  const z = coding === "gzip" ? zlib.createGzip() : zlib.createBrotliCompress({
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
  });
  const flushMode = coding === "gzip"
    ? zlib.constants.Z_SYNC_FLUSH
    : zlib.constants.BROTLI_OPERATION_FLUSH;
  let out!: TransformStreamDefaultController<Bytes>;
  let failure: unknown;
  z.on("data", (data: Uint8Array) => {
    try {
      out.enqueue(new Uint8Array(data)); // a copy: zlib may reuse its output buffer
    } catch { /* the reader went away (client disconnect) */ }
  });
  z.on("error", (err: unknown) => {
    failure = err;
    try {
      out.error(err);
    } catch { /* already errored or closed */ }
  });
  /** Run `op` and resolve once zlib has called back (or reject with its error). */
  const settle = (op: (done: () => void) => void) =>
    new Promise<void>((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      op(() => (failure === undefined ? resolve() : reject(failure)));
    });
  return new TransformStream<Bytes, Bytes>({
    start(controller) {
      out = controller;
    },
    transform(chunk) {
      return settle((done) => {
        z.write(chunk);
        z.flush(flushMode, done);
      });
    },
    flush() {
      return settle((done) => {
        z.once("end", done);
        z.end();
      });
    },
    cancel() {
      z.destroy();
    },
  });
}
