// Where Loopy's transparent window lets clicks through: the plan this runtime allows, and the
// click-catching rectangles of Loopy, its bubble and its buttons. Pure (no denext or DOM APIs), so
// it is unit-tested.

/**
 * The attribute that marks an element as catching clicks: Loopy itself, its bubble and its buttons.
 * Only these take the mouse; the rest of the transparent window (the empty space above Loopy where
 * no bubble is shown, the room beside it) lets clicks through to the window behind.
 */
export const HIT_ATTRIBUTE = "data-loopy-hit";

/** The selector for {@linkcode HIT_ATTRIBUTE}. */
export const HIT_SELECTOR = `[${HIT_ATTRIBUTE}]`;

/** A rectangle in page CSS pixels. */
export interface HitRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How the window lets clicks through outside Loopy. */
export type ClickThroughPlan = "region" | "forward" | "none";

/**
 * The best way this runtime has to let clicks through everywhere but Loopy: a native hit region,
 * else click-through whose pointer moves still reach the page (so it can catch clicks again over
 * Loopy), else none (the window catches every click, as an opaque card would).
 */
export function clickThroughPlan(
  caps: {
    readonly hitRegion?: unknown;
    readonly clickThrough?: unknown;
    readonly clickThroughForward?: unknown;
  },
): ClickThroughPlan {
  if (caps.hitRegion === true) return "region";
  if (caps.clickThrough === true && caps.clickThroughForward === true) return "forward";
  return "none";
}

/**
 * The click-catching rectangles of `boxes` (page CSS pixels, as `getBoundingClientRect()` gives
 * them), rounded outwards; empty boxes (a closed bubble) are left out.
 */
export function hitRects(
  boxes: readonly {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  }[],
): HitRect[] {
  return boxes.flatMap((b) => {
    const x = Math.floor(b.left);
    const y = Math.floor(b.top);
    const width = Math.ceil(b.right) - x;
    const height = Math.ceil(b.bottom) - y;
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  });
}

/** Whether `point` is inside one of `rects`. */
export function insideAny(rects: readonly HitRect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
}
