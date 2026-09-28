// DOM-level tests for VirtualList's opt-in features under denext/testing's in-memory DOM:
// viewability, sticky-header push, scroll restoration, grids (+ keyboard), the table recipe,
// content-container / header / footer styles, keyboard insets, refreshControl, layout
// animations, keepMounted, selection + print, RN scroll events, progressive rendering,
// typeahead + announcements, the window-scroll rect cache, and VirtualMasonry.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { useVirtualList } from "../src/client/virtual/use-virtual-list.ts";
import { useVirtualReorder, type VirtualReorder } from "../src/client/virtual/reorder.ts";
import { useRef } from "../src/runtime/hooks.ts";
import { VirtualMasonry } from "../src/client/virtual/virtual-masonry.ts";
import type { VirtualMasonryHandle } from "../src/client/virtual/virtual-masonry.ts";
import { RefreshControl } from "../src/mobile/refresh-control.ts";
import type {
  UseVirtualListResult,
  ViewableItemsChanged,
  VirtualListHandle,
  VirtualListScrollEvent,
} from "../src/client/virtual/types.ts";
import { DomEl, fireEventOn } from "../src/testing/dom.ts";
import { flushSync } from "../src/client/reconciler.ts";
import { type Any, mount, settle } from "./helpers/mobile-fakes.ts";
import {
  all,
  indices,
  list,
  measureAll,
  type Row,
  rowAt,
  rows,
  scrollerOf,
  scrollTo,
  styleHas,
  styleLength,
  visualTops,
  wait,
  withRO,
  withTempGlobals,
} from "./helpers/virtual-list.ts";

const text = (r: Row) => h("span", null, r.text);

// ---- viewability (D2, T15) ---------------------------------------------------------------------

Deno.test("viewability: onViewableItemsChanged with RN tokens on mount, scroll and data change; latest callback wins (D2, T15)", async () => {
  const seen: ViewableItemsChanged<Row>[] = [];
  let data = rows(1000);
  const props = (d: Row[], cb: (i: ViewableItemsChanged<Row>) => void) => ({
    data: d,
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    onViewableItemsChanged: cb,
    renderItem: text,
  });
  const screen = await render(list(props(data, (i) => seen.push(i))));
  assertEquals(seen.at(-1)!.viewableItems.map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(seen.at(-1)!.viewableItems[0], {
    item: data[0],
    key: "r0",
    index: 0,
    isViewable: true,
  });
  await scrollTo(screen, 400);
  const change = seen.at(-1)!;
  assertEquals(change.viewableItems[0].index, 10);
  assert(change.changed.some((t) => t.index === 0 && !t.isViewable), "row 0 left");
  assert(change.changed.some((t) => t.index === 19 && t.isViewable), "row 19 entered");
  // A data change without a scroll (FlashList #614), with a NEW callback (RN #30171).
  const late: ViewableItemsChanged<Row>[] = [];
  data = [...data.slice(0, 12), ...data.slice(15)];
  await screen.rerender(list(props(data, (i) => late.push(i))));
  assertEquals(late.length, 1, "the new callback is called");
  assert(late[0].changed.some((t) => t.key === "r20" && t.isViewable), "r20 became viewable");
  await screen.unmount();
});

Deno.test("viewability: thresholds, waitForInteraction, minimumViewTime and callback pairs", async () => {
  const strict: number[][] = [];
  const loose: number[][] = [];
  const waited: number[][] = [];
  const slow: number[][] = [];
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    viewabilityConfig: { waitForInteraction: true },
    onViewableItemsChanged: (i) => waited.push(i.viewableItems.map((t) => t.index as number)),
    viewabilityConfigCallbackPairs: [
      {
        viewabilityConfig: { itemVisiblePercentThreshold: 100 },
        onViewableItemsChanged: (i) => strict.push(i.viewableItems.map((t) => t.index as number)),
      },
      {
        viewabilityConfig: {},
        onViewableItemsChanged: (i) => loose.push(i.viewableItems.map((t) => t.index as number)),
      },
      {
        viewabilityConfig: { minimumViewTime: 30 },
        onViewableItemsChanged: (i) => slow.push(i.viewableItems.map((t) => t.index as number)),
      },
    ],
    renderItem: text,
  }));
  assertEquals(waited.length, 0, "waitForInteraction: nothing before the user scrolls");
  assertEquals(slow.length, 0, "minimumViewTime: not yet");
  await wait(60);
  assertEquals(slow.at(-1)?.[0], 0, "minimumViewTime: reported after the delay");
  await scrollTo(screen, 20); // row 0 half visible, row 10 half visible
  assertEquals(waited.length, 1, "reported after the interaction");
  assertEquals(strict.at(-1)![0], 1, "100 % threshold: the half-visible row 0 is out");
  assertEquals(loose.at(-1)![0], 0, "no threshold: any visible pixel counts");
  assertEquals(loose.at(-1)!.at(-1), 10);
  await screen.unmount();
});

Deno.test("viewability: grid rows report every item of a visible line", async () => {
  let last: ViewableItemsChanged<Row> | undefined;
  const screen = await render(list({
    data: rows(100),
    numColumns: 3,
    getItemSize: () => 100,
    viewportSize: 250,
    onViewableItemsChanged: (i) => void (last = i),
    renderItem: text,
  }));
  assertEquals(last!.viewableItems.map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  await screen.unmount();
});

// ---- sticky push (E1, T17) ---------------------------------------------------------------------

Deno.test("sticky: the next header pushes the stuck one up instead of overlapping (E1, T17)", async () => {
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    stickyIndices: [0, 10, 20],
    renderItem: text,
  }));
  await scrollTo(screen, 10 * 40 - 20);
  assertEquals(styleLength(rowAt(screen, 0)!, "top"), -20, "header 0 is pushed up by 20 px");
  assertEquals(styleLength(rowAt(screen, 10)!, "top"), 0);
  await scrollTo(screen, 10 * 40 - 5);
  assertEquals(styleLength(rowAt(screen, 0)!, "top"), -35);
  await scrollTo(screen, 10 * 40 + 100);
  assert(styleHas(rowAt(screen, 10)!, "top:0"), "header 10 is the stuck one, not pushed");
  assert(rowAt(screen, 0) === undefined || styleHas(rowAt(screen, 0)!, "top:0"), "header 0 reset");
  await screen.unmount();
});

