/**
 * Internal helpers shared by `denext/mobile`'s deep-link and push modules: decide whether an
 * incoming link is one the app accepts, map it to an in-app path, navigate to it, and fan one
 * native plugin listener out to many subscribers. Not re-exported from `denext/mobile`.
 *
 * @module
 */

/** An allow-list for incoming links. */
export interface LinkAllowList {
  /**
   * Custom schemes to accept (`"myapp"`, no `:`). Omitted: any custom scheme, because the OS
   * only hands the app a custom-scheme URL for a scheme the app itself registered.
   */
  readonly schemes?: readonly string[];
  /**
   * `https` hosts to accept (`"example.com"`, or `"*.example.com"` for any subdomain).
   * Omitted: none, so universal links / app links are refused until you list your domains.
   */
  readonly hosts?: readonly string[];
}

/** Which incoming links to act on: a predicate over the parsed URL, or an allow-list. */
export type LinkAccept = ((url: URL) => boolean) | LinkAllowList;

/**
 * How to navigate to an accepted link: `true` navigates with the page's router, `false` leaves
 * it to the callback, and a function navigates itself (e.g. `(path) => router.push(path)`).
 */
export type LinkRoute = boolean | ((path: string, url: URL) => void);

/** Schemes that are never an app's own custom scheme. */
const NOT_CUSTOM: readonly string[] = [
  "http",
  "https",
  "file",
  "content",
  "javascript",
  "data",
  "blob",
  "about",
  "ftp",
  "ws",
  "wss",
  "mailto",
  "tel",
  "sms",
  "intent",
  "capacitor",
];

/** A URL's scheme without the trailing `:`, lower-cased. */
function schemeOf(url: URL): string {
  return url.protocol.slice(0, -1).toLowerCase();
}

/** Whether `host` matches `pattern` (exact, or `*.domain` for any subdomain of it). */
function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  return p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p;
}

/** Whether `url` passes the allow-list form of {@linkcode LinkAccept}. */
function allowed(url: URL, list: LinkAllowList): boolean {
  const scheme = schemeOf(url);
  if (scheme === "https") {
    const host = url.hostname.toLowerCase();
    return (list.hosts ?? []).some((pattern) => hostMatches(host, pattern));
  }
  if (NOT_CUSTOM.includes(scheme)) return false;
  return list.schemes === undefined ||
    list.schemes.some((s) => s.toLowerCase().replace(/:$/, "") === scheme);
}

/**
 * Whether the app acts on `url`: `accept` as a predicate (a throw counts as "no"), else as an
 * allow-list (the default accepts the app's custom schemes and no `https` host).
 */
export function acceptsLink(url: URL, accept: LinkAccept | undefined): boolean {
  if (typeof accept === "function") {
    try {
      return accept(url) === true;
    } catch {
      return false;
    }
  }
  return allowed(url, accept ?? {});
}

/** `path` when it is an in-app path (`/…`, not `//…` and no backslash), normalised; else undefined. */
export function internalPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return undefined;
  const base = "https://denext.invalid";
  const url = new URL(path, base);
  return url.origin === base ? url.pathname + url.search + url.hash : undefined;
}

/**
 * The in-app path a link opens. An `https` link keeps its path, query and hash. A custom-scheme
 * link reads its host as the first path segment, the way `myapp://threads/42` is written to
 * mean `/threads/42` (and `myapp:///threads/42` means the same).
 */
export function linkPath(url: URL): string | undefined {
  const tail = url.search + url.hash;
  if (schemeOf(url) === "https") return internalPath(url.pathname + tail);
  const path = `/${url.host}/${url.pathname}`.replace(/\/{2,}/g, "/");
  return internalPath((path.length > 1 ? path.replace(/\/$/, "") : path) + tail);
}

/** The page's `history` and `dispatchEvent`, when there is a page. */
interface HistoryWindow {
  history?: { pushState(data: unknown, unused: string, url: string): void };
  dispatchEvent?: (event: Event) => boolean;
}

/**
 * Navigate to `path` per `route`. `true` pushes the path onto the history and fires
 * `popstate`, which denext's App Router, and SPA routers that follow the browser history
 * (react-router, TanStack Router), answer with a client-side navigation.
 */
export function navigateTo(path: string, url: URL, route: LinkRoute): void {
  if (route === false) return;
  if (typeof route === "function") return route(path, url);
  const win = globalThis as HistoryWindow;
  if (typeof win.history?.pushState !== "function") return;
  win.history.pushState(null, "", path);
  if (typeof PopStateEvent === "function") win.dispatchEvent?.(new PopStateEvent("popstate"));
}

/** Tracks whether one incoming event was already routed, so N subscribers navigate once. */
export interface RouteOnce {
  done: boolean;
}

/**
 * One native listener fanned out to every subscriber: `attach` runs when the first subscriber
 * arrives and its dispose function when the last one leaves. While nobody listens the native
 * side keeps any `retainUntilConsumed` event for the next attach.
 */
export interface Fanout<T> {
  subscribe(fn: (value: T, once: RouteOnce) => void): () => void;
}

/** Report a subscriber's throw without stopping delivery to the others. */
function reportError(err: unknown): void {
  console.error("denext/mobile: a listener threw", err);
}

/**
 * Create a {@linkcode Fanout} over `attach`, which starts listening and hands each native value
 * to `emit`, returning its stop function.
 */
export function createFanout<T>(attach: (emit: (value: T) => void) => () => void): Fanout<T> {
  const subscribers = new Set<(value: T, once: RouteOnce) => void>();
  let detach: (() => void) | undefined;
  // Each attach is a generation: a detached listener whose removal is still on its way over
  // the bridge must not deliver into a later attach.
  let generation = 0;
  const emit = (value: T) => {
    const once: RouteOnce = { done: false };
    for (const fn of [...subscribers]) {
      try {
        fn(value, once);
      } catch (err) {
        reportError(err);
      }
    }
  };
  return {
    subscribe(fn) {
      const entry = (value: T, once: RouteOnce) => fn(value, once);
      subscribers.add(entry);
      if (subscribers.size === 1) {
        const current = ++generation;
        detach = attach((value) => current === generation && emit(value));
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(entry);
        if (subscribers.size > 0) return;
        generation++;
        detach?.();
        detach = undefined;
      };
    },
  };
}
