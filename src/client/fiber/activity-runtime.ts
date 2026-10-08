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
import { NoLane, TransitionLane } from "./fiber.ts";
import { reconcileChildren } from "./reconcile-children.ts";
import { noteOffscreen } from "./state.ts";
import { renderLanes, scheduleUpdateLane } from "./scheduler.ts";
import { revealOffscreenChildren } from "./begin-work.ts";
import { setActivitySupport } from "./activity-support.ts";
import { runCommitEffects } from "./commit.ts";
import { setParkingEffects } from "./hooks-dispatcher.ts";

function activityChildren(wip: Fiber): VNodeChildren {
  return (wip.vnode.props?.children ?? null) as VNodeChildren;
}

/**
 * The hidden half of {@link beginActivity}. Mounting straight into hidden: defer the child
 * pre-render to a transition pass so it never blocks the initial (visible) paint — render
 * nothing this pass; the deferred pass (alternate now set) renders + hides the subtree.
 */
function beginHidden(wip: Fiber): Fiber | null {
  if (wip.alternate === null) {
    reconcileChildren(wip, null, wip.host, wip.boundary, wip.inherited);
    scheduleUpdateLane(wip, TransitionLane);
    return null;
  }
  reconcileChildren(wip, activityChildren(wip), wip.host, wip.boundary, wip.inherited);
  // The whole subtree is the hidden primary, rendered at low priority (React's Offscreen
  // lane): an urgent pass keeps a committed child mounted-as-is — begin-work skips a
  // `hidden` fiber, preserving its committed subtree and NOT consuming its lanes — and
  // defers a child whose props changed to a transition pass, which pre-renders it so a
  // reveal is instant. A freshly-mounted child renders this pass to create its DOM. The
  // commit hides the DOM and parks the subtree's effects (none mount while hidden).
  const lowPriority = (renderLanes & TransitionLane) !== NoLane;
  let count = 0;
  for (let c = wip.child; c !== null; c = c.sibling) {
    count++;
    const old = c.alternate;
    c.hidden = !lowPriority && old !== null;
    if (c.hidden && old!.vnode.props !== c.vnode.props) scheduleUpdateLane(c, TransitionLane);
  }
  wip.primaryCount = count;
  wip.offscreen = true;
  noteOffscreen(); // so the commit pass hides the primary DOM + parks/disconnects effects
  return wip.child;
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

  if (mode === "hidden") return beginHidden(wip);

  reconcileChildren(wip, activityChildren(wip), wip.host, wip.boundary, wip.inherited);
  // Reveal (hidden → visible): un-hide the preserved children, force them to render live, and
  // let the commit restore their DOM + reconnect the effects the hide tore down. The exact
  // same reveal the <Suspense> offscreen path uses.
  if (wip.offscreen === true) revealOffscreenChildren(wip);
  return wip.child;
}

/**
 * Park the queued layout + passive effects of fibers under a hidden `<Activity>` (the commit
 * collects them apart): each entry records its setup as a disconnected `reconnect` instead of
 * running it, so the effect first mounts when the Activity is revealed — React 19.2 mounts no
 * effect in hidden content.
 */
function park(fibers: Fiber[]): void {
  setParkingEffects(true);
  try {
    runCommitEffects(fibers, (f) => {
      const es = (f.pendingEffects ?? []).concat(f.passiveEffects ?? []);
      f.pendingEffects = [];
      f.passiveEffects = [];
      return es;
    });
  } finally {
    setParkingEffects(false);
  }
}

/**
 * Install the Activity offscreen scheduler into the reconciler seam. Emitted by the
 * generated entry (via `denext/client-runtime`) only when the app uses `Activity`; the dev
 * server and tests install it directly. Idempotent.
 */
export function installActivitySupport(): void {
  setActivitySupport({ begin: beginActivity, park });
}
