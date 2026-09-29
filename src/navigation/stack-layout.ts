/**
 * `<StackLayout>`: the App Router binding of the stack. Used in a segment's layout, it turns
 * the routes under it into a native-feeling stack whose screens are the router's pages:
 *
 * - **A push keeps the screen below.** Each route's content becomes a screen; navigating
 *   deeper pushes one and keeps the previous screens mounted but hidden (`<Activity>`), with
 *   their state and scroll position. Past `maxDepth` the oldest screens are unloaded (their
 *   history entries stay; they load again when popped back to).
 * - **The URL is the stack.** Every history entry is stamped with the stack it shows. Browser
 *   back, `history.back()`, the header's back button, a link to a screen below, the iOS swipe
 *   and Android's back all go through history, and a back to a kept screen is claimed: the
 *   router's popstate handler asks the stack first (`__dnxPop`), the screen shows at once and
 *   the router skips its refetch — only the location hooks (`usePathname()`, …) catch up.
 * - **Transitions.** A push or pop to a screen being loaded runs inside the router's View
 *   Transition with the platform's animation; a claimed pop, or a browser without View
 *   Transitions, animates the kept screens directly (Web Animations).
 * - **Deep links.** Opening `/items/42/comments` directly stacks `/items` and `/items/42`
 *   underneath (as history entries that load when popped back to), so back works.
 * - **Per-route options.** A page's `export const screenOptions = { … }` sets its title,
 *   animation, gesture, presentation (`"card"`, `"modal"`, `"formSheet"`,
 *   `"transparentModal"`) and header; `useStackNavigation().setOptions()` changes them from the
 *   screen.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "../runtime/hooks.ts";
import { LayoutSegmentContext } from "../runtime/layout-segments.ts";
import { getNavigatingHref, navigate, subscribeNavigating } from "../client/navigation.ts";
import { detectPlatform, ensureViewTransitionRules, VT_NAME } from "./animation.ts";
import { navigationContexts, type StackNavigatorApi, type TabScope } from "./context.ts";
import {
  ancestorHrefs,
  applyRoute,
  indexBelowTop,
  initialStack,
  modelFromStamp,
  normalizeBase,
  popToIndex,
  readStamp,
  type RouteContent,
  type RouteIntent,
  routeKey,
  type StackModel,
  type StackModelEntry,
  stampOf,
  underBase,
  withStamp,
} from "./stack-model.ts";
import { StackView, type StackViewAnimate, type StackViewHandle } from "./stack-view.ts";
import { viewTransitionsOn } from "./vt-hold.ts";
import type { NavigationThemeProps } from "./theme.ts";
import type { NavigationPlatform, ScreenOptions, StackViewEntry } from "./types.ts";

/**
 * Props of {@linkcode StackLayout}. `theme` (default `"auto"`: the platform theme inside the
 * native shell), `material` and `accentColor` pick the look; see {@linkcode NavigationThemeProps}.
 */
export interface StackLayoutProps extends NavigationThemeProps {
  /** The layout's `children` (the current route's page). */
  readonly children?: VNodeChildren;
  /**
   * The stack's root path (e.g. `"/items"`). Defaults to the layout's segment when the router
   * provides it, else `/`. Deep-link ancestors are built below it (by default only when the
   * base is known: given here, or the layout's segment).
   */
  readonly base?: string;
  /** How many screens stay mounted; deeper ones are unloaded (default `10`). */
  readonly maxDepth?: number;
  /** Options every screen starts from (a page's `screenOptions` and `setOptions` override). */
  readonly screenOptions?: ScreenOptions;
  /**
   * The screens stacked under a deep-linked route: `"segments"` (default) every path from
   * `base` down, `"root"` just `base`, `false` none, or a function returning the hrefs.
   */
  readonly ancestors?: "segments" | "root" | false | ((pathname: string, base: string) => string[]);
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /**
   * The route key that makes two URLs "the same screen" (default: the pathname, so a search
   * change updates the screen in place instead of pushing).
   */
  readonly getKey?: (href: string) => string;
  /** A light haptic when the iOS swipe commits (default `false`). */
  readonly swipeHaptic?: boolean;
  /** Extra style for the container (its height defaults to `100dvh`, `100%` inside tabs). */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
}

