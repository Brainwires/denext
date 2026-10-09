/**
 * `<HistoryStack>`: the stack bound to any history-based router — TanStack Router, a React
 * Router data router, or the browser's own history — through a {@linkcode HistorySource}.
 * Where {@linkcode StackLayout} takes the App Router's route content, this binding takes a
 * table of screens: each location under `base` matches one, and each screen renders from
 * its OWN location (its {@linkcode ScreenMatch}), so the screens kept below the top go on
 * showing what they showed even though the router has moved on:
 *
 * - **A push keeps the screen below** mounted but hidden (`<Activity>`), with its state and
 *   scroll position, and the platform animation plays (iOS push, Material shared axis).
 * - **The history is the stack.** A navigation pushes; a back (the header's button, the
 *   swipe, Android's back, the browser's back button) pops to the entry it lands on; a
 *   forward pushes again; a replace swaps the top. With a source that knows each entry's
 *   index (all three built-in ones do) this is exact.
 * - **Swipe back from anywhere** on the screen by default (`fullScreenSwipe`), under a strict
 *   axis lock so vertical scrolling keeps the touch; the left-edge swipe with
 *   `fullScreenSwipe={false}`.
 * - **Per-screen options** (`title`, `presentation: "formSheet"`, header, gesture, …) from
 *   the screen table, and `useStackNavigation().setOptions()` from inside a screen.
 * - **Deep links** stack the screens of the path's ancestors underneath (the ones the table
 *   matches, mounted and hidden), so back and the swipe work at once; popping to one of them
 *   replaces the history entry (it has none of its own).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useContext, useEffect, useLayoutEffect, useRef } from "../runtime/hooks.ts";
import { createContext } from "../runtime/context.ts";
import type { Context } from "../runtime/hooks.ts";
import { detectPlatform } from "./animation.ts";
import { navigationContexts, type StackNavigatorApi } from "./context.ts";
import { plainLinkHref, stackNavigator, useStackInTab, useStackOwner } from "./stack-owner.ts";
import {
  ancestorHrefs,
  applyRoute,
  indexBelowTop,
  initialStack,
  normalizeBase,
  popToIndex,
  type RouteContent,
  type RouteIntent,
  routeKey,
  type StackModel,
  underBase,
} from "./stack-model.ts";
import { StackView, type StackViewAnimate, type StackViewHandle } from "./stack-view.ts";
import { type HistoryLocation, type HistorySource, matchScreenPath } from "./history-source.ts";
import type { NavigationThemeProps } from "./theme.ts";
import type { NavigationPlatform, ScreenOptions, StackViewEntry } from "./types.ts";

/** What a screen renders from: the location it was pushed at, matched against its path. */
export interface ScreenMatch {
  /** The screen's path pattern (from the table). */
  readonly path: string;
  /** The location's path. */
  readonly pathname: string;
  /** The location's query string (with its `?`, or `""`). */
  readonly search: string;
  /** The location's fragment (with its `#`, or `""`). */
  readonly hash: string;
  /** `pathname + search + hash`. */
  readonly href: string;
  /** The path's params (`$threadId` / `:threadId` → `threadId`; a splat under `"*"`). */
  readonly params: Readonly<Record<string, string>>;
}

/** One screen of a {@linkcode HistoryStack}'s table. */
export interface HistoryScreen {
  /**
   * The path it shows at: literal segments, `:name` or `$name` params, a trailing `*` / `$`
   * splat ({@linkcode matchScreenPath}). The first screen that matches a location wins.
   */
  readonly path: string;
  /** Render the screen for its own location. */
  readonly render: (match: ScreenMatch) => VNodeChildren;
  /** Its options (title, presentation, header, gesture, …), or a function of its location. */
  readonly options?: ScreenOptions | ((match: ScreenMatch) => ScreenOptions);
}

/**
 * Props of {@linkcode HistoryStack}. `theme`, `material` and `accentColor` pick the look; see
 * {@linkcode NavigationThemeProps}.
 */
