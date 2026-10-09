/**
 * The gesture math of {@linkcode SwipeableRow}, free of the DOM so it can be tested with plain
 * numbers: the two-way axis lock, the content offset for a drag (rubber band past the actions,
 * or following the finger toward a full swipe), the action buttons' positions, and where a
 * released row settles.
 *
 * @module
 */

import { rubberband } from "../../navigation/gesture.ts";

/** One side of a row: how far it opens and whether a full swipe runs its first action. */
export interface RowSide {
  /** The open width in px (`0`: the side has nothing to reveal). */
  readonly width: number;
  /** Whether swiping past {@linkcode RowGeometry.fullThreshold} runs the side's first action. */
  readonly full: boolean;
}

/** A row's geometry, as the gesture reads it. */
export interface RowGeometry {
  /** The leading side (revealed by a rightward swipe). */
  readonly leading: RowSide;
  /** The trailing side (revealed by a leftward swipe). */
  readonly trailing: RowSide;
  /** The row's width in px. */
  readonly rowWidth: number;
  /** The fraction of the row width past which a release is a full swipe (default `0.55`). */
  readonly fullThreshold?: number;
}

/** Where a released row goes. */
export type RowSettle = "closed" | "leading" | "trailing" | "full-leading" | "full-trailing";

/**
 * The axis decision for a movement of `dx`/`dy` px since the touch started, either way:
 * `"pending"` under `lockDistance`, `"horizontal"` when it moved at least `ratio` × as much
 * across as down (so a scroll keeps the touch), else `"reject"`.
 */
export function lockRowAxis(
  dx: number,
  dy: number,
  lockDistance = 10,
  ratio = 1.2,
): "pending" | "horizontal" | "reject" {
  if (Math.hypot(dx, dy) < lockDistance) return "pending";
  return Math.abs(dx) >= ratio * Math.abs(dy) ? "horizontal" : "reject";
}

/** The distance at which `side` counts as fully swiped, in px. */
export function fullDistance(g: RowGeometry, side: RowSide): number {
  const threshold = g.rowWidth * (g.fullThreshold ?? 0.55);
  return Math.max(side.width + 24, threshold);
}

/** The offset of one side for a raw drag of `raw` px toward it (positive). */
function sideOffset(raw: number, side: RowSide, rowWidth: number): number {
  if (raw <= 0 || side.width <= 0) return 0;
  if (side.full) return Math.min(raw, rowWidth);
  return raw <= side.width ? raw : side.width + rubberband(raw - side.width, rowWidth);
}

/**
 * The content's offset for a raw drag position (`start + dx`): it follows the finger over a
 * side's actions, then either keeps following toward a full swipe or resists (rubber band);
 * a side with nothing to reveal does not move.
 */
export function rowOffset(raw: number, g: RowGeometry): number {
  if (raw >= 0) return sideOffset(raw, g.leading, g.rowWidth);
  return -sideOffset(-raw, g.trailing, g.rowWidth);
}

/** Whether `offset` is past the full-swipe distance of the side it reveals. */
export function isFullSwipe(offset: number, g: RowGeometry): boolean {
  if (offset > 0) return g.leading.full && offset >= fullDistance(g, g.leading);
  if (offset < 0) return g.trailing.full && -offset >= fullDistance(g, g.trailing);
  return false;
}

/** How long a release's momentum is projected forward when deciding open or closed, in ms. */
const PROJECTION_MS = 120;

/**
 * Where a row released at `offset` with horizontal `velocityX` (px/ms) settles: a full swipe
 * past its distance; otherwise open when the momentum carries it past half the side's width,
 * else closed.
 */
export function settleRow(offset: number, velocityX: number, g: RowGeometry): RowSettle {
  if (isFullSwipe(offset, g)) return offset > 0 ? "full-leading" : "full-trailing";
  const projected = offset + velocityX * PROJECTION_MS;
  if (offset > 0) return projected >= g.leading.width / 2 ? "leading" : "closed";
  if (offset < 0) return -projected >= g.trailing.width / 2 ? "trailing" : "closed";
  return "closed";
}

/**
 * The x position, in px from the row's side edge, of the inner end of action `i` (0 = the
 * outermost) of `count` actions when the content is `reveal` px open: the actions share the
 * revealed area, sliding out from under the content; past a full swipe the outermost covers it
 * all (its end follows the content's edge).
 */
export function actionEnd(i: number, count: number, reveal: number, full: boolean): number {
  if (count <= 0) return 0;
  if (full && i === 0) return reveal;
  return (reveal * (i + 1)) / count;
}
