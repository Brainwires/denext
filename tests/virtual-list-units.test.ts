// Unit tests for the VirtualList feature modules that need no DOM: viewability (React Native's
// rules and tracker), the scroll-event session (drag / momentum lifecycle), the restoration
// snapshot store, the masonry layout, and the reorder index math.

import { assert, assertEquals } from "@std/assert";
import {
  isViewable,
  ViewabilityTracker,
  viewableIndices,
  type ViewableItemsChanged,
} from "../src/client/virtual/viewability.ts";
import { scrollEvent, ScrollSession } from "../src/client/virtual/scroll-events.ts";
import { historyEntryId, loadSnapshot, saveSnapshot } from "../src/client/virtual/restore.ts";
import { MasonryLayout } from "../src/client/virtual/masonry.ts";
import { finalIndex } from "../src/client/virtual/reorder.ts";
import { VirtualCore } from "../src/client/virtual/core.ts";
import { withTempGlobals } from "./helpers/virtual-list.ts";

// ---- viewability ---------------------------------------------------------------------------

Deno.test("viewability: RN rules — fully visible always, partial by item % or viewport % (D2)", () => {
  // Fully visible counts under any threshold.
  assert(isViewable({ itemVisiblePercentThreshold: 100 }, 10, 50, 400));
  // 30 of 60 px visible = 50 %.
  assert(isViewable({ itemVisiblePercentThreshold: 50 }, -30, 60, 400));
  assert(!isViewable({ itemVisiblePercentThreshold: 51 }, -30, 60, 400));
  // A 1000 px row covering the whole 400 px viewport: 100 % of the viewport, 40 % of the row.
  assert(isViewable({ viewAreaCoveragePercentThreshold: 100 }, -300, 1000, 400));
  assert(!isViewable({ itemVisiblePercentThreshold: 50 }, -300, 1000, 400));
  // No threshold: any visible pixel; none: not viewable.
  assert(isViewable({}, 399, 50, 400));
  assert(!isViewable({}, 400, 50, 400));
  assert(!isViewable({}, -50, 50, 400));
  assertEquals(
    viewableIndices({ itemVisiblePercentThreshold: 50 }, [
      { index: 2, top: 380, size: 40 },
      { index: 0, top: -10, size: 40 },
      { index: 1, top: 30, size: 350 },
    ], 400),
    [0, 1, 2],
  );
});

function host() {
  const timers: { fn: () => void; ms: number }[] = [];
  return {
    timers,
    host: {
      itemAt: (i: number) => ({ n: i }),
      keyAt: (i: number) => `k${i}`,
      setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
      clearTimeout: () => {},
    },
  };
}

Deno.test("viewability: tracker reports viewable + changed tokens with RN's shape; nothing when unchanged", () => {
  const { host: hh } = host();
  const t = new ViewabilityTracker<{ n: number }>(hh);
  const seen: ViewableItemsChanged<{ n: number }>[] = [];
  const rowsAt = (first: number) =>
    Array.from({ length: 5 }, (_, k) => ({ index: first + k, top: k * 100, size: 100 }));
  t.update({}, rowsAt(0), 400, (i) => seen.push(i));
  assertEquals(seen.length, 1);
  assertEquals(seen[0].viewableItems.map((v) => v.index), [0, 1, 2, 3]);
  assertEquals(seen[0].changed[0], { item: { n: 0 }, key: "k0", index: 0, isViewable: true });
  t.update({}, rowsAt(0), 400, (i) => seen.push(i));
  assertEquals(seen.length, 1, "no call when the viewable set is unchanged");
  t.update({}, rowsAt(2), 400, (i) => seen.push(i));
  assertEquals(seen.length, 2);
  assertEquals(
    seen[1].changed.map((c) => [c.index, c.isViewable]),
    [[0, false], [1, false], [4, true], [5, true]],
  );
});

