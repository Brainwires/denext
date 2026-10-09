/**
 * `<TabsLayout>`: a tab bar layout (at the bottom by default) whose tabs keep their state.
 * Every tab visited stays mounted but hidden (`<Activity>`) when another is shown, with its own
 * stack (a `<StackLayout>` inside it) and scroll position; tapping the active tab pops its
 * stack to the root, then scrolls it to the top. Badges, `unmountOnBlur`, lazy tabs (the
 * default; `lazy: false` prefetches every tab) and hiding the bar while the on-screen keyboard
 * is up are built in.
 *
 * {@linkcode TabsView} is the router-independent view; {@linkcode TabsLayout} binds it to the
 * App Router (the URL decides the tab, a tab press navigates to that tab's last screen).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { Activity } from "../runtime/react-extras.ts";
import {
  getNavigatingHref,
  navigate,
  prefetch,
  subscribeNavigating,
} from "../client/navigation.ts";
import { detectPlatform } from "./animation.ts";
import { navigationContexts, type TabScope, type TabStackHandle } from "./context.ts";
import { useRouteAnnouncer } from "./announcer.ts";
import { suspendViewTransitions } from "./vt-hold.ts";
import { type NavigationThemeProps, themeAttributes, useNavigationTheme } from "./theme.ts";
import { isNativeShell } from "../mobile/bridge.ts";
import { haptic } from "../mobile/haptics.ts";
import { plainClick } from "./stack-owner.ts";
import type { NavigationPlatform } from "./types.ts";

/** One tab of a {@linkcode TabsLayout}. */
export interface TabDefinition {
  /** A unique name. */
  readonly name: string;
  /**
   * The tab's root URL (the first visit goes here; later ones return to its last screen). An
   * empty string draws a button instead of a link (a navigator that is not URL-driven).
   */
  readonly href: string;
  /** The label. */
  readonly title: string;
  /** The icon, or a function of whether the tab is active. */
  readonly icon?: VNodeChildren | ((state: { focused: boolean }) => VNodeChildren);
  /** A badge (a count or a short string); `undefined` or `""` hides it. */
  readonly badge?: string | number;
  /**
   * Which URLs belong to the tab: a path prefix, or a test on the pathname (default: `href`'s
   * pathname as a prefix).
   */
  readonly match?: string | ((pathname: string) => boolean);
  /** Unmount the tab's content when another tab is shown (default: the layout's). */
  readonly unmountOnBlur?: boolean;
}

/**
 * Props of {@linkcode TabsView}. `theme`, `material` and `accentColor` pick the look (see
 * {@linkcode NavigationThemeProps}).
 */
export interface TabsViewProps extends NavigationThemeProps {
  /** The tabs, in bar order. */
  readonly tabs: readonly TabDefinition[];
  /** The shown tab's name. */
  readonly active: string;
  /** The content of every tab that has been visited (and is not unmounted on blur). */
  readonly panels: ReadonlyMap<string, VNodeChildren>;
  /** The link each tab button points at (default: the tab's `href`). */
  readonly hrefs?: ReadonlyMap<string, string>;
  /** A tab button was pressed (call `preventDefault()` to keep the link from navigating). */
  readonly onTabPress: (name: string, event: MouseEvent) => void;
  /** Where the bar goes (default `"bottom"`). */
  readonly position?: "bottom" | "top";
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /** Hide the bar (e.g. while the on-screen keyboard is up). */
  readonly tabBarHidden?: boolean;
  /**
   * A selection haptic when a press switches tabs, inside the native shell only (default
   * `true`; the web never vibrates for it).
   */
  readonly tabHaptics?: boolean;
  /** Receives each tab's stack registry, so a press on the active tab can pop it. */
  readonly scopeFor?: (name: string) => TabScope;
  /** Extra style for the container (its height defaults to `100dvh`). */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** Extra style for the bar. */
  readonly tabBarStyle?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
  /**
   * Announce the new tab's title to screen readers when the tab changes (an `aria-live`
   * region). Default `true`.
   */
  readonly announceRouteChanges?: boolean;
}

