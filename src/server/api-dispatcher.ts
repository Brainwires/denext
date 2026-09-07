// In-process dispatch for the typed API client during SSR.
//
// A Server Component (or a route handler) that calls its own API through `createApiClient`
// used to loop back over HTTP. Installed once per app by `createApp`, this dispatcher instead
// runs the call as a sub-request through the FULL pipeline (middleware, rewrites, the redacted
// 500 contract — see `sub-request.ts`) under the current request's identity: an allowlisted
// copy of its headers (cookie, authorization, …), its socket peer, its abort signal, and a
// derived `x-request-id`. It refuses anything that is not a same-origin app path (a foreign
// `base`, a reserved `/_denext/*` endpoint) by returning `null`, which sends the client back
// to a real `fetch`.
//
// Cache: a GET goes through the same decision as the patched global `fetch`
// (`fetchCacheDecision`: the route's `fetchCache` segment default, then the call's `cache` /
// `next.revalidate` / `next.tags`), and a cacheable call is served by `cachedResponse` with
// the sub-request as its miss — so the page collects the tags, `revalidateTag` purges the
// entry, `updateTag` read-your-writes applies, concurrent misses coalesce, and the key includes
// the caller's cookie/authorization fingerprint (no cross-user confusion). No `cache`/`next` →
// uncached, exactly like `fetch`.

import type { AppRuntime } from "./pipeline-state.ts";
import { runPipeline } from "./request-pipeline.ts";
import { currentContext, type RequestContext } from "./request-context.ts";
import { cachedResponse, fetchCacheDecision } from "./cache.ts";
import { runSubRequest, synthesizeSubRequest } from "./sub-request.ts";
import { type ApiDispatchInit, setApiDispatcher } from "../runtime/api-dispatch.ts";
import { BATCH_ITEM_HEADER } from "../runtime/api-batch-protocol.ts";

/** Per-request counter for the derived request ids (`#api1`, `#api2`, …). */
const COUNTER_KEY = Symbol.for("denext.apiDispatch.counter");

/**
 * Install the in-process dispatcher for `app`. Idempotent per process (the last app wins —
 * one app per process is the norm; tests re-install).
 *
 * @param app The app runtime.
 */
export function installApiDispatcher(app: AppRuntime): void {
  setApiDispatcher((url, init) => dispatchInProcess(app, url, init));
}

/** One call: resolve, refuse what is not ours, synthesize, run (through the cache for a GET). */
function dispatchInProcess(
  app: AppRuntime,
  url: string,
  init: ApiDispatchInit,
): Promise<Response> | null {
  const ctx = currentContext();
  if (!ctx) return null; // outside a request (a script, a test): real fetch
  const target = resolveOwnUrl(ctx.request, url);
  if (!target) return null;
  const request = synthesizeSubRequest({
    method: init.method,
    url: target,
    parent: ctx.request,
    parentCtx: ctx,
    idSuffix: `#api${nextId(ctx)}`,
    extraHeaders: init.headers,
    signal: init.signal,
    body: init.body,
  });
  const run = () => runSubRequest(runPipeline, app, request, ctx);
  if (init.method !== "GET") return run();
  const decision = fetchCacheDecision(ctx.segmentConfig?.fetchCache, {
    cache: init.cache,
    next: init.next,
  });
  if (!decision) return run();
  // The cache key fingerprints the IDENTITY headers (cookie, authorization) plus whatever the
  // caller set explicitly, so two users never share an entry — and nothing else: a key that
  // varied on user-agent / x-forwarded-for / accept-* would let any client mint a fresh durable
  // entry per request (tag-only entries never expire).
  return cachedResponse(
    request,
    { headers: cacheKeyHeaders(request, init.headers) },
    decision.revalidate,
    decision.tags,
    run,
  );
}

/** Identity headers every key must vary on. */
const KEY_HEADERS = ["cookie", "authorization"];

/** The headers the cache key fingerprints: identity + the caller's explicit ones (never UA/XFF). */
function cacheKeyHeaders(request: Request, explicit: HeadersInit | undefined): Headers {
  const h = new Headers();
  for (const name of KEY_HEADERS) {
    const v = request.headers.get(name);
    if (v !== null) h.set(name, v);
  }
  for (const [name] of new Headers(explicit)) {
    if (name === "x-request-id" || name === BATCH_ITEM_HEADER) continue;
    const v = request.headers.get(name);
    if (v !== null) h.set(name, v);
  }
  return h;
}

/** The call's URL on the app's own origin, or `null` for a foreign origin / reserved path. */
function resolveOwnUrl(parent: Request, url: string): URL | null {
  let target: URL;
  try {
    target = new URL(url, parent.url);
  } catch {
    return null;
  }
  if (target.origin !== new URL(parent.url).origin) return null;
  if (target.pathname.startsWith("/_denext")) return null;
  return target;
}

function nextId(ctx: RequestContext): number {
  const memo = ctx.memo;
  let table = memo.get(COUNTER_KEY);
  if (!table) memo.set(COUNTER_KEY, table = new Map());
  const n = ((table.get("n") as number | undefined) ?? 0) + 1;
  table.set("n", n);
  return n;
}
