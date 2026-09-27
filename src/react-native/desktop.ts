/**
 * `react-native-windows` and `react-native-macos` for React Native mode: what those packages add
 * to React Native (Windows' `Flyout`, `Popup`, `Glyph`, `AppTheme`, `supportKeyboard`,
 * `EventPhase`; macOS' `DynamicColorMacOS` and `ColorWithSystemEffectMacOS`; both packages'
 * desktop `View` props), over react-native-web, for an app that runs in a browser or a Deno
 * Desktop window. React Native mode resolves either package to a module that re-exports
 * `react-native` (react-native-web with the shell overlay) and these; the components are built
 * over react-native-web's own components, which that module passes in.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useEffect, useRef } from "../runtime/hooks.ts";
import {
  type EmitterSubscription,
  handlerSubscriptions,
  mediaMatches,
  watchMedia,
} from "./internal.ts";
import { DynamicColorIOS, type DynamicColorIOSTuple } from "./platform-color.ts";

/** Which desktop package a {@linkcode createDesktopView} stands in for (their key semantics differ). */
export type DesktopFlavor = "windows" | "macos";

/** A key a desktop `View` handles (`keyDownEvents` / `keyUpEvents`; macOS' legacy strings too). */
export interface HandledKeyEvent {
  /** macOS: the key (`"Enter"`, `"a"`). */
  readonly key?: string;
  /** Windows: the key code (`"Enter"`, `"KeyA"`). */
  readonly code?: string;
  /** Alt / Option held. */
  readonly altKey?: boolean;
  /** Control held. */
  readonly ctrlKey?: boolean;
  /** Command / Windows key held. */
  readonly metaKey?: boolean;
  /** Shift held. */
  readonly shiftKey?: boolean;
  /** Windows: the phase to handle it in (accepted; the web handles it on bubbling). */
  readonly handledEventPhase?: number;
}

/** The desktop `View` props React Native mode maps; any other prop goes to the `View`. */
export interface DesktopViewProps {
  /** A tooltip: the element's `title`. */
  readonly tooltip?: string;
  /** Called on a double click. */
  readonly onDoubleClick?: (event: unknown) => void;
  /** Called on a key press (see `keyDownEvents`). */
  readonly onKeyDown?: (event: unknown) => void;
  /** Called on a key release (see `keyUpEvents`). */
  readonly onKeyUp?: (event: unknown) => void;
  /** The keys this view handles on key down. */
  readonly keyDownEvents?: readonly (HandledKeyEvent | string)[];
  /** The keys this view handles on key up. */
  readonly keyUpEvents?: readonly (HandledKeyEvent | string)[];
  /** macOS' legacy `keyDownEvents`: key names. */
  readonly validKeysDown?: readonly (HandledKeyEvent | string)[];
  /** macOS' legacy `keyUpEvents`: key names. */
  readonly validKeysUp?: readonly (HandledKeyEvent | string)[];
  /** `false` hides the keyboard focus ring (the browser's `:focus-visible` outline). */
  readonly enableFocusRing?: boolean;
  /** macOS: accepted; a web view has no first-mouse behaviour (dev warning). */
  readonly acceptsFirstMouse?: boolean;
  /** macOS: accepted; the page cannot move the window (dev warning). */
  readonly mouseDownCanMoveWindow?: boolean;
  /** macOS: accepted; no vibrancy in a web view (dev warning). */
  readonly allowsVibrancy?: boolean;
  /** macOS: accepted; drag and drop of files into a view is not mapped (dev warning). */
  readonly draggedTypes?: unknown;
  /** The view's style. */
  readonly style?: unknown;
  /** A ref to the view. */
  readonly ref?: unknown;
  /** The content. */
  readonly children?: VNodeChildren;
  /** Any other `View` prop. */
  readonly [prop: string]: unknown;
}

/** The desktop props a web view cannot honour, warned about once each in dev. */
const NO_OP_PROPS = [
  "acceptsFirstMouse",
  "mouseDownCanMoveWindow",
  "allowsVibrancy",
  "draggedTypes",
];

/** No-op props already warned about. */
let warnedProps: Set<string> | undefined;

