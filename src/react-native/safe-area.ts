/**
 * Safe areas for React Native mode, from `denext/mobile`'s one inset source (Capacitor 8's
 * injected `--safe-area-inset-*` on Android, where Android WebView before 140 reports wrong
 * `env()` values, else `env(safe-area-inset-*)`):
 *
 * - {@linkcode createSafeAreaView}: React Native's `SafeAreaView` over react-native-web's
 *   `View` (react-native-web's pads with `env()` only);
 * - {@linkcode createNativeSafeAreaProvider}: `react-native-safe-area-context`'s web
 *   `NativeSafeAreaProvider`, reporting `denext/mobile`'s `useSafeAreaInsets()`.
 *
 * Both are 0 unless the viewport meta has `viewport-fit=cover`, which React Native mode's SPA
 * shell writes by default.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren, VNodeType } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { listenAll, type SafeAreaInsets, useSafeAreaInsets } from "../mobile/safe-area.ts";

/** A side's inset as CSS: Capacitor's injected value, else `env()`, else `0px`. */
function inset(side: "top" | "right" | "bottom" | "left"): string {
  return `var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px))`;
}

/** Props of React Native's `SafeAreaView`: a `View`'s. */
export interface SafeAreaViewProps {
  /** The view's style; its padding is replaced by the insets, as react-native-web does. */
  readonly style?: unknown;
  /** The content. */
  readonly children?: VNodeChildren;
  /** Any other `View` prop. */
  readonly [prop: string]: unknown;
}

/**
 * React Native's `SafeAreaView` over react-native-web's `View`: a `View` padded by the device's
 * safe-area insets (the notch, status bar and home indicator), as React Native's iOS one is.
 * The padding is `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))`, the same source as
 * `denext/mobile`'s `useSafeAreaInsets()`: Capacitor 8's injected value on Android (correct
 * where Android WebView before 140 reports wrong `env()` insets), else `env()`. Being CSS, it
 * is right on the first frame and follows rotation without a re-render. A `style` padding
 * sits under the insets' (react-native-web's order).
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @returns The component.
 */
export function createSafeAreaView(View: VNodeType): (props: SafeAreaViewProps) => VNode {
  const padding = {
    paddingTop: inset("top"),
    paddingRight: inset("right"),
    paddingBottom: inset("bottom"),
    paddingLeft: inset("left"),
  };
  function SafeAreaView(props: SafeAreaViewProps): VNode {
    const { style, children, ...rest } = props;
    return h(View, { ...rest, style: [padding, style] }, children);
  }
  return SafeAreaView;
}

/** A frame in viewport coordinates, as `react-native-safe-area-context` reports it. */
export interface SafeAreaFrame {
  /** The left edge, in viewport px. */
  readonly x: number;
  /** The top edge, in viewport px. */
  readonly y: number;
  /** The width in px. */
  readonly width: number;
  /** The height in px. */
  readonly height: number;
}

/** What `NativeSafeAreaProvider`'s `onInsetsChange` receives. */
export interface InsetsChangeEvent {
  /** The insets (clamped to the view) and the view frame. */
  readonly nativeEvent: { readonly insets: SafeAreaInsets; readonly frame: SafeAreaFrame };
}

/** Props of `react-native-safe-area-context`'s `NativeSafeAreaProvider`. */
export interface NativeSafeAreaProviderProps {
  /** The content. */
  readonly children?: VNodeChildren;
  /** The provider view's style. */
  readonly style?: unknown;
  /** Called with the insets (clamped to the view) and the view's frame on every change. */
  readonly onInsetsChange?: (event: InsetsChangeEvent) => void;
  /** A ref to the provider view. */
  readonly ref?: unknown;
  /** Any other `View` prop (`testID`, …), passed through. */
  readonly [prop: string]: unknown;
}

/**
 * `insets` clamped to the part of the window edge the view overlaps, and the view's frame
 * (the window's when the view cannot be measured), as the package's own web provider does.
 */
function measure(view: unknown, insets: SafeAreaInsets): InsetsChangeEvent["nativeEvent"] {
  const g = globalThis as {
    innerWidth?: number;
    innerHeight?: number;
    document?: { documentElement?: { offsetWidth?: number; offsetHeight?: number } };
  };
  const el = view as { getBoundingClientRect?: () => DOMRectReadOnly } | null;
  if (typeof el?.getBoundingClientRect !== "function") {
    const root = g.document?.documentElement;
    return {
      insets,
      frame: { x: 0, y: 0, width: root?.offsetWidth ?? 0, height: root?.offsetHeight ?? 0 },
    };
  }
  const rect = el.getBoundingClientRect();
  const width = g.innerWidth ?? rect.right;
  const height = g.innerHeight ?? rect.bottom;
  return {
    insets: {
      top: Math.max(0, insets.top - rect.top),
      right: Math.max(0, insets.right - (width - rect.right)),
      bottom: Math.max(0, insets.bottom - (height - rect.bottom)),
      left: Math.max(0, insets.left - rect.left),
    },
    frame: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

/** A counter bumped when `view` resizes or the window does, so the provider re-measures. */
function useResizeTick(view: { current: unknown }): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const off = listenAll(globalThis, ["resize", "orientationchange"], bump);
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const observer = typeof Observer === "function" && view.current ? new Observer(bump) : null;
    observer?.observe(view.current as Element);
    return () => {
      off();
      observer?.disconnect();
    };
  }, []);
  return tick;
}

/**
 * `react-native-safe-area-context`'s web `NativeSafeAreaProvider` over react-native-web's
 * `View`, reporting `denext/mobile`'s `useSafeAreaInsets()`: the package's own web provider
 * reads `env(safe-area-inset-*)` only, which Android WebView before 140 gets wrong. It calls
 * `onInsetsChange({ nativeEvent: { insets, frame } })` with the insets clamped to the part of
 * the window edge the view overlaps and the view's frame, as the package's provider does, each
 * time the insets change or the view or window resizes; so the package's `SafeAreaProvider`,
 * `useSafeAreaInsets`, `useSafeAreaFrame` and `SafeAreaView` all read denext's insets.
 * React Native mode swaps it in for the package's `NativeSafeAreaProvider.web.js`.
 *
 * @param View react-native-web's `View` (React Native mode passes it in).
 * @returns The component.
 */
export function createNativeSafeAreaProvider(
  View: VNodeType,
): (props: NativeSafeAreaProviderProps) => VNode {
  function NativeSafeAreaProvider(props: NativeSafeAreaProviderProps): VNode {
    const { children, style, onInsetsChange, ref, ...rest } = props;
    const insets = useSafeAreaInsets();
    const view = useRef<unknown>(null);
    const tick = useResizeTick(view);
    const report = useRef(onInsetsChange);
    report.current = onInsetsChange;
    useEffect(() => {
      report.current?.({ nativeEvent: measure(view.current, insets) });
    }, [insets.top, insets.right, insets.bottom, insets.left, tick]);
    // The provider's own ref, then the caller's (a callback or an object ref).
    const setRef = (node: unknown) => {
      view.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref !== null && typeof ref === "object") Reflect.set(ref, "current", node);
    };
    return h(View, { ...rest, ref: setRef, style }, children);
  }
  return NativeSafeAreaProvider;
}