export interface HistoryStackProps extends NavigationThemeProps {
  /** The router's history ({@linkcode tanstackHistory}, {@linkcode browserHistory}, …). */
  readonly history: HistorySource;
  /** The screens, matched in order. */
  readonly screens: readonly HistoryScreen[];
  /** The stack's root path (default `/`); locations outside it leave the stack as it is. */
  readonly base?: string;
  /** How many screens stay mounted; deeper ones are unloaded until popped back to (default `10`). */
  readonly maxDepth?: number;
  /** Options every screen starts from. */
  readonly screenOptions?: ScreenOptions;
  /**
   * The screens stacked under a deep-linked location: `"segments"` (default) every path from
   * `base` down that a screen matches, `"root"` just `base`, `false` none, or a function
   * returning the hrefs.
   */
  readonly ancestors?: "segments" | "root" | false | ((pathname: string, base: string) => string[]);
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /**
   * The key that makes two locations "the same screen" (default: the pathname, so a search
   * change updates the screen in place).
   */
  readonly getKey?: (href: string) => string;
  /** Whether the back swipe pops (default: `true` on the iOS look). */
  readonly swipeBack?: boolean;
  /**
   * Whether the back swipe may start anywhere on the screen (default `true`); `false` keeps it
   * to the left edge. A screen's `fullScreenGestureEnabled` option overrides it.
   */
  readonly fullScreenSwipe?: boolean;
  /** A light haptic when the swipe commits (default `false`). */
  readonly swipeHaptic?: boolean;
  /** Announce the new top screen's title to screen readers (default `true`). */
  readonly announceRouteChanges?: boolean;
  /** Extra style for the container (its height defaults to `100dvh`). */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
}

let matchContext: Context<ScreenMatch | null> | null = null;

/** The screen-match context (created on first use). */
function screenMatchContext(): Context<ScreenMatch | null> {
  return matchContext ??= createContext<ScreenMatch | null>(null);
}

/**
 * The location the screen this component renders in was pushed at (its path params, search
 * and hash), or `null` outside a {@linkcode HistoryStack}. Read this in a screen rather than
 * the router's own location hooks: a kept screen below the top keeps its own location, while
 * the router's hooks follow the top screen.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useScreenMatch } from "denext/navigation";
 * export function Thread() {
 *   const id = useScreenMatch()?.params.threadId;
 *   return <h1>Thread {id}</h1>;
 * }
 * ```
 */
export function useScreenMatch(): ScreenMatch | null {
  return useContext(screenMatchContext());
}

/** The first screen of `screens` that matches `loc`, with its match. */
export function resolveScreen(
  screens: readonly HistoryScreen[],
  loc: Pick<HistoryLocation, "pathname" | "search" | "hash">,
): { screen: HistoryScreen; match: ScreenMatch } | null {
  for (const screen of screens) {
    const params = matchScreenPath(screen.path, loc.pathname);
    if (!params) continue;
    const href = loc.pathname + loc.search + loc.hash;
    return {
      screen,
      match: {
        path: screen.path,
        pathname: loc.pathname,
        search: loc.search,
        hash: loc.hash,
        href,
        params,
      },
    };
  }
  return null;
}

/** An href split into pathname, search and hash. */
function splitHref(href: string): { pathname: string; search: string; hash: string } {
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const rest = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const queryAt = rest.indexOf("?");
  return {
    pathname: (queryAt >= 0 ? rest.slice(0, queryAt) : rest) || "/",
    search: queryAt >= 0 ? rest.slice(queryAt) : "",
    hash,
  };
}

/** The binding's state that lives across renders outside React state. */
interface HistoryRt {
  props: HistoryStackProps;
  base: string;
  getKey: (href: string) => string;
  /** The stack of the last commit (entries carry their {@linkcode ScreenMatch} as `element`). */
  model: StackModel | null;
  /** The location the last commit took (`href` + history index). */
  seen: { href: string; index: number | undefined } | null;
  /** The history index each screen was shown at (seeded deep-link ancestors have none). */
  readonly indexOf: Map<string, number>;
  /** A push / replace from the navigator, for the route it navigates to. */
  intent: { key: string; kind: RouteIntent } | null;
  /** A pop through a history replace (to a seeded ancestor): the key and index it pops to. */
  replacePop: { key: string; index: number } | null;
  /** A pop through `go(-n)` that must not animate again (a gesture already did). */
  popHow: { animated: boolean } | null;
  handle: StackViewHandle | null;
  force: () => void;
  setOverrides: (
    fn: (prev: ReadonlyMap<string, ScreenOptions>) => ReadonlyMap<string, ScreenOptions>,
  ) => void;
}

