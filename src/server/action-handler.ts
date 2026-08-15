// Server-side dispatch for Server Actions (POST /_denext/action/<id>).
//
// SECURITY MODEL
// - Same-origin only: every action request is verified against Origin (falling
//   back to Referer). When neither is present the request is rejected. This is
//   the primary CSRF defense, because actions run with the visitor's cookies.
// - POST only: actions can never be triggered by a GET (no <img>/link CSRF).
// - Bounded dispatch: only ids explicitly registered via `serverAction` resolve;
//   the id is a Map key, never a path or eval target.
// - No leakage: handler errors are logged server-side and returned to the client
//   as a generic message, never a stack trace or internal detail.
// - Redirects are forced to 303 (POST -> GET) and, for no-JS posts, restricted
//   to a same-origin path derived from Referer.

import { ACTION_PREFIX, decodeActionArgs, getServerAction } from "../runtime/server-action.ts";
import { isRedirect } from "../runtime/error-boundary.ts";
import { safeRedirectLocation } from "./config.ts";
import { currentContext } from "./request-context.ts";

/**
 * Default max Server Action request body size (bytes) — 1 MiB, matching Next.js'
 * `serverActions.bodySizeLimit` default. A stricter, safer default; multipart file
 * uploads should opt into a higher limit via `actionMaxBodyBytes`.
 */
export const DEFAULT_MAX_ACTION_BODY = 1024 * 1024;

/** Options for {@linkcode handleAction}. */
export interface ActionHandlerOptions {
  /**
   * Extra origins permitted to invoke actions in addition to the request's own
   * Host. A **full origin** (`https://app.example.com`) is matched scheme-strictly;
   * a **bare host** (`app.example.com`) matches any scheme (compatibility). Use for
   * reverse-proxy / multi-host deployments.
   */
  allowedOrigins?: string[];
  /**
   * An explicit public origin (e.g. `https://example.com`). When its scheme is
   * `https`, an `http` Origin for the same host is rejected as a downgrade.
   */
  canonicalOrigin?: string;
  /**
   * Trust `X-Forwarded-Proto` to learn the external scheme (behind a TLS-terminating
   * proxy). Only ever tightens the check (rejects an HTTP origin when the proxy
   * reports HTTPS); a forged value cannot loosen it.
   */
  trustForwardedHeaders?: boolean;
  /**
   * Max request body size in bytes (default {@linkcode DEFAULT_MAX_ACTION_BODY}).
   * An over-limit body is rejected before the handler runs.
   */
  maxBodyBytes?: number;
  /**
   * Max idle time (ms) between body chunks before the read is aborted with 408
   * (default {@linkcode DEFAULT_BODY_IDLE_TIMEOUT}). Guards against a trickled or
   * never-closed body pinning the handler.
   */
  bodyIdleTimeoutMs?: number;
  /**
   * Invoked when the action handler throws a real error (not a control-flow
   * redirect). Lets the caller report it to instrumentation (`onRequestError`) —
   * the action path returns a normal Response, so it never reaches the app's
   * top-level error reporter otherwise. Must not throw.
   */
  onError?: (error: unknown) => void | Promise<void>;
}

/** True if `pathname` targets the server-action endpoint. */
export function isActionRequest(request: Request, pathname: string): boolean {
  return request.method === "POST" && pathname.startsWith(ACTION_PREFIX);
}

/** Handle a Server Action POST. Runs inside the per-request async context. */
export async function handleAction(
  request: Request,
  options: ActionHandlerOptions = {},
): Promise<Response> {
  // 1. CSRF: enforce same-origin before doing anything else.
  if (!verifyOrigin(request, options)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  // 2. Reject an over-large body before parsing (declared size fast-path).
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_ACTION_BODY;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBody) {
    return jsonResponse({ error: "payload too large" }, 413);
  }

  // 3. Resolve the action; unknown ids are indistinguishable from missing ones.
  const pathname = new URL(request.url).pathname;
  const id = decodeURIComponent(pathname.slice(ACTION_PREFIX.length));
  const handler = getServerAction(id);
  if (!handler) return jsonResponse({ error: "unknown action" }, 404);

  const isXhr = request.headers.get("x-denext-action") === "1";

  // 4. Buffer the body under the cap (covers chunked requests with no
  // Content-Length), then decode. Buffering first so an over-limit body is a clean
  // 413 rather than being masked by the decoder's lenient error handling.
  const buffered = await readCappedBody(request, maxBody, options.bodyIdleTimeoutMs);
  if (buffered === TOO_LARGE) return jsonResponse({ error: "payload too large" }, 413);
  if (buffered === STALLED) return jsonResponse({ error: "request timeout" }, 408);
  let args: unknown[];
  try {
    args = await decodeActionArgs(bufferedRequest(request, buffered));
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }

  // 5. Run the handler.
  try {
    const result = await handler(...args);
    if (isXhr) return jsonResponse({ result: result ?? null, ...refreshDirectives() });
    // No-JS form post: redirect back to the (same-origin) referring page (a full
    // reload, which itself satisfies any updateTag/refresh the action requested).
    return redirectResponse(sameOriginBackPath(request), 303);
  } catch (err) {
    if (isRedirect(err)) {
      // Force 303 so the browser follows with a GET after a POST. Normalize the
      // target so a user-controlled redirect can't escape the origin.
      const location = safeRedirectLocation(err.url);
      if (isXhr) return jsonResponse({ redirect: location });
      return redirectResponse(location, 303);
    }
    // Report to instrumentation (the action path returns a normal Response, so it
    // never reaches the app's top-level onRequestError otherwise) — then log and
    // return a redacted 500 that never leaks internals to the caller.
    await options.onError?.(err);
    console.error("denext: server action error", err);
    return jsonResponse({ error: "server action failed" }, 500);
  }
}

