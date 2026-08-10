/**
 * `React.Profiler` — measures render timing for a subtree and calls `onRender`
 * after each commit. The client reconciler instruments it directly: it times each
 * component's render, so `actualDuration` is the time spent rendering the
 * components that **actually** re-rendered this commit (bailed-out components are
 * excluded), while `baseDuration` is the estimated cost of rendering the whole
 * subtree without memoization (every component's most-recent render time). During
 * server rendering it is a transparent Fragment (no commit, no `onRender`).
 *
 * @module
 */

import type { VNode, VNodeChildren, VProps } from "../jsx/types.ts";
import { FRAGMENT } from "../jsx/types.ts";

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

/** Prop key carrying a Profiler's `{ id, onRender }` to the reconciler. */
export const PROFILER_PROP: string = "__dnxProfiler";

/**
 * Measure render timing for `children` and report it to `onRender` after each
 * commit. Renders as a Fragment carrying the profiler config for the reconciler,
 * so it adds no DOM of its own and is transparent during SSR.
 *
 * @param props The profiler id, `onRender` callback, and children.
 * @returns The children as a Fragment carrying the profiler marker.
 */
export function Profiler(props: ProfilerProps): VNode {
  return {
    type: FRAGMENT,
    key: null,
    props: {
      children: props.children,
      [PROFILER_PROP]: { id: props.id, onRender: props.onRender },
    } as unknown as VProps,
  };
}
