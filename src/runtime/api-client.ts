// Typed API client (2.0 Pillar V, network-boundary type safety).
//
// The runtime half of typed route handlers. `denext build` / `denext dev` generate
// `.denext/api.ts` — an `ApiSchema` describing every `app/**/route.ts` handler's params,
// request body, and response body (recovered from `TypedRequest`/`TypedResponse`; see
// src/build/api-types.ts). Passing that schema to `createApiClient` yields a callable that
// is type-checked end-to-end against your own API, with no extra dependency:
//
//   import { createApiClient } from "denext";
//   import type { ApiSchema } from "./.denext/api.ts";
//   const api = createApiClient<ApiSchema>();
//   const user = await api("/api/user/[id]", "GET", { params: { id: "1" } });
//   //    ^? the handler's response type — a wrong param name or method is a type error
//
// The runtime is a thin `fetch` wrapper: it substitutes params into the route pattern,
// appends the query, encodes a body through the wire codec (Date / Map / Set / BigInt survive;
// the `x-denext-wire` header is set only when needed), parses the JSON response (decoding it
// when the server flagged it), and turns a non-2xx into an `ApiClientError` carrying the
// server's error envelope. It works from a Server Component, a client component, a test, or
// any other `fetch` context.

/** The HTTP methods a route handler may export. */
export type { HttpMethod } from "../server/types.ts";
import type { HttpMethod } from "../server/types.ts";
import { decodeWire, encodeWire, stableKey, WIRE_HEADER } from "./wire-codec.ts";
import { type Batcher, createBatcher } from "./api-batch.ts";
import { getApiDispatcher } from "./api-dispatch.ts";

/** One endpoint's typed shape: its params, optional request/response bodies, query, error codes. */
export interface ApiEndpoint {
  /** Path params for the route's dynamic segments (absent for a fully-static route). */
  params?: Record<string, string | string[]>;
  /** The JSON request body the handler parses (absent when it reads none). */
  body?: unknown;
  /** The typed query record of a `defineApi` route (absent → free-form strings). */
  query?: unknown;
  /** The JSON response body the handler returns (`unknown` when it isn't a `TypedResponse`). */
  response?: unknown;
  /** The error codes a call may fail with (an endpoint's declared codes + the builtins). */
  errors?: string;
}

/** A whole app's API surface: route pattern → (method → endpoint). */
export type ApiSchema = Record<string, Partial<Record<HttpMethod, ApiEndpoint>>>;

/**
 * Augmentation target for the generated `.denext/api.ts`: `declare module "denext" { interface
 * RegisteredApi { schema: ApiSchema } }` makes `createApiClient()` typed with no type argument.
 */
// deno-lint-ignore no-empty-interface
export interface RegisteredApi {}

/** The registered app schema when `.denext/api.ts` is imported, else the open `ApiSchema`. */
export type RegisteredSchema = RegisteredApi extends { schema: infer S extends ApiSchema } ? S
  : ApiSchema;

// ── Request/response type mapping ────────────────────────────────────────────

/** The keys of `T` that are required (used to decide whether the opts arg is optional). */
export type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** The options object for one endpoint: `params`/`body`/`query` are typed when the route declares them. */
export type RequestOf<E extends ApiEndpoint> =
  & (E extends { params: infer P } ? { params: P } : unknown)
  & (E extends { body: infer B } ? { body: B } : unknown)
  & (E extends { query: infer Q } ? TypedQuery<Q> : FreeQuery)
  & {
    /** Extra request headers (merged over the JSON content-type). */
    headers?: HeadersInit;
    /** Abort signal forwarded to `fetch` (composed with the default timeout). */
    signal?: AbortSignal;
    /** Per-request timeout in ms (default 30000). Bounds a hanging endpoint. */
    timeoutMs?: number;
    /** Opt this call out of in-flight dedupe (GET/HEAD calls with equal inputs share one fetch). */
    dedupe?: boolean;
    /** Opt this call out of batching (GET/HEAD calls in one tick ride one `/_denext/api-batch` POST). */
    batch?: boolean;
    /** SSR only: Next-style fetch cache mode for the in-process call (`"force-cache"` / `"no-store"`). */
    cache?: RequestCache;
    /** SSR only: cache the in-process call for `revalidate` seconds and/or under `tags`. */
    next?: { revalidate?: number | false; tags?: string[] };
  };