// ---- Origin verification ---------------------------------------------------

/**
 * Verify the request is same-origin (or from an explicitly allowed origin).
 * Prefers the `Origin` header, falls back to `Referer`, and rejects when neither
 * is present — a state-changing RPC defaults to deny.
 *
 * Full-origin allowlist entries (and `canonicalOrigin`) are matched
 * scheme-strictly. For the request's own Host, the scheme is compared only when we
 * can determine the site is HTTPS (via `canonicalOrigin`, a trusted
 * `X-Forwarded-Proto`, or the request URL) — so an `http://host` origin is rejected
 * for an HTTPS app, without breaking a TLS-terminating proxy where the scheme is
 * unknown. Bare-host allowlist entries stay scheme-agnostic (compat).
 */
function verifyOrigin(request: Request, options: ActionHandlerOptions): boolean {
  const host = request.headers.get("host");
  if (!host) return false;

  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return false;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }

  const fullOrigins = new Set<string>();
  const bareHosts = new Set<string>();
  if (options.canonicalOrigin) {
    try {
      fullOrigins.add(new URL(options.canonicalOrigin).origin);
    } catch { /* ignore malformed config */ }
  }
  for (const o of options.allowedOrigins ?? []) {
    try {
      fullOrigins.add(new URL(o).origin); // full origin → scheme-strict
    } catch {
      if (o.length > 0 && !o.includes("/")) bareHosts.add(o); // bare host → any scheme
    }
  }

  if (fullOrigins.has(u.origin)) return true;
  if (bareHosts.has(u.host)) return true;
  if (u.host === host) {
    // Own host: block an HTTP → HTTPS downgrade when we know the site is HTTPS.
    return !isKnownHttps(request, options) || u.protocol === "https:";
  }
  return false;
}

/**
 * Whether the site is known to be served over HTTPS (for CSRF downgrade
 * rejection).
 *
 * SEC-L2 — behind a TLS-terminating proxy, `request.url` is the internal `http://`
 * URL, so this can't tell the public scheme is HTTPS on its own. Set
 * `canonicalOrigin` (e.g. `https://example.com`) or `trustForwardedHeaders: true`
 * (only when the proxy sets `x-forwarded-proto` and clients can't spoof it) so the
 * HTTP→HTTPS action-origin downgrade check actually engages. Without either, a
 * proxied HTTPS site is treated as HTTP here and the downgrade guard is a no-op.
 */
function isKnownHttps(request: Request, options: ActionHandlerOptions): boolean {
  if (options.canonicalOrigin) {
    try {
      return new URL(options.canonicalOrigin).protocol === "https:";
    } catch { /* ignore */ }
  }
  if (options.trustForwardedHeaders) {
    const xfp = request.headers.get("x-forwarded-proto");
    if (xfp) return xfp.split(",")[0].trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Sentinel returned by {@linkcode readCappedBody} when the body exceeds the cap. */
const TOO_LARGE = Symbol("too_large");
/** Sentinel returned by {@linkcode readCappedBody} when the body stalls (idle). */
const STALLED = Symbol("stalled");

/**
 * Max time (ms) a single body chunk may take to arrive before the read is aborted.
 * Defends against a trickled / never-closed body pinning a handler under the size
 * cap ("denial of wallet", CVE-2024-56332). A legitimate client streams
 * continuously; this bounds only pathological inactivity.
 */
const DEFAULT_BODY_IDLE_TIMEOUT = 30_000;

/**
 * Read a request body into memory, refusing anything over `maxBytes` (hard-caps
 * even a chunked body with no Content-Length) and aborting a body that stalls for
 * longer than `idleMs`. Returns the bytes, {@linkcode TOO_LARGE}, or
 * {@linkcode STALLED}.
 */
async function readCappedBody(
  request: Request,
  maxBytes: number,
  idleMs: number = DEFAULT_BODY_IDLE_TIMEOUT,
): Promise<Uint8Array | typeof TOO_LARGE | typeof STALLED> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof STALLED>((resolve) => {
      timer = setTimeout(() => resolve(STALLED), idleMs);
    });
    const step = await Promise.race([reader.read(), idle]);
    clearTimeout(timer);
    if (step === STALLED) {
      await reader.cancel().catch(() => {});
      return STALLED;
    }
    const { done, value } = step;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Rebuild a request from already-buffered body bytes (headers/method preserved). */
function bufferedRequest(request: Request, body: Uint8Array): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body.byteLength > 0 ? (body as BodyInit) : undefined,
  });
}

/** A safe same-origin path to redirect back to after a no-JS action post. */
function sameOriginBackPath(request: Request): string {
  const referer = request.headers.get("referer");
  const host = request.headers.get("host");
  if (referer && host) {
    try {
      const u = new URL(referer);
      if (u.host === host) return u.pathname + u.search;
    } catch {
      // fall through
    }
  }
  return "/";
}

// ---- Response helpers ------------------------------------------------------

/**
 * The client-refresh directives an action accrued via `updateTag`/`refresh`, folded
 * into its XHR JSON response so the client router can refresh the affected content
 * (Next.js 16 read-your-writes / refresh semantics).
 */
function refreshDirectives(): { refresh?: true; updatedTags?: string[] } {
  const ctx = currentContext();
  const out: { refresh?: true; updatedTags?: string[] } = {};
  if (ctx?.refreshRequested) out.refresh = true;
  if (ctx?.updatedTags && ctx.updatedTags.size > 0) out.updatedTags = [...ctx.updatedTags];
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirectResponse(location: string, status: number): Response {
  return new Response(null, { status, headers: { location } });
}
