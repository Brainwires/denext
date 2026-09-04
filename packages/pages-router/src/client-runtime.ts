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
import {
  __setActiveRouter,
  createRouterEvents,
  type NextRouter,
  RouterProvider,
} from "../router.ts";

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
  isFallback?: boolean;
  basePath?: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
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
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
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
/** i18n state (locales are static; the active locale updates on soft nav). */
const i18n: { locale?: string; locales?: string[]; defaultLocale?: string } = {};
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
  /** True while a `fallback: true` shell is showing (props not yet fetched). */
  isFallback?: boolean;
}
let current: NavState = { page: "/", pageProps: {}, query: {}, asPath: "/" };

/**
 * Register a route's page component. Called at the top of every generated entry
 * (including chunks fetched during soft navigation) so the runtime can render a
 * route once its code has loaded.
 */
export function registerPage(
  routePath: string,
  component: PageComponent,
): void {
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
    isReady: !state.isFallback,
    isFallback: !!state.isFallback,
    push: (url, as, options) =>
      navigate(url, { as, shallow: options?.shallow, scroll: options?.scroll }),
    replace: (url, as, options) =>
      navigate(url, {
        replace: true,
        as,
        shallow: options?.shallow,
        scroll: options?.scroll,
      }),
    reload: () => globalThis.location.reload(),
    back: () => globalThis.history.back(),
    forward: () => globalThis.history.forward(),
    prefetch: (url: string) => prefetchRoute(url),
    events: routerEvents,
    locale: i18n.locale,
    locales: i18n.locales,
    defaultLocale: i18n.defaultLocale,
  };
}

/** Build the VNode tree for a state: `RouterProvider > _app > Page` (mirrors SSR). */
function buildTree(state: NavState): VNode {
  const Page = registry.get(state.page);
  if (!Page) {
    throw new Error(
      `@denext/pages-router: no registered page for "${state.page}"`,
    );
  }
  const inner = appComponent
    ? h(appComponent, { Component: Page, pageProps: state.pageProps })
    : h(Page, state.pageProps);
  const router = makeRouter(state);
  // Publish the live router so the `Router` singleton (next/router default export) can
  // proxy push/replace/events from outside React.
  __setActiveRouter(router);
  return h(RouterProvider, { router }, inner) as VNode;
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
  i18n.locale = data.locale;
  i18n.locales = data.locales;
  i18n.defaultLocale = data.defaultLocale;
  current = {
    page: data.page,
    pageProps: data.props?.pageProps ?? {},
    query: data.query ?? {},
    asPath: data.asPath ?? globalThis.location.pathname,
    isFallback: data.isFallback,
  };

  try {
    root = hydrateRoot(container, buildTree(current));
  } catch (err) {
    // A hydration mismatch shouldn't blank the page — the SSR markup stays.
    console.warn(
      "denext/pages-router: skipping hydration:",
      (err as Error)?.message,
    );
    return;
  }
  installLinkInterception();
  installPopState();
  installPrefetchObserver();
  // A `fallback: true` shell hydrated with no props: fetch the real getStaticProps
  // data for this path, then re-render with it (isFallback → false).
  if (current.isFallback) void completeFallback();
  // Signal (for tests / progressive enhancement) that hydration completed.
  document.documentElement.setAttribute("data-denext-pages-hydrated", "1");
}

/**
 * Resolve a `fallback: true` shell: fetch this path's data (which runs the server's
 * `getStaticProps`) and re-render the retained root with the real props. A
 * not-found/redirect/failure falls back to a full document load, matching Next.
 */
