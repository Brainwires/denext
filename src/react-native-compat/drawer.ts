/**
 * `@react-navigation/drawer` for denext's React Native mode: the drawer navigator, drawn by
 * denext's {@linkcode Drawer} instead of `react-native-drawer-layout` (which needs Reanimated
 * worklets and gesture-handler on the UI thread).
 *
 * React Native mode resolves `@react-navigation/drawer` to a generated module that re-exports
 * this one and builds `createDrawerNavigator` from the app's own React Navigation core
 * (`drawerNavigatorExports(core)` with `import * as core from "@react-navigation/native"`), so
 * the drawer router, its `openDrawer` / `closeDrawer` / `toggleDrawer` actions, deep links and
 * screen options behave as in React Navigation. What the view does:
 *
 * - a slide-in panel over (`drawerType: "front"`), under (`"back"`), beside (`"slide"`) or next
 *   to (`"permanent"`) the screens, on the `drawerPosition` side, sized by `drawerStyle`;
 * - an overlay (`overlayColor`, `overlayStyle`) that closes it on press;
 * - an edge swipe to open (`swipeEnabled`, `swipeEdgeWidth`) and a drag to close that follows the
 *   finger, a fling or a pass of half the width deciding;
 * - Escape and the Android back button (while open) close it; a closed panel is `inert`;
 * - visited screens stay mounted (hidden), and each screen has a header with a
 *   {@linkcode DrawerToggleButton} unless `headerShown: false` (`header`, `headerTitle`,
 *   `headerLeft`, `headerRight`, `headerStyle`, `headerTintColor` are honoured).
 *
 * {@linkcode useDrawerProgress} returns `{ value }` (0 closed … 1 open) that re-renders as the
 * drawer moves: it is not a Reanimated `SharedValue`, so read it during render, not in a worklet.
 *
 * @example
 * ```ts
 * import { createDrawerNavigator } from "@react-navigation/drawer"; // React Native mode
 * import { h } from "denext/jsx-runtime";
 *
 * const Drawer = createDrawerNavigator();
 * h(Drawer.Navigator, { screenOptions: { drawerType: "front" } },
 *   h(Drawer.Screen, { name: "Home", component: () => "Home" }));
 * ```
 *
 * @module
 */

