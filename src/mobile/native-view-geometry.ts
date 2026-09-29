/**
 * The geometry behind `NativeViewSlot` (denext/mobile): where a slot's box is on screen, what
 * part of it its scrolling ancestors and the viewport leave visible, whether page content sits
 * on top of it, and which regions over it belong to the page (DOM overlays). Pure functions over
 * a small DOM surface, so the tracker can run them every frame and tests can feed them boxes.
 * Internal to `denext/mobile`; not re-exported.
 *
 * @module
 */

/** An axis-aligned box in CSS px. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What `getBoundingClientRect()` returns, as far as the geometry reads it. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The slice of an element the geometry reads. */
export interface GeometryElement {
  getBoundingClientRect(): RectLike;
  readonly parentElement?: GeometryElement | null;
  readonly clientLeft?: number;
  readonly clientTop?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  contains?(other: unknown): boolean;
  readonly scrollLeft?: number;
  readonly scrollTop?: number;
  readonly scrollWidth?: number;
  readonly scrollHeight?: number;
}

/** The computed style properties that make an element clip its descendants. */
export interface ClipStyle {
  readonly overflow?: string;
  readonly overflowX?: string;
  readonly overflowY?: string;
  readonly contain?: string;
}

/** The visual viewport, as the geometry reads it (layout viewport coordinates, and zoom). */
export interface ViewportLike {
  readonly offsetLeft: number;
  readonly offsetTop: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** `r` as a {@linkcode Box}. */
export function boxOf(r: RectLike): Box {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** The overlap of `a` and `b`, or null when they do not overlap (touching edges included). */
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Whether an `overflow*` value clips (anything but `visible`). */
function clipsAxis(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "visible";
}

/** Whether an element with computed style `s` clips its descendants' painting. */
export function clipsContent(s: ClipStyle): boolean {
  if (clipsAxis(s.overflow) || clipsAxis(s.overflowX) || clipsAxis(s.overflowY)) return true;
  return /\b(?:paint|strict|content)\b/.test(s.contain ?? "");
}

/**
 * The ancestors of `el` (nearest first) that clip it: scroll containers, `overflow: hidden` /
 * `clip` boxes and `contain: paint`. Collected once per slot and refreshed when the slot is
 * re-parented or resized; the boxes are re-measured every frame.
 *
 * @param el The slot element.
 * @param styleOf Returns an element's computed style.
 * @returns The clipping ancestors.
 */
export function clippingAncestors(
  el: GeometryElement,
  styleOf: (el: GeometryElement) => ClipStyle | undefined,
): GeometryElement[] {
  const out: GeometryElement[] = [];
  for (let p = el.parentElement ?? null; p; p = p.parentElement ?? null) {
    const style = styleOf(p);
    if (style && clipsContent(style)) out.push(p);
  }
  return out;
}

/**
 * An element's padding box (what it clips its children to): its border box inset by its borders,
 * and without scrollbars when `clientWidth` / `clientHeight` are known.
 */
export function paddingBox(el: GeometryElement): Box {
  const r = boxOf(el.getBoundingClientRect());
  const left = el.clientLeft ?? 0;
  const top = el.clientTop ?? 0;
  const width = el.clientWidth || r.width - 2 * left;
  const height = el.clientHeight || r.height - 2 * top;
  return { x: r.x + left, y: r.y + top, width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * The visible part of `box`: clipped by each of `clippers` and by the viewport, or null when
 * nothing of it is visible.
 */
export function visiblePart(
  box: Box,
  clippers: readonly GeometryElement[],
  viewport: Box,
): Box | null {
  let visible: Box | null = intersect(box, viewport);
  for (const c of clippers) {
    if (!visible) return null;
    visible = intersect(visible, paddingBox(c));
  }
  return visible;
}

/**
 * `box` (layout viewport coordinates, as `getBoundingClientRect` gives them) in visual viewport
 * coordinates, which is where it is on screen: shifted by the visual viewport's offset (iOS moves
 * it when the keyboard opens over a page that does not resize) and scaled by pinch zoom.
 */
export function toScreen(box: Box, vv: ViewportLike | undefined): Box {
  if (!vv) return box;
  const s = vv.scale || 1;
  return {
    x: (box.x - vv.offsetLeft) * s,
    y: (box.y - vv.offsetTop) * s,
    width: box.width * s,
    height: box.height * s,
  };
}

/**
 * Points to hit-test over the visible part of a slot: its center and its four corners pulled in
 * by 2 px (so a neighbour's edge never counts as covering it).
 */
export function samplePoints(box: Box): Array<readonly [number, number]> {
  const inset = Math.min(2, box.width / 4, box.height / 4);
  const left = box.x + inset;
  const top = box.y + inset;
  const right = box.x + box.width - inset;
  const bottom = box.y + box.height - inset;
  return [
    [box.x + box.width / 2, box.y + box.height / 2],
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
}

/**
 * Whether the hit-test stack at one point (topmost first) shows page content over the slot `el`:
 * the first element that is neither `el`, inside it, nor one of its ancestors (an ancestor never
 * paints over its descendants; a stack can list one first when the slot itself takes no hits).
 */
function coveredAt(el: GeometryElement, stack: readonly unknown[]): boolean {
  for (const hit of stack) {
    if (hit === null || hit === undefined) continue;
    if (hit === el || (el.contains?.(hit) ?? false)) return false;
    const ancestor = (hit as GeometryElement).contains?.(el) ?? false;
    if (!ancestor) return true;
  }
  return false;
}

/**
 * Whether page content covers part of the slot `el`: at some sample point of `visible`, an element
 * that is not the slot, inside it, or one of its ancestors is on top (a modal, a sheet, a sticky
 * header). Points the hit test cannot answer (an empty stack) do not count.
 *
 * @param el The slot element.
 * @param visible The slot's visible part (layout viewport coordinates).
 * @param hitTest The elements at a point, topmost first (`document.elementsFromPoint`).
 * @returns Whether page content covers the slot.
 */
export function isOccluded(
  el: GeometryElement,
  visible: Box,
  hitTest: (x: number, y: number) => readonly unknown[],
): boolean {
  return samplePoints(visible).some(([x, y]) => coveredAt(el, hitTest(x, y)));
}

/** A box rounded to 1/100 px, for comparing frames without float noise. */
export function roundBox(b: Box): Box {
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) };
}

/** Whether an `overflow*` value lets the element scroll. */
function scrollsAxis(value: string | undefined): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

/** Whether `el` (computed style `s`) is a scroll container with something to scroll. */
function isScroller(el: GeometryElement, s: ClipStyle): boolean {
  const y = scrollsAxis(s.overflowY ?? s.overflow) &&
    (el.scrollHeight ?? 0) > (el.clientHeight ?? 0);
  const x = scrollsAxis(s.overflowX ?? s.overflow) &&
    (el.scrollWidth ?? 0) > (el.clientWidth ?? 0);
  return x || y;
}

/**
 * The nearest of `clippers` (the slot's clipping ancestors, nearest first) that scrolls, or null
 * when the slot scrolls with the document. The native side follows this scroller's offset itself.
 */
export function nearestScroller(
  clippers: readonly GeometryElement[],
  styleOf: (el: GeometryElement) => ClipStyle | undefined,
): GeometryElement | null {
  for (const c of clippers) {
    const s = styleOf(c);
    if (s && isScroller(c, s)) return c;
  }
  return null;
}