/** Free-form query strings (an endpoint without a `query` schema). */
export interface FreeQuery {
  /** Extra query-string params appended to the URL. */
  query?: Record<string, string>;
}

/** A schema-typed query, required; an uninformative (`any`/`unknown`) schema stays free-form. */
export type TypedQuery<Q> = unknown extends Q ? FreeQuery : { query: Q };

/** The awaited response type for one endpoint. */
export type ResponseOf<E extends ApiEndpoint> = E extends { response: infer R } ? R : unknown;

/** The error codes a call to one endpoint may fail with. */
export type ErrorsOf<E extends ApiEndpoint> = E extends { errors: infer C extends string } ? C
  : string;

/** The trailing call args: the opts object is required only when it has a required key. */
export type RequestArgs<E extends ApiEndpoint> = RequiredKeys<RequestOf<E>> extends never
  ? [opts?: RequestOf<E>]
  : [opts: RequestOf<E>];

/** A typed callable over an app's {@link ApiSchema}. */
export interface ApiClient<S extends ApiSchema> {
  <P extends keyof S & string, M extends keyof S[P] & HttpMethod>(
    path: P,
    method: M,
    ...args: RequestArgs<NonNullable<S[P][M]>>
  ): Promise<ResponseOf<NonNullable<S[P][M]>>>;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

/** Options accepted by the untyped runtime call (the typed client narrows these). */
export interface ApiRequestOptions {
  /** Values for the route pattern's dynamic segments (a catch-all takes a `string[]`). */
  params?: Record<string, string | string[]>;
  /** A JSON request body (serialized with `JSON.stringify`). */
  body?: unknown;
  /** Query-string params appended to the URL (arrays repeat the key; other values stringify). */
  query?: Record<string, unknown>;
  /** Extra request headers (merged over the JSON content-type). */
  headers?: HeadersInit;
  /** Abort signal forwarded to `fetch` (composed with the default timeout). */
  signal?: AbortSignal;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Opt this call out of in-flight dedupe. */
  dedupe?: boolean;
  /** Opt this call out of batching. */
  batch?: boolean;
  /** SSR only: Next-style fetch cache mode for the in-process call. */
  cache?: RequestCache;
  /** SSR only: cache the in-process call for `revalidate` seconds and/or under `tags`. */
  next?: { revalidate?: number | false; tags?: string[] };
}

/** Options for {@link createApiClient}. */
export interface ApiClientOptions {
  /** Origin/base prefix for every request (default: relative to the current origin). */
  base?: string;
  /**
   * Share one in-flight fetch between concurrent GET/HEAD calls with equal path, params,
   * query, body, and headers (default true). Mutations are never deduped. In the browser the
   * in-flight table is per client instance; during SSR it is per request (never shared across
   * requests), and off outside a request.
   */
  dedupe?: boolean;
  /**
   * Coalesce the GET/HEAD calls made in one tick into a single `POST /_denext/api-batch`
   * (default true; `{ maxItems }` caps a batch, default 20). A call with custom headers or a
   * body, a mutation, or `batch: false` always goes as its own request; a single pending call
   * skips the batch framing entirely.
   */
  batch?: boolean | { maxItems?: number };
  /** The `fetch` to use (default: the global; a seam for tests and custom transports). */
  fetch?: typeof fetch;
}

/** The default per-request timeout (ms) — bounds a server-side call so SSR can't hang forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Compose the caller's signal (if any) with a default timeout so a request always terminates. */
function resolveSignal(
  caller: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/** Encode one param value; a catch-all is a `string[]` (or a `/`-joined string) of segments. */
function encodeParam(value: string | string[]): string {
  const segments = Array.isArray(value) ? value : value.split("/");
  return segments.map(encodeURIComponent).join("/");
}

/** Serialize a query record: arrays repeat the key, `undefined` is skipped, else `String(v)`. */
function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) { for (const item of v) qs.append(k, String(item)); }
    else qs.append(k, String(v));
  }
  return qs.toString();
}