/** The deep-link ancestors of `href` a screen matches (see {@linkcode HistoryStackProps.ancestors}). */
function deepLinkAncestors(rt: HistoryRt, href: string): string[] {
  const mode = rt.props.ancestors ?? "segments";
  const path = routeKey(href);
  let hrefs: string[];
  if (typeof mode === "function") hrefs = mode(path, rt.base);
  else if (mode === false) hrefs = [];
  else if (mode === "root") hrefs = path === rt.base || !underBase(path, rt.base) ? [] : [rt.base];
  else hrefs = ancestorHrefs(path, rt.base);
  return hrefs.filter((a) => resolveScreen(rt.props.screens, splitHref(a)) !== null);
}

/**
 * A deep link's ancestors render from their own locations (a screen table needs no router to
 * load them), so they are mounted hidden underneath and the back swipe reveals them at once.
 */
function withAncestorsLoaded(rt: HistoryRt, model: StackModel): StackModel {
  const entries = model.entries.map((e) => {
    if (e.element !== undefined) return e;
    const match = resolveScreen(rt.props.screens, splitHref(e.href))?.match;
    return match ? { ...e, element: match as never } : e;
  });
  return { ...model, entries };
}

/** What a location change does when the source knows both entries' indices. */
function indexedChange(
  rt: HistoryRt,
  model: StackModel,
  route: RouteContent,
  delta: number,
): StackModel {
  if (delta === 0) return applyRoute(model, route, "replace", rt.props.maxDepth ?? 10).model;
  if (delta < 0) {
    // A back lands on the screen that many below the top, when it is that route.
    const target = model.entries.length - 1 + delta;
    if (target >= 0 && model.entries[target].key === route.key) {
      model = popToIndex(model, target);
    }
  }
  return applyRoute(model, route, "auto", rt.props.maxDepth ?? 10).model;
}

/** The stack popped to a replace-pop's target, when `route` is the one it navigated to. */
function replacePopped(rt: HistoryRt, model: StackModel, route: RouteContent): StackModel | null {
  const rp = rt.replacePop;
  if (rp?.key !== route.key || rp.index >= model.entries.length - 1) return null;
  return popToIndex(model, rp.index);
}

/** What a change to `route` does to `model`: the navigator's intent, a replace-pop, or history. */
function changeStack(
  rt: HistoryRt,
  model: StackModel,
  loc: HistoryLocation,
  route: RouteContent,
): StackModel {
  const maxDepth = rt.props.maxDepth ?? 10;
  if (rt.intent?.key === route.key) return applyRoute(model, route, rt.intent.kind, maxDepth).model;
  const popped = replacePopped(rt, model, route);
  if (popped) return applyRoute(popped, route, "auto", maxDepth).model;
  const from = rt.seen?.index;
  if (from !== undefined && loc.index !== undefined) {
    return indexedChange(rt, model, route, loc.index - from);
  }
  return applyRoute(model, route, "auto", maxDepth).model;
}

/** This render's stack for `loc` (pure: the runtime only moves in the commit). */
function planStack(
  rt: HistoryRt,
  loc: HistoryLocation,
  route: RouteContent | null,
): StackModel | null {
  const model = rt.model;
  if (!route) return model;
  if (!model) {
    return withAncestorsLoaded(rt, initialStack(route, deepLinkAncestors(rt, route.href)));
  }
  const seen = rt.seen;
  if (seen && seen.href === route.href && seen.index === loc.index) return model;
  return changeStack(rt, model, loc, route);
}

/** Record the top screen's history index, and forget the screens no longer in the stack. */
function recordIndex(rt: HistoryRt, model: StackModel, index: number | undefined): void {
  const top = model.entries[model.entries.length - 1];
  if (index !== undefined) rt.indexOf.set(top.id, index);
  const live = new Set(model.entries.map((e) => e.id));
  for (const id of rt.indexOf.keys()) if (!live.has(id)) rt.indexOf.delete(id);
}