/** Warn (once per prop, in dev) about desktop props that do nothing here. */
function warnNoOps(props: Readonly<Record<string, unknown>>): void {
  const g = globalThis as { __DEV__?: boolean };
  if (g.__DEV__ === false) return;
  for (const name of NO_OP_PROPS) {
    if (props[name] === undefined || (warnedProps ??= new Set()).has(name)) continue;
    warnedProps.add(name);
    console.warn(
      `denext reactNative: the desktop View prop \`${name}\` has no web equivalent; ignored.`,
    );
  }
}

/** The key fields of a DOM keyboard event (or its `nativeEvent`). */
interface KeyFields {
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  preventDefault?: () => void;
}

/** Whether `event` is the handled key `spec` (a key name, or a key / code with modifiers). */
function matchesKey(event: KeyFields, spec: HandledKeyEvent | string): boolean {
  if (typeof spec === "string") return event.key === spec || event.code === spec;
  if (spec.key !== undefined && spec.key !== event.key) return false;
  if (spec.code !== undefined && spec.code !== event.code) return false;
  if (spec.key === undefined && spec.code === undefined) return false;
  return (["altKey", "ctrlKey", "metaKey", "shiftKey"] as const).every((m) =>
    (spec[m] ?? false) === (event[m] ?? false)
  );
}

/**
 * A key handler honouring the handled-key list: a listed key is handled (its default action
 * prevented) and passed on; an unlisted one reaches the handler on Windows (which only marks
 * listed keys handled) and not on macOS (which sends only the listed keys to JS). Without a
 * list the handler sees every key.
 */
function keyHandler(
  handler: ((event: unknown) => void) | undefined,
  keys: readonly (HandledKeyEvent | string)[] | undefined,
  flavor: DesktopFlavor,
): ((event: unknown) => void) | undefined {
  if (!keys || keys.length === 0) return handler;
  return (event) => {
    const fields = ((event as { nativeEvent?: KeyFields })?.nativeEvent ?? event) as KeyFields;
    const listed = keys.some((k) => matchesKey(fields, k));
    if (listed) (event as KeyFields).preventDefault?.();
    if (listed || flavor === "windows") handler?.(event);
  };
}

/** The DOM element behind a ref value (react-native-web's host refs are elements). */
type HostElement = {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
};

/** Set `ref` (a callback or an object ref) to `node`. */
function forwardRef(ref: unknown, node: unknown): void {
  if (typeof ref === "function") ref(node);
  else if (ref !== null && typeof ref === "object") Reflect.set(ref, "current", node);
}

/** `tooltip` as the element's `title`, and `onDoubleClick` as a `dblclick` listener. */
function useHostProps(
  node: { current: HostElement | null },
  tooltip: string | undefined,
  onDoubleClick: ((event: unknown) => void) | undefined,
): void {
  const dbl = useRef(onDoubleClick);
  dbl.current = onDoubleClick;
  const wantsDbl = onDoubleClick !== undefined;
  useEffect(() => {
    const el = node.current;
    if (typeof el?.setAttribute !== "function") return;
    if (tooltip) el.setAttribute("title", tooltip);
    else el.removeAttribute("title");
  }, [tooltip]);
  useEffect(() => {
    const el = node.current;
    if (!wantsDbl || typeof el?.addEventListener !== "function") return;
    const listener = (e: Event) => {
      if (!("nativeEvent" in e)) Object.defineProperty(e, "nativeEvent", { value: e });
      dbl.current?.(e);
    };
    el.addEventListener("dblclick", listener);
    return () => el.removeEventListener("dblclick", listener);
  }, [wantsDbl]);
}

/**
 * The desktop `View` (`react-native-windows`' and `react-native-macos`' `View`) over
 * react-native-web's `View`:
 *
 * - `tooltip` → the element's `title` (the browser's tooltip);
 * - `onDoubleClick` → a `dblclick` listener (the event carries `nativeEvent`);
 * - `keyDownEvents` / `keyUpEvents` (and macOS' legacy `validKeysDown` / `validKeysUp`) → a
 *   key filter on `onKeyDown` / `onKeyUp`: a listed key (by `key` on macOS, `code` on
 *   Windows, with its modifiers) has its default action prevented; macOS passes only listed
 *   keys to the handler, Windows passes every key;
 * - `enableFocusRing={false}` → no focus outline (otherwise the browser's `:focus-visible` ring);
 * - `acceptsFirstMouse`, `mouseDownCanMoveWindow`, `allowsVibrancy`, `draggedTypes` → accepted,
 *   with a dev warning once each (a web view has no equivalent).
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @param flavor Which package's key semantics to follow.
 * @returns The component.
 */
