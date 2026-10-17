// Client-side (soft) navigation: intercept internal link clicks, fetch the
// target page's server-rendered HTML, swap it into the hydration root, update
// history + <head>, and re-run the route bundle to hydrate the new content.
//
// This module is browser-only in practice; all DOM/history/fetch access is
// inside functions so it can be imported safely on the server.

import { BLUR_ATTR, clearBlur } from "../runtime/image-blur.ts";
import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { fillPattern, parsePattern, type RouteParams } from "../router/segments.ts";
import type { StandardSchemaV1 } from "../runtime/define-action.ts";
import { hydrateDocument, hydrateRoot } from "./reconciler.ts";
import { revealStreamedHoles } from "./reveal-holes.ts";
import {
  type Context,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { createContext } from "../runtime/context.ts";
// The document.ts imports are type-only (erased at build): its server-only deps (which import
// node:async_hooks) never reach the client bundle.
import type { HydrationData } from "../server/document.ts";
import {
  globalWin,
  type NavigateOptions,
  nextNavStamp,
  retainedRoot,
  retainRoot,
} from "./nav-state.ts";

export type { NavigateOptions };
import { LayoutSegmentContext } from "../runtime/layout-segments.ts";
import { setActionRefreshHandler } from "../runtime/server-action.ts";
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

// The configured basePath (denext.config `basePath`). Set on the server via setBasePath(); read
// from the hydration payload on the client. Kept on a process-wide slot: a compatibility-mode
// server bundle carries its own copy of this module, whose `<Link>` must see it too.
const baseSlot = globalThis as { __denextBasePath?: string };
let clientBaseRead = false;

/** Set the app's basePath so `<Link>`/`navigate()` prefix URLs (SSR + startup). */
export function setBasePath(basePath: string): void {
  baseSlot.__denextBasePath = basePath.replace(/\/$/, "");
}

function basePath(): string {
  if (!baseSlot.__denextBasePath && !clientBaseRead && typeof document !== "undefined") {
    clientBaseRead = true;
    const bp = readData().basePath;
    if (bp) baseSlot.__denextBasePath = bp.replace(/\/$/, "");
  }
  return baseSlot.__denextBasePath ?? "";
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

/** Notify the location hooks that the URL changed (also the Flight soft nav's, flight-nav.ts). */
export function emit(): void {
  current = readLocation();
  for (const l of listeners) l();
}

export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLocationState(): LocationState {
  if (typeof location === "undefined") return serverLocation() ?? current;
  return current;
}

type ContextBridge = {
  __denextCurrentRequestContext?: () => { request?: Request } | undefined;
};

/**
 * On the server, `usePathname()` / `useSearchParams()` in a Client Component reflect the
 * request being rendered (Next does the same), read through the request-context bridge the
 * server installs — never a static import of the server runtime from this client module.
 */
function serverLocation(): LocationState | null {
  const req = (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request;
  if (!req) return null;
  try {
    const u = new URL(req.url);
    return { pathname: stripBase(u.pathname), search: u.search };
  } catch {
    return null;
  }
}

// ---- Prefetching -----------------------------------------------------------

// Cache of prefetched page HTML keyed by absolute URL. `html === ""` marks an
// in-flight prefetch (so concurrent triggers dedupe). Bounded by both an entry
// count (LRU) and a TTL so hovering/scrolling across a large site can't grow it
// without limit or serve a long-stale prefetch. Map insertion order is the LRU.
const PREFETCH_CACHE_MAX = 50;
const PREFETCH_TTL_MS = 5 * 60_000; // completed entries expire after 5 minutes

interface PrefetchEntry {
  /** Prefetched body (HTML, or a Flight/iso JSON payload), "" while in flight. */
  body: string;
  /** Whether `body` is a Flight JSON payload (vs a full HTML document). */
  flight: boolean;
  /** Whether `body` is an isomorphic-nav JSON payload (title/data/entry/styles). */
  iso: boolean;
  /** Completion time (epoch ms); 0 while in flight (never TTL-expired). */
  at: number;
}
/** A completed prefetch result: the response body and which kind of payload it is. */
interface RouteResponse {
  body: string;
  flight: boolean;
  iso: boolean;
  /** A Flight payload streaming its deferred values: the response, unread (`body` is empty). */
  res?: Response;
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
  return { body: e.body, flight: e.flight, iso: e.iso };
}

/** Store an entry and evict the LRU beyond the entry-count cap. */
function prefetchStore(key: string, body: string, flight: boolean, iso: boolean): void {
  prefetchCache.set(key, { body, flight, iso, at: body === "" ? 0 : Date.now() });
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
async function fetchRoute(href: string, stream = false): Promise<RouteResponse> {
  // A registered request provider (the Remix compat's `shouldRevalidate` optimization) adds
  // per-request headers — and, for an over-large echo, a POST body — so the server can skip
  // unchanged loaders. Never overrides `x-denext-nav`.
  const extra = navRequestProvider?.() ?? {};
  const res = await fetch(href, {
    method: extra.body ? "POST" : "GET",
    headers: {
      ...extra.headers,
      ...slotStateHeader(),
      "x-denext-nav": "1",
      // A navigation takes a Flight payload's deferred values as they settle (flight-nav-stream.ts).
      ...(stream ? { "x-denext-defer": "1" } : {}),
    },
    body: extra.body,
  });
  if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
  // A redirect that landed on another origin (an auth provider, a marketing site) is not a
  // page of this app: never splice its body into the document — let the browser load it.
  if (res.url && new URL(res.url).origin !== location.origin) {
    throw new Error("cross-origin redirect");
  }
  return await readRoute(res);
}

/**
 * A soft-nav response's payload and kind. A Flight payload streaming its deferred values is left
 * unread, for the Flight navigator to read line by line.
 */
async function readRoute(res: Response): Promise<RouteResponse> {
  const header = (k: string) => res.headers?.get(k) === "1";
  const flight = header("x-denext-flight");
  const streamed = flight && header("x-denext-defer");
  return {
    body: streamed ? "" : await res.text(),
    flight,
    iso: header("x-denext-iso"),
    res: streamed ? res : undefined,
  };
}

/**
 * The parallel-route slot state to echo on a soft-nav fetch: the `slotState` map the server
 * put in the current page's data island, so a slot the new URL doesn't match keeps its
 * content instead of dropping to `default.tsx` (Next.js semantics; `server/slot-state.ts`).
 */
function slotStateHeader(): Record<string, string> {
  const state = (readData() as HydrationData | null)?.slotState;
  return state && Object.keys(state).length > 0
    ? { "x-denext-slot-state": JSON.stringify(state) }
    : {};
}

/** The prefetch-cache key: the URL plus the slot state it was rendered under. */
function prefetchKey(href: string): string {
  const state = slotStateHeader()["x-denext-slot-state"];
  return state ? `${href}\u0000${state}` : href;
}

/**
 * The Flight soft-nav handler, installed by the generated Flight entry's `setFlightParser`
 * (flight-nav.ts): parse a Flight navigation payload through the app-wide client registry and
 * commit it. Left null for isomorphic (non-Flight) apps, whose server never sends a Flight
 * payload — so the whole Flight soft-nav runtime stays out of their bundle (the Flight entry is
 * the only importer of flight-nav.ts).
 */
let flightNav: FlightNavigator | null = null;

/**
 * The Flight soft-nav handler: the payload, or (`res`) the response streaming it, committed
 * through the loaded soft-nav commit module (`nav`).
 */
type FlightNavigator = (
  body: string,
  url: URL,
  href: string,
  options: NavigateOptions,
  nav: DocumentNav,
  res?: Response,
) => Promise<void>;

/** Install the Flight soft-nav handler (called by flight-nav.ts's `setFlightParser`). */
export function setFlightNavigator(fn: FlightNavigator): void {
  flightNav = fn;
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
  const key = prefetchKey(url.href);
  if (prefetchGet(key) !== undefined) return;
  prefetchStore(key, "", false, false); // dedupe in-flight
  prefetchQueue.push({ href: url.href, key });
  pumpPrefetches();
}

/**
 * At most this many prefetches in flight: a docs sidebar scrolls dozens of links into view
 * at once, and each prefetch is a full server render — unbounded, they starve the
 * navigation the user actually makes (and the server).
 */
const MAX_PREFETCH_INFLIGHT = 4;
const prefetchQueue: Array<{ href: string; key: string }> = [];
let prefetchInflight = 0;

function pumpPrefetches(): void {
  while (prefetchInflight < MAX_PREFETCH_INFLIGHT && prefetchQueue.length > 0) {
    const { href, key } = prefetchQueue.shift()!;
    prefetchInflight++;
    fetchRoute(href)
      .then(({ body, flight, iso }) => {
        prefetchStore(key, body, flight, iso);
        void loadDocumentNav(); // warm the soft-nav commit for the click
      })
      .catch(() => prefetchCache.delete(key))
      .finally(() => {
        prefetchInflight--;
        pumpPrefetches();
      });
  }
}

// ---- Soft navigation -------------------------------------------------------

/**
 * The soft-navigation commit (nav-document.ts: the view-transition wrapper, history, scroll and
 * the isomorphic / full-HTML paths), loaded on first need — a prefetch warms it, a navigation
 * starts it alongside the route fetch — so a page that never navigates never fetches it.
 */
type DocumentNav = typeof import("./nav-document.ts");
let documentNav: Promise<DocumentNav | null> | undefined;

/** Load (once) the soft-navigation commit module, nav-document.ts; null when its chunk failed. */
function loadDocumentNav(): Promise<DocumentNav | null> {
  return documentNav ??= import("./nav-document.ts").catch(() => (documentNav = undefined, null));
}

// ---- Global soft-navigation pending signal ---------------------------------
//
// A process-wide signal that a same-origin soft navigation is in flight, with the
// target href. Backs a global pending indicator (e.g. Remix's `useNavigation`
// `state: "loading"`), which per-link `useLinkStatus` cannot express. A monotonic
// token guards overlapping navigations: only the latest nav clears the signal, so
// a slow earlier nav settling after a newer one started doesn't false-clear it.

let navPendingHref: string | null = null;
let navToken = 0;
const navPendingListeners = new Set<() => void>();

/** The target href of the in-flight soft navigation, or `null` when idle. */
export function getNavigatingHref(): string | null {
  return navPendingHref;
}

/** Subscribe to soft-navigation start/settle transitions (returns an unsubscribe). */
export function subscribeNavigating(listener: () => void): () => void {
  navPendingListeners.add(listener);
  return () => navPendingListeners.delete(listener);
}

function setNavigatingHref(href: string | null): void {
  if (navPendingHref === href) return;
  navPendingHref = href;
  for (const l of navPendingListeners) l();
}

/**
 * A single active soft-navigation blocker predicate: given the target `href`, return `true`
 * to VETO the navigation. Backs Remix/react-router `useBlocker` (one active blocker, matching
 * react-router). `null` clears it. Consulted only in {@link navigate} for user-initiated navs.
 */
let softNavBlocker: ((href: string) => boolean) | null = null;

/** Register (or clear, with `null`) the active soft-nav blocker. See {@link softNavBlocker}. */
export function setSoftNavBlocker(fn: ((href: string) => boolean) | null): void {
  softNavBlocker = fn;
}

/**
 * A provider of extra request state for every soft-nav route fetch — the seam the Remix compat
 * uses for its `shouldRevalidate` optimization (echoing the client's prior route ids + URL/params
 * + loader data so the server can skip unchanged loaders). Returns headers and, when the echo is
 * too large for headers, a JSON `body` (which switches the fetch to POST — the server treats a
 * POST carrying `x-denext-nav` as a render with an over-large payload). Generic and remix-agnostic;
 * `null` clears it. `x-denext-nav` always wins over any header a provider returns.
 */
let navRequestProvider: (() => { headers?: Record<string, string>; body?: string }) | null = null;

/** Register (or clear, with `null`) the soft-nav request provider. */
export function setNavRequestProvider(
  fn: (() => { headers?: Record<string, string>; body?: string }) | null,
): void {
  navRequestProvider = fn;
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

  // A registered soft-nav blocker (Remix/react-router `useBlocker`) can veto a
  // user-initiated navigation (unsaved-changes guard). Skipped for popstate reactions
  // (`history: false`) — the browser URL has already moved, so blocking the content swap
  // would desync it; back/forward interception is a documented non-goal.
  if (softNavBlocker && options.history !== false && softNavBlocker(href)) return;

  // Publish the global pending signal for the duration of this same-origin nav.
  const token = ++navToken;
  setNavigatingHref(href);
  try {
    await navigateSameOrigin(url, href, options, token);
    if (token === navToken) committedHref = url.href; // the committed entry (for undoing a blocked back/forward)
  } finally {
    if (token === navToken) setNavigatingHref(null); // only the latest nav clears it
  }
}

/** The prefetched render for `url`, else a fresh fetch; null when the fetch failed. */
async function loadRoute(
  url: URL,
): Promise<RouteResponse | null> {
  const prefetched = prefetchGet(prefetchKey(url.href));
  if (prefetched && prefetched.body.length > 0) return prefetched;
  try {
    return await fetchRoute(url.href, true);
  } catch {
    return null;
  }
}

/** The same-origin soft-navigation body. */
async function navigateSameOrigin(
  url: URL,
  href: string,
  options: NavigateOptions,
  token: number,
): Promise<void> {
  const commit = loadDocumentNav(); // every soft-nav commit path needs it: load it alongside
  const loaded = await loadRoute(url);
  // Superseded while loading (the user clicked again): applying this response now would
  // clobber the newer navigation's document. The newer one owns the page.
  if (token !== navToken) return;
  if (!loaded) {
    location.href = href; // network/parse failure: hard navigate so the user isn't stuck
    return;
  }
  const nav = await commit;
  if (token !== navToken) return; // superseded while the soft-nav commit loaded
  if (!nav) {
    location.href = href; // the soft-nav chunk failed to load: hard navigate
    return;
  }
  const { body, flight, iso, res } = loaded;
  // Flight route: the server sent a JSON payload, not HTML. Parse it through the app-wide
  // client registry and reconcile the retained root in place — no HTML parse, no bundle
  // re-run. A root-less islands page mounts a fresh root on its first Flight nav. If we can't
  // (no Flight runtime, or no root to render into: see flight-nav.ts), hard navigate rather
  // than DOMParser-ing JSON.
  if (flight) {
    if (flightNav) await flightNav(body, url, href, options, nav, res);
    else location.href = href;
    return;
  }
  // Isomorphic route: a compact JSON payload (title/data/entry/styles) instead of the full
  // HTML — the SSR body would be discarded anyway, since the re-run entry re-renders it.
  if (iso) return nav.applyIsoNav(body, url, href, options, emit);
  nav.applyHtmlNav(body, url, href, options, emit);
}

// ---- Link interception -----------------------------------------------------

/** An unmodified left click that nothing else claimed. */
/** A modified click opens a new tab/window or a context menu — never a soft nav. */
const MODIFIER_KEYS = ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const;

function isPlainClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false; // left click only
  return !MODIFIER_KEYS.some((key) => event[key]);
}

/** A same-origin, same-tab, non-download, non-external link. */
function isSoftNavAnchor(anchor: HTMLAnchorElement): boolean {
  if (opensOtherContext(anchor.getAttribute("target"))) return false;
  if (anchor.hasAttribute("download") || anchor.getAttribute("rel") === "external") return false;
  return new URL(anchor.href, location.href).origin === location.origin;
}

/** A `target` other than the current browsing context (`_blank`, a named frame…). */
function opensOtherContext(target: string | null): boolean {
  return !!target && target !== "_self";
}

function shouldIntercept(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  return isPlainClick(event) && isSoftNavAnchor(anchor);
}

/**
 * `next/image` blur placeholders in SERVER-ONLY trees have no hydrated `onLoad`: clear them
 * here — images already complete at boot, then every later `load` (captured, since `load`
 * does not bubble). Hydrated images clear themselves through their own handler as well.
 */
function installBlurClearing(): void {
  const sel = `img[${BLUR_ATTR}]`;
  for (const img of document.querySelectorAll<HTMLImageElement>(sel)) {
    if (img.complete) clearBlur(img);
  }
  document.addEventListener("load", (event) => {
    const img = event.target as HTMLImageElement | null;
    if (img?.tagName === "IMG" && img.hasAttribute(BLUR_ATTR)) clearBlur(img);
  }, true);
}

/** Install global click + popstate handlers (idempotent per page load). */
function installNavigation(): void {
  const w = globalThis as unknown as {
    __denextNav?: boolean;
    /** A navigator's pop claim (StackLayout): true when it shows the target screen itself. */
    __dnxPop?: (href: string, event: Event) => unknown;
  };
  if (typeof document === "undefined" || w.__denextNav) return;
  w.__denextNav = true;

  document.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    if (!shouldIntercept(event as MouseEvent, anchor as HTMLAnchorElement)) return;
    event.preventDefault();
    navigate((anchor as HTMLAnchorElement).href);
  });
  installBlurClearing();

  committedHref = location.href;
  globalThis.addEventListener("popstate", (event) => {
    const target = location.href;
    // A registered blocker (useBlocker) also vetoes browser back/forward: the browser has
    // already moved to `target`, so undo it by restoring the entry we were on, and let the
    // blocker enter its "blocked" state (proceed() then navigates to `target`).
    if (softNavBlocker && softNavBlocker(target)) {
      try {
        history.pushState(null, "", committedHref);
      } catch { /* history unavailable — nothing to undo */ }
      return;
    }
    committedHref = target;
    // A navigator that still holds the target screen (StackLayout's kept screens) claims the
    // pop: it shows the screen itself, so only the location hooks catch up — no refetch.
    if (w.__dnxPop?.(target, event)) return emit();
    navigate(target, { history: false, scroll: false }); // the browser restores scroll itself
  });
}

/**
 * The last URL the app committed to — tracked so a blocked browser back/forward can be undone
 * (restore this entry). Updated on every successful soft navigation and on install.
 */
let committedHref = "";

/**
 * Mount (first load) or reconcile (soft nav) the route tree and enable client-side
 * navigation. Called by every route bundle: on the initial load it hydrates the
 * server markup and retains the root; on a soft nav's bundle re-run it renders the
 * new tree through the retained root, reconciling in place.
 *
 * A `null` tree is a root-less islands page: every client part of it is a carved `client:*`
 * island that hydrates in its own root, so the page root has nothing to hydrate (its server
 * inlined no root Flight). Only navigation is installed; the first Flight navigation away
 * mounts a fresh root (flight-nav.ts's `mountRootlessPage`).
 *
 * @param container The hydration root element.
 * @param tree The route's virtual-node tree, or `null` for a root-less islands page.
 */
export function startClient(container: Element, tree: VNode | null): void {
  const root = retainedRoot ?? globalWin.__dnxRoot;
  if (tree === null) {
    if (!root) {
      revealStreamedHoles(); // the islands hydrate against resolved content, not a fallback
      globalWin.__dnxRootless = true;
    }
  } else if (root) {
    root.render(tree); // soft nav: reconcile in place (preserves state)
  } else {
    // Ordering safety: reveal any streamed hole not yet swapped by the inline
    // runtime, so hydration reads the resolved content, not a fallback (no-op on
    // buffered pages). Idempotent with the observer's `isConnected` guard.
    revealStreamedHoles();
    retainRoot(hydrateRoot(container, tree));
  }
  installNavigation();
  // Read-your-writes: after a Server Action revalidates a tag or calls `refresh()`,
  // re-render the current route in place. Wired here (not via a static edge from the
  // isomorphic server-action module) so client navigation never enters the server graph.
  setActionRefreshHandler(() => void navigate(location.href, { history: false }));
}

/**
 * Hydrate the server-rendered `global-error.tsx` document so it becomes interactive and its
 * `reset` is a real function (author `onClick`/handlers work too — before this the page shipped
 * no client JS at all). global-error replaces the root layout and renders its own `<html>`/
 * `<body>`, so it hydrates at the document root ({@link hydrateDocument}), not the `#__denext`
 * container. The error is rebuilt from the `#__denext_ge_data` island the server emitted (the
 * same redacted message/digest it rendered with, so hydration matches). `reset` reloads the
 * current route — an honest retry that re-runs the server render, which may now succeed; a soft
 * in-place retry would need the whole app runtime loaded into the error page.
 */
export function startGlobalErrorClient(
  GlobalError: (p: { error: Error; reset: () => void }) => VNode,
): void {
  const dataEl = document.getElementById("__denext_ge_data");
  // The page is already server-rendered and visible; a corrupt data island must not throw here
  // (that would abort hydration and leave `reset` dead) — fall back to a generic error.
  let data: { message?: string; digest?: string } = {};
  try {
    if (dataEl) data = JSON.parse(dataEl.textContent || "{}");
  } catch {
    data = {};
  }
  const error = Object.assign(new Error(data.message ?? "Error"), { digest: data.digest });
  hydrateDocument(h(GlobalError, { error, reset: () => void resetGlobalError() }));
}

/**
 * `reset()` for a hydrated global-error page — Next's soft recovery, not a browser reload.
 * denext's global-error fires on a SERVER render failure (it replaces the whole document), so
 * there is no client app tree to re-render in place; recovery means re-running the render. This
 * re-fetches the current route and swaps the document in place: a render that now succeeds
 * replaces the error UI with the app (no reload flash), and one that still fails renders a fresh
 * global-error. Any failure (offline, no `DOMParser`) falls back to a hard reload. Exported for
 * testing.
 */
export async function resetGlobalError(): Promise<void> {
  if (typeof fetch !== "function" || typeof DOMParser === "undefined") return location.reload();
  let html: string;
  try {
    const res = await fetch(location.href, { headers: { "cache-control": "no-cache" } });
    html = await res.text();
  } catch {
    return location.reload();
  }
  try {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    if (!parsed || !parsed.documentElement) return location.reload();
    swapDocument(parsed);
  } catch {
    location.reload();
  }
}

/**
 * Replace the live document with `parsed`'s tree and re-run its executable scripts (a soft
 * reload). The incoming document brings its own hydration root + entry, so the retained
 * global-error root is dropped first — the re-run entry then hydrates fresh rather than
 * reconciling the app into the old error tree. A module entry is re-imported under a fresh
 * `?nav` query (ES modules evaluate once per URL, so the same src would not re-run); JSON data
 * islands are left as-is (inert, already in the swapped-in tree).
 */
function swapDocument(parsed: Document): void {
  retainRoot(null);
  document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);
  document.title = parsed.title || document.title;
  for (const old of Array.from(document.querySelectorAll("script"))) {
    const type = old.getAttribute("type");
    if (type && type !== "module" && !/javascript/i.test(type)) continue; // skip data islands
    const script = document.createElement("script");
    for (const attr of Array.from(old.attributes)) script.setAttribute(attr.name, attr.value);
    const src = old.getAttribute("src");
    if (src && type === "module") {
      const u = new URL(src, location.href);
      u.searchParams.set("nav", nextNavStamp());
      script.src = u.href;
    }
    script.textContent = old.textContent;
    old.replaceWith(script);
  }
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
/**
 * Typed-routes registry (augmentation seam). `denext build`/`dev` emit `.denext/routes.ts`,
 * which augments this interface with `routes: Routes`; import that file anywhere in your app
 * and {@link Link} / {@link Router.push} narrow to real paths. Empty by default ⇒
 * {@link Href} is `string` (no enforcement until you opt in).
 */
// deno-lint-ignore no-empty-interface
export interface RegisteredRoutes {}

/** A navigable path: the app's registered routes when typed-routes is wired, else `string`. */
export type Href = RegisteredRoutes extends { routes: infer R extends string } ? R
  : string;

/**
 * The per-route params map when typed-routes is wired (from `.denext/routes.ts`), else a loose
 * fallback. Each key is a route pattern (`/blog/[slug]`) → its params object (`{ slug: string }`).
 */
export type RegisteredParams = RegisteredRoutes extends { params: infer P } ? P
  : Record<string, Record<string, string | string[]>>;

/** An href's query: a record (nullish values are dropped) or a pre-built query string. */
export type QueryInput = Record<string, string | number | boolean | null | undefined> | string;

/** Next.js `UrlObject` — the object form `Link`/`useRouter` accept as an href. */
export interface UrlObject {
  /** The path (`/blog/[slug]` resolved). */
  pathname?: string;
  /** Query as a record (nullish values are dropped) or a pre-built string. */
  query?: QueryInput;
  /** Fragment, with or without the leading `#`. */
  hash?: string;
  /** Pre-built query string (wins over `query`), with or without the leading `?`. */
  search?: string;
}

/**
 * The typed object form of an href: a route pattern as `pathname` plus the `params` object it
 * requires (checked against this app's routes when `.denext/routes.ts` is imported). A route with
 * no dynamic segments takes no `params`. Unresolved dynamic segments are filled from `params`, so
 * `{ pathname: "/blog/[slug]", params: { slug } }` navigates to `/blog/<slug>`.
 */
export type TypedUrlObject = {
  [P in keyof RegisteredParams & string]:
    & { pathname: P; query?: QueryInput; hash?: string; search?: string }
    & (keyof RegisteredParams[P] extends never ? { params?: Record<never, never> }
      : { params: RegisteredParams[P] });
}[keyof RegisteredParams & string];

/**
 * A string href, or the object form. Once `.denext/routes.ts` is imported the object form is the
 * strict {@link TypedUrlObject} (a real route pattern + its required `params`); before that it is the
 * loose {@link UrlObject}, so navigation stays permissive until an app opts into typed routes.
 */
export type HrefInput =
  | Href
  | (RegisteredRoutes extends { params: unknown } ? TypedUrlObject : UrlObject);

/** Fill a route-pattern pathname (`/blog/[slug]`, `/t/[...tags]`, `/d/[[...p]]`) from a params object. */
function fillPathname(pathname: string, params: Record<string, string | string[]>): string {
  return fillPattern(parsePattern(pathname), params as RouteParams);
}

/** Format a {@linkcode UrlObject}/{@linkcode TypedUrlObject} (or pass a string through). */
export function formatHref(href: HrefInput): string {
  if (typeof href === "string") return href;
  const params = (href as { params?: Record<string, string | string[]> }).params;
  let out = params && href.pathname ? fillPathname(href.pathname, params) : href.pathname ?? "";
  if (href.search) out += href.search.startsWith("?") ? href.search : `?${href.search}`;
  else if (href.query) {
    const q = typeof href.query === "string" ? href.query : new URLSearchParams(
      Object.entries(href.query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString();
    if (q) out += `?${q}`;
  }
  if (href.hash) out += href.hash.startsWith("#") ? href.hash : `#${href.hash}`;
  return out;
}

/** The anchor attributes a `Link` forwards (everything an `<a>` takes except `href`). */
export type AnchorProps = Omit<Record<string, unknown>, "href" | "children">;

/** Props for the {@link Link} component — an `<a>` with client-side soft navigation. */
export interface LinkProps extends AnchorProps {
  /** Destination URL (typed to the app's {@link Href} when wired), or a `UrlObject`. */
  href: HrefInput;
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
  /**
   * Prefetch the target in the background. `null` (the default, as in Next.js) prefetches
   * when the link scrolls into view; `true` also prefetches on hover; `false` disables.
   */
  prefetch?: boolean | null;
  /** Accepted for Next.js compatibility (shallow routing is not a denext concept). */
  shallow?: boolean;
  /** Accepted for Next.js compatibility (locale routing is handled by `i18n` config). */
  locale?: string | false;
  /**
   * Next.js `legacyBehavior`: the single child `<a>` IS the anchor — `href` and the
   * navigation handlers are cloned onto it instead of wrapping it in another `<a>`.
   */
  legacyBehavior?: boolean;
  /** Accepted for Next.js compatibility (the href is always forwarded). */
  passHref?: boolean;
  /** Anchor contents. */
  children?: VNodeChildren;
}

/** The Link-only props that must never reach the DOM. */
const LINK_ONLY_PROPS = ["shallow", "locale", "legacyBehavior", "passHref"] as const;

/** A client-side navigating anchor with hover/viewport prefetching. */
export function Link(props: LinkProps): VNode {
  const { href: rawHref, replace, scroll, prefetch: pf, children, legacyBehavior, ...rest } = props;
  for (const k of LINK_ONLY_PROPS) delete (rest as Record<string, unknown>)[k];
  const href = formatHref(rawHref);
  const { onClick: userClick, onMouseEnter: userEnter, ref: userRef, ...anchorRest } = rest as {
    onClick?: (e: MouseEvent) => void;
    onMouseEnter?: (e: MouseEvent) => void;
    ref?: unknown;
  } & Record<string, unknown>;
  const ref = useRef<Element | null>(null);
  // This link's own pending state: true from the click until its navigation
  // settles. Scoped to this Link (provided via LinkStatusContext) so a
  // descendant useLinkStatus() reflects only this link, not any global nav.
  const [pending, setPending] = useState(false);
  useViewportPrefetch(ref, href, pf);

  const handlers = {
    // The user's ref and handlers run first; a `preventDefault()` in theirs cancels the
    // soft navigation (Next.js semantics), and `target`/`download` links are left alone.
    ref: mergeRefs(ref, userRef),
    onMouseEnter: (event: MouseEvent) => {
      userEnter?.(event);
      if (pf === true) prefetch(href);
    },
    onClick: (event: MouseEvent) => {
      userClick?.(event);
      const anchor = event.currentTarget as HTMLAnchorElement | null;
      if (!isPlainClick(event) || (anchor && !isSoftNavAnchor(anchor))) return;
      event.preventDefault();
      setPending(true);
      navigate(href, { replace, scroll }).finally(() => setPending(false));
    },
  };
  const status = (inner: VNodeChildren) =>
    h(LinkStatusContext.Provider, { value: { pending } }, inner);
  if (legacyBehavior) return status(legacyAnchor(children, href, handlers));
  return h("a", { ...anchorRest, href: withBase(href), ...handlers }, status(children));
}

/** One callback ref that feeds every given ref (object or callback); local to avoid a cycle. */
function mergeRefs(...refs: unknown[]): (node: Element | null) => void {
  return (node) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r && typeof r === "object") (r as { current: Element | null }).current = node;
    }
  };
}

