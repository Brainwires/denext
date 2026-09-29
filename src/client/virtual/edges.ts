/**
 * `onEndReached` / `onStartReached` semantics for `VirtualList`, the rules RN users asked for
 * (RN #16067, PR #26444, Virtuoso #1059, FlashList #1872):
 *
 * - never on mount — only on movement toward that edge, or when the content is shorter than
 *   the viewport (then once, so a short first page loads the next one);
 * - at most once per data version (count + first/last key), re-armed when the data changes;
 * - only while moving **toward** that edge (scrolling down near the top never fires
 *   `onStartReached`);
 * - never while the scroller is rubber-banding past an edge.
 *
 * @module
 */

/** What the tracker needs to decide. */
export interface EdgeInput {
  /** Virtual offset of the viewport's leading edge. */
  readonly v: number;
  /** Viewport size. */
  readonly vp: number;
  /** Content size. */
  readonly total: number;
  /** Direction of the last movement: `1` toward the end, `-1` toward the start, `0` none. */
  readonly dir: number;
  /** Thresholds, in viewports. */
  readonly endThreshold: number;
  /** Thresholds, in viewports. */
  readonly startThreshold: number;
  /** The scroller is past an edge (iOS rubber band): report nothing. */
  readonly bouncing?: boolean;
  /** The list has rows. */
  readonly hasRows: boolean;
}

/** Which callbacks to fire. */
export interface EdgeResult {
  /** Fire `onEndReached`. */
  readonly end: boolean;
  /** Fire `onStartReached`. */
  readonly start: boolean;
}

/** Tracks when to fire `onEndReached` / `onStartReached`. */
export class EdgeTracker {
  #token: string | undefined;
  #endArmed = true;
  #startArmed = true;

  /** A new data version (`token` changed) re-arms both edges. */
  data(token: string): void {
    if (token === this.#token) return;
    this.#token = token;
    this.#endArmed = true;
    this.#startArmed = true;
  }

  /** Decide which edge callbacks fire now; a fired edge disarms until the next data version. */
  check(input: EdgeInput): EdgeResult {
    if (input.bouncing || !input.hasRows || !(input.vp > 0)) return { end: false, start: false };
    const short = input.total <= input.vp;
    const toEnd = input.total - (input.v + input.vp);
    const end = this.#endArmed &&
      (short || (input.dir > 0 && toEnd <= input.endThreshold * input.vp));
    const start = this.#startArmed &&
      (short || (input.dir < 0 && input.v <= input.startThreshold * input.vp));
    if (end) this.#endArmed = false;
    if (start) this.#startArmed = false;
    return { end, start };
  }
}