import { Fragment, h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import type { Context } from "../runtime/hooks.ts";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "../runtime/hooks.ts";
import { hostView, viewStyle } from "../expo/internal/common.ts";
import { clamp, releaseSwipe, VelocityTracker } from "../navigation/gesture.ts";
import { prefersReducedMotion } from "../navigation/animation.ts";
import { useRouteAnnouncer } from "../navigation/announcer.ts";
import { onBack } from "../mobile/back-handler.ts";
import { useSafeAreaInsets } from "../mobile/safe-area.ts";
import * as RN from "./internal/react-native.ts";

// ---- types ---------------------------------------------------------------------------------

/** Whether the drawer is open. */
export type DrawerStatus = "open" | "closed";

/** Which side the drawer is on. */
export type DrawerPosition = "left" | "right";

/** How the drawer and the screens move. */
export type DrawerType = "front" | "back" | "slide" | "permanent";

/** A drawer navigator route. */
export interface DrawerRoute {
  /** The route key. */
  readonly key: string;
  /** The screen name. */
  readonly name: string;
  /** The route params. */
  readonly params?: object;
}

/** The drawer navigator's state (the drawer router's). */
export interface DrawerNavigationState {
  /** The navigator key. */
  readonly key: string;
  /** The focused route's index. */
  readonly index: number;
  /** The routes. */
  readonly routes: readonly DrawerRoute[];
  /** The history; the drawer's open state is a `{ type: "drawer", status }` entry. */
  readonly history?: readonly { readonly type: string; readonly status?: DrawerStatus }[];
  /** The router's default status. */
  readonly default?: DrawerStatus;
}

/** The slice of the navigation object the drawer uses. */
export interface DrawerNavigationLike {
  /** Dispatch an action. */
  dispatch(action: object): void;
  /** Emit an event to the screens' listeners. */
  emit(event: { type: string; target?: string; canPreventDefault?: boolean; data?: unknown }): {
    defaultPrevented?: boolean;
  };
  /** Whether this navigator's screen is focused. */
  isFocused?(): boolean;
}

/** One screen's descriptor. */
export interface DrawerDescriptor {
  /** The screen's options (`title`, `drawerLabel`, `headerShown`, …). */
  readonly options: Record<string, unknown>;
  /** Render the screen. */
  render(): VNodeChildren;
  /** The route (React Navigation's descriptors carry it). */
  readonly route?: DrawerRoute;
  /** The screen's navigation object. */
  readonly navigation?: unknown;
}

/** What `drawerContent` and {@linkcode DrawerItemList} receive. */
export interface DrawerContentComponentProps {
  /** The navigator state. */
  state: DrawerNavigationState;
  /** The navigator's navigation object. */
  navigation: DrawerNavigationLike;
  /** The screens' descriptors. */
  descriptors: Record<string, DrawerDescriptor>;
}

/** The drawer actions (React Navigation's `DrawerActions`, or the built-in equivalents). */
export interface DrawerActionCreators {
  /** `{ type: "OPEN_DRAWER" }`. */
  openDrawer(): object;
  /** `{ type: "CLOSE_DRAWER" }`. */
  closeDrawer(): object;
  /** `{ type: "TOGGLE_DRAWER" }`. */
  toggleDrawer(): object;
}

/** The part of `@react-navigation/native` the drawer navigator needs. */
export interface DrawerNavigationCore {
  /** Turn a navigator component into a `create*Navigator`. */
  // deno-lint-ignore no-explicit-any -- React Navigation's generics are not modelled here.
  createNavigatorFactory(navigator: (props: any) => unknown): (config?: unknown) => any;
  /** Build the navigator's state, descriptors and navigation from its router. */
  useNavigationBuilder(router: unknown, options: Record<string, unknown>): {
    state: DrawerNavigationState;
    descriptors: Record<string, DrawerDescriptor>;
    navigation: DrawerNavigationLike;
    NavigationContent?: (props: { children?: VNodeChildren }) => unknown;
    render?: (children: VNodeChildren) => VNodeChildren;
  };
  /** The drawer router. */
  readonly DrawerRouter: unknown;
  /** The drawer actions. */
  readonly DrawerActions?: DrawerActionCreators;
  /** The common actions (`navigate`). */
  readonly CommonActions?: { navigate(name: string, params?: object): object };
}

// ---- contexts ------------------------------------------------------------------------------

/** The drawer's status for the screens inside it (`undefined` outside a drawer). */
export const DrawerStatusContext: Context<DrawerStatus | undefined> = /* @__PURE__ */ createContext<
  DrawerStatus | undefined
>(undefined);

/** {@linkcode useDrawerProgress}'s value. */
export interface DrawerProgress {
  /** 0 (closed) … 1 (open). */
  readonly value: number;
}

/** The drawer's open progress for the views inside it (`undefined` outside a drawer). */
export const DrawerProgressContext: Context<DrawerProgress | undefined> =
  /* @__PURE__ */ createContext<DrawerProgress | undefined>(undefined);

/** Which side the drawer is on, for the drawer content. */
const DrawerPositionContext: Context<DrawerPosition> = /* @__PURE__ */ createContext<
  DrawerPosition
>("left");

/** What the toggle button needs from the navigator it sits in. */
interface DrawerController {
  toggle(): void;
}

/** The enclosing drawer navigator's controller. */
const DrawerControllerContext: Context<DrawerController | null> = /* @__PURE__ */ createContext<
  DrawerController | null
>(null);

// ---- utilities -----------------------------------------------------------------------------

/**
 * The drawer's status in a drawer navigator's state: the last `drawer` history entry's, else
 * the router's default, else closed.
 *
 * @param state A drawer navigator's state.
 * @returns `"open"` or `"closed"`.
 */
export function getDrawerStatusFromState(state: DrawerNavigationState): DrawerStatus {
  if (state.history == null) {
    throw new Error(
      "Couldn't find the drawer status in the state object. Is it a valid state object of " +
        "drawer navigator?",
    );
  }
  const entry = [...state.history].reverse().find((it) => it.type === "drawer");
  return entry?.status ?? state.default ?? "closed";
}

/**
 * The status of the drawer the calling screen is in.
 *
 * @returns `"open"` or `"closed"`.
 */
export function useDrawerStatus(): DrawerStatus {
  const status = useContext(DrawerStatusContext);
  if (status === undefined) {
    throw new Error("Couldn't find a drawer. Is your component inside a drawer navigator?");
  }
  return status;
}

/**
 * The drawer's open progress: `{ value }`, 0 (closed) … 1 (open), updated (with a re-render)
 * as the drawer moves. Not a Reanimated `SharedValue`.
 *
 * @returns The progress.
 */
export function useDrawerProgress(): DrawerProgress {
  const progress = useContext(DrawerProgressContext);
  if (progress === undefined) {
    throw new Error("Couldn't find a drawer. Is your component inside a drawer layout?");
  }
  return progress;
}

/**
 * `createDrawerScreen`: the static-configuration helper, returning its config unchanged.
 *
 * @param config A screen config.
 * @returns The same config.
 */
export function createDrawerScreen<T>(config: T): T {
  return config;
}

/** The built-in drawer actions (the router's action types). */
const BUILTIN_ACTIONS: DrawerActionCreators = {
  openDrawer: () => ({ type: "OPEN_DRAWER" }),
  closeDrawer: () => ({ type: "CLOSE_DRAWER" }),
  toggleDrawer: () => ({ type: "TOGGLE_DRAWER" }),
};

/** A header slot: a node, or a render function called with `args`. */
function slot(value: unknown, args: Record<string, unknown>): VNodeChildren | undefined {
  const rendered = typeof value === "function" ? value(args) : value;
  // Nothing to draw: absent, or a boolean left by a `cond && <Node />` expression.
  if (rendered == null || rendered === true || rendered === false) return undefined;
  return rendered as VNodeChildren;
}

/** A text host: react-native-web's `Text`, else a `<span>`. */
function textHost(): VNodeType {
  return RN.Text ?? "span";
}

/** A pressable element that calls `onPress` (react-native-web's `Pressable`, else a button). */
function pressable(
  props:
    & { onPress: () => void; style?: unknown; label?: string; testID?: string }
    & Record<
      string,
      unknown
    >,
  children: VNodeChildren,
): VNode {
  const { onPress, style, label, testID, ...rest } = props;
  if (RN.Pressable) {
    return h(RN.Pressable, {
      ...rest,
      onPress,
      style,
      role: "button",
      "aria-label": label,
      testID,
    }, children as never);
  }
  return h("button", {
    ...rest,
    type: "button",
    onClick: onPress,
    "aria-label": label,
    "data-testid": testID,
    style: {
      display: "flex",
      alignItems: "center",
      background: "none",
      border: "0",
      padding: "0",
      font: "inherit",
      color: "inherit",
      cursor: "pointer",
      textAlign: "start",
      ...(viewStyle(style) as Record<string, unknown>),
    },
  }, children as never);
}

// ---- views ---------------------------------------------------------------------------------

/** {@linkcode DrawerToggleButton} props. */
export interface DrawerToggleButtonProps {
  /** The icon colour. */
  tintColor?: string;
  /** The accessible label (default "Show navigation menu"). */
  accessibilityLabel?: string;
  /** An image source for the icon (a URL string or `{ uri }`); default a three-bar icon. */
  imageSource?: unknown;
  /** Other button props. */
  [prop: string]: unknown;
}

/**
 * The header button that toggles the enclosing drawer.
 *
 * @param props The tint, label and icon.
 * @returns The button.
 */
export function DrawerToggleButton(props: DrawerToggleButtonProps): VNode {
  const {
    tintColor,
    accessibilityLabel = "Show navigation menu",
    imageSource,
    ...rest
  } = props;
  const controller = useContext(DrawerControllerContext);
  const uri = typeof imageSource === "string"
    ? imageSource
    : (imageSource as { uri?: string } | undefined)?.uri;
  const bar = {
    display: "block",
    width: "18px",
    height: "2px",
    margin: "2px 0",
    background: tintColor ?? "currentColor",
    borderRadius: "1px",
  };
  const icon = uri ? h("img", { src: uri, alt: "", width: 24, height: 24 }) : h(
    "span",
    { "aria-hidden": "true", style: { display: "block", padding: "3px" } },
    h("span", { style: bar }),
    h("span", { style: bar }),
    h("span", { style: bar }),
  );
  return pressable({
    ...rest,
    label: accessibilityLabel,
    "data-denext-drawer-toggle": "",
    style: { padding: 8, marginHorizontal: 5, color: tintColor },
    onPress: () => {
      if (controller) controller.toggle();
      else console.warn("denext @react-navigation/drawer: DrawerToggleButton is outside a drawer.");
    },
  }, icon);
}

/** {@linkcode DrawerItem} props. */
export interface DrawerItemProps {
  /** The label: text, or a render function `({ color, focused })`. */
  label: string | ((props: { color: string; focused: boolean }) => VNodeChildren);
  /** The icon, `({ focused, size, color })`. */
  icon?: (props: { focused: boolean; size: number; color: string }) => VNodeChildren;
  /** Whether it is the current route. */
  focused?: boolean;
  /** Pressed. */
  onPress: () => void;
  /** The focused tint. */
  activeTintColor?: string;
  /** The unfocused tint. */
  inactiveTintColor?: string;
  /** The focused background. */
  activeBackgroundColor?: string;
  /** The unfocused background. */
  inactiveBackgroundColor?: string;
  /** The label style. */
  labelStyle?: unknown;
  /** The item style. */
  style?: unknown;
  /** Test id. */
  testID?: string;
  /** The accessible label. */
  accessibilityLabel?: string;
  /** Other props (`href`, `pressColor`, … accepted and ignored). */
  [prop: string]: unknown;
}

/**
 * An item (icon + label) in the drawer.
 *
 * @param props The label, icon, colours and press handler.
 * @returns The item.
 */
export function DrawerItem(props: DrawerItemProps): VNode {
  const {
    label,
    icon,
    focused = false,
    onPress,
    activeTintColor = "rgb(0, 122, 255)",
    inactiveTintColor = "rgba(28, 28, 30, 0.68)",
    activeBackgroundColor = "rgba(0, 122, 255, 0.12)",
    inactiveBackgroundColor = "transparent",
    labelStyle,
    style,
    testID,
    accessibilityLabel,
  } = props;
  const color = focused ? activeTintColor : inactiveTintColor;
  const text = typeof label === "string"
    ? h(textHost(), {
      numberOfLines: RN.Text ? 1 : undefined,
      style: viewStyle(labelStyle, { color, fontWeight: "500", lineHeight: 24 }),
    }, label)
    : label({ color, focused });
  return h(
    hostView(),
    {
      style: viewStyle(style, {
        borderRadius: 56,
        overflow: "hidden",
        backgroundColor: focused ? activeBackgroundColor : inactiveBackgroundColor,
      }),
    },
    pressable({
      onPress,
      label: accessibilityLabel,
      testID,
      "aria-current": focused ? "page" : undefined,
      "data-denext-drawer-item": "",
      style: {
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 11,
        paddingLeft: 16,
        paddingRight: 24,
        gap: 12,
        width: "100%",
      },
    }, h(Fragment, null, icon ? icon({ size: 24, focused, color }) : null, text)),
  );
}

/**
 * The drawer's list of routes: one {@linkcode DrawerItem} per screen, `drawerLabel` /
 * `title` / the name as the label, `drawerIcon` as the icon; a press emits
 * `drawerItemPress`, then navigates (or, on the current route, closes the drawer).
 *
 * @param props The navigator's state, navigation and descriptors.
 * @returns The items.
 */
export function DrawerItemList(props: DrawerContentComponentProps): VNode {
  const { state, navigation, descriptors } = props;
  const actions = useContext(DrawerActionsContext);
  const focused = descriptors[state.routes[state.index]?.key]?.options ?? {};
  return h(
    Fragment,
    null,
    ...state.routes.map((route, i) => {
      const o = descriptors[route.key]?.options ?? {};
      const isFocused = i === state.index;
      const label = o.drawerLabel !== undefined
        ? o.drawerLabel
        : o.title !== undefined
        ? o.title
        : route.name;
      return h(DrawerItem, {
        key: route.key,
        label: label as DrawerItemProps["label"],
        icon: o.drawerIcon as DrawerItemProps["icon"],
        focused: isFocused,
        activeTintColor: focused.drawerActiveTintColor as string | undefined,
        inactiveTintColor: focused.drawerInactiveTintColor as string | undefined,
        activeBackgroundColor: focused.drawerActiveBackgroundColor as string | undefined,
        inactiveBackgroundColor: focused.drawerInactiveBackgroundColor as string | undefined,
        labelStyle: o.drawerLabelStyle,
        style: o.drawerItemStyle,
        testID: o.drawerItemTestID as string | undefined,
        onPress: () => {
          const event = navigation.emit({
            type: "drawerItemPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (event.defaultPrevented) return;
          navigation.dispatch({
            ...(isFocused
              ? actions.drawer.closeDrawer()
              : actions.navigate(route.name, route.params)),
            target: state.key,
          });
        },
      });
    }),
  );
}

/** {@linkcode DrawerContentScrollView} props. */
export interface DrawerContentScrollViewProps {
  /** The content container's style. */
  contentContainerStyle?: unknown;
  /** The scroll view's style. */
  style?: unknown;
  /** The content. */
  children?: VNodeChildren;
  /** The ref (forwarded to the scroll view). */
  ref?: unknown;
  /** Other scroll view props. */
  [prop: string]: unknown;
}

/**
 * A scroll view for drawer content, padded by the safe-area insets on the drawer's side.
 *
 * @param props The scroll view props.
 * @returns The scroll view.
 */
export function DrawerContentScrollView(props: DrawerContentScrollViewProps): VNode {
  const { contentContainerStyle, style, children, ...rest } = props;
  const position = useContext(DrawerPositionContext);
  const insets = useSafeAreaInsets();
  const padding = {
    paddingTop: 12 + insets.top,
    paddingBottom: 12 + insets.bottom,
    paddingLeft: 12 + (position === "left" ? insets.left : 0),
    paddingRight: 12 + (position === "right" ? insets.right : 0),
  };
  if (RN.ScrollView) {
    return h(RN.ScrollView, {
      ...rest,
      style: [{ flex: 1 }, style],
      contentContainerStyle: [padding, contentContainerStyle],
    }, children as never);
  }
  return h(
    "div",
    { ...rest, style: viewStyle(style, { flex: 1, overflowY: "auto" }) },
    h("div", { style: viewStyle(contentContainerStyle, padding) }, children as never),
  );
}

/**
 * The default drawer content: a {@linkcode DrawerContentScrollView} holding the
 * {@linkcode DrawerItemList}, styled by the focused screen's `drawerContentStyle` /
 * `drawerContentContainerStyle`.
 *
 * @param props The navigator's state, navigation and descriptors.
 * @returns The content.
 */
export function DrawerContent(props: DrawerContentComponentProps): VNode {
  const { state, descriptors } = props;
  const o = descriptors[state.routes[state.index]?.key]?.options ?? {};
  return h(
    DrawerContentScrollView,
    { contentContainerStyle: o.drawerContentContainerStyle, style: o.drawerContentStyle },
    h(DrawerItemList, { ...props }),
  );
}

// ---- the drawer ----------------------------------------------------------------------------

/** {@linkcode Drawer} props (`react-native-drawer-layout`'s `Drawer`). */
export interface DrawerProps {
  /** Whether the drawer is open. */
  open: boolean;
  /** Asked to open (a swipe). */
  onOpen: () => void;
  /** Asked to close (the overlay, a drag, Escape, back). */
  onClose: () => void;
  /** The drawer's content. */
  renderDrawerContent: () => VNodeChildren;
  /** Which side (default `"left"`). */
  drawerPosition?: DrawerPosition;
  /** How the drawer and the screens move (default `"front"`). */
  drawerType?: DrawerType;
  /** The drawer panel's style (`width` sets its width; default `min(80%, 320px)`). */
  drawerStyle?: unknown;
  /** The overlay's style. */
  overlayStyle?: unknown;
  /** The overlay's colour (default `rgba(0, 0, 0, 0.5)`). */
  overlayColor?: string;
  /** The overlay's accessible label (default "Close drawer"). */
  overlayAccessibilityLabel?: string;
  /** Whether swiping opens and closes it (default `true`). */
  swipeEnabled?: boolean;
  /** How far from the edge, in px, an opening swipe may start (default 32). */
  swipeEdgeWidth?: number;
  /** Movement, in px, before a swipe is decided (default 10). */
  swipeMinDistance?: number;
  /** `"on-drag"` blurs the focused field when a swipe starts. */
  keyboardDismissMode?: "none" | "on-drag";
  /** The container style. */
  style?: unknown;
  /** A swipe started. */
  onGestureStart?: () => void;
  /** A swipe ended (either way). */
  onGestureEnd?: () => void;
  /** A swipe was abandoned. */
  onGestureCancel?: () => void;
  /** An open or close transition started (`closing` says which). */
  onTransitionStart?: (closing: boolean) => void;
  /** An open or close transition ended. */
  onTransitionEnd?: (closing: boolean) => void;
  /** The screens. */
  children?: VNodeChildren;
  /** Other props (`hideStatusBarOnOpen`, `configureGestureHandler`, …): ignored. */
  [prop: string]: unknown;
}

/** The transition's duration, in ms. */
const DURATION = 250;

/** A swipe in flight. */
interface Swipe {
  readonly x0: number;
  readonly y0: number;
  readonly from: number;
  locked: boolean;
  width: number;
  readonly tracker: VelocityTracker;
  readonly pointerId: number;
}

/** The latest props, read by handlers and effects without re-subscribing. */
type LatestProps = { current: DrawerProps };

/** Report transitions, and close on Escape and Android back while open. */
function useDrawerLifecycle(latest: LatestProps, open: boolean, permanent: boolean): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (permanent) return;
    latest.current.onTransitionStart?.(!open);
    const t = setTimeout(() => latest.current.onTransitionEnd?.(!open), DURATION);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open || permanent) return;
    const doc = (globalThis as { document?: Document }).document;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") latest.current.onClose();
    };
    doc?.addEventListener?.("keydown", onKey);
    const offBack = onBack(() => {
      latest.current.onClose();
      return true;
    });
    return () => {
      doc?.removeEventListener?.("keydown", onKey);
      offBack();
    };
  }, [open, permanent]);
}

