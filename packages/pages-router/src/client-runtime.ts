/**
 * `@denext/pages-router/client-runtime` — the browser-side runtime that every
 * generated route entry hands off to. It hydrates the server-rendered page and
 * then runs **soft (SPA) navigation**: intercepting same-origin link clicks and
 * `history` events, fetching the next route's data + code-split chunk, and
 * re-rendering in place — no full document reload.
 *
 * This module runs **only in the browser** (it touches `document`/`window`); it
 * is bundled into the client entry, never imported during SSR.
 *
 * @module
 */

import { h, hydrateRoot } from "@denext/denext/client";
import type { Component, VNode } from "@denext/denext/client";
import type { Root } from "@denext/denext/client";
import { createRouterEvents, type NextRouter, RouterProvider } from "../router.ts";

export type { Component } from "@denext/denext/client";

/** A page component (its props are route-specific). */
export type PageComponent = Component;

/** The `__NEXT_DATA__` payload the server embeds (mirrors `render.ts`'s `NextData`). */
interface NextData {
  props: { pageProps: Record<string, unknown> };
  page: string;
  query: Record<string, string | string[]>;
  asPath: string;
  isServer?: boolean;
  basePath?: string;
}

/** The JSON the data endpoint returns for a soft navigation. */
interface DataResponse {
  page: string;
  entryUrl?: string | null;
  cssUrl?: string | null;
  pageProps: Record<string, unknown>;
  query: Record<string, string | string[]>;
  asPath: string;
  notFound?: boolean;
  redirect?: { destination: string };
}

/** The header that asks the server for a route's data (not its HTML). */
const DATA_HEADER = "x-denext-pages-data";
/** The header that asks the server for a route's code-chunk URL only (no data). */
const PREFETCH_HEADER = "x-denext-pages-prefetch";

// --- module state (one instance per page bundle; runtime is a shared chunk) ---

/** routePath → its default-exported component (each entry self-registers). */
const registry = new Map<string, PageComponent>();
/** The `_app` wrapper, captured from the first entry (identical across entries). */
let appComponent: PageComponent | null = null;
/** The hydrated root; `render()` reconciles it in place for every soft nav. */
let root: Root | null = null;
/** The `basePath` the app is served under (stripped/added around soft-nav URLs). */
let basePath = "";
/** True once {@linkcode bootstrapPages} has hydrated — makes it idempotent. */
let booted = false;
/** Monotonic navigation id — a slower fetch from a superseded nav is discarded. */
let navSeq = 0;
/**
 * The one `router.events` emitter, shared by every {@linkcode makeRouter} result
 * so an app's `router.events.on(...)`/`.off(...)` pair (registered and cleaned up
 * across renders) always target the same emitter.
 */
const routerEvents = createRouterEvents();
/** Stylesheet hrefs already present/injected, so soft nav never double-links CSS. */
const injectedCss = new Set<string>();
let cssSeeded = false;
/** Hrefs already prefetched (or in flight), so a link is warmed at most once. */
const prefetched = new Set<string>();

/** Inject a route's `<link rel="stylesheet">` once (CSS is shimmed out of the JS bundle). */
function ensureStylesheet(href: string): void {
  if (!cssSeeded) {
    cssSeeded = true;
    for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
      const h = l.getAttribute("href");
      if (h) injectedCss.add(h);
    }
  }
  if (injectedCss.has(href)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
  injectedCss.add(href);
}

/** The current navigation state driving the rendered tree. */
interface NavState {
  page: string;
  pageProps: Record<string, unknown>;
  query: Record<string, string | string[]>;
  asPath: string;
}
let current: NavState = { page: "/", pageProps: {}, query: {}, asPath: "/" };

/**
 * Register a route's page component. Called at the top of every generated entry
 * (including chunks fetched during soft navigation) so the runtime can render a
 * route once its code has loaded.
 */
export function registerPage(routePath: string, component: PageComponent): void {
  registry.set(routePath, component);
}

/** Build the client-side {@linkcode NextRouter} for a navigation state. */
function makeRouter(state: NavState): NextRouter {
  return {
    route: state.page,
    pathname: state.page,
    query: state.query,
    asPath: state.asPath,
    basePath,
    isReady: true,
    push: (url, as, options) =>
      navigate(url, { as, shallow: options?.shallow, scroll: options?.scroll }),
    replace: (url, as, options) =>
      navigate(url, { replace: true, as, shallow: options?.shallow, scroll: options?.scroll }),
    reload: () => globalThis.location.reload(),
    back: () => globalThis.history.back(),
    forward: () => globalThis.history.forward(),
    prefetch: (url: string) => prefetchRoute(url),
    events: routerEvents,
  };
}

/** Build the VNode tree for a state: `RouterProvider > _app > Page` (mirrors SSR). */
function buildTree(state: NavState): VNode {
  const Page = registry.get(state.page);
  if (!Page) throw new Error(`@denext/pages-router: no registered page for "${state.page}"`);
  const inner = appComponent
    ? h(appComponent, { Component: Page, pageProps: state.pageProps })
    : h(Page, state.pageProps);
  return h(RouterProvider, { router: makeRouter(state) }, inner) as VNode;
}

