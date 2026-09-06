// A request the server makes to ITSELF on behalf of a parent request: a typed-API batch item,
// or the typed client called during SSR (no loopback HTTP). It re-enters the FULL pipeline —
// middleware, config rewrites, basePath, i18n, header rules, the redacted-500 contract — under
// its own request context, so a sub-request can never bypass a middleware auth matcher on
// `/api/*` the way a direct `handleApi` call would. What the child learns that affects the
// PARENT's render (a cookie read, cache tags) is propagated back.

import type { AppRuntime } from "./pipeline-state.ts";
import {
  createRequestContext,
  type RequestContext,
  runDeferred,
  runWithContext,
} from "./request-context.ts";
import { copyRemoteAddr } from "./remote-addr.ts";
import { BATCH_ITEM_HEADER } from "../runtime/api-batch-protocol.ts";

/** How deep self-calls may nest (a route that calls itself through the typed client terminates). */
const MAX_SUB_REQUEST_DEPTH = 3;

/**
 * The parent request headers a sub-request inherits. Nothing else crosses: a client cannot
 * smuggle a header through a batch item, and a server-side self-call does not leak the
 * parent's `authorization`-unrelated framing headers.
 */
const SUB_REQUEST_HEADER_ALLOWLIST = [
  "cookie",
  "authorization",
  "accept-language",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
] as const;

/** Options for {@link synthesizeSubRequest}. */
export interface SubRequestInit {
  /** The item's method. */
  method: string;
  /** The absolute URL on the app's own origin. */
  url: URL;
  /** The parent request (its allowlisted headers and socket peer are inherited). */
  parent: Request;
  /** The parent context (its request id prefixes the child's; its signal aborts the child). */
  parentCtx: RequestContext;
  /** A suffix for the child's `x-request-id` (`#3` for batch item 3, `#api1` for an SSR call). */
  idSuffix: string;
  /** Extra headers the CALLER (server code, never a client) asked for. */
  extraHeaders?: HeadersInit;
  /** An extra abort signal composed with the parent's. */
  signal?: AbortSignal;
  /** The body (a server-side self-call may POST). */
  body?: BodyInit | null;
}

/**
 * Build the child `Request`: allowlisted parent headers, `accept: application/json`, the
 * batch-item marker (API only), a derived `x-request-id`, the parent's abort signal, and the
 * parent's socket peer (so rate limiters and `NextRequest.ip` see the real client).
 *
 * @param init What to synthesize.
 * @returns The child request.
 */
export function synthesizeSubRequest(init: SubRequestInit): Request {
  const headers = new Headers();
  for (const name of SUB_REQUEST_HEADER_ALLOWLIST) {
    const v = init.parent.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  if (init.extraHeaders) {
    for (const [k, v] of new Headers(init.extraHeaders)) {
      if (!HOP_HEADERS.has(k) && k !== BATCH_ITEM_HEADER) headers.set(k, v);
    }
  }
  headers.set("accept", "application/json");
  headers.set(BATCH_ITEM_HEADER, "1");
  headers.set("x-request-id", `${init.parentCtx.requestId}${init.idSuffix}`);
  const signals = [init.parentCtx.signal, init.signal].filter((s): s is AbortSignal => !!s);
  const request = new Request(init.url, {
    method: init.method,
    headers,
    body: init.body ?? undefined,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  });
  copyRemoteAddr(init.parent, request);
  return request;
}

/** Framing headers a caller may not set on a synthesized request. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
]);

/** The pipeline entry a sub-request re-enters (`runPipeline`, injected to avoid an import cycle). */
export type PipelineRunner = (
  app: AppRuntime,
  ctx: RequestContext,
  request: Request,
) => Promise<Response>;

/** Runs one synthesized request on behalf of a parent context (what the batch handler receives). */
export type SubRequestRunner = (request: Request, parentCtx: RequestContext) => Promise<Response>;

/**
 * Run a synthesized request through the whole pipeline under a fresh request context, then
 * propagate render-affecting facts to the parent: a dynamic-API read inside the API route
 * must stop the PAGE from being cached; cache tags the child read purge the parent's page too.
 *
 * @param run The pipeline entry (`runPipeline`).
 * @param app The app runtime.
 * @param request The synthesized child request.
 * @param parentCtx The parent's context.
 * @returns The child's response, or a 508 when self-calls nest past the depth limit.
 */
export async function runSubRequest(
  run: PipelineRunner,
  app: AppRuntime,
  request: Request,
  parentCtx: RequestContext,
): Promise<Response> {
  const depth = (parentCtx.subRequestDepth ?? 0) + 1;
  if (depth > MAX_SUB_REQUEST_DEPTH) {
    return new Response("Loop Detected", {
      status: 508,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const child = createRequestContext(request, request.signal);
  child.subRequestDepth = depth;
  child.routes = parentCtx.routes;
  const res = await runWithContext(child, () => run(app, child, request));
  propagateToParent(child, parentCtx);
  await runDeferred(child);
  return res;
}

/** What a child learned that the parent's render/cache decisions must see. */
function propagateToParent(child: RequestContext, parent: RequestContext): void {
  if (child.usedDynamicApi) parent.usedDynamicApi = true;
  if (child.collectedTags?.size) {
    parent.collectedTags ??= new Set();
    for (const t of child.collectedTags) parent.collectedTags.add(t);
  }
  if (child.updatedTags?.size) {
    parent.updatedTags ??= new Set();
    for (const t of child.updatedTags) parent.updatedTags.add(t);
  }
}
