/**
 * React Native's `adjustsFontSizeToFit` and `minimumFontScale` on `Text` for React Native mode,
 * which react-native-web drops: a `Text` whose content overflows its box (a `numberOfLines`
 * clamp, or a fixed width / height) draws its `fontSize` smaller until it fits, down to
 * `minimumFontScale` of the size (never below 4 px). The fit is measured in the DOM after each
 * render and again when the text's box is resized. A nested `Text` shrinks by the same factor:
 * the fit probes every element inside the box at its scaled size, and a nested `Text` with its
 * own `fontSize` draws it times the factor of the fitting `Text` around it (a context).
 *
 * React Native mode's build wraps react-native-web's `Text` with {@linkcode withTextProps}
 * (this fit inside the OS font scaling of `withFontScaling`, so the fit starts from the scaled
 * size).
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeType } from "../jsx/types.ts";
import { createContext } from "../runtime/context.ts";
import { useContext, useState } from "../runtime/hooks.ts";
import { flattenStyle, withFontScaling } from "./font-scaling.ts";
import { useMeasuredNode } from "./measured-node.ts";
import { withTextLayout } from "./text-layout.ts";

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
  /** The elements inside it (a nested `Text`'s spans); absent on a stand-in. */
  querySelectorAll?(selectors: string): ArrayLike<{ readonly style: { fontSize: string } }>;
}

/** An element inside a fitting `Text`, with its font size at the factor 1, px. */
export interface NestedFit {
  readonly style: { fontSize: string };
  readonly base: number;
}

/**
 * The factor of the nearest fitting `Text` around a `Text` (1 outside one): a nested `Text`
 * with its own `fontSize` draws it times this.
 */
const FitScale = createContext(1);

/**
 * The elements inside `el` with their font size at the factor 1: the size each draws now
 * divided by `scale`, the factor the fit drew last.
 */
function nestedFits(el: FitElement, scale: number): NestedFit[] {
  const all = el.querySelectorAll?.("*");
  if (!all) return [];
  const computed = (globalThis as { getComputedStyle?: typeof getComputedStyle })
    .getComputedStyle;
  const out: NestedFit[] = [];
  for (const node of Array.from(all)) {
    const px = parseFloat(
      computed ? computed(node as unknown as Element).fontSize : node.style.fontSize,
    );
    if (Number.isFinite(px) && px > 0) out.push({ style: node.style, base: px / scale });
  }
  return out;
}

/** Whether the element's content overflows its box (a pixel of rounding allowed). */
function overflows(el: FitElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * The largest factor of `base` at which `el`'s content fits, between `minScale` and 1: the
 * element's font size, and each nested element's, is probed in place and restored before
 * returning.
 *
 * @param el The text's element.
 * @param base The unshrunk font size, px.
 * @param minScale `minimumFontScale` (0 or less: down to the 4 px floor).
 * @param nested The elements inside it with their unshrunk sizes (a nested `Text`).
 * @returns The factor (1 when it already fits).
 */
export function fitFontScale(
  el: FitElement,
  base: number,
  minScale: number,
  nested: readonly NestedFit[] = [],
): number {
  const before = el.style.fontSize;
  const nestedBefore = nested.map((n) => n.style.fontSize);
  const fitsAt = (scale: number) => {
    el.style.fontSize = `${base * scale}px`;
    for (const n of nested) n.style.fontSize = `${n.base * scale}px`;
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
    nested.forEach((n, i) => (n.style.fontSize = nestedBefore[i]));
  }
}

/** Whether `children` are strings and numbers only (no nested `Text`). */
function isPlainText(children: unknown): boolean {
  const leaf = (c: unknown) => typeof c === "string" || typeof c === "number";
  return leaf(children) || (Array.isArray(children) && children.every(leaf));
}

/** The props the fit reads (the rest go on to react-native-web's `Text`). */
interface FitTextProps {
  readonly adjustsFontSizeToFit?: boolean;
  readonly minimumFontScale?: number;
  readonly style?: unknown;
  readonly ref?: unknown;
  readonly [prop: string]: unknown;
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
    const outer = useContext(FitScale);
    const [scale, setScale] = useState(1);
    const size = flattenStyle(props.style).fontSize;
    // Inside a fitting Text an own size shrinks with it (an inherited one already does).
    const own = typeof size === "number";
    const base = (own ? size : DEFAULT_FONT_SIZE) * outer;
    const { ref } = useMeasuredNode<FitElement>(!!fit, props.ref, (el) => {
      const next = fitFontScale(el, base, minimumFontScale ?? 0, nestedFits(el, scale));
      setScale((s) => (Math.abs(s - next) < 0.005 ? s : next));
    });
    const factor = fit ? scale : 1;
    const sized = factor < 1 || (own && outer < 1);
    const style = sized ? [props.style, { fontSize: base * factor }] : props.style;
    if (!fit) return sized ? h(Text, { ...rest, style }) : h(Text, rest);
    // Children that can hold a nested Text always sit under the factor's provider, so a refit
    // doesn't remount them; plain text stays plain (ellipsizeMode reads it).
    if (isPlainText(rest.children)) return h(Text, { ...rest, ref, style });
    return h(Text, {
      ...rest,
      ref,
      style,
      children: h(FitScale, { value: outer * factor }, rest.children as never),
    });
  }
  return Object.assign(FitText, { displayName: "Text" }) as unknown as VNodeType;
}

/**
 * react-native-web's `Text` with React Native's font scaling ({@linkcode withFontScaling}),
 * `adjustsFontSizeToFit` ({@linkcode withTextFit}) and `ellipsizeMode` / `onTextLayout`
 * ({@linkcode withTextLayout}): the wrapper React Native mode's build applies.
 *
 * @param Text react-native-web's `Text`.
 * @returns The wrapped `Text`.
 */
export function withTextProps(Text: VNodeType): VNodeType {
  return withFontScaling(withTextFit(withTextLayout(Text)));
}
