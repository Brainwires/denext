/**
 * Viewability for `VirtualList`, with React Native's semantics (`viewabilityConfig` +
 * `onViewableItemsChanged`, and `viewabilityConfigCallbackPairs` for several configs):
 *
 * - a row is viewable when it is entirely inside the viewport, or when the visible part is at
 *   least `itemVisiblePercentThreshold` % of the row, or (`viewAreaCoveragePercentThreshold`)
 *   at least that % of the viewport; with neither threshold, any visible pixel counts;
 * - `minimumViewTime` ms: a row is reported only after it stayed viewable that long;
 * - `waitForInteraction`: nothing is reported until the user scrolled (or the list's
 *   `recordInteraction()` was called);
 * - the callback fires whenever the viewable set changes — on scroll, and on data changes
 *   without a scroll (FlashList #614) — and the latest callback is always the one called (RN
 *   #30171: changing it on the fly is supported).
 *
 * The math and the tracker are DOM-free; the controller feeds them the rows intersecting the
 * viewport after every scroll frame and commit.
 *
 * @module
 */

/** React Native's `ViewabilityConfig`. */
export interface ViewabilityConfig {
  /**
   * % of the viewport a partly visible row must cover to count as viewable (a fully visible
   * row always counts). Mutually exclusive with `itemVisiblePercentThreshold`.
   */
  readonly viewAreaCoveragePercentThreshold?: number;
  /** % of a partly visible row that must be visible for it to count as viewable. */
  readonly itemVisiblePercentThreshold?: number;
  /** Ms a row must stay viewable before it is reported. Default 0. */
  readonly minimumViewTime?: number;
  /** Report nothing until the user scrolls (or `recordInteraction()` is called). */
  readonly waitForInteraction?: boolean;
}

/** One row as `onViewableItemsChanged` reports it (React Native's `ViewToken`). */
export interface ViewToken<T> {
  /** The row's item. */
  readonly item: T;
  /** Its key. */
  readonly key: string;
  /** Its index (`null` only for section headers in React Native; always set here). */
  readonly index: number | null;
  /** Whether it is viewable now. */
  readonly isViewable: boolean;
  /** Its section (set by a SectionList adapter; `undefined` for a plain list). */
  readonly section?: unknown;
}

/** What `onViewableItemsChanged` receives. */
export interface ViewableItemsChanged<T> {
  /** Every viewable row, in index order. */
  readonly viewableItems: ViewToken<T>[];
  /** The rows whose viewability changed since the last call. */
  readonly changed: ViewToken<T>[];
}

/** A `viewabilityConfigCallbackPairs` entry. */
export interface ViewabilityConfigCallbackPair<T> {
  /** The config. */
  readonly viewabilityConfig: ViewabilityConfig;
  /** Called when the rows viewable under `viewabilityConfig` change. */
  readonly onViewableItemsChanged: ((info: ViewableItemsChanged<T>) => void) | null;
}

/** A row intersecting (or near) the viewport, in viewport coordinates. */
export interface ViewportRow {
  /** Row index. */
  readonly index: number;
  /** Px from the viewport's leading edge to the row's leading edge (negative above it). */
  readonly top: number;
  /** Row size. */
  readonly size: number;
}

/** Px of `[top, top + size)` inside `[0, vp)`. */
function pixelsVisible(top: number, size: number, vp: number): number {
  return Math.max(0, Math.min(top + size, vp) - Math.max(top, 0));
}

/**
 * Whether a row at `top` of `size` px is viewable in a viewport of `vp` px under `config`
 * (React Native's `_isViewable`).
 */
export function isViewable(
  config: ViewabilityConfig,
  top: number,
  size: number,
  vp: number,
): boolean {
  const px = pixelsVisible(top, size, vp);
  if (px <= 0 && !(size === 0 && top >= 0 && top < vp)) return false;
  if (top >= 0 && top + size <= vp) return true;
  const area = config.viewAreaCoveragePercentThreshold;
  const threshold = area ?? config.itemVisiblePercentThreshold ?? 0;
  const percent = 100 * (area !== undefined ? px / Math.max(vp, 1) : px / Math.max(size, 1));
  return threshold > 0 ? percent >= threshold : px > 0;
}

/** The viewable row indices among `rows`, in index order. */
export function viewableIndices(
  config: ViewabilityConfig,
  rows: Iterable<ViewportRow>,
  vp: number,
): number[] {
  const out: number[] = [];
  for (const r of rows) if (isViewable(config, r.top, r.size, vp)) out.push(r.index);
  return out.sort((a, b) => a - b);
}

/** How a tracker resolves rows, reports, and schedules. */
export interface ViewabilityHost<T> {
  /** Row `index`'s item. */
  itemAt(index: number): T;
  /** Row `index`'s key. */
  keyAt(index: number): string | number;
  /** A timer (injectable for tests). */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancels `setTimeout`. */
  clearTimeout(handle: unknown): void;
}

/** Tracks one config's viewable set and reports its changes. */
export class ViewabilityTracker<T> {
  #viewable = new Map<string | number, ViewToken<T>>();
  #timer: unknown = undefined;
  #interacted = false;
  readonly #host: ViewabilityHost<T>;

  /** @param host Item / key resolution and timers. */
  constructor(host: ViewabilityHost<T>) {
    this.#host = host;
  }

  /** The user interacted (scrolled, or `recordInteraction()`). */
  interact(): void {
    this.#interacted = true;
  }

  /** Stop any pending `minimumViewTime` report. */
  // fallow-ignore-next-line unused-class-member -- called by the controller's cleanup
  dispose(): void {
    if (this.#timer !== undefined) this.#host.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Recompute with the rows now near the viewport; `report` receives the change (if any).
   * `rows` is read now; with `minimumViewTime` the report comes later, for the rows viewable
   * both now and then (`recompute` is called again at that time).
   */
  update(
    config: ViewabilityConfig,
    rows: readonly ViewportRow[],
    vp: number,
    report: (info: ViewableItemsChanged<T>) => void,
    recompute?: () => { rows: readonly ViewportRow[]; vp: number },
  ): void {
    if (config.waitForInteraction && !this.#interacted) return;
    const now = viewableIndices(config, rows, vp);
    const wait = config.minimumViewTime ?? 0;
    if (wait <= 0 || !recompute) {
      this.#commit(now, report);
      return;
    }
    if (this.#timer !== undefined) this.#host.clearTimeout(this.#timer);
    this.#timer = this.#host.setTimeout(() => {
      this.#timer = undefined;
      const later = recompute();
      const still = new Set(viewableIndices(config, later.rows, later.vp));
      this.#commit(now.filter((i) => still.has(i)), report);
    }, wait);
  }

  #commit(indices: readonly number[], report: (info: ViewableItemsChanged<T>) => void): void {
    const host = this.#host;
    const next = new Map<string | number, ViewToken<T>>();
    const changed: ViewToken<T>[] = [];
    for (const index of indices) {
      const key = host.keyAt(index);
      const prev = this.#viewable.get(key);
      const token: ViewToken<T> = prev && prev.index === index && prev.item === host.itemAt(index)
        ? prev
        : { item: host.itemAt(index), key: String(key), index, isViewable: true };
      next.set(key, token);
      if (!prev) changed.push(token);
    }
    for (const [key, prev] of this.#viewable) {
      if (!next.has(key)) changed.push({ ...prev, isViewable: false });
    }
    this.#viewable = next;
    if (changed.length === 0) return;
    changed.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    report({ viewableItems: [...next.values()], changed });
  }
}
