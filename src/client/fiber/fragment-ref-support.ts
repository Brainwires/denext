// Client-reconciler seam for React 19.3's Fragment refs (`<Fragment ref={r}>` → a
// `FragmentInstance`). The reconciler commits a ref'd Fragment THROUGH this null-default slot, so
// the always-shipped reconciler never statically imports the instance (fragment-instance.ts:
// event listeners, focus, observers, rects, document position over the fragment's host children).
// The runtime is gated on first use rather than by a build scan — a Fragment ref can come from a
// dependency no scan reads: the first `<Fragment ref>` a render reaches suspends on
// `loadFragmentRefs()` (its nearest Suspense boundary, or the root, which keeps what is on screen),
// and the retry commits the ref as usual. The dynamic `import()` lives HERE, its only importer, so
// the bundler emits the runtime as one on-demand `fragment-instance-*` chunk; the runtime imports
// nothing but types and takes the reconciler helpers it needs from here
// ({@link installFragmentRuntime}), since a chunk that imported shared modules would split the
// shared runtime into more chunks (and more bytes) for every app.

import type { Fiber } from "./fiber.ts";
import { updateRef } from "../dom-props.ts";
import { fiberForNode } from "../dom-fiber-map.ts";

/**
 * Commit a Fragment fiber's ref and host-children tracking. `visible`: attach the ref (creating
 * the fiber's `FragmentInstance` on first use) and sync the listeners / observers onto its current
 * host children; otherwise (hidden by an `<Activity>` / Offscreen, or deleted) detach the ref and
 * release the children.
 */
export type FragmentRefCommit = (fiber: Fiber, visible: boolean) => void;

/** The installed Fragment-ref runtime, or null until the first `<Fragment ref>` loaded it. */
export let fragmentRefs: FragmentRefCommit | null = null;

/** Install (or clear, with `null`) the Fragment-ref runtime. */
export function setFragmentRefs(commit: FragmentRefCommit | null): void {
  fragmentRefs = commit;
}

type FragmentRuntime = typeof import("./fragment-instance.ts");

/** Fill the seam from the loaded runtime module, handing it the reconciler helpers it uses. */
export function installFragmentRuntime(m: FragmentRuntime): void {
  fragmentRefs = m.fragmentRefCommit(updateRef, fiberForNode);
}

let mod: Promise<FragmentRuntime> | undefined;

/**
 * Load and install the Fragment-ref runtime (the `fragment-instance-*` chunk). The import is
 * memoized; the install runs on every call (it is idempotent), so the seam is filled again even
 * if it was cleared after an earlier load. A chunk that fails to load is reported and leaves a
 * no-op in the seam, so the suspended render retries into a tree without the ref instead of
 * suspending forever.
 *
 * @returns Resolves once the seam is filled.
 */
export function loadFragmentRefs(): Promise<void> {
  return (mod ??= import("./fragment-instance.ts")).then(installFragmentRuntime, (err) => {
    console.error("denext: the Fragment-ref runtime failed to load:", err);
    fragmentRefs = () => {};
  });
}