/** The commit: remember the stack and where each screen sits in the history. */
function commitStack(
  rt: HistoryRt,
  model: StackModel | null,
  loc: HistoryLocation,
  route: RouteContent | null,
): void {
  if (!model || !route) return;
  const changed = model !== rt.model;
  rt.model = model;
  rt.seen = { href: route.href, index: loc.index };
  recordIndex(rt, model, loc.index);
  if (rt.intent?.key === route.key) rt.intent = null;
  if (rt.replacePop?.key === route.key) rt.replacePop = null;
  if (changed) rt.popHow = null;
}

/** Pop so the screen at `index` is on top: back through history, or a replace to a seeded one. */
function popTo(rt: HistoryRt, index: number, animated: boolean): void {
  const m = rt.model;
  if (!m || index < 0 || index >= m.entries.length - 1) return;
  rt.popHow = { animated };
  const target = m.entries[index];
  const to = rt.indexOf.get(target.id);
  if (to === undefined && rt.seen?.index !== undefined) {
    // A deep link's ancestor has no history entry of its own: replace the top with it.
    rt.replacePop = { key: target.key, index };
    return rt.props.history.replace(target.href);
  }
  rt.props.history.go(historyDelta(rt, m, index, to));
}

/** How far back the history goes to reach screen `index` (by entry index when both are known). */
function historyDelta(rt: HistoryRt, m: StackModel, index: number, to: number | undefined): number {
  const from = rt.indexOf.get(m.entries[m.entries.length - 1].id);
  if (to !== undefined && from !== undefined && to < from) return to - from;
  return -(m.entries.length - 1 - index);
}

/** How the view animates this render's change: a gesture-driven pop must not animate again. */
function animateMode(rt: HistoryRt, next: StackModel | null): StackViewAnimate {
  const prev = rt.model;
  if (!rt.popHow || !prev || !next || next === prev) return "auto";
  return rt.popHow.animated ? "auto" : "none";
}

/** The screens as the view draws them: each rendered from its own location. */
function viewEntries(
  rt: HistoryRt,
  model: StackModel | null,
  overrides: ReadonlyMap<string, ScreenOptions>,
): StackViewEntry[] {
  if (!model) return [];
  const ctx = screenMatchContext();
  return model.entries.map((e) => {
    const resolved = e.element === undefined
      ? null
      : resolveScreen(rt.props.screens, e.element as unknown as ScreenMatch);
    const own = resolved?.screen.options;
    const options = typeof own === "function" ? own(resolved!.match) : own ?? {};
    return {
      id: e.id,
      href: e.href,
      element: resolved
        ? h(ctx, { value: resolved.match }, resolved.screen.render(resolved.match))
        : undefined,
      options: overrides.has(e.id) ? { ...options, ...overrides.get(e.id) } : options,
    };
  });
}

/** The navigator the screens get through context (`useStackNavigation`). */
function createNavigator(rt: HistoryRt): StackNavigatorApi {
  return stackNavigator({
    go: (href, kind) => {
      rt.intent = { key: rt.getKey(href), kind };
      if (kind === "replace") rt.props.history.replace(href);
      else rt.props.history.push(href);
    },
    popTo: (index) => popTo(rt, index, true),
    depth: () => rt.model?.entries.length ?? 1,
    setOverrides: () => rt.setOverrides,
  });
}

/** An app-relative href for an anchor, or `""` for another origin. */
function anchorHref(anchor: HTMLAnchorElement): string {
  try {
    const u = new URL(anchor.href, globalThis.location?.href);
    return u.origin === globalThis.location?.origin ? u.pathname + u.search + u.hash : "";
  } catch {
    return "";
  }
}

/**
 * A click on a link to a screen below: pop back to it through history instead of pushing a
 * copy. Runs in the capture phase, so a router's `<Link>` (which skips a click whose default
 * was prevented) leaves it alone.
 */
function onStackClick(rt: HistoryRt, event: MouseEvent): void {
  const href = plainLinkHref(event, anchorHref);
  const m = rt.model;
  const index = m && href ? indexBelowTop(m, rt.getKey(href)) : -1;
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  popTo(rt, index, true);
}

