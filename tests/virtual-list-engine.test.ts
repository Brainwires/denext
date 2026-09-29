// Unit tests for the VirtualList engine (src/client/virtual/*): the Fenwick size tree (checked
// against a naive model under random operations, and at 10M rows), scroll-scaling math, range
// + overscan + hysteresis, edge-callback semantics, recycling pools, and the core's anchoring
// / reconciliation / scroll-to logic. No DOM.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { BLOCK_SIZE, RowState, SizeTree } from "../src/client/virtual/size-tree.ts";
import {
  DEFAULT_MAX_PHYSICAL_SIZE,
  isScaled,
  physicalExtent,
  scrollRatio,
  toPhysical,
  toVirtual,
} from "../src/client/virtual/scale.ts";
import {
  desiredRange,
  nextRange,
  overscanFor,
  rowsBetween,
  visibleRange,
} from "../src/client/virtual/range.ts";
import { EdgeTracker } from "../src/client/virtual/edges.ts";
import { RecyclePool } from "../src/client/virtual/recycle.ts";
import { type CoreSource, VirtualCore } from "../src/client/virtual/core.ts";
import { createTextEstimator } from "../src/client/virtual/text-estimate.ts";

/** A deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The naive model: an array of sizes. */
function naiveOffset(sizes: number[], i: number): number {
  let sum = 0;
  for (let k = 0; k < Math.min(i, sizes.length); k++) sum += sizes[k];
  return sum;
}

function naiveIndexAt(sizes: number[], px: number): number {
  if (sizes.length === 0 || !(px > 0)) return 0;
  let sum = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (sum + sizes[i] > px) return i;
    sum += sizes[i];
  }
  return sizes.length - 1;
}

function assertMatches(tree: SizeTree, sizes: number[], label: string): void {
  assertEquals(tree.count, sizes.length, `${label}: count`);
  assertAlmostEquals(tree.total, naiveOffset(sizes, sizes.length), 1e-6, `${label}: total`);
  const probes = [0, 1, sizes.length >> 1, sizes.length - 1, sizes.length];
  for (let k = 0; k < 20; k++) probes.push(Math.floor((k / 20) * sizes.length));
  for (const i of probes) {
    assertAlmostEquals(tree.offsetOf(i), naiveOffset(sizes, i), 1e-6, `${label}: offsetOf(${i})`);
    if (i < sizes.length) assertEquals(tree.sizeOf(i), sizes[i], `${label}: sizeOf(${i})`);
  }
  const total = tree.total;
  for (let k = 0; k <= 25; k++) {
    const px = (k / 25) * total + (k % 3) * 0.37;
    assertEquals(tree.indexAt(px), naiveIndexAt(sizes, px), `${label}: indexAt(${px})`);
  }
}

// ---- SizeTree ------------------------------------------------------------------------------

Deno.test("SizeTree: uniform rows answer offsetOf / indexAt / total without per-row storage", () => {
  const t = new SizeTree(1000, 20);
  assertEquals(t.total, 20_000);
  assertEquals(t.offsetOf(0), 0);
  assertEquals(t.offsetOf(10), 200);
  assertEquals(t.offsetOf(1000), 20_000);
  assertEquals(t.indexAt(0), 0);
  assertEquals(t.indexAt(19.99), 0);
  assertEquals(t.indexAt(20), 1);
  assertEquals(t.indexAt(1e9), 999);
  assertEquals(t.fullBlocks, 0, "nothing materialized");
  assertEquals(t.stateOf(5), RowState.Default);
});

Deno.test("SizeTree: set() updates offsets after the row and returns the delta", () => {
  const t = new SizeTree(600, 10);
  assertEquals(t.set(300, 110), 100);
  assertEquals(t.set(300, 110), 0, "no change → 0");
  assertEquals(t.offsetOf(300), 3000);
  assertEquals(t.offsetOf(301), 3110);
  assertEquals(t.total, 6100);
  assertEquals(t.indexAt(3050), 300);
  assertEquals(t.indexAt(3110), 301);
  assert(t.isMeasured(300));
  assertEquals(t.fullBlocks, 1, "only the touched block is materialized");
});