/** The stack navigation a screen gets from {@linkcode useStackNavigation}. */
export interface StackNavigation {
  /** Push `href` as a new screen (even when a screen for it is already below). */
  push(href: string): void;
  /** Replace the top screen with `href` (a history replace). */
  replace(href: string): void;
  /** Pop `count` screens (default `1`) through history. */
  pop(count?: number): void;
  /** Pop to the stack's root screen. */
  popToTop(): void;
  /** Whether there is a screen below this one. */
  readonly canGoBack: boolean;
  /** Merge options into this screen's (title, header slots, gesture, …). */
  setOptions(options: ScreenOptions): void;
  /** This screen's position in its stack (0 = the root). */
  readonly index: number;
}

/** The hydration data fields the stack reads. */
interface StackData {
  basePath?: string;
  screenOptions?: ScreenOptions;
}

/** The request-context bridge the server installs (what `usePathname()` reads on the server). */
type ContextBridge = {
  __denextCurrentRequestContext?: () => { request?: Request; screenOptions?: unknown } | undefined;
};

/** The page's hydration data island, parsed. */
function readData(): StackData {
  try {
    const raw = document.getElementById("__denext_data")?.textContent;
    return raw ? JSON.parse(raw) as StackData : {};
  } catch {
    return {};
  }
}

/** The current route's `screenOptions` (the data island; on the server, the request context). */
function currentScreenOptions(): ScreenOptions {
  if (typeof document === "undefined") {
    const ctx = (globalThis as ContextBridge).__denextCurrentRequestContext?.();
    const so = ctx?.screenOptions;
    return typeof so === "object" && so !== null ? so as ScreenOptions : {};
  }
  const so = readData().screenOptions;
  return typeof so === "object" && so !== null ? so : {};
}

/** The URL being shown: pathname + search (the request's on the server). */
function currentHref(): string {
  if (typeof location === "undefined") {
    const req = (globalThis as ContextBridge).__denextCurrentRequestContext?.()?.request;
    try {
      if (req) {
        const u = new URL(req.url);
        return u.pathname + u.search;
      }
    } catch { /* fall through */ }
    return "/";
  }
  return location.pathname + location.search;
}

/** An href (absolute or relative) as pathname + search against the current page. */
function toHref(href: string): string {
  try {
    const u = new URL(href, location.href);
    return u.origin === location.origin ? u.pathname + u.search : "";
  } catch {
    return "";
  }
}

/** The app's basePath (from the hydration data) as a prefix, `""` without one. */
function basePathPrefix(): string {
  if (typeof document === "undefined") return "";
  return (readData().basePath ?? "").replace(/\/$/, "");
}

/** Put the stack's View Transition attributes on `<html>` (or remove them with `null`). */
function markDocument(anim: string | null, dir?: "push" | "pop"): void {
  const root = document.documentElement;
  if (!root?.setAttribute) return;
  if (anim === null) {
    root.removeAttribute("data-dnx-stack-anim");
    root.removeAttribute("data-dnx-stack-dir");
    return;
  }
  root.setAttribute("data-dnx-stack-anim", anim);
  root.setAttribute("data-dnx-stack-dir", dir ?? "push");
}

/** Name `el` for the View Transition (or clear it with `null`). */
function nameScreen(el: HTMLElement | null | undefined, name: string | null): void {
  if (el?.style) el.style.setProperty?.("view-transition-name", name ?? "");
}

/** A value `children` never is, so the first render always takes the route. */
const NONE: unique symbol = Symbol("none");

/** The layout's state that lives across renders outside React state. */
interface LayoutRt {
  props: StackLayoutProps;
  base: string;
  platform: NavigationPlatform;
  getKey: (href: string) => string;
  /** The stack of the last commit. */
  model: StackModel | null;
  /** The `children` the last commit took. */
  children: unknown;
  /** A `push` / `replace` from `useStackNavigation`, for the route it navigates to. */
  intent: { key: string; kind: RouteIntent } | null;
  /** A back to a kept screen, claimed from the router's popstate, for the next render. */
  claim: { index: number; animated: boolean } | null;
  /** Whether the next history pop animates (a gesture already did). */
  popHow: { animated: boolean } | null;
  /** A View Transition the router is running for a push or pop. */
  vt: { kind: "push" | "pop"; fromId: string } | null;
  vtCleanup: ReturnType<typeof setTimeout> | null;
  handle: StackViewHandle | null;
  container: HTMLElement | null;
  /** The stack shape last stamped into history. */
  stamped: string;
  overrides: ReadonlyMap<string, ScreenOptions>;
  force: () => void;
  setOverrides: (
    fn: (prev: ReadonlyMap<string, ScreenOptions>) => ReadonlyMap<string, ScreenOptions>,
  ) => void;
}

