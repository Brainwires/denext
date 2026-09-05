// The dev request handler: the dev-only `/_denext/*` endpoints (reload stream, editor,
// black box, runtime script, unbundled modules, bundles, chunks, route CSS, health,
// images), then the app itself with request timing recorded in the black box.

import type { RequestHandler } from "../../server/app.ts";
import { LIVE_ENDPOINT } from "../../runtime/live-protocol.ts";
import { handleLiveUpgrade } from "../../server/live.ts";
import { IMAGE_ENDPOINT } from "../../runtime/image.ts";
import { imageOptionsFromConfig, optimizeImage } from "../../server/image-optimizer.ts";
import { extractRouteCss } from "../css.ts";
import { routeSourceFiles } from "../bundle.ts";
import { getCss } from "./assets.ts";
import { getFlightBundle, getRouteBundle } from "./bundles.ts";
import {
  devLogResponse,
  devOriginAllowed,
  devStateResponse,
  openInEditorResponse,
} from "./dev-endpoints.ts";
import { getManifest, getUnbundled } from "./manifest.ts";
import { broadcastError, reloadStream } from "./reload.ts";
import { DEV_RELOAD_SCRIPT } from "./reload-script.ts";
import { devErrorPage } from "./error-page.ts";
import {
  DEV_LOG_PATH,
  DEV_RELOAD_JS_PATH,
  DEV_STATE_PATH,
  type DevState,
  FLIGHT_BUNDLE_PATH,
  OPEN_IN_EDITOR_PATH,
  RELOAD_PATH,
  ROUTE_BUNDLE_PATH,
  ROUTE_CSS_PATH,
} from "./state.ts";

const NO_STORE_JS = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "no-store",
};

function jsResponse(code: string): Response {
  return new Response(code, { headers: NO_STORE_JS });
}

/** A bundling failure: log it, push it to the overlay, and ship a console.error stub. */
function bundleErrorResponse(st: DevState, title: string, err: unknown): Response {
  console.error(`denext: ${title.toLowerCase()}`, err);
  broadcastError(st, title, err);
  const msg = err instanceof Error ? err.message : String(err);
  return new Response(
    `console.error(${JSON.stringify(`denext ${title.toLowerCase()}:\n` + msg)});`,
    { status: 500, headers: { "content-type": "text/javascript" } },
  );
}

/**
 * The origin-gated dev endpoints: the live-reload SSE stream, open-in-editor, and the dev
 * black box (browser log sink + state read). Null when `url` is none of them; 403 when a
 * cross-origin page tries (defense-in-depth — cf. CVE-2025-48068).
 */
function gatedDevEndpoint(
  st: DevState,
  request: Request,
  url: URL,
): Promise<Response> | Response | null {
  const gated = [RELOAD_PATH, OPEN_IN_EDITOR_PATH, DEV_LOG_PATH, DEV_STATE_PATH];
  if (!gated.includes(url.pathname)) return null;
  if (!devOriginAllowed(request, url, st.allowedDevOrigins)) {
    return new Response("forbidden", { status: 403 });
  }
  switch (url.pathname) {
    case RELOAD_PATH:
      return reloadStream(st);
    case OPEN_IN_EDITOR_PATH:
      return openInEditorResponse(st, url.searchParams);
    case DEV_LOG_PATH:
      return devLogResponse(st, request);
    default:
      return devStateResponse(st, url);
  }
}

/** App-wide Flight bundle (client islands + registry). */
async function flightBundleResponse(st: DevState): Promise<Response> {
  try {
    return jsResponse(await getFlightBundle(st));
  } catch (err) {
    return bundleErrorResponse(st, "Flight bundle error", err);
  }
}

/** On-demand client route bundle (`?p=<routePath>`). */
async function routeBundleResponse(st: DevState, url: URL): Promise<Response> {
  const routePath = url.searchParams.get("p");
  const m = await getManifest(st);
  const route = m.pages.find((p) => p.routePath === routePath);
  if (!route) return new Response("// route not found", { status: 404 });
  try {
    return jsResponse(await getRouteBundle(st, route));
  } catch (err) {
    return bundleErrorResponse(st, "Bundle error", err);
  }
}