export function createDesktopView(
  View: VNodeType,
  flavor: DesktopFlavor,
): ((props: DesktopViewProps) => VNode) & { readonly forceTouchAvailable: boolean } {
  function DesktopView(props: DesktopViewProps): VNode {
    const {
      tooltip,
      onDoubleClick,
      onKeyDown,
      onKeyUp,
      keyDownEvents,
      keyUpEvents,
      validKeysDown,
      validKeysUp,
      enableFocusRing,
      acceptsFirstMouse: _acceptsFirstMouse,
      mouseDownCanMoveWindow: _mouseDownCanMoveWindow,
      allowsVibrancy: _allowsVibrancy,
      draggedTypes: _draggedTypes,
      ref,
      style,
      ...rest
    } = props;
    warnNoOps(props);
    const node = useRef<HostElement | null>(null);
    useHostProps(node, tooltip, onDoubleClick);
    const down = keyHandler(onKeyDown, keyDownEvents ?? validKeysDown, flavor);
    const up = keyHandler(onKeyUp, keyUpEvents ?? validKeysUp, flavor);
    return h(View, {
      ...rest,
      ...(down ? { onKeyDown: down } : {}),
      ...(up ? { onKeyUp: up } : {}),
      ref: (el: HostElement | null) => {
        node.current = el;
        forwardRef(ref, el);
      },
      style: enableFocusRing === false ? [style, { outlineStyle: "none" }] : style,
    });
  }
  return Object.assign(DesktopView, { forceTouchAvailable: false });
}

/** Where a `Flyout` opens relative to its target (Windows' `FlyoutPlacementMode`). */
export type Placement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "full"
  | "top-edge-aligned-left"
  | "top-edge-aligned-right"
  | "bottom-edge-aligned-left"
  | "bottom-edge-aligned-right"
  | "left-edge-aligned-top"
  | "right-edge-aligned-top"
  | "left-edge-aligned-bottom"
  | "right-edge-aligned-bottom";

/** Props of `Flyout` and `Popup`. */
export interface FlyoutProps {
  /** Whether it is open. */
  readonly isOpen?: boolean;
  /** Called when it closes by a tap outside or Escape (Flyout: with `false`). */
  readonly onDismiss?: (isOpen?: boolean) => void;
  /** The element (or a ref to it) it opens against; centred without one. */
  readonly target?: unknown;
  /** Flyout: where it opens (default `"top"`). */
  readonly placement?: Placement;
  /** A tap outside closes it (Flyout default `true`, Popup default `false`). */
  readonly isLightDismissEnabled?: boolean;
  /** Flyout: dim the page behind it. */
  readonly isOverlayEnabled?: boolean;
  /** px added horizontally. */
  readonly horizontalOffset?: number;
  /** px added vertically. */
  readonly verticalOffset?: number;
  /** Accepted (focus moves into the dialog anyway). */
  readonly autoFocus?: boolean;
  /** Accepted. */
  readonly shouldConstrainToRootBounds?: boolean;
  /** Accepted. */
  readonly showMode?: string;
  /** The content's style. */
  readonly style?: unknown;
  /** The content. */
  readonly children?: VNodeChildren;
  /** Any other `View` prop, for the content. */
  readonly [prop: string]: unknown;
}

/** The rectangle of `target` (an element, or a ref to one), or null. */
function targetRect(target: unknown): DOMRectReadOnly | null {
  const el = (target && typeof target === "object" && "current" in target)
    ? (target as { current: unknown }).current
    : target;
  const measurable = el as { getBoundingClientRect?: () => DOMRectReadOnly } | null;
  return typeof measurable?.getBoundingClientRect === "function"
    ? measurable.getBoundingClientRect()
    : null;
}

/** A position style: `left` / `top` px plus a percentage shift of the content's own size. */
function at(left: number, top: number, dx: number, dy: number): Record<string, unknown> {
  return {
    position: "absolute",
    left,
    top,
    transform: [{ translateX: `${dx}%` }, { translateY: `${dy}%` }],
  };
}

