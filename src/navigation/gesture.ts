/**
 * The gesture math of `denext/navigation`, free of the DOM so it can be tested with plain
 * numbers: the velocity tracker, the iOS edge swipe (edge hit-test, axis lock, progress, the
 * commit-or-cancel release), the rubber band, and the sheet's detent resolution and snapping.
 *
 * @module
 */

import type { SheetDetent } from "./types.ts";

/** Tunables of the iOS interactive back swipe ({@linkcode EdgeSwipeTracker}). */
export interface EdgeSwipeConfig {
  /** How far from the left edge, in CSS px, a swipe may start (default `20`). */
  readonly edgeWidth?: number;
  /** Movement, in CSS px, before the axis is decided (default `10`). */
  readonly lockDistance?: number;
  /** Progress (0…1) past which a slow release commits (default `0.5`). */
  readonly commitProgress?: number;
  /** Horizontal speed, in px/ms, past which a release commits (or cancels, leftward) (default `0.3`). */
  readonly commitVelocity?: number;
  /**
   * How much more horizontal than vertical the movement must be for the axis to lock (default
   * `1`; the full-screen swipe uses `1.4`, so a slightly diagonal scroll stays a scroll).
   */
  readonly lockRatio?: number;
  /**
   * The distance, in CSS px, a fast release must have travelled to commit on its velocity alone
   * (default `0`; the full-screen swipe uses `72`, so a short flick mid-screen does not pop).
   */
  readonly minFlingDistance?: number;
}

/**
 * The tunables of the full-screen back swipe (a swipe that may start anywhere on the screen,
 * not only at the left edge): the axis locks only when the movement is at least 1.4 × as
 * horizontal as vertical, and a fling commits only past 72 px — the gesture rule T3 Code's
 * native app uses for its thread back swipe.
 */
export const FULL_SCREEN_SWIPE: EdgeSwipeConfig = {
  edgeWidth: Infinity,
  lockRatio: 1.4,
  minFlingDistance: 72,
};

/** What {@linkcode EdgeSwipeTracker.move} reports. */
export type SwipeMove =
  /** Not decided yet: under the lock distance. */
  | { readonly phase: "pending" }
  /** Vertical or leftward: the swipe is abandoned (scrolling keeps the touch). */
  | { readonly phase: "rejected" }
  /** Locked horizontal: the screen follows the finger. */
  | { readonly phase: "tracking"; readonly dx: number; readonly progress: number };

/** How a released swipe ends. */
export type SwipeRelease = "commit" | "cancel";

/** The velocity tracker's sample window, in ms. */
const VELOCITY_WINDOW_MS = 100;

/** One pointer position at a time. */
interface Sample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The pointer's recent velocity: the displacement over the last 100 ms of samples, in px/ms
 * (positive = right / down). With fewer than two samples it reads `0`.
 */
export class VelocityTracker {
  #samples: Sample[] = [];

