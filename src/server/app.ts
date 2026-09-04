// `createApp`: the core request handler. Wraps the request pipeline
// (request-pipeline.ts) with everything that is per-request but not routing: the
// concurrency ceiling, the async request context + abort signal, the request timeout,
// the correlation-id echo, the default hardening headers, request logging, and the
// concurrency-slot release.

import {
  type AppConfig,
  DEFAULT_REQUEST_TIMEOUT,
  DEFAULT_SLOT_BACKSTOP,
  isRegenRequest,
  type RequestHandler,
  type RequestLogInfo,
} from "./app-config.ts";
import { createRequestContext, runWithContext } from "./request-context.ts";
import { installFetchCache } from "./cache.ts";
import { setBasePath } from "../client/navigation.ts";
import { applyDefaultSecurityHeaders } from "./response-headers.ts";
import { type AppRuntime, type CompiledRules, compileRules } from "./pipeline-state.ts";
import { runPipeline } from "./request-pipeline.ts";

export type { AppConfig, RequestHandler, RequestLogInfo } from "./app-config.ts";
export { applyDefaultSecurityHeaders, hstsHeaderValue } from "./response-headers.ts";
export { routeUsesBoundary } from "./flight-routing.ts";

/**
 * Build the core request handler from an {@linkcode AppConfig}: routing,
 * SSR/streaming, API routes, the image endpoint, static files, caching, and the
 * optional request-logging/timeout wrappers. Most apps use {@linkcode serve}
 * instead; use `createApp` directly to embed denext in a custom server.
 *
 * @param config How to resolve the manifest, load modules, and behave.
 * @returns A `(Request) => Promise<Response>` handler.
 */
export function createApp(config: AppConfig): RequestHandler {
  // Install automatic fetch() caching (uncached by default; opt in per fetch via
  // next:{revalidate,tags} / cache:"force-cache"). Idempotent + a pass-through
  // outside a request, so it is safe to call on every createApp.
  installFetchCache();
  const basePath = config.basePath?.replace(/\/$/, "") || "";
  // Make server-rendered <Link>s prefix basePath (client reads it from hydration).
  setBasePath(basePath);
  // Opt-in in-process concurrency ceiling (see AppConfig.maxConcurrency). A single
  // per-app counter of in-flight client requests; 0 disables. Fast-fail 503 when at
  // capacity — deliberately not a queue (queuing just moves the overload).
  const maxConcurrency = config.maxConcurrency && config.maxConcurrency > 0
    ? Math.floor(config.maxConcurrency)
    : 0;
  let inFlight = 0;
  let compiled: CompiledRules | null = null;
  const app: AppRuntime = {
    config,
    basePath,
    rules: () => (compiled ??= compileRules(config)),
    handle: null!, // wired below — the ISR background regen loops back through it
  };

  const handle = (originalRequest: Request): Promise<Response> => {
    // A background ISR regen (x-denext-regen) is a detached internal task, not a
    // client request — exempt from the concurrency ceiling and the client timeout.
    const isBackgroundRegen = isRegenRequest(originalRequest);
    const counted = maxConcurrency > 0 && !isBackgroundRegen;
    if (counted) {
      if (inFlight >= maxConcurrency) return Promise.resolve(shedRequest(config, originalRequest));
      inFlight++;
    }
    // Establish the per-request async context so cookies()/headers() work in
    // server components, route handlers, and middleware.
    const requestCtx = createRequestContext(originalRequest);
    const startedAt = performance.now();
    // Per-request abort signal — fires on client disconnect or (when configured)
    // request timeout. Exposed on the context so handlers/components can thread it
    // into their own fetch()es for cooperative cancellation.
    const controller = new AbortController();
    linkAbort(originalRequest.signal, controller);
    requestCtx.signal = controller.signal;

    let pipeline = runWithContext(
      requestCtx,
      () => runPipeline(app, requestCtx, originalRequest),
    );
    // Per-request timeout: race the pipeline against a deadline → 503. Defaults to
    // 30s so a runaway or wedged render/action can't pin resources; the render is
    // signal-aware, so the abort actually reclaims the work. `requestTimeout: 0`
    // disables; a background regen has no client deadline.
    const requestTimeout = isBackgroundRegen
      ? 0
      : (config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT);
    if (requestTimeout > 0) pipeline = withRequestTimeout(pipeline, requestTimeout, controller);
    pipeline = pipeline.then((res) => echoRequestId(res, requestCtx.requestId));
    const secure = isSecureRequest(config, originalRequest);
    pipeline = pipeline.then((res) => applyDefaultSecurityHeaders(res, secure, config.hsts));
    pipeline = withRequestLog(pipeline, config, originalRequest, requestCtx.requestId, startedAt);
    if (counted) {
      pipeline = withSlotRelease(pipeline, requestTimeout, config.slotBackstop, () => {
        inFlight--;
      });
    }
    return pipeline;
  };
  app.handle = handle;
  return handle;
}

/** The request logger: the app's `onRequest`, else the DENEXT_LOG default, else none. */
function requestLogger(config: AppConfig): ((info: RequestLogInfo) => void) | undefined {
  return config.onRequest ?? (REQUEST_LOG_ENABLED ? defaultRequestLog : undefined);
}

/**
 * Concurrency ceiling: shed immediately (503 + Retry-After) when already at capacity,
 * before doing any per-request work. Surfaced to observability with a 0ms `shed` line
 * (no per-request context exists yet, so it carries no correlation id).
 */
