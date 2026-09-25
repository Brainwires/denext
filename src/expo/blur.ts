/**
 * `expo-blur` for denext: `BlurView` as a view with a CSS `backdrop-filter` blur and a tint
 * (react-native-web's `View` in React Native mode, a `<div>` elsewhere). `intensity` (0–100)
 * sets the blur radius; `tint` picks the overlay colour. `BlurTargetView` (Android's blur
 * target) is a plain view.
 *
 * @example
 * ```ts
 * import { BlurView } from "denext/expo/blur";
 * import { h } from "denext/jsx-runtime";
 *
 * h(BlurView, { intensity: 60, tint: "dark", style: { padding: 16 } }, "Hello");
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { blurStyle, hostView, viewStyle } from "./internal/common.ts";

/** The blur tint. `system*Material*` tints map to light, dark or default by name. */
export type BlurTint =
  | "light"
  | "dark"
  | "default"
  | "extraLight"
  | "regular"
  | "prominent"
  | string;

/** `BlurView` props. */
export interface BlurViewProps {
  /** The tint (default `default`). */
  tint?: BlurTint;
  /** The blur strength, 0–100 (default 50). */
  intensity?: number;
  /** Scale the blur down on Android (ignored). */
  blurReductionFactor?: number;
  /** The Android blur method (ignored). */
  experimentalBlurMethod?: string;
  /** The Android blur method (ignored). */
  blurMethod?: string;
  /** The Android blur target (ignored). */
  blurTarget?: unknown;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * A view that blurs what is behind it.
 *
 * @param props The tint, intensity, style and children.
 * @returns The view.
 */
export function BlurView(props: BlurViewProps): VNode {
  const {
    tint = "default",
    intensity = 50,
    style,
    children,
    blurReductionFactor: _r,
    experimentalBlurMethod: _e,
    blurMethod: _m,
    blurTarget: _t,
    ...rest
  } = props;
  return h(
    hostView(),
    { ...rest, style: viewStyle(style, blurStyle(intensity, tint)) },
    children as never,
  );
}

/** `BlurTargetView` props. */
export interface BlurTargetViewProps {
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * Android's blur target: a plain view here.
 *
 * @param props The view props.
 * @returns The view.
 */
export function BlurTargetView(props: BlurTargetViewProps): VNode {
  const { style, children, ...rest } = props;
  return h(hostView(), { ...rest, style: viewStyle(style) }, children as never);
}