  /** Record a position at time `t` (ms). */
  add(t: number, x: number, y: number): void {
    this.#samples.push({ t, x, y });
    const cutoff = t - VELOCITY_WINDOW_MS;
    while (this.#samples.length > 2 && this.#samples[0].t < cutoff) this.#samples.shift();
  }

  /** Forget every sample. */
  reset(): void {
    this.#samples = [];
  }

  /** The velocity over the window, `{ x, y }` in px/ms. */
  velocity(): { x: number; y: number } {
    const s = this.#samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const first = s[0];
    const last = s[s.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}

/** `value` clamped into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Whether a touch at `x` starts in the edge zone of a container whose left edge is at `left`.
 *
 * @param x The touch's `clientX`.
 * @param left The container's left edge (`getBoundingClientRect().left`).
 * @param edgeWidth The zone's width in px (default `20`).
 */
export function inEdgeZone(x: number, left: number, edgeWidth = 20): boolean {
  return x >= left && x - left <= edgeWidth;
}

/**
 * The axis decision for a movement of `dx`/`dy` px since the touch started: `"pending"` under
 * `lockDistance`, then `"horizontal"` when it moved right at least `ratio` × as much as it
 * moved vertically, else `"reject"` (vertical scrolling, or a leftward swipe, keeps the touch).
 */
export function lockAxis(
  dx: number,
  dy: number,
  lockDistance = 10,
  ratio = 1,
): "pending" | "horizontal" | "reject" {
  if (Math.hypot(dx, dy) < lockDistance) return "pending";
  return dx > 0 && dx >= ratio * Math.abs(dy) ? "horizontal" : "reject";
}

/**
 * Whether a released swipe commits (pops) or cancels: a fast rightward fling commits and a
 * fast leftward one cancels whatever the distance; otherwise it commits past `commitProgress`.
 *
 * @param progress How far the screen went, 0…1.
 * @param velocityX The release velocity in px/ms (positive = rightward).
 * @param config The tunables; a `minFlingDistance` needs `distance`.
 * @param distance How far the finger travelled, in px (default: past any `minFlingDistance`).
 */
export function releaseSwipe(
  progress: number,
  velocityX: number,
  config: EdgeSwipeConfig = {},
  distance = Infinity,
): SwipeRelease {
  const threshold = config.commitVelocity ?? 0.3;
  if (velocityX >= threshold && distance >= (config.minFlingDistance ?? 0)) return "commit";
  if (velocityX <= -threshold) return "cancel";
  return progress >= (config.commitProgress ?? 0.5) ? "commit" : "cancel";
}

/**
 * The iOS interactive back swipe as a state machine over pointer positions: {@linkcode start}
 * accepts a touch in the left edge zone (anywhere with {@linkcode FULL_SCREEN_SWIPE}), {@linkcode move} locks the axis after the first
 * `lockDistance` px and then reports the screen's offset and progress, and {@linkcode end}
 * decides commit or cancel from the progress and the release velocity. It never touches the
 * DOM (and so never writes a scroll position).
 */
export class EdgeSwipeTracker {
  readonly #config: EdgeSwipeConfig;
  #origin: Sample | null = null;
  #width = 1;
  #locked = false;
  #progress = 0;
  #dx = 0;
  readonly #velocity = new VelocityTracker();

  constructor(config: EdgeSwipeConfig = {}) {
    this.#config = config;
  }

  /** Whether a swipe is being tracked (started and not rejected or ended). */
  get active(): boolean {
    return this.#origin !== null;
  }

  /** Whether the axis locked horizontal (the screen is following the finger). */
  get tracking(): boolean {
    return this.#locked;
  }

  /**
   * Begin a swipe at (`x`, `y`) at time `t` over a container at `left` that is `width` px
   * wide. Returns `false` (and tracks nothing) outside the edge zone.
   */
  start(x: number, y: number, t: number, left: number, width: number): boolean {
    this.cancel();
    if (!inEdgeZone(x, left, this.#config.edgeWidth ?? 20)) return false;
    this.#origin = { t, x, y };
    this.#width = Math.max(1, width);
    this.#velocity.add(t, x, y);
    return true;
  }

  /** Report a move; see {@linkcode SwipeMove}. A rejected swipe stops tracking. */
  move(x: number, y: number, t: number): SwipeMove {
    const origin = this.#origin;
    if (!origin) return { phase: "rejected" };
    this.#velocity.add(t, x, y);
    const dx = x - origin.x;
    if (!this.#locked) {
      const axis = lockAxis(
        dx,
        y - origin.y,
        this.#config.lockDistance ?? 10,
        this.#config.lockRatio ?? 1,
      );
      if (axis === "pending") return { phase: "pending" };
      if (axis === "reject") {
        this.cancel();
        return { phase: "rejected" };
      }
      this.#locked = true;
    }
    const offset = clamp(dx, 0, this.#width);
    this.#dx = offset;
    this.#progress = offset / this.#width;
    return { phase: "tracking", dx: offset, progress: this.#progress };
  }

  /**
   * End the swipe (finger lifted). Returns the decision for a locked swipe, `null` when it never
   * locked. Tracking stops either way.
   */
  end(t: number): { decision: SwipeRelease; progress: number; velocityX: number } | null {
    const locked = this.#locked && this.#origin !== null;
    const progress = this.#progress;
    const distance = this.#dx;
    const velocityX = this.#velocity.velocity().x;
    void t;
    this.cancel();
    if (!locked) return null;
    const decision = releaseSwipe(progress, velocityX, this.#config, distance);
    return { decision, progress, velocityX };
  }

  /** Stop tracking without a decision. */
  cancel(): void {
    this.#origin = null;
    this.#locked = false;
    this.#progress = 0;
    this.#dx = 0;
    this.#velocity.reset();
  }
}

/**
 * Rubber-band resistance for dragging `overshoot` px past a limit, in a space `dimension` px
 * long (UIScrollView's formula): the result grows ever slower and never reaches `dimension`.
 */
export function rubberband(overshoot: number, dimension: number, coefficient = 0.55): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((overshoot * coefficient) / dimension + 1)) * dimension;
}

/**
 * Sheet detents as heights in px, ascending and without duplicates.
 *
 * @param detents The detents (`"medium"`, `"large"`, `"fit"`, or fractions / px).
 * @param available The height a `"large"` sheet takes.
 * @param content The content's natural height, for `"fit"` (ignored when absent).
 */
export function resolveDetents(
  detents: readonly SheetDetent[],
  available: number,
  content?: number,
): number[] {
  const max = Math.max(0, available);
  const heights = detents.map((d) => {
    if (d === "large") return max;
    if (d === "medium") return max / 2;
    if (d === "fit") return content !== undefined && content > 0 ? Math.min(content, max) : max;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      return Math.min(d <= 1 ? d * max : d, max);
    }
    return max;
  });
  const unique = [...new Set(heights.map((n) => Math.round(n)))].filter((n) => n > 0);
  unique.sort((a, b) => a - b);
  return unique.length > 0 ? unique : [Math.round(max)];
}

/** How long a release's momentum is projected forward when picking a detent, in ms. */
const SHEET_PROJECTION_MS = 180;

/**
 * Where a released sheet settles: the detent nearest to where its momentum would carry it, or
 * `"dismiss"` when that is below half the lowest detent (or it is flung down hard from the
 * lowest one).
 *
 * @param heights The detent heights, ascending ({@linkcode resolveDetents}).
 * @param height The sheet's visible height at release.
 * @param velocityY The release velocity in px/ms (positive = downward, shrinking the sheet).
 * @param dismissible Whether the sheet may be dragged away.
 * @returns The detent index, or `"dismiss"`.
 */
export function snapSheet(
  heights: readonly number[],
  height: number,
  velocityY: number,
  dismissible = true,
): number | "dismiss" {
  const projected = height - velocityY * SHEET_PROJECTION_MS;
  const lowest = heights[0] ?? 0;
  if (dismissible) {
    if (projected < lowest / 2) return "dismiss";
    if (velocityY > 1.5 && height <= lowest + 1) return "dismiss";
  }
  let best = 0;
  for (let i = 1; i < heights.length; i++) {
    if (Math.abs(heights[i] - projected) < Math.abs(heights[best] - projected)) best = i;
  }
  return best;
}
