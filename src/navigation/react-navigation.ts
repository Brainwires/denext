/**
 * React Navigation navigators drawn by `denext/navigation`'s views, for React Native mode
 * (Expo Router's `Stack` / `Tabs`, or `@react-navigation/native-stack` /
 * `@react-navigation/bottom-tabs` directly). On the web those libraries have no gestures, no
 * native-stack animations and no sheet presentation; these factories keep React Navigation's
 * routers and state (so `navigation.navigate`, deep links and `Stack.Screen` options work
 * unchanged) and draw them with {@linkcode StackView} / {@linkcode TabsView}: kept screens,
 * platform push/pop animations, the iOS edge swipe, Android predictive back, the header, and
 * `presentation: "modal" | "formSheet" | "transparentModal"`.
 *
 * denext ships no npm code, so the factories take React Navigation's core as an argument; the
 * app build supplies it (`import * as core from "@react-navigation/native"`).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useRef } from "../runtime/hooks.ts";
import { StackView } from "./stack-view.ts";
import { type TabDefinition, TabsView } from "./tabs.ts";
import type { ScreenOptions, SheetDetent, StackPresentation, StackViewEntry } from "./types.ts";

/** A React Navigation route, as the navigators read it. */
export interface ReactNavigationRoute {
  /** The route's unique key. */
  readonly key: string;
  /** The screen name. */
  readonly name: string;
}

/** A navigator's state, as the navigators read it. */
export interface ReactNavigationState {
  /** The navigator's key (actions target it). */
  readonly key: string;
  /** The focused route's index. */
  readonly index: number;
  /** The routes, bottom (or first tab) first. */
  readonly routes: readonly ReactNavigationRoute[];
}

/** One screen's descriptor (`options` are the library's own screen options). */
export interface ReactNavigationDescriptor {
  /** The screen's options (`title`, `presentation`, `tabBarBadge`, …). */
  readonly options: Record<string, unknown>;
  /** Render the screen (wrapped in its navigation contexts). */
  render(): VNodeChildren;
}

/** The slice of the navigation object the navigators use. */
export interface ReactNavigationObject {
  /** Dispatch an action (`StackActions.pop`, `TabActions.jumpTo`, …). */
  dispatch(action: unknown): void;
  /** Emit a navigator event (`tabPress`) to the screens' listeners. */
  emit(event: { type: string; target?: string; canPreventDefault?: boolean }): {
    defaultPrevented?: boolean;
  };
  /** Whether this navigator's screen is focused. */
  isFocused?(): boolean;
  /** Listen to a parent navigator's event (`tabPress`); returns the unsubscribe. */
  addListener?(type: string, cb: (e: { defaultPrevented?: boolean }) => void): () => void;
}

/**
 * The part of `@react-navigation/native` (which re-exports `@react-navigation/core` and the
 * routers) the factories need: `import * as core from "@react-navigation/native"` fits.
 */
export interface ReactNavigationCore {
  /** Turn a navigator component into a `create*Navigator` function. */
  // deno-lint-ignore no-explicit-any -- React Navigation's generics are not modelled here.
  createNavigatorFactory(navigator: (props: any) => unknown): (config?: unknown) => any;
  /** Build a navigator's state, descriptors and navigation object from its router. */
  useNavigationBuilder(router: unknown, options: Record<string, unknown>): {
    state: ReactNavigationState;
    descriptors: Record<string, ReactNavigationDescriptor>;
    navigation: ReactNavigationObject;
    NavigationContent: (props: { children?: VNodeChildren }) => unknown;
  };
  /** The stack router. */
  readonly StackRouter: unknown;
  /** The tab router (for {@linkcode createBottomTabNavigatorFactory}). */
  readonly TabRouter?: unknown;
  /** The stack actions. */
  readonly StackActions: { pop(count?: number): object; popToTop(): object };
  /** The tab actions (for {@linkcode createBottomTabNavigatorFactory}). */
  readonly TabActions?: { jumpTo(name: string): object };
}

/** The navigator props the builder takes (everything else is for the view). */
const BUILDER_KEYS = [
  "id",
  "initialRouteName",
  "backBehavior",
  "children",
  "layout",
  "screenListeners",
  "screenOptions",
  "screenLayout",
  "UNSTABLE_router",
  "UNSTABLE_getStateForRouteNamesChange",
] as const;