Deno.test("sticky: push works with anchor='end' (chat sections) (E1, B2)", async () => {
  const screen = await render(list({
    data: rows(100),
    anchor: "end",
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    stickyIndices: [0, 50],
    renderItem: text,
  }));
  const sc = scrollerOf(screen) as unknown as { scrollTop: number };
  assertEquals(sc.scrollTop, 100 * 40 - 400, "starts at the end");
  assert(styleHas(rowAt(screen, 50)!, "position:sticky"), "the section header sticks");
  await scrollTo(screen, 50 * 40 - 10);
  assertEquals(styleLength(rowAt(screen, 0)!, "top"), -30, "header 0 pushed by header 50");
  await scrollTo(screen, 3000);
  assertEquals(styleLength(rowAt(screen, 50)!, "top"), 0, "header 50 stuck at the top");
  await screen.unmount();
});

// ---- scroll restoration (C3, T12) ----------------------------------------------------------------

Deno.test("restoreKey: the view is saved on unmount and restored for the same history entry only (C3, T12)", async () => {
  let state: unknown = null;
  const history = {
    get state() {
      return state;
    },
    replaceState: (s: unknown) => void (state = s),
  };
  sessionStorage.clear();
  await withTempGlobals({ history }, async () => {
    const props = {
      data: rows(5000),
      getItemSize: () => 40,
      viewportSize: 400,
      restoreKey: "feed",
      renderItem: text,
    };
    const first = await render(list(props));
    await scrollTo(first, 40 * 1234 + 15);
    await first.unmount();
    // Back to the same entry: row 1234 is 15 px above the top again.
    const back = await render(list(props));
    assertEquals(visualTops(back, () => 40).get(1235), 25, "the anchor row is where it was");
    assertEquals(visualTops(back, () => 40).get(1234), -15);
    await back.unmount();
    // A new navigation (a pushed entry without our id) starts at the top.
    state = {};
    const fresh = await render(list(props));
    assertEquals(indices(fresh)[0], 0, "fresh entry: top of the list");
    await fresh.unmount();
  });
  sessionStorage.clear();
});

Deno.test("restoreKey: a chat at its end is restored pinned to the (possibly longer) end", async () => {
  let state: unknown = null;
  const history = {
    get state() {
      return state;
    },
    replaceState: (s: unknown) => void (state = s),
  };
  sessionStorage.clear();
  await withTempGlobals({ history }, async () => {
    const props = (n: number) => ({
      data: rows(n),
      anchor: "end" as const,
      getItemSize: () => 40,
      viewportSize: 400,
      restoreKey: "chat",
      renderItem: text,
    });
    const a = await render(list(props(100)));
    await a.unmount();
    const b = await render(list(props(120)));
    const tops = visualTops(b, () => 40);
    assertEquals(tops.get(119)! + 40, 400, "the new last message is at the bottom");
    await b.unmount();
  });
  sessionStorage.clear();
});

Deno.test("dev, no restoreKey: a hot update's remount and a reload restore the view; nothing else does", async () => {
  let state: unknown = null;
  const history = {
    get state() {
      return state;
    },
    replaceState: (s: unknown) => void (state = s),
  };
  const realPerf = globalThis.performance;
  let navType = "navigate";
  const performance = {
    now: () => realPerf.now(),
    getEntriesByType: (t: string) => t === "navigation" ? [{ type: navType }] : [],
  };
  sessionStorage.clear();
  const props = { data: rows(5000), getItemSize: () => 40, viewportSize: 400, renderItem: text };
  const g = globalThis as { __denextHmrAt?: number; __denextVLDoc?: string };
  // Production (no `__denextDev`): a remount starts at the top.
  await withTempGlobals({ history, performance }, async () => {
    const first = await render(list(props));
    await scrollTo(first, 40 * 1234 + 15);
    await first.unmount();
    const again = await render(list(props));
    assertEquals(indices(again)[0], 0, "production: no automatic restoration");
    await again.unmount();
  });
  await withTempGlobals({
    history,
    performance,
    __denextDev: true,
    __denextHmrAt: undefined,
    __denextVLDoc: "doc-a",
  }, async () => {
    const first = await render(list(props));
    await scrollTo(first, 40 * 1234 + 15);
    // A hot update remounts the list: it lands back on row 1234, 15 px above the top.
    g.__denextHmrAt = Date.now();
    await first.unmount();
    const hot = await render(list(props));
    assertEquals(visualTops(hot, () => 40).get(1234), -15, "restored after a hot update");
    // A remount long after that update (a key change, a navigation) starts at the top.
    g.__denextHmrAt = Date.now() - 60_000;
    await hot.unmount();
    const plain = await render(list(props));
    assertEquals(indices(plain)[0], 0, "a remount no hot update caused starts fresh");
    await scrollTo(plain, 40 * 300);
    await plain.unmount(); // saved by this document (like `pagehide` before a reload)
    // A reload: a new document, loaded as a reload, restores the previous document's view.
    g.__denextVLDoc = "doc-b";
    navType = "reload";
    const reloaded = await render(list(props));
    assertEquals(visualTops(reloaded, () => 40).get(300), 0, "restored across the reload");
    await reloaded.unmount();
    // A new document reached by navigation (not a reload) starts fresh.
    g.__denextVLDoc = "doc-c";
    navType = "navigate";
    const navigated = await render(list(props));
    assertEquals(indices(navigated)[0], 0, "a navigation starts at the top");
    await navigated.unmount();
  });
  sessionStorage.clear();
});

