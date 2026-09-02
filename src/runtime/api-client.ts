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
// appends the query, JSON-encodes a body, and parses the JSON response. It has no denext
// dependency, so the generated client works from a Server Component, a client component,
// a test, or any other `fetch` context.

/** The HTTP methods a route handler may export. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** One endpoint's typed shape: its params, optional request/response bodies. */
export interface ApiEndpoint {
  /** Path params for the route's dynamic segments (absent for a fully-static route). */
  params?: Record<string, string>;
  /** The JSON request body the handler parses (absent when it reads none). */
  body?: unknown;
  /** The JSON response body the handler returns (`unknown` when it isn't a `TypedResponse`). */
  response?: unknown;
}

/** A whole app's API surface: route pattern → (method → endpoint). */
export type ApiSchema = Record<string, Partial<Record<HttpMethod, ApiEndpoint>>>;

// ── Request/response type mapping ────────────────────────────────────────────

/** The keys of `T` that are required (used to decide whether the opts arg is optional). */
export type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** The options object for one endpoint: `params`/`body` appear only when the route has them. */
export type RequestOf<E extends ApiEndpoint> =
  & (E extends { params: infer P } ? { params: P } : unknown)
  & (E extends { body: infer B } ? { body: B } : unknown)
  & {
    /** Extra query-string params appended to the URL. */
    query?: Record<string, string>;
    /** Extra request headers (merged over the JSON content-type). */
    headers?: HeadersInit;
    /** Abort signal forwarded to `fetch`. */
    signal?: AbortSignal;
  };

/** The awaited response type for one endpoint. */
export type ResponseOf<E extends ApiEndpoint> = E extends { response: infer R } ? R : unknown;

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
  /** Values for the route pattern's dynamic segments. */
  params?: Record<string, string>;
  /** A JSON request body (serialized with `JSON.stringify`). */
  body?: unknown;
  /** Extra query-string params appended to the URL. */
  query?: Record<string, string>;
  /** Extra request headers (merged over the JSON content-type). */
  headers?: HeadersInit;
  /** Abort signal forwarded to `fetch`. */
  signal?: AbortSignal;
}

/** Encode one param value, preserving `/` so a catch-all value spans path segments. */
function encodeParam(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
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
  params?: Record<string, string>,
  query?: Record<string, string>,
): string {
  const path = pattern.replace(/\[\[?\.{0,3}([^\]]+)\]?\]/g, (_m, name: string) => {
    const value = params?.[name];
    if (value == null) throw new Error(`denext api client: missing param "${name}" for ${pattern}`);
    return encodeParam(value);
  });
  const qs = query ? new URLSearchParams(query).toString() : "";
  return qs ? `${path}?${qs}` : path;
}

/**
 * Perform one typed API request (the runtime the typed client dispatches to). Substitutes
 * params, JSON-encodes a body, and parses a JSON response (a 204/empty body → undefined).
 *
 * @param pattern The route pattern to call.
 * @param method The HTTP method.
 * @param opts Params, body, query, headers, and abort signal.
 * @param base Optional origin/base prefix (default: relative to the current origin).
 * @returns The parsed JSON response body.
 */
export async function apiRequest(
  pattern: string,
  method: HttpMethod,
  opts: ApiRequestOptions = {},
  base = "",
): Promise<unknown> {
  const url = base + buildPath(pattern, opts.params, opts.query);
  const hasBody = opts.body !== undefined;
  const headers = new Headers(opts.headers);
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`denext api client: ${method} ${url} → ${res.status} ${res.statusText}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") return undefined;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return await res.json();
  await res.body?.cancel();
  return undefined;
}

/**
 * Create a typed API client bound to an app's generated {@link ApiSchema}.
 *
 * @param base Optional origin/base prefix for every request (default: relative).
 * @returns A callable `(path, method, opts?) => Promise<response>`, checked against `S`.
 */
export function createApiClient<S extends ApiSchema>(base = ""): ApiClient<S> {
  return ((path: string, method: HttpMethod, opts?: ApiRequestOptions) =>
    apiRequest(path, method, opts, base)) as ApiClient<S>;
}
