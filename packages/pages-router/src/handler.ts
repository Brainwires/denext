// The Pages Router request handler: match a request against the scanned routes and
// serve it. Registered as the plugin's claim-hook, so it runs only after the App
// Router failed to match — returning `null` for anything it doesn't own.
//
// Besides HTML pages and `pages/api/*`, the handler answers two client-hydration
// concerns: it serves the browser bundles under `/_denext/pages/` (via the
// bundler) and responds to soft-navigation **data** requests (marked with the
// `x-denext-pages-data` header) with JSON — the page's props + the URL of its
// code-split entry — instead of HTML.

import { join } from "@std/path";
import { matchSegments, type PageCache, type RouteParams } from "@denext/denext/server";
import { type NextData, type PageComponent, renderPage } from "./render.ts";
import type { PageEntry, PagesScan } from "./scan.ts";
import { type ApiModule, runApiRoute } from "./api.ts";
import { type ClientBundler, PAGES_PREFIX } from "./client-bundle.ts";

/** A loaded page module's relevant exports. */
interface PageModule {
  default?: PageComponent;
  getServerSideProps?: DataFetch;
  getStaticProps?: DataFetch;
  getStaticPaths?: unknown;
}

/** A page's `_app` module. */
interface AppModule {
  default?: PageComponent;
}

/** getServerSideProps / getStaticProps signature (narrowed to what we consume). */
// deno-lint-ignore no-explicit-any
type DataFetch = (context: any) => Promise<DataResult> | DataResult;
interface DataResult {
  props?: Record<string, unknown>;
  redirect?: { destination: string; permanent?: boolean };
  notFound?: boolean;
}

/** The header a soft navigation sends to request a route's data (not its HTML). */
const DATA_HEADER = "x-denext-pages-data";

/** Options for {@linkcode createPagesHandler}. */
export interface HandlerOptions {
  /** Resolve the scanned pages tree (re-scanned each call in dev; cached in prod). */
  getScan: () => PagesScan | Promise<PagesScan>;
  /** Import a module by absolute file path. */
  load: (filePath: string) => Promise<unknown>;
  /** The client bundler: serves hydration bundles + CSS, provides their URLs. */
  bundler?: ClientBundler;
  /** Document language. */
  lang?: string;
  /** Sub-path the app is served under (stripped before matching, added to assets). */
  basePath?: string;
  /** Prod: dir holding build-time prerendered SSG pages (`pages-static/`). */
  staticDir?: string;
  /** Prod: cache backing `revalidate` (ISR) for prerendered pages. */
  pageCache?: PageCache;
}

/** The result of `getStaticPaths`. */
interface StaticPathsResult {
  paths: Array<string | { params: Record<string, string> }>;
  fallback: boolean | "blocking";
}

/** Outcome of resolving a page's data (shared by the HTML and JSON paths). */
type DataOutcome =
  | { kind: "props"; pageProps: Record<string, unknown>; isServer: boolean }
  | { kind: "redirect"; destination: string; permanent: boolean }
  | { kind: "notFound" };

/** True when `params` matches one of `getStaticPaths`' pre-listed param sets. */
function paramsListed(
  params: RouteParams,
  paths: StaticPathsResult["paths"],
): boolean {
  const keys = Object.keys(params);
  return paths.some((p) => {
    const listed = typeof p === "string" ? null : p.params;
    if (!listed) return false;
    return keys.every((k) => String(listed[k]) === String(params[k]));
  });
}

/** Build the merged `query` (route params + URL search params). */
function buildQuery(params: RouteParams, url: URL): Record<string, string> {
  const query: Record<string, string> = { ...params };
  for (const [k, v] of url.searchParams) query[k] = v;
  return query;
}

/**
 * Create the Pages Router request handler. Returns a function suitable for a
 * plugin's `addRequestHandler`: it resolves a page route to an HTML {@link Response},
 * serves client bundles + soft-nav data, or `null` when nothing matches.
 */