// ---- grid (E2, T18) ------------------------------------------------------------------------------

Deno.test("grid: numColumns lines with gaps, item-level a11y and index APIs (E2, T18)", async () => {
  let handle: VirtualListHandle | null = null;
  const ranges: [number, number][] = [];
  const screen = await render(list({
    data: rows(100),
    numColumns: 3,
    gap: 8,
    getItemSize: () => 50,
    viewportSize: 400,
    overscan: 0,
    onRangeChange: (a, b) => ranges.push([a, b]),
    ref: (x: VirtualListHandle | null) => void (handle = x),
    renderItem: text,
  }));
  const inner = all(screen).find((e) => e.getAttribute("data-vl-inner") !== null)!;
  assertEquals(styleLength(inner, "height"), 33 * 58 + 50, "34 lines: 58 px each, the last 50");
  const cells = all(screen).filter((e) => e.getAttribute("data-vl-item") !== null);
  assertEquals(cells[0].getAttribute("aria-setsize"), "100");
  assertEquals(cells[4].getAttribute("aria-posinset"), "5");
  assertEquals(styleLength(rowAt(screen, 0)!, "padding-bottom"), 8, "row gap");
  const grid = rowAt(screen, 0)!.children[0];
  assert(styleHas(grid, "grid-template-columns:repeat(3, minmax(0, 1fr))"));
  assertEquals(styleLength(grid, "column-gap"), 8, "column gap");
  assertEquals(ranges[0], [0, 20], "item range of the visible lines");
  await act(() => handle!.scrollToIndex(50));
  assertEquals((scrollerOf(screen) as unknown as { scrollTop: number }).scrollTop, 16 * 58);
  assertEquals(handle!.getRange().first, 48, "item 48 starts line 16");
  await screen.unmount();
});

Deno.test("grid: keyboard moves by cell (arrows across, lines down) with a roving tabindex (G2)", async () => {
  const screen = await render(list({
    data: rows(90),
    numColumns: 3,
    getItemSize: () => 50,
    viewportSize: 400,
    renderItem: text,
  }));
  const cell = (i: number) =>
    all(screen).find((e) => e.getAttribute("data-vl-item") === String(i))!;
  const tab = (i: number) => cell(i).getAttribute("tabIndex") ?? cell(i).getAttribute("tabindex");
  assertEquals(tab(0), "0");
  await screen.fireEvent.keyDown(cell(0), { key: "ArrowRight" });
  assertEquals(tab(1), "0");
  assertEquals(tab(0), "-1");
  await screen.fireEvent.keyDown(cell(1), { key: "ArrowDown" });
  assertEquals(tab(4), "0");
  await screen.fireEvent.keyDown(cell(4), { key: "End" });
  assertEquals(tab(89), "0", "the last cell, scrolled into view");
  await screen.unmount();
});

// ---- table recipe (E10) -----------------------------------------------------------------------------

Deno.test("table recipe: useVirtualList + spacer rows keep real <table> semantics (E10)", async () => {
  let v: UseVirtualListResult | null = null;
  function Table(): VNode {
    const list = useVirtualList({
      count: 10_000,
      getItem: (i: number) => i,
      getItemSize: () => 30,
      viewportSize: 300,
      overscan: 0,
    });
    v = list;
    const first = list.items[0];
    const last = list.items[list.items.length - 1];
    const before = first ? first.offset : 0;
    const after = last ? list.totalSize - (last.offset + last.size) : 0;
    return h(
      "div",
      { ...list.scrollProps, style: { ...list.scrollProps.style, height: "300px" } },
      h(
        "table",
        { style: { tableLayout: "fixed", width: "100%", borderCollapse: "collapse" } },
        h("colgroup", null, h("col", { style: { width: "80px" } }), h("col", null)),
        h("thead", { style: { position: "sticky", top: "0" } }, h("tr", null, h("th", null, "#"))),
        h(
          "tbody",
          { ref: list.innerProps.ref },
          h("tr", { key: "before", "data-spacer": "before", style: { height: `${before}px` } }),
          list.items.map((it) =>
            h(
              "tr",
              { key: it.key, ref: it.measureRef, "data-row": String(it.index) },
              h("td", null, it.index),
            )
          ),
          h("tr", { key: "after", "data-spacer": "after", style: { height: `${after}px` } }),
        ),
      ),
    );
  }
  const screen = await render(h(Table, null));
  const spacer = (which: string) =>
    all(screen).find((e) => e.getAttribute("data-spacer") === which)!;
  const trs = () => all(screen).filter((e) => e.getAttribute("data-row") !== null);
  assertEquals(trs().length, 10);
  assertEquals(styleLength(spacer("before"), "height"), 0);
  assertEquals(styleLength(spacer("after"), "height"), 300_000 - 300);
  const sc = screen.container.children[0] as unknown as DomEl & { scrollTop: number };
  sc.scrollTop = 30 * 5000;
  await act(() => fireEventOn(sc, "scroll"));
  assertEquals(trs()[0].getAttribute("data-row"), "5000");
  assertEquals(styleLength(spacer("before"), "height"), 150_000, "the rows above are one spacer");
  assert((v as unknown as UseVirtualListResult).totalSize === 300_000);
  await screen.unmount();
});

