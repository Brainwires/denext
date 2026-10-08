// CORS for route handlers (`route.ts`, `defineApi`) and the native `denextAuth` endpoints —
// what a Capacitor shell (`capacitor://localhost`, `https://localhost`) or a front end on
// another origin needs to call this server.
//
// The rules, all fail-closed:
// - **Exact origins.** A request's `Origin` is allowed only when it is byte-identical to a
//   configured origin (normalized once, at boot, to the lower-case form a browser sends).
//   There is no prefix, suffix or wildcard matching, so `capacitor://localhost.evil` and
//   `https://app.example.com.evil.test` are refused, and so is an upper-cased spelling a
//   browser never produces. `"null"` (sandboxed frames, `file:`) can't be configured at all.
// - **Never `*` with credentials.** `["*"]` answers `Access-Control-Allow-Origin: *` and is
//   refused at boot when `credentials` is on; a credentialed policy always echoes one exact
//   origin.
// - **`Vary: Origin`** on every answer a non-`*` policy touches, allowed or not, so a shared
//   cache can never serve one origin's CORS headers to another.
// - **Preflights** are answered by the framework (`204`), before middleware, for the API
//   routes a policy covers: an allowed origin + method + header set gets the approval headers,
//   anything else gets none (the browser then refuses to send the request).
//
// A route narrows or lifts the app policy with `export const cors = { … } | false` (a
// complete policy that REPLACES the app's, or `false` for none), and one endpoint does the same
// with the `cors({ … })` API middleware (`createApi().use(cors({ … }))`), which wins over both
// for the method it guards — a preflight is matched to the method it asks about.

import type { CorsConfig } from "./config.ts";
import { apiDefinitionOf } from "./define-api.ts";

/** The symbol under which a `cors()` API middleware carries its resolved policy. */
export const CORS_POLICY: unique symbol = Symbol.for("denext.api.cors") as never;

/** The methods a preflight approves when the config says nothing. */
const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** The request headers a preflight approves when the config says nothing. */
const DEFAULT_HEADERS = ["authorization", "content-type", "x-denext-wire"];
/** The preflight cache lifetime (seconds) when the config says nothing. */
const DEFAULT_MAX_AGE = 600;
/** The longest preflight cache lifetime accepted (a day — browsers cap lower anyway). */
const MAX_MAX_AGE = 86_400;

/** A validated, normalized CORS policy — what the request path consults. */
export interface CorsPolicy {
  /** `true` for the `["*"]` policy (any origin, never with credentials). */
  readonly any: boolean;
  /** The exact allowed origins (empty when {@link any}). */
  readonly origins: ReadonlySet<string>;
  /** Upper-cased methods a preflight may approve. */
  readonly methods: ReadonlySet<string>;
  /** The `Access-Control-Allow-Methods` value. */
  readonly methodsHeader: string;
  /** Lower-cased request headers a preflight may approve. */
  readonly headers: ReadonlySet<string>;
  /** The `Access-Control-Allow-Headers` value. */
  readonly headersHeader: string;
  /** The `Access-Control-Expose-Headers` value, or `""` for none. */
  readonly exposeHeader: string;
  /** Whether credentialed requests are allowed. */
  readonly credentials: boolean;
  /** Preflight cache lifetime, seconds. */
  readonly maxAge: number;
}

/** A URI scheme (RFC 3986 §3.1), lower-cased. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
/** A non-special-scheme authority: a host (+ optional port); no userinfo, path, query or hash. */
const AUTHORITY_RE = /^[a-z0-9._~-]+(?::\d{1,5})?$/;

/**
 * Normalize one configured origin to the exact string a browser sends as `Origin`, or throw.
 *
 * @param raw The configured value.
 * @returns The canonical origin (lower-case scheme + host, default port dropped).
 */
export function normalizeCorsOrigin(raw: unknown): string {
  const fail = (why: string): never => {
    throw new Error(
      `denext: cors.origins entry ${JSON.stringify(raw)} ${why} — list bare origins such as ` +
        '"capacitor://localhost", "https://localhost" or "myapp://app" (scheme + host, no path).',
    );
  };
  if (typeof raw !== "string" || raw.trim() === "") return fail("is not a non-empty string");
  const value = raw.trim();
  if (value.toLowerCase() === "null") return fail('is "null", which any sandboxed page can send');
  const sep = value.indexOf("://");
  if (sep <= 0) return fail("has no scheme");
  const scheme = value.slice(0, sep).toLowerCase();
  if (!SCHEME_RE.test(scheme)) return fail("has an invalid scheme");
  if (scheme === "http" || scheme === "https") return normalizeWebOrigin(value, fail);
  // A custom scheme (capacitor://, myapp://): WHATWG URL gives these an opaque `null` origin,
  // so the authority is checked by hand. One optional trailing slash is tolerated.
  const authority = value.slice(sep + 3).replace(/\/$/, "").toLowerCase();
  if (!AUTHORITY_RE.test(authority)) return fail("is not a bare origin");
  return `${scheme}://${authority}`;
}