/**
 * Decide whether a swipe that has moved (`dx` towards opening, `dy`) becomes a drag:
 * `"wait"` below the minimum distance, `"cancel"` when it goes the wrong way, else it locks
 * (and starts the gesture).
 */
function lockSwipe(
  s: Swipe,
  dx: number,
  dy: number,
  e: PointerEvent,
  p: DrawerProps,
): "wait" | "cancel" | "locked" {
  if (Math.hypot(dx, dy) < (p.swipeMinDistance ?? 10)) return "wait";
  if (Math.abs(dx) < Math.abs(dy) || (s.from === 0 && dx < 0) || (s.from === 1 && dx > 0)) {
    p.onGestureCancel?.();
    return "cancel";
  }
  s.locked = true;
  p.onGestureStart?.();
  if (p.keyboardDismissMode === "on-drag") {
    (globalThis as { document?: { activeElement?: { blur?: () => void } } }).document
      ?.activeElement?.blur?.();
  }
  (e.currentTarget as { setPointerCapture?: (id: number) => void } | null)
    ?.setPointerCapture?.(s.pointerId);
  return "locked";
}

/** What the swipe handlers need. */
interface SwipeOptions {
  readonly latest: LatestProps;
  readonly open: boolean;
  readonly permanent: boolean;
  readonly right: boolean;
  readonly drag: number | null;
  readonly setDrag: (value: number | null) => void;
  readonly panelWidth: () => number;
}