/** Viewport prefetch: prefetch once the link becomes visible (unless `prefetch === false`). */
function useViewportPrefetch(
  ref: { current: Element | null },
  href: string,
  pf: boolean | null | undefined,
): void {
  useEffect(() => {
    if (pf === false) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        prefetch(href);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [href, pf]);
}

/** `legacyBehavior`: clone the child `<a>` with the href + handlers instead of nesting anchors. */
function legacyAnchor(
  children: VNodeChildren,
  href: string,
  handlers: Record<string, unknown>,
): VNodeChildren {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === "object" && "type" in child && child.type === "a") {
    const c = child as VNode & { props: Record<string, unknown> };
    return { ...c, props: { ...c.props, href: withBase(href), ...handlers } } as VNode;
  }
  return h("a", { href: withBase(href), ...handlers }, children);
}

/** Options for {@link Router.push} / {@link Router.replace} (Next.js `NavigateOptions`). */
export interface RouterNavigateOptions {
  /** Scroll to the top after navigating (defaults to true). */
  scroll?: boolean;
}

/** Imperative navigation API returned by {@link useRouter} (Next.js `AppRouterInstance`). */
export interface Router {
  /** Navigate to `href`, pushing a new history entry. */
  push(href: HrefInput, options?: RouterNavigateOptions): void;
  /** Navigate to `href`, replacing the current history entry. */
  replace(href: HrefInput, options?: RouterNavigateOptions): void;
  /** Prefetch `href` so a later push/replace is instant. */
  prefetch(href: HrefInput, options?: { kind?: "auto" | "full" | "temporary" }): void;
  /** Go back one entry in the history stack. */
  back(): void;
  /** Go forward one entry in the history stack. */
  forward(): void;
  /** Re-fetch and re-render the current route. */
  refresh(): void;
}