/** Whether `pathname` belongs to `tab`. */
function tabMatches(tab: TabDefinition, pathname: string): boolean {
  if (typeof tab.match === "function") return tab.match(pathname);
  const prefix = (tab.match ?? tab.href.split(/[?#]/, 1)[0]).replace(/\/$/, "") || "/";
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** The tab `pathname` belongs to (the longest match wins), or the first tab. */
export function tabFor(
  tabs: readonly TabDefinition[],
  pathname: string,
): TabDefinition | undefined {
  let best: TabDefinition | undefined;
  let bestLen = -1;
  for (const tab of tabs) {
    if (!tabMatches(tab, pathname)) continue;
    const len = typeof tab.match === "string" ? tab.match.length : tab.href.length;
    if (len > bestLen) {
      best = tab;
      bestLen = len;
    }
  }
  return best ?? tabs[0];
}

/** A tab's stacks, as its scope registers them. */
export function createTabScope(): TabScope & { handles: Set<TabStackHandle> } {
  const handles = new Set<TabStackHandle>();
  return {
    handles,
    register(handle) {
      handles.add(handle);
      return () => void handles.delete(handle);
    },
  };
}

/**
 * What a press on the already-active tab does: pop its stack to the root when it can go back,
 * else scroll its stack (or, with no stack, `scrollPanel`) to the top. Returns what it did.
 */
export function reselectTab(
  handles: Iterable<TabStackHandle>,
  scrollPanel: () => boolean,
): "popToTop" | "scrollToTop" | "none" {
  const list = [...handles];
  for (const handle of list) {
    if (handle.canGoBack()) {
      handle.popToTop();
      return "popToTop";
    }
  }
  for (const handle of list) {
    if (handle.scrollToTop()) return "scrollToTop";
  }
  return scrollPanel() ? "scrollToTop" : "none";
}

/** The bar's badge. */
function badge(value: string | number | undefined): VNode | null {
  if (value === undefined || value === "") return null;
  return h("span", {
    "data-dnx-tab-badge": "",
    "aria-label": `${value} new`,
    style: {
      position: "absolute",
      top: 2,
      left: "calc(50% + 6px)",
      minWidth: 18,
      height: 18,
      padding: "0 5px",
      boxSizing: "border-box",
      borderRadius: 9,
      background: "#ff3b30",
      color: "#fff",
      fontSize: 11,
      fontWeight: 600,
      lineHeight: "18px",
      textAlign: "center",
    },
  }, String(value));
}

/** The look of one tab button. */
function tabButtonStyle(platform: NavigationPlatform, focused: boolean): Record<string, unknown> {
  const ios = platform === "ios";
  return {
    position: "relative",
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: ios ? 2 : 4,
    minHeight: `var(--dnx-tab-min-height, ${ios ? 49 : 64}px)`,
    textDecoration: "none",
    color: focused ? "var(--dnx-tab-active, LinkText)" : "var(--dnx-tab-inactive, GrayText)",
    fontSize: ios ? 10 : 12,
    fontWeight: focused ? 600 : 500,
    fontFamily: "inherit",
    background: "var(--dnx-tab-bg, none)",
    border: 0,
    cursor: "pointer",
  };
}

/** A tab's icon (Material draws an indicator pill behind the active one). */
function tabIcon(tab: TabDefinition, focused: boolean, platform: NavigationPlatform): VNode | null {
  const icon = typeof tab.icon === "function" ? tab.icon({ focused }) : tab.icon;
  if (!icon) return null;
  const pill = platform === "android";
  return h("span", {
    "aria-hidden": "true",
    "data-dnx-tab-icon": "",
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: pill ? "4px 20px" : 0,
      borderRadius: 16,
      background: pill && focused
        ? "var(--dnx-tab-indicator, rgba(127, 127, 127, 0.2))"
        : "transparent",
    },
  }, icon);
}

/** One tab button: a link to the tab (a button when it has no URL). */
function tabButton(props: TabsViewProps, tab: TabDefinition, platform: NavigationPlatform): VNode {
  const focused = tab.name === props.active;
  const href = props.hrefs?.get(tab.name) ?? tab.href;
  return h(
    href ? "a" : "button",
    {
      key: tab.name,
      role: "tab",
      id: `dnx-tab-${tab.name}`,
      href: href || undefined,
      type: href ? undefined : "button",
      "aria-selected": focused ? "true" : "false",
      "aria-controls": `dnx-tabpanel-${tab.name}`,
      "data-dnx-tab": tab.name,
      onClick: (event: MouseEvent) => {
        if (!focused && props.tabHaptics !== false && isNativeShell()) {
          haptic("selection").catch(() => {});
        }
        props.onTabPress(tab.name, event);
      },
      style: tabButtonStyle(platform, focused),
    },
    tabIcon(tab, focused, platform),
    h("span", null, tab.title),
    badge(tab.badge),
  );
}

/** The tab bar. */
function tabBar(
  props: TabsViewProps,
  platform: NavigationPlatform,
  position: "top" | "bottom",
): VNode {
  const hairline = "0.5px solid rgba(127, 127, 127, 0.35)";
  return h(
    "nav",
    {
      role: "tablist",
      "data-dnx-tabbar": platform,
      "aria-orientation": "horizontal",
      style: {
        flex: "none",
        display: props.tabBarHidden ? "none" : "flex",
        alignItems: "stretch",
        background: "var(--dnx-tabbar-bg, Canvas)",
        borderTop: position === "bottom" && platform === "ios"
          ? `var(--dnx-tabbar-border-top, ${hairline})`
          : "none",
        borderBottom: position === "top" ? hairline : "none",
        paddingBottom: position === "bottom"
          ? "var(--dnx-tabbar-pad-bottom, env(safe-area-inset-bottom, 0px))"
          : 0,
        ...(props.tabBarStyle ?? {}),
      },
    },
    ...props.tabs.map((tab) => tabButton(props, tab, platform)),
  );
}

/** The router-independent tab view: panels kept with `<Activity>`, and the bar. */
export function TabsView(props: TabsViewProps): VNode {
  const { tabs, active, panels } = props;
  const platform = props.platform ?? detectPlatform();
  const position = props.position ?? "bottom";
  const ctx = navigationContexts();
  useRouteAnnouncer(
    active,
    tabs.find((t) => t.name === active)?.title,
    props.announceRouteChanges !== false,
  );
  const panelEls = useRef(new Map<string, HTMLElement>());
  const scrollMemo = useRef(new Map<string, number>());

  // The shown panel gets its scroll position back (display:none dropped it).
  const shownBefore = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (shownBefore.current === active) return;
    shownBefore.current = active;
    const el = panelEls.current.get(active);
    const memo = scrollMemo.current.get(active);
    if (el && memo !== undefined && el.scrollTop !== memo) el.scrollTop = memo;
  });

  const panel = (tab: TabDefinition) => {
    const shown = tab.name === active;
    return h(
      "div",
      {
        key: tab.name,
        role: "tabpanel",
        id: `dnx-tabpanel-${tab.name}`,
        "aria-labelledby": `dnx-tab-${tab.name}`,
        "data-dnx-tabpanel": tab.name,
        ref: (el: HTMLElement | null) => {
          if (el) panelEls.current.set(tab.name, el);
          else panelEls.current.delete(tab.name);
        },
        onScroll: (event: Event) =>
          scrollMemo.current.set(tab.name, (event.currentTarget as HTMLElement).scrollTop),
        style: {
          position: "absolute",
          inset: 0,
          overflowY: "auto",
          display: shown ? "block" : "none",
          "--dnx-stack-height": "100%",
        },
      },
      h(
        ctx.tab,
        { value: props.scopeFor?.(tab.name) ?? null },
        h(Activity, { mode: shown ? "visible" : "hidden" }, panels.get(tab.name)),
      ),
    );
  };
  const body = h(
    "div",
    { "data-dnx-tab-panels": "", style: { position: "relative", flex: 1, minHeight: 0 } },
    ...tabs.filter((tab) => panels.has(tab.name)).map(panel),
  );
  const bar = tabBar(props, platform, position);
  useNavigationTheme(props.theme ?? "auto");
  const themed = themeAttributes(props, platform);
  return h(
    "div",
    {
      "data-dnx-tabs": position,
      ...themed.attrs,
      className: props.className,
      style: {
        display: "flex",
        flexDirection: "column",
        height: "var(--dnx-tabs-height, 100dvh)",
        ...themed.style,
        ...(props.style ?? {}),
      },
    },
    ...(position === "top" ? [bar, body] : [body, bar]),
  );
}

/**
 * Props of {@linkcode TabsLayout}. `theme` (default `"auto"`: the platform theme inside the
 * native shell), `material` and `accentColor` pick the look (see {@linkcode NavigationThemeProps}).
 */
export interface TabsLayoutProps extends NavigationThemeProps {
  /** The tabs, in bar order. */
  readonly tabs: readonly TabDefinition[];
  /** The layout's `children` (the current route under the tabs). */
  readonly children?: VNodeChildren;
  /** Where the bar goes (default `"bottom"`). */
  readonly position?: "bottom" | "top";
  /** `false` prefetches every tab's first screen on mount (default `true`: on first visit). */
  readonly lazy?: boolean;
  /** Unmount a tab's content when another tab is shown (default `false`: keep it). */
  readonly unmountOnBlur?: boolean;
  /** Hide the bar while the on-screen keyboard is up (default `false`). */
  readonly hideTabBarOnKeyboard?: boolean;
  /** The keyboard state (`useKeyboard()` from `denext/mobile`); else the visual viewport. */
  readonly keyboard?: { readonly visible: boolean } | null;
  /** How a tab switch enters history (default `"push"`: back returns to the previous tab). */
  readonly history?: "push" | "replace";
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /** Called on every tab press, before the layout acts on it. */
  readonly onTabPress?: (name: string) => void;
  /** A selection haptic on a tab switch, in the native shell only (default `true`). */
  readonly tabHaptics?: boolean;
  /** Extra style for the container. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** Extra style for the bar. */
  readonly tabBarStyle?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
}

/** The current URL's pathname and search (the request's on the server). */
function currentUrl(): { pathname: string; href: string } {
  if (typeof location === "undefined") {
    const req = (globalThis as {
      __denextCurrentRequestContext?: () => { request?: Request } | undefined;
    }).__denextCurrentRequestContext?.()?.request;
    try {
      if (req) {
        const u = new URL(req.url);
        return { pathname: u.pathname, href: u.pathname + u.search };
      }
    } catch { /* fall through */ }
    return { pathname: "/", href: "/" };
  }
  return { pathname: location.pathname, href: location.pathname + location.search };
}

/** Whether the on-screen keyboard is up, by the visual viewport (no `denext/mobile` needed). */
function useViewportKeyboard(enabled: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const g = globalThis as {
      visualViewport?: EventTarget & { height: number };
      innerHeight?: number;
    };
    const vv = g.visualViewport;
    if (!enabled || !vv) return;
    const check = () => setUp((g.innerHeight ?? vv.height) - vv.height > 150);
    vv.addEventListener("resize", check);
    check();
    return () => vv.removeEventListener("resize", check);
  }, [enabled]);
  return up;
}