Deno.test("SizeTree: random set/resize/prepend/removeFront/rebuild match a naive model", () => {
  const rand = rng(42);
  const def = 30;
  const tree = new SizeTree(700, def);
  let sizes: number[] = Array.from({ length: 700 }, () => def);
  for (let step = 0; step < 400; step++) {
    const op = rand();
    if (op < 0.45 && sizes.length > 0) {
      const i = Math.floor(rand() * sizes.length);
      const size = Math.round(rand() * 200 * 4) / 4;
      tree.set(i, size);
      sizes[i] = size;
    } else if (op < 0.6) {
      const k = Math.floor(rand() * 400);
      tree.resize(sizes.length + k);
      sizes = sizes.concat(Array.from({ length: k }, () => def));
    } else if (op < 0.7) {
      const n = Math.floor(rand() * sizes.length);
      tree.resize(n);
      sizes = sizes.slice(0, n);
    } else if (op < 0.82) {
      const k = Math.floor(rand() * 600);
      tree.prepend(k);
      sizes = Array.from({ length: k }, () => def).concat(sizes);
    } else if (op < 0.92) {
      const k = Math.floor(rand() * Math.min(300, sizes.length + 1));
      tree.removeFront(k);
      sizes = sizes.slice(k);
    } else {
      // A rebuild carrying every non-default row over (a key remap with identity keys).
      const rows = [...tree.entries()];
      tree.rebuild(sizes.length, rows);
    }
    assertMatches(tree, sizes, `step ${step}`);
  }
});

Deno.test("SizeTree: 10M rows — O(log n) queries, lazy storage, cheap append/prepend", () => {
  const n = 10_000_000;
  const t0 = performance.now();
  const t = new SizeTree(n, 48);
  assertEquals(t.total, n * 48);
  assertEquals(t.offsetOf(n - 1), (n - 1) * 48);
  assertEquals(t.indexAt(t.total - 1), n - 1);
  assertEquals(t.indexAt(123_456 * 48 + 1), 123_456);
  for (let i = 0; i < 1000; i++) t.set(5_000_000 + i, 100);
  assertEquals(t.offsetOf(5_001_000), 5_001_000 * 48 + 1000 * 52);
  assertEquals(t.indexAt(5_000_000 * 48 + 150), 5_000_001);
  t.resize(n + 1000);
  t.prepend(1000);
  assertEquals(t.count, n + 2000);
  assertEquals(t.offsetOf(1000), 1000 * 48);
  assert(
    t.fullBlocks <= Math.ceil(1000 / BLOCK_SIZE) + 3,
    `lazy storage (full blocks: ${t.fullBlocks})`,
  );
  // 100k random queries stay fast (O(log n + B) each).
  const rand = rng(7);
  for (let k = 0; k < 100_000; k++) {
    const i = Math.floor(rand() * t.count);
    const off = t.offsetOf(i);
    assertEquals(t.indexAt(off), i);
  }
  const ms = performance.now() - t0;
  assert(ms < 5000, `10M-row operations took ${ms.toFixed(0)} ms`);
});

Deno.test("SizeTree: compact() folds far blocks to averages without moving any offset", () => {
  const t = new SizeTree(BLOCK_SIZE * 40, 10);
  for (let i = 0; i < t.count; i++) t.set(i, 10 + (i % 7));
  const before = [0, 100, 3000, 7000, t.count].map((i) => t.offsetOf(i));
  t.compact(BLOCK_SIZE * 20, BLOCK_SIZE * 21, 4);
  assertEquals(t.fullBlocks, 4);
  const after = [0, 100, 3000, 7000, t.count].map((i) => t.offsetOf(i));
  for (let k = 0; k < before.length; k++) {
    // Block boundaries are exact; inside a folded block rows read as the average.
    assertAlmostEquals(after[k], before[k], 7 * BLOCK_SIZE, `offset ${k}`);
  }
  assertAlmostEquals(t.total, before[before.length - 1], 1e-6, "total unchanged");
  assert(t.isMeasured(BLOCK_SIZE * 20 + 5), "kept block still measured");
});

// ---- scale ---------------------------------------------------------------------------------

