/**
 * `expo-symbols` for denext: SF Symbols and Material Symbols are native-only, so
 * `SymbolView` renders its `fallback` when given one, and otherwise an empty box of the
 * symbol's `size` (so layouts keep their spacing). Apps that need icons on the web pass a
 * `fallback`, as Expo's own web build expects.
 *
 * @example
 * ```ts
 * import { SymbolView } from "denext/expo/symbols";
 * import { h } from "denext/jsx-runtime";
 *
 * h(SymbolView, { name: "checkmark", size: 18, fallback: h(CheckIcon, null) });
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { hostView, viewStyle } from "./internal/common.ts";

/** An SF Symbol name. */
export type SFSymbol = string;

/** A Material Symbol name. */
export type AndroidSymbol = string;

/** `SymbolView` props. */
export interface SymbolViewProps {
  /** The symbol: an SF Symbol name, or `{ ios, android, web }` names. */
  name: SFSymbol | { ios?: SFSymbol; android?: AndroidSymbol; web?: string };
  /** What to render where the symbol is not available (here: always). */
  fallback?: unknown;
  /** The size in points (default 24). */
  size?: number;
  /** The tint colour (ignored without a fallback). */
  tintColor?: string;
  /** The rendering type (ignored). */
  type?: "monochrome" | "hierarchical" | "palette" | "multicolor";
  /** The weight (ignored). */
  weight?: string;
  /** The style. */
  style?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/**
 * A system symbol: its `fallback`, or an empty box of its size.
 *
 * @param props The symbol props.
 * @returns The fallback, or the placeholder view.
 */
export function SymbolView(props: SymbolViewProps): VNode {
  const { fallback, size = 24, style, name, tintColor: _c, type: _t, weight: _w, ...rest } = props;
  if (fallback !== undefined && fallback !== null) return fallback as VNode;
  const label = typeof name === "string" ? name : name?.ios ?? name?.web ?? name?.android;
  return h(hostView(), {
    ...rest,
    "aria-hidden": true,
    "data-symbol": label,
    style: viewStyle(style, { width: size, height: size }),
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
