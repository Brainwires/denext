// DOM-level tests for VirtualList / useVirtualList under denext/testing's in-memory DOM, with a
// fake ResizeObserver and a tiny flow-layout simulator (the test DOM has no layout engine): the
// simulator places each rendered row at the window's margin plus the TRUE sizes of the rows
// before it, exactly as a browser lays out the flow window, so "the row did not move" and "the
// row landed at the top" are asserted against real positions, not the engine's own numbers.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { act, render, type TestElement } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { useEffect } from "../src/runtime/hooks.ts";
import { StrictMode } from "../src/runtime/strict-mode.ts";
import { VirtualList } from "../src/client/virtual/virtual-list.ts";
import { useVirtualList } from "../src/client/virtual/use-virtual-list.ts";
import type {
  UseVirtualListResult,
  VirtualListHandle,
  VirtualListProps,
} from "../src/client/virtual/types.ts";
import { type DomEl, fireEventOn, walkElements } from "../src/testing/dom.ts";

// ---- harness ---------------------------------------------------------------------------------

type Row = { id: string; text: string };
const rows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, text: `row ${from + i}` }));

/** A fake ResizeObserver: records observed elements; `fire` reports sizes like the browser. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<DomEl>();
  readonly reported = new Map<DomEl, number>();
  constructor(readonly cb: (entries: unknown[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: DomEl): void {
    this.targets.add(el);
  }
  unobserve(el: DomEl): void {
    this.targets.delete(el);
    this.reported.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
}

/** Install the fake RO for the duration of `fn`. */
async function withRO<R>(fn: () => Promise<R>): Promise<R> {
  const g = globalThis as { ResizeObserver?: unknown };
  const prev = g.ResizeObserver;
  FakeResizeObserver.instances = [];
  // A fresh class per install: the list shares one observer per ResizeObserver constructor.
  g.ResizeObserver = class extends FakeResizeObserver {};
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.ResizeObserver;
    else g.ResizeObserver = prev;
  }
}

/** Report the true size of every observed row whose size changed (like the browser); repeat. */
async function measureAll(truth: (index: number) => number, rounds = 12): Promise<void> {
  const ro = FakeResizeObserver.instances[FakeResizeObserver.instances.length - 1];
  for (let round = 0; round < rounds; round++) {
    const entries: unknown[] = [];
    for (const el of ro.targets) {
      const idx = el.getAttribute("data-index");
      if (idx === null) continue;
      const size = truth(Number(idx));
      if (ro.reported.get(el) === size) continue;
      ro.reported.set(el, size);
      entries.push({ target: el, borderBoxSize: [{ blockSize: size, inlineSize: size }] });
    }
    if (entries.length === 0) return;
    await act(() => ro.cb(entries));
  }
}

const scrollerOf = (screen: { container: TestElement }): DomEl =>
  screen.container.children[0] as DomEl;
const listOf = (screen: { container: TestElement }): DomEl =>
  walkElements(screen.container as DomEl).find((e) => e.getAttribute("role") === "list")!;
const renderedRows = (screen: { container: TestElement }): DomEl[] =>
  walkElements(screen.container as DomEl).filter((e) => e.getAttribute("data-vl-row") !== null);
const indices = (screen: { container: TestElement }): number[] =>
  renderedRows(screen).map((e) => Number(e.getAttribute("data-index")));