Deno.test("viewability: waitForInteraction holds reports until interact(); minimumViewTime reports rows still viewable", () => {
  const { host: hh, timers } = host();
  const t = new ViewabilityTracker<{ n: number }>(hh);
  const seen: ViewableItemsChanged<{ n: number }>[] = [];
  const rows = [{ index: 0, top: 0, size: 100 }, { index: 1, top: 100, size: 100 }];
  t.update({ waitForInteraction: true }, rows, 400, (i) => seen.push(i));
  assertEquals(seen.length, 0, "nothing before an interaction");
  t.interact();
  t.update({ waitForInteraction: true }, rows, 400, (i) => seen.push(i));
  assertEquals(seen.length, 1);

  const t2 = new ViewabilityTracker<{ n: number }>(hh);
  const seen2: ViewableItemsChanged<{ n: number }>[] = [];
  t2.update(
    { minimumViewTime: 250 },
    rows,
    400,
    (i) => seen2.push(i),
    () => ({ rows: [rows[1]], vp: 400 }), // by then row 0 scrolled away
  );
  assertEquals(seen2.length, 0, "deferred");
  assertEquals(timers[timers.length - 1].ms, 250);
  timers[timers.length - 1].fn();
  assertEquals(seen2[0].viewableItems.map((v) => v.index), [1], "only rows viewable throughout");
});

// ---- scroll events ---------------------------------------------------------------------------

Deno.test("scroll events: touch drag → end drag → momentum begin/end; non-touch → momentum once (C4, T13)", () => {
  const s = new ScrollSession();
  s.touchStart();
  assertEquals(s.scroll(0, 0), { beginDrag: true, momentumBegin: false, scroll: true });
  assertEquals(s.scroll(16, 0), { beginDrag: false, momentumBegin: false, scroll: true });
  assertEquals(s.touchEnd(), { endDrag: true });
  assertEquals(s.scroll(32, 0).momentumBegin, true, "the fling's first frame");
  assertEquals(s.settle().momentumEnd, true);
  assertEquals(s.settle().momentumEnd, false, "once");
  // A tap: no drag, no momentum.
  s.touchStart();
  assertEquals(s.touchEnd(), { endDrag: false });
  assertEquals(s.settle().momentumEnd, false);
  // Wheel / programmatic.
  assertEquals(s.scroll(100, 0).momentumBegin, true);
  assertEquals(s.scroll(116, 0).momentumBegin, false);
  assertEquals(s.settle().momentumEnd, true);
});

Deno.test("scroll events: scrollEventThrottle limits onScroll and a trailing call delivers the last offset", () => {
  const s = new ScrollSession();
  const fired = [0, 10, 20, 30, 40, 50, 60].map((t) => s.scroll(t, 50).scroll);
  assertEquals(fired, [true, false, false, false, false, true, false]);
  assertEquals(s.settle().trailing, true);
  const e = scrollEvent(false, 120, 5000, 400, 320, true);
  assertEquals(e.nativeEvent.contentOffset, { x: 0, y: 120 });
  assertEquals(e.nativeEvent.contentSize, { width: 320, height: 5000 });
  assertEquals(e.nativeEvent.layoutMeasurement, { width: 320, height: 400 });
  assertEquals(e.programmatic, true);
  assertEquals(scrollEvent(true, 7, 900, 300, 50, false).nativeEvent.contentOffset, { x: 7, y: 0 });
});

// ---- restoration store -------------------------------------------------------------------------

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

Deno.test("restore: the entry id lives in history.state (merged), snapshots round-trip per entry + key (C3)", async () => {
  let state: unknown = { router: 1 };
  const history = {
    get state() {
      return state;
    },
    replaceState: (s: unknown) => void (state = s),
  };
  await withTempGlobals({ history, sessionStorage: fakeStorage() }, () => {
    const id = historyEntryId()!;
    assert(id, "created");
    assertEquals((state as Record<string, unknown>).router, 1, "the router's state is kept");
    assertEquals(historyEntryId(), id, "stable for the entry");
    saveSnapshot(id, "feed", { key: "r5", index: 5, gap: -12, sizes: [["r5", 40]], atEnd: false });
    assertEquals(loadSnapshot(id, "feed")?.key, "r5");
    assertEquals(loadSnapshot(id, "other"), undefined);
    state = {}; // a new navigation pushes a fresh entry
    const next = historyEntryId()!;
    assert(next !== id);
    assertEquals(loadSnapshot(next, "feed"), undefined, "a fresh entry starts fresh");
    return Promise.resolve();
  });
});