/** Where the content goes for `placement` against `r` (see {@linkcode Placement}). */
function placeAt(r: DOMRectReadOnly, placement: Placement): Record<string, unknown> {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const table: Record<Placement, [number, number, number, number]> = {
    top: [cx, r.top, -50, -100],
    bottom: [cx, r.bottom, -50, 0],
    left: [r.left, cy, -100, -50],
    right: [r.right, cy, 0, -50],
    full: [0, 0, 0, 0],
    "top-edge-aligned-left": [r.left, r.top, 0, -100],
    "top-edge-aligned-right": [r.right, r.top, -100, -100],
    "bottom-edge-aligned-left": [r.left, r.bottom, 0, 0],
    "bottom-edge-aligned-right": [r.right, r.bottom, -100, 0],
    "left-edge-aligned-top": [r.left, r.top, -100, 0],
    "right-edge-aligned-top": [r.right, r.top, 0, 0],
    "left-edge-aligned-bottom": [r.left, r.bottom, -100, -100],
    "right-edge-aligned-bottom": [r.right, r.bottom, 0, -100],
  };
  const [left, top, dx, dy] = table[placement] ?? table.top;
  return at(left, top, dx, dy);
}

/** The content's position for a Flyout (`placement`) or a Popup (the target's top-left). */
function contentPosition(props: FlyoutProps, kind: "flyout" | "popup"): Record<string, unknown> {
  const h0 = props.horizontalOffset ?? 0;
  const v0 = props.verticalOffset ?? 0;
  if (kind === "flyout" && props.placement === "full") {
    return { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 };
  }
  const r = targetRect(props.target);
  const base = !r
    ? at(0, 0, -50, -50)
    : kind === "popup"
    ? at(r.left, r.top, 0, 0)
    : placeAt(r, props.placement ?? "top");
  if (!r) {
    return { ...base, left: "50%", top: "50%", marginLeft: h0, marginTop: v0 };
  }
  return { ...base, left: (base.left as number) + h0, top: (base.top as number) + v0 };
}

/** The full-window layer that catches a tap outside. */
const BACKDROP = { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } as const;

/** Build `Flyout` or `Popup` over react-native-web's `Modal` and `View`. */
function createAnchored(
  Modal: VNodeType,
  View: VNodeType,
  kind: "flyout" | "popup",
): (props: FlyoutProps) => VNode {
  function Anchored(props: FlyoutProps): VNode {
    const {
      isOpen,
      onDismiss,
      target: _target,
      placement: _placement,
      isLightDismissEnabled,
      isOverlayEnabled,
      horizontalOffset: _h,
      verticalOffset: _v,
      autoFocus: _autoFocus,
      shouldConstrainToRootBounds: _constrain,
      showMode: _showMode,
      style,
      children,
      ...rest
    } = props;
    const lightDismiss = isLightDismissEnabled ?? kind === "flyout";
    const dismiss = () => kind === "flyout" ? onDismiss?.(false) : onDismiss?.();
    return h(
      Modal,
      { visible: isOpen === true, transparent: true, onRequestClose: dismiss },
      h(View, {
        style: [BACKDROP, isOverlayEnabled ? { backgroundColor: "rgba(0,0,0,0.3)" } : null],
        onClick: lightDismiss ? dismiss : undefined,
        "data-denext-flyout-backdrop": "",
      }),
      isOpen === true
        ? h(View, { ...rest, style: [contentPosition(props, kind), style] }, children)
        : null,
    );
  }
  return Anchored;
}

/**
 * `react-native-windows`' `Flyout` over react-native-web's `Modal` and `View`: while `isOpen`,
 * its content opens against `target` (an element or a ref; centred without one) at
 * `placement` (default `"top"`; `"full"` fills the window) moved by `horizontalOffset` /
 * `verticalOffset`, above a layer that closes it on a tap outside (`isLightDismissEnabled`,
 * default `true`; `isOverlayEnabled` dims it). Escape closes it too. Closing calls
 * `onDismiss(false)`; the app sets `isOpen` back, as on Windows.
 *
 * @param Modal react-native-web's `Modal`.
 * @param View react-native-web's `View`.
 * @returns The component.
 */
