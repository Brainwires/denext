// Client-side (soft) navigation: intercept internal link clicks, fetch the
// target page's server-rendered HTML, swap it into the hydration root, update
// history + <head>, and re-run the route bundle to hydrate the new content.
//
// This module is browser-only in practice; all DOM/history/fetch access is
// inside functions so it can be imported safely on the server.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { hydrateRoot, type Root } from "./reconciler.ts";
import { useContext, useEffect, useRef, useState } from "../runtime/hooks.ts";
import { ROOT_ID } from "../server/document.ts";
import { LayoutSegmentContext } from "../runtime/layout-segments.ts";
import {
  makeTranslate,
  type Messages,
  MessagesContext,
  type TranslateFn,
} from "../runtime/i18n-messages.ts";

// ---- Reactive location store ----------------------------------------------

interface LocationState {
  pathname: string;
  search: string;
}

const listeners = new Set<() => void>();

// The configured basePath (denext.config `basePath`). Set on the server via
// setBasePath(); read from the hydration payload on the client.
let configuredBase = "";
let clientBaseRead = false;

/** Set the app's basePath so `<Link>`/`navigate()` prefix URLs (SSR + startup). */
export function setBasePath(basePath: string): void {
  configuredBase = basePath.replace(/\/$/, "");
}

function basePath(): string {
  if (!configuredBase && !clientBaseRead && typeof document !== "undefined") {
    clientBaseRead = true;
    const bp = readData().basePath;
    if (bp) configuredBase = bp.replace(/\/$/, "");
  }
  return configuredBase;
}

/** Prefix an app-relative path with basePath (idempotent; skips external URLs). */
function withBase(path: string): string {
  const b = basePath();
  if (!b || !path.startsWith("/") || path === b || path.startsWith(b + "/")) return path;
  return b + path;
}

/** Strip basePath from a location pathname so app code sees app-relative paths. */
function stripBase(path: string): string {
  const b = basePath();
  if (b && (path === b || path.startsWith(b + "/"))) return path.slice(b.length) || "/";
  return path;
}

let current: LocationState = readLocation();

function readLocation(): LocationState {
  if (typeof location === "undefined") return { pathname: "/", search: "" };
  return { pathname: stripBase(location.pathname), search: location.search };
}

function emit(): void {
  current = readLocation();
  for (const l of listeners) l();
}

export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocationState(): LocationState {
  return current;
}

// ---- Prefetching -----------------------------------------------------------

// Cache of prefetched page HTML keyed by absolute URL. `html === ""` marks an
// in-flight prefetch (so concurrent triggers dedupe). Bounded by both an entry
// count (LRU) and a TTL so hovering/scrolling across a large site can't grow it
// without limit or serve a long-stale prefetch. Map insertion order is the LRU.
const PREFETCH_CACHE_MAX = 50;
const PREFETCH_TTL_MS = 5 * 60_000; // completed entries expire after 5 minutes

interface PrefetchEntry {
  /** Prefetched HTML, or "" while the request is still in flight. */
  html: string;
  /** Completion time (epoch ms); 0 while in flight (never TTL-expired). */
  at: number;
}
const prefetchCache = new Map<string, PrefetchEntry>();

/** Read a still-fresh entry (touching it for LRU); evicts a TTL-expired one. */
function prefetchGet(key: string): string | undefined {
  const e = prefetchCache.get(key);
  if (!e) return undefined;
  if (e.html !== "" && Date.now() - e.at > PREFETCH_TTL_MS) {
    prefetchCache.delete(key);
    return undefined;
  }
  prefetchCache.delete(key); // re-insert to mark most-recently-used
  prefetchCache.set(key, e);
  return e.html;
}

/** Store an entry and evict the LRU beyond the entry-count cap. */
function prefetchStore(key: string, html: string): void {
  prefetchCache.set(key, { html, at: html === "" ? 0 : Date.now() });
  while (prefetchCache.size > PREFETCH_CACHE_MAX) {
    const oldest = prefetchCache.keys().next().value;
    if (oldest === undefined) break;
    prefetchCache.delete(oldest);
  }
}

/**
 * Prefetch the page at `href` in the background (same-origin only) and cache its
 * HTML, so a subsequent {@link navigate} is instant. No-op on the server, for
 * cross-origin URLs, or when already prefetched/in-flight.
 */
export function prefetch(href: string): void {
  if (typeof location === "undefined") return;
  const url = new URL(withBase(href), location.href);
  if (url.origin !== location.origin) return;
  // Skip if in-flight ("") or still-fresh; a TTL-expired entry is dropped here
  // and re-fetched below.
  if (prefetchGet(url.href) !== undefined) return;
  prefetchStore(url.href, ""); // dedupe in-flight
  fetch(url.href, { headers: { "x-denext-nav": "1" } })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then((html) => prefetchStore(url.href, html))
    .catch(() => prefetchCache.delete(url.href));
}

