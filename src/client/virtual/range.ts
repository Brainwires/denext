/**
 * Range math for `VirtualList`: which rows to render for a viewport, with pixel overscan that
 * grows in the direction of travel as the scroll velocity rises (fewer blank frames on a
 * fling, react-window #515 / FlashList #618) and hysteresis so a scroll inside the rendered
 * window re-renders nothing.
 *
 * @module
 */

import type { SizeTree } from "./size-tree.ts";

/** An inclusive row range; `last < first` is empty. */
export interface RowRange {
  /** First row. */
  readonly first: number;
  /** Last row (inclusive). */
  readonly last: number;
}

/** The empty range. */
export const EMPTY_RANGE: RowRange = { first: 0, last: -1 };

/** Overscan in px on each side of the viewport. */
export interface Overscan {
  /** Toward the start. */
  readonly before: number;
  /** Toward the end. */
  readonly after: number;
}

/** Velocity (px/ms) above which the trailing overscan is trimmed to its floor. */
const FAST = 4;

/**
 * Split a base overscan across both sides by velocity (px/ms, signed: positive toward the
 * end). At rest both sides get `base`; moving, the leading side grows up to 3× and the
 * trailing side shrinks to a quarter.
 */
export function overscanFor(base: number, velocity: number): Overscan {
  const speed = Math.min(Math.abs(velocity), FAST * 2);
  const lead = base * (1 + speed / 4);
  const trail = base * Math.max(0.25, 1 - speed / FAST);
  if (velocity > 0) return { before: trail, after: lead };
  if (velocity < 0) return { before: lead, after: trail };
  return { before: base, after: base };
}

/** Rows intersecting `[from, to)` of the list (`EMPTY_RANGE` for an empty tree). */
export function rowsBetween(tree: SizeTree, from: number, to: number): RowRange {
  if (tree.count === 0 || to <= from) return EMPTY_RANGE;
  const first = tree.indexAt(Math.max(0, from));
  let last = tree.indexAt(Math.max(0, to));
  if (last > first && tree.offsetOf(last) >= to) last--;
  return { first, last: Math.max(first, last) };
}

/** Rows visible in a viewport of `vp` px at virtual offset `v`. */
export function visibleRange(tree: SizeTree, v: number, vp: number): RowRange {
  if (tree.count === 0) return EMPTY_RANGE;
  const top = Math.max(0, v);
  const bottom = v + vp;
  if (bottom <= 0 || top >= tree.total) {
    const edge = top >= tree.total ? tree.count - 1 : 0;
    return { first: edge, last: edge };
  }
  return rowsBetween(tree, top, Math.min(bottom, tree.total));
}

/** Rows to render: the visible rows plus `overscan` px on each side. */
export function desiredRange(tree: SizeTree, v: number, vp: number, overscan: Overscan): RowRange {
  if (tree.count === 0) return EMPTY_RANGE;
  const from = Math.max(0, Math.min(v, tree.total) - overscan.before);
  const to = Math.min(tree.total, Math.max(v + vp, 0) + overscan.after);
  if (to <= from) {
    const edge = tree.indexAt(from);
    return { first: edge, last: edge };
  }
  return rowsBetween(tree, from, to);
}

/** Whether `inner` lies inside `outer`. */
function contains(outer: RowRange, inner: RowRange): boolean {
  if (inner.last < inner.first) return true;
  return outer.last >= outer.first && inner.first >= outer.first && inner.last <= outer.last;
}

/** Whether two ranges are the same. */
export function sameRange(a: RowRange, b: RowRange): boolean {
  return a.first === b.first && a.last === b.last;
}

/**
 * The range to render next. The current range is kept (no re-render) while it still covers
 * the viewport plus a quarter of the base overscan on each side and is not more than twice
 * the desired size; otherwise the desired range (velocity-scaled) replaces it.
 */
export function nextRange(
  tree: SizeTree,
  current: RowRange,
  v: number,
  vp: number,
  base: number,
  velocity: number,
): RowRange {
  const desired = desiredRange(tree, v, vp, overscanFor(base, velocity));
  if (current.last < current.first || current.last >= tree.count) return desired;
  const margin = base / 4;
  const required = desiredRange(tree, v, vp, { before: margin, after: margin });
  const bloated = current.last - current.first > 2 * (desired.last - desired.first) + 8;
  return contains(current, required) && !bloated ? current : desired;
}
