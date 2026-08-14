// React's StrictMode. In development the client reconciler double-invokes render
// functions and mount effects under a StrictMode subtree, surfacing impure renders
// and missing effect cleanup. In production (and during SSR) it is a transparent
// Fragment — it renders its children with no extra work and adds no markup.
//
// It is implemented as a Fragment carrying a marker prop (rather than a new element
// type) so every SSR renderer already treats it as a fragment with zero changes;
// only the client reconciler reads the marker to enable dev double-invocation.

import { FRAGMENT, type VNode, type VNodeChildren, type VProps } from "../jsx/types.ts";

/** Prop key marking a Fragment as a StrictMode boundary (dev double-invoke). */
export const STRICT_MODE_PROP: string = "__dnxStrict";

/**
 * `React.StrictMode` — a development aid that double-invokes renders and mount
 * effects beneath it to surface impurities and missing cleanup. A transparent
 * Fragment in production and during server rendering (no markup, no double-invoke).
 */
export function StrictMode(props: { children?: VNodeChildren }): VNode {
  return {
    type: FRAGMENT,
    key: null,
    props: { children: props.children, [STRICT_MODE_PROP]: true } as unknown as VProps,
  };
}
