/**
 * React Native's `adjustsFontSizeToFit` and `minimumFontScale` on `Text` for React Native mode,
 * which react-native-web drops: a `Text` whose content overflows its box (a `numberOfLines`
 * clamp, or a fixed width / height) draws its `fontSize` smaller until it fits, down to
 * `minimumFontScale` of the size (never below 4 px). The fit is measured in the DOM after each
 * render and again when the text's box is resized. Only the outer `Text`'s size shrinks: a
 * nested `Text` with its own `fontSize` keeps it.
 *
 * React Native mode's build wraps react-native-web's `Text` with {@linkcode withTextProps}
 * (this fit inside the OS font scaling of `withFontScaling`, so the fit starts from the scaled
 * size).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { useCallback, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { flattenStyle, withFontScaling } from "./font-scaling.ts";
import { setRef } from "./internal.ts";

/** React Native's default text size (react-native-web's `Text` draws 14px). */
const DEFAULT_FONT_SIZE = 14;

/** The smallest size a fit draws, px (React Native's Android floor). */
const MIN_FONT_SIZE = 4;

/** Binary-search steps (1/64 of the range: below a pixel at any text size). */
const STEPS = 6;

/** The DOM element a `Text` draws (the slice the fit reads and writes). */
export interface FitElement {
  readonly style: { fontSize: string };
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Whether the element's content overflows its box (a pixel of rounding allowed). */
function overflows(el: FitElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * The largest factor of `base` at which `el`'s content fits, between `minScale` and 1: the
 * element's font size is probed in place and restored before returning.
 *
 * @param el The text's element.
 * @param base The unshrunk font size, px.
 * @param minScale `minimumFontScale` (0 or less: down to the 4 px floor).
 * @returns The factor (1 when it already fits).
 */
export function fitFontScale(el: FitElement, base: number, minScale: number): number {
  const before = el.style.fontSize;
  const fitsAt = (scale: number) => {
    el.style.fontSize = `${base * scale}px`;
    return !overflows(el);
  };
  try {
    if (fitsAt(1)) return 1;
    let lo = Math.min(1, Math.max(minScale, MIN_FONT_SIZE / base));
    if (!fitsAt(lo)) return lo;
    let hi = 1;
    for (let i = 0; i < STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  } finally {
    el.style.fontSize = before;
  }
}

/** The props the fit reads (the rest go on to react-native-web's `Text`). */
interface FitTextProps {
  readonly adjustsFontSizeToFit?: boolean;
  readonly minimumFontScale?: number;
  readonly style?: unknown;
  readonly ref?: unknown;
  readonly [prop: string]: unknown;
}

/** The `ResizeObserver` constructor, where the page has one. */
function resizeObserver(): typeof ResizeObserver | undefined {
  return (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
}

/**
 * react-native-web's `Text` with `adjustsFontSizeToFit` / `minimumFontScale` (see the module
 * docs). A `Text` without `adjustsFontSizeToFit` renders exactly as before.
 *
 * @param Text react-native-web's `Text`.
 * @returns The fitting `Text`.
 */
function withTextFit(Text: VNodeType): VNodeType {
  function FitText(props: FitTextProps): VNode {
    const { adjustsFontSizeToFit: fit, minimumFontScale, ...rest } = props;
    const [scale, setScale] = useState(1);
    const node = useRef<FitElement | null>(null);
    const userRef = props.ref;
    const ref = useCallback((el: FitElement | null) => {
      node.current = el;
      setRef(userRef, el);
    }, [userRef]);
    const size = flattenStyle(props.style).fontSize;
    const base = typeof size === "number" ? size : DEFAULT_FONT_SIZE;
    const measure = useRef(() => {});
    measure.current = () => {
      const el = node.current;
      if (!fit || !el) return;
      const next = fitFontScale(el, base, minimumFontScale ?? 0);
      setScale((s) => (Math.abs(s - next) < 0.005 ? s : next));
    };
    useLayoutEffect(() => measure.current());
    useLayoutEffect(() => {
      const RO = resizeObserver();
      if (!fit || !RO || !node.current) return;
      const ro = new RO(() => measure.current());
      ro.observe(node.current as unknown as Element);
      return () => ro.disconnect();
    }, [fit]);
    if (!fit) return h(Text, rest);
    return h(Text, {
      ...rest,
      ref,
      style: scale < 1 ? [props.style, { fontSize: base * scale }] : props.style,
    });
  }
  return Object.assign(FitText, { displayName: "Text" }) as unknown as VNodeType;
}

/**
 * react-native-web's `Text` with React Native's font scaling ({@linkcode withFontScaling}) and
 * `adjustsFontSizeToFit` ({@linkcode withTextFit}): the wrapper React Native mode's build
 * applies.
 *
 * @param Text react-native-web's `Text`.
 * @returns The wrapped `Text`.
 */
export function withTextProps(Text: VNodeType): VNodeType {
  return withFontScaling(withTextFit(Text));
}
