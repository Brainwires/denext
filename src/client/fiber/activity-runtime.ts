// The `Activity` offscreen scheduler — the import-gated half of the feature. The generated
// route/Flight entry calls `installActivitySupport()` ONLY when the app uses `Activity`
// (a build-time scan), wiring this begin logic into the reconciler seam
// (`activity-support.ts`). A bundle that never renders an `<Activity>` never references
// this module, so `deno bundle` tree-shakes the whole offscreen runtime out — the same
// lever the class-component and Live runtimes use. The reconciler itself imports only the
// seam, never this file.
//
// It reuses the exact offscreen commit machinery <Suspense> already ships (hide the primary
// DOM with `display:none !important`, disconnect its effects, keep its state cells; restore
// + reconnect on reveal — all in `commit.ts`). This module only decides, at begin-work
// time, WHICH children are the hidden primary and when to hide vs. reveal.

import type { Fiber } from "./fiber.ts";
import type { VNodeChildren } from "../../jsx/types.ts";
import { TransitionLane } from "./fiber.ts";
import { reconcileChildren } from "./reconcile-children.ts";
import { noteOffscreen } from "./state.ts";
import { scheduleUpdateLane } from "./scheduler.ts";
import { revealOffscreenChildren } from "./begin-work.ts";
import { setActivitySupport } from "./activity-support.ts";

function activityChildren(wip: Fiber): VNodeChildren {
  return (wip.vnode.props?.children ?? null) as VNodeChildren;
}

/**
 * Begin an `activity` fiber. `mode="hidden"` keeps the whole subtree mounted-but-hidden
 * (state preserved, effects torn down); `mode="visible"` (the default) renders it live and,
 * when leaving hidden, reveals the preserved instances. A subtree that MOUNTS hidden is
 * pre-rendered at transition priority so it never blocks the initial paint.
 */
function beginActivity(wip: Fiber): Fiber | null {
  const mode = (wip.vnode.props as { mode?: string } | null)?.mode === "hidden"
    ? "hidden"
    : "visible";

  if (mode === "hidden") {
    // Mounting straight into hidden: defer the child pre-render to a transition pass so it
    // never blocks the initial (visible) paint — render nothing this pass. The deferred
    // pass (alternate now set) renders + hides the subtree below.
    if (wip.alternate === null) {
      reconcileChildren(wip, null, wip.host, wip.boundary, wip.inherited);
      scheduleUpdateLane(wip, TransitionLane);
      return null;
    }
    reconcileChildren(wip, activityChildren(wip), wip.host, wip.boundary, wip.inherited);
    // The whole subtree is the hidden primary. A child that already committed (a visible →
    // hidden flip) is kept mounted-as-is — begin-work skips a `hidden` fiber, preserving its
    // committed subtree and NOT consuming its lanes. A freshly-mounted child renders once
    // this pass to create its DOM, which the commit then hides.
    let count = 0;
    for (let c = wip.child; c !== null; c = c.sibling) count++;
    wip.primaryCount = count;
    wip.offscreen = true;
    for (let c = wip.child; c !== null; c = c.sibling) c.hidden = c.alternate !== null;
    noteOffscreen(); // so the commit pass hides the primary DOM + disconnects its effects
    return wip.child;
  }

  reconcileChildren(wip, activityChildren(wip), wip.host, wip.boundary, wip.inherited);
  // Reveal (hidden → visible): un-hide the preserved children, force them to render live, and
  // let the commit restore their DOM + reconnect the effects the hide tore down. The exact
  // same reveal the <Suspense> offscreen path uses.
  if (wip.offscreen === true) revealOffscreenChildren(wip);
  return wip.child;
}

/**
 * Install the Activity offscreen scheduler into the reconciler seam. Emitted by the
 * generated entry (via `denext/client-runtime`) only when the app uses `Activity`; the dev
 * server and tests install it directly. Idempotent.
 */
export function installActivitySupport(): void {
  setActivitySupport({ begin: beginActivity });
}
