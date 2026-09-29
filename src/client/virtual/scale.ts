/**
 * Scroll scaling for lists taller than a browser can lay out. Firefox caps an element at
 * 17,187,496 px and Chromium near 33.5M px (Mozilla bug 1527883, TanStack/virtual #616), so
 * 1M variable rows (or 10M fixed ones) cannot get a 1:1 scroll height. Above
 * {@linkcode DEFAULT_MAX_PHYSICAL_SIZE} the list lays out a capped **physical** height and maps
 * it linearly onto the **virtual** one: scrollbar position ↔ list position stays proportional,
 * while the engine keeps small scrolls 1:1 (it adds scroll deltas to the virtual offset and
 * re-syncs the physical offset to the mapping only when the scroller settles; see core.ts).
 *
 * @module
 */

/**
 * The largest physical scroll size the list lays out: below every engine's element-size
 * limit (Firefox ~17.19M px) with a wide margin for headers, footers and zoom.
 */
export const DEFAULT_MAX_PHYSICAL_SIZE = 8_000_000;

/** The physical extent to lay out for a virtual extent of `virtual` px. */
export function physicalExtent(virtual: number, max: number = DEFAULT_MAX_PHYSICAL_SIZE): number {
  return Math.max(0, Math.min(virtual, max));
}

/** Whether a virtual extent of `virtual` px needs scaling. */
export function isScaled(virtual: number, max: number = DEFAULT_MAX_PHYSICAL_SIZE): boolean {
  return virtual > max;
}

/**
 * The virtual px per physical px of scroll range: `(virtual - viewport) / (physical -
 * viewport)`, or 1 when no scaling applies.
 */
export function scrollRatio(
  virtual: number,
  viewport: number,
  max: number = DEFAULT_MAX_PHYSICAL_SIZE,
): number {
  if (!isScaled(virtual, max)) return 1;
  const physRange = physicalExtent(virtual, max) - viewport;
  const virtRange = virtual - viewport;
  return physRange > 0 && virtRange > 0 ? virtRange / physRange : 1;
}

/** The physical scroll offset that shows virtual offset `v` (the linear mapping). */
export function toPhysical(
  v: number,
  virtual: number,
  viewport: number,
  max: number = DEFAULT_MAX_PHYSICAL_SIZE,
): number {
  return v / scrollRatio(virtual, viewport, max);
}

/** The virtual offset shown at physical scroll offset `s` (the linear mapping). */
export function toVirtual(
  s: number,
  virtual: number,
  viewport: number,
  max: number = DEFAULT_MAX_PHYSICAL_SIZE,
): number {
  return s * scrollRatio(virtual, viewport, max);
}
