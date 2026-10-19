/**
 * `denext/preact/jsx-runtime` — the automatic JSX runtime for code written against Preact
 * (`jsxImportSource: "preact"`; `denext migrate` maps `preact/jsx-runtime` here). It is denext's
 * own runtime, plus Preact Signals' DOM-prop binding: a signal passed to an intrinsic element
 * (`<input value={text} />`) becomes its value, read while the owning component renders, so that
 * component follows the signal. A signal child stays a signal (it renders its value in place).
 *
 * @module
 */

import { Fragment, jsx as coreJsx, jsxDEV as coreJsxDEV } from "../../jsx/jsx-runtime.ts";
import type { Key, VNode, VNodeChildren, VNodeType, VProps } from "../../jsx/types.ts";
import { isSignal } from "../../runtime/signal-brand.ts";

export { Fragment };
export type { JSX } from "../../jsx/types.ts";

/** An intrinsic element's props with each signal-valued prop (but `children`) read. */
function unwrapSignals(type: VNodeType, props: VProps | null): VProps | null {
  if (typeof type !== "string" || props === null) return props;
  let out: Record<string, unknown> | null = null;
  for (const name in props) {
    const value = (props as Record<string, unknown>)[name];
    if (name === "children" || !isSignal(value)) continue;
    out ??= { ...props };
    out[name] = (value as unknown as { value: unknown }).value;
  }
  return (out ?? props) as VProps;
}

/**
 * JSX factory (automatic runtime) with signal-valued DOM props bound.
 *
 * @param type The element type.
 * @param props Its props.
 * @param key Its key.
 * @returns The element.
 */
export function jsx(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  return coreJsx(type, unwrapSignals(type, props), key);
}

/** JSX factory for static children (automatic runtime); see {@link jsx}. */
export const jsxs: typeof jsx = jsx;

/**
 * Development JSX factory (`react-jsxdev`) with signal-valued DOM props bound.
 *
 * @param type The element type.
 * @param props Its props.
 * @param key Its key.
 * @param isStatic Static children.
 * @param source The JSX's source location.
 * @param self The `this` of the call site.
 * @returns The element.
 */
export function jsxDEV(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
  isStatic?: boolean,
  source?: unknown,
  self?: unknown,
): VNode {
  return coreJsxDEV(type, unwrapSignals(type, props), key, isStatic, source, self);
}
