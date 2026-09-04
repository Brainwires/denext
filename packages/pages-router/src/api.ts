// Pages Router API routes: adapt a Web `Request` to Next's imperative
// `(req, res)` handler contract and collect the `res` calls into a `Response`.
// (Global middleware runs earlier in denext's pipeline, before this handler.)

import type { RouteParams } from "@denext/denext/server";
import { revalidatePath } from "@denext/denext/server";
import { clearPreviewCookie, previewSecrets, setPreviewCookie, signPreview } from "./preview.ts";

/** The `req` object passed to a Pages API handler (Next `NextApiRequest` subset). */
export interface ApiRequest {
  method: string;
  url: string;
  /** Route params merged with URL search params. */
  query: Record<string, string | string[]>;
  /** Parsed `Cookie` header. */
  cookies: Record<string, string>;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Parsed body (JSON object, form object, or text), or undefined for GET/HEAD. */
  body: unknown;
}

/** The `res` object passed to a Pages API handler (Next `NextApiResponse` subset). */
export interface ApiResponse {
  statusCode: number;
  status(code: number): ApiResponse;
  setHeader(name: string, value: string | number | string[]): ApiResponse;
  getHeader(name: string): string | null;
  json(body: unknown): ApiResponse;
  send(body: unknown): ApiResponse;
  end(body?: unknown): ApiResponse;
  redirect(statusOrUrl: number | string, url?: string): ApiResponse;
  write(chunk: string): ApiResponse;
  /**
   * On-demand ISR (Next's `res.revalidate`): purge the cached render for `path` so the
   * next request regenerates it. Purge-only — an unknown/bad path is a safe no-op, never
   * a re-render, so it cannot poison the page cache. Returns a promise you can await.
   */
  revalidate(path: string): Promise<void>;
  /**
   * Enable Preview Mode: set a signed, httpOnly cookie carrying `data`, so a later
   * `getStaticProps`/`getServerSideProps` sees `context.preview === true` +
   * `context.previewData` and the static cache is bypassed. `maxAge` defaults to the
   * session (cleared when the browser closes).
   */
  setPreviewData(data: unknown, options?: { maxAge?: number }): ApiResponse;
  /** Disable Preview Mode: clear the preview cookie. */
  clearPreviewData(): ApiResponse;
}

/** A deferred preview-cookie mutation, applied (signed) when the response finalizes. */
type PreviewAction =
  | { kind: "set"; data: unknown; maxAge?: number }
  | { kind: "clear" };

/** `export const config` for an API route (Next's `bodyParser` subset). */
export interface ApiRouteConfig {
  api?: {
    /**
     * `false` leaves the body **unparsed** — `req.body` is the raw `Uint8Array`
     * (for webhooks that verify a signature over the exact bytes). An object opts
     * into parsing with a `sizeLimit` (e.g. `"500kb"`, `"2mb"`, or a byte count).
     */
    bodyParser?: false | { sizeLimit?: string | number };
    /** Reserved for parity; denext resolves the response when the handler returns. */
    externalResolver?: boolean;
  };
}

/** A Pages API handler module. */
export interface ApiModule {
  default?: (req: ApiRequest, res: ApiResponse) => unknown;
  /** `export const config` — body-parsing options. */
  config?: ApiRouteConfig;
}

/** Parse a Next size-limit (`"1mb"`, `"500kb"`, `1024`) into bytes; default 1 MiB. */
function parseSizeLimit(limit: string | number | undefined): number {
  if (typeof limit === "number") return limit;
  if (!limit) return 1024 * 1024; // Next's default bodyParser sizeLimit is 1mb
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!m) return 1024 * 1024;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return Math.floor(n * mult);
}

/** Raised when a request body exceeds the configured `sizeLimit`. */
class BodyTooLargeError extends Error {}

/** Parse a `Cookie` header into a name→value map. */
function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return out;
}

/** Read the request body as bytes, enforcing `sizeLimit`. */
async function readBytes(
  request: Request,
  sizeLimit: number,
): Promise<Uint8Array> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > sizeLimit) throw new BodyTooLargeError();
  return new Uint8Array(buf);
}

/**
 * Parse a `multipart/form-data` body into a plain object: text fields become
 * strings (repeated names become arrays), and file parts become `File` objects.
 */
async function parseMultipart(
  request: Request,
): Promise<Record<string, unknown>> {
  const form = await request.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}

/** Build the `req` object from a Web Request. */
async function buildReq(
  request: Request,
  params: RouteParams,
  url: URL,
  config: ApiRouteConfig | undefined,
): Promise<ApiRequest> {
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers) headers[k] = v;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return {
    method: request.method,
    url: url.pathname + url.search,
    query: mergeQuery(params, url),
    cookies: parseCookies(request.headers.get("cookie")),
    headers,
    body: hasBody ? await parseBody(request, config?.api?.bodyParser) : undefined,
  };
}

