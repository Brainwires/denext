// Client-side (soft) navigation: intercept internal link clicks, fetch the
// target page's server-rendered HTML, swap it into the hydration root, update
// history + <head>, and re-run the route bundle to hydrate the new content.
//
// This module is browser-only in practice; all DOM/history/fetch access is
// inside functions so it can be imported safely on the server.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { hydrateRoot } from "./reconciler.ts";
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
let current: LocationState = readLocation();

function readLocation(): LocationState {
  if (typeof location === "undefined") return { pathname: "/", search: "" };
  return { pathname: location.pathname, search: location.search };
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

// Cache of prefetched page HTML keyed by absolute URL. An empty string marks an
// in-flight prefetch (so concurrent triggers dedupe).
const prefetchCache = new Map<string, string>();

/**
 * Prefetch the page at `href` in the background (same-origin only) and cache its
 * HTML, so a subsequent {@link navigate} is instant. No-op on the server, for
 * cross-origin URLs, or when already prefetched/in-flight.
 */
export function prefetch(href: string): void {
  if (typeof location === "undefined") return;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  if (prefetchCache.has(url.href)) return;
  prefetchCache.set(url.href, ""); // dedupe in-flight
  fetch(url.href, { headers: { "x-denext-nav": "1" } })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
    .then((html) => prefetchCache.set(url.href, html))
    .catch(() => prefetchCache.delete(url.href));
}

// ---- Soft navigation -------------------------------------------------------

let navCounter = 0;

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
  const url = new URL(href, location.href);

  // Cross-origin: fall back to a full navigation.
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }

  let html: string;
  const prefetched = prefetchCache.get(url.href);
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

  // Swap the server-rendered markup in.
  container.innerHTML = newRoot.innerHTML;

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

/** Hydrate the root and enable client-side navigation. Used by route bundles. */
export function startClient(container: Element, tree: VNode): void {
  hydrateRoot(container, tree);
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
      href,
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
function readData(): { params?: Record<string, string>; messages?: Messages } {
  if (typeof document === "undefined") return {};
  try {
    const el = document.getElementById("__denext_data");
    if (!el) return {};
    return JSON.parse(el.textContent ?? "{}") as {
      params?: Record<string, string>;
      messages?: Messages;
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
