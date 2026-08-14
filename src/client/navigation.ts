// Client-side (soft) navigation: intercept internal link clicks, fetch the
// target page's server-rendered HTML, swap it into the hydration root, update
// history + <head>, and re-run the route bundle to hydrate the new content.
//
// This module is browser-only in practice; all DOM/history/fetch access is
// inside functions so it can be imported safely on the server.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
import { hydrateRoot, type Root } from "./reconciler.ts";
import { type Context, useContext, useEffect, useRef, useState } from "../runtime/hooks.ts";
import { createContext } from "../runtime/context.ts";
import { type FlightNavPayload, type HydrationData, ROOT_ID } from "../server/document.ts";
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
  /** Prefetched body (HTML, or a Flight JSON payload), "" while in flight. */
  body: string;
  /** Whether `body` is a Flight JSON payload (vs a full HTML document). */
  flight: boolean;
  /** Completion time (epoch ms); 0 while in flight (never TTL-expired). */
  at: number;
}
/** A completed prefetch result: the response body and whether it is Flight JSON. */
interface RouteResponse {
  body: string;
  flight: boolean;
}
const prefetchCache = new Map<string, PrefetchEntry>();

/** Read a still-fresh entry (touching it for LRU); evicts a TTL-expired one. */
function prefetchGet(key: string): RouteResponse | undefined {
  const e = prefetchCache.get(key);
  if (!e) return undefined;
  if (e.body !== "" && Date.now() - e.at > PREFETCH_TTL_MS) {
    prefetchCache.delete(key);
    return undefined;
  }
  prefetchCache.delete(key); // re-insert to mark most-recently-used
  prefetchCache.set(key, e);
  return { body: e.body, flight: e.flight };
}

/** Store an entry and evict the LRU beyond the entry-count cap. */
function prefetchStore(key: string, body: string, flight: boolean): void {
  prefetchCache.set(key, { body, flight, at: body === "" ? 0 : Date.now() });
  while (prefetchCache.size > PREFETCH_CACHE_MAX) {
    const oldest = prefetchCache.keys().next().value;
    if (oldest === undefined) break;
    prefetchCache.delete(oldest);
  }
}

/**
 * Fetch a route for soft navigation. Returns the response body plus whether the
 * server answered with a Flight JSON payload (`x-denext-flight`) rather than a
 * full HTML document. A non-OK, non-404 status rejects (caller hard-navigates).
 */
async function fetchRoute(href: string): Promise<RouteResponse> {
  const res = await fetch(href, { headers: { "x-denext-nav": "1" } });
  if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  return { body: await res.text(), flight: res.headers?.get("x-denext-flight") === "1" };
}

// The Flight soft-nav parser, registered by the generated Flight entry
// (`setFlightParser`). It reconstructs a VNode tree from a Flight payload via the
// app-wide client registry. Left null for isomorphic (non-Flight) apps, whose
// server never sends a Flight payload — so this stays entirely out of their
// bundle (the Flight entry is the only importer of `parseFlight`).
let flightParse: ((flight: unknown) => VNodeChild) | null = null;

/**
 * Register the Flight-payload parser used by soft navigation. Called once by the
 * generated Flight entry with a closure over the route's client registry.
 */
export function setFlightParser(parse: (flight: unknown) => VNodeChild): void {
  flightParse = parse;
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
  prefetchStore(url.href, "", false); // dedupe in-flight
  fetchRoute(url.href)
    .then(({ body, flight }) => prefetchStore(url.href, body, flight))
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
  const url = new URL(withBase(href), location.href);

  // Cross-origin: fall back to a full navigation.
  if (url.origin !== location.origin) {
    location.href = href;
    return;
  }

  await navigateSameOrigin(url, href, options);
}