// ---- content container / header / footer styles (I2, E7) ------------------------------------------

Deno.test("contentContainerStyle / Class and ListHeader/FooterComponentStyle are applied (I2, E7)", async () => {
  const screen = await render(list({
    data: rows(3),
    getItemSize: () => 30,
    viewportSize: 400,
    contentContainerStyle: { padding: "16px", flexGrow: 1 },
    contentContainerClass: "content",
    ListHeaderComponent: () => h("h2", null, "HEAD"),
    ListHeaderComponentStyle: { borderBottom: "1px solid" },
    ListFooterComponent: () => h("p", null, "FOOT"),
    ListFooterComponentStyle: { opacity: 0.5 },
    renderItem: text,
  }));
  const content = all(screen).find((e) => e.getAttribute("data-vl-content") !== null)!;
  assertEquals(content.getAttribute("class"), "content");
  assert(styleHas(content, "padding:16px") && styleHas(content, "flex-grow:1"));
  assert(content.parentNode === scrollerOf(screen), "the container is inside the scroller");
  const header = all(screen).find((e) => e.getAttribute("data-vl-header") !== null)!;
  assert(styleHas(header, "border-bottom:1px solid"));
  const footer = all(screen).find((e) => e.getAttribute("data-vl-footer") !== null)!;
  assert(styleHas(footer, "opacity:0.5"));
  await screen.unmount();
});

// ---- keyboard inset (B8, T9) ------------------------------------------------------------------------

Deno.test("keyboardInset: a chat at its end keeps its last message above the keyboard, in one adjustment (B8, T9)", async () => {
  const props = (inset: number) => ({
    data: rows(100),
    anchor: "end" as const,
    getItemSize: () => 40,
    viewportSize: 400,
    keyboardInset: inset,
    renderItem: text,
  });
  const screen = await render(list(props(0)));
  const bottom = () => visualTops(screen, () => 40).get(99)! + 40;
  assertEquals(bottom(), 400);
  const sc = scrollerOf(screen) as unknown as { scrollTop: number };
  const writes: number[] = [];
  let value = sc.scrollTop;
  Object.defineProperty(sc, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      writes.push(v);
      value = v;
    },
  });
  await screen.rerender(list(props(300)));
  const spacer = all(screen).find((e) => e.getAttribute("data-vl-keyboard") !== null)!;
  assertEquals(styleLength(spacer, "height"), 300);
  assertEquals(bottom(), 100, "the last message sits right above the keyboard");
  assertEquals(writes.length, 1, "one scroll adjustment (no double scroll, FlashList #2026)");
  await screen.rerender(list(props(0)));
  assertEquals(bottom(), 400, "keyboard closed: back at the bottom");
  await screen.unmount();
});

// ---- pull-to-refresh (D3, T16) -----------------------------------------------------------------------

Deno.test("refreshControl: a component gets refreshing/onRefresh/progressViewOffset and wraps the scroller (D3)", async () => {
  const got: Record<string, unknown>[] = [];
  const Control = (p: Record<string, unknown>) => {
    got.push(p);
    return h("section", { "data-rc": "", class: p.class, style: p.style }, p.children as VNode);
  };
  const onRefresh = () => {};
  const screen = await render(list({
    data: rows(10),
    getItemSize: () => 30,
    class: "feed",
    style: { height: "300px" },
    refreshControl: Control,
    refreshing: true,
    onRefresh,
    progressViewOffset: 24,
    renderItem: text,
  }));
  const wrapper = screen.container.children[0] as DomEl;
  assert(wrapper.getAttribute("data-rc") !== null, "the control is outermost");
  assertEquals(wrapper.getAttribute("class"), "feed", "the list's class moves to the control");
  assert(styleHas(wrapper, "height:300px"), "and its style");
  assert(wrapper.children[0].getAttribute("data-denext-virtual-list") !== null);
  assertEquals(got.at(-1)!.refreshing, true);
  assertEquals(got.at(-1)!.onRefresh, onRefresh);
  assertEquals(got.at(-1)!.progressViewOffset, 24);
  await screen.unmount();
});

Deno.test("refreshControl: denext/mobile's RefreshControl pulls the list's scroller (D3, T16)", async () => {
  // The spinner is SVG: this test uses the SVG-capable fake DOM of the mobile tests.
  let refreshes = 0;
  let refreshing = false;
  const { container, rerender, root } = mount(() =>
    list({
      data: rows(50),
      getItemSize: () => 30,
      viewportSize: 300,
      refreshControl: RefreshControl as never,
      refreshing,
      onRefresh: () => void refreshes++,
      renderItem: text,
    })
  );
  await new Promise((r) => setTimeout(r, 5));
  await settle();
  const wrapper = container.firstChild;
  assert(
    wrapper.getAttribute("data-denext-refresh-control") !== null,
    "the control wraps the list",
  );
  const scroller = wrapper.childNodes.find((n: Any) =>
    n.getAttribute?.("data-denext-virtual-list") !== null &&
    n.getAttribute?.("data-denext-virtual-list") !== undefined
  );
  assert(scroller, "the list's scroller is inside");
  const touch = (y: number) => ({ touches: [{ clientX: 10, clientY: y }], preventDefault() {} });
  flushSync(() => scroller.dispatch("touchstart", touch(100)));
  flushSync(() => scroller.dispatch("touchmove", touch(348)));
  flushSync(() => scroller.dispatch("touchend", { touches: [] }));
  assertEquals(refreshes, 1, "onRefresh fired once");
  refreshing = true;
  rerender();
  assertStringIncludes(wrapper.outerHTML, 'role="progressbar"', "spinner shown while refreshing");
  flushSync(() => root.unmount());
});

