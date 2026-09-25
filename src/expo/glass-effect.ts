/**
 * `expo-glass-effect` for denext: iOS 26 Liquid Glass is native-only, so `GlassView` is a
 * frosted view (a CSS `backdrop-filter` blur with a light tint, or `tintColor`), and
 * `isGlassEffectAPIAvailable()` / `isLiquidGlassAvailable()` report `false` so apps take
 * their fallback path. `GlassContainer` is a plain view.
 *
 * @example
 * ```ts
 * import { GlassView, isGlassEffectAPIAvailable } from "denext/expo/glass-effect";
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { blurStyle, hostView, viewStyle } from "./internal/common.ts";

/** The glass style. */
export type GlassStyle = "clear" | "regular" | "none";

/** A glass style with animation options (the animation is ignored). */
export interface GlassEffectStyleConfig {
  /** The style. */
  style: GlassStyle;
  /** Animate changes (ignored). */
  animate?: boolean;
  /** The animation duration (ignored). */
  animationDuration?: number;
}

/** The glass colour scheme. */
export type GlassColorScheme = "auto" | "light" | "dark";

/** `GlassView` props. */
export interface GlassViewProps {
  /** The glass style (default `regular`; `none` draws no glass). */
  glassEffectStyle?: GlassStyle | GlassEffectStyleConfig;
  /** A tint colour over the glass. */
  tintColor?: string;
  /** React to touches (ignored). */
  isInteractive?: boolean;
  /** The colour scheme (`dark` darkens the tint). */
  colorScheme?: GlassColorScheme;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** `GlassContainer` props. */
export interface GlassContainerProps {
  /** The spacing between merged glass shapes (ignored). */
  spacing?: number;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * Whether the Liquid Glass API is available: not outside native iOS 26.
 *
 * @returns `false`.
 */
export function isGlassEffectAPIAvailable(): boolean {
  return false;
}

/**
 * Whether Liquid Glass is available: not outside native iOS 26.
 *
 * @returns `false`.
 */
export function isLiquidGlassAvailable(): boolean {
  return false;
}

/** The style name of a `glassEffectStyle` prop. */
function styleName(effect: GlassViewProps["glassEffectStyle"]): GlassStyle {
  if (!effect) return "regular";
  return typeof effect === "string" ? effect : effect.style;
}

/**
 * A frosted-glass view.
 *
 * @param props The glass style, tint, style and children.
 * @returns The view.
 */
export function GlassView(props: GlassViewProps): VNode {
  const {
    glassEffectStyle,
    tintColor,
    colorScheme,
    style,
    children,
    isInteractive: _i,
    ...rest
  } = props;
  const name = styleName(glassEffectStyle);
  const glass = name === "none" ? {} : {
    ...blurStyle(name === "clear" ? 30 : 60, colorScheme === "dark" ? "dark" : "light"),
    ...(tintColor ? { backgroundColor: tintColor } : {}),
  };
  return h(hostView(), { ...rest, style: viewStyle(style, glass) }, children as never);
}

/**
 * A group of glass views: a plain view here.
 *
 * @param props The style and children.
 * @returns The view.
 */
export function GlassContainer(props: GlassContainerProps): VNode {
  const { style, children, spacing: _s, ...rest } = props;
  return h(hostView(), { ...rest, style: viewStyle(style) }, children as never);
}