/** The same-origin soft-navigation body. */
async function navigateSameOrigin(
  url: URL,
  href: string,
  options: NavigateOptions,
): Promise<void> {
  let body: string;
  let flight: boolean;
  const prefetched = prefetchGet(url.href);
  if (prefetched && prefetched.body.length > 0) {
    body = prefetched.body; // use the prefetched render
    flight = prefetched.flight;
  } else {
    try {
      const r = await fetchRoute(url.href);
      body = r.body;
      flight = r.flight;
    } catch {
      // Network/parse failure: hard navigate so the user isn't stuck.
      location.href = href;
      return;
    }
  }

  // Flight route: the server sent a JSON payload, not HTML. Parse it through the
  // app-wide client registry and reconcile the retained root in place — no HTML
  // parse, no bundle re-run. If we can't (no parser / no retained root), hard
  // navigate rather than DOMParser-ing JSON.
  if (flight) {
    if (flightParse && retainedRoot) {
      applyFlightNav(body, url, href, options);
    } else {
      location.href = href;
    }
    return;
  }

  const parsed = new DOMParser().parseFromString(body, "text/html");
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
 * Apply a Flight soft-navigation payload: parse the JSON envelope, update
 * history, title, and the `#__denext_data` island, then reconcile the new tree
 * through the retained root in place (preserving unaffected-subtree state). Both
 * `flightParse` and `retainedRoot` are guaranteed non-null by the caller.
 */
function applyFlightNav(body: string, url: URL, href: string, options: NavigateOptions): void {
  // Parse + reconstruct + render under one guard: a malformed-but-valid-JSON
  // payload can throw in parseFlight/reconcile, and history/title must not be
  // mutated on a render we can't complete. Any failure hard-navigates so the user
  // is never stuck on the old route (mirrors the JSON.parse/fetch failure paths).
  let payload: FlightNavPayload;
  let tree: VNode;
  try {
    payload = JSON.parse(body) as FlightNavPayload;
    tree = flightParse!(payload.flight) as VNode;
  } catch {
    location.href = href; // malformed payload / reconstruction failure: hard navigate
    return;
  }

  // Update history first so route hooks read the correct URL after render.
  if (options.history === false) {
    // popstate: the browser already changed the URL; leave history alone.
  } else if (options.replace) {
    history.replaceState({}, "", url.href);
  } else {
    history.pushState({}, "", url.href);
  }

  // <title> + the hydration-data island, so useParams()/useTranslations() etc.
  // re-read the new route's params/messages (and a later hard reload matches).
  if (payload.title != null) document.title = payload.title;
  writeDataIsland(payload.data);

  emit();
  if (options.scroll !== false) globalThis.scrollTo?.(0, 0);

  try {
    retainedRoot!.render(tree);
  } catch {
    // The render threw after we committed history/title — recover with a hard nav
    // so the document isn't left half-updated.
    location.href = href;
  }
}

/** Write the `#__denext_data` island from a hydration-data object (Flight nav). */
function writeDataIsland(data: HydrationData): void {
  let live = document.getElementById("__denext_data");
  if (!live) {
    live = document.createElement("script");
    live.id = "__denext_data";
    (live as HTMLScriptElement).type = "application/json";
    document.body.appendChild(live);
  }
  live.textContent = JSON.stringify(data);
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

/**
 * Per-`<Link>` navigation status, read by {@link useLinkStatus}. Each `<Link>`
 * provides its own value around its children; the default (`{ pending: false }`)
 * applies outside any Link, matching Next.js (where `useLinkStatus` is only
 * meaningful inside a Link).
 */
const LinkStatusContext: Context<LinkStatus> = createContext<LinkStatus>({ pending: false });

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
  // This link's own pending state: true from the click until its navigation
  // settles. Scoped to this Link (provided via LinkStatusContext) so a
  // descendant useLinkStatus() reflects only this link, not any global nav.
  const [pending, setPending] = useState(false);

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
          setPending(true);
          navigate(href, { replace, scroll }).finally(() => setPending(false));
        }
      },
    },
    // Scope this link's pending status to its subtree so useLinkStatus() reads it.
    h(LinkStatusContext.Provider, { value: { pending } }, children),
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
 * `useLinkStatus` (Next.js) — reactive pending state for the enclosing `<Link>`,
 * for rendering inline loading indicators. Scoped to the nearest `<Link>`:
 * `pending` is `true` from that link's click until its navigation settles.
 * Outside any `<Link>` it is always `false` (matching Next.js).
 *
 * @returns `{ pending }` for the enclosing link's navigation.
 */
export function useLinkStatus(): LinkStatus {
  return useContext(LinkStatusContext);
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