/**
 * Hydrate the server-rendered page. Called by every generated entry; only the
 * first call hydrates (later entries — loaded via soft nav — just
 * {@linkcode registerPage} and no-op here).
 *
 * @param opts.App The `_app` component, or `null` when the project has none.
 */
export function bootstrapPages(opts: { App: PageComponent | null }): void {
  if (booted) return;
  booted = true;
  if (opts.App) appComponent = opts.App;

  const el = typeof document !== "undefined" ? document.getElementById("__NEXT_DATA__") : null;
  const container = typeof document !== "undefined" ? document.getElementById("__next") : null;
  if (!el || !container) return; // not a hydratable document — nothing to do

  let data: NextData;
  try {
    data = JSON.parse(el.textContent || "{}") as NextData;
  } catch {
    return;
  }
  basePath = data.basePath ?? "";
  current = {
    page: data.page,
    pageProps: data.props?.pageProps ?? {},
    query: data.query ?? {},
    asPath: data.asPath ?? globalThis.location.pathname,
  };

  try {
    root = hydrateRoot(container, buildTree(current));
  } catch (err) {
    // A hydration mismatch shouldn't blank the page — the SSR markup stays.
    console.warn("denext/pages-router: skipping hydration:", (err as Error)?.message);
    return;
  }
  installLinkInterception();
  installPopState();
  installPrefetchObserver();
  // Signal (for tests / progressive enhancement) that hydration completed.
  document.documentElement.setAttribute("data-denext-pages-hydrated", "1");
}

/** Options for {@linkcode navigate}. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** The nav came from a `popstate` event — don't touch history again. */
  fromPop?: boolean;
  /** The URL to show in the address bar, if it differs from the fetched `href`. */
  as?: string;
  /** Update the query without re-fetching data, when the pathname is unchanged. */
  shallow?: boolean;
  /** Scroll to the top after navigating (default `true`). */
  scroll?: boolean;
}

/** The path portion (no query/hash) of the currently displayed URL. */
function currentPathname(): string {
  return new URL(current.asPath, globalThis.location.href).pathname;
}

