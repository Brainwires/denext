/**
 * `@react-native-community/blur` for denext (React Native mode): `BlurView` and
 * `VibrancyView` as views with a CSS `backdrop-filter` blur and a tint (react-native-web's
 * `View` in React Native mode, a `<div>` elsewhere). The package's native views have no web
 * build, so React Native mode resolves the package here.
 *
 * `blurAmount` (0–100, default 10) sets the blur radius and `blurType` the tint (`dark*`
 * names tint dark, `light` / `xlight` light, the materials a neutral frost). Android's
 * `overlayColor` replaces the tint, and `enabled={false}` renders a plain view. Where the
 * browser has no `backdrop-filter` the `reducedTransparencyFallbackColor` is the background.
 *
 * @example
 * ```ts
 * import { BlurView } from "@react-native-community/blur"; // → this module
 * import { h } from "denext/jsx-runtime";
 *
 * h(BlurView, { blurType: "light", blurAmount: 20, style: { position: "absolute", inset: 0 } });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { blurStyle, hostView, viewStyle } from "../expo/internal/common.ts";

/** A blur tint. */
export type BlurType =
  | "dark"
  | "light"
  | "xlight"
  | "prominent"
  | "regular"
  | "extraDark"
  | "chromeMaterial"
  | "material"
  | "thickMaterial"
  | "thinMaterial"
  | "ultraThinMaterial"
  | "chromeMaterialDark"
  | "materialDark"
  | "thickMaterialDark"
  | "thinMaterialDark"
  | "ultraThinMaterialDark"
  | "chromeMaterialLight"
  | "materialLight"
  | "thickMaterialLight"
  | "thinMaterialLight"
  | "ultraThinMaterialLight";

/** `BlurView` props (plus any view prop). */
export interface BlurViewProps {
  /** The tint (default `dark`). */
  blurType?: BlurType;
  /** The blur strength, 0–100 (default 10). */
  blurAmount?: number;
  /** The background when the browser cannot blur (iOS "Reduce Transparency"). */
  reducedTransparencyFallbackColor?: string;
  /** Android: the overlay colour, replacing the tint. */
  overlayColor?: string;
  /** Android: `false` renders a plain view (default `true`). */
  enabled?: boolean;
  /** Android: the blur radius (ignored; `blurAmount` sets it). */
  blurRadius?: number;
  /** Android: the downsample factor (ignored). */
  downsampleFactor?: number;
  /** Android: live updates (ignored; the blur is always live). */
  autoUpdate?: boolean;
  /** The style. */
  style?: unknown;
  /** The content. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** `VibrancyView` props. */
export type VibrancyViewProps = BlurViewProps;

/** Whether this browser can draw a backdrop blur (true when it cannot tell). */
function canBlur(): boolean {
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  if (typeof css?.supports !== "function") return true;
  return css.supports("backdrop-filter", "blur(1px)") ||
    css.supports("-webkit-backdrop-filter", "blur(1px)");
}

/** The tint name `expo`'s blur helper understands for a `blurType`. */
function tintOf(blurType: string): string {
  if (/dark/i.test(blurType)) return "dark";
  if (/light/i.test(blurType)) return "light";
  return "default";
}

/**
 * A view that blurs what is behind it.
 *
 * @param props The tint, strength, style and children.
 * @returns The view.
 */
export function BlurView(props: BlurViewProps): VNode {
  const {
    blurType = "dark",
    blurAmount = 10,
    reducedTransparencyFallbackColor,
    overlayColor,
    enabled = true,
    blurRadius: _radius,
    downsampleFactor: _downsample,
    autoUpdate: _auto,
    style,
    children,
    ...rest
  } = props;
  let base: Record<string, string> = {};
  if (enabled) {
    if (reducedTransparencyFallbackColor !== undefined && !canBlur()) {
      base = { backgroundColor: reducedTransparencyFallbackColor };
    } else {
      base = blurStyle(blurAmount, tintOf(blurType));
      if (overlayColor !== undefined) base.backgroundColor = overlayColor;
    }
  }
  return h(hostView(), { ...rest, style: viewStyle(style, base) }, children as never);
}

/**
 * iOS's vibrancy view: the same frosted blur as {@linkcode BlurView} (no vibrancy effect on
 * the content).
 *
 * @param props The tint, strength, style and children.
 * @returns The view.
 */
export function VibrancyView(props: VibrancyViewProps): VNode {
  return BlurView(props);
}
