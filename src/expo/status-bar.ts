/**
 * `expo-status-bar` for denext: Expo's `StatusBar` over React Native mode's `StatusBar`, which
 * drives Capacitor 8's `SystemBars` in the native shell (`denext mobile add system-bars`).
 * Expo's own web build of this package does nothing; here the status bar follows the app's
 * theme in the shell. In a browser, as there, nothing changes.
 *
 * `style` names the content's color: `"light"` (light icons, for a dark app), `"dark"`,
 * `"auto"` (the opposite of the page's color scheme: dark icons over a light theme) or
 * `"inverted"` (the page's scheme). The page's scheme is the root element's `color-scheme`
 * when it names one (React Native's `Appearance.setColorScheme` sets it), else the system's.
 *
 * @example
 * ```tsx
 * import { StatusBar } from "denext/expo/status-bar";
 *
 * export function Screen() {
 *   return <StatusBar style="auto" />;
 * }
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { useEffect, useState } from "../runtime/hooks.ts";
import { watchScheme } from "../mobile/system-bars.ts";
import {
  StatusBar as NativeStatusBar,
  type StatusBarStyle as BarStyle,
} from "../react-native/status-bar.ts";

/** The status bar content's color. */
export type StatusBarStyle = "auto" | "inverted" | "light" | "dark";

/** How the status bar hides and shows. */
export type StatusBarAnimation = "none" | "fade" | "slide";

/** Props of {@linkcode StatusBar}. */
export type StatusBarProps = {
  /** The content's color (default `"auto"`). */
  style?: StatusBarStyle;
  /** Animate style and visibility changes. */
  animated?: boolean;
  /** Hide the status bar. */
  hidden?: boolean;
  /** The hide / show animation. */
  hideTransitionAnimation?: StatusBarAnimation;
};

/** The page's color scheme now (`"light"` during SSR). */
function currentScheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  let scheme: "light" | "dark" = "light";
  watchScheme((s) => void (scheme = s))();
  return scheme;
}

/** The page's color scheme, updated on every change while mounted. */
function usePageScheme(): "light" | "dark" {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  useEffect(() => (typeof document === "undefined" ? undefined : watchScheme(setScheme)), []);
  return scheme;
}

/** Expo's style as React Native's `barStyle`, for the page's `scheme`. */
function barStyle(style: StatusBarStyle = "auto", scheme: "light" | "dark"): BarStyle {
  const resolved = style === "auto"
    ? (scheme === "light" ? "dark" : "light")
    : style === "inverted"
    ? (scheme === "light" ? "light" : "dark")
    : style;
  return resolved === "light" ? "light-content" : "dark-content";
}

/**
 * Set the status bar's content color now.
 *
 * @param style The content's color.
 * @param animated Animate the change.
 */
export function setStatusBarStyle(style: StatusBarStyle, animated?: boolean): void {
  NativeStatusBar.setBarStyle(barStyle(style, currentScheme()), animated);
}

/**
 * Hide or show the status bar now.
 *
 * @param hidden Whether to hide it.
 * @param animation The hide / show animation.
 */
export function setStatusBarHidden(hidden: boolean, animation?: StatusBarAnimation): void {
  NativeStatusBar.setHidden(hidden, animation);
}

/**
 * The status bar, while mounted: its `style` (following the page's color scheme for `"auto"`
 * and `"inverted"`), `hidden` and animations, stacked like React Native's `<StatusBar>` (the
 * newest mounted one wins). Renders nothing.
 *
 * @param props The status bar's props.
 * @returns The React Native mode `StatusBar` element.
 */
function StatusBarView(props: StatusBarProps): VNode {
  const scheme = usePageScheme();
  const { style, animated, hidden, hideTransitionAnimation } = props;
  return h(NativeStatusBar as unknown as VNodeType, {
    animated,
    hidden,
    barStyle: barStyle(style, scheme),
    showHideTransition: hideTransitionAnimation === "none" ? undefined : hideTransitionAnimation,
  });
}

/** The {@linkcode StatusBar} component with Expo's static forms. */
export interface StatusBarComponent {
  /**
   * Render the status bar's props while mounted.
   *
   * @param props The status bar's props.
   * @returns The React Native mode `StatusBar` element.
   */
  (props: StatusBarProps): VNode;
  /** Expo's static form of {@linkcode setStatusBarStyle}. */
  setStyle: typeof setStatusBarStyle;
  /** Expo's static form of {@linkcode setStatusBarHidden}. */
  setHidden: typeof setStatusBarHidden;
}

/**
 * The status bar, while mounted: its `style` (following the page's color scheme for `"auto"`
 * and `"inverted"`), `hidden` and animations, stacked like React Native's `<StatusBar>` (the
 * newest mounted one wins). Renders nothing. `StatusBar.setStyle` / `StatusBar.setHidden` are
 * Expo's static forms of {@linkcode setStatusBarStyle} / {@linkcode setStatusBarHidden}.
 */
export const StatusBar: StatusBarComponent = /* @__PURE__ */ Object.assign(StatusBarView, {
  setStyle: setStatusBarStyle,
  setHidden: setStatusBarHidden,
});
