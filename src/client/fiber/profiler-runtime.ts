// The <Profiler> commit runtime: fires each committed Profiler's `onRender`. It ships only with
// `Profiler`: the element's marker prop carries `fireProfilers` (runtime/profiler.ts), and
// beginWork hands it to the commit (`noteProfiler`), so the always-shipped reconciler never
// imports this module and an app that never renders a Profiler bundles none of it.

import { type Fiber, hasBit, ProfilerMountedBit } from "./fiber.ts";
import { walk } from "./fiber-utils.ts";
import type { ProfilerPhase } from "../../runtime/profiler.ts";

/**
 * For each committed `<Profiler>` boundary, fire its `onRender` with the subtree's
 * `actualDuration` (components that rendered this commit) and `baseDuration` (every
 * component's most-recent render time, so a fully-memoized commit has actual ≪ base).
 */
export function fireProfilers(root: Fiber): void {
  const commitTime = performance.now();
  walk(root, (f) => {
    const profiler = f.ext?.profiler;
    if (profiler == null) return;
    let actual = 0;
    let base = 0;
    walk(f, (d) => {
      actual += d.ext?.actualDuration ?? 0;
      base += d.ext?.selfBaseDuration ?? 0;
    });
    const phase: ProfilerPhase = hasBit(f, ProfilerMountedBit) ? "update" : "mount";
    f.bits |= ProfilerMountedBit;
    profiler.onRender?.(profiler.id, phase, actual, base, commitTime - actual, commitTime);
  });
}