export function createPagesHandler(
  opts: HandlerOptions,
): (request: Request) => Promise<Response | null> {
  const base = opts.basePath?.replace(/\/$/, "") || "";
  const withBase = (path: string): string => (base ? base + path : path);

  const html = (body: string, status = 200): Response =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  /** Resolve a page's props (running gSSP/gSP + getStaticPaths gating). */
  async function resolveData(
    mod: PageModule,
    params: RouteParams,
    query: Record<string, string>,
    request: Request,
    url: URL,
    pathname: string,
  ): Promise<DataOutcome> {
    // getStaticPaths: a `fallback: false` page 404s for an unlisted param set.
    if (mod.getStaticProps && typeof mod.getStaticPaths === "function") {
      const gsp = await (mod.getStaticPaths as () => Promise<StaticPathsResult>)();
      if (gsp && gsp.fallback === false && !paramsListed(params, gsp.paths)) {
        return { kind: "notFound" };
      }
    }
    const fetcher = mod.getServerSideProps ?? mod.getStaticProps;
    if (!fetcher) return { kind: "props", pageProps: {}, isServer: false };
    const isServer = mod.getServerSideProps != null;
    const result = await fetcher({
      params,
      query,
      req: request,
      resolvedUrl: pathname + url.search,
      locale: undefined,
    });
    if (result.redirect) {
      return {
        kind: "redirect",
        destination: result.redirect.destination,
        permanent: !!result.redirect.permanent,
      };
    }
    if (result.notFound) return { kind: "notFound" };
    return { kind: "props", pageProps: result.props ?? {}, isServer };
  }

  /** Load a module's default export (a component), or null. */
  async function loadDefault(filePath: string | null): Promise<PageComponent | null> {
    if (!filePath) return null;
    return (await opts.load(filePath) as AppModule).default ?? null;
  }

  /**
   * Render an error page — the custom `404`/`500`/`_error` component wrapped in
   * `_app`/`_document` — or a bare fallback document when the app has none. Error
   * pages render SSR-only (no per-route client bundle). `_error` receives
   * `{ statusCode }`; `404`/`500` receive no props (Next parity).
   */
  async function renderError(
    scan: PagesScan,
    status: number,
    pathname: string,
    url: URL,
  ): Promise<Response> {
    // Prefer the specific page (404.tsx/500.tsx); _error is the catch-all.
    const file = status === 404 ? (scan.notFound ?? scan.error) : (scan.serverError ?? scan.error);
    const Component = await loadDefault(file);
    if (!Component) {
      const title = status === 404 ? "404" : "500";
      const msg = status === 404 ? "Not Found" : "Internal Server Error";
      return html(`<!DOCTYPE html><title>${title}</title>${msg}`, status);
    }
    const App = await loadDefault(scan.app);
    const Document = await loadDefault(scan.document);
    const pageProps = file === scan.error ? { statusCode: status } : {};
    const nextData: NextData = {
      props: { pageProps },
      page: status === 404 ? "/404" : "/500",
      query: {},
      asPath: pathname + url.search,
      basePath: base || undefined,
    };
    const body = await renderPage({
      Page: Component,
      pageProps,
      App,
      nextData,
      clientBundle: null,
      styles: undefined,
      lang: opts.lang,
      Document,
    });
    return html(body, status);
  }

  /** Respond to a soft-navigation data request with JSON (props + entry URL). */
  async function renderData(
    entry: PageEntry,
    params: RouteParams,
    request: Request,
    url: URL,
    pathname: string,
  ): Promise<Response> {
    const mod = await opts.load(entry.filePath) as PageModule;
    const query = buildQuery(params, url);
    const outcome = await resolveData(mod, params, query, request, url, pathname);
    if (outcome.kind === "redirect") {
      return Response.json({ redirect: { destination: outcome.destination } });
    }
    if (outcome.kind === "notFound") return Response.json({ notFound: true });
    const entryUrl = opts.bundler ? await opts.bundler.urlFor(entry.routePath) : null;
    return Response.json({
      page: entry.routePath,
      entryUrl, // app-absolute, without basePath — the client re-adds it
      pageProps: outcome.pageProps,
      query,
      asPath: pathname + url.search,
      isServer: outcome.isServer,
    });
  }

  // Keys currently being regenerated in the background (ISR stampede guard).
  const regenerating = new Set<string>();

  /**
   * Serve a build-time prerendered SSG page from disk, or null if the path wasn't
   * prerendered (→ render on demand). `revalidate` pages go through the PageCache
   * for stale-while-revalidate ISR, seeded from the prerendered file.
   */
  async function servePrerendered(
    scan: PagesScan,
    entry: PageEntry,
    params: RouteParams,
    request: Request,
    url: URL,
    pathname: string,
    wantsData: boolean,
  ): Promise<Response | null> {
    if (!opts.staticDir) return null;
    const dir = join(opts.staticDir, pathname === "/" ? "" : pathname);
    let meta: { revalidate?: number } & Record<string, unknown>;
    try {
      meta = JSON.parse(await Deno.readTextFile(join(dir, "props.json")));
    } catch {
      return null; // not prerendered
    }
    if (wantsData) {
      const { revalidate: _drop, ...data } = meta;
      return Response.json(data);
    }
    let body: string;
    try {
      body = await Deno.readTextFile(join(dir, "index.html"));
    } catch {
      return null;
    }
    const revalidate = typeof meta.revalidate === "number" ? meta.revalidate : undefined;
    if (!revalidate || !opts.pageCache) return html(body);

    // ISR (stale-while-revalidate): serve fresh from cache; when stale, serve stale
    // and regenerate in the background exactly once.
    const key = `pr:${pathname}`;
    const now = Date.now();
    const cached = await opts.pageCache.get(key);
    if (cached) {
      if (now < (cached.staleAt ?? Infinity)) return html(cached.body);
      if (!regenerating.has(key)) {
        regenerating.add(key);
        (async () => {
          try {
            const fresh = await (await renderMatched(scan, entry, params, request, url, pathname))
              .text();
            await opts.pageCache!.set(key, {
              body: fresh,
              status: 200,
              path: pathname,
              expiresAt: Infinity,
              staleAt: Date.now() + revalidate * 1000,
              tags: [],
            });
          } catch (err) {
            console.error("@denext/pages-router: ISR regen failed for", pathname, err);
          } finally {
            regenerating.delete(key);
          }
        })();
      }
      return html(cached.body);
    }
    // First serve: seed the cache from the prerendered build output.
    await opts.pageCache.set(key, {
      body,
      status: 200,
      path: pathname,
      expiresAt: Infinity,
      staleAt: now + revalidate * 1000,
      tags: [],
    });
    return html(body);
  }

  /** Render a matched page to a full HTML document. */
  async function renderMatched(
    scan: PagesScan,
    entry: PageEntry,
    params: RouteParams,
    request: Request,
    url: URL,
    pathname: string,
  ): Promise<Response> {
    const mod = await opts.load(entry.filePath) as PageModule;
    const Page = mod.default;
    if (typeof Page !== "function") return await renderError(scan, 500, pathname, url);

    const query = buildQuery(params, url);
    const outcome = await resolveData(mod, params, query, request, url, pathname);
    if (outcome.kind === "redirect") {
      return new Response(null, {
        status: outcome.permanent ? 308 : 307,
        headers: { location: outcome.destination },
      });
    }
    if (outcome.kind === "notFound") return await renderError(scan, 404, pathname, url);

    const App = await loadDefault(scan.app);
    const Document = await loadDefault(scan.document);

    const nextData: NextData = {
      props: { pageProps: outcome.pageProps },
      page: entry.routePath,
      query,
      asPath: pathname + url.search,
      isServer: outcome.isServer,
      basePath: base || undefined,
    };

    const rawBundle = opts.bundler ? await opts.bundler.urlFor(entry.routePath) : null;
    const rawCss = opts.bundler ? await opts.bundler.cssUrlFor(entry.routePath) : null;
    const body = await renderPage({
      Page,
      pageProps: outcome.pageProps,
      App,
      nextData,
      clientBundle: rawBundle ? withBase(rawBundle) : null,
      styles: rawCss ? [withBase(rawCss)] : undefined,
      lang: opts.lang,
      Document,
    });
    return html(body);
  }

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (base) {
      if (pathname === base) pathname = "/";
      else if (pathname.startsWith(base + "/")) pathname = pathname.slice(base.length);
      else return null;
    }

    // Client hydration bundles (served in dev + prod-from-source).
    if (opts.bundler && pathname.startsWith(PAGES_PREFIX)) {
      const served = await opts.bundler.serve(pathname);
      if (served) return served;
    }

    const scan = await opts.getScan();

    // API routes match any method (POST/PUT/…), before pages.
    for (const entry of scan.api) {
      const params = matchSegments(entry.pattern, pathname);
      if (params) {
        const mod = await opts.load(entry.filePath) as ApiModule;
        return await runApiRoute(mod, request, params, url);
      }
    }

    // Page routes render for GET/HEAD only.
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const wantsData = request.headers.get(DATA_HEADER) === "1";
    for (const entry of scan.pages) {
      const params = matchSegments(entry.pattern, pathname);
      if (params) {
        // Build-time prerendered (SSG) page? Serve it (with ISR) before rendering.
        const pre = await servePrerendered(scan, entry, params, request, url, pathname, wantsData);
        if (pre) return request.method === "HEAD" ? new Response(null, pre) : pre;
        if (wantsData) return await renderData(entry, params, request, url, pathname);
        try {
          const res = await renderMatched(scan, entry, params, request, url, pathname);
          if (request.method === "HEAD") return new Response(null, res);
          return res;
        } catch (err) {
          console.error("@denext/pages-router: render error for", pathname, err);
          const res = await renderError(scan, 500, pathname, url);
          if (request.method === "HEAD") return new Response(null, res);
          return res;
        }
      }
    }

    // No page matched. Render the custom 404 (`404.tsx`/`_error`) for page-like
    // paths only — never for asset requests (they have an extension) or framework
    // paths, so `public/` files still fall through to static serving. Without a
    // custom error page, return null so core handles the 404.
    if (
      (scan.notFound || scan.error) && !wantsData &&
      !/\.[^/]+$/.test(pathname) && !pathname.startsWith("/_denext")
    ) {
      const res = await renderError(scan, 404, pathname, url);
      return request.method === "HEAD" ? new Response(null, res) : res;
    }
    return null;
  };
}