/** Split navigator props into the builder's options and the rest. */
function builderOptions(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BUILDER_KEYS) if (key in props) out[key] = props[key];
  return out;
}

/** A native-stack `presentation` in {@linkcode StackPresentation} terms. */
function mapPresentation(value: unknown): StackPresentation | undefined {
  switch (value) {
    case "card":
    case "modal":
    case "formSheet":
    case "transparentModal":
      return value;
    case "fullScreenModal":
    case "containedModal":
      return "modal";
    case "pageSheet":
      return "formSheet";
    case "containedTransparentModal":
      return "transparentModal";
    default:
      return undefined;
  }
}

/** A native-stack `sheetAllowedDetents` in {@linkcode SheetDetent} terms. */
function mapDetents(value: unknown): SheetDetent[] | undefined {
  if (value === "fitToContents") return ["fit"];
  if (value === "medium" || value === "large") return [value];
  if (value === "all") return ["medium", "large"];
  if (Array.isArray(value)) return value.filter((d) => typeof d === "number" && d > 0);
  return undefined;
}

/** A header slot: a node, or React Navigation's render function. */
function slot(value: unknown, args: Record<string, unknown>): VNodeChildren | undefined {
  if (typeof value === "function") return (value as (a: unknown) => VNodeChildren)(args);
  return value === undefined || value === null || typeof value === "boolean"
    ? undefined
    : value as VNodeChildren;
}

/**
 * Native-stack screen options as {@linkcode ScreenOptions}: the names mostly match
 * (`title`, `animation`, `gestureEnabled`, `headerShown`, `headerLargeTitle`, …); the
 * presentations and detents are translated and the header slots rendered.
 */