/** A value `children` never is, so the first render always takes the route. */
const NONE: unique symbol = Symbol("none");

/** Scroll the tab's panel to the top; `false` when it already was. */
function scrollPanelToTop(event: MouseEvent, name: string): boolean {
  const doc = (event.currentTarget as Element | null)?.ownerDocument;
  const panel = doc?.getElementById?.(`dnx-tabpanel-${name}`);
  if (!panel || panel.scrollTop <= 0) return false;
  panel.scrollTo?.({ top: 0, behavior: "smooth" });
  return true;
}

/** The router's View Transition, held off while a tab switch shows a kept panel. */
function useTransitionHold(): () => void {
  const release = useRef<(() => void) | null>(null);
  useEffect(() =>
    subscribeNavigating(() => {
      if (getNavigatingHref() !== null) return;
      release.current?.();
      release.current = null;
    }), []);
  useEffect(() => () => release.current?.(), []);
  return () => {
    release.current?.();
    const done = suspendViewTransitions();
    release.current = done;
    setTimeout(done, 5000); // in case the router never settles
  };
}

/** Back/forward into another visited tab shows it at once; the router catches up behind. */
function useTabPopstate(
  tabs: () => readonly TabDefinition[],
  active: string,
  visited: { current: Map<string, VNodeChildren> },
  show: (name: string) => void,
): void {
  useEffect(() => {
    if (typeof globalThis.addEventListener !== "function") return;
    const onPop = () => {
      const name = tabFor(tabs(), location.pathname)?.name;
      if (name && name !== active && visited.current.has(name)) show(name);
    };
    globalThis.addEventListener("popstate", onPop, true);
    return () => globalThis.removeEventListener("popstate", onPop, true);
  }, [active]);
}