/** `http(s)://host[:port]` through the URL parser (which lower-cases and drops default ports). */
function normalizeWebOrigin(value: string, fail: (why: string) => never): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("is not a valid URL");
  }
  if (url.username || url.password) return fail("carries credentials");
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) {
    return fail("has a path, query or fragment");
  }
  return url.origin;
}

/** A method / header token list, trimmed; a non-array or a non-string entry throws. */
function tokens(field: string, value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error(`denext: cors.${field} must be an array of non-empty strings`);
  }
  return value.map((v: string) => v.trim());
}

/**
 * Validate and normalize a {@link CorsConfig}. Throws on anything that can't be applied
 * safely — a malformed or `"null"` origin, `"*"` mixed with other origins or with
 * `credentials`, a bad `maxAge` — so a mistake fails at boot, not as a silent open door.
 *
 * @param config The configured policy (`undefined`/`null` → no CORS).
 * @returns The resolved policy, or `null` when CORS is off.
 */
export function resolveCors(config: CorsConfig | null | undefined): CorsPolicy | null {
  if (config === undefined || config === null) return null;
  if (typeof config !== "object" || !Array.isArray(config.origins)) {
    throw new Error("denext: cors must be an object with an `origins` array");
  }
  const any = config.origins.length === 1 && config.origins[0] === "*";
  if (!any && config.origins.includes("*")) {
    throw new Error('denext: cors.origins may be ["*"] on its own, never "*" among origins');
  }
  const credentials = config.credentials === true;
  if (any && credentials) {
    throw new Error(
      'denext: cors.origins ["*"] cannot be combined with `credentials: true` — list the ' +
        "exact origins that may send credentials",
    );
  }
  const origins = any ? new Set<string>() : new Set(config.origins.map(normalizeCorsOrigin));
  const methods = tokens("methods", config.methods, DEFAULT_METHODS).map((m) => m.toUpperCase());
  const headers = tokens("headers", config.headers, DEFAULT_HEADERS).map((h) => h.toLowerCase());
  const expose = tokens("exposeHeaders", config.exposeHeaders, []).map((h) => h.toLowerCase());
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
  if (!Number.isInteger(maxAge) || maxAge < 0 || maxAge > MAX_MAX_AGE) {
    throw new Error(`denext: cors.maxAge must be a whole number of seconds 0..${MAX_MAX_AGE}`);
  }
  return {
    any,
    origins,
    methods: new Set(methods),
    methodsHeader: methods.join(", "),
    headers: new Set(headers),
    headersHeader: headers.join(", "),
    exposeHeader: expose.join(", "),
    credentials,
    maxAge,
  };
}

/**
 * The policy a route runs under: its own `export const cors` when it has one (`false` → none,
 * an object → that policy INSTEAD of the app's), else the app's.
 *
 * @param app The app-level policy.
 * @param mod The loaded route module.
 * @returns The effective policy, or `null` for none.
 */
function routeCorsPolicy(app: CorsPolicy | null, mod: unknown): CorsPolicy | null {
  const own = (mod as { cors?: unknown } | null)?.cors;
  if (own === undefined) return app;
  if (own === false || own === null) return null;
  return routePolicies.get(own as object) ?? cacheRoutePolicy(own as CorsConfig);
}

/**
 * The policy one request to a route runs under: the `cors()` middleware on the handler for the
 * request's method (a preflight's `Access-Control-Request-Method`; `HEAD` falls back to `GET`)
 * when it has one, else {@link routeCorsPolicy}.
 *
 * @param app The app-level policy.
 * @param mod The loaded route module.
 * @param request The request (a preflight or the actual request).
 * @returns The effective policy, or `null` for none.
 */
export function endpointCorsPolicy(
  app: CorsPolicy | null,
  mod: unknown,
  request: Request,
): CorsPolicy | null {
  const method =
    (isPreflight(request)
      ? request.headers.get("access-control-request-method") ?? ""
      : request.method).toUpperCase();
  const handlers = (mod ?? {}) as Record<string, unknown>;
  const handler = handlers[method] ?? (method === "HEAD" ? handlers.GET : undefined);
  const chain = apiDefinitionOf(handler)?.middleware ?? [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const own = (chain[i] as unknown as Record<symbol, CorsPolicy | undefined>)[CORS_POLICY];
    if (own) return own;
  }
  return routeCorsPolicy(app, mod);
}

