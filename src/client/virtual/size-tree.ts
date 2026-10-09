/**
 * The row-size store behind `VirtualList` / `useVirtualList`: a Fenwick (binary indexed) tree
 * over fixed-size blocks of rows, so `offsetOf(i)` and `indexAt(px)` are O(log n + B) and a
 * list of 10M rows costs a few hundred KB until its rows are actually visited.
 *
 * - Rows are grouped in blocks of {@linkcode BLOCK_SIZE}. A block is **uniform** (never
 *   touched: every row is the default size, no per-row storage), **summarized** (it once held
 *   per-row sizes and was compacted to their average, so block-level offsets stay exact), or
 *   **full** (per-row sizes plus a per-row state: unseeded, estimated, measured).
 * - The Fenwick tree runs over block sums, so a size change is O(log(n / B)) and a query is
 *   one descent plus one in-block scan over a lazily rebuilt prefix array.
 * - Logical row `i` lives at physical row `base + i`, and the physical space keeps headroom at
 *   both ends: an append or a prepend that fits the headroom touches only the edge blocks;
 *   growing the headroom re-lays the block array (O(n / B)), never the rows.
 * - A splice in the middle is a rebuild over the materialized rows only (see
 *   {@linkcode SizeTree.rebuild}).
 *
 * @module
 */

// Literals, not `1 << BLOCK_SHIFT` / `BLOCK_SIZE - 1`: the bundler keeps a computed module-scope
// constant even when nothing uses it, which put these three into every app's shared runtime chunk
// (the root `denext` entry reaches this module), VirtualList or not.
/** log2 of the rows per block. */
const BLOCK_SHIFT = 8;
/** Rows per block (`1 << BLOCK_SHIFT`). */
export const BLOCK_SIZE: number = 256;
/** Mask of a row's position inside its block (`BLOCK_SIZE - 1`). */
const BLOCK_MASK = 255;

/** A row's size state: never seeded (default size), estimated, or measured. */
export const RowState = { Default: 0, Estimated: 1, Measured: 2 } as const;
/** One of {@linkcode RowState}'s values. */
export type RowStateValue = typeof RowState[keyof typeof RowState];

/** A block with per-row storage. */
interface FullBlock {
  readonly sizes: Float64Array;
  readonly state: Uint8Array;
  /** Prefix sums of `sizes` (length `BLOCK_SIZE + 1`), rebuilt lazily after a change. */
  prefix: Float64Array | null;
}

/** A compacted block: every present row reads as `avg`. */
interface SummaryBlock {
  readonly avg: number;
}

/** A block: `undefined` is uniform (every present row is the default size). */
type Block = FullBlock | SummaryBlock | undefined;

/** Whether `b` carries per-row storage. */
function isFull(b: Block): b is FullBlock {
  return b !== undefined && "sizes" in b;
}

/** One materialized row, as {@linkcode SizeTree.entries} yields it. */
export interface SizeEntry {
  /** The row's logical index. */
  readonly index: number;
  /** Its size in px. */
  readonly size: number;
  /** Its {@linkcode RowState}. */
  readonly state: RowStateValue;
}

/**
 * Row sizes with O(log n) offset queries, lazy per-block storage and cheap growth at both
 * ends. Sizes are non-negative px values; absent physical rows (headroom) are size 0.
 */
export class SizeTree {
  #count = 0;
  #base = 0;
  #def: number;
  #blocks: Block[] = [];
  #sums: Float64Array = new Float64Array(0);
  #fen: Float64Array = new Float64Array(1);
  #total = 0;
  #full = 0;

  /**
   * @param count The number of rows.
   * @param defaultSize The size every row has until it is estimated or measured.
   */
  constructor(count = 0, defaultSize = 48) {
    this.#def = Math.max(0, defaultSize);
    this.#layout(Math.max(0, count), 0, 0);
  }

  /** The number of rows. */
  get count(): number {
    return this.#count;
  }

  /** The sum of every row's size. */
  get total(): number {
    return this.#total;
  }

  /** How many blocks currently hold per-row storage (the memory the tree is using). */
  get fullBlocks(): number {
    return this.#full;
  }

  // ---- layout ---------------------------------------------------------------------------

