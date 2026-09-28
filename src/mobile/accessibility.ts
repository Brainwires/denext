/**
 * Accessibility state for `denext/mobile`, read from denext's native `DenextAccessibility` plugin
 * (`denext mobile add accessibility`):
 *
 * - whether VoiceOver (iOS) or TalkBack (Android) is on. The web has no API that reveals a
 *   screen reader, so there (and in a shell without the plugin) it reads `false` and never
 *   changes;
 * - the OS text size (Dynamic Type on iOS, the font scale on Android) as the factor the page
 *   still has to apply itself: {@linkcode getFontScale}, {@linkcode useFontScale} and the opt-in
 *   {@linkcode applyFontScale}. A browser applies its user's text size to `rem` on its own, so
 *   the factor is 1 there;
 * - whether the user asked for reduced motion ({@linkcode useReducedMotion}), which WebKit and
 *   Chrome report from the OS setting through `prefers-reduced-motion`, in the shell as on the
 *   web.
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** A font scale answer or event: the OS scale, and (Android) the WebView's text zoom in percent. */
interface FontScaleEvent {
  value?: number;
  textZoom?: number;
}

/** The JS side of the `DenextAccessibility` plugin: `{ value }` answers and events. */
interface AccessibilityPlugin {
  isScreenReaderEnabled(): Promise<{ value?: boolean }>;
  getFontScale?(): Promise<FontScaleEvent>;
  addListener(
    eventName: "screenReaderChanged" | "fontScaleChanged",
    listener: (event: { value?: boolean } & FontScaleEvent) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The native plugin, when the shell has it. */
function accessibilityPlugin(): AccessibilityPlugin | undefined {
  return nativePlugin<AccessibilityPlugin>("DenextAccessibility", [
    "isScreenReaderEnabled",
    "addListener",
  ]);
}

/**
 * Whether a screen reader is on: VoiceOver on iOS, a touch-exploration service (TalkBack) on
 * Android, through the `DenextAccessibility` plugin that `denext mobile add accessibility`
 * installs. On the web, during SSR, in a shell without the plugin, or when the plugin fails, it
 * resolves `false`.
 *
 * @returns Whether a screen reader is running.
 * @example
 * ```ts
 * import { isScreenReaderEnabled } from "denext/mobile";
 *
 * if (await isScreenReaderEnabled()) carousel.stopAutoplay();
 * ```
 */
export async function isScreenReaderEnabled(): Promise<boolean> {
  const plugin = accessibilityPlugin();
  if (!plugin) return false;
  try {
    return (await plugin.isScreenReaderEnabled())?.value === true;
  } catch {
    return false;
  }
}

/**
 * Call `callback` with the new state whenever the screen reader is turned on or off; returns a
 * function that stops listening. Without the native plugin (the web, SSR) it never fires and the
 * returned function does nothing.
 *
 * @param callback Called with `true` when a screen reader starts, `false` when it stops.
 * @returns A function that removes the listener.
 * @example
 * ```ts
 * import { onScreenReaderChange } from "denext/mobile";
 *
 * const stop = onScreenReaderChange((on) => document.body.classList.toggle("sr", on));
 * ```
 */
export function onScreenReaderChange(callback: (enabled: boolean) => void): () => void {
  const plugin = accessibilityPlugin();
  if (!plugin) return () => {};
  return listenerDisposer(
    plugin.addListener("screenReaderChanged", (event) => callback(event?.value === true)),
  );
}

/**
 * Hook form: whether a screen reader is on, read on mount and kept current until unmount. It is
 * `false` before the first answer (and always on the web), so render the sighted layout first and
 * let the screen-reader one replace it.
 *
 * @returns Whether a screen reader is running.
 * @example
 * ```tsx
 * "use client";
 * import { useScreenReader } from "denext/mobile";
 *
 * export function Slides({ items }: { items: string[] }) {
 *   const screenReader = useScreenReader();
 *   return screenReader ? <ol>{items.map((i) => <li key={i}>{i}</li>)}</ol> : <Carousel items={items} />;
 * }
 * ```
 */
export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    const stop = onScreenReaderChange((on) => {
      changed = true;
      if (active) setEnabled(on);
    });
    // The first read loses to any change event that beats it.
    isScreenReaderEnabled().then((on) => active && !changed && setEnabled(on));
    return () => {
      active = false;
      stop();
    };
  }, []);
  return enabled;
}

