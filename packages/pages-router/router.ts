/**
 * `next/router` for the Pages Router — {@linkcode useRouter} and a
 * {@linkcode RouterProvider}. During SSR the router reflects the matched route
 * (from `__NEXT_DATA__`); on the client it reflects `window.location`. Navigation
 * (`push`/`replace`) performs a full document load in v0.1; soft client-side
 * navigation is planned.
 *
 * @module
 */

import { createContext, h, useContext } from "@denext/denext";
import type { Context } from "@denext/denext";
import type { VNodeChildren } from "@denext/denext/server";

/** The Pages Router `router` object (a subset of Next's `NextRouter`). */
export interface NextRouter {
  /** The route pattern, e.g. `/blog/[slug]`. */
  route: string;
  /** The current path pattern (same as {@linkcode route} here). */
  pathname: string;
  /** Route params merged with query-string params. */
  query: Record<string, string | string[]>;
  /** The actual path shown in the browser, incl. search. */
  asPath: string;
  /** Configured `basePath`, or `""`. */
  basePath: string;
  /** True once the route is ready (always true here — no client param hydration gap). */
  isReady: boolean;
  /** Navigate to `url` (full load in v0.1). */
  push(url: string): Promise<boolean>;
  /** Replace the current entry with `url` (full load in v0.1). */
  replace(url: string): Promise<boolean>;
  /** Reload the page. */
  reload(): void;
  /** Go back. */
  back(): void;
  /** Go forward. */
  forward(): void;
  /** Prefetch (a no-op in v0.1). */
  prefetch(url: string): Promise<void>;
}

/** The shape stored in the router context (server-provided or client-derived). */
export const RouterContext: Context<NextRouter | null> = createContext<NextRouter | null>(null);

/** Build a browser-side navigation method (full document load). */
function nav(kind: "assign" | "replace"): (url: string) => Promise<boolean> {
  return (url: string) => {
    if (typeof globalThis !== "undefined" && "location" in globalThis) {
      const loc = (globalThis as { location: Location }).location;
      if (kind === "assign") loc.assign(url);
      else loc.replace(url);
    }
    return Promise.resolve(true);
  };
}

/** A router derived from the current `window.location` (client fallback). */
function locationRouter(): NextRouter {
  const loc = (globalThis as { location?: Location }).location;
  const url = loc ? new URL(loc.href) : new URL("http://localhost/");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  return {
    route: url.pathname,
    pathname: url.pathname,
    query,
    asPath: url.pathname + url.search,
    basePath: "",
    isReady: true,
    push: nav("assign"),
    replace: nav("replace"),
    reload: () => (globalThis as { location?: Location }).location?.reload(),
    back: () => (globalThis as { history?: History }).history?.back(),
    forward: () => (globalThis as { history?: History }).history?.forward(),
    prefetch: () => Promise.resolve(),
  };
}

/** Data needed to build the SSR router (from `__NEXT_DATA__`). */
export interface ServerRouterInit {
  route: string;
  query: Record<string, string | string[]>;
  asPath: string;
  basePath?: string;
}

/** Build the router object used during SSR (navigation is a no-op on the server). */
export function createServerRouter(init: ServerRouterInit): NextRouter {
  return {
    route: init.route,
    pathname: init.route,
    query: init.query,
    asPath: init.asPath,
    basePath: init.basePath ?? "",
    isReady: true,
    push: () => Promise.resolve(true),
    replace: () => Promise.resolve(true),
    reload: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => Promise.resolve(),
  };
}

/**
 * Access the Pages Router {@linkcode NextRouter}. Reads the nearest
 * {@linkcode RouterProvider} (set during SSR/hydration); falls back to a
 * `window.location`-derived router on the client.
 */
export function useRouter(): NextRouter {
  const ctx = useContext(RouterContext);
  return ctx ?? locationRouter();
}

/** Props for {@linkcode RouterProvider}. */
export interface RouterProviderProps {
  router: NextRouter;
  children?: VNodeChildren;
}

/** Provide a {@linkcode NextRouter} to the tree (wraps the app during render). */
export function RouterProvider(props: RouterProviderProps): ReturnType<typeof h> {
  return h(RouterContext.Provider, { value: props.router }, props.children);
}
