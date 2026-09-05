// Types and small helpers shared by the Pages Router handler stages.

import type { I18nConfig, PageCache, RouteParams } from "@denext/denext/server";
import type { PageComponent } from "../render.ts";
import type { PagesScan } from "../scan.ts";
import type { ClientBundler } from "../client-bundle.ts";

/** A loaded page module's relevant exports. */
export interface PageModule {
  default?: PageComponent;
  getServerSideProps?: DataFetch;
  getStaticProps?: DataFetch;
  getStaticPaths?: unknown;
}

/** A page's `_app` module. */
export interface AppModule {
  default?: PageComponent;
}

/** getServerSideProps / getStaticProps signature (narrowed to what we consume). */
// deno-lint-ignore no-explicit-any
export type DataFetch = (context: any) => Promise<DataResult> | DataResult;
export interface DataResult {
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
export type GetInitialProps = (
  // deno-lint-ignore no-explicit-any
  context: any,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Read a component's static `getInitialProps`, if it has one. */
export function getInitialPropsOf(
  component: PageComponent | null | undefined,
): GetInitialProps | undefined {
  return (component as { getInitialProps?: GetInitialProps } | null | undefined)
    ?.getInitialProps;
}

/** The header a soft navigation sends to request a route's data (not its HTML). */
export const DATA_HEADER = "x-denext-pages-data";
/**
 * The header a `<Link prefetch>` / `router.prefetch()` sends to warm a route's
 * code chunk. Unlike a data request it deliberately does **not** run
 * `getServerSideProps`/`getStaticProps` (prefetch must be side-effect-free), so it
 * returns only the entry/CSS URLs — matching Next's "prefetch the JS, not the data".
 */
export const PREFETCH_HEADER = "x-denext-pages-prefetch";

/** Options for `createPagesHandler`. */
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
export interface StaticPathsResult {
  paths: Array<string | { params: Record<string, string> }>;
  fallback: boolean | "blocking";
}

/** Outcome of resolving a page's data (shared by the HTML and JSON paths). */
export type DataOutcome =
  | { kind: "props"; pageProps: Record<string, unknown>; isServer: boolean }
  | { kind: "redirect"; destination: string; permanent: boolean; statusCode?: number }
  | { kind: "notFound" }
  /** A `getStaticPaths` `fallback: true` shell: render props-less, client fetches data. */
  | { kind: "fallback" };

/** True when `params` matches one of `getStaticPaths`' pre-listed param sets. */
export function paramsListed(
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
export function buildQuery(params: RouteParams, url: URL): Record<string, string> {
  // Pages Router `query` values are strings (a catch-all is the joined path form).
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) query[k] = Array.isArray(v) ? v.join("/") : v;
  for (const [k, v] of url.searchParams) query[k] = v;
  return query;
}

/** Everything the handler stages share for one `createPagesHandler` instance. */
export interface HandlerState {
  readonly opts: HandlerOptions;
  /** The configured base path without its trailing slash ("" when none). */
  readonly base: string;
  /** Keys currently being regenerated in the background (ISR stampede guard). */
  readonly regenerating: Set<string>;
}

/** Create the shared state for one handler. */
export function createHandlerState(opts: HandlerOptions): HandlerState {
  return { opts, base: opts.basePath?.replace(/\/$/, "") || "", regenerating: new Set() };
}

/** One matched page request: what every render stage needs to know about it. */
export interface PageRequest {
  params: RouteParams;
  query: Record<string, string>;
  request: Request;
  url: URL;
  /** The request pathname (base path stripped; the routing path for a data request). */
  pathname: string;
  /** The matched route pattern (`/blog/[slug]`). */
  routePath: string;
  locale: string | undefined;
}

/** Prefix an app-absolute path with the base path (if any). */
export function withBase(st: HandlerState, path: string): string {
  return st.base ? st.base + path : path;
}

/** An HTML response. */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Merge headers a page's `getServerSideProps` set via `context.res` into an outgoing
 * response (Set-Cookie is appended, not coalesced, so multiple cookies survive).
 */
export function applyResHeaders(res: Response, collected: Headers): Response {
  for (const [name, value] of collected) {
    if (name.toLowerCase() !== "set-cookie") res.headers.set(name, value);
  }
  for (const cookie of collected.getSetCookie?.() ?? []) {
    res.headers.append("set-cookie", cookie);
  }
  return res;
}

/**
 * A minimal Node-`ServerResponse`-shaped shim over a `Headers` collector, so a
 * `getServerSideProps` can `context.res.setHeader("Set-Cookie", …)` / `Cache-Control`.
 */
export function makeRes(headers: Headers) {
  return {
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
  };
}

/** The route's client entry + stylesheet URLs (app-absolute, without basePath), or nulls. */
export async function bundleUrls(
  st: HandlerState,
  routePath: string,
): Promise<{ entryUrl: string | null; cssUrl: string | null }> {
  const b = st.opts.bundler;
  if (!b) return { entryUrl: null, cssUrl: null };
  return { entryUrl: await b.urlFor(routePath), cssUrl: await b.cssUrlFor(routePath) };
}

/** A HEAD request gets the same status/headers with no body. */
export function forMethod(request: Request, res: Response): Response {
  return request.method === "HEAD" ? new Response(null, res) : res;
}