/** The stack's base path, and whether it is known (given, or the layout's segment). */
function layoutBase(
  props: StackLayoutProps,
  segment: { pathname: string; depth: number },
): { base: string; known: boolean } {
  const prefix = basePathPrefix();
  const segmentBase = segment.depth > 0
    ? "/" + segment.pathname.split("/").filter(Boolean).slice(0, segment.depth).join("/")
    : "/";
  const appBase = normalizeBase(props.base ?? segmentBase);
  const base = prefix ? normalizeBase(prefix + (appBase === "/" ? "" : appBase)) : appBase;
  return { base, known: props.base !== undefined || segment.depth > 0 };
}

/** The deep-link ancestors of `href` (see {@linkcode StackLayoutProps.ancestors}). */
function initialAncestors(
  props: StackLayoutProps,
  href: string,
  base: string,
  known: boolean,
): string[] {
  const mode = props.ancestors;
  if (typeof mode === "function") return mode(href, base);
  // Without a known base only an explicit `ancestors` applies.
  if (mode === false || (mode === undefined && !known)) return [];
  if (mode !== "root") return ancestorHrefs(href, base);
  const path = routeKey(href);
  return path === base || !underBase(path, base) ? [] : [base];
}

/** This render's stack (pure: the runtime only moves in the commit). */
function planModel(
  rt: LayoutRt,
  route: RouteContent,
  known: boolean,
): { model: StackModel; changed: boolean } {
  let model = rt.model;
  let changed = false;
  if (!model) {
    model = initialStack(route, initialAncestors(rt.props, route.href, rt.base, known));
  } else if (route.element !== rt.children) {
    const intent = rt.intent?.key === route.key ? rt.intent.kind : "auto";
    model = applyRoute(model, route, intent, rt.props.maxDepth ?? 10).model;
    changed = true;
  }
  const claim = rt.claim;
  if (claim && claim.index < model.entries.length - 1) model = popToIndex(model, claim.index);
  return { model, changed };
}

/** How the view animates this render's change. */
function animateMode(rt: LayoutRt): StackViewAnimate {
  if (rt.claim) return rt.claim.animated ? "auto" : "none";
  return rt.vt && viewTransitionsOn() ? "external" : "auto";
}

/** The top screen with the page's title and hydration data, for an instant pop back. */
function snapshotTop(m: StackModel): StackModel {
  const top = m.entries[m.entries.length - 1];
  const data = document.getElementById("__denext_data")?.textContent ?? undefined;
  const snap: StackModelEntry = { ...top, title: document.title, data };
  return { ...m, entries: [...m.entries.slice(0, -1), snap] };
}

/** Put a deep link's ancestors into history under the current entry, stamped. */
function seedAncestors(rt: LayoutRt, m: StackModel): void {
  try {
    const final = location.href;
    const at = (i: number) => stampOf({ entries: m.entries.slice(0, i + 1), seq: m.seq }, rt.base);
    history.replaceState(withStamp(history.state, at(0)), "", m.entries[0].href);
    for (let i = 1; i < m.entries.length - 1; i++) {
      history.pushState(withStamp(null, at(i)), "", m.entries[i].href);
    }
    history.pushState(withStamp(null, at(m.entries.length - 1)), "", final);
  } catch { /* history unavailable: back simply leaves the stack */ }
}

/**
 * The first commit: rebuild the stack from this history entry's stamp (a reload keeps its
 * screens below, to load when popped back to), or put a deep link's ancestors into history
 * underneath the current entry so back works. Returns the stack to keep.
 */
function firstCommit(rt: LayoutRt, m: StackModel): StackModel {
  if (typeof history === "undefined") return m;
  const top = m.entries[m.entries.length - 1];
  const stamp = readStamp(history.state, rt.base);
  if (stamp && stamp.entries[stamp.index]?.key === top.key) {
    rt.force();
    return modelFromStamp(stamp, top, m.seq);
  }
  if (m.entries.length > 1) seedAncestors(rt, m);
  return m;
}

/** Stamp the entry we show so a reload, or a back from elsewhere, rebuilds this stack. */
function stampHistory(rt: LayoutRt, next: StackModel): void {
  const top = next.entries[next.entries.length - 1];
  const shape = next.entries.map((e) => e.id).join(",");
  if (shape === rt.stamped || typeof history === "undefined") return;
  if (rt.getKey(currentHref()) !== top.key) return;
  rt.stamped = shape;
  try {
    history.replaceState(withStamp(history.state, stampOf(next, rt.base)), "", location.href);
  } catch { /* history unavailable (sandboxed frame): the stack still works in memory */ }
}