Deno.test("scale: no scaling at or below the cap; linear mapping above it round-trips", () => {
  assertEquals(isScaled(1_000_000), false);
  assertEquals(scrollRatio(1_000_000, 800), 1);
  assertEquals(physicalExtent(1_000_000), 1_000_000);
  const V = 480_000_000; // 10M rows × 48 px
  const vp = 800;
  assert(isScaled(V));
  assertEquals(physicalExtent(V), DEFAULT_MAX_PHYSICAL_SIZE);
  const r = scrollRatio(V, vp);
  assertAlmostEquals(r, (V - vp) / (DEFAULT_MAX_PHYSICAL_SIZE - vp), 1e-9);
  // Both ends map exactly.
  assertEquals(toVirtual(0, V, vp), 0);
  assertAlmostEquals(toVirtual(DEFAULT_MAX_PHYSICAL_SIZE - vp, V, vp), V - vp, 1e-3);
  for (const v of [0, 1, 12_345, 123_456_789, V / 2, V - vp]) {
    assertAlmostEquals(toVirtual(toPhysical(v, V, vp), V, vp), v, 1e-3, `round trip ${v}`);
  }
});

// ---- range ---------------------------------------------------------------------------------

Deno.test("range: overscan is symmetric at rest and leans toward the direction of travel", () => {
  assertEquals(overscanFor(500, 0), { before: 500, after: 500 });
  const down = overscanFor(500, 6);
  assert(down.after > 500 && down.before < 500, JSON.stringify(down));
  const up = overscanFor(500, -6);
  assert(up.before > 500 && up.after < 500, JSON.stringify(up));
  assert(overscanFor(500, 100).after <= 500 * 3 + 1, "capped");
});

Deno.test("range: visible / desired / rowsBetween over a variable tree", () => {
  const t = new SizeTree(100, 50);
  t.set(10, 200);
  assertEquals(visibleRange(t, 0, 500), { first: 0, last: 9 });
  assertEquals(visibleRange(t, 490, 100), { first: 9, last: 10 });
  assertEquals(rowsBetween(t, 500, 700), { first: 10, last: 10 });
  const d = desiredRange(t, 1000, 500, { before: 100, after: 100 });
  assert(d.first <= t.indexAt(900) && d.last >= t.indexAt(1599), JSON.stringify(d));
});

Deno.test("range: hysteresis keeps the rendered range for small scrolls, replaces it when needed", () => {
  const t = new SizeTree(10_000, 20);
  const r0 = nextRange(t, { first: 0, last: -1 }, 2000, 400, 400, 0);
  assert(r0.first <= 80 && r0.last >= 120);
  assertEquals(
    nextRange(t, r0, 2040, 400, 400, 0),
    r0,
    "a 40 px scroll inside the window re-renders nothing",
  );
  const far = nextRange(t, r0, 20_000, 400, 400, 0);
  assert(far.first > r0.last, "a jump replaces the range");
});

// ---- edges ---------------------------------------------------------------------------------

Deno.test("edges: never on mount; once per data version on movement toward the edge (T14)", () => {
  const e = new EdgeTracker();
  e.data("v1");
  const base = { vp: 500, total: 5000, endThreshold: 0.5, startThreshold: 0.5, hasRows: true };
  // (a) content fills the viewport on mount: no call.
  assertEquals(e.check({ ...base, v: 0, dir: 0 }), { end: false, start: false });
  // Scrolling toward the end, not yet near it.
  assertEquals(e.check({ ...base, v: 3000, dir: 1 }).end, false);
  // (c) near the end: exactly one call, however many scroll events follow.
  assertEquals(e.check({ ...base, v: 4300, dir: 1 }).end, true);
  assertEquals(e.check({ ...base, v: 4400, dir: 1 }).end, false);
  assertEquals(e.check({ ...base, v: 4500, dir: 1 }).end, false);
  // (d) new data re-arms.
  e.data("v2");
  assertEquals(e.check({ ...base, total: 8000, v: 7300, dir: 1 }).end, true);
  // Moving AWAY from the start near the top never fires onStartReached (FlashList #1872).
  e.data("v3");
  assertEquals(e.check({ ...base, v: 100, dir: 1 }).start, false);
  assertEquals(e.check({ ...base, v: 50, dir: -1 }).start, true);
});

Deno.test("edges: content shorter than the viewport fires once (T14b, T7) and never while bouncing", () => {
  const e = new EdgeTracker();
  e.data("short");
  const short = {
    v: 0,
    vp: 800,
    total: 300,
    dir: 0,
    endThreshold: 0.5,
    startThreshold: 0.5,
    hasRows: true,
  };
  assertEquals(e.check({ ...short, bouncing: true }), { end: false, start: false });
  assertEquals(e.check(short), { end: true, start: true });
  assertEquals(e.check(short), { end: false, start: false });
  assertEquals(e.check({ ...short, hasRows: false }), { end: false, start: false });
});

