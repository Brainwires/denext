/**
 * `@react-native-masked-view/masked-view` for denext (and `@expo/ui/community/masked-view`,
 * which is API-compatible): `MaskedView` shows its children through the alpha channel of
 * `maskElement`, drawn with CSS instead of a native mask.
 *
 * A web page cannot use an arbitrary rendered element as a mask, so the two patterns apps use
 * it for are recognised and drawn exactly:
 *
 * - a gradient mask (`maskElement` is a `LinearGradient` of `expo-linear-gradient` or
 *   `react-native-linear-gradient`, e.g. fading a list's edges): the children get a CSS
 *   `mask-image` with the same gradient;
 * - gradient text (`maskElement` is a `Text`, the children a `LinearGradient`): the text is
 *   drawn with the gradient as its fill (`background-clip: text`).
 *
 * Any other mask renders the children unmasked and warns once.
 *
 * @example
 * ```ts
 * import MaskedView from "@react-native-masked-view/masked-view";
 * import { LinearGradient } from "expo-linear-gradient";
 * import { h } from "denext/jsx-runtime";
 *
 * // Fade the bottom of a list out.
 * h(MaskedView, {
 *   style: { flex: 1 },
 *   maskElement: h(LinearGradient, { colors: ["black", "black", "transparent"] }),
 * }, "…the list…");
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { isValidElement } from "../runtime/react-core.ts";
import { flattenStyle, hostView, viewStyle } from "../expo/internal/common.ts";
import { type GradientPoint, linearGradientCss } from "./linear-gradient.ts";
import * as RN from "./internal/react-native.ts";

/** `MaskedView` props (plus any view prop). */
export interface MaskedViewProps {
  /** The element whose alpha channel masks the children. */
  maskElement: unknown;
  /** The masked content. */
  children?: unknown;
  /** Android's rendering mode (ignored). */
  androidRenderingMode?: "software" | "hardware";
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** Whether the unmasked fallback has warned already. */
let warned = false;

/** Warn once that `MaskedView` rendered its children without the mask. */
function warnUnmasked(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "denext reactNative: MaskedView can mask only with a LinearGradient (a CSS mask-image) or " +
      "turn a Text into gradient text on the web; this mask is not drawn and the children " +
      "render unmasked.",
  );
}

/** A point prop (`{ x, y }` or `[x, y]`), or `fallback`. */
function point(value: unknown, fallback: GradientPoint): GradientPoint {
  if (Array.isArray(value)) return { x: Number(value[0]), y: Number(value[1]) };
  if (value && typeof value === "object") return value as GradientPoint;
  return fallback;
}

/**
 * The CSS gradient a `LinearGradient` element draws, or null when `element` is not one (no
 * `colors` array).
 *
 * @param element Any child or mask element.
 */
export function gradientImageOf(element: unknown): string | null {
  if (!isValidElement(element)) return null;
  const props = element.props as Record<string, unknown>;
  if (!Array.isArray(props.colors) || props.colors.length === 0) return null;
  const colors = props.colors as (string | number)[];
  const locations = Array.isArray(props.locations) ? props.locations as number[] : undefined;
  return linearGradientCss(
    colors,
    locations,
    point(props.start, { x: 0.5, y: 0 }),
    point(props.end, { x: 0.5, y: 1 }),
  );
}

/** Whether `element` is a text element (React Native's `Text`, or text-only content). */
function isTextElement(element: VNode): boolean {
  if (RN.Text !== undefined && element.type === RN.Text) return true;
  const children = (element.props as { children?: unknown }).children;
  return typeof children === "string" || typeof children === "number";
}

/** The only child of `children`, or undefined when there are none or several. */
function onlyChild(children: unknown): unknown {
  if (Array.isArray(children)) return children.length === 1 ? children[0] : undefined;
  return children;
}

/**
 * `maskElement` drawn as gradient text when it is a text element and `children` is one
 * gradient, else null.
 */
function gradientText(maskElement: unknown, children: unknown): VNode | null {
  const fill = gradientImageOf(onlyChild(children));
  if (!fill || !isValidElement(maskElement) || !isTextElement(maskElement)) return null;
  const textProps = maskElement.props as Record<string, unknown>;
  const style = {
    backgroundImage: fill,
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
  };
  return RN.Text !== undefined
    ? h(RN.Text, { ...textProps, style: [textProps.style, style] })
    : h("span", { ...textProps, style: { ...flattenStyle(textProps.style), ...style } });
}

/**
 * Show `children` through `maskElement`'s alpha channel.
 *
 * @param props The mask, the style and the content.
 * @returns The view.
 */
export function MaskedView(props: MaskedViewProps): VNode {
  const { maskElement, children, style, androidRenderingMode: _mode, ...rest } = props;
  const maskImage = gradientImageOf(maskElement);
  if (maskImage) {
    const mask = { maskImage, WebkitMaskImage: maskImage };
    return h(hostView(), { ...rest, style: viewStyle(style, mask) }, children as never);
  }
  const text = gradientText(maskElement, children);
  if (!text) warnUnmasked();
  return h(hostView(), { ...rest, style: viewStyle(style) }, (text ?? children) as never);
}

export default MaskedView;
