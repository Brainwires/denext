/**
 * `<HistoryTabs>`: the tab bar bound to any history-based router through a
 * {@linkcode HistorySource}, as {@linkcode HistoryStack} binds the stack. The location decides
 * the active tab (its `href` prefix, or `match`); every visited tab stays mounted but hidden
 * (`<Activity>`) with its state; a press navigates to the tab's last location; a press on the
 * active tab pops its stack (a {@linkcode HistoryStack} with that tab's `base`) to the root,
 * then scrolls it to the top.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useReducer, useRef } from "../runtime/hooks.ts";
import { type TabDefinition, tabFor, tabPressHandler, TabsView, useTabScopes } from "./tabs.ts";
import type { HistorySource } from "./history-source.ts";
import type { NavigationThemeProps } from "./theme.ts";
import type { NavigationPlatform } from "./types.ts";

/** One tab of a {@linkcode HistoryTabs}: a {@linkcode TabDefinition} that renders itself. */
export interface HistoryTab extends TabDefinition {
  /** The tab's content (typically a `<HistoryStack base={href}>` of its screens). */
  readonly render: () => VNodeChildren;
}

/** Props of {@linkcode HistoryTabs}. */
export interface HistoryTabsProps extends NavigationThemeProps {
  /** The router's history ({@linkcode tanstackHistory}, {@linkcode browserHistory}, …). */
  readonly history: HistorySource;
  /** The tabs, in bar order. */
  readonly tabs: readonly HistoryTab[];
  /** Where the bar sits (default `"bottom"`). */
  readonly position?: "bottom" | "top";
  /** `false` renders every tab at once (default `true`: a tab renders when first shown). */
  readonly lazy?: boolean;
  /** Whether a press pushes a history entry (default) or replaces the current one. */
  readonly historyMode?: "push" | "replace";
  /** The look (default: detected from the user agent). */
  readonly platform?: NavigationPlatform;
  /** Called on every tab press, before it navigates. */
  readonly onTabPress?: (name: string) => void;
  /** A selection haptic on a tab press inside the native shell (default `true`). */
  readonly tabHaptics?: boolean;
  /** Extra style for the container. */
  readonly style?: Readonly<Record<string, string | number | undefined>>;
  /** Extra style for the tab bar. */
  readonly tabBarStyle?: Readonly<Record<string, string | number | undefined>>;
  /** A class for the container. */
  readonly className?: string;
}

/**
 * A tab bar over any history-based router whose tabs keep their state; see the module docs.
 *
 * @example
 * ```tsx
 * "use client";
 * import { HistoryStack, HistoryTabs, tanstackHistory } from "denext/navigation";
 * const history = tanstackHistory(router);
 * export function Phone() {
 *   return (
 *     <HistoryTabs
 *       history={history}
 *       tabs={[
 *         { name: "threads", href: "/threads", title: "Threads",
 *           render: () => <HistoryStack history={history} base="/threads" screens={threadScreens} /> },
 *         { name: "settings", href: "/settings", title: "Settings", render: () => <Settings /> },
 *       ]}
 *     />
 *   );
 * }
 * ```
 */
export function HistoryTabs(props: HistoryTabsProps): VNode {
  const { tabs, history } = props;
  const [, force] = useReducer((n: number, _tick: void) => n + 1, 0);
  const visited = useRef(new Set<string>());
  const lastHref = useRef(new Map<string, string>());
  useEffect(() => history.subscribe(() => force()), [history]);

  const loc = history.location();
  const active = tabFor(tabs, loc.pathname)?.name ?? "";
  if (active) {
    visited.current.add(active);
    lastHref.current.set(active, loc.pathname + loc.search + loc.hash);
  }
  const panels = new Map<string, VNodeChildren>();
  for (const tab of tabs) {
    const keep = tab.name === active ||
      (!tab.unmountOnBlur && (visited.current.has(tab.name) || props.lazy === false));
    if (keep) panels.set(tab.name, tab.render());
    else visited.current.delete(tab.name);
  }

  const scopeFor = useTabScopes();
  const onTabPress = tabPressHandler({
    tabs,
    active,
    scopeFor,
    notify: (name) => props.onTabPress?.(name),
    go: (tab) => {
      const target = lastHref.current.get(tab.name) ?? tab.href;
      if (props.historyMode === "replace") history.replace(target);
      else history.push(target);
    },
  });

  return h(TabsView, {
    tabs,
    active,
    panels,
    hrefs: lastHref.current,
    onTabPress,
    position: props.position,
    platform: props.platform,
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