/** Route params merged with the URL search params (a repeated key becomes an array). */
function mergeQuery(params: RouteParams, url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = { ...params };
  for (const [k, v] of url.searchParams) {
    const existing = query[k];
    if (existing === undefined) query[k] = v;
    else query[k] = Array.isArray(existing) ? [...existing, v] : [existing as string, v];
  }
  return query;
}

/**
 * The request body. `bodyParser: false` → hand back the raw bytes unparsed (webhook
 * signatures); otherwise parse by content type under the size limit. A malformed body
 * → undefined (Next parity); an oversized one still throws.
 */
async function parseBody(
  request: Request,
  bodyParser: NonNullable<ApiRouteConfig["api"]>["bodyParser"],
): Promise<unknown> {
  if (bodyParser === false) return new Uint8Array(await request.arrayBuffer());
  const sizeLimit = parseSizeLimit(bodyParser === undefined ? undefined : bodyParser.sizeLimit);
  try {
    return await parseTypedBody(request, request.headers.get("content-type") ?? "", sizeLimit);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return undefined;
  }
}

/** Parse a body by content type: JSON, form-urlencoded, multipart, else text. */
async function parseTypedBody(request: Request, ct: string, sizeLimit: number): Promise<unknown> {
  if (ct.includes("application/json")) {
    return JSON.parse(new TextDecoder().decode(await readBytes(request, sizeLimit)));
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = new TextDecoder().decode(await readBytes(request, sizeLimit));
    return Object.fromEntries(new URLSearchParams(text));
  }
  // denext convenience: multipart is parsed into fields + `File`s (Next requires an
  // external parser). The size limit is not enforced here — the platform streams parts —
  // so gate large uploads at the edge if needed.
  if (ct.includes("multipart/form-data")) return await parseMultipart(request);
  return new TextDecoder().decode(await readBytes(request, sizeLimit));
}

/** A `res` object plus a promise that resolves to the final Response. */
function buildRes(): {
  res: ApiResponse;
  done: Promise<Response>;
  finish: () => void;
  preview: () => PreviewAction | null;
  streaming: () => boolean;
} {
  const b = new ResponseBuilder();
  return {
    res: b,
    done: b.done,
    finish: () => b.finish(),
    preview: () => b.previewAction,
    streaming: () => b.streaming,
  };
}

const encoder = new TextEncoder();
const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : encoder.encode(typeof v === "string" ? v : String(v));

/**
 * The Node-style `res` handed to a Pages API handler. Buffered by default (`json`/
 * `send`/`end`/`redirect` resolve `done` once); the first `write()` before a terminal
 * call switches into chunked/SSE mode — the status + headers flush immediately (as a
 * streamed Response) and subsequent writes enqueue until `end()` (or the handler
 * returning) closes the stream.
 */
class ResponseBuilder implements ApiResponse {
  statusCode = 200;
  readonly done: Promise<Response>;
  /** Recorded synchronously (Next parity); signed + written when runApiRoute finalizes. */
  previewAction: PreviewAction | null = null;
  #headers = new Headers();
  #body: BodyInit | null = null;
  #finished = false;
  #resolve: (r: Response) => void = () => {};
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #streamClosed = false;

  constructor() {
    this.done = new Promise<Response>((r) => (this.#resolve = r));
  }

  get streaming(): boolean {
    return this.#writer !== null;
  }

  #beginStream(): WritableStreamDefaultWriter<Uint8Array> {
    const ts = new TransformStream<Uint8Array, Uint8Array>();
    this.#writer = ts.writable.getWriter();
    this.#finished = true; // status/headers are flushed now; a later buffered finish() is a no-op
    this.#resolve(new Response(ts.readable, { status: this.statusCode, headers: this.#headers }));
    return this.#writer;
  }

  #closeStream(): void {
    if (this.#writer && !this.#streamClosed) {
      this.#streamClosed = true;
      void this.#writer.close().catch(() => {});
    }
  }