export function mapStackOptions(
  options: Record<string, unknown>,
  context: { canGoBack: boolean },
): ScreenOptions {
  const str = (k: string) => typeof options[k] === "string" ? options[k] as string : undefined;
  const bool = (k: string) => typeof options[k] === "boolean" ? options[k] as boolean : undefined;
  const title = str("title");
  const headerTitle = typeof options.headerTitle === "string"
    ? options.headerTitle
    : slot(options.headerTitle, { children: title });
  const out: Record<string, unknown> = {
    title,
    animation: str("animation"),
    animationDuration: typeof options.animationDuration === "number"
      ? options.animationDuration
      : undefined,
    gestureEnabled: bool("gestureEnabled"),
    presentation: mapPresentation(options.presentation),
    headerShown: bool("headerShown") ?? true,
    headerLargeTitle: bool("headerLargeTitle"),
    headerBackTitle: str("headerBackTitle"),
    headerBackVisible: bool("headerBackVisible"),
    sheetAllowedDetents: mapDetents(options.sheetAllowedDetents),
    sheetInitialDetentIndex: typeof options.sheetInitialDetentIndex === "number"
      ? options.sheetInitialDetentIndex
      : undefined,
    sheetGrabberVisible: bool("sheetGrabberVisible"),
    headerTitle: typeof headerTitle === "string" ? undefined : headerTitle,
    headerLeft: slot(options.headerLeft, { canGoBack: context.canGoBack }),
    headerRight: slot(options.headerRight, { canGoBack: context.canGoBack }),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as ScreenOptions;
}

/**
 * `createNativeStackNavigator` for React Native mode, drawn by {@linkcode StackView}.
 *
 * @param core React Navigation's core (`import * as core from "@react-navigation/native"`).
 * @returns A `createNativeStackNavigator` look-alike (`.Navigator`, `.Screen`, `.Group`).
 * @example
 * ```ts
 * import * as core from "@react-navigation/native";
 * import { createNativeStackNavigatorFactory } from "denext/navigation";
 * export const createNativeStackNavigator = createNativeStackNavigatorFactory(core);
 * ```
 */
export function createNativeStackNavigatorFactory(
  core: ReactNavigationCore,
): (config?: unknown) => unknown {
  function DenextNativeStackNavigator(props: Record<string, unknown>): VNode {
    const { state, descriptors, navigation, NavigationContent } = core.useNavigationBuilder(
      core.StackRouter,
      builderOptions(props),
    );
    // A second press on this stack's tab pops it to its root (native-stack does the same).
    const stateRef = useRef(state);
    stateRef.current = state;
    useEffect(() =>
      navigation.addListener?.("tabPress", (e) => {
        const s = stateRef.current;
        if (s.index > 0 && navigation.isFocused?.() !== false && !e.defaultPrevented) {
          navigation.dispatch({ ...core.StackActions.popToTop(), target: s.key });
        }
      }), [navigation]);
    const entries: StackViewEntry[] = state.routes.map((route, i) => {
      const d = descriptors[route.key];
      return {
        id: route.key,
        element: d.render(),
        options: mapStackOptions(d.options, { canGoBack: i > 0 }),
      };
    });
    return h(
      NavigationContent as never,
      null,
      h(StackView, {
        entries,
        swipeBack: props.swipeBack as boolean | undefined,
        onPop: (toIndex: number) => {
          const count = state.routes.length - 1 - toIndex;
          if (count > 0) {
            navigation.dispatch({ ...core.StackActions.pop(count), target: state.key });
          }
        },
      }),
    );
  }
  return core.createNavigatorFactory(DenextNativeStackNavigator);
}

/**
 * `createBottomTabNavigator` for React Native mode, drawn by {@linkcode TabsView}: visited tabs
 * stay mounted (hidden with `<Activity>`), `tabBarBadge` / `tabBarIcon` / `tabBarLabel` /
 * `title` and `lazy` / `popToTopOnBlur` / `unmountOnBlur` are honoured, and a press on the
 * active tab emits `tabPress` (a nested stack pops to its root) then scrolls it to the top.
 *
 * @param core React Navigation's core (needs `TabRouter` and `TabActions`).
 * @returns A `createBottomTabNavigator` look-alike.
 */
export function createBottomTabNavigatorFactory(
  core: ReactNavigationCore,
): (config?: unknown) => unknown {
  function DenextBottomTabNavigator(props: Record<string, unknown>): VNode {
    const { state, descriptors, navigation, NavigationContent } = core.useNavigationBuilder(
      core.TabRouter,
      builderOptions(props),
    );
    const visited = useRef(new Set<string>());
    const activeKey = state.routes[state.index]?.key ?? "";
    visited.current.add(activeKey);
    const panels = new Map<string, VNodeChildren>();
    const tabs: TabDefinition[] = state.routes.map((route) => {
      const o = descriptors[route.key].options;
      const focused = route.key === activeKey;
      const lazy = o.lazy !== false;
      const drop = o.unmountOnBlur === true || o.popToTopOnBlur === true;
      if (focused || (!drop && (visited.current.has(route.key) || !lazy))) {
        panels.set(route.key, descriptors[route.key].render());
      }
      const label = typeof o.tabBarLabel === "string"
        ? o.tabBarLabel
        : typeof o.title === "string"
        ? o.title
        : route.name;
      const icon = typeof o.tabBarIcon === "function"
        ? ({ focused }: { focused: boolean }) =>
          (o.tabBarIcon as (a: unknown) => VNodeChildren)({
            focused,
            color: "currentColor",
            size: 24,
          })
        : undefined;
      const badge = typeof o.tabBarBadge === "number" || typeof o.tabBarBadge === "string"
        ? o.tabBarBadge
        : undefined;
      return { name: route.key, href: "", title: label, icon, badge };
    });
    const position = descriptors[activeKey]?.options.tabBarPosition === "top" ? "top" : "bottom";
    return h(
      NavigationContent as never,
      null,
      h(TabsView, {
        tabs,
        active: activeKey,
        panels,
        position,
        onTabPress: (name: string, event: MouseEvent) => {
          event.preventDefault();
          const route = state.routes.find((r) => r.key === name);
          if (!route) return;
          const e = navigation.emit({ type: "tabPress", target: name, canPreventDefault: true });
          // A press on the active tab: its nested stack pops to its root on the `tabPress`.
          if (e.defaultPrevented || name === activeKey) return;
          if (core.TabActions) {
            navigation.dispatch({ ...core.TabActions.jumpTo(route.name), target: state.key });
          }
        },
      }),
    );
  }
  return core.createNavigatorFactory(DenextBottomTabNavigator);
}