/** A CSS length out of an element's style attribute. */
function styleLength(el: DomEl, name: string): number {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?[\\d.]+)px`).exec(
    el.getAttribute("style") ?? "",
  );
  return m ? Number(m[1]) : 0;
}
const styleHas = (el: DomEl, text: string): boolean =>
  (el.getAttribute("style") ?? "").includes(text);

/**
 * The flow-layout simulator: each rendered in-flow row's top relative to the viewport, from
 * the window's margin and the rows' true sizes.
 */
function visualTops(
  screen: { container: TestElement },
  truth: (i: number) => number,
): Map<number, number> {
  const list = listOf(screen);
  const scrollTop = Number((scrollerOf(screen) as unknown as { scrollTop?: number }).scrollTop) ||
    0;
  let y = styleLength(list, "margin-top");
  const tops = new Map<number, number>();
  for (const row of list.children) {
    if (styleHas(row, "position:absolute")) continue;
    const i = Number(row.getAttribute("data-index"));
    tops.set(i, y - scrollTop);
    y += truth(i) + styleLength(row, "margin-bottom");
  }
  return tops;
}

/** A user scroll bypasses a setter spy (only the list's own writes are recorded). */
const USER_SCROLL = Symbol("userScroll");

/** Scroll the list's own scroller to `top` (as the user) and dispatch `scroll`. */
async function scrollTo(screen: { container: TestElement }, top: number): Promise<void> {
  const el = scrollerOf(screen) as unknown as {
    scrollTop: number;
    [USER_SCROLL]?: (v: number) => void;
  };
  if (el[USER_SCROLL]) el[USER_SCROLL](top);
  else el.scrollTop = top;
  await act(() => fireEventOn(scrollerOf(screen), "scroll"));
}

function list<T>(props: VirtualListProps<T>): VNode {
  return h(
    VirtualList as unknown as (p: Record<string, unknown>) => VNode,
    props as unknown as Record<string, unknown>,
  );
}

// ---- test mode, a11y, identity ------------------------------------------------------------------

Deno.test("test mode: no ResizeObserver → deterministic rows from getItemSize + viewportSize (L1, T35)", async () => {
  const screen = await render(list({
    data: rows(10_000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assertEquals(indices(screen), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "exactly one viewport of rows");
  const inner = walkElements(screen.container as DomEl).find((e) =>
    e.getAttribute("data-vl-inner") !== null
  )!;
  assertEquals(styleLength(inner, "height"), 400_000, "the inner element spans every row");
  await screen.unmount();
});

Deno.test("a11y: role list/listitem with aria-setsize / aria-posinset on every rendered row (G1, T26)", async () => {
  const screen = await render(list({
    data: rows(500),
    getItemSize: () => 50,
    viewportSize: 300,
    "aria-label": "Messages",
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const l = listOf(screen);
  assertEquals(l.getAttribute("aria-label"), "Messages");
  for (const row of renderedRows(screen)) {
    assertEquals(row.getAttribute("role"), "listitem");
    assertEquals(row.getAttribute("aria-setsize"), "500");
    assertEquals(
      row.getAttribute("aria-posinset"),
      String(Number(row.getAttribute("data-index")) + 1),
    );
  }
  await scrollTo(screen, 10_000);
  const first = renderedRows(screen)[0];
  assertEquals(
    first.getAttribute("aria-posinset"),
    String(Number(first.getAttribute("data-index")) + 1),
  );
  await screen.unmount();
});

Deno.test("identity: data changes never remount surviving rows, and unchanged rows do not re-render (A5, T4)", async () => {
  const mounts = new Map<string, number>();
  const renders = new Map<string, number>();
  function Item({ row }: { row: Row }): VNode {
    renders.set(row.id, (renders.get(row.id) ?? 0) + 1);
    useEffect(() => {
      mounts.set(row.id, (mounts.get(row.id) ?? 0) + 1);
    }, []);
    return h("span", null, row.text);
  }
  const renderItem = (r: Row) => h(Item, { row: r });
  let data = rows(100);
  const screen = await render(list({ data, getItemSize: () => 50, viewportSize: 300, renderItem }));
  const r5 = renderedRows(screen).find((e) => e.getAttribute("data-index") === "5")!;
  // Edit one row, insert one before it, filter one out: surviving keys keep their DOM + state.
  data = [
    { id: "new", text: "inserted" },
    ...data.slice(0, 3),
    { ...data[3], text: "edited" },
    ...data.slice(5),
  ];
  const renders1 = renders.get("r1")!;
  await screen.rerender(list({ data, getItemSize: () => 50, viewportSize: 300, renderItem }));
  for (const id of ["r0", "r1", "r2", "r3", "r5"]) {
    assertEquals(mounts.get(id), 1, `${id} mounted once`);
  }
  assertEquals(renders.get("r1"), renders1, "r1's props did not change: its component bailed out");
  const r5after = renderedRows(screen).find((e) => e.getAttribute("data-index") === "5");
  assert(r5after === r5 || r5after?.textContent === "row 5", "same element for r5");
  assertStringIncludes(screen.html(), "edited");
  await screen.unmount();
});

// ---- scrolling ----------------------------------------------------------------------------------

Deno.test("element scroll: the window follows scrollTop; rows outside it unmount (bounded DOM, M1)", async () => {
  const screen = await render(list({
    data: rows(100_000),
    getItemSize: () => 20,
    viewportSize: 400,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  await scrollTo(screen, 1_000_000);
  const idx = indices(screen);
  assert(idx.includes(50_000) && idx.includes(50_019), `rows at 1,000,000 px (${idx[0]}…)`);
  assert(idx.length < 150, `bounded rendered rows (${idx.length})`);
  const tops = visualTops(screen, () => 20);
  assertEquals(tops.get(50_000), 0, "row 50,000 is at the top of the viewport");
  await screen.unmount();
});

Deno.test("scaled: 1M rows × 48 px lay out a capped height and still reach the last row (H1, T30)", async () => {
  let handle: VirtualListHandle | null = null;
  const screen = await render(list({
    count: 1_000_000,
    getItem: (i: number) => i,
    getItemSize: () => 48,
    viewportSize: 800,
    ref: (x: VirtualListHandle | null) => {
      handle = x;
    },
    renderItem: (i: number) => h("span", null, `#${i}`),
  }));
  const inner = walkElements(screen.container as DomEl).find((e) =>
    e.getAttribute("data-vl-inner") !== null
  )!;
  assertEquals(styleLength(inner, "height"), 8_000_000, "physical height capped at 8M px");
  await scrollTo(screen, 8_000_000 - 800);
  assert(indices(screen).includes(999_999), "the last row renders at the physical bottom");
  await act(() => handle!.scrollToIndex(654_321));
  assertEquals(handle!.getRange().first, 654_321);
  assertEquals(visualTops(screen, () => 48).get(654_321), 0, "exact landing in the scaled space");
  await screen.unmount();
});

