// SPA mode dev server: the request handler — live-reload SSE, the dev-reload module, the
// unbundled module graph, the generation's client assets, `public/`, and the shell.

import { devPlatformOf, pinDevPlatform } from "../platform-extensions.ts";
import { devLogResponse, devOriginAllowed, devStateResponse } from "../dev-server/dev-endpoints.ts";
import { DEV_LOG_PATH, DEV_STATE_PATH } from "../dev-server/state.ts";
import { reactNativeRootStyle } from "../../server/config.ts";
import { serveStatic } from "../../server/static.ts";
import { sseStream } from "../sse.ts";
import { spaDevReloadScript } from "./dev-reload-script.ts";
import {
  devShell,
  ensureBuilt,
  ensureUnbundled,
  getUnbundledCss,
  type SpaDevState,
  UNBUNDLED_STYLE_PATH,
} from "./dev-state.ts";
import {
  CLIENT_PREFIX,
  DEV_RELOAD_JS_PATH,
  ENTRY_FILE,
  escapeHtml,
  RELOAD_PATH,
  spaClientPrefix,
  spaShellHtml,
  STYLE_FILE,
  wantsShell,
} from "./shared.ts";

const jsHeaders = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" };
const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A client asset (the entry bundle, a split chunk, the stylesheet) from the current build;
 * `pathname` is under `prefix` (`spa.assetsDir`'s, or `/_denext/client/`).
 */
async function serveClientAsset(
  st: SpaDevState,
  pathname: string,
  prefix: string,
): Promise<Response> {
  let dir: string;
  try {
    dir = await ensureBuilt(st);
  } catch (err) {
    console.error("denext: SPA bundle error", err);
    const body = `console.error(${
      JSON.stringify("denext SPA bundle error:\n" + errorMessage(err))
    });`;
    return new Response(body, { status: 500, headers: jsHeaders });
  }
  const asset = await serveStatic(dir, "/" + pathname.slice(prefix.length));
  if (asset) {
    asset.headers.set("cache-control", "no-store");
    return asset;
  }
  return new Response("// not found", { status: 404, headers: jsHeaders });
}

function htmlResponse(request: Request, html: string, status = 200): Response {
  return new Response(request.method === "HEAD" ? null : html, { status, headers: htmlHeaders });
}

/**
 * The shell for a navigation. Unbundled loop: the shell points at the unbundled entry
 * (the app graph is served per-module, no whole-bundle build) and links the extracted
 * CSS. Bundled loop: build the current generation first, rendering the error as HTML.
 */
async function serveShell(st: SpaDevState, request: Request): Promise<Response> {
  const rnRootStyle = reactNativeRootStyle(st.paths.config);
  const platform = devPlatformOf(request);
  try {
    if (await ensureUnbundled(st) && st.unbundled) {
      const css = await getUnbundledCss(st, platform);
      const html = await spaShellHtml({
        spa: st.spa,
        scriptSrc: st.unbundled.spaEntryUrl(),
        styleHref: css.length > 0 ? UNBUNDLED_STYLE_PATH : undefined,
        devScriptSrc: DEV_RELOAD_JS_PATH,
        reactNativeRootStyle: rnRootStyle,
        shell: await devShell(st, platform),
      });
      return htmlResponse(request, html);
    }
    await ensureBuilt(st);
    const prefix = spaClientPrefix(st.spa);
    const html = await spaShellHtml({
      spa: st.spa,
      scriptSrc: `${prefix}${ENTRY_FILE}`,
      styleHref: st.hasStyles ? `${prefix}${STYLE_FILE}` : undefined,
      devScriptSrc: DEV_RELOAD_JS_PATH,
      reactNativeRootStyle: rnRootStyle,
      shell: await devShell(st, "web"),
    });
    return htmlResponse(request, html);
  } catch (err) {
    const body = `<pre>denext SPA build error:\n\n${escapeHtml(errorMessage(err))}</pre>`;
    return new Response(body, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

/** The unbundled module graph (`/_denext/@*`) and its extracted stylesheet, or null. */
async function serveUnbundled(
  st: SpaDevState,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url;
  if (pathname.startsWith("/_denext/@") && await ensureUnbundled(st) && st.unbundled) {
    const res = await st.unbundled.handle(request, url, { pages: [] } as never);
    if (res) return res;
  }
  if (pathname === UNBUNDLED_STYLE_PATH && await ensureUnbundled(st)) {
    return new Response(await getUnbundledCss(st, devPlatformOf(request)), {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

/** The SPA dev request handler. */
export function createSpaDevHandler(st: SpaDevState): (request: Request) => Promise<Response> {
  const handle = spaRequestHandler(st);
  // A shell's `?__denext_platform=ios` is pinned in a cookie, so the page's module requests
  // resolve that target's platform files too.
  return async (request) => pinDevPlatform(request, await handle(request));
}

/** Whether `pathname` is a dev endpoint or a client asset (behind the dev origin gate). */
function gatedPath(pathname: string, prefix: string): boolean {
  return pathname.startsWith("/_denext/") || pathname.startsWith(prefix);
}

/** {@linkcode createSpaDevHandler}'s routing, before the platform cookie. */
function spaRequestHandler(st: SpaDevState): (request: Request) => Promise<Response> {
  const allowed = st.options.allowedDevOrigins ?? [];
  const prefix = spaClientPrefix(st.spa);
  const reloadScript = spaDevReloadScript(prefix);
  return async (request) => {
    const url = new URL(request.url);
    // Same Host/Origin gate as the app dev server (DNS-rebinding defense): the reload stream,
    // the unbundled module graph (transformed project source) and the client assets — under
    // `spa.assetsDir` too — must not be reachable from a foreign origin.
    if (gatedPath(url.pathname, prefix) && !devOriginAllowed(request, url, allowed)) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === RELOAD_PATH) return sseStream(st.reloadClients);
    if (url.pathname === DEV_RELOAD_JS_PATH) {
      return new Response(reloadScript, { headers: jsHeaders });
    }
    // The dev black box, as on the App Router dev server: the page's console capture posts
    // here, and `denext_dev_logs` reads it back.
    if (url.pathname === DEV_LOG_PATH && request.method === "POST") {
      return devLogResponse(st, request);
    }
    // SPA dev records no request log: `kind=request` stays unanswered, so the Network tab
    // keeps saying it is App-Router-only instead of showing an empty table.
    if (url.pathname === DEV_STATE_PATH && url.searchParams.get("kind") !== "request") {
      return devStateResponse(st, url);
    }
    const unbundled = await serveUnbundled(st, request, url);
    if (unbundled) return unbundled;
    return await serveFile(st, request, url, prefix);
  };
}

/**
 * Under `spa.assetsDir`, the bundled loop's file at `pathname` (it wins over a public one), or
 * null: not in the bundle, or the unbundled loop is the page's client (no bundle to ask).
 */
async function bundleFirst(
  st: SpaDevState,
  pathname: string,
  prefix: string,
): Promise<Response | null> {
  if (await ensureUnbundled(st)) return null;
  const asset = await serveClientAsset(st, pathname, prefix);
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  return null;
}

/**
 * The file a request for `url` gets ahead of the plain client lookup: under `spa.assetsDir`, the
 * bundle's (see {@link bundleFirst}) and then a public one; outside the client prefix, a public
 * file; under `/_denext/client/`, nothing (the client lookup answers it).
 */
async function bundleOrPublic(
  st: SpaDevState,
  request: Request,
  url: URL,
  prefix: string,
  client: boolean,
): Promise<Response | null> {
  const shared = client && prefix !== CLIENT_PREFIX;
  const built = shared ? await bundleFirst(st, url.pathname, prefix) : null;
  if (built || (client && !shared)) return built;
  const accEnc = request.headers.get("accept-encoding") ?? undefined;
  return await serveStatic(st.paths.publicDir, url.pathname, accEnc, request);
}

/**
 * A client asset under `prefix`, a `public/` file, or the shell for a navigation. Under
 * `spa.assetsDir` the client shares its directory with `public/` (Vite's `assets/`): where the
 * bundle is the page's client (the bundled loop) a path it holds is the bundle's, as `denext
 * start` and the export serve it, and a public file answers the rest. The unbundled loop serves
 * the page from its module graph, so there a public file is served without building the bundle.
 */
async function serveFile(
  st: SpaDevState,
  request: Request,
  url: URL,
  prefix: string,
): Promise<Response> {
  const client = url.pathname.startsWith(prefix);
  const local = await bundleOrPublic(st, request, url, prefix, client);
  if (local) return local;
  if (client) return serveClientAsset(st, url.pathname, prefix);
  if (wantsShell(request, url.pathname)) return serveShell(st, request);
  return new Response("not found", { status: 404 });
}
