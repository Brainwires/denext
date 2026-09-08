// Client-reconciler seam for the `Activity` offscreen scheduler. beginWork dispatches an
// `activity` fiber THROUGH this null-default slot, so the always-shipped reconciler never
// statically imports the offscreen begin logic (`activity-runtime.ts`). The generated
// route/Flight entry installs the real support (installActivitySupport) ONLY when the app
// uses `Activity` (a build-time scan), so `deno bundle` tree-shakes the offscreen runtime
// out of an app that never renders one — the same lever the class-component and Live seams
// use. Without it installed, an Activity fiber is a transparent passthrough of its children.

import type { Fiber } from "./fiber.ts";

/** The Activity offscreen runtime the reconciler calls. Supplied by activity-runtime.ts. */
export interface ActivitySupport {
  /** Begin an `activity` fiber: reconcile + apply the offscreen (hide/reveal) dance. */
  begin(wip: Fiber): Fiber | null;
}

let support: ActivitySupport | null = null;

/** Install (or clear, with `null`) the Activity offscreen runtime. */
export function setActivitySupport(s: ActivitySupport | null): void {
  support = s;
}

/** The installed Activity runtime, or null when the app doesn't use `Activity`. */
export function getActivitySupport(): ActivitySupport | null {
  return support;
}