// --- reduced motion ----------------------------------------------------------------------------

/** The `prefers-reduced-motion: reduce` query, or undefined without `matchMedia` (SSR). */
function reducedMotionQuery(): MediaQueryList | undefined {
  const mm = (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia;
  return typeof mm === "function" ? mm("(prefers-reduced-motion: reduce)") : undefined;
}

/**
 * Whether the user asked for reduced motion (iOS Reduce Motion, Android Remove animations, the
 * desktop setting), updated when it changes: `prefers-reduced-motion`, which the iOS and
 * Android WebViews report from the OS. `false` during SSR. The same answer as Reanimated's
 * `useReducedMotion` and React Native's `AccessibilityInfo.isReduceMotionEnabled()` in React
 * Native mode.
 *
 * @returns Whether to cut motion.
 * @example
 * ```tsx
 * "use client";
 * import { useReducedMotion } from "denext/mobile";
 *
 * export function Banner() {
 *   const reduce = useReducedMotion();
 *   return <div style={{ transition: reduce ? "none" : "transform 300ms" }} />;
 * }
 * ```
 */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    setReduce(query.matches);
    const onChange = () => setReduce(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduce;
}

// --- font scale --------------------------------------------------------------------------------

/** The page factor of a plugin answer: the OS scale over what the WebView already applies. */
function pageFactor(event: FontScaleEvent | undefined): number | null {
  const value = event?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const zoom = typeof event?.textZoom === "number" && event.textZoom > 0 ? event.textZoom / 100 : 1;
  return Math.round((value / zoom) * 1000) / 1000;
}

/** The last factor read (1 until then); what the synchronous readers see. */
let lastFontScale = 1;
/** The first read, started by the first synchronous reader. */
let fontScaleRead: Promise<number> | null = null;

/**
 * The OS text size as the factor the page must still apply itself: 1 at the default size.
 *
 * - iOS shell: the Dynamic Type size on React Native's scale (0.823 for "Extra Small" … 1.0 for
 *   the default "Large" … 3.571 for the largest accessibility size). A WKWebView does not scale
 *   the page by it, so the whole factor is the page's.
 * - Android shell: the system font scale divided by the WebView's text zoom, which the WebView
 *   already applies to all text (so usually 1).
 * - Web, Deno Desktop, SSR, a shell without the plugin: 1 (a browser applies its user's text
 *   size to `rem` itself).
 *
 * Needs `denext mobile add accessibility` (the `DenextAccessibility` plugin).
 *
 * @returns The factor (1 = the default size).
 * @example
 * ```ts
 * import { getFontScale } from "denext/mobile";
 *
 * const scale = await getFontScale(); // 1.353 at iOS's largest non-accessibility size
 * ```
 */
export async function getFontScale(): Promise<number> {
  const plugin = accessibilityPlugin();
  if (!plugin?.getFontScale) return 1;
  try {
    const factor = pageFactor(await plugin.getFontScale()) ?? 1;
    lastFontScale = factor;
    return factor;
  } catch {
    return 1;
  }
}

/**
 * The last font scale read, synchronously (1 until the first read answers; this starts one).
 * Internal: React Native mode's `PixelRatio.getFontScale()` and `Text` read it.
 *
 * @returns The factor.
 */
export function fontScaleNow(): number {
  fontScaleRead ??= getFontScale();
  return lastFontScale;
}

/**
 * Call `callback` with the new factor when the user changes the OS text size; returns a
 * function that stops listening. Without the plugin it never fires.
 *
 * @param callback Called with the new factor (see {@linkcode getFontScale}).
 * @returns A function that removes the listener.
 */
export function onFontScaleChange(callback: (scale: number) => void): () => void {
  const plugin = accessibilityPlugin();
  if (!plugin?.getFontScale) return () => {};
  return listenerDisposer(
    plugin.addListener("fontScaleChanged", (event) => {
      const factor = pageFactor(event);
      if (factor === null) return;
      lastFontScale = factor;
      callback(factor);
    }),
  );
}

/**
 * Hook form of {@linkcode getFontScale}: the factor, read on mount and kept current. It starts
 * at the last value read (1 before any), so the first render uses the default size.
 *
 * @returns The factor (1 = the default size).
 * @example
 * ```tsx
 * "use client";
 * import { useFontScale } from "denext/mobile";
 *
 * export function Title({ children }: { children: string }) {
 *   const scale = useFontScale();
 *   return <h1 style={{ fontSize: 28 * Math.min(scale, 2) }}>{children}</h1>;
 * }
 * ```
 */
export function useFontScale(): number {
  const [scale, setScale] = useState(lastFontScale);
  useEffect(() => {
    let active = true;
    let changed = false;
    const stop = onFontScaleChange((s) => {
      changed = true;
      if (active) setScale(s);
    });
    getFontScale().then((s) => active && !changed && setScale(s));
    return () => {
      active = false;
      stop();
    };
  }, []);
  return scale;
}

/** Options for {@linkcode applyFontScale}. */
export interface ApplyFontScaleOptions {
  /** The largest factor applied (default: none). */
  readonly max?: number;
  /** The smallest factor applied (default: none). */
  readonly min?: number;
  /** The element whose font size is scaled (default: `document.documentElement`). */
  readonly root?: HTMLElement;
}

/** `scale` within `options`' bounds. */
function clampScale(scale: number, options: ApplyFontScaleOptions): number {
  return Math.min(options.max ?? Infinity, Math.max(options.min ?? 0, scale));
}

/**
 * Opt in to the OS text size: scale the root element's font size (as the page's stylesheet
 * sets it when this is called) by {@linkcode getFontScale}'s factor, so everything sized in
 * `rem` / `em` follows Dynamic Type (iOS) and the font scale (Android), and keep it current. The factor is also set as the `--dnx-font-scale` custom
 * property, for sizes the page computes itself (`calc(15px * var(--dnx-font-scale))`). A
 * browser's own text-size setting already reaches `rem`, so on the web this sets nothing but
 * the property (1).
 *
 * @param options Bounds for the factor, and the element to scale.
 * @returns A function that stops following the OS and restores the element's font size.
 * @example
 * ```ts
 * import { applyFontScale } from "denext/mobile";
 *
 * applyFontScale({ max: 2 }); // once, early (the client entry or a root layout effect)
 * ```
 */
export function applyFontScale(options: ApplyFontScaleOptions = {}): () => void {
  const root = options.root ??
    (globalThis as { document?: { documentElement?: HTMLElement } }).document?.documentElement;
  if (!root?.style) return () => {};
  const before = root.style.fontSize;
  // The page's own root size (its stylesheet's, e.g. a 62.5% base), scaled from there.
  const computed = (globalThis as { getComputedStyle?: (el: Element) => { fontSize?: string } })
    .getComputedStyle?.(root)?.fontSize;
  const base = computed ? parseFloat(computed) : NaN;
  const set = (scale: number) => {
    const factor = clampScale(scale, options);
    root.style.setProperty("--dnx-font-scale", String(factor));
    if (factor === 1) root.style.fontSize = before;
    else if (Number.isFinite(base) && base > 0) {
      root.style.fontSize = `${Math.round(base * factor * 100) / 100}px`;
    } else root.style.fontSize = `${Math.round(factor * 10000) / 100}%`;
  };
  set(lastFontScale);
  let active = true;
  getFontScale().then((s) => active && set(s));
  const stop = onFontScaleChange((s) => active && set(s));
  return () => {
    active = false;
    stop();
    root.style.removeProperty("--dnx-font-scale");
    root.style.fontSize = before;
  };
}

/** Forget the last read font scale (tests). */
export function resetFontScaleForTesting(): void {
  lastFontScale = 1;
  fontScaleRead = null;
}