/** Every visited tab's latest content (the route's content goes to the URL's tab). */
function nextPanels(
  props: TabsLayoutProps,
  kept: Map<string, VNodeChildren>,
  fresh: boolean,
  urlTab: string,
  active: (panels: Map<string, VNodeChildren>) => string,
): { panels: Map<string, VNodeChildren>; active: string } {
  const panels = new Map(kept);
  if (fresh && urlTab) panels.set(urlTab, props.children);
  const shown = active(panels);
  for (const tab of props.tabs) {
    if (tab.name !== shown && (tab.unmountOnBlur ?? props.unmountOnBlur)) panels.delete(tab.name);
  }
  return { panels, active: shown };
}

/** The scope of each tab's stacks (created on first use, kept across renders). */
export function useTabScopes(): (name: string) => ReturnType<typeof createTabScope> {
  const scopes = useRef(new Map<string, ReturnType<typeof createTabScope>>());
  return (name: string) => {
    let scope = scopes.current.get(name);
    if (!scope) scopes.current.set(name, scope = createTabScope());
    return scope;
  };
}

/**
 * A tab bar's press handler: a plain click on the active tab pops its stack to the root (then
 * scrolls it to the top); on another tab it calls `go`.
 */
export function tabPressHandler<T extends TabDefinition>(o: {
  readonly tabs: readonly T[];
  readonly active: string;
  readonly scopeFor: (name: string) => ReturnType<typeof createTabScope>;
  readonly notify: (name: string) => void;
  readonly go: (tab: T) => void;
}): (name: string, event: MouseEvent) => void {
  return (name, event) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    o.notify(name);
    if (name === o.active) {
      reselectTab(o.scopeFor(name).handles, () => scrollPanelToTop(event, name));
      return;
    }
    const tab = o.tabs.find((t) => t.name === name);
    if (tab) o.go(tab);
  };
}

