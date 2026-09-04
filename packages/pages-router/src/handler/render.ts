// Rendering a matched page: the HTML document, the soft-navigation JSON data
// response, the prefetch response, and the error pages.

import { type NextData, renderPage } from "../render.ts";
import type { PageEntry, PagesScan } from "../scan.ts";
import { loadDefault, resolveData } from "./data.ts";
import {
  applyResHeaders,
  buildQuery,
  bundleUrls,
  type DataOutcome,
  type HandlerState,
  html,
  type PageModule,
  type PageRequest,
  withBase,
} from "./shared.ts";

/**
 * Render an error page — the custom `404`/`500`/`_error` component wrapped in
 * `_app`/`_document` — or a bare fallback document when the app has none. Error
 * pages render SSR-only (no per-route client bundle). `_error` receives
 * `{ statusCode }`; `404`/`500` receive no props (Next parity).
 */
export async function renderError(
  st: HandlerState,
  scan: PagesScan,
  status: number,
  pathname: string,
  url: URL,
): Promise<Response> {
  // Prefer the specific page (404.tsx/500.tsx); _error is the catch-all.
  const file = status === 404 ? (scan.notFound ?? scan.error) : (scan.serverError ?? scan.error);
  const Component = await loadDefault(st, file);
  if (!Component) {
    const title = status === 404 ? "404" : "500";
    const msg = status === 404 ? "Not Found" : "Internal Server Error";
    return html(`<!DOCTYPE html><title>${title}</title>${msg}`, status);
  }
  const App = await loadDefault(st, scan.app);
  const Document = await loadDefault(st, scan.document);
  const pageProps = file === scan.error ? { statusCode: status } : {};
  const nextData: NextData = {
    props: { pageProps },
    page: status === 404 ? "/404" : "/500",
    query: {},
    asPath: pathname + url.search,
    basePath: st.base || undefined,
  };
  const body = await renderPage({
    Page: Component,
    pageProps,
    App,
    nextData,
    clientBundle: null,
    styles: undefined,
    lang: st.opts.lang,
    Document,
  });
  return html(body, status);
}

/** Respond to a soft-navigation data request with JSON (props + entry URL). */
export async function renderData(
  st: HandlerState,
  entry: PageEntry,
  req: PageRequest,
  appFile: string | null,
): Promise<Response> {
  const mod = await st.opts.load(entry.filePath) as PageModule;
  const resHeaders = new Headers();
  // Data path: never a fallback shell — the client's follow-up fetch wants the real
  // getStaticProps output, so allowFallbackShell is false.
  const outcome = await resolveData(st, mod, req, appFile, resHeaders, false);
  if (outcome.kind === "redirect") {
    return Response.json({ redirect: { destination: outcome.destination } });
  }
  if (outcome.kind !== "props") return Response.json({ notFound: true }); // "fallback" can't occur here (allowFallbackShell=false)
  const { entryUrl, cssUrl } = await bundleUrls(st, entry.routePath);
  return applyResHeaders(
    Response.json({
      page: entry.routePath,
      entryUrl, // app-absolute, without basePath — the client re-adds it
      cssUrl, // ditto; the client injects the route's stylesheet before rendering
      pageProps: outcome.pageProps,
      query: req.query,
      asPath: req.pathname + req.url.search,
      isServer: outcome.isServer,
      locale: req.locale,
      locales: st.opts.i18n?.locales,
      defaultLocale: st.opts.i18n?.defaultLocale,
    }),
    resHeaders,
  );
}

/**
 * Answer a prefetch request: the route's code-chunk + CSS URLs only. No page
 * module is loaded and no data fetcher runs, so prefetch is side-effect-free.
 */
export async function renderPrefetch(st: HandlerState, entry: PageEntry): Promise<Response> {
  const { entryUrl, cssUrl } = await bundleUrls(st, entry.routePath);
  return Response.json({ page: entry.routePath, entryUrl, cssUrl, prefetch: true });
}

/** Render a matched page to a full HTML document. */
export async function renderMatched(
  st: HandlerState,
  scan: PagesScan,
  entry: PageEntry,
  req: PageRequest,
): Promise<Response> {
  const mod = await st.opts.load(entry.filePath) as PageModule;
  const Page = mod.default;
  if (typeof Page !== "function") return await renderError(st, scan, 500, req.pathname, req.url);
  const resHeaders = new Headers();
  // HTML path: allow a `fallback: true` shell (allowFallbackShell = true).
  const outcome = await resolveData(st, mod, req, scan.app, resHeaders, true);
  if (outcome.kind === "redirect") {
    return applyResHeaders(
      new Response(null, {
        status: outcome.statusCode ?? (outcome.permanent ? 308 : 307),
        headers: { location: outcome.destination },
      }),
      resHeaders,
    );
  }
  if (outcome.kind === "notFound") return await renderError(st, scan, 404, req.pathname, req.url);
  const body = await renderDocument(st, scan, entry, req, outcome, Page);
  return applyResHeaders(html(body), resHeaders);
}

/**
 * The page document for a resolved outcome. A `fallback: true` shell renders
 * props-less with `isFallback: true`; the client fetches the real getStaticProps data
 * (the data endpoint) and re-renders.
 */
async function renderDocument(
  st: HandlerState,
  scan: PagesScan,
  entry: PageEntry,
  req: PageRequest,
  outcome: Extract<DataOutcome, { kind: "props" | "fallback" }>,
  Page: NonNullable<PageModule["default"]>,
): Promise<string> {
  const App = await loadDefault(st, scan.app);
  const Document = await loadDefault(st, scan.document);
  const isFallback = outcome.kind === "fallback";
  const pageProps = isFallback ? {} : outcome.pageProps;
  const nextData: NextData = {
    props: { pageProps },
    page: entry.routePath,
    query: req.query,
    asPath: req.pathname + req.url.search,
    isServer: isFallback ? false : outcome.isServer,
    isFallback: isFallback || undefined,
    basePath: st.base || undefined,
    locale: req.locale,
    locales: st.opts.i18n?.locales,
    defaultLocale: st.opts.i18n?.defaultLocale,
  };
  const { entryUrl, cssUrl } = await bundleUrls(st, entry.routePath);
  return await renderPage({
    Page,
    pageProps,
    App,
    nextData,
    clientBundle: entryUrl ? withBase(st, entryUrl) : null,
    styles: cssUrl ? [withBase(st, cssUrl)] : undefined,
    lang: st.opts.lang,
    Document,
  });
}

/** The matched-page request record for an HTML or data render. */
export function pageRequest(
  entry: PageEntry,
  params: PageRequest["params"],
  request: Request,
  url: URL,
  pathname: string,
  locale: string | undefined,
): PageRequest {
  return {
    params,
    query: buildQuery(params, url),
    request,
    url,
    pathname,
    routePath: entry.routePath,
    locale,
  };
}
