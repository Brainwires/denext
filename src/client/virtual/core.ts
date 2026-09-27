/**
 * The framework-agnostic engine behind `VirtualList` / `useVirtualList`: row sizes, the scroll
 * model, anchoring, scroll-to targets and edge callbacks. No DOM access — the controller
 * (controller.ts) feeds it scroll offsets, viewport metrics and measurements, and applies the
 * layout and scroll writes it asks for.
 *
 * ## The scroll model
 *
 * Offsets are **list-relative** (0 = the first row's leading edge). The browser reports a
 * **physical** offset `s`; the engine keeps a **virtual** offset `v = s + delta`. Rows are laid
 * out at physical `offsetOf(i) - delta`, so:
 *
 * - a size correction above the viewport (a row measured taller than its estimate, a prepend)
 *   is absorbed by adding the shift to `delta`: the visible rows do not move and no scroll
 *   write happens. The controller **reconciles** later (writes `s := v`, `delta := 0` in one
 *   synchronous step) — immediately when no gesture is in flight, and at `scrollend` / settle
 *   during a touch gesture, because iOS WebKit cancels a fling on any scroll write (WebKit bug
 *   187449). The list therefore never needs the momentum shim, and cooperates with it;
 * - past {@linkcode DEFAULT_MAX_PHYSICAL_SIZE} the physical height is capped and `delta` holds
 *   the scale offset: small scrolls stay 1:1, a large jump (scrollbar drag) re-maps linearly,
 *   and settling re-syncs `s` to the linear mapping so both ends stay reachable;
 * - server rendering and the first client render place the initial window at physical 0
 *   (`delta = v`), so an `initialScrollIndex` or a chat list starting at the bottom paints its
 *   target rows before any script runs, and hydration reconciles without a visible move.
 *
 * @module
 */

import { type EdgeResult, EdgeTracker } from "./edges.ts";
import { EMPTY_RANGE, nextRange, type RowRange, sameRange, visibleRange } from "./range.ts";
import { DEFAULT_MAX_PHYSICAL_SIZE, isScaled, toPhysical, toVirtual } from "./scale.ts";
import { RowState, SizeTree } from "./size-tree.ts";

/** A row key. */
export type Key = string | number;

/** Where a row lands in the viewport when scrolled to. */
export type ScrollAlign = "start" | "center" | "end" | "auto";

/** The data the engine sizes. */
export interface CoreSource {
  /** Number of rows. */
  readonly count: number;
  /** Row `i`'s stable key. */
  readonly keyAt: (i: number) => Key;
  /** A size hint for row `i` (px), or `undefined` for the default size. */
  readonly hint?: (i: number) => number | undefined;
  /** The hints are exact sizes (treated as measured), not estimates. */
  readonly exact?: boolean;
  /** The data version: an unchanged token (and count) means unchanged data. */
  readonly token: unknown;
}

/** Engine settings (the resolved list props). */
export interface CoreConfig {
  /** Size of a row without a hint or a measurement. */
  readonly defaultSize: number;
  /** Base overscan in px (default: one viewport). */
  readonly overscan?: number;
  /** `"end"` sticks to the end while the view is at the end (chat). */
  readonly anchor: "start" | "end";
  /**
   * Keep the visible rows in place when data above them changes (inserts, removals). Size
   * refinements are anchored regardless (see `#mutate`'s `refine`).
   */
  readonly maintainVisibleContentPosition: boolean;
  /** Largest physical extent to lay out before scaling. */
  readonly maxPhysicalSize: number;
  /** `onEndReached` distance, in viewports. */
  readonly endThreshold: number;
  /** `onStartReached` distance, in viewports. */
  readonly startThreshold: number;
  /** Most rows to render (a window sized by a guess, before the first measurement). */
  readonly maxRows?: number;
}

/** A pending `scrollToIndex` (or `scrollToEnd`): the engine keeps landing on it until settled. */
export interface ScrollTarget {
  /** The row (re-located by key when the data changes while the target is pending). */
  index: number;
  /** Its alignment. */
  readonly align: ScrollAlign;
  /** Extra px between the aligned edge and the viewport edge. */
  readonly viewOffset: number;
  /** Target the very end (the footer included), not the row's edge. */
  readonly toEnd?: boolean;
  /** A native smooth scroll is carrying the view there: user-scroll does not cancel it. */
  smooth?: boolean;
  /** Settling passes so far. */
  passes: number;
}