// ---- recycle -------------------------------------------------------------------------------

Deno.test("recycle: cells stay with their items, are reused within a type, never across types", () => {
  const pool = new RecyclePool();
  const a = pool.assign([{ key: 1, type: "text" }, { key: 2, type: "image" }, {
    key: 3,
    type: "text",
  }]);
  assertEquals(new Set(a).size, 3);
  // Item 1 leaves, item 4 (text) enters: it takes item 1's cell; 2 and 3 keep theirs.
  const b = pool.assign([{ key: 2, type: "image" }, { key: 3, type: "text" }, {
    key: 4,
    type: "text",
  }]);
  assertEquals(b[0], a[1]);
  assertEquals(b[1], a[2]);
  assertEquals(b[2], a[0], "a freed text cell is reused for a text item");
  // An image item never takes a text cell.
  const c = pool.assign([{ key: 5, type: "image" }]);
  assert(c[0] !== a[0] && c[0] !== a[2], "no cross-type reuse");
  assertEquals(c[0], a[1], "the freed image cell");
});

// ---- core ----------------------------------------------------------------------------------

/** A keyed source over `keys` with an optional per-key size. */
function source(
  keys: (string | number)[],
  size?: (k: string | number) => number,
  exact = false,
): CoreSource {
  return {
    count: keys.length,
    keyAt: (i) => keys[i],
    hint: size ? (i) => size(keys[i]) : undefined,
    exact,
    token: keys,
  };
}