// ---- Soft navigation -------------------------------------------------------

let navCounter = 0;

// Navigation pending status, backing `useLinkStatus`. denext's soft nav is a
// single global operation (fetch → swap → re-hydrate) rather than React's per-
// Link transition, so this reports whether *any* soft navigation is in flight
// (not scoped to one Link) — a deliberate, simpler divergence documented in
// KNOWN-LIMITATIONS. Ref-counted so overlapping navigations (rapid clicks) keep
// `pending` true until the last one settles, rather than the first to finish
// clearing it. `true` from the start of a navigate() until its DOM swap.
let navInFlight = 0;
const navStatusListeners = new Set<() => void>();

function setNavPending(value: boolean): void {
  const was = navInFlight > 0;
  navInFlight = Math.max(0, navInFlight + (value ? 1 : -1));
  const now = navInFlight > 0;
  if (was === now) return;
  for (const l of navStatusListeners) l();
}

/** Subscribe to navigation-pending changes (for `useLinkStatus`). */
export function subscribeNavStatus(listener: () => void): () => void {
  navStatusListeners.add(listener);
  return () => navStatusListeners.delete(listener);
}

/** Whether a soft navigation is currently in flight. */
export function getNavPending(): boolean {
  return navInFlight > 0;
}

/** Options controlling a soft (client-side) navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /** Internal: set when responding to popstate (don't push history). */
  history?: boolean;
}

/**
 * Perform a soft navigation to `href`: fetch the target page, swap its markup
 * into the hydration root, update history and `<head>`, and re-hydrate. Falls
 * back to a full-page navigation on cross-origin URLs or network failure.
 */
export async function navigate(
  href: string,
  options: NavigateOptions = {},
): Promise<void> {
  const url = new URL(withBase(href), location.href);

  // Cross-origin: fall back to a full navigation.
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }

  setNavPending(true);
  try {
    await navigateSameOrigin(url, href, options);
  } finally {
    setNavPending(false);
  }
}

/** The same-origin soft-navigation body (pending status wraps this). */
async function navigateSameOrigin(
  url: URL,
  href: string,
  options: NavigateOptions,
): Promise<void> {
  let html: string;
  const prefetched = prefetchGet(url.href);
  if (typeof prefetched === "string" && prefetched.length > 0) {
    html = prefetched; // use the prefetched render
  } else {
    try {
      const res = await fetch(url.href, { headers: { "x-denext-nav": "1" } });
      if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
      html = await res.text();
    } catch {
      // Network/parse failure: hard navigate so the user isn't stuck.
      location.href = href;
      return;
    }
  }

  const parsed = new DOMParser().parseFromString(html, "text/html");
  const newRoot = parsed.getElementById(ROOT_ID);
  const container = document.getElementById(ROOT_ID);
  if (!newRoot || !container) {
    location.href = href;
    return;
  }

  // Update history first so the bundle sees the correct URL.
  if (options.history === false) {
    // popstate: the browser already changed the URL; leave history alone.
  } else if (options.replace) {
    history.replaceState({}, "", url.href);
  } else {
    history.pushState({}, "", url.href);
  }

  // <title> and hydration data.
  const newTitle = parsed.querySelector("title");
  if (newTitle) document.title = newTitle.textContent ?? "";
  syncScript(parsed, "__denext_data");
  // Flight island: sync it too so a soft-nav to a Flight route hydrates from the
  // new payload (and a nav to an isomorphic route clears a stale one).
  syncScript(parsed, "__denext_flight");

  // Reconcile-in-place: when a retained root exists the re-run route bundle calls
  // startClient → root.render(newTree), which diffs the old tree into the new one
  // and patches the DOM — preserving state in unaffected subtrees. Only when there
  // is no retained root (defensive) do we blow away and re-mount the markup.
  if (!retainedRoot) {
    container.innerHTML = newRoot.innerHTML;
  }

  emit();
  if (options.scroll !== false) globalThis.scrollTo?.(0, 0);

  // Re-run the route's client bundle to hydrate the swapped markup.
  const moduleScript = parsed.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  if (moduleScript) {
    const src = new URL(moduleScript.getAttribute("src")!, url.href);
    src.searchParams.set("nav", String(navCounter++));
    const script = document.createElement("script");
    script.type = "module";
    script.src = src.href;
    // Remove the injected node once it has run (or failed to) so soft-nav
    // <script> elements don't pile up in <body> across navigations.
    const cleanup = () => script.remove();
    script.addEventListener("load", cleanup, { once: true });
    script.addEventListener("error", cleanup, { once: true });
    document.body.appendChild(script);
  }
}