export function createFlyout(Modal: VNodeType, View: VNodeType): (props: FlyoutProps) => VNode {
  return createAnchored(Modal, View, "flyout");
}

/**
 * `react-native-windows`' `Popup` over react-native-web's `Modal` and `View`: while `isOpen`,
 * its content sits at `target`'s top-left corner (centred without a target) moved by
 * `horizontalOffset` / `verticalOffset`. A tap outside closes it only with
 * `isLightDismissEnabled`; Escape always does. Closing calls `onDismiss()`.
 *
 * @param Modal react-native-web's `Modal`.
 * @param View react-native-web's `View`.
 * @returns The component.
 */
export function createPopup(Modal: VNodeType, View: VNodeType): (props: FlyoutProps) => VNode {
  return createAnchored(Modal, View, "popup");
}

/** Props of `react-native-windows`' `Glyph`. */
export interface GlyphProps {
  /** The character(s) to draw. */
  readonly glyph: string;
  /** The font: a URI whose `#fragment` names the font family (`ms-appx:///Fonts/icons.ttf#Icons`). */
  readonly fontUri?: string;
  /** The size in px. */
  readonly emSize?: number;
  /** Accepted (colour fonts draw in colour on the web). */
  readonly colorEnabled?: boolean;
  /** The style (`color` colours the glyph). */
  readonly style?: unknown;
  /** Any other `Text` prop. */
  readonly [prop: string]: unknown;
}

/**
 * `react-native-windows`' `Glyph` as react-native-web's `Text`: `glyph` drawn at `emSize` px in
 * the family named by `fontUri`'s `#fragment` (load that font with `@font-face` or
 * `expo-font`); without a fragment, the style's `fontFamily`.
 *
 * @param Text react-native-web's `Text`.
 * @returns The component.
 */
export function createGlyph(Text: VNodeType): (props: GlyphProps) => VNode {
  function Glyph(props: GlyphProps): VNode {
    const { glyph, fontUri, emSize, colorEnabled: _colorEnabled, style, ...rest } = props;
    const family = typeof fontUri === "string" ? fontUri.split("#")[1] : undefined;
    return h(Text, {
      ...rest,
      style: [{
        ...(emSize !== undefined ? { fontSize: emSize } : {}),
        ...(family ? { fontFamily: family } : {}),
      }, style],
    }, glyph);
  }
  return Glyph;
}

/** Windows' high-contrast palette, as `AppTheme` reports it. */
export interface HighContrastColors {
  /** A button's face. */
  readonly ButtonFaceColor: string;
  /** A button's text. */
  readonly ButtonTextColor: string;
  /** Disabled text. */
  readonly GrayTextColor: string;
  /** A selection. */
  readonly HighlightColor: string;
  /** Selected text. */
  readonly HighlightTextColor: string;
  /** A hyperlink. */
  readonly HotlightColor: string;
  /** The window background. */
  readonly WindowColor: string;
  /** Text on the window. */
  readonly WindowTextColor: string;
}

/** What a `highContrastChanged` listener receives. */
export interface HighContrastChangedEvent {
  /** Whether high contrast is on now. */
  readonly isHighContrast: boolean;
  /** The palette. */
  readonly highContrastColors: HighContrastColors;
}

/** `react-native-windows`' `AppTheme`. */
export interface AppThemeStatic {
  /** Whether a high-contrast (forced colors) theme is on. */
  readonly isHighContrast: boolean;
  /** The high-contrast palette, as CSS system colors. */
  readonly currentHighContrastColors: HighContrastColors;
  /** Listen for high contrast turning on or off. */
  addListener(
    eventName: "highContrastChanged",
    listener: (event: HighContrastChangedEvent) => void,
  ): EmitterSubscription;
  /** Stop a listener. */
  removeListener(
    eventName: "highContrastChanged",
    listener: (event: HighContrastChangedEvent) => void,
  ): void;
}

/** The forced-colors media query that is Windows' high contrast on the web. */
const FORCED_COLORS = "(forced-colors: active)";

