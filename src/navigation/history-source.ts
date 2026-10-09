/**
 * The history sources `denext/navigation`'s history-router bindings ({@linkcode HistoryStack},
 * {@linkcode HistoryTabs}) read and drive: the browser's own history, a TanStack Router, or a
 * React Router data router, behind one small interface. Importing this module runs nothing.
 *
 * @module
 */

/** A location as the history bindings read it. */
export interface HistoryLocation {
  /** The path (`/threads/42`). */
  readonly pathname: string;
  /** The query string, with its `?` (or `""`). */
  readonly search: string;
  /** The fragment, with its `#` (or `""`). */
  readonly hash: string;
  /**
   * The entry's position in the session history, when the router records one (TanStack
   * Router's `__TSR_index`, React Router's `idx`, {@linkcode browserHistory}'s own). With it a
   * back or forward is told apart from a new navigation exactly; without it the stack goes by
   * the routes it holds.
   */
  readonly index?: number;
}

/**
 * A history-based router, as {@linkcode HistoryStack} and {@linkcode HistoryTabs} use it: read
 * the location, hear it change, and navigate. {@linkcode browserHistory},
 * {@linkcode tanstackHistory} and {@linkcode reactRouterHistory} build one; any router whose
 * location lives in the URL history can implement it in a few lines.
 */
export interface HistorySource {
  /** The current location. */
  location(): HistoryLocation;
  /** Call `listener` after every location change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Navigate to `href` with a new history entry. */
  push(href: string): void;
  /** Navigate to `href` in place of the current history entry. */
  replace(href: string): void;
  /** Move `delta` entries through the history (`-1` is back). */
  go(delta: number): void;
}

/** The history-state key {@linkcode browserHistory} keeps each entry's index under. */
const INDEX_KEY = "__dnxIdx";

/** The index stamped on the current history entry, if any. */
function stampedIndex(): number | undefined {
  const state = globalThis.history?.state as Record<string, unknown> | null | undefined;
  const value = state?.[INDEX_KEY];
  return typeof value === "number" ? value : undefined;
}

/** A plain listener set: add with an unsubscribe, notify everyone. */
function listenerSet(onFirst: () => void, onLast: () => void) {
  const listeners = new Set<() => void>();
  return {
    add(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) onFirst();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) onLast();
      };
    },
    notify(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * The browser's own history as a {@linkcode HistorySource}, for an app with no router (or one
 * that navigates only through this source): `push` / `replace` write `history.pushState` /
 * `replaceState` and stamp each entry with its index, and `popstate` (back, forward) is heard.
 * A `pushState` made behind its back is not.
 *
 * @example
 * ```tsx
 * "use client";
 * import { browserHistory, HistoryStack } from "denext/navigation";
 * const history = browserHistory();
 * export function App() {
 *   return <HistoryStack history={history} screens={[…]} />;
 * }
 * ```
 */
export function browserHistory(): HistorySource {
  const set = listenerSet(
    () => globalThis.addEventListener?.("popstate", onPop),
    () => globalThis.removeEventListener?.("popstate", onPop),
  );
  function onPop(): void {
    set.notify();
  }
  const ensureStamped = (): number => {
    const index = stampedIndex();
    if (index !== undefined || !globalThis.history) return index ?? 0;
    const state = (history.state ?? {}) as Record<string, unknown>;
    history.replaceState({ ...state, [INDEX_KEY]: 0 }, "", location.href);
    return 0;
  };
  const write = (kind: "push" | "replace", href: string) => {
    const current = ensureStamped();
    const index = kind === "push" ? current + 1 : current;
    if (kind === "push") history.pushState({ [INDEX_KEY]: index }, "", href);
    else history.replaceState({ [INDEX_KEY]: index }, "", href);
    set.notify();
  };
  return {
    location: () => ({
      pathname: globalThis.location?.pathname ?? "/",
      search: globalThis.location?.search ?? "",
      hash: globalThis.location?.hash ?? "",
      index: globalThis.history ? ensureStamped() : undefined,
    }),
    subscribe: (listener) => set.add(listener),
    push: (href) => write("push", href),
    replace: (href) => write("replace", href),
    go: (delta) => globalThis.history?.go(delta),
  };
}

/** The slice of `@tanstack/history`'s `RouterHistory` {@linkcode tanstackHistory} uses. */
export interface TanStackHistoryLike {
  readonly location: {
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    readonly state?: unknown;
  };
  subscribe(listener: (...args: never[]) => void): () => void;
  push(path: string, state?: unknown): void;
  replace(path: string, state?: unknown): void;
  go(delta: number): void;
}