function shedRequest(config: AppConfig, request: Request): Response {
  const res = new Response("Service Unavailable", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1" },
  });
  const log = requestLogger(config);
  if (log) {
    try {
      log({
        method: request.method,
        path: new URL(request.url).pathname,
        status: 503,
        durationMs: 0,
        requestId: "shed",
      });
    } catch { /* observability must never break the response */ }
  }
  return res;
}

/**
 * Echo the correlation id on every error response (M5) — the global-error 500, the
 * timeout 503, and the abort 503, matching the fallback 500 and the documented contract.
 * Applied after the timeout wrap so the 503 it produces is covered too. (The
 * pre-context shed 503 has no id yet and is left as-is.)
 */
function echoRequestId(res: Response, requestId: string): Response {
  if (res.status >= 500 && !res.headers.has("x-request-id")) {
    try {
      res.headers.set("x-request-id", requestId);
    } catch { /* immutable headers (rare) — leave as-is */ }
  }
  return res;
}

/**
 * Whether the client connection is HTTPS, for HSTS. `x-forwarded-proto` is only
 * consulted behind a trusted proxy (config.trustForwardedHeaders) — otherwise a client
 * could spoof it — falling back to the connection's own protocol. A proxy may emit a
 * comma-separated chain ("https, http"); the first hop is the client scheme.
 */
function isSecureRequest(config: AppConfig, request: Request): boolean {
  const forwardedProto = config.trustForwardedHeaders
    ? request.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase()
    : undefined;
  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}

/** Observability: emit timing + final status after the response resolves. */
function withRequestLog(
  pipeline: Promise<Response>,
  config: AppConfig,
  request: Request,
  requestId: string,
  startedAt: number,
): Promise<Response> {
  const logRequest = requestLogger(config);
  if (!logRequest) return pipeline;
  return pipeline.then((res) => {
    try {
      logRequest({
        method: request.method,
        path: new URL(request.url).pathname,
        status: res.status,
        durationMs: performance.now() - startedAt,
        requestId,
      });
    } catch { /* observability must never break the response */ }
    return res;
  });
}

/**
 * Release the concurrency slot once the response is produced, on every exit path
 * (success, error, abort, timeout — all settle the pipeline). For a streaming body this
 * is when the Response is returned, not when the body finishes: the ceiling bounds
 * handler/render concurrency up to Response production, and the client-read duration of
 * a stream is bounded at the edge (see maxConcurrency docs) — holding the slot for the
 * whole download would invite a slowloris-read slot exhaustion and would starve
 * long-lived SSE under the ceiling. With no request deadline, a render that never
 * settles would otherwise never release its slot: a backstop timer frees the slot (only
 * the counter, not the render) so the ceiling can never permanently wedge. Unref'd so it
 * can't by itself keep the process alive; cleared on the normal exit.
 */
function withSlotRelease(
  pipeline: Promise<Response>,
  requestTimeout: number,
  slotBackstop: number | undefined,
  releaseSlot: () => void,
): Promise<Response> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
  if (requestTimeout !== 0) return pipeline.finally(release);
  const backstop = setTimeout(release, slotBackstop ?? DEFAULT_SLOT_BACKSTOP);
  Deno.unrefTimer(backstop);
  return pipeline.finally(() => {
    clearTimeout(backstop);
    release();
  });
}

/** Abort `controller` when `source` aborts (client disconnect), if present. */
function linkAbort(
  source: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (!source) return;
  if (source.aborted) {
    controller.abort();
    return;
  }
  source.addEventListener("abort", () => controller.abort(), { once: true });
}

/** Race a response against a timeout; on expiry, abort in-flight work and 503. */
function withRequestTimeout(
  pipeline: Promise<Response>,
  ms: number,
  controller: AbortController,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(
        new Response("Service Unavailable (request timeout)", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }, ms);
  });
  return Promise.race([pipeline, timeout]).finally(() => clearTimeout(timer));
}

/** The `DENEXT_LOG` value ("", "1", "json", …), or "" when unset/unreadable. */
const REQUEST_LOG_MODE = (() => {
  try {
    return Deno.env.get("DENEXT_LOG") ?? "";
  } catch {
    return ""; // env not permitted; stay silent
  }
})();

/** Whether the default request logger is enabled at all (`DENEXT_LOG` set). */
const REQUEST_LOG_ENABLED = REQUEST_LOG_MODE !== "";
/** Whether to emit structured JSON (`DENEXT_LOG=json`) vs. the compact human line. */
const REQUEST_LOG_JSON = REQUEST_LOG_MODE.toLowerCase() === "json";

function defaultRequestLog(info: RequestLogInfo): void {
  // `DENEXT_LOG=json` emits one structured JSON object per request (ingestible by a
  // log pipeline); any other truthy value emits the compact human-readable line.
  if (REQUEST_LOG_JSON) {
    console.log(JSON.stringify({
      level: "info",
      msg: "request",
      method: info.method,
      path: info.path,
      status: info.status,
      statusClass: `${Math.floor(info.status / 100)}xx`,
      durationMs: Number(info.durationMs.toFixed(1)),
      requestId: info.requestId,
    }));
    return;
  }
  console.log(
    `[denext] ${info.method} ${info.path} ${info.status} ` +
      `${info.durationMs.toFixed(1)}ms ${info.requestId}`,
  );
}