/** Clear the View Transition names and `<html>` attributes after `ms`. */
function scheduleVtCleanup(
  rt: LayoutRt,
  a: HTMLElement | null | undefined,
  b: HTMLElement | null | undefined,
  ms: number,
): void {
  if (rt.vtCleanup) clearTimeout(rt.vtCleanup);
  rt.vtCleanup = setTimeout(() => {
    rt.vtCleanup = null;
    nameScreen(a, null);
    nameScreen(b, null);
    markDocument(null);
  }, ms);
}

/** A View Transition the router runs for this change: name the new top, set the look. */
function commitViewTransition(rt: LayoutRt, prev: StackModel | null, next: StackModel): void {
  const vt = rt.vt;
  if (!vt) return;
  rt.vt = null;
  const top = next.entries[next.entries.length - 1];
  const fromEl = rt.handle?.section(vt.fromId);
  if (top.id === vt.fromId || !prev) return nameScreen(fromEl, null);
  const driver = vt.kind === "push" ? top : prev.entries.find((e) => e.id === vt.fromId);
  const opts = {
    ...rt.props.screenOptions,
    ...driver?.options,
    ...rt.overrides.get(driver?.id ?? ""),
  };
  // A sheet slides itself; the screen below stays put.
  if (opts.presentation === "formSheet") return scheduleVtCleanup(rt, fromEl, null, 400);
  nameScreen(fromEl, null);
  const toEl = rt.handle?.section(top.id);
  nameScreen(toEl, VT_NAME);
  markDocument(
    ensureViewTransitionRules(opts.animation, rt.platform, opts.animationDuration),
    vt.kind,
  );
  scheduleVtCleanup(rt, toEl, fromEl, (opts.animationDuration ?? 350) + 150);
}

/** The commit: remember the stack, snapshot fresh content, stamp history, run the transition. */
function commitLayout(
  rt: LayoutRt,
  model: StackModel,
  changed: boolean,
  key: string,
  children: unknown,
): void {
  const prev = rt.model;
  let next = changed || prev === null ? snapshotTop(model) : model;
  if (prev === null) next = firstCommit(rt, next);
  rt.model = next;
  rt.children = children;
  if (changed && rt.intent?.key === key) rt.intent = null;
  rt.claim = null;
  stampHistory(rt, next);
  commitViewTransition(rt, prev, next);
}

/** The screen a popstate goes back to, when the stack still holds it (else -1). */
function claimIndex(rt: LayoutRt, m: StackModel, state: unknown, key: string): number {
  const stamp = readStamp(state, rt.base);
  if (stamp && stamp.index < m.entries.length - 1 && m.entries[stamp.index]?.key === key) {
    return stamp.index;
  }
  return indexBelowTop(m, key);
}

/**
 * A back to a kept screen: claim it (show it now) and tell the router so, which then skips
 * its refetch. False when the stack does not hold the target (the router loads it).
 */
