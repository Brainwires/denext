// Dispatch a request to an API route module's method handler — the single seam every
// `app/**/route.ts` request passes through, and therefore where the framework's guarantees
// for route handlers live:
//
// - **Body cap.** A handler's request body is bounded (1 MiB default; `apiMaxBodyBytes` on
//   the app, `export const maxBodyBytes = N | false` on the route). A declared over-cap
//   `Content-Length` is a 413 before the handler runs; a chunked body errors the stream as
//   the handler reads past the cap (→ 413). Streaming consumers keep streaming.
// - **Control signals.** `redirect()` / `notFound()` / `forbidden()` / `unauthorized()`
//   thrown inside a handler become the HTTP response they name (they used to fall out of the
//   pipeline as a 500), JSON or text by `Accept`.
// - **Typed errors.** A thrown `ApiError` becomes its JSON error envelope verbatim.
//
// Anything else a plain handler throws is rethrown to the pipeline's redacted text 500
// (the long-standing contract; `config.onError` may render it).

import { adaptRequest } from "./middleware.ts";
import type { ApiMatch } from "../router/match.ts";
import type { ApiContext, ApiModule, HttpMethod, ModuleLoader } from "./types.ts";
import { readApiBodyLimit, readSegmentConfig } from "./segment-config.ts";
import { currentContext } from "./request-context.ts";
import { asyncProps } from "../runtime/async-props.ts";
import { cappedBody, isBodyTooLarge } from "./body.ts";
import { ApiError, apiErrorResponse, isApiError } from "./api-error.ts";
import { isForbidden, isNotFound, isRedirect, isUnauthorized } from "../runtime/error-boundary.ts";
import { safeRedirectLocation } from "./config.ts";

const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** The default request-body cap for route handlers (1 MiB — Next's Server Action parity). */
const DEFAULT_MAX_API_BODY = 1024 * 1024;

/** Per-dispatch options the pipeline passes to {@link handleApi}. */
export interface ApiDispatchOptions {
  /** The app-level body cap (`AppConfig.apiMaxBodyBytes`); a route's own export overrides it. */
  maxBodyBytes?: number;
}

/**
 * Invoke the handler on an API module matching the request method.
 *
 * @param match The matched API route + params.
 * @param request The incoming request.
 * @param load Loads the route module.
 * @param options Dispatch options (body cap).
 * @returns The handler's response, a mapped control-signal / typed-error response, or a 405.
 */
export async function handleApi(
  match: ApiMatch,
  request: Request,
  load: ModuleLoader,
  options: ApiDispatchOptions = {},
): Promise<Response> {
  const mod = (await load(match.route.filePath)) as ApiModule;
  const method = request.method.toUpperCase() as HttpMethod;
  // Route segment config applies to handlers too: `dynamic = "error"` makes cookies()/
  // headers() throw, `force-static` makes them empty, and `revalidate` is honored by the
  // caller's cache flow — so record it on the request context like a page render does.
  const ctx = currentContext();
  if (ctx) ctx.segmentConfig = readSegmentConfig(mod);
  const handler = mod[method];
  if (!handler && !(method === "HEAD" && mod.GET)) return methodNotAllowed(mod);

  const cap = readApiBodyLimit(mod) ?? options.maxBodyBytes ?? DEFAULT_MAX_API_BODY;
  try {
    // Like middleware, a route handler receives the adapted request — a `NextRequest`
    // (`nextUrl`, `cookies`) once `next/server` is loaded, the plain Request otherwise.
    const req = adaptRequest(boundRequest(request, cap));
    const context: ApiContext = { params: asyncProps({ ...match.params }) };
    if (handler) return await handler(req, context);
    return await headFromGet(mod, req, context);
  } catch (err) {
    return apiErrorFor(err, request, ctx?.requestId);
  }
}

/** The request with its body bounded by `cap` (`false` = unbounded; no body = unchanged). */
function boundRequest(request: Request, cap: number | false): Request {
  if (cap === false || !request.body) return request;
  return cappedBody(request, cap); // a declared over-cap Content-Length throws right here
}

/** Auto-implement HEAD from GET: same status + headers, no body. */
async function headFromGet(mod: ApiModule, req: Request, context: ApiContext): Promise<Response> {
  const res = await mod.GET!(req, context);
  // A HEAD response carries no body; cancel the GET's stream instead of dropping
  // it on the floor, which would leak the stream (and pin whatever backs it).
  await res.body?.cancel();
  return new Response(null, { status: res.status, headers: res.headers });
}

function methodNotAllowed(mod: ApiModule): Response {
  const allowed = METHODS.filter((m) => mod[m]).join(", ");
  return new Response("Method Not Allowed", {
    status: 405,
    headers: allowed ? { allow: allowed } : undefined,
  });
}

/**
 * Map what a handler threw to its HTTP response, or rethrow. A `redirect()` is the redirect
 * (its status, target normalized so a user-controlled URL can't leave the origin);
 * `notFound()`/`forbidden()`/`unauthorized()` are 404/403/401; an `ApiError` is its envelope;
 * reading past the body cap is a 413. Everything else keeps the pipeline's redacted-500 path.
 */
function apiErrorFor(err: unknown, request: Request, requestId: string | undefined): Response {
  if (isRedirect(err)) {
    return new Response(null, {
      status: err.status,
      headers: { location: safeRedirectLocation(err.url) },
    });
  }
  const signal = controlSignalError(err);
  if (signal) return signalResponse(signal, request, requestId);
  if (isApiError(err)) return apiErrorResponse(err, requestId);
  if (isBodyTooLarge(err)) {
    const tooLarge = new ApiError(413, "payload_too_large", { message: "request body too large" });
    return apiErrorResponse(tooLarge, requestId);
  }
  throw err;
}

/** The `ApiError` equivalent of a thrown control signal, or null for anything else. */
function controlSignalError(err: unknown): ApiError | null {
  if (isNotFound(err)) return new ApiError(404, "not_found", { message: "Not Found" });
  if (isForbidden(err)) return new ApiError(403, "forbidden", { message: "Forbidden" });
  if (isUnauthorized(err)) return new ApiError(401, "unauthorized", { message: "Unauthorized" });
  return null;
}

/** JSON envelope for API clients; plain text when the caller prefers HTML (a browser tab). */
function signalResponse(err: ApiError, request: Request, requestId: string | undefined): Response {
  if (wantsJson(request)) return apiErrorResponse(err, requestId);
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (requestId) headers["x-request-id"] = requestId;
  return new Response(err.message, { status: err.status, headers });
}

/** No `Accept`, or one naming JSON, or one NOT naming HTML → JSON. */
function wantsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return !accept || accept.includes("application/json") || !accept.includes("text/html");
}