Deno.test("scrollToIndex lands exactly on an unmeasured variable-height row (C1, T10)", async () => {
  await withRO(async () => {
    const truth = (i: number) => 30 + ((i * 53) % 170);
    let handle: VirtualListHandle | null = null;
    const screen = await render(list({
      data: rows(3000),
      estimatedItemSize: 60,
      viewportSize: 600,
      ref: (x: VirtualListHandle | null) => {
        handle = x;
      },
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    await measureAll(truth);
    for (
      const [target, align] of [[2100, "start"], [900, "end"], [2999, "end"], [
        37,
        "center",
      ]] as const
    ) {
      await act(() => handle!.scrollToIndex(target, { align }));
      await measureAll(truth);
      const top = visualTops(screen, truth).get(target);
      assert(top !== undefined, `row ${target} rendered`);
      if (align === "start") assertEquals(Math.round(top), 0, `row ${target} at the top`);
      if (align === "end") {
        assertEquals(Math.round(top + truth(target)), 600, `row ${target} at the bottom`);
      }
      if (align === "center") {
        assertEquals(Math.round(top + truth(target) / 2), 300, `row ${target} centred`);
      }
    }
    await screen.unmount();
  });
});

Deno.test("initialScrollIndex: the first render already shows the target (C2, T11)", async () => {
  const screen = await render(list({
    data: rows(10_000),
    getItemSize: () => 30,
    viewportSize: 300,
    initialScrollIndex: 5000,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assertEquals(visualTops(screen, () => 30).get(5000), 0);
  assertEquals(
    Number((scrollerOf(screen) as unknown as { scrollTop: number }).scrollTop),
    150_000,
    "reconciled into the real scroll offset",
  );
  await screen.unmount();
});

// ---- anchoring ----------------------------------------------------------------------------------

Deno.test("prepend preserves the visible row, even with rows much taller than estimated (B1, T5)", async () => {
  await withRO(async () => {
    const tall = new Set<string>();
    const size = (r: Row) => (tall.has(r.id) ? 150 : 50);
    let data = rows(200, 1000);
    const byIndex = () => (i: number) => size(data[i]);
    const props = (d: Row[]) => ({
      data: d,
      estimatedItemSize: 50,
      viewportSize: 500,
      renderItem: (r: Row) => h("span", null, r.text),
    });
    const screen = await render(list(props(data)));
    await measureAll(byIndex());
    await scrollTo(screen, 2000); // r1040 at the top
    await measureAll(byIndex());
    const before = visualTops(screen, byIndex()).get(data.findIndex((r) => r.id === "r1040"));
    assertEquals(before, 0);
    const older = rows(50, 950);
    for (const r of older) if (Number(r.id.slice(1)) % 3 === 0) tall.add(r.id);
    data = [...older, ...data];
    await screen.rerender(list(props(data)));
    await measureAll(byIndex());
    const after = visualTops(screen, byIndex()).get(data.findIndex((r) => r.id === "r1040"));
    assertEquals(after, 0, "the same row is still at the top after the prepend");
    await screen.unmount();
  });
});

Deno.test("scrolling up into unmeasured rows never moves the visible content (A2, T2)", async () => {
  await withRO(async () => {
    const truth = (i: number) => 20 + ((i * 31) % 120);
    const screen = await render(list({
      data: rows(2000),
      estimatedItemSize: 50,
      viewportSize: 500,
      overscan: 200,
      initialScrollIndex: 1990,
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    await measureAll(truth);
    for (let step = 0; step < 15; step++) {
      const tops = visualTops(screen, truth);
      // Pick the first fully visible row as the reference.
      const [ref, top] = [...tops].find(([, t]) => t >= 0)!;
      const sc = scrollerOf(screen) as unknown as { scrollTop: number };
      await scrollTo(screen, sc.scrollTop - 300);
      await measureAll(truth);
      const after = visualTops(screen, truth).get(ref);
      assertEquals(
        Math.round(after!),
        Math.round(top + 300),
        `step ${step}: moved exactly by the scroll delta`,
      );
    }
    await screen.unmount();
  });
});

Deno.test("chat: anchor end starts at the bottom, stays pinned on append/growth, not when scrolled up (B2, B3, T6)", async () => {
  await withRO(async () => {
    const sizes = new Map<string, number>();
    let data = rows(100);
    const truth = (i: number) => sizes.get(data[i].id) ?? 40;
    const props = (d: Row[]) => ({
      data: d,
      anchor: "end" as const,
      estimatedItemSize: 40,
      viewportSize: 400,
      renderItem: (r: Row) => h("span", null, r.text),
    });
    const screen = await render(list(props(data)));
    await measureAll(truth);
    const bottomOf = (i: number) => visualTops(screen, truth).get(i)! + truth(i);
    assertEquals(bottomOf(99), 400, "last message at the bottom");
    // Append while at the bottom → still pinned.
    data = [...data, ...rows(3, 100)];
    await screen.rerender(list(props(data)));
    await measureAll(truth);
    assertEquals(bottomOf(102), 400, "pinned after append");
    // Stream-grow the last message → still pinned.
    sizes.set("r102", 260);
    await measureAll(truth);
    assertEquals(bottomOf(102), 400, "pinned while the last row grows");
    // Scroll 200 px up; append; the view does not move.
    const sc = scrollerOf(screen) as unknown as { scrollTop: number };
    await scrollTo(screen, sc.scrollTop - 200);
    const ref = visualTops(screen, truth).get(95)!;
    data = [...data, ...rows(2, 103)];
    await screen.rerender(list(props(data)));
    await measureAll(truth);
    assertEquals(visualTops(screen, truth).get(95), ref, "unmoved while scrolled up");
    await screen.unmount();
  });
});

Deno.test("chat: short content bottom-aligns via the spacer and fires onStartReached once (B2, T7)", async () => {
  let starts = 0;
  const screen = await render(list({
    data: rows(3),
    anchor: "end",
    getItemSize: () => 40,
    viewportSize: 600,
    onStartReached: () => starts++,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const spacer = (scrollerOf(screen).children[0]) as DomEl;
  assert(styleHas(spacer, "flex:1 1 auto"), "a flexible spacer pushes short content to the bottom");
  assertEquals(starts, 1);
  await screen.rerender(list({
    data: rows(3),
    anchor: "end",
    getItemSize: () => 40,
    viewportSize: 600,
    onStartReached: () => starts++,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assertEquals(starts, 1, "not again for the same data");
  await screen.unmount();
});

// ---- edges --------------------------------------------------------------------------------------

Deno.test("onEndReached: not on mount, once near the end, re-armed by new data (D1, T14)", async () => {
  let ends = 0;
  let data = rows(100);
  const props = (d: Row[]) => ({
    data: d,
    getItemSize: () => 50,
    viewportSize: 500,
    onEndReached: () => ends++,
    renderItem: (r: Row) => h("span", null, r.text),
  });
  const screen = await render(list(props(data)));
  assertEquals(ends, 0, "(a) no call on mount");
  await scrollTo(screen, 1000);
  assertEquals(ends, 0);
  await scrollTo(screen, 4300);
  assertEquals(ends, 1, "(c) near the end");
  await scrollTo(screen, 4400);
  await scrollTo(screen, 4500);
  assertEquals(ends, 1, "once per data length");
  data = [...data, ...rows(50, 100)];
  await screen.rerender(list(props(data)));
  await scrollTo(screen, 6800);
  assertEquals(ends, 2, "(d) re-armed after new data");
  await screen.unmount();
});

Deno.test("onEndReached: content shorter than the viewport fires exactly once (T14b)", async () => {
  let ends = 0;
  const screen = await render(list({
    data: rows(3),
    getItemSize: () => 50,
    viewportSize: 500,
    onEndReached: () => ends++,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assertEquals(ends, 1);
  await screen.unmount();
});

Deno.test("onRangeChange reports the visible rows", async () => {
  const seen: [number, number][] = [];
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 25,
    viewportSize: 250,
    onRangeChange: (a: number, b: number) => seen.push([a, b]),
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assertEquals(seen[0], [0, 9]);
  await scrollTo(screen, 500);
  assertEquals(seen[seen.length - 1], [20, 29]);
  await screen.unmount();
});

// ---- iOS momentum path ------------------------------------------------------------------------

/** Spy on the scroller's `scrollTop` setter. */
function spyScrollTop(el: DomEl): { writes: number[] } {
  const spy = { writes: [] as number[] };
  let value = Number((el as unknown as { scrollTop?: number }).scrollTop) || 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      spy.writes.push(v);
      value = v;
    },
  });
  (el as unknown as Record<symbol, (v: number) => void>)[USER_SCROLL] = (v: number) => {
    value = v;
  };
  return spy;
}

Deno.test("iOS: no scrollTop write during a touch fling; corrections are absorbed and reconciled at scrollend (F1, T23)", async () => {
  await withRO(async () => {
    const truth = (i: number) => (i >= 50 && i < 80 ? 120 : 50);
    const screen = await render(list({
      data: rows(400),
      estimatedItemSize: 50,
      viewportSize: 500,
      overscan: 1500,
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    await measureAll(() => 50); // everything measured at the estimate first
    await scrollTo(screen, 5000); // row 100 at the top
    const sc = scrollerOf(screen);
    const spy = spyScrollTop(sc);
    await act(() => fireEventOn(sc, "touchstart", { touches: [{}] }));
    await act(() => fireEventOn(sc, "touchend", { touches: [] }));
    // Momentum: the user flings up; rows 50–79 above the viewport measure 70 px taller each.
    await scrollTo(screen, 4000);
    // What was painted: rows at their known (measured) sizes, before the new sizes arrive.
    const ref = visualTops(screen, () => 50).get(80)!;
    await measureAll(truth);
    assertEquals(spy.writes.length, 0, "no scroll write mid-fling");
    assertEquals(visualTops(screen, truth).get(80), ref, "absorbed: the visible row did not move");
    // The fling ends.
    await act(() => fireEventOn(sc, "scrollend"));
    assertEquals(spy.writes.length, 1, "one reconciling write at scrollend");
    assertEquals(visualTops(screen, truth).get(80), ref, "and still no visual move");
    await screen.unmount();
  });
});

Deno.test("iOS: without scrollend, the fling settles after a quiet period, then reconciles", async () => {
  await withRO(async () => {
    const truth = (i: number) => (i >= 50 && i < 80 ? 120 : 50);
    const screen = await render(list({
      data: rows(400),
      estimatedItemSize: 50,
      viewportSize: 500,
      overscan: 1500,
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    await measureAll(() => 50);
    await scrollTo(screen, 5000);
    const sc = scrollerOf(screen);
    const spy = spyScrollTop(sc);
    await act(() => fireEventOn(sc, "touchstart", { touches: [{}] }));
    await act(() => fireEventOn(sc, "touchend", { touches: [] }));
    await scrollTo(screen, 4000);
    // What was painted: rows at their known (measured) sizes, before the new sizes arrive.
    const ref = visualTops(screen, () => 50).get(80)!;
    await measureAll(truth);
    assertEquals(spy.writes.length, 0);
    await act(() => new Promise((r) => setTimeout(r, 320)));
    assertEquals(spy.writes.length, 1, "reconciled after the settle period");
    assertEquals(visualTops(screen, truth).get(80), ref);
    await screen.unmount();
  });
});

Deno.test("iOS: with the momentum-safe shim installed, the reconcile write is consistent too", async () => {
  // A shim-like scroller: while "flinging", writes are deferred and reads return the target
  // (what installMomentumSafeScroll does); the list must end up consistent either way.
  await withRO(async () => {
    const truth = (i: number) => (i >= 50 && i < 80 ? 120 : 50);
    const screen = await render(list({
      data: rows(400),
      estimatedItemSize: 50,
      viewportSize: 500,
      overscan: 1500,
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    await measureAll(() => 50);
    await scrollTo(screen, 5000);
    const sc = scrollerOf(screen);
    let real = 5000;
    let pending = 0;
    let shimActive = false;
    Object.defineProperty(sc, "scrollTop", {
      configurable: true,
      get: () => real + pending,
      set: (v: number) => {
        if (shimActive) pending = v - real;
        else real = v;
      },
    });
    await act(() => fireEventOn(sc, "touchstart", { touches: [{}] }));
    await act(() => fireEventOn(sc, "touchend", { touches: [] }));
    real = 4000;
    await act(() => fireEventOn(sc, "scroll"));
    // What was painted: rows at their known (measured) sizes, before the new sizes arrive.
    const ref = visualTops(screen, () => 50).get(80)!;
    await measureAll(truth);
    // The shim still considers the scroller flinging when the list reconciles at scrollend.
    shimActive = true;
    await act(() => fireEventOn(sc, "scrollend"));
    assertEquals(
      visualTops(screen, truth).get(80),
      ref,
      "consistent while the shim holds the write",
    );
    // The shim flushes: the real offset takes the pending delta.
    shimActive = false;
    real += pending;
    pending = 0;
    await act(() => fireEventOn(sc, "scroll"));
    assertEquals(visualTops(screen, truth).get(80), ref, "consistent after the shim flushes");
    await screen.unmount();
  });
});

// ---- sticky, empty, focus, keyboard ------------------------------------------------------------

Deno.test("sticky: the real header row sticks (one element, same DOM node), even when its section scrolled far (E1, T17)", async () => {
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    stickyIndices: [0, 100, 200],
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const header0 = renderedRows(screen).find((e) => e.getAttribute("data-index") === "0")!;
  assert(styleHas(header0, "position:sticky"));
  await scrollTo(screen, 150 * 40);
  const headers = renderedRows(screen).filter((e) => e.getAttribute("data-index") === "100");
  assertEquals(headers.length, 1, "exactly one element for the section header");
  assert(styleHas(headers[0], "position:sticky"));
  assert(styleLength(headers[0], "margin-bottom") === -40, "detached: takes no flow space");
  assert(
    !renderedRows(screen).some((e) => e.getAttribute("data-index") === "0"),
    "older header gone",
  );
  await scrollTo(screen, 0);
  const again = renderedRows(screen).find((e) => e.getAttribute("data-index") === "0")!;
  assert(again !== undefined);
  await screen.unmount();
});

Deno.test("empty: ListEmptyComponent fills the viewport (E7, T20)", async () => {
  const screen = await render(list({
    data: [] as Row[],
    ListEmptyComponent: () => h("p", null, "Nothing here"),
    ListHeaderComponent: h("h2", null, "Inbox"),
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const empty = walkElements(screen.container as DomEl).find((e) =>
    e.getAttribute("data-vl-empty") !== null
  )!;
  assert(styleHas(empty, "flex:1 1 auto"), "grows to fill the scroller");
  assertStringIncludes(screen.html(), "Nothing here");
  assertStringIncludes(screen.html(), "Inbox");
  assert(styleHas(scrollerOf(screen), "display:flex"));
  await screen.unmount();
});

Deno.test("focus: the focused row stays mounted while scrolled far away (G3, T26)", async () => {
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    renderItem: (r: Row) => h("input", { value: r.text }),
  }));
  const row3 = renderedRows(screen).find((e) => e.getAttribute("data-index") === "3")!;
  await act(() => fireEventOn(row3.children[0], "focusin"));
  await scrollTo(screen, 30_000);
  const kept = renderedRows(screen).find((e) => e.getAttribute("data-index") === "3");
  assert(kept === row3, "the same element, still mounted");
  assert(styleHas(kept!, "position:absolute"), "outside the flow window");
  await act(() => fireEventOn(row3.children[0], "focusout", { relatedTarget: null }));
  await scrollTo(screen, 30_040);
  await scrollTo(screen, 60_000);
  assert(
    !renderedRows(screen).some((e) => e.getAttribute("data-index") === "3"),
    "released after blur",
  );
  await screen.unmount();
});

Deno.test("keyboard: arrows / End / Home move a roving tabindex into rows not rendered yet (G2, T26)", async () => {
  const screen = await render(list({
    data: rows(10_000),
    getItemSize: () => 40,
    viewportSize: 400,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const rowAt = (i: number) =>
    renderedRows(screen).find((e) => e.getAttribute("data-index") === String(i));
  assertEquals(rowAt(0)!.getAttribute("tabIndex") ?? rowAt(0)!.getAttribute("tabindex"), "0");
  await screen.fireEvent.keyDown(rowAt(0)!, { key: "ArrowDown" });
  assertEquals(rowAt(1)!.getAttribute("tabIndex") ?? rowAt(1)!.getAttribute("tabindex"), "0");
  await screen.fireEvent.keyDown(rowAt(1)!, { key: "End" });
  const last = rowAt(9999);
  assert(last, "the last row is rendered (scrolled into view)");
  assertEquals(last.getAttribute("tabIndex") ?? last.getAttribute("tabindex"), "0");
  assertEquals(visualTops(screen, () => 40).get(9999)! + 40, 400, "and fully visible");
  await screen.fireEvent.keyDown(last, { key: "Home" });
  assert(rowAt(0), "back at the first row");
  await screen.unmount();
});

// ---- find-in-page -------------------------------------------------------------------------------

Deno.test("find-in-page: feature-detected no-op here; with support, hidden=until-found stubs + beforematch (G4, T27)", async () => {
  const props = {
    data: rows(5000),
    getItemSize: () => 40,
    viewportSize: 400,
    findInPage: true,
    estimateText: { font: "14px sans", lineHeight: 20, text: (r: Row) => r.text },
    renderItem: (r: Row) => h("span", null, r.text),
  };
  const plain = await render(list(props));
  assertEquals(plain.html().includes("until-found"), false, "unsupported → no stubs");
  await plain.unmount();

  const g = globalThis as { HTMLElement?: unknown; document?: unknown };
  const had = { HTMLElement: g.HTMLElement, document: g.document };
  g.HTMLElement = class {
    onbeforematch = null;
  };
  (g.HTMLElement as { prototype: Record<string, unknown> }).prototype.onbeforematch = null;
  g.document = {};
  try {
    const screen = await render(list(props));
    const stubs = walkElements(screen.container as DomEl).filter((e) =>
      e.getAttribute("hidden") === "until-found"
    );
    assert(stubs.length > 100, `stubs for off-window rows (${stubs.length})`);
    const stub = stubs.find((e) => e.textContent === "row 1500")!;
    assert(stub, "a far row is findable");
    await act(() => fireEventOn(stub, "beforematch"));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    assert(indices(screen).includes(1500), "the matched row is rendered and scrolled to");
    await screen.unmount();
  } finally {
    if (had.HTMLElement === undefined) delete g.HTMLElement;
    else g.HTMLElement = had.HTMLElement;
    if (had.document === undefined) delete g.document;
    else g.document = had.document;
  }
});

// ---- scroll parents, horizontal, recycling --------------------------------------------------------

Deno.test("window scroll: the page scrolls the list (E8, T21)", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    innerHeight: g.innerHeight,
    scrollY: g.scrollY,
    scrollTo: g.scrollTo,
    document: g.document,
  };
  g.innerHeight = 500;
  g.scrollY = 0;
  g.document = { documentElement: { scrollHeight: 0 } };
  const writes: number[] = [];
  g.scrollTo = (o: { top: number }) => {
    writes.push(o.top);
    g.scrollY = o.top;
  };
  try {
    const screen = await render(list({
      data: rows(10_000),
      getItemSize: () => 50,
      scrollElement: "window",
      renderItem: (r: Row) => h("span", null, r.text),
    }));
    assert(!styleHas(scrollerOf(screen), "overflow-y"), "the list does not scroll itself");
    g.scrollY = 25_000;
    await act(() => globalThis.dispatchEvent(new Event("scroll")));
    assert(indices(screen).includes(500), "rows at the window offset render");
    await screen.unmount();
  } finally {
    Object.assign(g, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete g[k];
  }
});

Deno.test("custom scroll parent: an ancestor element (or ref) scrolls the list (E8, E9, T22)", async () => {
  const screen0 = await render(h("div", null));
  const parent = screen0.container as unknown as DomEl & {
    scrollTop: number;
    clientHeight: number;
  };
  parent.clientHeight = 300;
  parent.scrollTop = 0;
  const screen = await render(list({
    data: rows(5000),
    getItemSize: () => 30,
    scrollElement: { current: parent as unknown as Element },
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  assert(indices(screen).length < 60, "virtualized against the parent's viewport");
  parent.scrollTop = 30 * 2000;
  await act(() => fireEventOn(parent, "scroll"));
  assert(indices(screen).includes(2000), "follows the parent's scroll");
  await screen.unmount();
  await screen0.unmount();
});

Deno.test("horizontal: scrollLeft drives the range and the window offset is a left margin (E4)", async () => {
  const screen = await render(list({
    data: rows(1000),
    horizontal: true,
    getItemSize: () => 100,
    viewportSize: 500,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const sc = scrollerOf(screen) as unknown as { scrollLeft: number };
  sc.scrollLeft = 20_000;
  await act(() => fireEventOn(scrollerOf(screen), "scroll"));
  assert(indices(screen).includes(200));
  const l = listOf(screen);
  assert(styleLength(l, "margin-left") > 0 && styleHas(l, "flex-direction:row"));
  await screen.unmount();
});

Deno.test("recycle (opt-in): scrolled-in rows reuse cells of the same type instead of new elements (A8)", async () => {
  const screen = await render(list({
    data: rows(1000),
    recycle: true,
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const before = new Set(renderedRows(screen));
  await scrollTo(screen, 40 * 5);
  const after = renderedRows(screen);
  const reused = after.filter((e) => before.has(e)).length;
  assertEquals(reused, after.length, "every row element is an existing cell");
  assertStringIncludes(screen.html(), "row 14");
  await screen.unmount();
});

Deno.test("recycle defaults off: a scrolled-in row is a fresh element", async () => {
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const before = new Set(renderedRows(screen));
  await scrollTo(screen, 40 * 5);
  const fresh = renderedRows(screen).filter((e) => !before.has(e));
  assertEquals(fresh.length, 5);
  await screen.unmount();
});

// ---- React semantics ----------------------------------------------------------------------------

Deno.test("StrictMode: double-mounted effects leave one set of listeners and a working list (A7, T31)", async () => {
  let ranges = 0;
  const screen = await render(h(
    StrictMode,
    null,
    list({
      data: rows(1000),
      getItemSize: () => 20,
      viewportSize: 200,
      onRangeChange: () => ranges++,
      renderItem: (r: Row) => h("span", null, r.text),
    }),
  ));
  const base = ranges;
  await scrollTo(screen, 2000);
  assertEquals(ranges, base + 1, "one range change per scroll (listeners not duplicated)");
  assert(indices(screen).includes(100));
  await screen.unmount();
});

Deno.test("react compat alias: a component written against `react` renders the list", async () => {
  const React = await import("../src/compat/react.ts");
  function App(): VNode {
    const [n, setN] = React.useState(3);
    return React.createElement(
      "div",
      null,
      React.createElement("button", { onClick: () => setN(n + 1) }, "add"),
      React.createElement(VirtualList as never, {
        data: rows(n),
        getItemSize: () => 20,
        viewportSize: 200,
        renderItem: (r: Row) => React.createElement("span", null, r.text),
      }),
    );
  }
  const screen = await render(h(App, null));
  assertEquals(indices(screen), [0, 1, 2]);
  await screen.fireEvent.click(screen.getByRole("button"));
  assertEquals(indices(screen), [0, 1, 2, 3]);
  await screen.unmount();
});

Deno.test("onBlankArea is development-only", async () => {
  const seen: unknown[] = [];
  const props = {
    data: rows(10_000),
    getItemSize: () => 20,
    viewportSize: 200,
    overscan: 0,
    onBlankArea: (b: unknown) => seen.push(b),
    renderItem: (r: Row) => h("span", null, r.text),
  };
  const prod = await render(list(props));
  await scrollTo(prod, 50_000);
  assertEquals(seen.length, 0, "never in production");
  await prod.unmount();
  (globalThis as { __denextDev?: boolean }).__denextDev = true;
  try {
    const dev = await render(list(props));
    await scrollTo(dev, 50_000);
    assert(seen.length > 0, "reported in development when a jump outruns the window");
    await dev.unmount();
  } finally {
    delete (globalThis as { __denextDev?: boolean }).__denextDev;
  }
});

// ---- useVirtualList ---------------------------------------------------------------------------

Deno.test("useVirtualList: positioned items + measureRef for a custom layout (I4)", async () => {
  let last: UseVirtualListResult | null = null;
  function Grid(): VNode {
    const v = useVirtualList({
      count: 10_000,
      getItem: (i: number) => i,
      getItemSize: () => 30,
      viewportSize: 300,
    });
    last = v;
    return h(
      "div",
      { ...v.scrollProps },
      h(
        "div",
        { ...v.innerProps },
        v.items.map((it) =>
          h("div", {
            key: it.key,
            ref: it.measureRef,
            "data-index": String(it.index),
            style: { position: "absolute", top: `${it.offset}px` },
          }, `cell ${it.index}`)
        ),
      ),
    );
  }
  const screen = await render(h(Grid, null));
  const r = last as unknown as UseVirtualListResult;
  assertEquals(r.totalSize, 300_000);
  assertEquals(r.items[0].offset, 0);
  assertEquals(r.items[3].offset, 90);
  assert(r.items.length >= 10 && r.items.length < 40);
  const ref0 = r.items[0].measureRef;
  const sc = screen.container.children[0] as unknown as DomEl & { scrollTop: number };
  sc.scrollTop = 30 * 5000;
  await act(() => fireEventOn(sc, "scroll"));
  const r2 = last as unknown as UseVirtualListResult;
  assert(r2.items.some((it) => it.index === 5000 && it.offset === 150_000));
  assert(r2.handle.getRange().first === 5000);
  assert(typeof ref0 === "function");
  await screen.unmount();
});

Deno.test("header, footer and separators render around the rows; separators re-render on append (E11)", async () => {
  const props = (n: number) => ({
    data: rows(n),
    getItemSize: () => 30,
    viewportSize: 600,
    ListHeaderComponent: () => h("header", null, "HEAD"),
    ListFooterComponent: h("footer", null, "FOOT"),
    ItemSeparatorComponent: () => h("hr", null),
    renderItem: (r: Row) => h("span", null, r.text),
  });
  const screen = await render(list(props(3)));
  const html = screen.html();
  assert(
    html.indexOf("HEAD") < html.indexOf("row 0") && html.indexOf("row 2") < html.indexOf("FOOT"),
  );
  const hrs = () =>
    walkElements(screen.container as DomEl).filter((e) => e.tagName === "HR").length;
  assertEquals(hrs(), 2, "between rows only");
  await screen.rerender(list(props(4)));
  assertEquals(hrs(), 3, "the previous last row gained its separator (FlashList #633)");
  await screen.unmount();
});

Deno.test("useVirtualList: measured sizes re-position the items (absolute layout)", async () => {
  await withRO(async () => {
    let last: UseVirtualListResult | null = null;
    function Rows(): VNode {
      const v = useVirtualList({
        count: 100,
        getItem: (i: number) => i,
        estimatedItemSize: 50,
        viewportSize: 300,
      });
      last = v;
      return h(
        "div",
        { ...v.scrollProps },
        h(
          "div",
          { ...v.innerProps },
          v.items.map((it) =>
            h(
              "div",
              { key: it.key, ref: it.measureRef, "data-index": String(it.index) },
              `row ${it.index}`,
            )
          ),
        ),
      );
    }
    const screen = await render(h(Rows, null));
    await measureAll((i) => (i === 0 ? 120 : 50));
    const r = last as unknown as UseVirtualListResult;
    assertEquals(r.items[1].offset, 120, "row 1 moved below the measured row 0");
    assertEquals(r.totalSize, 120 + 99 * 50);
    await screen.unmount();
  });
});

Deno.test("handle: scrollToOffset / scrollToEnd / isAtEnd / getRange", async () => {
  let handle: VirtualListHandle | null = null;
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 20,
    viewportSize: 200,
    ListFooterComponent: h("footer", null, "end"),
    ref: (x: VirtualListHandle | null) => {
      handle = x;
    },
    renderItem: (r: Row) => h("span", null, r.text),
  }));
  const h0 = handle as unknown as VirtualListHandle;
  assertEquals(h0.isAtEnd(), false);
  await act(() => h0.scrollToOffset(4000));
  assertEquals(h0.getRange(), { first: 200, last: 209 });
  assertEquals(Number((scrollerOf(screen) as unknown as { scrollTop: number }).scrollTop), 4000);
  await act(() => h0.scrollToEnd());
  assert(h0.isAtEnd(), "at the end after scrollToEnd");
  assert(indices(screen).includes(999));
  await screen.unmount();
});

Deno.test("iOS: with the REAL installMomentumSafeScroll shim (forced), deferral and flush stay consistent", async () => {
  const { installMomentumSafeScroll } = await import("../src/mobile/momentum.ts");
  const { DomEl } = await import("../src/testing/dom.ts");
  // Give the test DOM's elements the scroll members the shim patches, and a document.
  const pos = new WeakMap<object, { top: number; left: number }>();
  const at = (el: object) => {
    let p = pos.get(el);
    if (!p) pos.set(el, p = { top: 0, left: 0 });
    return p;
  };
  const proto = DomEl.prototype as unknown as Record<string, unknown>;
  const scrollToImpl = function (this: object, a?: { top?: number; left?: number }) {
    if (a && typeof a === "object") {
      if (a.top !== undefined) at(this).top = a.top;
      if (a.left !== undefined) at(this).left = a.left;
    }
  };
  Object.defineProperties(proto, {
    scrollTop: {
      configurable: true,
      get(this: object) {
        return at(this).top;
      },
      set(this: object, v: number) {
        at(this).top = Number(v);
      },
    },
    scrollLeft: {
      configurable: true,
      get(this: object) {
        return at(this).left;
      },
      set(this: object, v: number) {
        at(this).left = Number(v);
      },
    },
    scrollBy: {
      configurable: true,
      writable: true,
      value(this: object, a: { top?: number; left?: number }) {
        at(this).top += a.top ?? 0;
        at(this).left += a.left ?? 0;
      },
    },
    scrollTo: { configurable: true, writable: true, value: scrollToImpl },
    scroll: { configurable: true, writable: true, value: scrollToImpl },
  });
  const docListeners = new Map<string, Set<(e: unknown) => void>>();
  const fakeDoc = {
    scrollingElement: null,
    documentElement: null,
    body: null,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      docListeners.get(type)?.delete(fn);
    },
  };
  const g = globalThis as Record<string, unknown>;
  const saved = { Element: g.Element, document: g.document };
  g.Element = DomEl;
  g.document = fakeDoc;
  // Document capture listeners (the shim's) run before the target's (the list's).
  const fire = (el: DomEl, type: string, init: Record<string, unknown> = {}) =>
    act(() => {
      for (const fn of docListeners.get(type) ?? []) fn({ type, target: el, ...init });
      fireEventOn(el, type, init);
    });
  // The shim settles after 1 s: the list (250 ms) reconciles while the shim still defers.
  const uninstall = installMomentumSafeScroll({ force: true, settleMs: 1000 });
  try {
    await withRO(async () => {
      const truth = (i: number) => (i >= 50 && i < 80 ? 120 : 50);
      const screen = await render(list({
        data: rows(400),
        estimatedItemSize: 50,
        viewportSize: 500,
        overscan: 1500,
        renderItem: (r: Row) => h("span", null, r.text),
      }));
      await measureAll(() => 50);
      const sc = scrollerOf(screen);
      const el = sc as unknown as { scrollTop: number };
      el.scrollTop = 5000;
      await fire(sc, "scroll");
      await fire(sc, "touchstart", { touches: [{}] });
      at(sc).top = 4800; // the finger drags (the shim now tracks this scroller)
      await fire(sc, "scroll");
      await fire(sc, "touchend", { touches: [] });
      at(sc).top = 4000; // momentum
      await fire(sc, "scroll");
      const ref = visualTops(screen, () => 50).get(80)!;
      await measureAll(truth);
      assertEquals(at(sc).top, 4000, "no real scroll write mid-fling");
      assertEquals(visualTops(screen, truth).get(80), ref, "absorbed during the fling");
      // The list settles first (no scrollend here): its write is deferred by the shim.
      await act(() => new Promise((r) => setTimeout(r, 320)));
      assertEquals(at(sc).top, 4000, "the shim held the list's reconciling write");
      const held = el.scrollTop; // the shim's getter: real + pending
      assert(held > 4000, `a correction is pending (${held})`);
      assertEquals(
        visualTops(screen, truth).get(80),
        ref,
        "consistent while held (getter reads the target)",
      );
      // The shim settles and applies it for real.
      await act(() => new Promise((r) => setTimeout(r, 1000)));
      assertEquals(at(sc).top, held, "the shim applied exactly the list's reconcile");
      assertEquals(visualTops(screen, truth).get(80), ref, "still no visual move");
      await screen.unmount();
    });
  } finally {
    uninstall();
    for (const k of ["scrollTop", "scrollLeft", "scrollBy", "scrollTo", "scroll"]) delete proto[k];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  }
});
