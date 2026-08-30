// The Pages Router request handler: match a request against the scanned routes and
// serve it. Registered as the plugin's claim-hook, so it runs only after the App
// Router failed to match — returning `null` for anything it doesn't own.
//
// Besides HTML pages and `pages/api/*`, the handler answers two client-hydration
// concerns: it serves the browser bundles under `/_denext/pages/` (via the
// bundler) and responds to soft-navigation **data** requests (marked with the
// `x-denext-pages-data` header) with JSON — the page's props + the URL of its
// code-split entry — instead of HTML.

import { join, resolve, SEPARATOR } from "@std/path";
import {
  type I18nConfig,
  matchSegments,
  type PageCache,
  peelLocale,
  type RouteParams,
} from "@denext/denext/server";
import { type NextData, type PageComponent, renderPage } from "./render.ts";
import type { PageEntry, PagesScan } from "./scan.ts";
import { type ApiModule, runApiRoute } from "./api.ts";
import { type ClientBundler, PAGES_PREFIX } from "./client-bundle.ts";
import { previewCookieFrom, previewSecrets, readPreview } from "./preview.ts";

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

/**
 * Legacy `Component.getInitialProps` / `_app.getInitialProps`. Unlike Next (which
 * runs it on the client during client-side nav), denext resolves it **server-side**
 * for both the initial render and soft-nav data requests — coherent with this
 * router's server-driven data model, so its `context` carries `req` but no `res`.
 */