/** The pointer handlers of the edge swipe that opens and the drag that closes the drawer. */
function useDrawerSwipe(o: SwipeOptions) {
  const swipe = useRef<Swipe | null>(null);
  const dir = o.right ? -1 : 1;
  const onPointerDown = (e: PointerEvent) => {
    const p = o.latest.current;
    if (o.permanent || p.swipeEnabled === false) return;
    const target = e.currentTarget as HTMLElement | null;
    const rect = target?.getBoundingClientRect?.() ?? { left: 0, width: 0 };
    const fromEdge = o.right ? rect.left + rect.width - e.clientX : e.clientX - rect.left;
    if (!o.open && fromEdge > (p.swipeEdgeWidth ?? 32)) return;
    const tracker = new VelocityTracker();
    tracker.add(e.timeStamp ?? 0, e.clientX, e.clientY);
    swipe.current = {
      x0: e.clientX,
      y0: e.clientY,
      from: o.open ? 1 : 0,
      locked: false,
      width: o.panelWidth(),
      tracker,
      pointerId: e.pointerId,
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = swipe.current;
    if (!s) return;
    const dx = (e.clientX - s.x0) * dir;
    s.tracker.add(e.timeStamp ?? 0, e.clientX, e.clientY);
    if (!s.locked) {
      const state = lockSwipe(s, dx, e.clientY - s.y0, e, o.latest.current);
      if (state === "cancel") swipe.current = null;
      if (state !== "locked") return;
    }
    o.setDrag(clamp(s.from + dx / s.width, 0, 1));
  };
  const onPointerUp = () => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !s.locked) return;
    const opens = releaseSwipe(o.drag ?? s.from, s.tracker.velocity().x * dir) === "commit";
    o.setDrag(null);
    const p = o.latest.current;
    p.onGestureEnd?.();
    if (opens && !o.open) p.onOpen();
    else if (!opens && o.open) p.onClose();
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

/** The panel's base style for a drawer type, side and progress. */
function panelBaseStyle(
  drawerType: string,
  right: boolean,
  progress: number,
  transition: string,
): Record<string, unknown> {
  if (drawerType === "permanent") return { width: 280, maxWidth: "100%", flexShrink: 0, zIndex: 1 };
  const shift = (1 - progress) * 100 * (right ? 1 : -1);
  const rounded = right
    ? { borderTopLeftRadius: 16, borderBottomLeftRadius: 16 }
    : { borderTopRightRadius: 16, borderBottomRightRadius: 16 };
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    [right ? "right" : "left"]: 0,
    width: "min(80%, 320px)",
    zIndex: drawerType === "back" ? 0 : 2,
    transform: drawerType === "back" ? "none" : `translateX(${shift}%)`,
    transition,
    backgroundColor: "#fff",
    ...(drawerType === "front" ? rounded : {}),
  };
}

