// denext JSX runtime — the automatic runtime target for `jsx: "react-jsx"`.
// The TypeScript compiler emits calls to `jsx`, `jsxs`, and `Fragment` from here.

import type { Key, VNode, VNodeChildren, VNodeType, VProps } from "./types.ts";
import { FRAGMENT } from "./types.ts";

export { FRAGMENT as Fragment };
export type { VNode };
// The automatic JSX runtime resolves element typing from this namespace.
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

export const jsx = createElement;
export const jsxs = createElement;
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
