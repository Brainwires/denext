/**
 * System bars for `denext/mobile`: the status bar and the navigation / gesture bar, through the
 * `SystemBars` plugin that `@capacitor/core` 8 bundles (no npm package; `denext mobile add
 * system-bars` sets up the native side). On the web the browser owns its chrome, so these do
 * nothing there.
 *
 * @module
 */

import { useEffect } from "../runtime/hooks.ts";
import { isNativeShell } from "./bridge.ts";
import { nativePlugin } from "./plugin.ts";

/**
 * The theme the system bars sit over: `"light"` (a light app, so dark icons and text),
 * `"dark"` (a dark app, so light icons and text) or `"auto"` (the device's appearance). This
 * is Capacitor's `SystemBarsStyle`; note that `expo-status-bar`'s `style` names the content's
 * color instead, the opposite way round.
 */
export type SystemBarsStyle = "light" | "dark" | "auto";

/** One of the system bars: the top status bar, or the navigation / gesture bar at the bottom. */
export type SystemBar = "status" | "navigation";

/** What {@linkcode setSystemBars} changes; a field left out is left as it is. */
export interface SystemBarsOptions {
  /** The theme the bars sit over (see {@linkcode SystemBarsStyle}). */
  readonly style?: SystemBarsStyle;
  /** Hide (`true`) or show (`false`) the bars. */
  readonly hidden?: boolean;
  /** How the status bar hides and shows on iOS: `"fade"` (the default) or `"none"`. */
  readonly animation?: "fade" | "none";
  /** Change only this bar (default: both). */
  readonly bar?: SystemBar;
}

/** The JS side of `@capacitor/core`'s bundled `SystemBars` plugin. */
interface SystemBarsPlugin {
  setStyle(options: { style: "LIGHT" | "DARK" | "DEFAULT"; bar?: string }): Promise<void>;
  show(options?: { bar?: string; animation?: "FADE" | "NONE" }): Promise<void>;
  hide(options?: { bar?: string; animation?: "FADE" | "NONE" }): Promise<void>;
  setAnimation?(options: { animation: "FADE" | "NONE" }): Promise<void>;
}

const STYLES = { light: "LIGHT", dark: "DARK", auto: "DEFAULT" } as const;
const BARS = { status: "StatusBar", navigation: "NavigationBar" } as const;
const ANIMATIONS = { fade: "FADE", none: "NONE" } as const;

/** `options` checked; throws a `TypeError` naming the first bad field. */
function checkOptions(options: SystemBarsOptions): void {
  const bad = (field: string, value: unknown) =>
    new TypeError(`setSystemBars: unknown ${field} "${String(value)}"`);
  if (options.style !== undefined && !Object.hasOwn(STYLES, options.style)) {
    throw bad("style", options.style);
  }
  if (options.bar !== undefined && !Object.hasOwn(BARS, options.bar)) throw bad("bar", options.bar);
  if (options.animation !== undefined && !Object.hasOwn(ANIMATIONS, options.animation)) {
    throw bad("animation", options.animation);
  }
}

/**
 * Style, hide or show the system bars.
 *
 * Inside the native shell this calls Capacitor 8's `SystemBars` plugin, part of
 * `@capacitor/core` (no plugin to install): `style` becomes `setStyle`, `hidden` becomes
 * `hide` / `show` (with `animation`, iOS only), and `bar` limits both to one bar. On iOS the
 * app needs `UIViewControllerBasedStatusBarAppearance` in Info.plist, which `denext mobile add
 * system-bars` writes. On the web it does nothing: the browser owns its toolbars (set a
 * `theme-color` meta for their tint).
 *
 * @param options What to change.
 * @returns A promise that settles once the plugin applied it. It rejects with a `TypeError`
 * for an unknown `style`, `bar` or `animation`, or if the plugin rejects.
 * @example
 * ```ts
 * import { setSystemBars } from "denext/mobile";
 *
 * await setSystemBars({ style: "dark" }); // light icons over a dark header
 * await setSystemBars({ hidden: true, bar: "status", animation: "none" }); // full-screen video
 * ```
 */