/** The overlay over the content that closes the drawer when tapped. */
function drawerOverlay(
  props: DrawerProps,
  latest: LatestProps,
  progress: number,
  transition: string,
): VNode {
  return h("div", {
    role: "button",
    tabIndex: -1,
    "aria-label": props.overlayAccessibilityLabel ?? "Close drawer",
    "aria-hidden": progress === 0 ? "true" : undefined,
    "data-denext-drawer-overlay": "",
    onClick: () => latest.current.onClose(),
    style: viewStyle(props.overlayStyle, {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: props.overlayColor ?? "rgba(0, 0, 0, 0.5)",
      opacity: progress,
      pointerEvents: progress === 0 ? "none" : "auto",
      transition,
    }),
  });
}

/** The content's style: moved by the panel's width for the `back` and `slide` types. */
function contentStyle(
  drawerType: string,
  right: boolean,
  progress: number,
  width: number,
  transition: string,
): unknown {
  const moves = drawerType === "back" || drawerType === "slide";
  return viewStyle(null, {
    flex: 1,
    zIndex: 1,
    transform: moves ? `translateX(${progress * width * (right ? -1 : 1)}px)` : "none",
    transition,
    backgroundColor: drawerType === "back" ? "#fff" : undefined,
  });
}

/**
 * A drawer layout: `react-native-drawer-layout`'s `Drawer` for the web. The panel slides in
 * over, under or beside the content; an overlay, Escape and the Android back button close it,
 * and a swipe from the edge opens it.
 *
 * @param props The open state, callbacks, content and styling.
 * @returns The layout.
 */