/** Parse a URL's search string into Next's `query` shape (repeated keys → arrays). */
export function queryFromSearch(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

/** Resolve `href` against the current location; add `basePath` to app-absolute paths. */
function withBase(href: string): string {
  if (basePath && href.startsWith("/") && !href.startsWith(basePath + "/") && href !== basePath) {
    return basePath + href;
  }
  return href;
}

/**
 * Perform a soft navigation to `href`: fetch its data (running the server's
 * `getServerSideProps`/`getStaticProps`), load its code chunk if new, and
 * re-render the retained root in place. Falls back to a full document load for
 * cross-origin targets, redirects, not-found, or any failure.
 */
export async function navigate(href: string, opts: NavigateOptions): Promise<boolean> {
  const target = new URL(href, globalThis.location.href);
  // A hard fallback: reload (not assign) when the URL already changed via popstate,
  // so we don't push a duplicate history entry.
  const fallback = (): boolean => {
    if (opts.fromPop) globalThis.location.reload();
    else globalThis.location.assign(href);
    return false;
  };
  if (target.origin !== globalThis.location.origin || !root) {
    globalThis.location.assign(href);
    return true;
  }
  // The URL shown in the address bar (`as` overrides the fetched path); it's also
  // the `asPath` reported to route-change listeners.
  const displayUrl = opts.as ?? target.pathname + target.search + target.hash;
  const asPath = displayUrl;
  // Shallow only applies to a query change on the *same* page; a cross-page
  // shallow request falls through to a normal (data-fetching) navigation.
  const shallow = !!opts.shallow && target.pathname === currentPathname();
  const meta = { shallow };
  const scroll = opts.scroll !== false;

  /** Update history + scroll for a successful navigation (skipped on popstate). */
  const commitHistory = (): void => {
    if (opts.fromPop) return;
    routerEvents.emit("beforeHistoryChange", asPath, meta);
    if (opts.replace) globalThis.history.replaceState(null, "", displayUrl);
    else globalThis.history.pushState(null, "", displayUrl);
    if (scroll) globalThis.scrollTo(0, 0);
  };

  // Shallow navigation: keep the current page + props, swap only the query/asPath.
  if (shallow) {
    routerEvents.emit("routeChangeStart", asPath, meta);
    current = {
      ...current,
      query: queryFromSearch(target.searchParams),
      asPath,
    };
    root.render(buildTree(current));
    commitHistory();
    routerEvents.emit("routeChangeComplete", asPath, meta);
    return true;
  }

  // Signal an aborted transition (fetch/chunk failure, not-found) so listeners
  // (progress bars, etc.) can reset. `cancelled` distinguishes a superseded nav.
  const emitError = (cancelled: boolean, cause?: unknown): void => {
    const err = new Error(
      cancelled ? "Route change was cancelled" : "Route change failed",
    ) as Error & { cancelled: boolean; cause?: unknown };
    err.cancelled = cancelled;
    if (cause !== undefined) err.cause = cause;
    routerEvents.emit("routeChangeError", err, asPath, meta);
  };

  const seq = ++navSeq; // this navigation's id; a newer nav supersedes it
  routerEvents.emit("routeChangeStart", asPath, meta);

  let data: DataResponse;
  try {
    const res = await fetch(target.href, {
      headers: { [DATA_HEADER]: "1" },
      credentials: "same-origin",
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
      emitError(false);
      return fallback();
    }
    data = await res.json() as DataResponse;
  } catch (cause) {
    emitError(false, cause);
    return fallback();
  }
  if (seq !== navSeq) { // a later navigation won the race — drop this one
    emitError(true);
    return false;
  }

  if (data.redirect) {
    globalThis.location.assign(data.redirect.destination);
    return false;
  }
  if (data.notFound) {
    emitError(false);
    return fallback();
  }

  if (!registry.has(data.page) && data.entryUrl) {
    try {
      await import(withBase(data.entryUrl));
    } catch (cause) {
      emitError(false, cause);
      return fallback();
    }
  }
  if (seq !== navSeq) { // superseded while the chunk loaded
    emitError(true);
    return false;
  }
  if (!registry.has(data.page)) { // chunk didn't register
    emitError(false);
    return fallback();
  }

  // Inject the route's stylesheet before rendering so it paints styled.
  if (data.cssUrl) ensureStylesheet(withBase(data.cssUrl));

  current = {
    page: data.page,
    pageProps: data.pageProps ?? {},
    query: data.query ?? {},
    asPath: data.asPath ?? target.pathname + target.search,
  };
  root.render(buildTree(current));

  commitHistory();
  routerEvents.emit("routeChangeComplete", current.asPath, meta);
  return true;
}

/** Intercept same-origin left-clicks on `<a>` and route them through soft nav. */
function installLinkInterception(): void {
  document.addEventListener("click", (event: MouseEvent) => {
    if (
      event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    const targetAttr = anchor.getAttribute("target");
    if (targetAttr && targetAttr !== "_self") return;
    if (anchor.hasAttribute("download")) return;
    const rel = anchor.getAttribute("rel");
    if (rel && rel.split(/\s+/).includes("external")) return;
    const raw = anchor.getAttribute("href");
    if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw) && !raw.startsWith("http")) return;

    const url = new URL(anchor.href);
    if (url.origin !== globalThis.location.origin) return;
    // Same page, only a hash change → let the browser scroll natively.
    if (
      url.pathname === globalThis.location.pathname && url.search === globalThis.location.search
    ) {
      return;
    }
    event.preventDefault();
    void navigate(url.pathname + url.search + url.hash, {});
  });
}

/** Re-render on browser back/forward without pushing a new history entry. */
function installPopState(): void {
  globalThis.addEventListener("popstate", () => {
    void navigate(
      globalThis.location.pathname + globalThis.location.search,
      { fromPop: true },
    );
  });
}

/**
 * Warm a route's code chunk (and stylesheet) so a later navigation skips the
 * import — the JS only, never its data (matching Next's prefetch, which never runs
 * `getServerSideProps`). Deduped per URL; best-effort (failures are swallowed).
 */
export async function prefetchRoute(href: string): Promise<void> {
  if (!root) return;
  let target: URL;
  try {
    target = new URL(href, globalThis.location.href);
  } catch {
    return;
  }
  if (target.origin !== globalThis.location.origin) return;
  const key = target.pathname + target.search;
  if (prefetched.has(key)) return;
  prefetched.add(key);
  try {
    const res = await fetch(target.href, {
      headers: { [PREFETCH_HEADER]: "1" },
      credentials: "same-origin",
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return;
    const data = await res.json() as {
      page?: string;
      entryUrl?: string | null;
      cssUrl?: string | null;
    };
    if (data.cssUrl) ensureStylesheet(withBase(data.cssUrl));
    if (data.page && !registry.has(data.page) && data.entryUrl) {
      await import(withBase(data.entryUrl));
    }
  } catch {
    // Best-effort: a failed prefetch just means the navigation fetches normally.
  }
}

/**
 * Prefetch links marked `data-denext-prefetch` (rendered by `<Link prefetch>`) when
 * they scroll into view, and rescan after each soft navigation for new links.
 */
function installPrefetchObserver(): void {
  if (typeof IntersectionObserver === "undefined") return; // SSR / old browsers
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const anchor = entry.target as HTMLAnchorElement;
      observer.unobserve(anchor);
      const raw = anchor.getAttribute("href");
      if (raw) void prefetchRoute(raw);
    }
  }, { rootMargin: "200px" });
  const scan = () => {
    for (const a of document.querySelectorAll("a[data-denext-prefetch]")) observer.observe(a);
  };
  scan();
  routerEvents.on("routeChangeComplete", scan);
}