Deno.test("restore: SSR-safe — no history / storage is a no-op", () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: undefined, configurable: true });
  try {
    assertEquals(historyEntryId(), undefined, "no history (the server)");
    saveSnapshot("x", "y", { key: "a", index: 0, gap: 0, sizes: [], atEnd: false });
    assertEquals(loadSnapshot("x", "y"), undefined);
  } finally {
    if (desc) Object.defineProperty(globalThis, "sessionStorage", desc);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

Deno.test("core.anchor: the anchored row and its distance from the viewport", () => {
  const core = new VirtualCore({ defaultSize: 50 });
  core.setMetrics(400, 0, 0);
  core.setSource({ count: 1000, keyAt: (i) => i, token: 1 });
  core.scroll(1020, 0);
  const a = core.anchor()!;
  assertEquals(a.index, 21, "first fully visible row");
  assertEquals(a.gap, 21 * 50 - 1020);
});

// ---- masonry ------------------------------------------------------------------------------------

Deno.test("masonry: shortest-column placement, balanced within one item, appends land in the shortest column (E3, T18)", () => {
  const sizes = (i: number) => 100 + ((i * 37) % 120);
  const m = new MasonryLayout(3, 8);
  m.append(1000, sizes);
  const heights = m.columnHeights();
  const spread = Math.max(...heights) - Math.min(...heights);
  assert(spread <= 220, `columns balanced within one item (${heights})`);
  const shortest = heights.indexOf(Math.min(...heights));
  m.append(1001, () => 150);
  assertEquals(m.placement(1000).column, shortest, "the new item goes to the shortest column");
  assertEquals(m.placement(1000).top, heights[shortest] + 8, "gap exact");
  // Visible query equals a brute-force scan.
  const brute = (from: number, to: number) => {
    const out: number[] = [];
    for (let i = 0; i < m.count; i++) {
      const p = m.placement(i);
      if (p.top < to && p.top + p.size > from) out.push(i);
    }
    return out;
  };
  for (const [a, b] of [[0, 800], [20_000, 20_600], [m.height - 500, m.height + 10]]) {
    assertEquals(m.visible(a, b), brute(a, b));
  }
});

Deno.test("masonry: a size change moves only the items below it in its column; columns never reshuffle", () => {
  const m = new MasonryLayout(2, 0);
  m.append(10, () => 100);
  const before = Array.from({ length: 10 }, (_, i) => m.placement(i));
  const c = before[2].column;
  assertEquals(m.setSize(2, 160), 60);
  for (let i = 0; i < 10; i++) {
    const now = m.placement(i);
    assertEquals(now.column, before[i].column, "same column");
    const below = now.column === c && before[i].top > before[2].top;
    assertEquals(now.top, before[i].top + (below ? 60 : 0), `item ${i}`);
  }
  m.rebuild(10, () => 50, 3);
  assertEquals(m.columns, 3);
  assertEquals(m.height, 200, "10 items of 50 px in 3 columns: 4 rows tall");
});

// ---- reorder ------------------------------------------------------------------------------------

Deno.test("reorder: a drop slot maps to splice semantics (K2)", () => {
  assertEquals(finalIndex(2, 0), 0, "before the first");
  assertEquals(finalIndex(2, 2), 2, "its own slot: no move");
  assertEquals(finalIndex(2, 3), 2, "just after itself: no move");
  assertEquals(finalIndex(2, 6), 5, "later slots shift down by one");
});