export function Drawer(props: DrawerProps): VNode {
  const { open, drawerPosition = "left", drawerType = "front" } = props;
  const latest = useRef(props);
  latest.current = props;
  const permanent = drawerType === "permanent";
  const right = drawerPosition === "right";
  const [drag, setDrag] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const progress = drawerProgress(permanent, drag, open);
  const progressValue = useMemo<DrawerProgress>(() => ({ value: progress }), [progress]);
  useDrawerLifecycle(latest, open, permanent);
  const panelWidth = () => panelRef.current?.getBoundingClientRect().width || 280;
  const handlers = useDrawerSwipe({ latest, open, permanent, right, drag, setDrag, panelWidth });
  const animate = drag === null && !prefersReducedMotion();
  const layout: DrawerLayout = {
    drawerType,
    drawerPosition,
    right,
    permanent,
    progress,
    transition: animate ? `transform ${DURATION}ms ease, opacity ${DURATION}ms ease` : "none",
  };
  const panel = drawerPanel(props, layout, panelRef);
  const width = panelRef.current ? panelWidth() : 280;
  const content = drawerContentView(props, layout, latest, width);
  const panelFirst = permanent || drawerType === "back";
  return h(
    DrawerProgressContext,
    { value: progressValue },
    h(
      hostView(),
      {
        "data-denext-drawer-layout": "",
        ...handlers,
        style: viewStyle(props.style, layoutStyle(permanent, right)),
      },
      ...(panelFirst ? [panel, content] : [content, panel]),
    ),
  );
}

/** The drawer's layout facts, shared by its parts. */
interface DrawerLayout {
  readonly drawerType: string;
  readonly drawerPosition: DrawerPosition;
  readonly right: boolean;
  readonly permanent: boolean;
  readonly progress: number;
  readonly transition: string;
}

/** How open the drawer is, 0–1: always 1 when permanent, else the drag or the open state. */
function drawerProgress(permanent: boolean, drag: number | null, open: boolean): number {
  if (permanent) return 1;
  return drag ?? (open ? 1 : 0);
}

/** The layout view's style. */
function layoutStyle(permanent: boolean, right: boolean): Record<string, unknown> {
  const row = right ? "row-reverse" : "row";
  return {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    flexDirection: permanent ? row : "column",
    touchAction: "pan-y",
  };
}

