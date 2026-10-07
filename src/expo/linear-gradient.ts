/**
 * `expo-linear-gradient` for denext: `LinearGradient` as a view with a CSS
 * `linear-gradient()` background (react-native-web's `View` in React Native mode, a `<div>`
 * elsewhere), the same component React Native mode gives `react-native-linear-gradient`.
 * `start` / `end` are honoured exactly (the view measures itself, so the stops land where the
 * native gradient puts them); `dither` (Android) is ignored. A `MaskedView` whose mask is this
 * gradient becomes a CSS `mask-image`.
 *
 * @example
 * ```ts
 * import { LinearGradient } from "denext/expo/linear-gradient";
 * import { h } from "denext/jsx-runtime";
 *
 * h(LinearGradient, { colors: ["#4c669f", "#192f6a"], start: { x: 0, y: 0 }, end: [1, 1] });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { LinearGradient as GradientView } from "../react-native-compat/linear-gradient.ts";

/** A point as a tuple: `[x, y]`, each 0–1. */
export type NativeLinearGradientPoint = [number, number];

/** A point in the view's unit square: `{ x, y }` or `[x, y]` (`{ x: 0, y: 0 }` is the top left). */
export type LinearGradientPoint = { x: number; y: number } | NativeLinearGradientPoint;

/** `LinearGradient` props (plus any view prop). */
export interface LinearGradientProps {
  /** At least two colours: CSS colour strings or `processColor` numbers. */
  colors: readonly (string | number)[];
  /** Each colour's position on the start → end line, 0–1 (default: evenly spaced). */
  locations?: readonly number[] | null;
  /** Where the gradient starts (default `{ x: 0.5, y: 0 }`). */
  start?: LinearGradientPoint | null;
  /** Where the gradient ends (default `{ x: 0.5, y: 1 }`). */
  end?: LinearGradientPoint | null;
  /** Android's dithering (ignored: the browser draws the gradient). */
  dither?: boolean;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * A view whose background is a linear gradient.
 *
 * @param props The colours, geometry, style and children.
 * @returns The view.
 */
export function LinearGradient(props: LinearGradientProps): VNode {
  const { locations, start, end, dither: _dither, children, ...rest } = props;
  // As Expo: extra locations are dropped (it also warns); missing ones space the rest evenly.
  const stops = locations && locations.length > props.colors.length
    ? locations.slice(0, props.colors.length)
    : locations;
  return h(GradientView, {
    ...rest,
    colors: props.colors,
    ...(stops ? { locations: stops } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  } as never, children as never);
}