/**
 * Settling passes after which a target is released even if rows in the window are still
 * unmeasured (a safety net; the controller also releases it once measurements go quiet).
 */
const MAX_SETTLE_PASSES = 120;

/** Views within this many px of the end count as "at the end". */
const AT_END_EPSILON = 4;

/**
 * Row counts up to this get every hint applied (an exact scrollbar), outside the render: the
 * controller seeds them in background slices after the commit (`seedPending`), or at once
 * when an absolute offset is asked for (`flushSeed`). A data change applies hints only to the
 * rows it renders, so a render's sizes never depend on a time budget (server and client first
 * renders match) and never pay for materializing every item (a hint receives the item). Larger
 * lists apply hints to the rows they render only.
 */
const EAGER_HINT_LIMIT = 50_000;

/** Rows seeded between two clock reads. */
const SEED_CHUNK = 256;

/** A clock in ms. */
const clock = (): number => typeof performance !== "undefined" ? performance.now() : Date.now();

/** Per-row storage budget, in blocks (see `SizeTree.compact`): ~2.3 MB, 512k rows. */
const MAX_FULL_BLOCKS = 2048;

/** How far (rows, each way) an anchor key is searched for after a data change. */
const KEY_SEARCH_LIMIT = 100_000;

/** A scroll delta larger than this many viewports is a jump (scrollbar drag) when scaled. */
const JUMP_VIEWPORTS = 3;

/** An empty source. */
const EMPTY_SOURCE: CoreSource = { count: 0, keyAt: (i) => i, token: undefined };

/** Default config. */
export const DEFAULT_CONFIG: CoreConfig = {
  defaultSize: 48,
  anchor: "start",
  maintainVisibleContentPosition: true,
  maxPhysicalSize: DEFAULT_MAX_PHYSICAL_SIZE,
  endThreshold: 0.5,
  startThreshold: 0.5,
};

/** The anchor captured before a change: a row's key and its distance from the viewport. */
interface Anchor {
  /** The anchor row's index before the change. */
  readonly index: number;
  /** The anchor row and the next visible rows: key and distance from the viewport edge. */
  readonly rows: readonly { readonly key: Key; readonly gap: number }[];
}

/** The virtual-list engine. */
export class VirtualCore {
  /** Row sizes. */
  readonly tree: SizeTree;
  #cfg: CoreConfig = DEFAULT_CONFIG;
  #src: CoreSource = EMPTY_SOURCE;
  /** Physical list-relative scroll offset last seen (or written). */
  s = 0;
  /** `v - s`: the virtual offset's lead over the physical one. */
  delta = 0;
  /** Viewport size (main axis). */
  vp = 0;
  /** Scrollable space before the list (header, spacer, page content above it). */
  lead = 0;
  /** Scrollable space after the list (footer, page content below it). */
  tail = 0;
  /** `anchor: "end"` and the view was at the end at the last user scroll. */
  pinned = false;
  /** A gesture is in flight: absorb corrections, never write the scroll offset. */
  deferring = false;
  /** The last scroll offset read was past an edge (rubber band). */
  bouncing = false;
  /** A pending scroll-to. */
  target: ScrollTarget | null = null;
  /** Rows currently rendered. */
  range: RowRange = EMPTY_RANGE;
  /** Scroll velocity in px/ms (positive toward the end). */
  velocity = 0;
  #lastT = 0;
  #dir = 0;
  /** The next row the hints are applied from (−1: nothing pending). */
  #seedNext = -1;
  readonly #edges = new EdgeTracker();