function coreWith(keys: (string | number)[], vp = 500, size = 50): VirtualCore {
  const core = new VirtualCore({ defaultSize: size });
  core.setMetrics(vp, 0, 0);
  core.setSource(source(keys));
  core.updateRange();
  return core;
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

Deno.test("core: a size change above the viewport is absorbed into delta — no scroll write, no visual move", () => {
  const core = coreWith(range(0, 200));
  core.scroll(1000, 1);
  assertEquals(core.v, 1000);
  const topKeyBefore = core.visible().first;
  // Row 5 (above the viewport) measures 150 instead of 50.
  core.measure([[5, 150]]);
  assertEquals(core.s, 1000, "the physical offset is untouched");
  assertEquals(core.v, 1100, "the virtual offset follows the content");
  assertEquals(core.delta, 100);
  assertEquals(core.visible().first, topKeyBefore, "the same row is at the top");
  // Physical position of the visible row is unchanged: offsetOf - delta.
  assertEquals(core.physicalOffset(20), 1000);
  // A change below the viewport moves nothing.
  core.measure([[100, 300]]);
  assertEquals(core.v, 1100);
});

Deno.test("core: reconcile writes only when no gesture is in flight (iOS momentum)", () => {
  const core = coreWith(range(0, 200));
  core.scroll(1000, 1);
  core.deferring = true;
  core.measure([[5, 150]]);
  assertEquals(core.reconcileTarget(false), null, "no write while deferring");
  core.deferring = false;
  assertEquals(core.reconcileTarget(false), 1100);
  const s = core.prepareWrite(core.v);
  assertEquals(s, 1100);
  assertEquals(core.delta, 0);
  core.commitWrite(1100);
  assertEquals(core.v, 1100);
  assertEquals(core.reconcileTarget(false), null);
});

Deno.test("core: prepend keeps the visible row by key (B1, T5)", () => {
  let keys = range(100, 300);
  const core = coreWith(keys);
  core.scroll(1000, 1); // key 120 at the top
  assertEquals(keys[core.visible().first], 120);
  keys = [...range(0, 100), ...keys];
  core.setSource(source(keys));
  assertEquals(keys[core.visible().first], 120, "same row still at the top");
  assertEquals(core.v - core.tree.offsetOf(keys.indexOf(120)), 0);
  assertEquals(core.s, 1000, "no scroll write");
});

Deno.test("core: insert and remove in the middle keep the position; a removed anchor falls back (B7)", () => {
  let keys = range(0, 300);
  const core = coreWith(keys);
  core.scroll(5000, 1); // key 100 at the top
  keys = [...keys.slice(0, 50), -1, -2, -3, ...keys.slice(50)];
  core.setSource(source(keys));
  assertEquals(keys[core.visible().first], 100);
  // Remove the anchor row itself: the next visible row holds its place.
  const at = core.tree.offsetOf(keys.indexOf(101)) - core.v;
  keys = keys.filter((k) => k !== 100);
  core.setSource(source(keys));
  assertEquals(core.tree.offsetOf(keys.indexOf(101)) - core.v, at);
});

Deno.test("core: general data changes carry measured sizes over by key", () => {
  let keys = range(0, 50);
  const core = coreWith(keys);
  core.measure([[3, 333]]);
  keys = [...keys].reverse();
  core.setSource(source(keys));
  assertEquals(core.tree.sizeOf(keys.indexOf(3)), 333);
  assert(core.tree.isMeasured(keys.indexOf(3)));
});

Deno.test("core: anchor end — starts at the end, stays pinned on append / growth, not when scrolled up (B2, B3, T6)", () => {
  let keys = range(0, 100);
  const core = new VirtualCore({ defaultSize: 50, anchor: "end" });
  core.setMetrics(500, 0, 0);
  core.setSource(source(keys));
  core.initialEnd();
  assertEquals(core.v, core.vmax);
  core.prepareWrite(core.v);
  assert(core.isAtEnd());
  // Append while at the end: still at the end.
  keys = [...keys, 100, 101];
  core.setSource(source(keys));
  assertEquals(core.v, core.vmax, "pinned after append");
  // The last row grows (streaming): still at the end.
  core.measure([[101, 400]]);
  assertEquals(core.v, core.vmax, "pinned after growth");
  // Scroll up 200 px: no longer pinned; append does not move the view.
  core.scroll(core.s - 200, 10);
  assert(!core.pinned);
  const v = core.v;
  keys = [...keys, 102];
  core.setSource(source(keys));
  assertEquals(core.v, v, "unmoved while scrolled up");
});

Deno.test("core: maintainVisibleContentPosition=false leaves the offset alone", () => {
  let keys = range(100, 300);
  const core = new VirtualCore({ defaultSize: 50, maintainVisibleContentPosition: false });
  core.setMetrics(500, 0, 0);
  core.setSource(source(keys));
  core.scroll(1000, 1);
  keys = [...range(0, 100), ...keys];
  core.setSource(source(keys));
  assertEquals(core.v, 1000);
});

/**
 * Drive `core` to a scroll target like the browser would: render the window, measure it with
 * the true sizes, let the engine correct, repeat until it settles. Returns the row's top
 * relative to the viewport.
 */
function landOn(
  core: VirtualCore,
  index: number,
  align: "start" | "end" | "center",
  truth: (i: number) => number,
): number {
  core.target = { index, align, viewOffset: 0, passes: 0 };
  core.prepareWrite(core.targetOffset(core.target));
  for (let pass = 0; pass < 10 && core.target; pass++) {
    core.updateRange();
    const batch: [number, number][] = [];
    for (let i = core.range.first; i <= core.range.last; i++) batch.push([i, truth(i)]);
    core.measure(batch);
    core.prepareWrite(core.targetOffset(core.target!));
    core.settleTarget(true);
  }
  assertEquals(core.target, null, `target ${index} settled`);
  return core.tree.offsetOf(index) - core.v;
}

Deno.test("core: scroll targets land exactly on unmeasured variable rows by measure-and-correct (C1)", () => {
  const truth = (i: number) => 20 + ((i * 37) % 180); // actual sizes, all unknown up front
  const core = new VirtualCore({ defaultSize: 50 });
  core.setMetrics(600, 0, 0);
  core.setSource(source(range(0, 5000)));
  assertAlmostEquals(landOn(core, 3210, "start", truth), 0, 0.5);
  assertAlmostEquals(landOn(core, 4999, "end", truth) + truth(4999), core.vp, 0.5);
  assertAlmostEquals(landOn(core, 17, "center", truth) + truth(17) / 2, core.vp / 2, 0.5);
  assertAlmostEquals(landOn(core, 2500, "start", truth), 0, 0.5);
});

Deno.test("core: scaled lists (1M variable rows) scroll 1:1 for small deltas, re-map on jumps, reach both ends (H1)", () => {
  const n = 1_000_000;
  const core = new VirtualCore({ defaultSize: 48 });
  core.setMetrics(800, 0, 0);
  core.setSource({ count: n, keyAt: (i) => i, token: "big" });
  assert(core.scaled, "48M px virtual height is scaled");
  assertEquals(core.physicalSize(), DEFAULT_MAX_PHYSICAL_SIZE);
  core.scroll(100, 1);
  assertEquals(core.v, 100, "small scroll is 1:1 near the top");
  core.scroll(160, 2);
  assertEquals(core.v, 160);
  // A scrollbar drag to the middle re-maps linearly.
  const mid = (DEFAULT_MAX_PHYSICAL_SIZE - 800) / 2;
  core.scroll(mid, 3);
  assertAlmostEquals(core.v, (core.total - 800) / 2, 1);
  // Small scrolls from there stay 1:1 …
  core.scroll(mid + 50, 4);
  assertAlmostEquals(core.v, (core.total - 800) / 2 + 50, 1);
  // … and settling re-syncs the physical offset to the mapping without moving the view.
  const v = core.v;
  const target = core.reconcileTarget(true);
  assert(target !== null);
  core.prepareWrite(core.v);
  assertAlmostEquals(core.v, v, 1);
  // The end is reachable exactly.
  core.scroll(DEFAULT_MAX_PHYSICAL_SIZE - 800, 5);
  assertAlmostEquals(core.v, core.vmax, 1);
  core.updateRange();
  assertEquals(core.range.last, n - 1, "the last row renders at the end");
  // scrollToIndex into the scaled space is exact.
  core.target = { index: 777_777, align: "start", viewOffset: 0, passes: 0 };
  core.prepareWrite(core.targetOffset(core.target));
  assertEquals(core.tree.offsetOf(777_777) - core.v, 0);
  assert(core.s <= DEFAULT_MAX_PHYSICAL_SIZE, "physical offset stays inside the capped height");
});

Deno.test("core: rubber-band offsets are clamped and flagged, and fire no edge callbacks (F4)", () => {
  const core = coreWith(range(0, 100));
  core.scroll(-60, 1);
  assert(core.bouncing);
  assertEquals(core.v, 0);
  assertEquals(core.edges(), { end: false, start: false });
  assertEquals(core.reconcileTarget(false), null, "no correction write during the bounce");
});

Deno.test("core: velocity scales the overscan in the direction of travel", () => {
  const core = coreWith(range(0, 100_000), 500, 20);
  let t = 0;
  for (let s = 0; s < 20_000; s += 400) core.scroll(s, t += 16);
  assert(core.velocity > 5, `velocity ${core.velocity}`);
  core.range = { first: 0, last: -1 };
  core.updateRange();
  const ahead = core.tree.offsetOf(core.range.last + 1) - (core.v + core.vp);
  const behind = core.v - core.tree.offsetOf(core.range.first);
  assert(ahead > behind * 2, `ahead ${ahead} behind ${behind}`);
});

Deno.test("core: initialIndex lays the target window out at physical 0 (SSR, no flash of row 0)", () => {
  const core = new VirtualCore({ defaultSize: 40 });
  core.setMetrics(800, 0, 0);
  core.setSource(source(range(0, 10_000)));
  core.initialIndex(5000, "start");
  core.updateRange();
  assertEquals(core.s, 0);
  assertEquals(core.physicalOffset(5000), 0, "row 5000 is at the top without a scroll");
  assert(core.range.first <= 5000 && core.range.last >= 5019);
});

Deno.test("core: hints seed estimates (exact hints count as measured) and blankArea reports gaps", () => {
  const core = new VirtualCore({ defaultSize: 10 });
  core.setMetrics(500, 0, 0);
  core.setSource(source(range(0, 100), () => 25, true));
  // A data change never seeds in the render (deterministic SSR); the controller seeds after it.
  assert(core.seeding, "hints are pending after the data change");
  core.flushSeed();
  assertEquals(core.total, 2500);
  assert(core.tree.isMeasured(50));
  core.updateRange();
  assertEquals(core.blankArea(), { before: 0, after: 0 });
  core.range = { first: 30, last: 40 };
  const blank = core.blankArea();
  assert(blank.before > 0, JSON.stringify(blank));
});

Deno.test("text estimate: wraps words at the width, deterministic without a canvas", () => {
  const est = createTextEstimator<string>({
    font: "10px sans",
    lineHeight: 12,
    padding: 4,
    text: (s) => s,
  }, () => 100);
  assertEquals(est("hi"), 16);
  const long = est("word ".repeat(100));
  assert(long > 16 * 5, `long text wraps to many lines (${long})`);
  assertEquals(est("a\nb\nc"), 3 * 12 + 4, "explicit newlines");
});