/**
 * Substitute path params into a route pattern, appending any query params.
 *
 * @param pattern A route pattern like `/api/user/[id]` or `/files/[...path]`.
 * @param params Values for the pattern's dynamic segments.
 * @param query Extra query-string params.
 * @returns The concrete request path (relative; prefix with a base to make it absolute).
 */
export function buildPath(
  pattern: string,
  params?: Record<string, string | string[]>,
  query?: Record<string, unknown>,
): string {
  const path = pattern.replace(/\[\[?\.{0,3}([^\]]+)\]?\]/g, (_m, name: string) => {
    const value = params?.[name];
    if (value == null) throw new Error(`denext api client: missing param "${name}" for ${pattern}`);
    return encodeParam(value);
  });
  const qs = queryString(query);
  return qs ? `${path}?${qs}` : path;
}

/**
 * A failed typed API call: the HTTP status plus, when the server answered with denext's JSON
 * error envelope (`{ error: { code, status, message, data?, fieldErrors?, digest? } }` — an
 * `ApiError`, a validation failure, a control signal, or a redacted 500), the envelope's
 * fields. `code` narrows to the endpoint's declared codes (`ErrorsOf<E>`); a non-envelope
 * failure (a plain text 500, an HTML error page) has `code: "http_error"`.
 */
export class ApiClientError<Code extends string = string> extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The HTTP status text. */
  readonly statusText: string;
  /** The request method. */
  readonly method: HttpMethod;
  /** The request URL. */
  readonly url: string;
  /** The envelope's machine-readable code, or `"http_error"` without an envelope. */
  readonly code: Code | "http_error";
  /** Structured detail the server attached. */
  readonly data?: unknown;
  /** Per-field validation messages (a 400 `validation`). */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** The redaction digest of an internal error (correlates with the server log). */
  readonly digest?: string;
  /** The server's `x-request-id`. */
  readonly requestId?: string;

  /**
   * Build the error for a non-2xx response.
   *
   * @param method The request method.
   * @param url The request URL.
   * @param res The failed response (status/headers; the body is passed separately).
   * @param envelope The parsed error envelope body, when the server sent one.
   */
  constructor(method: HttpMethod, url: string, res: Response, envelope?: ApiErrorEnvelope) {
    const e = envelope?.error;
    super(
      e?.message
        ? `denext api client: ${method} ${url} → ${res.status} ${e.code}: ${e.message}`
        : `denext api client: ${method} ${url} → ${res.status} ${res.statusText}`,
    );
    this.name = "ApiClientError";
    this.status = res.status;
    this.statusText = res.statusText;
    this.method = method;
    this.url = url;
    this.code = (e?.code as Code) ?? "http_error";
    if (e?.data !== undefined) this.data = e.data;
    if (e?.fieldErrors) this.fieldErrors = e.fieldErrors;
    if (e?.digest) this.digest = e.digest;
    const id = res.headers.get("x-request-id");
    if (id) this.requestId = id;
  }
}

/** The shape of denext's JSON error envelope (the server's `ApiErrorBody`). */
export interface ApiErrorEnvelope {
  /** The error. */
  error: {
    /** Machine-readable code. */
    code: string;
    /** HTTP status. */
    status?: number;
    /** Human-readable message. */
    message?: string;
    /** Structured detail. */
    data?: unknown;
    /** Per-field messages. */
    fieldErrors?: Record<string, string>;
    /** Redaction digest. */
    digest?: string;
  };
}

/**
 * Is `value` an {@link ApiClientError}?
 *
 * @param value The caught value.
 * @returns True for a typed API client failure.
 */
export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof Error && value.name === "ApiClientError";
}