  /** @param config Initial settings. */
  constructor(config: Partial<CoreConfig> = {}) {
    this.#cfg = { ...DEFAULT_CONFIG, ...config };
    this.tree = new SizeTree(0, this.#cfg.defaultSize);
  }

  // ---- derived --------------------------------------------------------------------------

  /** The settings. */
  get config(): CoreConfig {
    return this.#cfg;
  }

  /** The virtual offset of the viewport's leading edge. */
  get v(): number {
    return this.s + this.delta;
  }

  /** The list's virtual size. */
  get total(): number {
    return this.tree.total;
  }

  /** Whether the physical height is capped and scaled. */
  get scaled(): boolean {
    return isScaled(this.tree.total, this.#cfg.maxPhysicalSize);
  }

  /** The smallest virtual offset (the scroller's start, before any header). */
  get vmin(): number {
    return -this.lead;
  }

  /** The largest virtual offset (the scroller's end, after any footer). */
  get vmax(): number {
    return Math.max(this.vmin, this.tree.total + this.tail - this.vp);
  }

  /** The physical extent to lay out for the rows. */
  physicalSize(): number {
    const total = this.tree.total;
    if (this.scaled) return this.#cfg.maxPhysicalSize;
    return Math.max(0, total - this.delta, Math.min(total, this.s + this.vp - this.tail));
  }

  /** Physical offset (list-relative) of row `i`'s leading edge. */
  physicalOffset(i: number): number {
    return this.tree.offsetOf(i) - this.delta;
  }

  /** Whether the view is at the end (within {@linkcode AT_END_EPSILON}). */
  isAtEnd(): boolean {
    return this.v >= this.vmax - AT_END_EPSILON;
  }

  /** The rows intersecting the viewport. */
  visible(): RowRange {
    return visibleRange(this.tree, this.v, this.vp);
  }

  /** The virtual offset that shows `t`. */
  targetOffset(t: ScrollTarget): number {
    if (t.toEnd) return this.vmax;
    const i = Math.max(0, Math.min(this.tree.count - 1, t.index));
    const top = this.tree.offsetOf(i);
    const size = this.tree.sizeOf(i);
    const vo = t.viewOffset;
    let v: number;
    switch (t.align) {
      case "end":
        v = top + size - this.vp + vo;
        break;
      case "center":
        v = top + size / 2 - this.vp / 2;
        break;
      case "auto": {
        const cur = this.v;
        if (top - vo < cur) v = top - vo;
        else if (top + size + vo > cur + this.vp) v = top + size + vo - this.vp;
        else v = cur;
        break;
      }
      default:
        v = top - vo;
    }
    return this.#clampV(v);
  }

  #clampV(v: number): number {
    return Math.min(this.vmax, Math.max(this.vmin, v));
  }

  /** Move the virtual offset to `v` (clamped) without moving the physical one. */
  #setV(v: number): void {
    this.delta = this.#clampV(v) - this.s;
  }

  // ---- configuration + data -------------------------------------------------------------

  /** Apply new settings; a new default size keeps the visible rows in place. */
  configure(config: CoreConfig): void {
    const old = this.#cfg;
    this.#cfg = config;
    if (config.defaultSize !== old.defaultSize) {
      // A better estimate, not a content change: the view stays put whatever MVCP says.
      this.#mutate(() => this.tree.setDefaultSize(config.defaultSize), true);
    }
  }

  /** Start at `index` (SSR / first render: the window is laid out at physical 0). */
  initialIndex(index: number, align: ScrollAlign, viewOffset = 0): void {
    this.pinned = false;
    this.target = { index, align, viewOffset, passes: 0 };
    this.s = 0;
    this.#setV(this.targetOffset(this.target));
  }

  /** Start at the end (anchor `"end"`). */
  initialEnd(): void {
    this.pinned = true;
    this.s = 0;
    this.#setV(this.vmax);
  }

