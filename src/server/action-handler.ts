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

/** Options for {@linkcode handleAction}. */
export interface ActionHandlerOptions {
  /**
   * Extra origins (full origins like `https://app.example.com`, or bare hosts)
   * permitted to invoke actions in addition to the request's own Host. Use for
   * reverse-proxy / multi-host deployments.
   */
  allowedOrigins?: string[];
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
  if (!verifyOrigin(request, options.allowedOrigins)) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  // 2. Resolve the action; unknown ids are indistinguishable from missing ones.
  const pathname = new URL(request.url).pathname;
  const id = decodeURIComponent(pathname.slice(ACTION_PREFIX.length));
  const handler = getServerAction(id);
  if (!handler) return jsonResponse({ error: "unknown action" }, 404);

  const isXhr = request.headers.get("x-denext-action") === "1";

  // 3. Decode arguments defensively.
  let args: unknown[];
  try {
    args = await decodeActionArgs(request);
  } catch {
    return jsonResponse({ error: "bad request" }, 400);
  }

  // 4. Run the handler.
  try {
    const result = await handler(...args);
    if (isXhr) return jsonResponse({ result: result ?? null });
    // No-JS form post: redirect back to the (same-origin) referring page.
    return redirectResponse(sameOriginBackPath(request), 303);
  } catch (err) {
    if (isRedirect(err)) {
      // Force 303 so the browser follows with a GET after a POST.
      if (isXhr) return jsonResponse({ redirect: err.url });
      return redirectResponse(err.url, 303);
    }
    // Never leak internals to the caller.
    console.error("denext: server action error", err);
    return jsonResponse({ error: "server action failed" }, 500);
  }
}

// ---- Origin verification ---------------------------------------------------

/**
 * Verify the request is same-origin (or from an explicitly allowed origin).
 * Prefers the `Origin` header, falls back to `Referer`, and rejects when neither
 * is present — a state-changing RPC defaults to deny.
 */
function verifyOrigin(request: Request, allowedOrigins?: string[]): boolean {
  const host = request.headers.get("host");
  if (!host) return false;

  const allowed = new Set<string>([host]);
  for (const o of allowedOrigins ?? []) {
    const h = hostOf(o);
    if (h) allowed.add(h);
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const h = hostOf(origin);
    return h !== null && allowed.has(h);
  }
  const referer = request.headers.get("referer");
  if (referer) {
    const h = hostOf(referer);
    return h !== null && allowed.has(h);
  }
  return false;
}

/** Extract the host from a full URL or accept a bare host string. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return value.length > 0 && !value.includes("/") ? value : null;
  }
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirectResponse(location: string, status: number): Response {
  return new Response(null, { status, headers: { location } });
}
