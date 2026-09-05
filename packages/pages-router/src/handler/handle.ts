// The request dispatcher: strip the base path, serve client bundles, run API routes,
// then match a page and answer it as prefetch / prerendered / data / HTML.

import { matchSegments, peelLocale } from "@denext/denext/server";
import type { PageEntry, PagesScan } from "../scan.ts";
import { type ApiModule, runApiRoute } from "../api.ts";
import { PAGES_PREFIX } from "../client-bundle.ts";
import { previewCookieFrom, previewSecrets, readPreview } from "../preview.ts";
import { pageRequest, renderData, renderError, renderMatched, renderPrefetch } from "./render.ts";
import { servePrerendered } from "./prerendered.ts";
import { DATA_HEADER, forMethod, type HandlerState, PREFETCH_HEADER } from "./shared.ts";

/** Framework paths and asset-like requests (they have an extension) are never pages. */
function looksLikeAsset(pathname: string): boolean {
  return /\.[^/]+$/.test(pathname) || pathname.startsWith("/_denext");
}

/** The request handler for one `createPagesHandler` instance. */
export function createHandle(st: HandlerState): (request: Request) => Promise<Response | null> {
  return async function handle(request: Request): Promise<Response | null> {
    try {
      return await dispatch(st, request);
    } catch (err) {
      // Last-resort backstop: the plugin must never throw out to core with an
      // unhandled error. For requests it clearly doesn't own (assets with an
      // extension, framework paths) return null so core can still static-serve them
      // even while the plugin is broken; only 500 a page-like request.
      console.error("@denext/pages-router: unhandled handler error", err);
      if (looksLikeAsset(new URL(request.url).pathname)) return null;
      return new Response("Internal Server Error", { status: 500 });
    }
  };
}

async function dispatch(st: HandlerState, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = stripBase(st, url.pathname);
  if (pathname === null) return null;
  // Client hydration bundles (served in dev + prod-from-source).
  if (st.opts.bundler && pathname.startsWith(PAGES_PREFIX)) {
    const served = await serveBundle(st, pathname);
    if (served) return served;
  }
  const scan = await st.opts.getScan();
  // API routes match any method (POST/PUT/…), before pages.
  const api = await matchApi(st, scan, request, pathname, url);
  if (api) return api;
  // Page routes render for GET/HEAD only.
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  // i18n: peel an optional locale prefix; match against the stripped path and
  // carry the active locale into data fetching, `__NEXT_DATA__`, and the router.
  const peeled = st.opts.i18n ? peelLocale(pathname, st.opts.i18n) : null;
  const routingPath = peeled ? peeled.rest : pathname;
  for (const entry of scan.pages) {
    const params = matchSegments(entry.pattern, routingPath);
    if (params) {
      const req = pageRequest(entry, params, request, url, pathname, peeled?.locale);
      return await servePage(st, scan, entry, req, routingPath);
    }
  }
  return await notFoundPage(st, scan, request, pathname, url);
}

/** The app-relative pathname, or null when the request is outside the base path. */
function stripBase(st: HandlerState, pathname: string): string | null {
  if (!st.base) return pathname;
  if (pathname === st.base) return "/";
  if (pathname.startsWith(st.base + "/")) return pathname.slice(st.base.length);
  return null;
}

/** A bundling failure (e.g. a page with a syntax error) must not crash the request. */
async function serveBundle(st: HandlerState, pathname: string): Promise<Response | null> {
  try {
    return await st.opts.bundler!.serve(pathname);
  } catch (err) {
    console.error("@denext/pages-router: bundle serve failed for", pathname, err);
    return new Response("/* bundle error */", {
      status: 500,
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
}

/** Run the first matching `pages/api/*` route, or null when none matches. */
async function matchApi(
  st: HandlerState,
  scan: PagesScan,
  request: Request,
  pathname: string,
  url: URL,
): Promise<Response | null> {
  for (const entry of scan.api) {
    const params = matchSegments(entry.pattern, pathname);
    if (!params) continue;
    let mod: ApiModule;
    try {
      mod = await st.opts.load(entry.filePath) as ApiModule;
    } catch (err) {
      console.error("@denext/pages-router: failed to load API route", entry.filePath, err);
      return new Response("Internal Server Error", { status: 500 });
    }
    return await runApiRoute(mod, request, params, url);
  }
  return null;
}

/**
 * Answer a matched page: a prefetch (chunk URLs only — never HTML, data, or gSSP), a
 * build-time prerendered page (with ISR), a soft-navigation data response, or the
 * HTML document.
 */
async function servePage(
  st: HandlerState,
  scan: PagesScan,
  entry: PageEntry,
  req: ReturnType<typeof pageRequest>,
  routingPath: string,
): Promise<Response> {
  const { request } = req;
  if (request.headers.get(PREFETCH_HEADER) === "1") return await renderPrefetch(st, entry);
  const wantsData = request.headers.get(DATA_HEADER) === "1";
  // A non-default locale renders live so getStaticProps runs with the locale
  // (per-locale SSG output isn't prewritten), keeping localized content correct.
  // Preview Mode also bypasses the static cache so drafts render live. The cookie is
  // VERIFIED here, not just detected: a forged/junk cookie must not let anyone force every
  // request into a live render (a cache-bypass DoS lever).
  const nonDefaultLocale = !!st.opts.i18n && req.locale !== st.opts.i18n.defaultLocale;
  const rawPreview = previewCookieFrom(request.headers.get("cookie"));
  const inPreview = rawPreview !== undefined &&
    (await readPreview(rawPreview, previewSecrets())) !== null;
  if (!nonDefaultLocale && !inPreview) {
    // ISR regen is reached only for the default locale (non-default renders live).
    const regen = () =>
      renderMatched(st, scan, entry, {
        ...req,
        pathname: routingPath,
        locale: st.opts.i18n?.defaultLocale,
      });
    const pre = await servePrerendered(st, routingPath, wantsData, regen);
    if (pre) return forMethod(request, pre);
  }
  if (wantsData) return await serveData(st, scan, entry, req);
  try {
    return forMethod(request, await renderMatched(st, scan, entry, req));
  } catch (err) {
    console.error("@denext/pages-router: render error for", req.pathname, err);
    return forMethod(request, await renderError(st, scan, 500, req.pathname, req.url));
  }
}

/** Keep the JSON contract even on failure so the client can fall back. */
async function serveData(
  st: HandlerState,
  scan: PagesScan,
  entry: PageEntry,
  req: ReturnType<typeof pageRequest>,
): Promise<Response> {
  try {
    return await renderData(st, entry, req, scan.app);
  } catch (err) {
    console.error("@denext/pages-router: data error for", req.pathname, err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * No page matched. Render the custom 404 (`404.tsx`/`_error`) for page-like paths
 * only — never for asset requests (they have an extension) or framework paths, so
 * `public/` files still fall through to static serving. Without a custom error page,
 * return null so core handles the 404.
 */
async function notFoundPage(
  st: HandlerState,
  scan: PagesScan,
  request: Request,
  pathname: string,
  url: URL,
): Promise<Response | null> {
  const wantsData = request.headers.get(DATA_HEADER) === "1";
  if (!(scan.notFound || scan.error) || wantsData || looksLikeAsset(pathname)) return null;
  return forMethod(request, await renderError(st, scan, 404, pathname, url));
}