// ---- layout animations (K1, T33) ---------------------------------------------------------------------

Deno.test("itemLayoutAnimation: moves glide, inserts fade in, removals leave a fading ghost; off costs nothing (K1, T33)", async () => {
  const proto = DomEl.prototype as unknown as Record<string, unknown>;
  const calls: { key: string; frames: Keyframe[] }[] = [];
  let screenRef: { container: unknown } | null = null;
  proto.getBoundingClientRect = function (this: DomEl) {
    if (this.getAttribute("data-vl-inner") !== null && screenRef) {
      const st =
        Number((scrollerOf(screenRef as never) as unknown as { scrollTop?: number }).scrollTop) ||
        0;
      return { top: -st, left: 0, right: 300, bottom: 800 - st, width: 300, height: 800 };
    }
    if (this.getAttribute("data-vl-row") === null || !screenRef) {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    const tops = visualTops(screenRef as never, () => 40);
    const top = tops.get(Number(this.getAttribute("data-index"))) ?? 0;
    return { top, left: 0, right: 300, bottom: top + 40, width: 300, height: 40 };
  };
  proto.animate = function (this: DomEl, frames: Keyframe[]) {
    calls.push({ key: this.textContent, frames });
    return { finished: Promise.resolve() };
  };
  proto.cloneNode = function (this: DomEl) {
    const c = new DomEl(this.tagName);
    for (const [k, v] of this.attributes) c.setAttribute(k, v);
    (c as unknown as { style: Record<string, string> }).style = {};
    return c;
  };
  try {
    const data = rows(20);
    const base = { getItemSize: () => 40, viewportSize: 400, renderItem: text };
    const plain = await render(list({ ...base, data }));
    screenRef = plain;
    await plain.rerender(list({ ...base, data: [data[0], ...data.slice(2)] }));
    assertEquals(calls.length, 0, "off: nothing animates");
    await plain.unmount();

    const screen = await render(list({ ...base, data, itemLayoutAnimation: { duration: 100 } }));
    screenRef = screen;
    const next = [data[0], ...data.slice(2, 4), { id: "n1", text: "new" }, ...data.slice(4)];
    await screen.rerender(list({ ...base, data: next, itemLayoutAnimation: { duration: 100 } }));
    const moved = calls.find((c) => c.key === "row 2")!;
    assertEquals(
      moved.frames[0].transform,
      "translate(0px, 40px)",
      "row 2 glides up from its old place",
    );
    const entered = calls.find((c) => c.key === "new")!;
    assertEquals(entered.frames[0].opacity, 0, "the inserted row fades in");
    const ghost = calls.find((c) => c.frames[0].opacity === 1 && c.frames[1].opacity === 0);
    assert(ghost, "the removed row fades out as a ghost");
    assertEquals(calls.length, 4, "nothing else animates");
    assert(!calls.some((c) => c.key === "row 0"), "the anchored row does not move");
    const ghostEl = all(screen).find((e) => e.getAttribute("data-vl-ghost") !== null);
    assert(ghostEl === undefined || ghostEl.getAttribute("aria-hidden") === "true");
    await screen.unmount();
  } finally {
    delete proto.getBoundingClientRect;
    delete proto.animate;
    delete proto.cloneNode;
  }
});

// ---- keepMounted (K3) ---------------------------------------------------------------------------------

Deno.test("keepMounted: listed keys stay mounted (same element) while scrolled away; the hook returns them too (K3)", async () => {
  const props = (keep: string[]) => ({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    keepMounted: keep,
    renderItem: text,
  });
  const screen = await render(list(props(["r5", "r900"])));
  const row5 = rowAt(screen, 5)!;
  assert(rowAt(screen, 900), "r900 mounted though far below");
  await scrollTo(screen, 20_000);
  assert(rowAt(screen, 5) === row5, "the same element");
  assert(styleHas(row5, "position:absolute"));
  await screen.rerender(list(props([])));
  await scrollTo(screen, 20_040);
  assertEquals(rowAt(screen, 5), undefined, "released");

  let v: UseVirtualListResult | null = null;
  function Hooked(): VNode {
    v = useVirtualList({
      count: 1000,
      getItem: (i: number) => ({ id: `k${i}` }),
      getItemSize: () => 40,
      viewportSize: 400,
      keepMounted: ["k3"],
    });
    return h("div", v.scrollProps, h("div", v.innerProps));
  }
  const hooked = await render(h(Hooked, null));
  const sc = hooked.container.children[0] as unknown as DomEl & { scrollTop: number };
  sc.scrollTop = 30_000;
  await act(() => fireEventOn(sc, "scroll"));
  const items = (v as unknown as UseVirtualListResult).items;
  assert(items.some((it) => it.index === 3 && it.offset === 120), "kept, with its offset");
  await hooked.unmount();
  await screen.unmount();
});

// ---- selection + print (G5, G6, T28, T29) ------------------------------------------------------------------

Deno.test("selection: a text selection's first and last rows stay mounted while it lives (G5, T28)", async () => {
  const doc = new EventTarget();
  let sel: Record<string, unknown> = { isCollapsed: true, rangeCount: 0 };
  await withTempGlobals({ document: doc, getSelection: () => sel }, async () => {
    const screen = await render(list({
      data: rows(1000),
      getItemSize: () => 40,
      viewportSize: 400,
      renderItem: text,
    }));
    const row3 = rowAt(screen, 3)!;
    const row8 = rowAt(screen, 8)!;
    sel = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: row3.children[0],
      focusNode: row8.children[0],
    };
    await act(() => doc.dispatchEvent(new Event("selectionchange")));
    await scrollTo(screen, 30_000);
    assert(rowAt(screen, 3) === row3 && rowAt(screen, 8) === row8, "both ends kept");
    sel = { isCollapsed: true, rangeCount: 1 };
    await act(() => doc.dispatchEvent(new Event("selectionchange")));
    await scrollTo(screen, 30_040);
    assertEquals(rowAt(screen, 3), undefined, "released with the selection");
    await screen.unmount();
  });
});

