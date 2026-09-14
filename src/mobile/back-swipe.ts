/**
 * Swipe-right-to-go-back for `denext/mobile`: a touch gesture that fires a callback, yielding to
 * text fields and to horizontal scrollers that still have room to scroll.
 *
 * @module
 */

import { useCallback, useRef } from "../runtime/hooks.ts";

/** Options for {@linkcode useBackSwipe} and {@linkcode isBackSwipe}. */
export interface BackSwipeOptions {
  /** Minimum rightward travel, in CSS px, before the swipe counts (default `72`). */
  readonly minDistance?: number;
  /** Horizontal travel must be at least `ratio` × the vertical travel (default `1.4`). */
  readonly ratio?: number;
  /** `false` ignores new gestures without unbinding (default `true`). Read at gesture start. */
  readonly enabled?: boolean;
}

/**
 * The pure gesture test behind {@linkcode useBackSwipe}: whether a movement of `dx`/`dy` CSS px
 * from the touch start is a back swipe, i.e. rightward by at least `minDistance` and
 * horizontal by at least `ratio` × the absolute vertical movement.
 *
 * @param dx Horizontal movement since the touch started (positive = rightward).
 * @param dy Vertical movement since the touch started (sign ignored).
 * @param opts `{ minDistance = 72, ratio = 1.4 }`; `enabled` is not consulted here.
 * @returns `true` when the movement qualifies as a back swipe.
 * @example
 * ```ts
 * import { isBackSwipe } from "denext/mobile";
 * isBackSwipe(80, 20); // true: 80 ≥ 72 and 80 ≥ 1.4 × 20
 * isBackSwipe(80, 60); // false: too diagonal
 * ```
 */
export function isBackSwipe(dx: number, dy: number, opts: BackSwipeOptions = {}): boolean {
  const { minDistance = 72, ratio = 1.4 } = opts;
  return dx >= minDistance && dx >= ratio * Math.abs(dy);
}

/** The element fields the yield check reads. */
interface ElementLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly scrollLeft?: number;
  readonly parentElement?: ElementLike | null;
}

/** Whether `el` takes text or selection input: `input`, `textarea`, `select`, contenteditable. */
function isEditable(el: ElementLike): boolean {
  return /^(?:INPUT|TEXTAREA|SELECT)$/i.test(el.tagName ?? "") || el.isContentEditable === true;
}

/** Whether a gesture over `el` belongs to it: an editable control, or a scroller not at its start. */
function claimsGesture(el: ElementLike): boolean {
  return isEditable(el) || (el.scrollLeft ?? 0) > 0;
}

/** The event's target and its ancestors (through shadow roots when `composedPath` exists). */
function eventPath(event: PointerEvent): ElementLike[] {
  if (typeof event.composedPath === "function") return event.composedPath() as ElementLike[];
  const path: ElementLike[] = [];
  for (let el = event.target as ElementLike | null; el; el = el.parentElement ?? null) {
    path.push(el);
  }
  return path;
}

/** Whether a gesture starting at `event` must be left alone. */
function startsInYieldingElement(event: PointerEvent): boolean {
  return eventPath(event).some(claimsGesture);
}

/** The pointer being tracked and where it went down. */
interface Track {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Begin tracking a primary touch, unless the options or the target say to yield. */
function startTrack(event: PointerEvent, opts: BackSwipeOptions): Track | null {
  if (event.isPrimary === false || opts.enabled === false) return null;
  if (startsInYieldingElement(event)) return null;
  return { id: event.pointerId, x: event.clientX, y: event.clientY };
}

/** Bind the gesture to `el`; `options()` and `fire` are read live. Returns the unbind function. */
function bindBackSwipe(
  el: EventTarget,
  fire: () => void,
  options: () => BackSwipeOptions,
): () => void {
  let track: Track | null = null;
  const down = (event: PointerEvent) => {
    if (event.pointerType === "touch") track = startTrack(event, options());
  };
  const move = (event: PointerEvent) => {
    if (!track || event.pointerId !== track.id) return;
    if (!isBackSwipe(event.clientX - track.x, event.clientY - track.y, options())) return;
    track = null;
    fire();
  };
  const end = (event: PointerEvent) => {
    if (track && event.pointerId === track.id) track = null;
  };
  const pairs = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", end],
    ["pointercancel", end],
  ] as const;
  for (const [type, fn] of pairs) el.addEventListener(type, fn as EventListener, { passive: true });
  return () => {
    for (const [type, fn] of pairs) el.removeEventListener(type, fn as EventListener);
  };
}

/**
 * Swipe right to go back. Returns a ref callback: attach it to the element that should
 * recognize the gesture (often the page's scroll container). A touch that travels rightward at
 * least `minDistance` CSS px (default 72), with horizontal travel at least `ratio` (default
 * 1.4) × vertical travel, fires `onBack` once, as soon as it qualifies.
 *
 * It yields, and never fires, when the touch starts inside an editable element (`input`,
 * `textarea`, `select`, contenteditable) or inside an element scrolled away from its left
 * edge (`scrollLeft > 0`), so carousels and code blocks keep their own horizontal pans. Only
 * touch pointers count (`pointerType === "touch"`); mouse and pen are ignored.
 *
 * `onBack` and `opts` are held in refs: changing them between renders never re-binds, and the
 * returned ref callback is stable. Give the element `touch-action: pan-y` so the browser does
 * not claim horizontal pans for itself (which would cancel the pointer stream).
 *
 * @param onBack Called when a back swipe is recognized, e.g. `() => router.back()`.
 * @param opts {@linkcode BackSwipeOptions}: `minDistance`, `ratio`, `enabled`.
 * @returns A ref callback for the element to watch.
 * @example
 * ```tsx
 * "use client";
 * import { useRouter } from "denext";
 * import { useBackSwipe } from "denext/mobile";
 *
 * export function Screen({ children }: { children: unknown }) {
 *   const router = useRouter();
 *   const ref = useBackSwipe(() => router.back());
 *   return <main ref={ref} style={{ touchAction: "pan-y" }}>{children}</main>;
 * }
 * ```
 */
export function useBackSwipe(
  onBack: () => void,
  opts: BackSwipeOptions = {},
): (el: Element | null) => void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const unbindRef = useRef<(() => void) | null>(null);
  return useCallback((el: Element | null) => {
    unbindRef.current?.();
    unbindRef.current = el
      ? bindBackSwipe(el, () => onBackRef.current(), () => optsRef.current)
      : null;
  }, []);
}
