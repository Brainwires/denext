/**
 * React Native scroll events for `VirtualList` on the web: `onScroll` with RN's
 * `nativeEvent` shape (`contentOffset`, `contentSize`, `layoutMeasurement`), throttled by
 * `scrollEventThrottle`, and the drag / momentum lifecycle react-native-web never implemented
 * (RNW #2249) — best effort from touch events, `scrollend` and a quiet period:
 *
 * - a touch that scrolls: `onScrollBeginDrag` (first scroll after `touchstart`),
 *   `onScrollEndDrag` (finger up), then `onMomentumScrollBegin` / `onMomentumScrollEnd` for
 *   the fling (the end at `scrollend`, or after a quiet period where it is missing);
 * - any other scroll (wheel, keys, scrollbar, and every programmatic `scrollTo*` — RN #21718
 *   asks for exactly this): `onMomentumScrollBegin` at its first frame and
 *   `onMomentumScrollEnd` once when it comes to rest.
 *
 * Every event carries `programmatic` (a denext extra, react-virtualized #1144): whether the
 * list's own write (a `scrollTo*`, an anchor correction) caused it.
 *
 * @module
 */

/** A 2-D point. */
export interface ScrollPoint {
  /** Horizontal px. */
  readonly x: number;
  /** Vertical px. */
  readonly y: number;
}

/** A 2-D size. */
export interface ScrollSize {
  /** Width in px. */
  readonly width: number;
  /** Height in px. */
  readonly height: number;
}

/** React Native's scroll `nativeEvent`. */
export interface ScrollNativeEvent {
  /** The scroll offset (list offset plus the header), in px. */
  readonly contentOffset: ScrollPoint;
  /** The scrollable content's size (every row, estimated where unmeasured, plus header/footer). */
  readonly contentSize: ScrollSize;
  /** The viewport's size. */
  readonly layoutMeasurement: ScrollSize;
  /** Always zero on the web. */
  readonly contentInset: {
    readonly top: 0;
    readonly left: 0;
    readonly bottom: 0;
    readonly right: 0;
  };
  /** Always 1 on the web. */
  readonly zoomScale: 1;
}

/** What every scroll callback receives. */
export interface VirtualListScrollEvent {
  /** RN's native event. */
  readonly nativeEvent: ScrollNativeEvent;
  /** The list's own write caused this scroll (not the user). */
  readonly programmatic: boolean;
  /** `Date.now()` when it fired. */
  readonly timeStamp: number;
}

/** The scroll callbacks (props). */
export interface ScrollEventProps {
  readonly onScroll?: (e: VirtualListScrollEvent) => void;
  readonly scrollEventThrottle?: number;
  readonly onScrollBeginDrag?: (e: VirtualListScrollEvent) => void;
  readonly onScrollEndDrag?: (e: VirtualListScrollEvent) => void;
  readonly onMomentumScrollBegin?: (e: VirtualListScrollEvent) => void;
  readonly onMomentumScrollEnd?: (e: VirtualListScrollEvent) => void;
}

/** Whether any scroll callback is set (the tracker costs nothing otherwise). */
export function wantsScrollEvents(p: ScrollEventProps): boolean {
  return !!(p.onScroll || p.onScrollBeginDrag || p.onScrollEndDrag || p.onMomentumScrollBegin ||
    p.onMomentumScrollEnd);
}

const INSET = { top: 0, left: 0, bottom: 0, right: 0 } as const;

/** Build an event. */
export function scrollEvent(
  horizontal: boolean,
  offset: number,
  content: number,
  viewport: number,
  cross: number,
  programmatic: boolean,
): VirtualListScrollEvent {
  const along = (main: number, other: number): ScrollSize =>
    horizontal ? { width: main, height: other } : { width: other, height: main };
  return {
    nativeEvent: {
      contentOffset: horizontal ? { x: offset, y: 0 } : { x: 0, y: offset },
      contentSize: along(content, cross),
      layoutMeasurement: along(viewport, cross),
      contentInset: INSET,
      zoomScale: 1,
    },
    programmatic,
    timeStamp: Date.now(),
  };
}

/** Phase of the current scroll session. */
type Phase = "idle" | "touch" | "drag" | "fling" | "momentum";

/** The drag / momentum state machine; the controller feeds it DOM events. */
export class ScrollSession {
  #phase: Phase = "idle";
  #lastOnScroll = -Infinity;
  #suppressed = false;

  /** A finger touched the scroller. */
  touchStart(): void {
    this.#phase = "touch";
  }

  /**
   * A scroll frame. Returns which callbacks fire (`scroll` honours `throttle` ms, measured
   * with `now`).
   */
  scroll(
    now: number,
    throttle: number,
  ): { beginDrag: boolean; momentumBegin: boolean; scroll: boolean } {
    let beginDrag = false;
    let momentumBegin = false;
    if (this.#phase === "touch") {
      this.#phase = "drag";
      beginDrag = true;
    } else if (this.#phase === "idle" || this.#phase === "fling") {
      this.#phase = "momentum";
      momentumBegin = true;
    }
    const scroll = !(throttle > 0) || now - this.#lastOnScroll >= throttle;
    if (scroll) this.#lastOnScroll = now;
    this.#suppressed = !scroll;
    return { beginDrag, momentumBegin, scroll };
  }

  /**
   * The finger lifted: `endDrag` when it had dragged. A fling's `onMomentumScrollBegin` comes
   * with its first scroll frame after the lift (none when the view stops with the finger).
   */
  touchEnd(): { endDrag: boolean } {
    const dragged = this.#phase === "drag";
    this.#phase = dragged ? "fling" : "idle";
    return { endDrag: dragged };
  }

  /**
   * The scroller came to rest: `momentumEnd` when a momentum phase was open; `trailing` when
   * the throttle swallowed the last frame (so `onScroll` still sees the final offset).
   */
  settle(): { momentumEnd: boolean; trailing: boolean } {
    const open = this.#phase === "momentum";
    if (this.#phase !== "touch" && this.#phase !== "drag") this.#phase = "idle";
    const trailing = this.#suppressed;
    this.#suppressed = false;
    return { momentumEnd: open, trailing };
  }
}