/** Resolved route policies, keyed by the exported object (a module export is stable). */
const routePolicies = new WeakMap<object, CorsPolicy | null>();

function cacheRoutePolicy(own: CorsConfig): CorsPolicy | null {
  const policy = resolveCors(own);
  if (typeof own === "object") routePolicies.set(own, policy);
  return policy;
}

/**
 * Whether `origin` (the raw `Origin` header) is allowed by `policy`. Exact string membership:
 * no case folding, no trimming, no prefix/suffix logic.
 *
 * @param policy The policy.
 * @param origin The request's `Origin`, or `null` when it sent none.
 * @returns `true` only for an allowed origin.
 */
export function corsOriginAllowed(policy: CorsPolicy, origin: string | null): boolean {
  if (origin === null || origin === "" || origin === "null") return false;
  return policy.any || policy.origins.has(origin);
}

/**
 * Whether `request` is a CORS preflight: `OPTIONS` carrying both `Origin` and
 * `Access-Control-Request-Method`.
 *
 * @param request The request.
 * @returns `true` for a preflight.
 */
export function isPreflight(request: Request): boolean {
  return request.method === "OPTIONS" && request.headers.has("origin") &&
    request.headers.has("access-control-request-method");
}

/** Whether every header the preflight asks for is one the policy approves. */
function headersApproved(policy: CorsPolicy, requested: string | null): boolean {
  if (!requested) return true;
  return requested.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
    .every((h) => policy.headers.has(h));
}

/** The `Vary` value a policy's answers carry. */
function varyFor(policy: CorsPolicy, preflight: boolean): string | null {
  if (policy.any) return preflight ? "Access-Control-Request-Headers" : null;
  return preflight
    ? "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    : "Origin";
}

/**
 * Answer a preflight under `policy`: `204` with the approval headers when the origin, the
 * method and every requested header are allowed, else `204` with NO approval (the browser then
 * refuses to send the real request). Never runs the route.
 *
 * @param request The preflight request.
 * @param policy The route's effective policy.
 * @returns The preflight response.
 */
export function preflightResponse(request: Request, policy: CorsPolicy): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const vary = varyFor(policy, true);
  if (vary) headers.set("vary", vary);
  const origin = request.headers.get("origin");
  const method = (request.headers.get("access-control-request-method") ?? "").toUpperCase();
  const approved = corsOriginAllowed(policy, origin) && policy.methods.has(method) &&
    headersApproved(policy, request.headers.get("access-control-request-headers"));
  if (approved) {
    headers.delete("cache-control");
    headers.set("access-control-allow-origin", policy.any ? "*" : origin!);
    headers.set("access-control-allow-methods", policy.methodsHeader);
    if (policy.headersHeader) headers.set("access-control-allow-headers", policy.headersHeader);
    headers.set("access-control-max-age", String(policy.maxAge));
    if (policy.credentials) headers.set("access-control-allow-credentials", "true");
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Decorate an actual (non-preflight) response with the CORS headers `policy` grants the
 * request's origin: `Access-Control-Allow-Origin` (+ credentials / expose headers) for an
 * allowed origin, and `Vary: Origin` either way. A response whose headers are immutable is
 * copied first.
 *
 * @param request The request the response answers.
 * @param response The response.
 * @param policy The route's effective policy (`null` → returned unchanged).
 * @returns The response with its CORS headers.
 */
export function applyCors(
  request: Request,
  response: Response,
  policy: CorsPolicy | null,
): Response {
  if (!policy) return response;
  const origin = request.headers.get("origin");
  const allowed = corsOriginAllowed(policy, origin);
  const vary = varyFor(policy, false);
  if (!allowed && !vary) return response;
  const res = mutable(response);
  if (vary) appendVary(res.headers, vary);
  if (!allowed) return res;
  res.headers.set("access-control-allow-origin", policy.any ? "*" : origin!);
  if (policy.credentials) res.headers.set("access-control-allow-credentials", "true");
  if (policy.exposeHeader) res.headers.set("access-control-expose-headers", policy.exposeHeader);
  return res;
}

/** Add `value` to a `Vary` header without duplicating it. */
function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) return headers.set("vary", value);
  const have = current.split(",").map((v) => v.trim().toLowerCase());
  if (have.includes("*") || have.includes(value.toLowerCase())) return;
  headers.set("vary", `${current}, ${value}`);
}

/** The response itself when its headers can be written, else a copy that can. */
function mutable(response: Response): Response {
  try {
    response.headers.set("x-denext-cors-probe", "1");
    response.headers.delete("x-denext-cors-probe");
    return response;
  } catch {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }
}