Deno.test("print: beforeprint renders up to printLimit rows in flow; afterprint restores (G6, T29)", async () => {
  await withTempGlobals({ document: new EventTarget() }, async () => {
    const screen = await render(list({
      data: rows(5000),
      getItemSize: () => 40,
      viewportSize: 400,
      printLimit: 1000,
      renderItem: text,
    }));
    await scrollTo(screen, 40 * 4500);
    await act(() => globalThis.dispatchEvent(new Event("beforeprint")));
    const idx = indices(screen);
    assertEquals(idx.length, 1000, "the print cap");
    assertEquals([idx[0], idx.at(-1)], [4000, 4999], "the window ending at the last row");
    const sc = scrollerOf(screen);
    assert(sc.getAttribute("data-vl-printing") !== null && styleHas(sc, "overflow:visible"));
    const inner = all(screen).find((e) => e.getAttribute("data-vl-inner") !== null)!;
    assert(styleHas(inner, "height:auto"), "rows paginate in normal flow");
    await act(() => globalThis.dispatchEvent(new Event("afterprint")));
    assert(indices(screen).length < 100, "virtualized again");
    assert(indices(screen).includes(4500), "at the same place");
    await screen.unmount();
  });
});

// ---- scroll events (C4, C6, T13) -------------------------------------------------------------------

Deno.test("scroll events: RN nativeEvent, drag + momentum lifecycle, programmatic flag (C4, C6, T13)", async () => {
  const log: string[] = [];
  let lastEvent: VirtualListScrollEvent | null = null;
  let handle: VirtualListHandle | null = null;
  const rec = (name: string) => (e: VirtualListScrollEvent) => {
    lastEvent = e;
    log.push(`${name}${e.programmatic ? "*" : ""}`);
  };
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    ref: (x: VirtualListHandle | null) => void (handle = x),
    onScroll: rec("scroll"),
    onScrollBeginDrag: rec("beginDrag"),
    onScrollEndDrag: rec("endDrag"),
    onMomentumScrollBegin: rec("momentumBegin"),
    onMomentumScrollEnd: rec("momentumEnd"),
    renderItem: text,
  }));
  const sc = scrollerOf(screen);
  await act(() => fireEventOn(sc, "touchstart", { touches: [{}] }));
  await scrollTo(screen, 100);
  await act(() => fireEventOn(sc, "touchend", { touches: [] }));
  await scrollTo(screen, 300);
  await act(() => fireEventOn(sc, "scrollend"));
  assertEquals(log, ["beginDrag", "scroll", "endDrag", "momentumBegin", "scroll", "momentumEnd"]);
  const ne = (lastEvent as unknown as VirtualListScrollEvent).nativeEvent;
  assertEquals(ne.contentOffset.y, 300);
  assertEquals(ne.contentSize.height, 40_000);
  assertEquals(ne.layoutMeasurement.height, 400);
  // A programmatic scroll: momentum begin + end once, flagged.
  log.length = 0;
  await act(() => handle!.scrollToOffset(2000));
  await act(() => fireEventOn(sc, "scroll"));
  await wait(220);
  assertEquals(log, ["momentumBegin*", "scroll*", "momentumEnd*"]);
  await screen.unmount();
});

Deno.test("scroll events: scrollEventThrottle limits onScroll; a trailing call carries the final offset", async () => {
  const offsets: number[] = [];
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    scrollEventThrottle: 10_000,
    onScroll: (e) => offsets.push(e.nativeEvent.contentOffset.y),
    renderItem: text,
  }));
  for (const y of [10, 20, 30, 40, 50]) await scrollTo(screen, y);
  assertEquals(offsets, [10]);
  await wait(220);
  assertEquals(offsets, [10, 50], "the trailing call");
  await screen.unmount();
});

// ---- progressive rendering (A6, T1) ------------------------------------------------------------------

Deno.test("progressive: rows entering after mount show a placeholder for one task, then content (A6)", async () => {
  const screen = await render(list({
    data: rows(1000),
    getItemSize: () => 40,
    viewportSize: 400,
    overscan: 0,
    progressive: true,
    renderPlaceholder: (i) => h("i", null, `…${i}`),
    renderItem: text,
  }));
  assertStringIncludes(screen.html(), "row 0", "the first window renders its content (SSR parity)");
  assertEquals(screen.html().includes("data-vl-placeholder"), false);
  await scrollTo(screen, 4000);
  const placeholders = all(screen).filter((e) => e.getAttribute("data-vl-placeholder") !== null);
  assertEquals(placeholders.length, 10, "the new rows start as placeholders");
  assertStringIncludes(screen.html(), "…100");
  const el = rowAt(screen, 100)!;
  await wait(120);
  assertEquals(all(screen).filter((e) => e.getAttribute("data-vl-placeholder") !== null).length, 0);
  assertStringIncludes(screen.html(), "row 100");
  assert(rowAt(screen, 100) === el, "the row element is kept; only its content swaps");
  await screen.unmount();
});