/** One stable router object (so `useEffect(…, [router])` does not re-run every render). */
const ROUTER: Router = {
  push: (href, options) => void navigate(formatHref(href), { scroll: options?.scroll }),
  replace: (href, options) =>
    void navigate(formatHref(href), { replace: true, scroll: options?.scroll }),
  prefetch: (href) => prefetch(formatHref(href)),
  back: () => history.back(),
  forward: () => history.forward(),
  refresh: () => {
    prefetchCache.clear(); // stale prefetched documents must not satisfy the refreshed route
    void navigate(location.href, { history: false });
  },
};

/** Access the imperative {@link Router} for programmatic navigation. Stable identity. */
export function useRouter(): Router {
  return ROUTER;
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

/**
 * Next's `ReadonlyURLSearchParams` — the read-only view of the URL query
 * that `useSearchParams()` returns. It is a real `URLSearchParams` for reads/iteration,
 * but its mutating methods throw (you cannot change the URL by mutating this object;
 * navigate instead).
 */
export class ReadonlyURLSearchParams extends URLSearchParams {
  private static readonly ERROR = (method: string) =>
    new Error(
      `ReadonlyURLSearchParams.${method} is not supported: the search params from ` +
        `useSearchParams() are read-only. Use useRouter().push/replace to change the URL.`,
    );
  /** Not supported — this view is read-only. @throws always. */
  override append(_name: string, _value: string): never {
    throw ReadonlyURLSearchParams.ERROR("append");
  }
  /** Not supported — this view is read-only. @throws always. */
  override delete(_name: string, _value?: string): never {
    throw ReadonlyURLSearchParams.ERROR("delete");
  }
  /** Not supported — this view is read-only. @throws always. */
  override set(_name: string, _value: string): never {
    throw ReadonlyURLSearchParams.ERROR("set");
  }
  /** Not supported — this view is read-only. @throws always. */
  override sort(): never {
    throw ReadonlyURLSearchParams.ERROR("sort");
  }
}

/** What a Standard Schema produces from the query string — its validated output type. */
export type SearchOutput<S> = S extends StandardSchemaV1<infer O> ? O : never;

/**
 * Thrown by `useSearchParams(schema)` when the URL query fails the schema. It is a normal error,
 * so the nearest `error.tsx` boundary catches it (matching the server's `defineApi` validation).
 */
export class SearchParamsValidationError extends Error {
  /** Per-field messages, keyed by the query parameter name. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** Create the error from per-field messages (query parameter name → message). */
  constructor(fieldErrors: Record<string, string>) {
    super(`Invalid search params: ${Object.keys(fieldErrors).join(", ") || "validation failed"}`);
    this.name = "SearchParamsValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/** The raw record a Standard Schema validates: repeat keys become arrays (like server query parsing). */
function searchRecord(params: URLSearchParams): Record<string, string | string[]> {
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }
  return raw;
}

/** Validate the current query against a Standard Schema (synchronously — a hook can't await). */
function validateSearch<O>(schema: StandardSchemaV1<O>, params: URLSearchParams): O {
  const result = schema["~standard"].validate(searchRecord(params));
  if (result instanceof Promise) {
    throw new Error(
      "useSearchParams(schema): the schema validates asynchronously, which a hook cannot await. " +
        "Use a synchronous schema (no async refinements).",
    );
  }
  if (result.issues) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.issues) {
      const first = issue.path?.[0];
      const k = typeof first === "object" && first !== null
        ? String(first.key)
        : String(first ?? "");
      if (k && !(k in fieldErrors)) fieldErrors[k] = issue.message;
    }
    throw new SearchParamsValidationError(fieldErrors);
  }
  return result.value;
}

