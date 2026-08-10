// Shared VNode helpers used by both the recursive reconciler and the fiber
// reconciler: text-vnode construction, child normalization (React's
// arbitrarily-nested-array flattening), and same-type identity.

import type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";

/** The synthetic `type` used for text nodes in the client tree. */
export const TEXT_TYPE = "#text";

/** Wrap a raw string value as a text VNode. */
export function textVNode(value: string): VNode {
  return { type: TEXT_TYPE, props: { nodeValue: value }, key: null };
}

/** Normalize JSX children into a flat list of renderable VNodes. */
export function normalizeChildren(children: VNodeChildren): VNode[] {
  const out: VNode[] = [];
  // React flattens arbitrarily-nested children arrays; recurse so deeply-nested
  // arrays (e.g. recharts' renderByOrder output) match the SSR renderer's flattening.
  const push = (c: VNodeChild | VNodeChildren) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) {
      for (const x of c) push(x);
      return;
    }
    if (typeof c === "string") out.push(textVNode(c));
    else if (typeof c === "number") out.push(textVNode(String(c)));
    else out.push(c as VNode);
  };
  push(children as VNodeChild);
  return out;
}

/** Whether two vnodes reconcile in place (same element type) vs. replace. */
export function sameType(a: VNode, b: VNode): boolean {
  return a.type === b.type;
}