Deno.test("progressive: placeholder sizes are never recorded as row sizes", async () => {
  await withRO(async () => {
    const screen = await render(list({
      data: rows(1000),
      estimatedItemSize: 40,
      viewportSize: 400,
      overscan: 0,
      progressive: true,
      renderItem: text,
    }));
    await measureAll(() => 90);
    await scrollTo(screen, 20_000);
    await measureAll(() => 12); // what a placeholder would measure
    await wait(120);
    await measureAll(() => 90); // the real rows
    const tops = visualTops(screen, () => 90);
    const ordered = [...tops.values()];
    for (let k = 1; k < ordered.length; k++) assertEquals(ordered[k] - ordered[k - 1], 90);
    await screen.unmount();
  });
});

// ---- typeahead + announcements (G2, G1) -----------------------------------------------------------------

Deno.test("typeahead: a letter jumps to the next row starting with it, into rows not rendered (G2, T26)", async () => {
  const data = Array.from(
    { length: 6000 },
    (_, i) => i === 1 ? "banana" : i === 5000 ? "Quince" : i === 5001 ? "quark" : `item ${i}`,
  );
  const screen = await render(list({
    data,
    getItemSize: () => 40,
    viewportSize: 400,
    typeahead: true,
    renderItem: (s: string) => h("span", null, s),
  }));
  const tab = (i: number) =>
    rowAt(screen, i)?.getAttribute("tabIndex") ?? rowAt(screen, i)?.getAttribute("tabindex");
  await screen.fireEvent.keyDown(rowAt(screen, 0)!, { key: "q" });
  assertEquals(tab(5000), "0", "jumped (case-insensitive) to row 5000");
  await screen.fireEvent.keyDown(rowAt(screen, 5000)!, { key: "q" });
  assertEquals(tab(5001), "0", "the same letter again cycles to the next match");
  await wait(800);
  await screen.fireEvent.keyDown(rowAt(screen, 5001)!, { key: "b" });
  assertEquals(tab(1), "0", "wraps around");
  await screen.unmount();
});

Deno.test("announceChanges: a polite live region reports row-count changes (not on mount)", async () => {
  const props = (n: number, announce: boolean | ((c: number, p: number) => string)) => ({
    data: rows(n),
    getItemSize: () => 40,
    viewportSize: 400,
    announceChanges: announce,
    renderItem: text,
  });
  const screen = await render(list(props(10, true)));
  const region = () => all(screen).find((e) => e.getAttribute("data-vl-announce") !== null)!;
  assertEquals(region().getAttribute("aria-live"), "polite");
  assertEquals(region().textContent, "", "nothing on mount");
  await screen.rerender(list(props(12, true)));
  await wait(600);
  assertEquals(region().textContent, "12 items");
  await screen.rerender(list(props(15, (c, p) => `${c - p} new messages`)));
  await wait(600);
  assertEquals(region().textContent, "3 new messages");
  await screen.unmount();
});

// ---- window scroll: no layout read per scroll (E8) -----------------------------------------------------

Deno.test("window scroll: the page offset is cached, not re-read with getBoundingClientRect on every scroll", async () => {
  const proto = DomEl.prototype as unknown as Record<string, unknown>;
  let reads = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  proto.getBoundingClientRect = function (this: DomEl) {
    reads++;
    const inner = this.getAttribute("data-vl-inner") !== null;
    const top = inner ? 200 - Number(g.scrollY ?? 0) : 0;
    return {
      top,
      left: 0,
      right: 300,
      bottom: top + 40_000,
      width: inner ? 300 : 0,
      height: inner ? 40_000 : 0,
    };
  };
  try {
    await withTempGlobals({
      innerHeight: 500,
      scrollY: 0,
      document: Object.assign(new EventTarget(), { documentElement: { scrollHeight: 40_700 } }),
      scrollTo: (o: { top: number }) => void (g.scrollY = o.top),
    }, async () => {
      const screen = await render(list({
        data: rows(1000),
        getItemSize: () => 40,
        scrollElement: "window",
        overscan: 4000,
        renderItem: text,
      }));
      reads = 0;
      for (let y = 10; y <= 200; y += 10) {
        g.scrollY = y;
        await act(() => globalThis.dispatchEvent(new Event("scroll")));
      }
      assert(reads <= 4, `layout reads during 20 scroll frames: ${reads}`);
      g.scrollY = 200 + 40 * 300;
      await act(() => globalThis.dispatchEvent(new Event("scroll")));
      assert(
        indices(screen).includes(300),
        "the cached page offset (200 px header) still maps rows",
      );
      await screen.unmount();
    });
  } finally {
    delete proto.getBoundingClientRect;
  }
});

// ---- masonry (E3, T18) -----------------------------------------------------------------------------------

Deno.test("VirtualMasonry: balanced columns, only nearby items rendered, appends keep placed items, onEndReached (E3, T18)", async () => {
  type Pin = { id: string; h: number };
  const pins = (n: number, from = 0): Pin[] =>
    Array.from(
      { length: n },
      (_, i) => ({ id: `p${from + i}`, h: 100 + (((from + i) * 37) % 120) }),
    );
  let ends = 0;
  let handle: VirtualMasonryHandle | null = null;
  const props = (data: Pin[]) => ({
    data,
    numColumns: 3,
    gap: 8,
    getItemSize: (p: Pin) => p.h,
    viewportSize: 600,
    onEndReached: () => void ends++,
    ref: (x: VirtualMasonryHandle | null) => void (handle = x),
    renderItem: (p: Pin) => h("div", null, p.id),
  });
  const el = (p: Record<string, unknown>) =>
    h(VirtualMasonry as unknown as (p: Record<string, unknown>) => VNode, p);
  let data = pins(1000);
  const screen = await render(el(props(data)));
  const items = () => all(screen).filter((e) => e.getAttribute("data-column") !== null);
  assert(items().length > 5 && items().length < 80, `bounded (${items().length})`);
  const cols = new Set(items().map((e) => e.getAttribute("data-column")));
  assertEquals(cols.size, 3, "three columns in use");
  const p5 = items().find((e) => e.getAttribute("data-index") === "5")!.getAttribute("style");
  assertEquals(ends, 0, "not on mount");
  const root = screen.container.children[0] as unknown as DomEl & { scrollTop: number };
  await act(() => handle!.scrollToIndex(999));
  await act(() => fireEventOn(root as unknown as DomEl, "scroll"));
  assert(items().some((e) => e.getAttribute("data-index") === "999"), "the last item rendered");
  assertEquals(ends, 1, "onEndReached near the end");
  data = [...data, ...pins(100, 1000)];
  await screen.rerender(el(props(data)));
  root.scrollTop = 0;
  await act(() => fireEventOn(root as unknown as DomEl, "scroll"));
  assertEquals(
    items().find((e) => e.getAttribute("data-index") === "5")!.getAttribute("style"),
    p5,
    "an append never moves placed items",
  );
  await screen.unmount();
});