export async function setSystemBars(options: SystemBarsOptions): Promise<void> {
  checkOptions(options);
  const plugin = nativePlugin<SystemBarsPlugin>("SystemBars", ["setStyle", "show", "hide"]);
  if (!plugin) return;
  const bar = options.bar === undefined ? {} : { bar: BARS[options.bar] };
  const animation = options.animation === undefined
    ? {}
    : { animation: ANIMATIONS[options.animation] };
  if (options.style !== undefined) await plugin.setStyle({ style: STYLES[options.style], ...bar });
  if (options.hidden !== undefined) {
    await (options.hidden ? plugin.hide : plugin.show).call(plugin, { ...bar, ...animation });
  } else if (animation.animation !== undefined && typeof plugin.setAnimation === "function") {
    await plugin.setAnimation({ animation: animation.animation });
  }
}

/** A single `light` / `dark` color-scheme value, else undefined (`normal`, `light dark`, …). */
function singleScheme(value: string | undefined): "light" | "dark" | undefined {
  const scheme = (value ?? "").replace(/^only\s+/, "").trim();
  return scheme === "light" || scheme === "dark" ? scheme : undefined;
}

/**
 * The scheme the page renders in: the root element's `color-scheme` when it names one (an
 * app's theme toggle, React Native's `Appearance.setColorScheme` in denext's react-native
 * mode), else the system's `prefers-color-scheme`.
 */
function pageScheme(media: MediaQueryList | undefined): "light" | "dark" {
  const root = document.documentElement;
  const computed = typeof getComputedStyle === "function"
    ? getComputedStyle(root).colorScheme
    : undefined;
  return singleScheme(root.style?.colorScheme) ?? singleScheme(computed) ??
    (media?.matches ? "dark" : "light");
}

/**
 * Report the page's scheme now and whenever it changes; returns a stop function. Internal to
 * `denext/mobile` (the `expo-status-bar` shim follows it too); not re-exported.
 */
export function watchScheme(onScheme: (scheme: "light" | "dark") => void): () => void {
  const media = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : undefined;
  let last: "light" | "dark" | undefined;
  const update = () => {
    const scheme = pageScheme(media);
    if (scheme === last) return;
    last = scheme;
    onScheme(scheme);
  };
  media?.addEventListener?.("change", update);
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver(update)
    : undefined;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme"],
  });
  update();
  return () => {
    media?.removeEventListener?.("change", update);
    observer?.disconnect();
  };
}

/**
 * Keep the system bars' style matching the app's light / dark theme while the component is
 * mounted: `dark` bars over a dark theme, `light` bars over a light one. With a `scheme`
 * argument that is the theme; without one it follows the page, re-applied on every change:
 * the root element's `color-scheme` when it names one (a theme toggle that sets it, or React
 * Native's `Appearance.setColorScheme` in react-native mode), else the system's
 * `prefers-color-scheme`. Only the native shell has system bars to style; elsewhere, and during
 * SSR, it does nothing.
 *
 * @param scheme The app's theme, when the app decides it (omit or `null` to follow the page).
 * @example
 * ```tsx
 * "use client";
 * import { useSystemBarsFollowTheme } from "denext/mobile";
 *
 * export function ThemeSync({ theme }: { theme?: "light" | "dark" }) {
 *   useSystemBarsFollowTheme(theme);
 *   return null;
 * }
 * ```
 */
export function useSystemBarsFollowTheme(scheme?: "light" | "dark" | null): void {
  useEffect(() => {
    if (!isNativeShell() || typeof document === "undefined") return;
    const apply = (style: "light" | "dark") => void setSystemBars({ style }).catch(() => {});
    if (scheme === "light" || scheme === "dark") return void apply(scheme);
    return watchScheme(apply);
  }, [scheme]);
}
