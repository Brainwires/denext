/**
 * `expo-navigation-bar` for denext: Android's navigation bar over `denext/mobile`'s
 * {@linkcode setSystemBars} (Capacitor 8's `SystemBars` in the native shell: `denext mobile
 * add system-bars`), limited to the navigation bar. `style` names the buttons' color, as
 * `expo-status-bar` does (`"light"` buttons for a dark app, `"auto"` the opposite of the page's
 * color scheme); `setVisibilityAsync` hides and shows the bar. The visibility is what this
 * module last set (no native visibility events: a swipe that reveals a hidden bar is not
 * reported). Outside the Android shell the calls do nothing and the bar reads `"hidden"`, as
 * Expo's web build.
 *
 * @example
 * ```ts
 * import * as NavigationBar from "denext/expo/navigation-bar";
 *
 * NavigationBar.setStyle("dark");
 * await NavigationBar.setVisibilityAsync("hidden");
 * ```
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { setSystemBars, watchScheme } from "../mobile/system-bars.ts";
import { createEmitter, type Emitter, type Subscription } from "./internal/common.ts";

export type { Subscription };

/** The navigation bar's visibility. */
export type NavigationBarVisibility = "visible" | "hidden";

/** What a visibility listener receives. */
export type NavigationBarVisibilityEvent = {
  /** The visibility. */
  visibility: NavigationBarVisibility;
  /** Android's raw system-UI flags (0 here). */
  rawVisibility: number;
};

/** The buttons' color: `"light"`, `"dark"`, `"auto"` or `"inverted"`. */
export type NavigationBarStyle = "auto" | "inverted" | "light" | "dark";

/** Props of {@linkcode NavigationBar}. */
export type NavigationBarProps = {
  /** The buttons' color. */
  style?: NavigationBarStyle;
  /** Hide the bar. */
  hidden?: boolean;
};

/** Whether this is the Android shell, where the calls reach the bar. */
function onAndroid(): boolean {
  return nativePlatform() === "android";
}

/** The page's color scheme now (`"light"` without a document). */
function currentScheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  let scheme: "light" | "dark" = "light";
  watchScheme((s) => void (scheme = s))();
  return scheme;
}

/** The theme the bar sits over for a buttons' `style` (SystemBars' style). */
function barTheme(style: NavigationBarStyle, scheme: "light" | "dark"): "light" | "dark" {
  const buttons = style === "auto"
    ? (scheme === "light" ? "dark" : "light")
    : style === "inverted"
    ? scheme
    : style;
  return buttons === "light" ? "dark" : "light";
}

/**
 * Set the buttons' color now (Android shell only).
 *
 * @param style The buttons' color.
 */
export function setStyle(style: NavigationBarStyle): void {
  if (!onAndroid()) return;
  setSystemBars({ style: barTheme(style, currentScheme()), bar: "navigation" }).catch(() => {});
}

/** The visibility last set (made on first use). */
let visibility: NavigationBarVisibility | undefined;
/** The visibility listeners (made on first use). */
let emitter: Emitter<NavigationBarVisibilityEvent> | undefined;

/** The visibility now: what was last set, `"visible"` in the Android shell until then. */
function currentVisibility(): NavigationBarVisibility {
  return visibility ?? (onAndroid() ? "visible" : "hidden");
}

/**
 * Hide or show the bar (Android shell only).
 *
 * @param next The visibility.
 * @returns Settles once applied.
 */
export async function setVisibilityAsync(next: NavigationBarVisibility): Promise<void> {
  if (!onAndroid()) return;
  await setSystemBars({ hidden: next === "hidden", bar: "navigation" });
  if (visibility === next) return;
  visibility = next;
  emitter?.emit({ visibility: next, rawVisibility: 0 });
}

/**
 * The bar's visibility (what this module last set).
 *
 * @returns The visibility.
 */
export function getVisibilityAsync(): Promise<NavigationBarVisibility> {
  return Promise.resolve(currentVisibility());
}

/**
 * Listen for visibility changes made through {@linkcode setVisibilityAsync}.
 *
 * @param listener Called with each change.
 * @returns The subscription.
 */
export function addVisibilityListener(
  listener: (event: NavigationBarVisibilityEvent) => void,
): Subscription {
  return (emitter ??= createEmitter()).subscribe(listener);
}

/**
 * The bar's visibility, updated on each change (null until read).
 *
 * @returns The visibility, or null before the first read.
 */
export function useVisibility(): NavigationBarVisibility | null {
  const [value, setValue] = useState<NavigationBarVisibility | null>(null);
  useEffect(() => {
    setValue(currentVisibility());
    const sub = addVisibilityListener((e) => setValue(e.visibility));
    return () => sub.remove();
  }, []);
  return value;
}

/** Hide or show the bar now (Android shell only). */
function setHidden(hidden: boolean): void {
  setVisibilityAsync(hidden ? "hidden" : "visible").catch(() => {});
}

/**
 * The navigation bar's `style` and `hidden`, applied while mounted. Renders nothing.
 *
 * @param props The style and visibility.
 * @returns null.
 */
function NavigationBarView(props: NavigationBarProps): null {
  useEffect(() => {
    if (props.style !== undefined) setStyle(props.style);
  }, [props.style]);
  useEffect(() => {
    if (props.hidden !== undefined) setHidden(props.hidden);
  }, [props.hidden]);
  return null;
}

/** The {@linkcode NavigationBar} component with its static forms. */
export interface NavigationBarComponent {
  /**
   * Apply the props while mounted.
   *
   * @param props The style and visibility.
   * @returns null.
   */
  (props: NavigationBarProps): null;
  /** Set the buttons' color now. */
  setStyle: (style: NavigationBarStyle) => void;
  /** Hide or show the bar now. */
  setHidden: (hidden: boolean) => void;
}

/** The navigation bar as a component, with `setStyle` / `setHidden`. */
export const NavigationBar: NavigationBarComponent = /* @__PURE__ */ Object.assign(
  NavigationBarView,
  { setStyle, setHidden },
);