  /** Allocate a fresh, uniform block array for `count` rows with the given headroom. */
  #layout(count: number, headBlocks: number, tailBlocks: number): void {
    const nb = headBlocks + Math.ceil(count / BLOCK_SIZE) + tailBlocks;
    this.#blocks = new Array(nb);
    this.#base = headBlocks * BLOCK_SIZE;
    this.#count = count;
    this.#full = 0;
    this.#sums = new Float64Array(nb);
    this.#recomputeAllSums();
  }

  /** The physical rows `[lo, hi)` of block `b` that hold a logical row. */
  #present(b: number): [number, number] {
    const lo = Math.max(b * BLOCK_SIZE, this.#base);
    const hi = Math.min(b * BLOCK_SIZE + BLOCK_SIZE, this.#base + this.#count);
    return hi > lo ? [lo, hi] : [lo, lo];
  }

  /** Block `b`'s sum, recomputed from its representation. */
  #computeSum(b: number): number {
    const block = this.#blocks[b];
    if (isFull(block)) {
      let sum = 0;
      for (let r = 0; r < BLOCK_SIZE; r++) sum += block.sizes[r];
      return sum;
    }
    const [lo, hi] = this.#present(b);
    return (hi - lo) * (block === undefined ? this.#def : block.avg);
  }

  /** Recompute every block sum and rebuild the Fenwick tree (O(n / B)). */
  #recomputeAllSums(): void {
    const nb = this.#blocks.length;
    if (this.#sums.length !== nb) this.#sums = new Float64Array(nb);
    for (let b = 0; b < nb; b++) this.#sums[b] = this.#computeSum(b);
    this.#rebuildFenwick();
  }

  /** Build the Fenwick tree over `#sums` in O(n / B). */
  #rebuildFenwick(): void {
    const nb = this.#sums.length;
    const fen = new Float64Array(nb + 1);
    let total = 0;
    for (let b = 0; b < nb; b++) {
      fen[b + 1] += this.#sums[b];
      total += this.#sums[b];
      const parent = (b + 1) + ((b + 1) & -(b + 1));
      if (parent <= nb) fen[parent] += fen[b + 1];
    }
    this.#fen = fen;
    this.#total = total;
  }

  /** Add `d` to block `b`'s sum. */
  #addToBlock(b: number, d: number): void {
    if (d === 0) return;
    this.#sums[b] += d;
    this.#total += d;
    const fen = this.#fen;
    for (let i = b + 1; i < fen.length; i += i & -i) fen[i] += d;
  }

  /** The sum of blocks `[0, b)`. */
  #blockPrefix(b: number): number {
    let sum = 0;
    for (let i = b; i > 0; i -= i & -i) sum += this.#fen[i];
    return sum;
  }

  /** Block `b` with per-row storage, converting a uniform or summarized block. */
  #materialize(b: number): FullBlock {
    const block = this.#blocks[b];
    if (isFull(block)) return block;
    const full: FullBlock = {
      sizes: new Float64Array(BLOCK_SIZE),
      state: new Uint8Array(BLOCK_SIZE),
      prefix: null,
    };
    const size = block === undefined ? this.#def : block.avg;
    const state = block === undefined ? RowState.Default : RowState.Estimated;
    const [lo, hi] = this.#present(b);
    for (let p = lo; p < hi; p++) {
      full.sizes[p & BLOCK_MASK] = size;
      full.state[p & BLOCK_MASK] = state;
    }
    this.#blocks[b] = full;
    this.#full++;
    return full;
  }

  /** The prefix array of a full block, rebuilt when stale. */
  #prefixOf(block: FullBlock): Float64Array {
    if (block.prefix) return block.prefix;
    const prefix = new Float64Array(BLOCK_SIZE + 1);
    for (let r = 0; r < BLOCK_SIZE; r++) prefix[r + 1] = prefix[r] + block.sizes[r];
    block.prefix = prefix;
    return prefix;
  }

  // ---- queries --------------------------------------------------------------------------

  /** Row `i`'s size (0 outside `[0, count)`). */
  sizeOf(i: number): number {
    if (i < 0 || i >= this.#count) return 0;
    const p = this.#base + i;
    const block = this.#blocks[p >> BLOCK_SHIFT];
    if (isFull(block)) return block.sizes[p & BLOCK_MASK];
    return block === undefined ? this.#def : block.avg;
  }

  /** Row `i`'s {@linkcode RowState}. */
  stateOf(i: number): RowStateValue {
    if (i < 0 || i >= this.#count) return RowState.Default;
    const p = this.#base + i;
    const block = this.#blocks[p >> BLOCK_SHIFT];
    if (isFull(block)) return block.state[p & BLOCK_MASK] as RowStateValue;
    return block === undefined ? RowState.Default : RowState.Estimated;
  }

  /** Whether row `i`'s size came from a measurement (or an exact size hint). */
  isMeasured(i: number): boolean {
    return this.stateOf(i) === RowState.Measured;
  }

  /** The sum of the sizes of rows `[0, i)`; `i` is clamped to `[0, count]`. */
  offsetOf(i: number): number {
    if (i <= 0) return 0;
    if (i >= this.#count) return this.#total;
    const p = this.#base + i;
    const b = p >> BLOCK_SHIFT;
    const r = p & BLOCK_MASK;
    const block = this.#blocks[b];
    if (isFull(block)) return this.#blockPrefix(b) + this.#prefixOf(block)[r];
    const lo = Math.max(b * BLOCK_SIZE, this.#base);
    const rows = Math.max(0, p - lo);
    return this.#blockPrefix(b) + rows * (block === undefined ? this.#def : block.avg);
  }

  /**
   * The row at `px`: the largest `i` with `offsetOf(i) <= px` whose size is non-zero, clamped
   * to `[0, count - 1]` (0 for an empty tree).
   */
  indexAt(px: number): number {
    const n = this.#count;
    if (n === 0 || !(px > 0)) return 0;
    if (px >= this.#total) return n - 1;
    const [b, rem] = this.#descend(px);
    return Math.min(n - 1, Math.max(0, this.#rowIn(b, rem) - this.#base));
  }

  /** The block holding `px` and the remainder inside it (a Fenwick descent). */
  #descend(px: number): [number, number] {
    const fen = this.#fen;
    const nb = fen.length - 1;
    let pos = 0;
    let rem = px;
    let step = 1;
    while (step * 2 <= nb) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= nb && fen[next] <= rem) {
        pos = next;
        rem -= fen[next];
      }
    }
    // `pos` is the block holding `px` (every later block's prefix exceeds it).
    return [Math.min(pos, nb - 1), rem];
  }

  /** The physical row `rem` px into block `b`. */
  #rowIn(b: number, rem: number): number {
    const block = this.#blocks[b];
    if (!isFull(block)) {
      const size = block === undefined ? this.#def : block.avg;
      const [lo, hi] = this.#present(b);
      return Math.min(hi - 1, lo + (size > 0 ? Math.floor(rem / size) : 0));
    }
    const prefix = this.#prefixOf(block);
    let lo = 0;
    let hi = BLOCK_SIZE - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] <= rem) lo = mid;
      else hi = mid - 1;
    }
    return b * BLOCK_SIZE + lo;
  }

  // ---- updates --------------------------------------------------------------------------

  /**
   * Set row `i`'s size and state; returns the size delta (0 when `i` is out of range or the
   * size did not change).
   */
  set(i: number, size: number, state: RowStateValue = RowState.Measured): number {
    if (i < 0 || i >= this.#count || !(size >= 0)) return 0;
    const p = this.#base + i;
    const b = p >> BLOCK_SHIFT;
    const block = this.#materialize(b);
    const r = p & BLOCK_MASK;
    const d = size - block.sizes[r];
    block.state[r] = state;
    if (d === 0) return 0;
    block.sizes[r] = size;
    block.prefix = null;
    this.#addToBlock(b, d);
    return d;
  }

  /**
   * Change the default size (the size of every row never estimated or measured). Offsets of
   * uniform blocks move; O(n / B).
   */
  setDefaultSize(size: number): void {
    if (!(size >= 0) || size === this.#def) return;
    this.#def = size;
    this.#recomputeAllSums();
  }

  /** Grow or shrink at the end to `count` rows (new rows are the default size). */
  resize(count: number): void {
    count = Math.max(0, Math.floor(count));
    const old = this.#count;
    if (count === old) return;
    if (count > old) {
      const needBlocks = Math.ceil((this.#base + count) / BLOCK_SIZE);
      if (needBlocks > this.#blocks.length) {
        const grow = Math.max(needBlocks - this.#blocks.length, this.#blocks.length >> 2, 1);
        this.#blocks.length += grow;
      }
    }
    const lo = this.#base + Math.min(old, count);
    const hi = this.#base + Math.max(old, count);
    this.#count = count;
    this.#fillEdge(lo, hi, count > old);
    this.#recomputeAllSums();
  }

  /** Insert `k` default-size rows before row 0. */
  prepend(k: number): void {
    k = Math.max(0, Math.floor(k));
    if (k === 0) return;
    if (this.#base < k) {
      const need = Math.ceil((k - this.#base) / BLOCK_SIZE);
      const grow = Math.max(need, this.#blocks.length >> 2, 1);
      this.#blocks = [...new Array<Block>(grow), ...this.#blocks];
      this.#base += grow * BLOCK_SIZE;
    }
    const oldBase = this.#base;
    this.#base -= k;
    this.#count += k;
    this.#fillEdge(this.#base, oldBase, true);
    this.#recomputeAllSums();
  }

  /** Remove the first `k` rows. */
  removeFront(k: number): void {
    k = Math.max(0, Math.min(this.#count, Math.floor(k)));
    if (k === 0) return;
    const lo = this.#base;
    this.#base += k;
    this.#count -= k;
    this.#fillEdge(lo, lo + k, false);
    this.#recomputeAllSums();
  }

  /**
   * Physical rows `[lo, hi)` just became present (`present`) or absent: give present rows of
   * full blocks the default size, zero absent ones, and drop blocks left with no rows.
   */
  #fillEdge(lo: number, hi: number, present: boolean): void {
    for (let b = lo >> BLOCK_SHIFT; b <= (hi - 1) >> BLOCK_SHIFT && b < this.#blocks.length; b++) {
      const block = this.#blocks[b];
      const [plo, phi] = this.#present(b);
      if (!present && phi <= plo) {
        if (isFull(block)) this.#full--;
        this.#blocks[b] = undefined;
        continue;
      }
      if (!isFull(block)) continue;
      const from = Math.max(lo, b * BLOCK_SIZE);
      const to = Math.min(hi, b * BLOCK_SIZE + BLOCK_SIZE);
      for (let p = from; p < to; p++) {
        block.sizes[p & BLOCK_MASK] = present ? this.#def : 0;
        block.state[p & BLOCK_MASK] = RowState.Default;
      }
      block.prefix = null;
    }
  }

  /**
   * Replace the whole tree: `count` rows, the default size everywhere, then each of `rows`
   * applied. Cost: O(n / B + rows). Used for splices in the middle and for key remaps.
   */
  rebuild(count: number, rows: Iterable<SizeEntry>): void {
    this.#layout(Math.max(0, count), 0, 0);
    for (const row of rows) {
      if (row.state === RowState.Default) continue;
      const i = row.index;
      if (i < 0 || i >= this.#count) continue;
      const p = this.#base + i;
      const block = this.#materialize(p >> BLOCK_SHIFT);
      block.sizes[p & BLOCK_MASK] = row.size;
      block.state[p & BLOCK_MASK] = row.state;
      block.prefix = null;
    }
    this.#recomputeAllSums();
  }

  /** Every row that is not the default size, in index order. */
  *entries(): Generator<SizeEntry> {
    for (let b = 0; b < this.#blocks.length; b++) {
      const block = this.#blocks[b];
      if (block === undefined) continue;
      const [lo, hi] = this.#present(b);
      for (let p = lo; p < hi; p++) {
        const index = p - this.#base;
        if (isFull(block)) {
          const state = block.state[p & BLOCK_MASK] as RowStateValue;
          if (state !== RowState.Default) {
            yield { index, size: block.sizes[p & BLOCK_MASK], state };
          }
        } else yield { index, size: block.avg, state: RowState.Estimated };
      }
    }
  }

  /**
   * Bound memory: while more than `maxFullBlocks` blocks hold per-row storage, fold the ones
   * farthest from rows `[keepFrom, keepTo]` into their average. Every offset is unchanged
   * (block sums are kept); rows inside a folded block read as the average until re-measured.
   */
  compact(keepFrom: number, keepTo: number, maxFullBlocks: number): void {
    if (this.#full <= maxFullBlocks) return;
    const keepLo = (this.#base + Math.max(0, keepFrom)) >> BLOCK_SHIFT;
    const keepHi = (this.#base + Math.max(0, keepTo)) >> BLOCK_SHIFT;
    const candidates: number[] = [];
    for (let b = 0; b < this.#blocks.length; b++) {
      if (isFull(this.#blocks[b]) && (b < keepLo || b > keepHi)) candidates.push(b);
    }
    const dist = (b: number): number => (b < keepLo ? keepLo - b : b - keepHi);
    candidates.sort((a, b) => dist(b) - dist(a));
    for (const b of candidates) {
      if (this.#full <= maxFullBlocks) break;
      const [lo, hi] = this.#present(b);
      const n = hi - lo;
      this.#blocks[b] = n > 0 ? { avg: this.#sums[b] / n } : undefined;
      this.#full--;
    }
  }
}