/**
 * Copy the incoming page's JSON island (`#<id>`) into the live document. When the
 * incoming page has no such island, remove any stale live copy so it does not
 * leak into the next hydration.
 */
function syncScript(parsed: Document, id: string): void {
  const incoming = parsed.getElementById(id);
  let live = document.getElementById(id);
  if (!incoming) {
    live?.remove();
    return;
  }
  if (!live) {
    live = document.createElement("script");
    live.id = id;
    (live as HTMLScriptElement).type = "application/json";
    document.body.appendChild(live);
  }
  live.textContent = incoming.textContent;
}

// ---- Link interception -----------------------------------------------------

function shouldIntercept(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false; // left click only
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  if (anchor.getAttribute("rel") === "external") return false;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return false;
  return true;
}

/** Install global click + popstate handlers (idempotent per page load). */
export function installNavigation(): void {
  const w = globalThis as unknown as { __denextNav?: boolean };
  if (typeof document === "undefined" || w.__denextNav) return;
  w.__denextNav = true;

  document.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    if (!shouldIntercept(event as MouseEvent, anchor as HTMLAnchorElement)) return;
    event.preventDefault();
    navigate((anchor as HTMLAnchorElement).href);
  });

  globalThis.addEventListener("popstate", () => {
    navigate(location.href, { history: false });
  });
}

/**
 * The retained reconciler root for the hydration container. Kept across soft
 * navigations so a nav reconciles the new route in place (`root.render`) instead
 * of re-mounting — preserving state in unaffected subtrees and skipping a
 * re-hydrate. Lives in the shared runtime chunk, so it persists across the
 * cache-busted route-bundle re-imports a soft nav triggers.
 */
let retainedRoot: Root | null = null;

/**
 * Mount (first load) or reconcile (soft nav) the route tree and enable client-side
 * navigation. Called by every route bundle: on the initial load it hydrates the
 * server markup and retains the root; on a soft nav's bundle re-run it renders the
 * new tree through the retained root, reconciling in place.
 *
 * @param container The hydration root element.
 * @param tree The route's virtual-node tree.
 */
export function startClient(container: Element, tree: VNode): void {
  if (retainedRoot) {
    retainedRoot.render(tree); // soft nav: reconcile in place (preserves state)
  } else {
    retainedRoot = hydrateRoot(container, tree);
  }
  installNavigation();
}

// ---- Link component + router hooks -----------------------------------------

/** Props for the {@link Link} client-side navigating anchor component. */
export interface LinkProps {
  /** Destination URL for the link. */
  href: string;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /**
   * Prefetch the target in the background: on hover, and when the link scrolls
   * into view. Set `false` to disable. Defaults to enabled.
   */
  prefetch?: boolean;
  /** Anchor contents. */
  children?: VNodeChildren;
  /** Any additional attributes forwarded to the underlying `<a>` element. */
  [key: string]: unknown;
}

/** A client-side navigating anchor with hover/viewport prefetching. */
export function Link(props: LinkProps): VNode {
  const { href, replace, scroll, prefetch: pf, children, ...rest } = props;
  const ref = useRef<Element | null>(null);

  // Viewport prefetch: prefetch once the link becomes visible.
  useEffect(() => {
    if (pf === false) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          prefetch(href);
          io.disconnect();
          break;
        }
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [href, pf]);

  return h(
    "a",
    {
      ...rest,
      // Render the basePath-prefixed href so the link works without JS too;
      // navigate()/prefetch() re-derive it from the original href.
      href: withBase(href),
      ref,
      onMouseEnter: () => {
        if (pf !== false) prefetch(href);
      },
      onClick: (event: MouseEvent) => {
        if (
          event.button === 0 && !event.metaKey && !event.ctrlKey &&
          !event.shiftKey && !event.altKey
        ) {
          event.preventDefault();
          navigate(href, { replace, scroll });
        }
      },
    },
    children,
  );
}

/** Imperative navigation API returned by {@link useRouter}. */
export interface Router {
  /** Navigate to `href`, pushing a new history entry. */
  push(href: string): void;
  /** Navigate to `href`, replacing the current history entry. */
  replace(href: string): void;
  /** Go back one entry in the history stack. */
  back(): void;
  /** Go forward one entry in the history stack. */
  forward(): void;
  /** Re-fetch and re-render the current route. */
  refresh(): void;
}

/** Access the imperative {@link Router} for programmatic navigation. */
export function useRouter(): Router {
  return {
    push: (href) => void navigate(href),
    replace: (href) => void navigate(href, { replace: true }),
    back: () => history.back(),
    forward: () => history.forward(),
    refresh: () => void navigate(location.href, { history: false }),
  };
}

/** The status of an in-flight navigation, returned by {@link useLinkStatus}. */
export interface LinkStatus {
  /** Whether a soft navigation is currently pending. */
  pending: boolean;
}

