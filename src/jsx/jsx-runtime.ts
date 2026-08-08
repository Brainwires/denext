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

export { FRAGMENT as Fragment };
// The automatic JSX runtime resolves element typing from this namespace; `VNode`
// and other types are exported from the `denext` entrypoint, not duplicated here.
export type { JSX } from "./types.ts";

/**
 * Create a virtual DOM node. Shared by both `jsx` (single/no child) and
 * `jsxs` (static children array) — the distinction only matters to React's
 * key warnings, which we don't need.
 */
function createElement(
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
): VNode {
  const normalized: VProps = props ? { ...props } : {};
  if (key !== undefined) normalized.key = key;
  const resolvedKey = normalized.key ?? null;
  return {
    type,
    props: normalized,
    key: resolvedKey,
  };
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
/** Development-mode JSX factory; behaves identically to {@link jsx} here. */
export const jsxDEV = (
  type: VNodeType,
  props: (VProps & { children?: VNodeChildren }) | null,
  key?: Key,
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
  return createElement(type, merged, merged.key);
}
