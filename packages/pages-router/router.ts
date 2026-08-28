/**
 * `next/router` for the Pages Router — {@linkcode useRouter} and a
 * {@linkcode RouterProvider}. During SSR the router reflects the matched route
 * (from `__NEXT_DATA__`); after hydration the client runtime supplies a router
 * whose `push`/`replace` perform **soft (SPA) navigation** — fetching the target
 * route's data + code-split chunk and re-rendering in place. Outside a provider
 * (a rare fallback), a `window.location`-derived router does a full load.
 *
 * @module
 */

import { createContext, h, useContext } from "@denext/denext";
import type { Context, VNode } from "@denext/denext";
import type { VNodeChildren } from "@denext/denext/server";

export type { Context, VNode } from "@denext/denext";
export type { VNodeChildren } from "@denext/denext/server";

/** Options for a {@linkcode NextRouter} `push`/`replace` transition. */
export interface TransitionOptions {
  /**
   * Change the URL/query **without** re-running the destination's data fetching
   * (`getServerSideProps`/`getStaticProps`) — the current page + props are kept
   * and re-rendered. Only applies when the pathname is unchanged (a query-only
   * change on the same page); a cross-page `shallow` falls back to a full nav,
   * matching Next.
   */
  shallow?: boolean;
  /** Scroll to the top after navigating (default `true`). */
  scroll?: boolean;
}

/** The route-change events a Pages Router app can subscribe to via `router.events`. */
export type RouterEventName =
  | "routeChangeStart"
  | "routeChangeComplete"
  | "routeChangeError"
  | "beforeHistoryChange"
  | "hashChangeStart"
  | "hashChangeComplete";

/** A `router.events` listener. Args vary by event (see {@linkcode RouterEvents}). */
// deno-lint-ignore no-explicit-any
export type RouterEventHandler = (...args: any[]) => void;

/**
 * The `router.events` emitter — a small `on`/`off`/`emit` surface matching Next's
 * Pages Router. Apps use it for top-loading bars, analytics pageviews, etc.:
 *
 * ```ts
 * router.events.on("routeChangeStart", (url) => NProgress.start());
 * router.events.on("routeChangeComplete", () => NProgress.done());
 * ```
 */
export interface RouterEvents {
  /** Subscribe `handler` to `event`. */
  on(event: RouterEventName, handler: RouterEventHandler): void;
  /** Unsubscribe `handler` from `event`. */
  off(event: RouterEventName, handler: RouterEventHandler): void;
  /** Emit `event` to its subscribers (used by the runtime, rarely by apps). */
  emit(event: RouterEventName, ...args: unknown[]): void;
}

/** Create a fresh {@linkcode RouterEvents} emitter (no DOM — safe on the server). */
export function createRouterEvents(): RouterEvents {
  const handlers = new Map<RouterEventName, Set<RouterEventHandler>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, set = new Set());
      set.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      // Snapshot: a listener may unsubscribe itself (or another) while emitting.
      const set = handlers.get(event);
      if (!set) return;
      for (const handler of [...set]) handler(...args);
    },
  };
}

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
  /**
   * Soft-navigate to `url`, pushing a history entry (full load if not hydrated).
   * `as` overrides the URL shown in the address bar; `options.shallow` updates the
   * query without re-fetching data (see {@linkcode TransitionOptions}).
   */
  push(url: string, as?: string, options?: TransitionOptions): Promise<boolean>;
  /** Soft-navigate to `url`, replacing the current history entry (see {@linkcode push}). */
  replace(url: string, as?: string, options?: TransitionOptions): Promise<boolean>;
  /** Reload the page. */
  reload(): void;
  /** Go back. */
  back(): void;
  /** Go forward. */
  forward(): void;
  /** Prefetch (a no-op — bundles are already code-split and cached on demand). */
  prefetch(url: string): Promise<void>;
  /** Route-change event emitter (`routeChangeStart`/`routeChangeComplete`/…). */
  events: RouterEvents;
  /** The active locale (i18n), when the app configures `i18n`. */
  locale?: string;
  /** All configured locales (i18n). */
  locales?: string[];
  /** The locale served without a URL prefix (i18n). */
  defaultLocale?: string;
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
    events: createRouterEvents(),
  };
}

/** Data needed to build the SSR router (from `__NEXT_DATA__`). */
export interface ServerRouterInit {
  /** The matched route pattern, e.g. `/blog/[slug]`. */
  route: string;
  /** Route params merged with query-string params. */
  query: Record<string, string | string[]>;
  /** The actual path shown in the browser, incl. search. */
  asPath: string;
  /** Configured `basePath`, or `""`. */
  basePath?: string;
  /** The active locale (i18n). */
  locale?: string;
  /** All configured locales (i18n). */
  locales?: string[];
  /** The default (unprefixed) locale (i18n). */
  defaultLocale?: string;
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
    events: createRouterEvents(),
    locale: init.locale,
    locales: init.locales,
    defaultLocale: init.defaultLocale,
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
  /** The router to expose to descendants via {@linkcode useRouter}. */
  router: NextRouter;
  /** The subtree the router is provided to. */
  children?: VNodeChildren;
}

/** Provide a {@linkcode NextRouter} to the tree (wraps the app during render). */
export function RouterProvider(props: RouterProviderProps): VNode {
  return h(RouterContext.Provider, { value: props.router }, props.children);
}