/** Per-route extracted stylesheet (transformed CSS the route's graph reaches). */
async function routeCssResponse(st: DevState, url: URL): Promise<Response> {
  const routePath = url.searchParams.get("p");
  const m = await getManifest(st);
  const route = m.pages.find((p) => p.routePath === routePath);
  const css = await getCss(st);
  const text = route && css ? await extractRouteCss(routeSourceFiles(route), css) : "";
  return new Response(text, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * A split chunk from a dynamic import, emitted next to a route/flight entry. The entry's
 * relative `./chunk-*.js` import resolves here; the entry request populated `chunkCache`
 * before returning, so the chunk is present by now. Null when unknown.
 */
function chunkResponse(st: DevState, url: URL): Response | null {
  if (!url.pathname.startsWith("/_denext/") || !url.pathname.endsWith(".js")) return null;
  const chunk = st.chunkCache.get(url.pathname.slice("/_denext/".length));
  return chunk === undefined ? null : jsResponse(chunk);
}

/**
 * Unbundled dev loop: `@dep` / `@fs` / `@entry` / `@empty` modules. Null for any other URL,
 * so the bundled handlers stay the path for flight routes and the compat build. `getManifest`
 * FIRST: it resolves `unbundledCompat`, which `getUnbundled` captures at creation.
 */
async function unbundledResponse(
  st: DevState,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (!st.unbundledActive || !url.pathname.startsWith("/_denext/@")) return null;
  // Same Host/Origin gate as the other dev endpoints (DNS-rebinding defense): these URLs
  // serve transformed project source and must not be readable from a foreign origin.
  if (!devOriginAllowed(request, url, st.allowedDevOrigins)) {
    return new Response("forbidden", { status: 403 });
  }
  const m = await getManifest(st);
  return await getUnbundled(st).handle(request, url, m);
}

/**
 * A 500 for a navigation (HTML GET) becomes the dev error page for the most recent recorded
 * error — the same title/message/codeframe the terminal printed — so the first-hour mistake
 * (a syntax error in a page) shows in the browser instead of "Internal Server Error".
 */
async function devErrorPageFor(st: DevState, request: Request, res: Response): Promise<Response> {
  const wantsHtml = request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html");
  if (res.status < 500 || !wantsHtml) return res;
  const latest = st.devEvents.snapshot({ kind: "error", limit: 1 })[0];
  const page = devErrorPage(latest, DEV_RELOAD_JS_PATH);
  if (!page) return res;
  await res.body?.cancel();
  return new Response(page, {
    status: res.status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The app request, timed and recorded as a `request` event in the black box. */
async function appResponse(
  st: DevState,
  appHandler: RequestHandler,
  request: Request,
  url: URL,
): Promise<Response> {
  const started = performance.now();
  const res = await devErrorPageFor(st, request, await appHandler(request));
  st.devEvents.record({
    kind: "request",
    ts: Date.now(),
    source: "server",
    level: res.status >= 500 ? "error" : "info",
    message: `${request.method} ${url.pathname} → ${res.status}`,
    url: url.pathname,
    status: res.status,
    durationMs: Math.round(performance.now() - started),
  });
  return res;
}

/** The dev server's request handler over `appHandler` (the createApp handler). */
export function createDevHandler(st: DevState, appHandler: RequestHandler): RequestHandler {
  return async (request) => {
    const url = new URL(request.url);
    // Live Server Components WebSocket upgrade (before appHandler so the long-lived
    // socket dodges the per-request timeout + concurrency ceiling).
    if (url.pathname === LIVE_ENDPOINT) return handleLiveUpgrade(request);
    const gated = gatedDevEndpoint(st, request, url);
    if (gated) return gated;
    if (url.pathname === DEV_RELOAD_JS_PATH) return jsResponse(DEV_RELOAD_SCRIPT);
    const unbundled = await unbundledResponse(st, request, url);
    if (unbundled) return unbundled;
    if (url.pathname === FLIGHT_BUNDLE_PATH) return flightBundleResponse(st);
    // Liveness/readiness probe endpoint (for load balancers / k8s).
    if (url.pathname === "/_denext/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === IMAGE_ENDPOINT) {
      return optimizeImage(
        request,
        imageOptionsFromConfig(st.paths.config?.images, st.paths.publicDir),
      );
    }
    if (url.pathname === ROUTE_CSS_PATH) return routeCssResponse(st, url);
    const chunk = chunkResponse(st, url);
    if (chunk) return chunk;
    if (url.pathname === ROUTE_BUNDLE_PATH) return routeBundleResponse(st, url);
    return appResponse(st, appHandler, request, url);
  };
}
