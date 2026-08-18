// The Pages Router request handler: match a request against the scanned routes and
// serve it. Registered as the plugin's claim-hook, so it runs only after the App
// Router failed to match — returning `null` for anything it doesn't own.

import { matchSegments, type RouteParams } from "@denext/denext/server";
import { type NextData, type PageComponent, renderPage } from "./render.ts";
import type { PageEntry, PagesScan } from "./scan.ts";
import { type ApiModule, runApiRoute } from "./api.ts";

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

/** Options for {@link createPagesHandler}. */
export interface HandlerOptions {
  /** Resolve the scanned pages tree (re-scanned each call in dev; cached in prod). */
  getScan: () => PagesScan | Promise<PagesScan>;
  /** Import a module by absolute file path. */
  load: (filePath: string) => Promise<unknown>;
  /** Client entry URL for a route (module script), or nothing for no hydration. */
  clientBundleFor?: (routePath: string) => string | null | undefined;
  /** Stylesheet URLs for a route. */
  stylesFor?: (routePath: string) => string[] | undefined;
  /** Document language. */
  lang?: string;
  /** Sub-path the app is served under (stripped before matching). */
  basePath?: string;
}

/** The result of `getStaticPaths`. */
interface StaticPathsResult {
  paths: Array<string | { params: Record<string, string> }>;
  fallback: boolean | "blocking";
}

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
 * or `null` when nothing matches.
 */
export function createPagesHandler(
  opts: HandlerOptions,
): (request: Request) => Promise<Response | null> {
  const html = (body: string, status = 200): Response =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

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
    if (typeof Page !== "function") {
      return html(`<!DOCTYPE html><title>500</title>Page has no default export`, 500);
    }

    const query = buildQuery(params, url);

    // getStaticPaths: for a getStaticProps page with `fallback: false`, a request
    // for a param set that wasn't pre-listed is a 404 (mirrors Next). Otherwise the
    // page renders on demand (blocking-style).
    if (mod.getStaticProps && typeof mod.getStaticPaths === "function") {
      const gsp = await (mod.getStaticPaths as () => Promise<StaticPathsResult>)();
      if (gsp && gsp.fallback === false && !paramsListed(params, gsp.paths)) {
        return html(`<!DOCTYPE html><title>404</title>Not Found`, 404);
      }
    }

    // Data fetching (getServerSideProps / getStaticProps). A getStaticProps page
    // renders on demand here (no build-time pre-render in v0.1).
    let pageProps: Record<string, unknown> = {};
    let isServer = false;
    const fetcher = mod.getServerSideProps ?? mod.getStaticProps;
    if (fetcher) {
      isServer = mod.getServerSideProps != null;
      const result = await fetcher({
        params,
        query,
        req: request,
        resolvedUrl: pathname + url.search,
        locale: undefined,
      });
      if (result.redirect) {
        return new Response(null, {
          status: result.redirect.permanent ? 308 : 307,
          headers: { location: result.redirect.destination },
        });
      }
      if (result.notFound) return html(`<!DOCTYPE html><title>404</title>Not Found`, 404);
      pageProps = result.props ?? {};
    }

    const App = (scan.app ? (await opts.load(scan.app) as AppModule).default : null) ?? null;
    const Document =
      (scan.document ? (await opts.load(scan.document) as AppModule).default : null) ?? null;

    const nextData: NextData = {
      props: { pageProps },
      page: entry.routePath,
      query,
      asPath: pathname + url.search,
      isServer,
    };

    const body = await renderPage({
      Page,
      pageProps,
      App,
      nextData,
      clientBundle: opts.clientBundleFor?.(entry.routePath),
      styles: opts.stylesFor?.(entry.routePath),
      lang: opts.lang,
      Document,
    });
    return html(body);
  }

  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    let pathname = url.pathname;
    const base = opts.basePath?.replace(/\/$/, "");
    if (base) {
      if (pathname === base) pathname = "/";
      else if (pathname.startsWith(base + "/")) pathname = pathname.slice(base.length);
      else return null;
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
    for (const entry of scan.pages) {
      const params = matchSegments(entry.pattern, pathname);
      if (params) {
        const res = await renderMatched(scan, entry, params, request, url, pathname);
        if (request.method === "HEAD") return new Response(null, res);
        return res;
      }
    }
    return null;
  };
}