/** The drawer panel: the drawer content, inert while fully closed. */
function drawerPanel(
  props: DrawerProps,
  layout: DrawerLayout,
  panelRef: { current: HTMLElement | null },
): VNode {
  const hidden = !layout.permanent && layout.progress === 0;
  const base = panelBaseStyle(layout.drawerType, layout.right, layout.progress, layout.transition);
  return h(
    hostView(),
    {
      ref: panelRef,
      role: "navigation",
      "data-denext-drawer": props.open ? "open" : "closed",
      "aria-hidden": hidden ? "true" : undefined,
      inert: hidden ? "" : undefined,
      style: viewStyle(props.drawerStyle, base),
    },
    h(
      DrawerPositionContext,
      { value: layout.drawerPosition },
      props.renderDrawerContent() as never,
    ),
  );
}

/** The content view, with the overlay unless the drawer is permanent. */
function drawerContentView(
  props: DrawerProps,
  layout: DrawerLayout,
  latest: LatestProps,
  width: number,
): VNode {
  const type = layout.permanent ? "front" : layout.drawerType;
  return h(
    hostView(),
    {
      "data-denext-drawer-content": "",
      style: contentStyle(type, layout.right, layout.progress, width, layout.transition),
    },
    props.children as never,
    layout.permanent ? null : drawerOverlay(props, latest, layout.progress, layout.transition),
  );
}

// ---- the navigator view --------------------------------------------------------------------

/** The actions the drawer views dispatch. */
interface DrawerActionsValue {
  readonly drawer: DrawerActionCreators;
  navigate(name: string, params?: object): object;
}

/** The enclosing navigator's action creators (the app's core's, or the built-ins). */
const DrawerActionsContext: Context<DrawerActionsValue> = /* @__PURE__ */ createContext<
  DrawerActionsValue
>({
  drawer: BUILTIN_ACTIONS,
  navigate: (name, params) => ({ type: "NAVIGATE", payload: { name, params } }),
});

/** {@linkcode DrawerView} props. */
export interface DrawerViewProps extends DrawerContentComponentProps {
  /** The status the drawer returns to on back (default `"closed"`). */
  defaultStatus?: DrawerStatus;
  /** Render the drawer's content (default {@linkcode DrawerContent}). */
  drawerContent?: (props: DrawerContentComponentProps) => VNodeChildren;
  /** Ignored (inactive screens stay mounted, hidden). */
  detachInactiveScreens?: boolean;
  /** Other navigator props. */
  [prop: string]: unknown;
}

/** One screen's header. */
function DrawerHeader(
  props: {
    options: Record<string, unknown>;
    route: DrawerRoute;
    navigation: unknown;
    position: DrawerPosition;
  },
): VNode {
  const { options: o, route, position } = props;
  const tint = o.headerTintColor as string | undefined;
  const toggle = () => h(DrawerToggleButton, { tintColor: tint });
  const left = o.headerLeft != null
    ? slot(o.headerLeft, { tintColor: tint })
    : position === "left"
    ? toggle()
    : null;
  const rightSlot = o.headerRight != null
    ? slot(o.headerRight, { tintColor: tint })
    : position === "right"
    ? toggle()
    : null;
  const titleText = typeof o.title === "string" ? o.title : route.name;
  const title = typeof o.headerTitle === "function"
    ? (o.headerTitle as (a: unknown) => VNodeChildren)({ children: titleText, tintColor: tint })
    : typeof o.headerTitle === "string"
    ? o.headerTitle
    : titleText;
  return h(
    hostView(),
    {
      role: "banner",
      "data-denext-drawer-header": "",
      style: viewStyle(o.headerStyle, {
        flexDirection: "row",
        alignItems: "center",
        minHeight: 56,
        paddingHorizontal: 4,
        backgroundColor: "#fff",
        borderBottomWidth: 1,
        borderBottomColor: "rgba(0,0,0,0.12)",
        borderStyle: "solid",
      }),
    },
    left ?? null,
    h(
      textHost(),
      {
        role: "heading",
        "aria-level": 1,
        style: viewStyle(o.headerTitleStyle, {
          flex: 1,
          fontSize: 18,
          fontWeight: "600",
          color: tint,
          paddingHorizontal: 12,
        }),
      },
      title as never,
    ),
    rightSlot ?? null,
  );
}

/**
 * The drawer navigator's view: a {@linkcode Drawer} whose content is `drawerContent` and whose
 * children are the visited screens (the focused one shown), each with its header.
 *
 * @param props The navigator's state, navigation, descriptors and view props.
 * @returns The view.
 */
