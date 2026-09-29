/**
 * React Native's font scaling for React Native mode: the OS text size (Dynamic Type on iOS,
 * the font scale on Android, through `denext/mobile`'s font scale and the `DenextAccessibility`
 * plugin) reaches `PixelRatio.getFontScale()`, `Dimensions` / `useWindowDimensions().fontScale`,
 * and every `Text`: a `Text` with `allowFontScaling` (the default) draws its `fontSize` and
 * `lineHeight` times the factor, capped by `maxFontSizeMultiplier`, as React Native's does.
 * react-native-web reports a font scale of 1 and scales nothing.
 *
 * The factor is what the page must still apply: iOS's WKWebView ignores Dynamic Type, so there
 * it is the whole Dynamic Type factor; Android's WebView already zooms all text by the system
 * font scale (its `textZoom`), so there it is usually 1 (and `allowFontScaling={false}` cannot
 * undo that zoom). In a browser it is 1.
 *
 * React Native mode's build patches react-native-web's `PixelRatio`, `Dimensions` and `Text`
 * modules to call {@linkcode reactNativeFontScale} and {@linkcode withFontScaling}.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import { useContext, useSyncExternalStore } from "../runtime/hooks.ts";
import { fontScaleNow, getFontScale, onFontScaleChange } from "../mobile/accessibility.ts";

/** Listeners of the factor (the scaled `Text`s). */
const listeners = new Set<() => void>();
/** Whether the OS listener and the first read are running. */
let watching = false;

/**
 * Tell every `Text` and react-native-web's `Dimensions` the factor moved: `Dimensions` re-reads
 * on a `resize` of the visual viewport (else the window), which it listens to.
 */
function notify(): void {
  for (const fn of [...listeners]) fn();
  const g = globalThis as {
    visualViewport?: EventTarget;
    dispatchEvent?: (e: Event) => boolean;
    Event?: typeof Event;
  };
  if (typeof g.Event !== "function") return;
  const event = new g.Event("resize");
  if (g.visualViewport) g.visualViewport.dispatchEvent(event);
  else if (typeof g.dispatchEvent === "function") g.dispatchEvent(event);
}

/** Start following the OS text size (once per page). */
function watch(): void {
  if (watching) return;
  watching = true;
  const before = fontScaleNow();
  onFontScaleChange(() => notify());
  getFontScale().then((scale) => scale !== before && notify(), () => {});
}

/**
 * The font scale React Native mode reports (`PixelRatio.getFontScale()`, `Dimensions`'
 * `fontScale`): 1 until the first read answers, then the factor, kept current.
 *
 * @returns The factor (1 = the default size).
 */
export function reactNativeFontScale(): number {
  watch();
  return fontScaleNow();
}

/** Subscribe to the factor (useSyncExternalStore's shape). */
function subscribe(onChange: () => void): () => void {
  watch();
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
}

/** The server's (and the first render's) factor. */
function serverScale(): number {
  return 1;
}

/** Whether a `Text` is inside a scaled `Text` (whose size an unsized child inherits). */
let insideText: ReturnType<typeof createContext<boolean>> | null = null;

/** The nesting context, created on first use. */
function textContext(): ReturnType<typeof createContext<boolean>> {
  return insideText ??= createContext(false);
}

/** A style value (object, array, falsy) flattened to one object (later entries win). */
export function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style || typeof style !== "object") return {};
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle)) as Record<string, unknown>;
  }
  return style as Record<string, unknown>;
}

/** React Native's default text size (react-native-web's `Text` draws 14px). */
const DEFAULT_FONT_SIZE = 14;

/** The props a scaled `Text` reads. */
interface ScalableTextProps {
  readonly style?: unknown;
  readonly allowFontScaling?: boolean;
  readonly maxFontSizeMultiplier?: number | null;
  readonly [prop: string]: unknown;
}

/**
 * The style overrides that scale a `Text` by `scale`: its `fontSize` (React Native's default 14
 * for an outermost `Text` without one; an inner one without one inherits the scaled size) and a
 * numeric `lineHeight`. `null` when nothing changes.
 *
 * @param props The `Text`'s props.
 * @param scale The factor.
 * @param nested Whether it is inside another `Text`.
 * @returns The overrides, or `null`.
 */
export function scaledTextStyle(
  props: ScalableTextProps,
  scale: number,
  nested: boolean,
): Record<string, number> | null {
  if (props.allowFontScaling === false || scale === 1) return null;
  const cap = props.maxFontSizeMultiplier;
  const factor = typeof cap === "number" && cap >= 1 ? Math.min(scale, cap) : scale;
  if (factor === 1) return null;
  const flat = flattenStyle(props.style);
  const out: Record<string, number> = {};
  if (typeof flat.fontSize === "number") out.fontSize = flat.fontSize * factor;
  else if (!nested) out.fontSize = DEFAULT_FONT_SIZE * factor;
  if (typeof flat.lineHeight === "number") out.lineHeight = flat.lineHeight * factor;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * react-native-web's `Text` with React Native's font scaling (see the module docs).
 *
 * @param Text react-native-web's `Text` (React Native mode passes it in).
 * @returns The scaling `Text`.
 */
export function withFontScaling(Text: VNodeType): VNodeType {
  const ctx = textContext();
  function ScaledText(props: ScalableTextProps): VNode {
    const scale = useSyncExternalStore(subscribe, reactNativeFontScale, serverScale);
    const nested = useContext(ctx);
    const extra = scaledTextStyle(props, scale, nested);
    const text = h(Text, extra ? { ...props, style: [props.style, extra] } : props);
    return nested ? text : h(ctx.Provider, { value: true }, text);
  }
  return Object.assign(ScaledText, { displayName: "Text" }) as unknown as VNodeType;
}

/**
 * react-native-web's `PixelRatio` with `getFontScale()` answering {@linkcode reactNativeFontScale}
 * (react-native-web's answers 1).
 *
 * @param PixelRatio react-native-web's `PixelRatio` class.
 * @returns The same class.
 */
export function withFontScaleRatio<T extends { getFontScale?: () => number }>(PixelRatio: T): T {
  PixelRatio.getFontScale = reactNativeFontScale;
  return PixelRatio;
}

/** Forget the watcher (tests). */
export function resetFontScalingForTesting(): void {
  listeners.clear();
  watching = false;
}