/**
 * Reactive current search params — a {@link ReadonlyURLSearchParams}, memoized per query string so
 * `useEffect(…, [searchParams])` re-runs only when the query changes.
 *
 * Pass a **Standard Schema** (Zod/Valibot/ArkType/…) to get the query typed and validated instead:
 * `const { page } = useSearchParams(z.object({ page: z.coerce.number().default(1) }))`. Invalid input
 * throws a {@link SearchParamsValidationError} the nearest `error.tsx` catches. Hoist the schema to a
 * module constant so it keeps a stable identity across renders.
 */
export function useSearchParams(): ReadonlyURLSearchParams;
/** Validated overload: parse the query with a Standard Schema and return its typed output. */
export function useSearchParams<S extends StandardSchemaV1>(schema: S): SearchOutput<S>;
export function useSearchParams(
  schema?: StandardSchemaV1,
): ReadonlyURLSearchParams | unknown {
  const [search, setSearch] = useState(getLocationState().search);
  useEffect(
    () => subscribeLocation(() => setSearch(getLocationState().search)),
    [],
  );
  return useMemo(() => {
    const params = new ReadonlyURLSearchParams(search);
    return schema ? validateSearch(schema, params) : params;
  }, [search, schema]);
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
 * The current route's dynamic params (reactive). Reads the params the server resolved for this page
 * from the hydration payload; updates on soft navigation.
 *
 * Pass a route pattern as the type argument to type the result against this app's routes (requires
 * `.denext/routes.ts` imported): `useParams<"/blog/[slug]">()` is `{ slug: string }`.
 */
export function useParams<
  P extends keyof RegisteredParams = never,
>(): [P] extends [never] ? Record<string, string | string[]> : RegisteredParams[P] {
  const [params, setParams] = useState<Record<string, string | string[]>>(
    () => readData().params ?? {},
  );
  useEffect(() => subscribeLocation(() => setParams(readData().params ?? {})), []);
  return params as [P] extends [never] ? Record<string, string | string[]> : RegisteredParams[P];
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
export function useSelectedLayoutSegments(_parallelRoutesKey?: string): string[] {
  const { pathname, depth } = useContext(LayoutSegmentContext);
  // Seed from the provider's pathname (correct on the server); track live
  // navigation on the client so the slice updates on soft nav.
  const [live, setLive] = useState(pathname);
  useEffect(() => subscribeLocation(() => setLive(getLocationState().pathname)), []);
  return live.split("/").filter((s) => s.length > 0).slice(depth);
}

/** The first route segment below the calling layout's level (reactive), or null. */
export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null {
  const segments = useSelectedLayoutSegments(parallelRoutesKey);
  return segments.length > 0 ? segments[0] : null;
}