/** The high-contrast palette as CSS system colors (the browser resolves them to the theme's). */
const HIGH_CONTRAST_COLORS: HighContrastColors = {
  ButtonFaceColor: "ButtonFace",
  ButtonTextColor: "ButtonText",
  GrayTextColor: "GrayText",
  HighlightColor: "Highlight",
  HighlightTextColor: "HighlightText",
  HotlightColor: "LinkText",
  WindowColor: "Canvas",
  WindowTextColor: "CanvasText",
};

/** The registrations by listener, for `removeListener`. */
let themeSubs: ReturnType<typeof handlerSubscriptions> | undefined;

/**
 * `react-native-windows`' `AppTheme`: `isHighContrast` is `(forced-colors: active)` (Windows'
 * high-contrast themes turn it on in WebView2 and Edge), `currentHighContrastColors` the CSS
 * system colors the theme paints with, and `highContrastChanged` follows the media query. For
 * light / dark, use `Appearance` / `useColorScheme()`, as current `react-native-windows` does.
 *
 * @example
 * ```ts
 * import { AppTheme } from "react-native-windows";
 *
 * const sub = AppTheme.addListener("highContrastChanged", (e) => setHighContrast(e.isHighContrast));
 * ```
 */
export const AppTheme: AppThemeStatic = {
  get isHighContrast() {
    return mediaMatches(FORCED_COLORS);
  },
  currentHighContrastColors: HIGH_CONTRAST_COLORS,
  addListener(_eventName, listener) {
    const stop = watchMedia(
      FORCED_COLORS,
      (on) => listener({ isHighContrast: on, highContrastColors: HIGH_CONTRAST_COLORS }),
    );
    return (themeSubs ??= handlerSubscriptions()).track(listener, stop);
  },
  removeListener(_eventName, listener) {
    themeSubs?.removeAll(listener);
  },
};

/**
 * `react-native-windows`' `supportKeyboard(Component)`: the component itself. react-native-web
 * components already take `onKeyDown` / `onKeyUp`, and React Native mode's desktop `View`
 * takes `keyDownEvents` / `keyUpEvents`.
 *
 * @param Component The component to give keyboard props.
 * @returns The same component.
 */
export function supportKeyboard<C>(Component: C): C {
  return Component;
}

/** `react-native-windows`' `EventPhase` (a keyboard event's phase). */
export const EventPhase: {
  readonly None: 0;
  readonly Capturing: 1;
  readonly AtTarget: 2;
  readonly Bubbling: 3;
} = { None: 0, Capturing: 1, AtTarget: 2, Bubbling: 3 };

/** `react-native-windows`' `HandledEventPhase` (the phases a handled key can name). */
export const HandledEventPhase: { readonly Capturing: 1; readonly Bubbling: 3 } = {
  Capturing: 1,
  Bubbling: 3,
};

/**
 * `react-native-macos`' `DynamicColorMacOS({ light, dark, highContrastLight?, highContrastDark? })`:
 * one CSS color for light and dark mode, as `DynamicColorIOS` (see there).
 *
 * @param tuple The colors.
 * @returns The CSS color.
 */
export function DynamicColorMacOS(tuple: DynamicColorIOSTuple): string {
  return DynamicColorIOS(tuple);
}

/** What `ColorWithSystemEffectMacOS` applies. */
export type SystemEffectMacOS = "none" | "pressed" | "deepPressed" | "disabled" | "rollover";

/** How each effect mixes the color, as CSS `color-mix()` (AppKit darkens / fades it alike). */
const EFFECT_MIX: Readonly<Record<SystemEffectMacOS, string | null>> = {
  none: null,
  pressed: "black 20%",
  deepPressed: "black 35%",
  disabled: "transparent 50%",
  rollover: "white 10%",
};

/**
 * `react-native-macos`' `ColorWithSystemEffectMacOS(color, effect)`: `color` as AppKit draws it
 * for a control `effect`, as a CSS `color-mix()` (`pressed` / `deepPressed` darken it,
 * `disabled` fades it, `rollover` lightens it, `none` leaves it).
 *
 * @param color The base CSS color.
 * @param effect The system effect.
 * @returns The CSS color.
 */
export function ColorWithSystemEffectMacOS(color: string, effect: SystemEffectMacOS): string {
  const mix = EFFECT_MIX[effect];
  return mix ? `color-mix(in srgb, ${String(color)}, ${mix})` : String(color);
}