/**
 * `useLinkStatus` (Next.js) — reactive pending state for client navigation, for
 * rendering inline loading indicators. denext's soft nav is a single global
 * operation, so this reflects whether *any* navigation is in flight rather than
 * being scoped to one enclosing `<Link>` (a documented divergence). `pending` is
 * `true` from the moment a navigation starts until its markup is swapped in.
 *
 * @returns `{ pending }` for the current navigation.
 */
export function useLinkStatus(): LinkStatus {
  const [pending, setPending] = useState(getNavPending());
  useEffect(() => subscribeNavStatus(() => setPending(getNavPending())), []);
  return { pending };
}

/** Reactive current pathname; re-renders the component on navigation. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(getLocationState().pathname);
  useEffect(
    () => subscribeLocation(() => setPathname(getLocationState().pathname)),
    [],
  );
  return pathname;
}

/** Reactive current search params. */
export function useSearchParams(): URLSearchParams {
  const [search, setSearch] = useState(getLocationState().search);
  useEffect(
    () => subscribeLocation(() => setSearch(getLocationState().search)),
    [],
  );
  return new URLSearchParams(search);
}

/** Read the server-embedded hydration data (params, messages, etc.). */
function readData(): { params?: Record<string, string>; messages?: Messages; basePath?: string } {
  if (typeof document === "undefined") return {};
  try {
    const el = document.getElementById("__denext_data");
    if (!el) return {};
    return JSON.parse(el.textContent ?? "{}") as {
      params?: Record<string, string>;
      messages?: Messages;
      basePath?: string;
    };
  } catch {
    return {};
  }
}

/** Read the active locale from the server-embedded hydration data. */
function readLocale(): string {
  return readData().params?.locale ?? "";
}

/**
 * The current route's dynamic params (reactive). Reads the params the server
 * resolved for this page from the hydration payload; updates on soft navigation.
 */
export function useParams(): Record<string, string> {
  const [params, setParams] = useState<Record<string, string>>(() => readData().params ?? {});
  useEffect(() => subscribeLocation(() => setParams(readData().params ?? {})), []);
  return params;
}

/**
 * The active locale (reactive) for apps using i18n routing. Reads the locale the
 * server resolved for this page from the hydration payload and re-reads it on
 * soft navigation. Server components should read `params.locale` directly.
 */
export function useLocale(): string {
  const [locale, setLocale] = useState(readLocale());
  useEffect(() => subscribeLocation(() => setLocale(readLocale())), []);
  return locale;
}

/** Read the active locale's message catalog from the hydration payload. */
function readMessages(): Messages {
  return readData().messages ?? {};
}

/**
 * Access a translation function `t(key, vars?)` for the active locale (reactive).
 * Looks up `key` in the locale's catalog and interpolates `{var}` placeholders;
 * a missing key returns the key itself. The catalog comes from the render-time
 * provider during SSR and from the hydration payload on the client, re-read on
 * soft navigation (so switching locales updates the strings).
 *
 * ```ts
 * const t = useTranslations();
 * t("greeting", { name }); // "Bonjour, Ada" for the "fr" catalog
 * ```
 */
export function useTranslations(): TranslateFn {
  // useContext must run unconditionally; on the client its default is ignored in
  // favor of the embedded catalog.
  const provided = useContext(MessagesContext);
  const [messages, setMessages] = useState<Messages>(() =>
    typeof document === "undefined" ? provided : readMessages()
  );
  useEffect(() => subscribeLocation(() => setMessages(readMessages())), []);
  return makeTranslate(messages);
}

/**
 * The active route path segments **below the calling layout's level** (reactive),
 * matching Next.js. A layout at `/a` sees `["b","c"]` for `/a/b/c`; the root
 * layout sees all segments. The depth comes from the nearest
 * {@link LayoutSegmentContext} provider (injected around each layout by the
 * server renderer and the client route entry); outside any layout it is 0, so
 * all segments are returned. Updates on soft navigation.
 *
 * Note: under the Flight boundary, a `"use client"` island resolves relative to
 * the app root (depth 0), since the layout providers are expanded server-side.
 */
export function useSelectedLayoutSegments(): string[] {
  const { pathname, depth } = useContext(LayoutSegmentContext);
  // Seed from the provider's pathname (correct on the server); track live
  // navigation on the client so the slice updates on soft nav.
  const [live, setLive] = useState(pathname);
  useEffect(() => subscribeLocation(() => setLive(getLocationState().pathname)), []);
  return live.split("/").filter((s) => s.length > 0).slice(depth);
}

/** The first route segment below the calling layout's level (reactive), or null. */
export function useSelectedLayoutSegment(): string | null {
  const segments = useSelectedLayoutSegments();
  return segments.length > 0 ? segments[0] : null;
}
