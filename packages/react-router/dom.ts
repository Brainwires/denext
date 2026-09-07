// `react-router/dom` on denext. An RR7 app's `entry.client.tsx` renders `<HydratedRouter />`
// (and a library-mode app `<RouterProvider router={…} />`); denext owns hydration and routing,
// so both are inert here — the aliased import resolves, the app's own entry is never the
// browser entry (denext generates it), and nothing renders twice.

import { Fragment, h } from "@denext/denext";
import type { VNode, VNodeChildren } from "@denext/denext";

/** RR7's client hydration root — inert: denext hydrates. */
export function HydratedRouter(_props: Record<string, unknown>): VNode {
  return h(Fragment, {});
}

/** RR's library-mode provider — inert passthrough of `children` (denext routes). */
export function RouterProvider(props: { children?: VNodeChildren }): VNode {
  return h(Fragment, {}, props.children);
}