  finish(): void {
    if (this.#writer) {
      this.#closeStream(); // a streamed response is already sent; just close the stream
      return;
    }
    if (this.#finished) return;
    this.#finished = true;
    this.#resolve(new Response(this.#body, { status: this.statusCode, headers: this.#headers }));
  }

  status(code: number): ApiResponse {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number | string[]): ApiResponse {
    this.#headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  getHeader(name: string): string | null {
    return this.#headers.get(name);
  }

  #jsonBody(value: unknown): void {
    if (!this.#headers.has("content-type")) this.#headers.set("content-type", "application/json");
    this.#body = JSON.stringify(value);
  }

  json(value: unknown): ApiResponse {
    this.#jsonBody(value);
    this.finish();
    return this;
  }

  send(value: unknown): ApiResponse {
    if (value != null && typeof value === "object" && !(value instanceof Uint8Array)) {
      this.#jsonBody(value);
    } else {
      this.#body = value as BodyInit;
    }
    this.finish();
    return this;
  }

  end(value?: unknown): ApiResponse {
    if (this.#writer) {
      if (value != null && !this.#streamClosed) {
        void this.#writer.write(toBytes(value)).catch(() => {});
      }
      this.#closeStream();
      return this;
    }
    if (value != null) this.#body = value as BodyInit;
    this.finish();
    return this;
  }

  redirect(statusOrUrl: number | string, url?: string): ApiResponse {
    const [code, location] = typeof statusOrUrl === "number"
      ? [statusOrUrl, url ?? "/"]
      : [307, statusOrUrl];
    this.statusCode = code;
    this.#headers.set("location", location);
    this.finish();
    return this;
  }

  write(chunk: string): ApiResponse {
    if (this.#streamClosed) return this; // stream already ended — drop late writes
    if (this.#finished && !this.#writer) return this; // buffered response already sent
    const w = this.#writer ?? this.#beginStream();
    void w.write(toBytes(chunk)).catch(() => {});
    return this;
  }

  revalidate(path: string): Promise<void> {
    return revalidatePath(path);
  }

  setPreviewData(data: unknown, options?: { maxAge?: number }): ApiResponse {
    this.previewAction = { kind: "set", data, maxAge: options?.maxAge };
    return this;
  }

  clearPreviewData(): ApiResponse {
    this.previewAction = { kind: "clear" };
    return this;
  }
}

/** Apply a recorded preview action to the finalized response (signs the cookie). */
async function applyPreview(
  response: Response,
  action: PreviewAction,
  secure: boolean,
): Promise<void> {
  if (action.kind === "clear") {
    response.headers.append("set-cookie", clearPreviewCookie(secure));
    return;
  }
  const token = await signPreview(action.data, previewSecrets()[0]);
  response.headers.append(
    "set-cookie",
    setPreviewCookie(token, { secure, maxAge: action.maxAge }),
  );
}

/**
 * Run a Pages API handler against a Web Request and return its Response. A handler
 * that never ends the response is finalized with whatever it set (mirroring Next's
 * lenient behavior) once it returns.
 */
export async function runApiRoute(
  mod: ApiModule,
  request: Request,
  params: RouteParams,
  url: URL,
): Promise<Response> {
  const handler = mod.default;
  if (typeof handler !== "function") {
    return new Response("API route has no default export", { status: 500 });
  }
  let req: ApiRequest;
  try {
    req = await buildReq(request, params, url, mod.config);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return new Response("Body exceeded size limit", { status: 413 });
    }
    throw err;
  }
  const { res, done, finish, preview, streaming } = buildRes();
  const secure = url.protocol === "https:";
  // Finalize: apply any recorded preview cookie (async signing) to the response.
  const finalize = async (response: Response): Promise<Response> => {
    const action = preview();
    if (action) await applyPreview(response, action, secure);
    return response;
  };

  // Run the handler. A **streaming** handler resolves `done` at its first `res.write()`, so
  // we return the streamed Response immediately and let the handler keep writing — essential
  // for SSE / long-lived streams (awaiting the whole handler would defeat streaming). A
  // **buffered** handler resolves `done` when it ends the response, or via the finish()
  // fallback when it returns. An unhandled throw *before any output* surfaces a 500 (or the
  // handler's own >= 400 status), matching the previous buffered contract.
  let earlyError: Response | null = null;
  const running = (async () => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!streaming() && (!res.statusCode || res.statusCode < 400)) {
        console.error("@denext/pages-router: API route threw:", error);
        earlyError = new Response("Internal Server Error", { status: 500 });
        return; // return the 500 — do NOT finalize the (empty) buffered body
      }
      // Threw after setting a >= 400 status (or mid-stream): finalize/close what it produced.
    }
    finish(); // close a stream / finalize a buffered response the handler didn't end
  })();

  // Return whichever comes first: the response becoming available (early for streaming, at
  // finish() for buffered) or an early handler error.
  const response = await new Promise<Response>((resolveOuter) => {
    done.then(resolveOuter);
    running.then(() => {
      if (earlyError) resolveOuter(earlyError);
    });
  });
  return await finalize(response);
}
