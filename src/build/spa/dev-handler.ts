// SPA mode dev server: the request handler — live-reload SSE, the dev-reload module, the
// unbundled module graph, the generation's client assets, `public/`, and the shell.

import { serveStatic } from "../../server/static.ts";
import { sseStream } from "../sse.ts";
import { SPA_DEV_RELOAD } from "./dev-reload-script.ts";
import {
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
  spaShellHtml,
  STYLE_FILE,
  wantsShell,
} from "./shared.ts";

const jsHeaders = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" };
const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A client asset (the entry bundle, a split chunk, the stylesheet) from the current build. */
async function serveClientAsset(st: SpaDevState, pathname: string): Promise<Response> {
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
  const asset = await serveStatic(dir, "/" + pathname.slice(CLIENT_PREFIX.length));
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
  if (await ensureUnbundled(st) && st.unbundled) {
    const css = await getUnbundledCss(st);
    const html = await spaShellHtml({
      spa: st.spa,
      scriptSrc: st.unbundled.spaEntryUrl(),
      styleHref: css.length > 0 ? UNBUNDLED_STYLE_PATH : undefined,
      devScriptSrc: DEV_RELOAD_JS_PATH,
    });
    return htmlResponse(request, html);
  }
  try {
    await ensureBuilt(st);
  } catch (err) {
    const body = `<pre>denext SPA build error:\n\n${escapeHtml(errorMessage(err))}</pre>`;
    return new Response(body, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const html = await spaShellHtml({
    spa: st.spa,
    scriptSrc: `${CLIENT_PREFIX}${ENTRY_FILE}`,
    styleHref: st.hasStyles ? `${CLIENT_PREFIX}${STYLE_FILE}` : undefined,
    devScriptSrc: DEV_RELOAD_JS_PATH,
  });
  return htmlResponse(request, html);
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
    return new Response(await getUnbundledCss(st), {
      headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

/** The SPA dev request handler. */
export function createSpaDevHandler(st: SpaDevState): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === RELOAD_PATH) return sseStream(st.reloadClients);
    if (url.pathname === DEV_RELOAD_JS_PATH) {
      return new Response(SPA_DEV_RELOAD, { headers: jsHeaders });
    }
    const unbundled = await serveUnbundled(st, request, url);
    if (unbundled) return unbundled;
    if (url.pathname.startsWith(CLIENT_PREFIX)) return serveClientAsset(st, url.pathname);
    const accEnc = request.headers.get("accept-encoding") ?? undefined;
    const pub = await serveStatic(st.paths.publicDir, url.pathname, accEnc, request);
    if (pub) return pub;
    if (wantsShell(request, url.pathname)) return serveShell(st, request);
    return new Response("not found", { status: 404 });
  };
}