function claimBack(rt: LayoutRt, event: Event): boolean {
  const m = rt.model;
  if (!m || typeof location === "undefined") return false;
  const target = currentHref();
  if (!underBase(routeKey(target), rt.base)) return false;
  const index = claimIndex(rt, m, (event as PopStateEvent).state, rt.getKey(target));
  const entry = index >= 0 ? m.entries[index] : undefined;
  if (!entry || entry.element === undefined) return false; // not kept: the router loads it
  const how = rt.popHow;
  rt.popHow = null;
  const uaAnimated = (event as { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
  rt.claim = { index, animated: (how?.animated ?? true) && !uaAnimated };
  if (entry.title !== undefined) document.title = entry.title;
  const island = document.getElementById("__denext_data");
  if (island && entry.data !== undefined) island.textContent = entry.data;
  rt.force();
  return true;
}

/** Every mounted stack's pop claim; the router's popstate asks them in mount order. */
const popClaims = new Set<(event: Event) => boolean>();

/** The router's `__dnxPop` hook: true when a stack showed the popped-to screen itself. */
function claimPop(_href: string, event: Event): boolean {
  for (const claim of popClaims) if (claim(event)) return true;
  return false;
}

/** What a navigation to `target` does to the stack: a push, a pop, or nothing to animate. */
function classifyNav(rt: LayoutRt, m: StackModel, target: string): "push" | "pop" | null {
  const k = rt.getKey(target);
  if (rt.intent?.key === k) return "push";
  const top = m.entries[m.entries.length - 1];
  if (k === top.key) return null;
  return indexBelowTop(m, k) >= 0 ? "pop" : "push";
}

/** A navigation starts (or settles): for a View Transition, name the outgoing screen. */
function onNavigating(rt: LayoutRt): void {
  const nav = getNavigatingHref();
  if (nav === null) return;
  const target = toHref(nav);
  const m = rt.model;
  if (!m || !target || !viewTransitionsOn() || !underBase(routeKey(target), rt.base)) return;
  const kind = classifyNav(rt, m, target);
  if (!kind) return;
  const top = m.entries[m.entries.length - 1];
  rt.vt = { kind, fromId: top.id };
  if (rt.vtCleanup) clearTimeout(rt.vtCleanup);
  markDocument(null);
  nameScreen(rt.handle?.section(top.id), VT_NAME);
}

/** Pop through history so `index` is the top. */
function popTo(rt: LayoutRt, index: number, animated: boolean): void {
  const m = rt.model;
  if (!m) return;
  const n = m.entries.length - 1 - index;
  if (n <= 0 || index < 0) return;
  rt.popHow = { animated };
  history.go(-n);
}

/** A click on a link to a screen below: go back to it through history instead of pushing. */
function onStackClick(rt: LayoutRt, event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor || anchor.hasAttribute("download")) return;
  const tgt = anchor.getAttribute("target");
  if (tgt && tgt !== "_self") return;
  const m = rt.model;
  const target = toHref((anchor as HTMLAnchorElement).href);
  const index = m && target ? indexBelowTop(m, rt.getKey(target)) : -1;
  if (index < 0) return;
  event.preventDefault();
  popTo(rt, index, true);
}

/** The navigator the screens get through context (stable). */
function createApi(rt: LayoutRt): StackNavigatorApi {
  const go = (target: string, kind: RouteIntent) => {
    rt.intent = { key: rt.getKey(toHref(target) || target), kind };
    void navigate(target, kind === "replace" ? { replace: true } : {});
  };
  return {
    push: (target) => go(target, "push"),
    replace: (target) => go(target, "replace"),
    popTo: (index) => popTo(rt, index, true),
    depth: () => rt.model?.entries.length ?? 1,
    setOptions(id, options) {
      rt.setOverrides((prev) => new Map(prev).set(id, { ...prev.get(id), ...options }));
    },
  };
}

/** The router/container hooks: claimed backs, navigation starts, links to screens below. */
function useLayoutListeners(rt: LayoutRt): void {
  useEffect(() => {
    const claim = (event: Event) => claimBack(rt, event);
    popClaims.add(claim);
    (globalThis as { __dnxPop?: typeof claimPop }).__dnxPop = claimPop;
    return () => void popClaims.delete(claim);
  }, []);
  useEffect(() => subscribeNavigating(() => onNavigating(rt)), [rt.base]);
  useEffect(() => {
    const root = rt.container;
    if (!root || typeof root.addEventListener !== "function") return;
    const onClick = (event: Event) => onStackClick(rt, event as MouseEvent);
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);
  // Tidy the document on unmount.
  useEffect(() => () => {
    if (rt.vtCleanup) clearTimeout(rt.vtCleanup);
    if (typeof document !== "undefined") markDocument(null);
  }, []);
}

/** Inside a tab: re-tapping the tab pops to the root, then scrolls to the top. */
function useTabRegistration(rt: LayoutRt, tab: TabScope | null): void {
  useEffect(() => {
    if (!tab) return;
    return tab.register({
      canGoBack: () => (rt.model?.entries.length ?? 1) > 1,
      popToTop: () => popTo(rt, 0, true),
      scrollToTop: () => rt.handle?.scrollToTop() ?? false,
    });
  }, [tab]);
}

/** A fresh runtime for a mounting layout. */
function createLayoutRuntime(props: StackLayoutProps): LayoutRt {
  return {
    props,
    base: "/",
    platform: "ios",
    getKey: routeKey,
    model: null,
    children: NONE,
    intent: null,
    claim: null,
    popHow: null,
    vt: null,
    vtCleanup: null,
    handle: null,
    container: null,
    stamped: "",
    overrides: new Map(),
    force: () => {},
    setOverrides: () => {},
  };
}

/**
 * A native-feeling stack of the routes under a layout; see the module docs.
 *
 * Render it from a `"use client"` component your layout uses (framework components are not
 * client references on their own):
 *
 * @example
 * ```tsx
 * // app/items/stack.tsx
 * "use client";
 * import { StackLayout } from "denext/navigation";
 * export function ItemsStack({ children }: { children: unknown }) {
 *   return <StackLayout base="/items" screenOptions={{ headerShown: true }}>{children}</StackLayout>;
 * }
 *
 * // app/items/layout.tsx
 * import { ItemsStack } from "./stack.tsx";
 * export default function Layout({ children }: { children: unknown }) {
 *   return <ItemsStack>{children}</ItemsStack>;
 * }
 *
 * // app/items/[id]/page.tsx
 * export const screenOptions = { title: "Item", headerLargeTitle: true };
 * ```
 */
export function StackLayout(props: StackLayoutProps): VNode {
  const ctx = navigationContexts();
  const segment = useContext(LayoutSegmentContext);
  const tab = useContext(ctx.tab);
  const [, force] = useReducer((n: number, _tick: void) => n + 1, 0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ScreenOptions>>(() => new Map());
  const ref = useRef<LayoutRt | null>(null);
  const rt = ref.current ??= createLayoutRuntime(props);
  const { base, known } = layoutBase(props, segment);
  Object.assign(rt, {
    props,
    base,
    platform: props.platform ?? detectPlatform(),
    getKey: props.getKey ?? routeKey,
    overrides,
    force,
    setOverrides,
  });
  const apiRef = useRef<StackNavigatorApi | null>(null);
  apiRef.current ??= createApi(rt);

  const href = currentHref();
  const key = rt.getKey(href);
  const children = props.children;
  const route = { key, href, element: children, options: currentScreenOptions() };
  const { model, changed } = planModel(rt, route, known);
  const animate = animateMode(rt);
  const entries: StackViewEntry[] = model.entries.map((e) => ({
    id: e.id,
    href: e.href,
    element: e.element,
    options: overrides.has(e.id) ? { ...e.options, ...overrides.get(e.id) } : e.options,
  }));

  useLayoutEffect(() => commitLayout(rt, model, changed, key, children));
  useLayoutListeners(rt);
  useTabRegistration(rt, tab);

  return h(
    ctx.navigator,
    { value: apiRef.current },
    h(StackView, {
      entries,
      animate,
      platform: rt.platform,
      screenOptions: props.screenOptions,
      swipeHaptic: props.swipeHaptic,
      theme: props.theme,
      material: props.material,
      accentColor: props.accentColor,
      style: props.style,
      className: props.className,
      onPop: (index: number, how: { animated: boolean }) => popTo(rt, index, how.animated),
      onHandle: (hd: StackViewHandle | null) => void (rt.handle = hd),
      containerRef: (el: HTMLElement | null) => void (rt.container = el),
    }),
  );
}

/**
 * The stack navigation for the screen this component renders in: `push`, `pop`, `popToTop`,
 * `replace`, `canGoBack`, `setOptions`. Outside a {@linkcode StackLayout} the methods fall back
 * to plain navigation and history.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useEffect } from "denext";
 * import { useStackNavigation } from "denext/navigation";
 *
 * export function Title({ name }: { name: string }) {
 *   const nav = useStackNavigation();
 *   useEffect(() => nav.setOptions({ title: name }), [name]);
 *   return null;
 * }
 * ```
 */
export function useStackNavigation(): StackNavigation {
  const ctx = navigationContexts();
  const navigator = useContext(ctx.navigator);
  const screen = useContext(ctx.screen);
  const index = screen?.index ?? 0;
  if (!navigator) {
    return {
      push: (href) => void navigate(href),
      replace: (href) => void navigate(href, { replace: true }),
      pop: (count = 1) => history.go(-count),
      popToTop: () => {},
      canGoBack: false,
      setOptions: () => {},
      index: 0,
    };
  }
  return {
    push: (href) => navigator.push(href),
    replace: (href) => navigator.replace(href),
    pop: (count = 1) => navigator.popTo(Math.max(0, navigator.depth() - 1 - count)),
    popToTop: () => navigator.popTo(0),
    canGoBack: index > 0,
    setOptions: (options) => {
      if (screen) navigator.setOptions(screen.id, options);
    },
    index,
  };
}