export function DrawerView(props: DrawerViewProps): VNode {
  const {
    state,
    navigation,
    descriptors,
    defaultStatus = "closed",
    drawerContent = (p: DrawerContentComponentProps) => h(DrawerContent, { ...p }),
  } = props;
  const actions = useContext(DrawerActionsContext);
  const focusedKey = state.routes[state.index]?.key ?? "";
  const o = descriptors[focusedKey]?.options ?? {};
  useRouteAnnouncer(
    focusedKey,
    typeof o.title === "string"
      ? o.title
      : typeof o.drawerLabel === "string"
      ? o.drawerLabel
      : state.routes[state.index]?.name,
  );
  const loaded = useRef(new Set<string>());
  loaded.current.add(focusedKey);
  const status = getDrawerStatusFromState({ ...state, history: state.history ?? [] });
  const drawerPosition = (o.drawerPosition as DrawerPosition | undefined) ?? "left";
  const dispatch = useCallback(
    (action: object) => navigation.dispatch({ ...action, target: state.key }),
    [navigation, state.key],
  );
  const controller = useMemo<DrawerController>(() => ({
    toggle: () => dispatch(actions.drawer.toggleDrawer()),
  }), [dispatch, actions]);
  const emit = (type: string, data?: unknown) => navigation.emit({ type, target: state.key, data });
  const screens = state.routes.filter((r) => loaded.current.has(r.key)).map((route) => {
    const d = descriptors[route.key];
    const so = d?.options ?? {};
    const focused = route.key === focusedKey;
    const header = so.headerShown === false
      ? null
      : typeof so.header === "function"
      ? (so.header as (a: unknown) => VNodeChildren)({
        options: so,
        route,
        navigation: d?.navigation,
      })
      : h(DrawerHeader, {
        options: so,
        route,
        navigation: d?.navigation,
        position: drawerPosition,
      });
    return h(
      hostView(),
      {
        key: route.key,
        "data-denext-drawer-screen": route.key,
        "aria-hidden": focused ? undefined : "true",
        style: viewStyle(so.sceneStyle, {
          flex: 1,
          display: focused ? "flex" : "none",
        }),
      },
      header as never,
      h(hostView(), { style: viewStyle(null, { flex: 1 }) }, d?.render() as never),
    );
  });
  return h(
    DrawerControllerContext,
    { value: controller },
    h(
      DrawerStatusContext,
      { value: status },
      h(Drawer, {
        open: status !== "closed",
        onOpen: () => dispatch(actions.drawer.openDrawer()),
        onClose: () => dispatch(actions.drawer.closeDrawer()),
        onGestureStart: () => emit("gestureStart"),
        onGestureEnd: () => emit("gestureEnd"),
        onGestureCancel: () => emit("gestureCancel"),
        onTransitionStart: (closing: boolean) => emit("transitionStart", { closing }),
        onTransitionEnd: (closing: boolean) => emit("transitionEnd", { closing }),
        drawerPosition,
        drawerType: (o.drawerType as DrawerType | undefined) ?? "front",
        drawerStyle: o.drawerStyle,
        overlayStyle: o.overlayStyle,
        overlayColor: o.overlayColor as string | undefined,
        overlayAccessibilityLabel: o.overlayAccessibilityLabel as string | undefined,
        swipeEnabled: o.swipeEnabled as boolean | undefined,
        swipeEdgeWidth: o.swipeEdgeWidth as number | undefined,
        swipeMinDistance: o.swipeMinDistance as number | undefined,
        keyboardDismissMode: o.keyboardDismissMode as "none" | "on-drag" | undefined,
        renderDrawerContent: () => drawerContent({ state, navigation, descriptors }),
        defaultStatus,
      }, ...screens),
    ),
  );
}

// ---- the navigator factory -----------------------------------------------------------------

/** The navigator props the builder takes (everything else is for the view). */
const BUILDER_KEYS = [
  "id",
  "initialRouteName",
  "defaultStatus",
  "backBehavior",
  "UNSTABLE_routeNamesChangeBehavior",
  "children",
  "layout",
  "screenListeners",
  "screenOptions",
  "screenLayout",
  "UNSTABLE_router",
] as const;

/** What {@linkcode drawerNavigatorExports} returns. */
export interface DrawerNavigatorExports {
  /** `createDrawerNavigator`, drawn by {@linkcode DrawerView}. */
  createDrawerNavigator: (config?: unknown) => unknown;
}

/**
 * Build `createDrawerNavigator` from the app's React Navigation core. React Native mode's
 * generated `@react-navigation/drawer` module calls it with `@react-navigation/native`.
 *
 * @param core React Navigation's core (`import * as core from "@react-navigation/native"`).
 * @returns `{ createDrawerNavigator }`.
 */
export function drawerNavigatorExports(core: DrawerNavigationCore): DrawerNavigatorExports {
  const actions: DrawerActionsValue = {
    drawer: core.DrawerActions ?? BUILTIN_ACTIONS,
    navigate: (name, params) =>
      core.CommonActions?.navigate(name, params) ??
        { type: "NAVIGATE", payload: { name, params } },
  };
  function DenextDrawerNavigator(props: Record<string, unknown>): VNode {
    const options: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if ((BUILDER_KEYS as readonly string[]).includes(k)) options[k] = v;
      else rest[k] = v;
    }
    options.defaultStatus ??= "closed";
    const built = core.useNavigationBuilder(core.DrawerRouter, options);
    const view = h(
      DrawerActionsContext,
      { value: actions },
      h(DrawerView, {
        ...rest,
        defaultStatus: options.defaultStatus as DrawerStatus,
        state: built.state,
        navigation: built.navigation,
        descriptors: built.descriptors,
      }),
    );
    if (built.NavigationContent) return h(built.NavigationContent as never, null, view);
    return h(Fragment, null, (built.render ? built.render(view) : view) as never);
  }
  return { createDrawerNavigator: core.createNavigatorFactory(DenextDrawerNavigator) };
}