  /**
   * Switch to new data. Appends, prepends, truncations and front removals are detected in O(1)
   * key probes; anything else remaps sizes by key. The visible rows (by key) stay in place.
   * Returns whether anything changed.
   */
  setSource(src: CoreSource): boolean {
    const old = this.#src;
    if (src.token === old.token && src.count === old.count) {
      this.#src = src;
      return false;
    }
    const first = this.tree.count === 0 && old === EMPTY_SOURCE;
    this.#mutate(() => {
      this.#src = src;
      if (first) this.tree.resize(src.count);
      else return this.#applyDiff(old, src);
      return undefined;
    });
    this.#seedNext = src.hint && src.count <= EAGER_HINT_LIMIT ? 0 : -1;
    this.#edges.data(this.#edgeToken());
    return true;
  }

  /** Whether hints remain to be applied (see {@linkcode EAGER_HINT_LIMIT}). */
  get seeding(): boolean {
    return this.#seedNext >= 0;
  }

  /**
   * Apply pending hints for up to `budgetMs` (the view stays put: a hint refines an estimate,
   * it does not change the content). Returns whether any remain.
   */
  seedPending(budgetMs: number): boolean {
    if (this.#seedNext < 0) return false;
    const start = clock();
    const n = this.tree.count;
    this.#mutate(() => {
      while (this.#seedNext < n) {
        const to = Math.min(n, this.#seedNext + SEED_CHUNK);
        this.#seed(this.#seedNext, to - 1);
        this.#seedNext = to;
        if (clock() - start >= budgetMs) break;
      }
    }, true);
    if (this.#seedNext >= n) this.#seedNext = -1;
    return this.#seedNext >= 0;
  }

  /** Apply every pending hint now (before an absolute offset is used). */
  flushSeed(): void {
    if (this.#seedNext >= 0) this.seedPending(Infinity);
  }

  #edgeToken(): string {
    const n = this.#src.count;
    return n === 0 ? "0" : `${n}\u0000${this.#src.keyAt(0)}\u0000${this.#src.keyAt(n - 1)}`;
  }

  /**
   * Update the tree for `old → src`; returns a function mapping an old index to a hint for its
   * new index (used to find the anchor key fast).
   */
  #applyDiff(old: CoreSource, src: CoreSource): (i: number) => number {
    const fast = this.#fastDiff(old, src);
    if (fast) return fast;
    this.#remapByKey(old, src);
    return (i) => i;
  }

  /**
   * The O(1)-probe cases (unchanged, append, prepend, truncate, front removal); `undefined`
   * when none applies.
   */
  #fastDiff(old: CoreSource, src: CoreSource): ((i: number) => number) | undefined {
    const a = old.count;
    const b = src.count;
    const k = b - a;
    const same = (newIdx: number, oldIdx: number): boolean =>
      newIdx >= 0 && newIdx < b && oldIdx >= 0 && oldIdx < a &&
      src.keyAt(newIdx) === old.keyAt(oldIdx);
    const resized = (): (i: number) => number => {
      this.tree.resize(b);
      return (i) => i;
    };
    if (a === 0 || b === 0) return resized();
    const first = same(0, 0);
    const lastSame = same(b - 1, a - 1);
    // Unchanged (first, middle and last keys equal) or an append (old last row still at a-1).
    if (first && k >= 0 && same(a - 1, a - 1) && (k > 0 || same(b >> 1, a >> 1))) return resized();
    // A truncation at the end.
    if (first && k < 0 && same(b - 1, b - 1)) return resized();
    if (k > 0 && lastSame && same(k, 0)) {
      this.tree.prepend(k);
      return (i) => i + k;
    }
    if (k < 0 && lastSame && same(0, -k)) {
      this.tree.removeFront(-k);
      return (i) => i + k;
    }
    return undefined;
  }

  /** A general change: rebuild the tree carrying every known size over by key. */
  #remapByKey(old: CoreSource, src: CoreSource): void {
    const byKey = new Map<Key, { size: number; state: 0 | 1 | 2 }>();
    for (const e of this.tree.entries()) {
      if (e.index < old.count) byKey.set(old.keyAt(e.index), { size: e.size, state: e.state });
    }
    const rows: { index: number; size: number; state: 0 | 1 | 2 }[] = [];
    for (let j = 0; byKey.size > 0 && j < src.count; j++) {
      const hit = byKey.get(src.keyAt(j));
      if (hit) rows.push({ index: j, size: hit.size, state: hit.state });
    }
    this.tree.rebuild(src.count, rows);
  }

  /** Apply hints to rows `[from, to]` that still have the default size. */
  #seed(from: number, to: number): boolean {
    const hint = this.#src.hint;
    if (!hint) return false;
    const state = this.#src.exact ? RowState.Measured : RowState.Estimated;
    let changed = false;
    const last = Math.min(to, this.tree.count - 1);
    for (let i = Math.max(0, from); i <= last; i++) {
      if (this.tree.stateOf(i) !== RowState.Default) continue;
      const size = hint(i);
      if (size === undefined || !(size >= 0)) continue;
      this.tree.set(i, size, state);
      changed = true;
    }
    return changed;
  }

  // ---- anchoring ------------------------------------------------------------------------

  /** Follow a pending target's row (by key) into new data; a removed row keeps its index. */
  #relocateTarget(
    t: ScrollTarget,
    old: CoreSource,
    map: ((oldIndex: number) => number) | void,
  ): void {
    const n = this.tree.count;
    if (t.toEnd || n === 0 || t.index >= old.count) return;
    const key = old.keyAt(t.index);
    const hint = Math.max(0, Math.min(n - 1, map ? map(t.index) : t.index));
    const found = this.#findKey(key, hint);
    if (found >= 0) t.index = found;
  }

  /**
   * The anchor row: the first row fully inside the viewport whose size is already known
   * (measured or exact), else the first fully visible row, else the row at the leading edge.
   * Preferring a measured row matters when scrolling toward the start: the rows entering at
   * the top are still estimates, and anchoring on one of them would let its own correction
   * move every row below it (TanStack/virtual #659).
   */
  #anchorIndex(): number {
    const tree = this.tree;
    const v = this.v;
    const end = v + this.vp;
    const edge = tree.indexAt(Math.max(0, v));
    let firstFull = -1;
    for (let i = edge; i < tree.count && i < edge + 64; i++) {
      const top = tree.offsetOf(i);
      if (top >= end) break;
      if (top < v - 0.5) continue;
      if (tree.offsetOf(i + 1) > end + 0.5 && firstFull >= 0) break;
      if (firstFull < 0) firstFull = i;
      if (tree.isMeasured(i)) return i;
    }
    return firstFull >= 0 ? firstFull : edge;
  }

  /**
   * Run `change` (which may replace the data and the sizes), then restore the view: the end
   * while pinned, the scroll target while one is pending, otherwise the anchor row at its old
   * distance from the viewport (by key, with the next visible rows as fallbacks). `refine`: the
   * change only refines sizes (a measurement, a resize, hints, a learned default size), not
   * the content, so the view is anchored even without `maintainVisibleContentPosition` — that
   * setting governs data changes only.
   */
  #mutate(change: () => ((oldIndex: number) => number) | void, refine = false): void {
    const pinned = this.#cfg.anchor === "end" && this.pinned && this.target === null;
    let anchor: Anchor | undefined;
    if (!pinned && this.target === null && (refine || this.#cfg.maintainVisibleContentPosition)) {
      anchor = this.#captureAnchor();
    }
    const src = this.#src;
    const map = change();
    if (pinned) this.#setV(this.vmax);
    else if (this.target) {
      // A pending target is the anchor, whatever `maintainVisibleContentPosition` says: the
      // programmatic scroll owns the view until it settles.
      if (this.#src !== src) this.#relocateTarget(this.target, src, map);
      this.#setV(this.targetOffset(this.target));
    } else if (anchor) {
      const at = this.#locate(anchor, map ?? ((i) => i));
      this.#setV(at ? this.tree.offsetOf(at.index) - at.gap : this.v);
    } else this.#setV(this.v);
  }

  /**
   * The row the view is anchored on (see `#anchorIndex`) and its distance from the viewport's
   * leading edge — what scroll restoration saves. `null` for an empty list.
   */
  anchor(): { readonly index: number; readonly gap: number } | null {
    if (this.tree.count === 0) return null;
    const index = this.#anchorIndex();
    return { index, gap: this.tree.offsetOf(index) - this.v };
  }

  #captureAnchor(): Anchor | undefined {
    const n = this.tree.count;
    if (n === 0) return undefined;
    const index = this.#anchorIndex();
    const rows: { key: Key; gap: number }[] = [];
    const last = Math.max(index, this.visible().last);
    for (let i = index; i <= last && rows.length < 8; i++) {
      rows.push({ key: this.#src.keyAt(i), gap: this.tree.offsetOf(i) - this.v });
    }
    return { index, rows };
  }

  /**
   * The anchor's row in the (possibly new) data: its key searched outward from the mapped
   * index; failing that (the row was removed), the next visible row that survived.
   */
  #locate(anchor: Anchor, map: (i: number) => number): { index: number; gap: number } | null {
    const n = this.tree.count;
    if (n === 0) return null;
    for (let k = 0; k < anchor.rows.length; k++) {
      const hint = Math.max(0, Math.min(n - 1, map(anchor.index + k)));
      const found = this.#findKey(anchor.rows[k].key, hint);
      if (found >= 0) return { index: found, gap: anchor.rows[k].gap };
    }
    return null;
  }

  /**
   * The index of `key`, searching outward from `hint` up to {@linkcode KEY_SEARCH_LIMIT} rows
   * each way (−1 when absent or farther: the anchor then falls back to the next visible key).
   */
  #findKey(key: Key, hint: number): number {
    const n = this.tree.count;
    const keyAt = this.#src.keyAt;
    if (keyAt(hint) === key) return hint;
    for (let d = 1; d < n && d <= KEY_SEARCH_LIMIT; d++) {
      const lo = hint - d;
      const hi = hint + d;
      if (lo < 0 && hi >= n) break;
      if (hi < n && keyAt(hi) === key) return hi;
      if (lo >= 0 && keyAt(lo) === key) return lo;
    }
    return -1;
  }

  // ---- inputs ---------------------------------------------------------------------------

  /**
   * New viewport / lead / tail sizes; the visible rows (or the end, when pinned) stay, whatever
   * `maintainVisibleContentPosition` says (a resize is not a content change).
   */
  setMetrics(vp: number, lead: number, tail: number): boolean {
    if (vp === this.vp && lead === this.lead && tail === this.tail) return false;
    const leadShift = lead - this.lead;
    this.#mutate(() => {
      this.vp = vp;
      // The physical list start moved: the same scroller offset is a different list offset.
      this.s -= leadShift;
      this.lead = lead;
      this.tail = tail;
    }, true);
    return true;
  }

  /**
   * Apply measured sizes (`[index, px]`); returns whether any size changed. A measurement
   * refines an estimate, it does not change the content: the visible rows stay put whatever
   * `maintainVisibleContentPosition` says (no jump scrolling up into unmeasured rows).
   */
  measure(entries: Iterable<readonly [number, number]>): boolean {
    let changed = false;
    this.#mutate(() => {
      for (const [i, size] of entries) {
        const was = this.tree.stateOf(i);
        if (this.tree.set(i, size, RowState.Measured) !== 0 || was !== RowState.Measured) {
          changed = true;
        }
      }
    }, true);
    if (changed) {
      const r = this.range;
      this.tree.compact(r.first - 4096, r.last + 4096, MAX_FULL_BLOCKS);
    }
    return changed;
  }

  /**
   * A scroll event: the physical list-relative offset is now `raw`. Past an edge (rubber
   * band) the offset is clamped and the event marked `bouncing`.
   */
  scroll(raw: number, now: number): void {
    const lo = this.vmin;
    const hi = Math.max(lo, this.#sMax());
    this.bouncing = raw < lo - 0.5 || raw > hi + 0.5;
    const s = Math.min(hi, Math.max(lo, raw));
    const ds = s - this.s;
    if (ds === 0) return;
    const before = this.v;
    this.s = s;
    if (this.scaled && Math.abs(ds) > JUMP_VIEWPORTS * Math.max(this.vp, 1)) {
      this.delta = this.#mapped(s) - s;
    }
    this.#setV(this.v);
    if (this.target && !this.target.smooth) this.target = null;
    const dv = this.v - before;
    const dt = now - this.#lastT;
    this.velocity = dt > 0 && dt < 200 ? this.velocity * 0.5 + (dv / dt) * 0.5 : 0;
    this.#lastT = now;
    this.#dir = Math.sign(dv);
    if (this.#cfg.anchor === "end" && !this.bouncing) this.pinned = this.isAtEnd();
  }

  /** The largest physical list-relative offset. */
  #sMax(): number {
    return this.physicalSize() + this.tail - this.vp;
  }

  /** The virtual offset the linear mapping gives physical `s`. */
  #mapped(s: number): number {
    if (s <= 0) return s;
    return toVirtual(s, this.tree.total, this.vp, this.#cfg.maxPhysicalSize);
  }

  /** Decay the velocity (no scroll event for a while). */
  rest(): void {
    this.velocity = 0;
  }

  // ---- outputs --------------------------------------------------------------------------

  /**
   * The physical offset to write now, or `null`. `settled`: the scroller is at rest (after
   * `scrollend` or a quiet period), when a scaled list re-syncs to its linear mapping.
   */
  reconcileTarget(settled: boolean): number | null {
    if (this.deferring || this.bouncing) return null;
    if (this.scaled) {
      if (!settled) return null;
      const want = this.#physicalFor(this.v);
      return Math.abs(want - this.s) >= 1 ? want : null;
    }
    return Math.abs(this.delta) >= 0.5 ? this.v : null;
  }

  #physicalFor(v: number): number {
    if (!this.scaled || v <= 0) return v;
    return Math.round(toPhysical(v, this.tree.total, this.vp, this.#cfg.maxPhysicalSize));
  }

  /**
   * Plan a write that shows virtual offset `v`: sets `s` and `delta` for it and returns the
   * physical offset to write. Lay out (physical size + window offset) before writing it.
   */
  prepareWrite(v: number): number {
    const target = this.#clampV(v);
    const s = this.#physicalFor(target);
    this.s = s;
    this.delta = target - s;
    return s;
  }

  /** The offset the browser actually took after a write (it may clamp). */
  commitWrite(actual: number): void {
    if (Math.abs(actual - this.s) < 0.5) return;
    const v = this.v;
    this.s = actual;
    this.#setV(this.scaled ? v : actual + this.delta);
  }

  /**
   * Recompute the rendered range (hysteresis + velocity-scaled overscan) and apply hints to
   * the rows it adds. Returns whether the range changed.
   */
  updateRange(): boolean {
    const before = this.range;
    for (let pass = 0; pass < 4; pass++) {
      const next = this.#nextRange();
      this.range = next;
      let seeded = false;
      this.#mutate(() => {
        seeded = this.#seed(next.first, next.last);
      }, true);
      if (!seeded) break;
    }
    return !sameRange(before, this.range);
  }

  /**
   * The range `updateRange` would render now (hysteresis + velocity-scaled overscan), at most
   * `maxRows` rows from the viewport's leading row (its trailing row at the end of a chat).
   */
  #nextRange(): RowRange {
    const base = this.#cfg.overscan ?? Math.max(this.vp, 1);
    const r = nextRange(this.tree, this.range, this.v, this.vp, base, this.velocity);
    const max = this.#cfg.maxRows;
    if (max === undefined || r.last - r.first < max) return r;
    const vis = this.visible();
    if (this.#cfg.anchor === "end" && this.pinned) {
      return { first: Math.max(r.first, vis.last - max + 1), last: vis.last };
    }
    return { first: vis.first, last: Math.min(r.last, vis.first + max - 1) };
  }

  /**
   * After a measurement or a commit: whether the pending scroll target has settled — the view
   * sits at its offset and every row in the rendered window — and in the window about to
   * render, which grows once estimates above the target turn out too large — has a known size
   * (measured, or exact), so no later measurement can move it. Clears it then.
   * Until then the target is the anchor of every size or data change (see `#mutate`).
   */
  settleTarget(measurable: boolean): boolean {
    const t = this.target;
    if (!t) return true;
    t.passes++;
    const landed = Math.abs(this.v - this.targetOffset(t)) < 0.5;
    const known = !measurable || this.#windowKnown(t);
    if ((landed && known && !t.smooth) || t.passes > MAX_SETTLE_PASSES) {
      this.target = null;
      return true;
    }
    return false;
  }

  /** Whether the target row and every row of the current and next windows have known sizes. */
  #windowKnown(t: ScrollTarget): boolean {
    const tree = this.tree;
    if (!tree.isMeasured(Math.min(t.index, tree.count - 1))) return false;
    const next = this.#nextRange();
    return this.#rowsKnown(this.range) && (sameRange(next, this.range) || this.#rowsKnown(next));
  }

  /** Whether every row of `r` has a known size. */
  #rowsKnown(r: RowRange): boolean {
    const tree = this.tree;
    for (let i = Math.max(0, r.first); i <= r.last && i < tree.count; i++) {
      if (!tree.isMeasured(i)) return false;
    }
    return true;
  }

  /** Which edge callbacks to fire now (consumes the last movement direction). */
  edges(): EdgeResult {
    const r = this.#edges.check({
      v: this.v,
      vp: this.vp,
      total: this.tree.total,
      dir: this.#dir,
      endThreshold: this.#cfg.endThreshold,
      startThreshold: this.#cfg.startThreshold,
      bouncing: this.bouncing,
      hasRows: this.tree.count > 0,
    });
    this.#dir = 0;
    return r;
  }

  /** Blank px at each side of the viewport not covered by rendered rows (diagnostics). */
  blankArea(): { readonly before: number; readonly after: number } {
    const r = this.range;
    const v = Math.max(0, this.v);
    const end = Math.min(this.tree.total, this.v + this.vp);
    if (r.last < r.first) return { before: 0, after: Math.max(0, end - v) };
    const top = this.tree.offsetOf(r.first);
    const bottom = this.tree.offsetOf(r.last + 1);
    return {
      before: Math.max(0, Math.min(end, top) - v),
      after: Math.max(0, end - Math.max(v, bottom)),
    };
  }
}