/** Bound on how much of a failed response body is read to look for the error envelope. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Read a failed response's envelope (bounded; a huge or non-JSON body yields undefined). */
async function readErrorEnvelope(res: Response): Promise<ApiErrorEnvelope | undefined> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  const ct = res.headers.get("content-type") ?? "";
  if (declared > MAX_ERROR_BODY_BYTES || !ct.includes("application/json")) {
    await res.body?.cancel();
    return undefined;
  }
  try {
    const text = await res.text();
    if (text.length > MAX_ERROR_BODY_BYTES) return undefined;
    const parsed = JSON.parse(text) as unknown;
    const body = res.headers.get(WIRE_HEADER) === "1" ? decodeWire(parsed) : parsed;
    const err = (body as { error?: { code?: unknown } } | null)?.error;
    return err && typeof err.code === "string" ? (body as ApiErrorEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a successful response: JSON (codec-decoded when flagged), or undefined for no body. */
async function readResult(res: Response): Promise<unknown> {
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    await res.body?.cancel();
    return undefined;
  }
  const parsed = await res.json();
  return res.headers.get(WIRE_HEADER) === "1" ? decodeWire(parsed) : parsed;
}

/**
 * Perform one typed API request (the runtime the typed client dispatches to). Substitutes
 * params, encodes a body through the wire codec (flagging it only when a tag was needed), and
 * parses the JSON response (decoding it when the server flagged it; a 204/empty body →
 * undefined). A non-2xx response throws an {@link ApiClientError} carrying the server's error
 * envelope when there is one.
 *
 * @param pattern The route pattern to call.
 * @param method The HTTP method.
 * @param opts Params, body, query, headers, and abort signal.
 * @param base Optional origin/base prefix (default: relative to the current origin).
 * @param fetchImpl The `fetch` to use (default: the global).
 * @returns The parsed response body.
 */
export async function apiRequest(
  pattern: string,
  method: HttpMethod,
  opts: ApiRequestOptions = {},
  base = "",
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const url = base + buildPath(pattern, opts.params, opts.query);
  const headers = new Headers(opts.headers);
  let body: string | undefined;
  if (opts.body !== undefined) {
    const encoded = encodeWire(opts.body);
    body = encoded.body;
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (encoded.tagged) headers.set(WIRE_HEADER, "1");
  }
  const signal = resolveSignal(opts.signal, opts.timeoutMs);
  // On the server inside a request, the installed dispatcher runs the call in-process (the full
  // pipeline, this request's cookies, the tag cache) — no loopback HTTP. `null` → real fetch.
  const inProcess = serverDispatch(url, {
    method,
    headers,
    body,
    signal,
    cache: opts.cache,
    next: opts.next,
  });
  const res = inProcess
    ? await inProcess
    : await (fetchImpl ?? fetch)(url, { method, headers, body, signal });
  return await settle(method, url, res);
}

/** The server installs the context bridge; a browser bundle never has it. */
function isServerRuntime(): boolean {
  return !!(globalThis as ContextBridge).__denextCurrentRequestContext;
}

/** The in-process dispatch for a server-side call, or `null` (browser, no request, foreign origin). */
function serverDispatch(
  url: string,
  init: Parameters<NonNullable<ReturnType<typeof getApiDispatcher>>>[1],
): Promise<Response> | null {
  if (!isServerRuntime()) return null;
  return getApiDispatcher()?.(url, init) ?? null;
}

/** Turn a response into the call's result, or throw the typed error (shared with batching). */
async function settle(method: HttpMethod, url: string, res: Response): Promise<unknown> {
  if (!res.ok) throw new ApiClientError(method, url, res, await readErrorEnvelope(res));
  return await readResult(res);
}

// ── Batching ─────────────────────────────────────────────────────────────────

/** GET/HEAD with no custom headers or body and no per-call opt-out may ride a batch. */
function batchable(method: HttpMethod, opts: ApiRequestOptions): boolean {
  return (method === "GET" || method === "HEAD") && opts.batch !== false && !opts.headers &&
    opts.body === undefined;
}

/** Run one call through the batcher; its item response settles like a direct one. */
async function batchedRequest(
  batcher: Batcher,
  pattern: string,
  method: "GET" | "HEAD",
  opts: ApiRequestOptions,
  base: string,
): Promise<unknown> {
  const path = buildPath(pattern, opts.params, opts.query);
  const signal = resolveSignal(opts.signal, opts.timeoutMs);
  const res = await batcher.enqueue(method, path, signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return await settle(method, base + path, res);
}

// ── In-flight dedupe ─────────────────────────────────────────────────────────

/** The key under which a request context's `memo` holds this client family's in-flight table. */
const INFLIGHT_MEMO_KEY = Symbol.for("denext.apiClient.inflight");

/** The server installs this bridge; its absence means "a browser bundle". */
interface ContextBridge {
  __denextCurrentRequestContext?: () => { memo?: Map<unknown, Map<string, unknown>> } | undefined;
}

/**
 * Where in-flight GET/HEAD promises live: the client's own table in the browser; during SSR
 * the current request's memo (so two users' requests can never share a promise); nowhere
 * (dedupe off) on the server outside a request.
 */
function inflightTable(local: Map<string, Promise<unknown>>): Map<string, Promise<unknown>> | null {
  const bridge = (globalThis as ContextBridge).__denextCurrentRequestContext;
  if (!bridge) return local;
  const memo = bridge()?.memo;
  if (!memo) return null;
  let table = memo.get(INFLIGHT_MEMO_KEY) as Map<string, Promise<unknown>> | undefined;
  if (!table) memo.set(INFLIGHT_MEMO_KEY, table = new Map());
  return table;
}

/** The dedupe key: everything that changes the response, headers included (an `Authorization`). */
function inflightKey(pattern: string, method: HttpMethod, opts: ApiRequestOptions): string {
  const headers = opts.headers ? [...new Headers(opts.headers).entries()].sort() : undefined;
  return stableKey([method, pattern, opts.params, opts.query, opts.body, headers]);
}

/** Run one call through the in-flight table (GET/HEAD only; a settled entry is removed). */
function deduped(
  local: Map<string, Promise<unknown>>,
  pattern: string,
  method: HttpMethod,
  opts: ApiRequestOptions,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const table = inflightTable(local);
  if (!table) return run();
  const key = inflightKey(pattern, method, opts);
  const existing = table.get(key);
  if (existing) return existing;
  const promise = run().finally(() => table.delete(key));
  table.set(key, promise);
  return promise;
}

/**
 * Create a typed API client bound to an app's generated {@link ApiSchema} (the registered
 * schema when `.denext/api.ts` is imported). Concurrent GET/HEAD calls with equal inputs share
 * one fetch (see {@link ApiClientOptions.dedupe}).
 *
 * @param baseOrOptions A base prefix (default: relative), or {@link ApiClientOptions}.
 * @returns A callable `(path, method, opts?) => Promise<response>`, checked against `S`.
 */
export function createApiClient<S extends ApiSchema = RegisteredSchema>(
  baseOrOptions: string | ApiClientOptions = "",
): ApiClient<S> {
  const options = typeof baseOrOptions === "string" ? { base: baseOrOptions } : baseOrOptions;
  const base = options.base ?? "";
  const dedupe = options.dedupe ?? true;
  const batchOpt = options.batch ?? true;
  const batcher = batchOpt
    ? createBatcher({
      fetch: options.fetch,
      base,
      maxItems: typeof batchOpt === "object" ? batchOpt.maxItems : undefined,
    })
    : null;
  const local = new Map<string, Promise<unknown>>();
  return ((path: string, method: HttpMethod, opts: ApiRequestOptions = {}) => {
    // Batching is a browser optimization; a server-side call with a dispatcher goes in-process.
    const canBatch = batcher && batchable(method, opts) &&
      !(isServerRuntime() && getApiDispatcher());
    const run = () =>
      canBatch
        ? batchedRequest(batcher, path, method as "GET" | "HEAD", opts, base)
        : apiRequest(path, method, opts, base, options.fetch);
    const readOnly = method === "GET" || method === "HEAD";
    if (!dedupe || opts.dedupe === false || !readOnly) return run();
    return deduped(local, path, method, opts, run);
  }) as ApiClient<S>;
}
