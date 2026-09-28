/**
 * `expo-symbols` for denext: `SymbolView` is `denext/mobile`'s {@linkcode SystemIcon}. Inside
 * the iOS shell with `denext mobile add system-icons` it draws the real SF Symbol (natively
 * rendered, at the requested `weight`, tinted by `tintColor`, `type` as the rendering mode);
 * elsewhere it draws the Material Symbol named by `name.android` (or mapped from the SF Symbol
 * name for the common ones) as inline SVG. A `fallback` is rendered instead off iOS, as Expo's
 * web and Android builds do with one. `animationSpec`, `resizeMode` and `scale` are ignored.
 *
 * @example
 * ```ts
 * import { SymbolView } from "denext/expo/symbols";
 * import { h } from "denext/jsx-runtime";
 *
 * h(SymbolView, { name: { ios: "checkmark.circle", android: "check_circle" }, size: 18 });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { nativePlatform } from "../mobile/bridge.ts";
import { SystemIcon, type SystemIconMode, type SystemIconWeight } from "../mobile/system-icon.ts";
import { flattenStyle } from "./internal/common.ts";

/** An SF Symbol name. */
export type SFSymbol = string;

/** A Material Symbol name. */
export type AndroidSymbol = string;

/** `SymbolView` props. */
export interface SymbolViewProps {
  /** The symbol: an SF Symbol name, or `{ ios, android, web }` names. */
  name: SFSymbol | { ios?: SFSymbol; android?: AndroidSymbol; web?: string };
  /** What to render off iOS instead of the Material Symbol. */
  fallback?: unknown;
  /** The size in points (default 24). */
  size?: number;
  /** The tint colour (default: the inherited text colour). */
  tintColor?: string;
  /** The rendering type (default `"monochrome"`). */
  type?: "monochrome" | "hierarchical" | "palette" | "multicolor";
  /** `"palette"`'s layer colours. */
  colors?: string | string[];
  /** The weight (default `"regular"`). */
  weight?: string;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** The SF Symbol weights {@linkcode SystemIcon} takes. */
const WEIGHTS: ReadonlySet<string> = new Set([
  "ultralight",
  "thin",
  "light",
  "regular",
  "medium",
  "semibold",
  "bold",
  "heavy",
  "black",
]);

/** The SF Symbol and Material Symbol names of a `name` prop. */
function symbolNames(name: SymbolViewProps["name"]): { ios: string; android?: string } {
  if (typeof name === "string") return { ios: name };
  const ios = name?.ios ?? name?.web ?? name?.android ?? "";
  return { ios, ...(name?.android ? { android: name.android } : {}) };
}

/**
 * A system symbol: the SF Symbol in the iOS shell, the Material Symbol (or `fallback`)
 * elsewhere.
 *
 * @param props The symbol props.
 * @returns The icon, or the fallback.
 */
export function SymbolView(props: SymbolViewProps): VNode {
  const { fallback, size = 24, style, name, tintColor, type, weight, colors } = props;
  if (fallback !== undefined && fallback !== null && nativePlatform() !== "ios") {
    return fallback as VNode;
  }
  const names = symbolNames(name);
  return h(SystemIcon, {
    name: names.ios,
    ...(names.android ? { android: names.android } : {}),
    size,
    color: tintColor,
    mode: (type ?? "monochrome") as SystemIconMode,
    ...(colors ? { colors: Array.isArray(colors) ? colors : [colors] } : {}),
    ...(weight && WEIGHTS.has(weight) ? { weight: weight as SystemIconWeight } : {}),
    style: flattenStyle(style) as Record<string, string | number | undefined>,
  });
}

/**
 * The image source of a Material Symbol: not available here.
 *
 * @param _symbol The symbol.
 * @param _size The size.
 * @param _color The colour.
 * @returns null.
 */
export function unstable_getMaterialSymbolSourceAsync(
  _symbol: AndroidSymbol | null,
  _size: number,
  _color: string,
): Promise<null> {
  return Promise.resolve(null);
}
