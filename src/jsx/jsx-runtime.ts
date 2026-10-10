/**
 * denext's automatic JSX runtime.
 *
 * This module is the target of `jsx: "react-jsx"`: the compiler emits calls to
 * {@link jsx}, {@link jsxs}, {@link jsxDEV}, and {@link Fragment} from here to
 * build {@link VNode} trees. It also exports the classic-style {@link h} helper
 * for creating nodes programmatically.
 *
 * @module
 */

import type { Key, VNode, VNodeChildren, VNodeType, VProps } from "./types.ts";
import { FRAGMENT } from "./types.ts";
import { REACT_ELEMENT_TYPE } from "../runtime/react-brands.ts";

export { FRAGMENT as Fragment };
// The automatic JSX runtime resolves element typing from this namespace; `VNode`
// and other types are exported from the `denext` entrypoint, not duplicated here.
export type { JSX } from "./types.ts";

/**
 * Create a virtual DOM node. Shared by both `jsx` (single/no child) and
 * `jsxs` (static children array) — the distinction only matters to React's
 * key warnings, which we don't need.
 *
 * The props object a JSX compiler passes is a fresh literal per call, so — as React 19's `jsx`
 * does — it becomes the element's props as is, unless something must be written into it: a
 * separately passed `key`, or a component's `defaultProps`. Only then is it copied first.
 */
function createElement(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  if (props !== null && key === undefined && defaultPropsOf(type) === undefined) {
    return element(type, props);
  }
  const normalized: VProps = props ? { ...props } : {};
  if (key !== undefined) normalized.key = key;
  applyDefaultProps(type, normalized as Record<string, unknown>);
  return element(type, normalized);
}

/** The element over `props`, which is already final (its key is read from it). */
function element(type: VNodeType, props: VProps): VNode {
  // `$$typeof` is a literal own field (not `Object.defineProperty`) so V8 keeps a
  // monomorphic hidden class on this hot path — this is the shape React itself ships.
  // Its value is a symbol, so `JSON.stringify` drops it (no Flight wire-size cost).
  return {
    $$typeof: REACT_ELEMENT_TYPE,
    type,
    props,
    key: props.key ?? null,
  };
}

/**
 * Apply a component's `defaultProps` for any missing/undefined prop, matching React's
 * createElement. Many npm libraries rely on this (e.g. recharts' `XAxis.defaultProps =
 * { xAxisId: 0 }`). For a `memo(Inner)` wrapper (now a non-callable object) the defaults
 * live on the inner component (exposed as `.type`), so fall back to it.
 */
function applyDefaultProps(type: VNodeType, props: Record<string, unknown>): void {
  const defaults = defaultPropsOf(type);
  if (!defaults) return;
  for (const k in defaults) {
    if (props[k] === undefined) props[k] = defaults[k];
  }
}

/** `type`'s `defaultProps` (a `memo(Inner)` wrapper's live on `Inner`, its `.type`), if any. */
function defaultPropsOf(type: VNodeType): Record<string, unknown> | undefined {
  if (typeof type !== "function" && (typeof type !== "object" || type === null)) return undefined;
  const t = type as {
    defaultProps?: Record<string, unknown>;
    type?: { defaultProps?: Record<string, unknown> };
  };
  return t.defaultProps ?? t.type?.defaultProps ?? undefined;
}

/** JSX factory for elements with zero or one child (automatic runtime). */
export const jsx: (
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
) => VNode = createElement;
/** JSX factory for elements with a static array of children (automatic runtime). */
export const jsxs: (
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
) => VNode = createElement;
/**
 * Development-mode JSX factory. React's dev runtime passes extra arguments —
 * `isStaticChildren`, `source` (`__source`: file/line), and `self` (`__self`) — used
 * for dev warnings and source mapping. denext produces the same element from `(type,
 * props, key)`; the extra args are accepted for signature parity and currently ignored.
 */
export const jsxDEV = (
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): VNode => createElement(type, props, key);

/**
 * Classic-runtime style helper, also handy for programmatic node creation:
 *   h("div", { class: "x" }, child1, child2)
 */
export function h(
  type: VNodeType,
  props: VProps | null,
  ...children: VNodeChildren[]
): VNode {
  const merged: VProps = props ? { ...props } : {};
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children as VNodeChildren;
  // `merged` is this call's own copy: no second copy for the key or the defaults.
  applyDefaultProps(type, merged as Record<string, unknown>);
  return element(type, merged);
}