// ---- SSR of the new props (J1) -----------------------------------------------------------------------------

Deno.test("SSR: grid, content container, progressive and announcements render deterministic markup (J1)", async () => {
  const html = await renderToString(list({
    data: rows(100),
    numColumns: 2,
    gap: 4,
    getItemSize: () => 30,
    viewportSize: 300,
    progressive: true,
    announceChanges: true,
    contentContainerStyle: { padding: "8px" },
    renderItem: text,
  }));
  assertStringIncludes(html, 'data-vl-item="0"');
  assertStringIncludes(html, 'aria-setsize="100"');
  assertStringIncludes(html, "row 0", "progressive: the server renders content, not placeholders");
  assertStringIncludes(html, 'data-vl-content=""');
  assertStringIncludes(html, 'aria-live="polite"');
  assertEquals(html.includes("data-vl-placeholder"), false);
});

// ---- drag-to-reorder (K2, T34) ---------------------------------------------------------------------

/** A list with reorder handles; `moves` records onReorder calls. */
function reorderApp(moves: [number, number][], expose: (r: VirtualReorder) => void) {
  return function App(): VNode {
    const ref = useRef<VirtualListHandle | null>(null);
    const data = rows(1000);
    const reorder = useVirtualReorder({
      list: ref,
      count: data.length,
      onReorder: (from, to) => void moves.push([from, to]),
    });
    expose(reorder);
    return h(
      "div",
      null,
      list({
        ref,
        data,
        getItemSize: () => 40,
        viewportSize: 400,
        keepMounted: reorder.keepMounted,
        renderItem: (r: Row, i: number) =>
          h(
            "div",
            reorder.itemProps(i),
            h("button", { ...reorder.handleProps(i), "data-handle": String(i) }, "::"),
            r.text,
          ),
      }),
      reorder.liveRegion,
    );
  };
}

Deno.test("reorder: keyboard pick-up, move into unrendered rows, drop — announced (K2, G2)", async () => {
  const moves: [number, number][] = [];
  let r: VirtualReorder | null = null;
  const screen = await render(h(reorderApp(moves, (x) => void (r = x)), null));
  const handleOf = (i: number) =>
    all(screen).find((e) => e.getAttribute("data-handle") === String(i))!;
  await screen.fireEvent.keyDown(handleOf(2), { key: " " });
  assertEquals(r!.dragging, 2);
  assertStringIncludes(r!.announcement, "Picked up item 3 of 1000");
  for (let k = 0; k < 3; k++) await screen.fireEvent.keyDown(handleOf(2), { key: "ArrowDown" });
  assertEquals(r!.target, 5);
  assertEquals(r!.itemProps(5)["data-vl-drop"], "after", "the drop indicator");
  await screen.fireEvent.keyDown(handleOf(2), { key: "Enter" });
  assertEquals(moves, [[2, 5]]);
  assertStringIncludes(r!.announcement, "Moved from position 3 to 6");
  // Escape cancels.
  await screen.fireEvent.keyDown(handleOf(7), { key: " " });
  await screen.fireEvent.keyDown(handleOf(7), { key: "ArrowUp" });
  await screen.fireEvent.keyDown(handleOf(7), { key: "Escape" });
  assertEquals(moves.length, 1);
  assertStringIncludes(r!.announcement, "Cancelled");
  await screen.unmount();
});

Deno.test("reorder: pointer drag keeps the dragged row mounted while the list scrolls far, drops at the pointer (K2, T34)", async () => {
  const moves: [number, number][] = [];
  let r: VirtualReorder | null = null;
  const screen = await render(h(reorderApp(moves, (x) => void (r = x)), null));
  const handle2 = all(screen).find((e) => e.getAttribute("data-handle") === "2")!;
  await act(() => fireEventOn(handle2, "pointerdown", { clientX: 5, clientY: 90, pointerId: 1 }));
  assertEquals(r!.dragging, 2);
  assertEquals(r!.keepMounted, ["r2"]);
  const row2 = rowAt(screen, 2)!;
  await scrollTo(screen, 20_000); // e.g. auto-scroll carried the view far away
  assert(rowAt(screen, 2) === row2, "the dragged row is still mounted (same element)");
  await act(() => fireEventOn(handle2, "pointermove", { clientX: 5, clientY: 50 }));
  assertEquals(r!.target, 501, "pointer 50 px into the viewport at 20,000 px: row 501");
  await act(() => fireEventOn(handle2, "pointerup", {}));
  assertEquals(moves, [[2, 501]]);
  assertEquals(r!.dragging, null);
  await screen.unmount();
});
