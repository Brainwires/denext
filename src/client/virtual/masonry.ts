/**
 * The layout engine behind `VirtualMasonry` (`denext/virtual-masonry`): variable-height items
 * in N columns, each new item placed in the currently shortest column (column-balanced, as
 * Pinterest / `MasonryFlashList` do). An item keeps its column once placed — a late image load
 * only pushes the items below it in that column down, never reshuffles columns — and appends
 * are incremental. Per column the items are kept in order with their tops, so the visible
 * items of a viewport are one binary search per column.
 *
 * Costs: an append of k items is O(k · columns); a size change is O(items below it in its
 * column); a non-append data change re-places every item (O(n · columns)), carrying known
 * sizes over by key. Built for lists up to ~100k items (use `VirtualList` + `numColumns` for
 * uniform grids of millions).
 *
 * @module
 */

/** An item's placement. */
export interface MasonryPlacement {
  /** Its column. */
  readonly column: number;
  /** Px from the top of the layout. */
  readonly top: number;
  /** Its height. */
  readonly size: number;
}

/** A masonry layout over `count` items. */
export class MasonryLayout {
  #cols: number;
  #gap: number;
  #col: Int32Array = new Int32Array(0);
  #top: Float64Array = new Float64Array(0);
  #size: Float64Array = new Float64Array(0);
  #pos: Int32Array = new Int32Array(0);
  /** Per column: item indices in order. */
  #lists: number[][] = [];
  /** Per column: the bottom of its last item (plus gap). */
  #bottoms: number[] = [];
  #count = 0;

  /**
   * An empty layout.
   *
   * @param columns Number of columns (≥ 1).
   * @param rowGap Px between items in a column.
   */
  constructor(columns: number, rowGap = 0) {
    this.#cols = Math.max(1, Math.floor(columns));
    this.#gap = Math.max(0, rowGap);
    this.#reset();
  }

  /** Number of columns. */
  get columns(): number {
    return this.#cols;
  }

  /** Number of items placed. */
  get count(): number {
    return this.#count;
  }

  /** The layout's height (the tallest column). */
  get height(): number {
    let h = 0;
    for (const b of this.#bottoms) h = Math.max(h, b);
    return Math.max(0, h - (this.#count > 0 ? this.#gap : 0));
  }

  #reset(): void {
    this.#lists = Array.from({ length: this.#cols }, () => []);
    this.#bottoms = new Array(this.#cols).fill(0);
    this.#count = 0;
  }

  #grow(n: number): void {
    if (n <= this.#col.length) return;
    const cap = Math.max(n, this.#col.length * 2, 64);
    const col = new Int32Array(cap);
    col.set(this.#col);
    const top = new Float64Array(cap);
    top.set(this.#top);
    const size = new Float64Array(cap);
    size.set(this.#size);
    const pos = new Int32Array(cap);
    pos.set(this.#pos);
    this.#col = col;
    this.#top = top;
    this.#size = size;
    this.#pos = pos;
  }

  /** Append items `[count, n)` with sizes from `sizeOf`, each into the shortest column. */
  append(n: number, sizeOf: (i: number) => number): void {
    this.#grow(n);
    for (let i = this.#count; i < n; i++) {
      let c = 0;
      for (let k = 1; k < this.#cols; k++) if (this.#bottoms[k] < this.#bottoms[c]) c = k;
      const size = Math.max(0, sizeOf(i));
      this.#col[i] = c;
      this.#top[i] = this.#bottoms[c];
      this.#size[i] = size;
      this.#pos[i] = this.#lists[c].length;
      this.#lists[c].push(i);
      this.#bottoms[c] += size + this.#gap;
    }
    this.#count = Math.max(this.#count, n);
  }

  /** Re-place every item (new data, new column count or gap). */
  rebuild(
    n: number,
    sizeOf: (i: number) => number,
    columns: number = this.#cols,
    rowGap: number = this.#gap,
  ): void {
    this.#cols = Math.max(1, Math.floor(columns));
    this.#gap = Math.max(0, rowGap);
    this.#reset();
    this.append(n, sizeOf);
  }

  /** Item `i`'s placement. */
  placement(i: number): MasonryPlacement {
    return { column: this.#col[i], top: this.#top[i], size: this.#size[i] };
  }

  /** Item `i`'s current size. */
  sizeOf(i: number): number {
    return i >= 0 && i < this.#count ? this.#size[i] : 0;
  }

  /**
   * Set item `i`'s size; the items below it in its column move by the difference. Returns
   * the difference (0 when unchanged).
   */
  setSize(i: number, size: number): number {
    if (i < 0 || i >= this.#count || !(size >= 0)) return 0;
    const d = size - this.#size[i];
    if (d === 0) return 0;
    this.#size[i] = size;
    const c = this.#col[i];
    const list = this.#lists[c];
    for (let k = this.#pos[i] + 1; k < list.length; k++) this.#top[list[k]] += d;
    this.#bottoms[c] += d;
    return d;
  }

  /** Items intersecting `[from, to)`, in index order. */
  visible(from: number, to: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.#cols; c++) {
      const list = this.#lists[c];
      // First item whose bottom is past `from`.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const i = list[mid];
        if (this.#top[i] + this.#size[i] <= from) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < list.length; k++) {
        const i = list[k];
        if (this.#top[i] >= to) break;
        out.push(i);
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** The column heights (for tests and diagnostics). */
  columnHeights(): number[] {
    return this.#bottoms.map((b, c) =>
      Math.max(0, b - (this.#lists[c].length > 0 ? this.#gap : 0))
    );
  }
}