async function completeFallback(): Promise<void> {
  if (!root) return;
  const href = globalThis.location.href;
  let data: DataResponse;
  try {
    const res = await fetch(href, {
      headers: { [DATA_HEADER]: "1" },
      credentials: "same-origin",
    });
    if (
      !res.ok || !res.headers.get("content-type")?.includes("application/json")
    ) {
      globalThis.location.reload();
      return;
    }
    data = await res.json() as DataResponse;
  } catch {
    globalThis.location.reload();
    return;
  }
  if (data.redirect) {
    globalThis.location.assign(data.redirect.destination);
    return;
  }
  if (data.notFound) {
    globalThis.location.reload();
    return;
  }
  if (data.cssUrl) ensureStylesheet(withBase(data.cssUrl));
  current = {
    page: data.page,
    pageProps: data.pageProps ?? {},
    query: data.query ?? current.query,
    asPath: data.asPath ?? current.asPath,
    isFallback: false,
  };
  root.render(buildTree(current));
  routerEvents.emit("routeChangeComplete", current.asPath, { shallow: false });
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
export function queryFromSearch(
  params: URLSearchParams,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

/** Resolve `href` against the current location; add `basePath` to app-absolute paths. */
function withBase(href: string): string {
  if (!basePath || !href.startsWith("/")) return href;
  const alreadyBased = href === basePath || href.startsWith(basePath + "/");
  return alreadyBased ? href : basePath + href;
}

/**
 * Perform a soft navigation to `href`: fetch its data (running the server's
 * `getServerSideProps`/`getStaticProps`), load its code chunk if new, and
 * re-render the retained root in place. Falls back to a full document load for
 * cross-origin targets, redirects, not-found, or any failure.
 */
export async function navigate(
  href: string,
  opts: NavigateOptions,
): Promise<boolean> {
  const target = new URL(href, globalThis.location.href);
  if (target.origin !== globalThis.location.origin || !root) {
    globalThis.location.assign(href);
    return true;
  }
  // The URL shown in the address bar (`as` overrides the fetched path); it's also
  // the `asPath` reported to route-change listeners.
  const asPath = opts.as ?? target.pathname + target.search + target.hash;
  // Shallow only applies to a query change on the *same* page; a cross-page
  // shallow request falls through to a normal (data-fetching) navigation.
  const shallow = !!opts.shallow && target.pathname === currentPathname();
  const nav: Nav = { href, target, asPath, meta: { shallow }, opts };
  if (shallow) return shallowNavigate(nav);
  const seq = ++navSeq; // this navigation's id; a newer nav supersedes it
  routerEvents.emit("routeChangeStart", asPath, nav.meta);
  const data = await fetchRouteData(nav, seq);
  if (!data || !(await ensureRouteChunk(nav, data, seq))) return false;
  commitRoute(nav, data);
  return true;
}

/** One soft navigation in flight. */
interface Nav {
  /** The raw href (what a hard fallback assigns). */
  href: string;
  target: URL;
  /** The display path (`as` or the target's path+search+hash). */
  asPath: string;
  meta: { shallow: boolean };
  opts: NavigateOptions;
}

/** Shallow navigation: keep the current page + props, swap only the query/asPath. */
function shallowNavigate(nav: Nav): boolean {
  routerEvents.emit("routeChangeStart", nav.asPath, nav.meta);
  current = { ...current, query: queryFromSearch(nav.target.searchParams), asPath: nav.asPath };
  root!.render(buildTree(current));
  commitHistory(nav);
  routerEvents.emit("routeChangeComplete", nav.asPath, nav.meta);
  return true;
}

/**
 * Fetch the route's data. Null when the navigation ended without a render: a hard
 * fallback (fetch failure, non-JSON, not found), a server redirect, or a newer
 * navigation that won the race.
 */
async function fetchRouteData(nav: Nav, seq: number): Promise<DataResponse | null> {
  let data: DataResponse;
  try {
    const res = await fetch(nav.target.href, {
      headers: { [DATA_HEADER]: "1" },
      credentials: "same-origin",
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
      return failNav(nav);
    }
    data = await res.json() as DataResponse;
  } catch (cause) {
    return failNav(nav, cause);
  }
  if (seq !== navSeq) return cancelNav(nav); // a later navigation won the race — drop this one
  if (data.redirect) {
    globalThis.location.assign(data.redirect.destination);
    return null;
  }
  if (data.notFound) return failNav(nav);
  return data;
}

/** Load the route's code chunk if it isn't registered yet; false when the navigation ended. */
async function ensureRouteChunk(nav: Nav, data: DataResponse, seq: number): Promise<boolean> {
  if (!registry.has(data.page) && data.entryUrl) {
    try {
      await import(withBase(data.entryUrl));
    } catch (cause) {
      failNav(nav, cause);
      return false;
    }
  }
  if (seq !== navSeq) { // superseded while the chunk loaded
    cancelNav(nav);
    return false;
  }
  if (!registry.has(data.page)) { // chunk didn't register
    failNav(nav);
    return false;
  }
  return true;
}

/** Render the fetched route, then update history and notify listeners. */
function commitRoute(nav: Nav, data: DataResponse): void {
  // Inject the route's stylesheet before rendering so it paints styled.
  if (data.cssUrl) ensureStylesheet(withBase(data.cssUrl));
  if (data.locale !== undefined) i18n.locale = data.locale; // i18n: track active locale
  current = {
    page: data.page,
    pageProps: data.pageProps ?? {},
    query: data.query ?? {},
    asPath: data.asPath ?? nav.target.pathname + nav.target.search,
  };
  root!.render(buildTree(current));
  commitHistory(nav);
  routerEvents.emit("routeChangeComplete", current.asPath, nav.meta);
}

/** Update history + scroll for a successful navigation (skipped on popstate). */
function commitHistory(nav: Nav): void {
  if (nav.opts.fromPop) return;
  routerEvents.emit("beforeHistoryChange", nav.asPath, nav.meta);
  if (nav.opts.replace) globalThis.history.replaceState(null, "", nav.asPath);
  else globalThis.history.pushState(null, "", nav.asPath);
  if (nav.opts.scroll !== false) globalThis.scrollTo(0, 0);
}

/**
 * Abort the transition with a hard fallback: reload (not assign) when the URL already
 * changed via popstate, so we don't push a duplicate history entry. Always null (the
 * caller's "no render" result).
 */
function failNav(nav: Nav, cause?: unknown): null {
  emitNavError(nav, false, cause);
  if (nav.opts.fromPop) globalThis.location.reload();
  else globalThis.location.assign(nav.href);
  return null;
}

/** A superseded navigation: signal the cancellation and render nothing. */
function cancelNav(nav: Nav): null {
  emitNavError(nav, true);
  return null;
}

/**
 * Signal an aborted transition (fetch/chunk failure, not-found) so listeners
 * (progress bars, etc.) can reset. `cancelled` distinguishes a superseded nav.
 */
function emitNavError(nav: Nav, cancelled: boolean, cause?: unknown): void {
  const err = new Error(
    cancelled ? "Route change was cancelled" : "Route change failed",
  ) as Error & { cancelled: boolean; cause?: unknown };
  err.cancelled = cancelled;
  if (cause !== undefined) err.cause = cause;
  routerEvents.emit("routeChangeError", err, nav.asPath, nav.meta);
}

/** Intercept same-origin left-clicks on `<a>` and route them through soft nav. */
/** `hashChangeStart` now; `hashChangeComplete` once the browser has applied the hash. */
function emitHashChange(asPath: string): void {
  const meta = { shallow: false };
  routerEvents.emit("hashChangeStart", asPath, meta);
  globalThis.addEventListener(
    "hashchange",
    () => routerEvents.emit("hashChangeComplete", asPath, meta),
    { once: true },
  );
}

function installLinkInterception(): void {
  document.addEventListener("click", (event: MouseEvent) => {
    if (!isPlainClick(event)) return;
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor || !isSoftNavAnchor(anchor)) return;
    const url = new URL(anchor.href);
    if (url.origin !== globalThis.location.origin) return;
    // Same page, only a hash change → let the browser scroll natively, but emit Next's
    // `hashChangeStart`/`hashChangeComplete` (not `routeChange*`) around it.
    if (
      url.pathname === globalThis.location.pathname &&
      url.search === globalThis.location.search
    ) {
      emitHashChange(url.pathname + url.search + url.hash);
      return;
    }
    event.preventDefault();
    // `<Link replace>` marks the anchor so the click replaces the history entry
    // instead of pushing one, matching next/router's `router.replace`.
    const replace = anchor.hasAttribute("data-denext-replace");
    void navigate(url.pathname + url.search + url.hash, { replace });
  });
}

/** A primary-button click with no modifier and no prior `preventDefault`. */
function isPlainClick(event: MouseEvent): boolean {
  return !(
    event.defaultPrevented || event.button !== 0 ||
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
  );
}

/** A same-tab, non-download, non-external link with a navigable href. */
function isSoftNavAnchor(anchor: HTMLAnchorElement): boolean {
  const targetAttr = anchor.getAttribute("target");
  if (targetAttr && targetAttr !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  const rel = anchor.getAttribute("rel");
  if (rel && rel.split(/\s+/).includes("external")) return false;
  return isNavigableHref(anchor.getAttribute("href"));
}

/** Not empty, not an in-page fragment, and not a non-http scheme (`mailto:`, `tel:`…). */
function isNavigableHref(raw: string | null): boolean {
  if (!raw || raw.startsWith("#")) return false;
  return !(/^[a-z]+:/i.test(raw) && !raw.startsWith("http"));
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
    if (
      !res.ok || !res.headers.get("content-type")?.includes("application/json")
    ) return;
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
    for (const a of document.querySelectorAll("a[data-denext-prefetch]")) {
      observer.observe(a);
    }
  };
  scan();
  routerEvents.on("routeChangeComplete", scan);
}