/** Re-render on every location change; listen for links to screens below. */
function useHistoryListeners(rt: HistoryRt, container: { current: HTMLElement | null }): void {
  const source = rt.props.history;
  useEffect(() => source.subscribe(() => rt.force()), [source]);
  useEffect(() => {
    const root = container.current;
    if (!root || typeof root.addEventListener !== "function") return;
    const onClick = (event: Event) => onStackClick(rt, event as MouseEvent);
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, []);
}

/** A fresh runtime for a mounting stack. */
function createRuntime(props: HistoryStackProps): HistoryRt {
  return {
    props,
    base: "/",
    getKey: routeKey,
    model: null,
    seen: null,
    indexOf: new Map(),
    intent: null,
    replacePop: null,
    popHow: null,
    handle: null,
    force: () => {},
    setOverrides: () => {},
  };
}

/** The route the current location shows, or `null` outside the base / matching no screen. */
function currentRoute(rt: HistoryRt, loc: HistoryLocation): RouteContent | null {
  if (!underBase(routeKey(loc.pathname), rt.base)) return null;
  const resolved = resolveScreen(rt.props.screens, loc);
  if (!resolved) return null;
  const href = resolved.match.href;
  return { key: rt.getKey(href), href, element: resolved.match as never, options: {} };
}

/**
 * A native-feeling stack over any history-based router; see the module docs. Mount it where
 * the router would render the routes it covers (in a TanStack Router layout route, in place of
 * its `<Outlet />`), and give it the screens; the router keeps owning the URL.
 *
 * @example
 * ```tsx
 * "use client";
 * import { HistoryStack, tanstackHistory, useScreenMatch } from "denext/navigation";
 * import { router } from "./router.ts";
 *
 * const history = tanstackHistory(router);
 * const screens = [
 *   { path: "/", render: () => <ThreadList />, options: { title: "Threads" } },
 *   { path: "/$threadId", render: (m) => <Thread id={m.params.threadId} /> },
 *   {
 *     path: "/$threadId/diff",
 *     render: (m) => <Diff id={m.params.threadId} />,
 *     options: { presentation: "formSheet", sheetAllowedDetents: ["medium", "large"] },
 *   },
 * ];
 *
 * export function PhoneShell() {
 *   return <HistoryStack history={history} screens={screens} />;
 * }
 * ```
 */
export function HistoryStack(props: HistoryStackProps): VNode {
  const ctx = navigationContexts();
  const { tab, force, overrides, setOverrides } = useStackOwner();
  const ref = useRef<HistoryRt | null>(null);
  const rt = ref.current ??= createRuntime(props);
  const container = useRef<HTMLElement | null>(null);
  Object.assign(rt, {
    props,
    base: normalizeBase(props.base),
    getKey: props.getKey ?? routeKey,
    force,
    setOverrides,
  });
  const navRef = useRef<StackNavigatorApi | null>(null);
  navRef.current ??= createNavigator(rt);

  const loc = props.history.location();
  const route = currentRoute(rt, loc);
  const model = planStack(rt, loc, route);
  const animate = animateMode(rt, model);
  const entries = viewEntries(rt, model, overrides);
  const platform = props.platform ?? detectPlatform();

  useLayoutEffect(() => commitStack(rt, model, loc, route));
  useHistoryListeners(rt, container);
  useStackInTab(
    tab,
    () => rt.model?.entries.length ?? 1,
    () => popTo(rt, 0, true),
    () => rt.handle?.scrollToTop() ?? false,
  );

  return h(
    ctx.navigator,
    { value: navRef.current },
    h(StackView, {
      entries,
      animate,
      platform,
      screenOptions: props.screenOptions,
      swipeBack: props.swipeBack,
      fullScreenSwipe: props.fullScreenSwipe ?? true,
      swipeHaptic: props.swipeHaptic,
      announceRouteChanges: props.announceRouteChanges,
      theme: props.theme,
      material: props.material,
      accentColor: props.accentColor,
      style: props.style,
      className: props.className,
      onPop: (index: number, how: { animated: boolean }) => popTo(rt, index, how.animated),
      onHandle: (hd: StackViewHandle | null) => void (rt.handle = hd),
      containerRef: (el: HTMLElement | null) => void (container.current = el),
    }),
  );
}