type GetInitialProps = (
  // deno-lint-ignore no-explicit-any
  context: any,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Read a component's static `getInitialProps`, if it has one. */
function getInitialPropsOf(
  component: PageComponent | null | undefined,
): GetInitialProps | undefined {
  return (component as { getInitialProps?: GetInitialProps } | null | undefined)
    ?.getInitialProps;
}

/** The header a soft navigation sends to request a route's data (not its HTML). */
const DATA_HEADER = "x-denext-pages-data";
/**
 * The header a `<Link prefetch>` / `router.prefetch()` sends to warm a route's
 * code chunk. Unlike a data request it deliberately does **not** run
 * `getServerSideProps`/`getStaticProps` (prefetch must be side-effect-free), so it
 * returns only the entry/CSS URLs — matching Next's "prefetch the JS, not the data".
 */
const PREFETCH_HEADER = "x-denext-pages-prefetch";

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
  /** i18n config — enables locale-prefixed routing (`/fr/about`). */
  i18n?: I18nConfig;
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
  | { kind: "notFound" }
  /** A `getStaticPaths` `fallback: true` shell: render props-less, client fetches data. */
  | { kind: "fallback" };

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

  // Merge headers a page's `getServerSideProps` set via `context.res` into an outgoing
  // response (Set-Cookie is appended, not coalesced, so multiple cookies survive).
  const applyResHeaders = (res: Response, collected: Headers): Response => {
    for (const [name, value] of collected) {
      if (name.toLowerCase() !== "set-cookie") res.headers.set(name, value);
    }
    for (const cookie of collected.getSetCookie?.() ?? []) {
      res.headers.append("set-cookie", cookie);
    }
    return res;
  };

  // A minimal Node-`ServerResponse`-shaped shim over a `Headers` collector, so a
  // `getServerSideProps` can `context.res.setHeader("Set-Cookie", …)` / `Cache-Control`.
  const makeRes = (headers: Headers) => ({
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]): void {
      const key = String(name);
      if (Array.isArray(value)) {
        headers.delete(key);
        for (const v of value) headers.append(key, String(v));
      } else {
        headers.set(key, String(value));
      }
    },
    getHeader(name: string): string | undefined {
      return headers.get(String(name)) ?? undefined;
    },
    removeHeader(name: string): void {
      headers.delete(String(name));
    },
    hasHeader(name: string): boolean {
      return headers.has(String(name));
    },
  });

  /** Resolve a page's props (running gSSP/gSP + getStaticPaths gating). */
  async function resolveData(
    mod: PageModule,
    params: RouteParams,
    query: Record<string, string>,
    request: Request,
    url: URL,
    pathname: string,
    appFile: string | null,
    routePath: string,
    locale: string | undefined,
    resHeaders: Headers,
    allowFallbackShell: boolean,
  ): Promise<DataOutcome> {
    // Preview Mode: a valid signed preview cookie makes getStaticProps run LIVE with
    // `context.preview`/`previewData` (and skips the static-paths gating below), so a
    // CMS draft renders. An absent/forged cookie → normal behavior.
    const previewData = await readPreview(
      previewCookieFrom(request.headers.get("cookie")),
      previewSecrets(),
    );
    const preview = previewData !== null;
    // getStaticPaths gating for an unlisted param set (skipped in preview mode):
    //   fallback: false      → 404
    //   fallback: true       → serve a props-less shell on the HTML path (the client
    //                          then fetches real props via the data endpoint, where
    //                          allowFallbackShell is false so getStaticProps runs)
    //   fallback: "blocking" → fall through and render live (getStaticProps runs now)
    if (
      !preview && mod.getStaticProps && typeof mod.getStaticPaths === "function"
    ) {
      const gsp = await (mod.getStaticPaths as () => Promise<StaticPathsResult>)();
      if (gsp && !paramsListed(params, gsp.paths)) {
        if (gsp.fallback === false) return { kind: "notFound" };
        if (gsp.fallback === true && allowFallbackShell) {
          return { kind: "fallback" };
        }
      }
    }
    const fetcher = mod.getServerSideProps ?? mod.getStaticProps;
    // No gSSP/gSP → fall back to legacy getInitialProps (page and/or _app).
    if (!fetcher) {
      return await resolveInitialProps(
        mod.default,
        appFile,
        params,
        query,
        request,
        url,
        pathname,
        routePath,
        locale,
      );
    }
    const isServer = mod.getServerSideProps != null;
    const result = await fetcher({
      params,
      query,
      req: request,
      // `res` lets gSSP set cookies/headers (Next parity); it collects into `resHeaders`,
      // which the caller merges onto the outgoing response.
      res: makeRes(resHeaders),
      resolvedUrl: pathname + url.search,
      locale,
      locales: opts.i18n?.locales,
      defaultLocale: opts.i18n?.defaultLocale,
      // Preview Mode (Next parity): `preview` + `previewData` when a valid preview
      // cookie is present (both are absent otherwise).
      preview: preview || undefined,
      previewData: preview ? previewData : undefined,
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

  /**
   * Legacy `getInitialProps` fallback. If `_app` defines `getInitialProps`, it owns
   * the flow (`App.getInitialProps({ Component, ctx })` → `{ pageProps }`), matching
   * Next — a custom `_app` is responsible for calling the page's. Otherwise the page's
   * own `getInitialProps(ctx)` runs. Presence of either makes the route dynamic.
   */
  async function resolveInitialProps(
    page: PageComponent | undefined,
    appFile: string | null,
    params: RouteParams,
    query: Record<string, string>,
    request: Request,
    url: URL,
    pathname: string,
    routePath: string,
    locale: string | undefined,
  ): Promise<DataOutcome> {
    const pageGip = getInitialPropsOf(page);
    const appGip = getInitialPropsOf(await loadDefault(appFile));
    if (!appGip && !pageGip) {
      return { kind: "props", pageProps: {}, isServer: false };
    }
    // `pathname` is the route pattern (Next parity); `asPath` is the real URL.
    const ctx = {
      pathname: routePath,
      query,
      asPath: pathname + url.search,
      req: request,
      params,
      locale,
    };
    let pageProps: Record<string, unknown>;
    if (appGip) {
      const appProps = await appGip({ Component: page, ctx });
      pageProps = (appProps?.pageProps as Record<string, unknown> | undefined) ?? {};
    } else {
      pageProps = (await pageGip!(ctx)) ?? {};
    }
    return { kind: "props", pageProps, isServer: true };
  }

  /** Load a module's default export (a component), or null. */
  async function loadDefault(
    filePath: string | null,
  ): Promise<PageComponent | null> {
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
    appFile: string | null,
    locale: string | undefined,
  ): Promise<Response> {
    const mod = await opts.load(entry.filePath) as PageModule;
    const query = buildQuery(params, url);
    const resHeaders = new Headers();
    // Data path: never a fallback shell — the client's follow-up fetch wants the real
    // getStaticProps output, so allowFallbackShell is false.
    const outcome = await resolveData(
      mod,
      params,
      query,
      request,
      url,
      pathname,
      appFile,
      entry.routePath,
      locale,
      resHeaders,
      false,
    );
    if (outcome.kind === "redirect") {
      return Response.json({ redirect: { destination: outcome.destination } });
    }
    if (outcome.kind !== "props") return Response.json({ notFound: true }); // "fallback" can't occur here (allowFallbackShell=false)
    const entryUrl = opts.bundler ? await opts.bundler.urlFor(entry.routePath) : null;
    const cssUrl = opts.bundler ? await opts.bundler.cssUrlFor(entry.routePath) : null;
    return applyResHeaders(
      Response.json({
        page: entry.routePath,
        entryUrl, // app-absolute, without basePath — the client re-adds it
        cssUrl, // ditto; the client injects the route's stylesheet before rendering
        pageProps: outcome.pageProps,
        query,
        asPath: pathname + url.search,
        isServer: outcome.isServer,
        locale,
        locales: opts.i18n?.locales,
        defaultLocale: opts.i18n?.defaultLocale,
      }),
      resHeaders,
    );
  }

  /**
   * Answer a prefetch request: the route's code-chunk + CSS URLs only. No page
   * module is loaded and no data fetcher runs, so prefetch is side-effect-free.
   */
  async function renderPrefetch(entry: PageEntry): Promise<Response> {
    const entryUrl = opts.bundler ? await opts.bundler.urlFor(entry.routePath) : null;
    const cssUrl = opts.bundler ? await opts.bundler.cssUrlFor(entry.routePath) : null;
    return Response.json({
      page: entry.routePath,
      entryUrl,
      cssUrl,
      prefetch: true,
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
    // Defense-in-depth: never let a pathname escape the static dir, even if a future
    // refactor decodes `pathname` earlier (WHATWG URL already normalizes `..`).
    if (pathname.includes("..") || pathname.includes("\0")) return null;
    const dir = join(opts.staticDir, pathname === "/" ? "" : pathname);
    const rootDir = resolve(opts.staticDir);
    const resolvedDir = resolve(dir);
    if (
      resolvedDir !== rootDir && !resolvedDir.startsWith(rootDir + SEPARATOR)
    ) return null;

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
    const cache = opts.pageCache;
    if (!revalidate || !cache) return html(body);

    // ISR (stale-while-revalidate). The prerendered file is always servable, so a
    // cache backend error must never turn it into a 500 — fall back to the file.
    const key = `pr:${pathname}`;
    const now = Date.now();
    let cached;
    try {
      cached = await cache.get(key);
    } catch (err) {
      console.error(
        "@denext/pages-router: ISR cache read failed for",
        pathname,
        err,
      );
      return html(body);
    }
    if (cached) {
      if (now < (cached.staleAt ?? Infinity)) return html(cached.body);
      if (!regenerating.has(key)) {
        regenerating.add(key);
        const stale = cached;
        (async () => {
          const nextStale = Date.now() + revalidate * 1000;
          try {
            // ISR regen is reached only for the default locale (non-default renders live).
            const res = await renderMatched(
              scan,
              entry,
              params,
              request,
              url,
              pathname,
              opts.i18n?.defaultLocale,
            );
            // Only cache a real page as 200. A redirect/404/500 regen (e.g. the data
            // source started returning notFound) must NOT poison the cache as a 200
            // blank/error body — keep serving stale and back off.
            const fresh = res.status === 200
              ? { body: await res.text(), staleAt: nextStale }
              : { body: stale.body, staleAt: nextStale };
            await cache.set(key, {
              ...stale,
              body: fresh.body,
              status: 200,
              staleAt: fresh.staleAt,
            });
          } catch (err) {
            console.error(
              "@denext/pages-router: ISR regen failed for",
              pathname,
              err,
            );
            // Back off so a sustained failure doesn't re-fire on every request.
            try {
              await cache.set(key, { ...stale, staleAt: nextStale });
            } catch { /* cache down — nothing to do */ }
          } finally {
            regenerating.delete(key);
          }
        })();
      }
      return html(cached.body);
    }
    // First serve: seed the cache from the prerendered file (best-effort).
    try {
      await cache.set(key, {
        body,
        status: 200,
        path: pathname,
        expiresAt: Infinity,
        staleAt: now + revalidate * 1000,
        tags: [],
      });
    } catch (err) {
      console.error(
        "@denext/pages-router: ISR cache seed failed for",
        pathname,
        err,
      );
    }
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
    locale: string | undefined,
  ): Promise<Response> {
    const mod = await opts.load(entry.filePath) as PageModule;
    const Page = mod.default;
    if (typeof Page !== "function") {
      return await renderError(scan, 500, pathname, url);
    }

    const query = buildQuery(params, url);
    const resHeaders = new Headers();
    // HTML path: allow a `fallback: true` shell (allowFallbackShell = true).
    const outcome = await resolveData(
      mod,
      params,
      query,
      request,
      url,
      pathname,
      scan.app,
      entry.routePath,
      locale,
      resHeaders,
      true,
    );
    if (outcome.kind === "redirect") {
      return applyResHeaders(
        new Response(null, {
          status: outcome.permanent ? 308 : 307,
          headers: { location: outcome.destination },
        }),
        resHeaders,
      );
    }
    if (outcome.kind === "notFound") {
      return await renderError(scan, 404, pathname, url);
    }

    const App = await loadDefault(scan.app);
    const Document = await loadDefault(scan.document);

    // A `fallback: true` shell renders props-less with `isFallback: true`; the client
    // fetches the real getStaticProps data (the data endpoint) and re-renders.
    const isFallback = outcome.kind === "fallback";
    const pageProps = isFallback ? {} : outcome.pageProps;
    const nextData: NextData = {
      props: { pageProps },
      page: entry.routePath,
      query,
      asPath: pathname + url.search,
      isServer: isFallback ? false : outcome.isServer,
      isFallback: isFallback || undefined,
      basePath: base || undefined,
      locale,
      locales: opts.i18n?.locales,
      defaultLocale: opts.i18n?.defaultLocale,
    };

    const rawBundle = opts.bundler ? await opts.bundler.urlFor(entry.routePath) : null;
    const rawCss = opts.bundler ? await opts.bundler.cssUrlFor(entry.routePath) : null;
    const body = await renderPage({
      Page,
      pageProps,
      App,
      nextData,
      clientBundle: rawBundle ? withBase(rawBundle) : null,
      styles: rawCss ? [withBase(rawCss)] : undefined,
      lang: opts.lang,
      Document,
    });
    return applyResHeaders(html(body), resHeaders);
  }

  return async function handle(request: Request): Promise<Response | null> {
    try {
      const url = new URL(request.url);
      let pathname = url.pathname;
      if (base) {
        if (pathname === base) pathname = "/";
        else if (pathname.startsWith(base + "/")) {
          pathname = pathname.slice(base.length);
        } else return null;
      }

      // Client hydration bundles (served in dev + prod-from-source). A bundling
      // failure (e.g. a page with a syntax error) must not crash the request.
      if (opts.bundler && pathname.startsWith(PAGES_PREFIX)) {
        try {
          const served = await opts.bundler.serve(pathname);
          if (served) return served;
        } catch (err) {
          console.error(
            "@denext/pages-router: bundle serve failed for",
            pathname,
            err,
          );
          return new Response("/* bundle error */", {
            status: 500,
            headers: { "content-type": "text/javascript; charset=utf-8" },
          });
        }
      }

      const scan = await opts.getScan();

      // API routes match any method (POST/PUT/…), before pages.
      for (const entry of scan.api) {
        const params = matchSegments(entry.pattern, pathname);
        if (params) {
          let mod: ApiModule;
          try {
            mod = await opts.load(entry.filePath) as ApiModule;
          } catch (err) {
            console.error(
              "@denext/pages-router: failed to load API route",
              entry.filePath,
              err,
            );
            return new Response("Internal Server Error", { status: 500 });
          }
          return await runApiRoute(mod, request, params, url);
        }
      }

      // Page routes render for GET/HEAD only.
      if (request.method !== "GET" && request.method !== "HEAD") return null;
      const wantsData = request.headers.get(DATA_HEADER) === "1";
      const wantsPrefetch = request.headers.get(PREFETCH_HEADER) === "1";
      // i18n: peel an optional locale prefix; match against the stripped path and
      // carry the active locale into data fetching, `__NEXT_DATA__`, and the router.
      const peeled = opts.i18n ? peelLocale(pathname, opts.i18n) : null;
      const routingPath = peeled ? peeled.rest : pathname;
      const locale = peeled?.locale;
      for (const entry of scan.pages) {
        const params = matchSegments(entry.pattern, routingPath);
        if (params) {
          // Prefetch: return the route's chunk URL only — never HTML, data, or gSSP.
          if (wantsPrefetch) return await renderPrefetch(entry);
          // Build-time prerendered (SSG) page? Serve it (with ISR) before rendering.
          // A non-default locale renders live so getStaticProps runs with the locale
          // (per-locale SSG output isn't prewritten), keeping localized content correct.
          // Preview Mode also bypasses the static cache so drafts render live (a forged
          // cookie only forces a live render — resolveData verifies the signature).
          const nonDefaultLocale = !!opts.i18n &&
            locale !== opts.i18n.defaultLocale;
          const hasPreviewCookie = previewCookieFrom(request.headers.get("cookie")) !== undefined;
          const pre = (nonDefaultLocale || hasPreviewCookie) ? null : await servePrerendered(
            scan,
            entry,
            params,
            request,
            url,
            routingPath,
            wantsData,
          );
          if (pre) {
            return request.method === "HEAD" ? new Response(null, pre) : pre;
          }
          if (wantsData) {
            // Keep the JSON contract even on failure so the client can fall back.
            try {
              return await renderData(
                entry,
                params,
                request,
                url,
                pathname,
                scan.app,
                locale,
              );
            } catch (err) {
              console.error(
                "@denext/pages-router: data error for",
                pathname,
                err,
              );
              return Response.json({ error: "Internal Server Error" }, {
                status: 500,
              });
            }
          }
          try {
            const res = await renderMatched(
              scan,
              entry,
              params,
              request,
              url,
              pathname,
              locale,
            );
            if (request.method === "HEAD") return new Response(null, res);
            return res;
          } catch (err) {
            console.error(
              "@denext/pages-router: render error for",
              pathname,
              err,
            );
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
    } catch (err) {
      // Last-resort backstop: the plugin must never throw out to core with an
      // unhandled error. For requests it clearly doesn't own (assets with an
      // extension, framework paths) return null so core can still static-serve them
      // even while the plugin is broken; only 500 a page-like request.
      console.error("@denext/pages-router: unhandled handler error", err);
      const p = new URL(request.url).pathname;
      if (/\.[^/]+$/.test(p) || p.startsWith("/_denext")) return null;
      return new Response("Internal Server Error", { status: 500 });
    }
  };
}