/**
 * A tab bar layout whose tabs keep their state; see the module docs. Render it from a
 * `"use client"` component your layout uses.
 *
 * @example
 * ```tsx
 * // app/(tabs)/tabs.tsx
 * "use client";
 * import { TabsLayout } from "denext/navigation";
 * export function AppTabs({ children }: { children: unknown }) {
 *   return (
 *     <TabsLayout
 *       tabs={[
 *         { name: "home", href: "/home", title: "Home", icon: <HomeIcon /> },
 *         { name: "inbox", href: "/inbox", title: "Inbox", badge: 3 },
 *       ]}
 *     >
 *       {children}
 *     </TabsLayout>
 *   );
 * }
 * ```
 */
export function TabsLayout(props: TabsLayoutProps): VNode {
  const { tabs } = props;
  const urlTab = tabFor(tabs, currentUrl().pathname)?.name ?? "";
  const [pending, setPending] = useState<string | null>(null);
  const panelsRef = useRef<Map<string, VNodeChildren>>(new Map());
  const childrenRef = useRef<unknown>(NONE);
  const lastHref = useRef(new Map<string, string>());
  const latest = useRef(props);
  latest.current = props;
  const hold = useTransitionHold();

  const { panels, active } = nextPanels(
    props,
    panelsRef.current,
    props.children !== childrenRef.current,
    urlTab,
    (p) => (pending && p.has(pending) ? pending : urlTab),
  );

  useLayoutEffect(() => {
    panelsRef.current = panels;
    childrenRef.current = props.children;
    if (urlTab) lastHref.current.set(urlTab, currentUrl().href);
    if (pending !== null && pending === urlTab) setPending(null);
  });

  // lazy: false warms every tab's first screen.
  useEffect(() => {
    if (props.lazy !== false) return;
    for (const tab of tabs) if (tab.name !== urlTab) prefetch(tab.href);
  }, []);

  const show = (name: string) => {
    hold();
    setPending(name);
  };
  useTabPopstate(() => latest.current.tabs, active, panelsRef, show);

  const scopeFor = useTabScopes();
  const onTabPress = tabPressHandler({
    tabs,
    active,
    scopeFor,
    notify: (name) => latest.current.onTabPress?.(name),
    go: (tab) => {
      if (panelsRef.current.has(tab.name)) show(tab.name);
      const target = lastHref.current.get(tab.name) ?? tab.href;
      void navigate(target, { replace: props.history === "replace", scroll: false });
    },
  });

  const hideOnKeyboard = props.hideTabBarOnKeyboard === true;
  const viewportKeyboard = useViewportKeyboard(hideOnKeyboard && props.keyboard === undefined);
  const keyboardUp = props.keyboard ? props.keyboard.visible : viewportKeyboard;

  return h(TabsView, {
    tabs,
    active,
    panels,
    hrefs: lastHref.current,
    onTabPress,
    position: props.position,
    platform: props.platform,
    tabBarHidden: hideOnKeyboard && keyboardUp,
    tabHaptics: props.tabHaptics,
    theme: props.theme,
    material: props.material,
    accentColor: props.accentColor,
    scopeFor,
    style: props.style,
    tabBarStyle: props.tabBarStyle,
    className: props.className,
  });
}
