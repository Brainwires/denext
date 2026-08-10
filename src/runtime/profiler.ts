/**
 * `React.Profiler` — measures render timing for a subtree and calls `onRender` after
 * each commit. denext renders synchronously, so the timings are a best-effort
 * approximation (wall-clock from the Profiler's render to its post-commit layout
 * effect, which spans the subtree); `actualDuration` and `baseDuration` are reported
 * as the same measured value. Behaviorally faithful for the common
 * `<Profiler id onRender>` usage; not a substitute for React DevTools' profiler.
 *
 * @module
 */

import { useLayoutEffect, useRef } from "./hooks.ts";
import { h } from "../jsx/jsx-runtime.ts";
import { FRAGMENT, type VNode, type VNodeChildren } from "../jsx/types.ts";

/** The commit phase reported to a Profiler's `onRender`. */
export type ProfilerPhase = "mount" | "update";

/** Callback invoked after each commit of a {@link Profiler}'s subtree. */
export type ProfilerOnRender = (
  id: string,
  phase: ProfilerPhase,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
) => void;

/** Props for {@link Profiler}. */
export interface ProfilerProps {
  /** Identifies the profiled subtree in `onRender`. */
  id: string;
  /** Called after each commit with timing measurements. */
  onRender?: ProfilerOnRender;
  /** The subtree to profile. */
  children?: VNodeChildren;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Measure render timing for `children` and report it to `onRender` after each commit.
 *
 * @param props The profiler id, `onRender` callback, and children.
 * @returns The children (Profiler adds no DOM of its own).
 */
export function Profiler(props: ProfilerProps): VNode {
  const start = useRef(0);
  const mounted = useRef(false);
  start.current = now();
  useLayoutEffect(() => {
    const commitTime = now();
    const duration = commitTime - start.current;
    const phase: ProfilerPhase = mounted.current ? "update" : "mount";
    mounted.current = true;
    props.onRender?.(props.id, phase, duration, duration, start.current, commitTime);
  });
  return h(FRAGMENT, null, props.children);
}
