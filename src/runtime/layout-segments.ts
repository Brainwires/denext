// Layout-relative route segments: the plumbing behind `useSelectedLayoutSegment(s)`.
//
// Each layout is wrapped (on the server in `wrapLayouts`, on the client in the
// generated route entry) with a provider carrying the active URL pathname plus
// the layout's own **depth** — the number of URL path segments consumed above
// it. `useSelectedLayoutSegments()` reads the nearest provider and returns the
// path segments *below* the calling layout's level, matching Next.js.

import { createContext } from "./context.ts";
import type { Context } from "./hooks.ts";
import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../jsx/types.ts";

/** The active pathname plus the calling layout's segment depth. */
export interface LayoutSegmentInfo {
  /** The active request/location pathname (e.g. `/a/b/c`). */
  pathname: string;
  /** URL path segments consumed above this layout (0 at the root layout). */
  depth: number;
}

/**
 * Internal context carrying the active pathname and the nearest layout's depth
 * to {@linkcode useSelectedLayoutSegments}. Provided around each layout by the
 * server renderer and the client route entry.
 */
export const LayoutSegmentContext: Context<LayoutSegmentInfo> = createContext<LayoutSegmentInfo>({
  pathname: "/",
  depth: 0,
});

/**
 * Wrap `child` in a {@link LayoutSegmentContext} provider so a layout (and its
 * descendants) resolves `useSelectedLayoutSegment(s)` relative to `info.depth`.
 *
 * @param info The active pathname and the wrapped layout's segment depth.
 * @param child The layout VNode (and its subtree) to wrap.
 * @returns The provider VNode.
 */
export function provideLayoutSegments(info: LayoutSegmentInfo, child: VNodeChild): VNode {
  return h(LayoutSegmentContext, { value: info, children: child });
}
