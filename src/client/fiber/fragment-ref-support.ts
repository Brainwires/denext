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

/** The seam's no-op after a failed load: the render retries into a tree without the ref. */
const failed: FragmentRefCommit = () => {};

/** Failed loads in a row, and when (ms since the epoch) the next Fragment ref may load again. */
let failures = 0;
let retryAt = 0;

/** A chunk that failed this many loads in a row is not tried again for the page's life. */
const MAX_LOADS = 5;

/**
 * Load and install the Fragment-ref runtime (the `fragment-instance-*` chunk). The import is
 * memoized; the install runs on every call (it is idempotent), so the seam is filled again even
 * if it was cleared after an earlier load. A chunk that fails to load is reported and leaves a
 * no-op in the seam, so the suspended render retries into a tree without the ref instead of
 * suspending forever; the import is forgotten, so a later Fragment ref loads it again once the
 * backoff has passed (see {@linkcode fragmentRuntimeLoad}).
 *
 * @returns Resolves once the seam is filled.
 */
export function loadFragmentRefs(): Promise<void> {
  return (mod ??= importRuntime()).then((m) => {
    failures = 0;
    installFragmentRuntime(m);
  }, (err) => {
    console.error("denext: the Fragment-ref runtime failed to load:", err);
    mod = undefined;
    retryAt = Date.now() + 1000 * 2 ** failures++; // 1 s, 2 s, 4 s, 8 s
    fragmentRefs = failed;
  });
}

/**
 * The load a render reaching a `<Fragment ref>` suspends on: the first one, or, after a failed
 * load, the next one once its backoff has passed (up to {@linkcode MAX_LOADS} in a row, so a chunk
 * that is gone for good is not fetched forever). `undefined` when the render goes on.
 */
export function fragmentRuntimeLoad(): Promise<void> | undefined {
  if (
    fragmentRefs === null ||
    (fragmentRefs === failed && failures < MAX_LOADS && Date.now() >= retryAt)
  ) return loadFragmentRefs();
}

/**
 * Test seam: replace the runtime chunk's import (`null` restores it), forgetting a loaded one and
 * any failed loads.
 *
 * @param load The import to use, or `null` for the real one.
 */
export function __setFragmentRuntimeImportForTests(
  load: (() => Promise<FragmentRuntime>) | null,
): void {
  importRuntime = load ?? (() => import("./fragment-instance.ts"));
  mod = undefined;
  failures = 0;
  retryAt = 0;
}

/** The runtime chunk's import (a test seam: {@linkcode __setFragmentRuntimeImportForTests}). */
let importRuntime = () => import("./fragment-instance.ts");