/** The slice of a TanStack Router {@linkcode tanstackHistory} uses. */
export interface TanStackRouterLike {
  readonly history: TanStackHistoryLike;
  navigate(options: { href: string; replace?: boolean }): unknown;
}

/** Whether `value` is a router (it has a `history` and `navigate`), not a bare history. */
function isTanStackRouter(value: unknown): value is TanStackRouterLike {
  const v = value as Partial<TanStackRouterLike> | null;
  return typeof v?.navigate === "function" && typeof v.history === "object" && v.history !== null;
}

/**
 * A TanStack Router (or its `router.history`) as a {@linkcode HistorySource}. With the router,
 * navigations go through `router.navigate({ href })` (so loaders, blockers and view
 * transitions run as for a `<Link>`); with a bare history, through `history.push`. The entry
 * index comes from TanStack's `__TSR_index`, so back and forward are exact.
 *
 * @param routerOrHistory The app's router (`createRouter(…)`), or `router.history`.
 * @example
 * ```tsx
 * "use client";
 * import { HistoryStack, tanstackHistory } from "denext/navigation";
 * import { router } from "./router.ts";
 * const history = tanstackHistory(router);
 * export function PhoneLayout() {
 *   return <HistoryStack history={history} screens={screens} />;
 * }
 * ```
 */
export function tanstackHistory(
  routerOrHistory: TanStackRouterLike | TanStackHistoryLike,
): HistorySource {
  const router = isTanStackRouter(routerOrHistory) ? routerOrHistory : null;
  const hist = router ? router.history : routerOrHistory as TanStackHistoryLike;
  const nav = (href: string, replace: boolean) => {
    if (router) void router.navigate({ href, replace });
    else if (replace) hist.replace(href);
    else hist.push(href);
  };
  return {
    location: () => {
      const loc = hist.location;
      const state = loc.state as { __TSR_index?: unknown } | null | undefined;
      const index = typeof state?.__TSR_index === "number" ? state.__TSR_index : undefined;
      return { pathname: loc.pathname, search: loc.search, hash: loc.hash, index };
    },
    subscribe: (listener) => hist.subscribe(() => listener()),
    push: (href) => nav(href, false),
    replace: (href) => nav(href, true),
    go: (delta) => hist.go(delta),
  };
}

/** The slice of a React Router data router (`createBrowserRouter`) {@linkcode reactRouterHistory} uses. */
export interface ReactRouterLike {
  readonly state: {
    readonly location: {
      readonly pathname: string;
      readonly search: string;
      readonly hash: string;
    };
  };
  subscribe(listener: (...args: never[]) => void): () => void;
  navigate(to: string | number, options?: { replace?: boolean }): unknown;
}

/**
 * A React Router data router (`createBrowserRouter` / `createHashRouter` /
 * `createMemoryRouter`, library mode) as a {@linkcode HistorySource}: the location from
 * `router.state`, changes from `router.subscribe`, navigations through `router.navigate`. The
 * entry index is the browser router's `history.state.idx` where it exists.
 *
 * @param router The data router.
 */
export function reactRouterHistory(router: ReactRouterLike): HistorySource {
  return {
    location: () => {
      const { pathname, search, hash } = router.state.location;
      const idx = (globalThis.history?.state as { idx?: unknown } | null | undefined)?.idx;
      return { pathname, search, hash, index: typeof idx === "number" ? idx : undefined };
    },
    subscribe: (listener) => router.subscribe(() => listener()),
    push: (href) => void router.navigate(href),
    replace: (href) => void router.navigate(href, { replace: true }),
    go: (delta) => void router.navigate(delta),
  };
}

/**
 * Match `pathname` against a screen pattern: literal segments, `:name` or `$name` params
 * (TanStack Router's spelling too), and a trailing `*` or `$` splat (its value under `"*"` and
 * `"_splat"`). Returns the decoded params, or `null` when it does not match.
 *
 * @example
 * ```ts
 * matchScreenPath("/threads/$threadId", "/threads/42"); // { threadId: "42" }
 * matchScreenPath("/files/*", "/files/a/b.ts"); // { "*": "a/b.ts", _splat: "a/b.ts" }
 * ```
 */
export function matchScreenPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const seg = want[i];
    if ((seg === "*" || seg === "$") && i === want.length - 1) {
      const rest = have.slice(i).map(decodeSegment).join("/");
      params["*"] = rest;
      params._splat = rest;
      return params;
    }
    if (i >= have.length) return null;
    const name = /^[:$](.+)$/.exec(seg)?.[1];
    if (name) params[name] = decodeSegment(have[i]);
    else if (seg !== have[i]) return null;
  }
  return want.length === have.length ? params : null;
}

/** A path segment decoded (left as is when it is not valid percent-encoding). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
