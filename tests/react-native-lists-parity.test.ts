// React Native mode's list adapters, the names the lists parity ledger used to track
// (scripts/parity/native/baselines/lists.known-gaps.json, now empty): `renderScrollComponent`
// (FlatList / SectionList / VirtualizedList / FlashList / LegendList),
// `automaticallyAdjustKeyboardInsets`, FlashList's benchmark exports, LegendList's
// `anchoredEndSpace` / `onItemSizeChanged` / `onMetricsChange` / `snapToIndices`, the engine's
// `onItemMeasured` + `getItemLayout().measured` they build on, and the documented waiver of
// SectionList's type-only `data` / `getItem` / `getItemCount`. denext/testing's in-memory DOM.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import { useLayoutEffect, useRef } from "../src/runtime/hooks.ts";
import { fireEventOn } from "../src/testing/dom.ts";
import type { DomEl } from "../src/testing/dom.ts";
import {
  createFlatList,
  createSectionList,
  createVirtualizedList,
} from "../src/react-native/mod.ts";
import type { FlatListRef, ListPrimitives } from "../src/react-native/lists/types.ts";
import {
  autoScroll,
  type BenchmarkResult,
  Cancellable,
  createFlashList,
  type FlashListRef,
  JSFPSMonitor,
  useBenchmark,
  useDataMultiplier,
  useFlatListBenchmark,
} from "../src/react-native/flash-list.ts";
import {
  type AnchoredEndSpaceReadyInfo,
  createLegendList,
  type LegendListMetrics,
} from "../src/react-native/legend-list.ts";
import { LIST_PACKAGES } from "../src/react-native/lists/manifest.ts";
import { listPackageSource } from "../src/build/react-native-lists.ts";
import { listGaps } from "../scripts/parity/native/lists.ts";
import { LIST_WAIVERS } from "../scripts/parity/native/waivers.ts";
import { all, list, measureAll, scrollerOf, withRO } from "./helpers/virtual-list.ts";
import { type Any, fakeViewport, frameQueue, withGlobals } from "./helpers/mobile-fakes.ts";

/** A react-native-web `View` stand-in that reports `onLayout` with its style's size. */
function View(
  props: { style?: unknown; onLayout?: (e: unknown) => void; children?: VNodeChild },
): VNode {
  const flat: Record<string, unknown> = {};
  const add = (s: unknown): void => {
    if (Array.isArray(s)) s.forEach(add);
    else if (s && typeof s === "object") Object.assign(flat, s);
  };
  add(props.style);
  const height = Number(flat.height ?? 0);
  const width = Number(flat.width ?? 0);
  useLayoutEffect(() => {
    props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
  });
  return h("div", { "data-rn-view": "", style: flat }, props.children);
}

const PRIM: ListPrimitives = { View };
const FlatList = createFlatList(PRIM);
const SectionList = createSectionList(PRIM);
const VirtualizedList = createVirtualizedList(PRIM);
const FlashList = createFlashList(PRIM);
const LegendList = createLegendList(PRIM);

type Item = { id: string; text: string };
const items = (n: number, from = 0): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, text: `item ${from + i}` }));
const row = (item: Item): VNode => h("span", { "data-text": item.text }, item.text);
const layout40 = (_: unknown, index: number) => ({ length: 40, offset: 40 * index, index });

/** The rendered `[data-text]` texts, in DOM order. */
const texts = (screen: { container: unknown }): string[] =>
  all(screen as never).filter((e) => e.getAttribute("data-text") !== null).map((e) =>
    e.getAttribute("data-text")!
  );

/** The element marked `attr`. */
const marked = (screen: { container: unknown }, attr: string): DomEl | undefined =>
  all(screen as never).find((e) => e.getAttribute(attr) !== null);

/** The keyboard / end-room spacer's height (0 when absent). */
function endRoom(screen: { container: unknown }): number {
  const el = marked(screen, "data-vl-keyboard");
  const m = /height:\s*([\d.]+)px/.exec(el?.getAttribute("style") ?? "");
  return m ? Number(m[1]) : 0;
}

// ---- renderScrollComponent ---------------------------------------------------------------

/** An app scroll view: records its props, renders a scrollable div with the list's ref. */
function makeScrollView(seen: Record<string, unknown>[]) {
  return function ScrollView(props: Record<string, unknown>): VNode {
    seen.push(props);
    return h("div", {
      ref: props.ref,
      "data-custom-scroll": "",
      "data-has-refresh": String(!!props.refreshControl),
    }, props.children as VNodeChild);
  };
}

/** Scroll `el` to `top` as the user would. */
async function scrollEl(el: DomEl, top: number): Promise<void> {
  (el as unknown as { scrollTop: number }).scrollTop = top;
  await act(() => fireEventOn(el, "scroll"));
}

Deno.test("renderScrollComponent (FlatList): the app's scroll view hosts the items and scrolls them", async () => {
  const seen: Record<string, unknown>[] = [];
  const ScrollView = makeScrollView(seen);
  const scrolls: number[] = [];
  let ref: FlatListRef<Item> | null = null;
  const style = { height: 800 };
  const screen = await render(h(FlatList as never, {
    data: items(1000),
    getItemLayout: layout40,
    style,
    refreshControl: h("i", { "data-rc": "" }),
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) =>
      scrolls.push(e.nativeEvent.contentOffset.y),
    ref: (r: FlatListRef<Item> | null) => (ref = r),
    renderScrollComponent: (props: Record<string, unknown>) => h(ScrollView, props),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  const host = marked(screen, "data-custom-scroll")!;
  assert(host, "the app's scroll view rendered");
  const props = seen.at(-1)!;
  assertEquals(props.style, style, "the list's style goes to the scroll view");
  assertEquals(props.onScroll, undefined, "the list reports onScroll itself (never twice)");
  assertEquals(props.onLayout, undefined);
  assertEquals(host.getAttribute("data-has-refresh"), "true", "refreshControl goes to it");
  assertEquals(texts(screen)[0], "item 0");
  assertEquals(ref!.getScrollableNode(), host as unknown as Element, "the host is the scroller");
  await scrollEl(host, 4000);
  assertEquals(scrolls, [4000], "one onScroll per scroll, from the host's offset");
  assert(texts(screen).includes("item 100"), "the window follows the host's scroll");
  assert(!texts(screen).includes("item 0"));
  await screen.unmount();
});

Deno.test("renderScrollComponent: SectionList and VirtualizedList; the element's own ref is kept", async () => {
  const seen: Record<string, unknown>[] = [];
  const ScrollView = makeScrollView(seen);
  const own: unknown[] = [];
  const section = await render(h(SectionList as never, {
    sections: [{ key: "a", data: items(3) }],
    renderScrollComponent: (props: Record<string, unknown>) =>
      h(ScrollView, { ...props, ref: (r: unknown) => own.push(r) }),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(texts(section), ["item 0", "item 1", "item 2"]);
  assert(own.includes(marked(section, "data-custom-scroll")), "the app's ref still receives it");
  await section.unmount();
  const data = items(4);
  const virtualized = await render(h(VirtualizedList as never, {
    data,
    getItem: (d: Item[], i: number) => d[i],
    getItemCount: (d: Item[]) => d.length,
    horizontal: true,
    renderScrollComponent: (props: Record<string, unknown>) => h(ScrollView, props),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(seen.at(-1)!.horizontal, true);
  assertEquals(texts(virtualized).length, 4);
  await virtualized.unmount();
});

Deno.test("renderScrollComponent: FlashList takes a component or a function; LegendList a function", async () => {
  const seen: Record<string, unknown>[] = [];
  const ScrollView = makeScrollView(seen);
  for (const renderScrollComponent of [ScrollView, (p: Record<string, unknown>) => ScrollView(p)]) {
    const screen = await render(h(FlashList as never, {
      data: items(3),
      renderScrollComponent,
      renderItem: ({ item }: { item: Item }) => row(item),
    }));
    assert(marked(screen, "data-custom-scroll"));
    assertEquals(texts(screen), ["item 0", "item 1", "item 2"]);
    await screen.unmount();
  }
  const legend = await render(h(LegendList as never, {
    data: items(3),
    renderScrollComponent: (props: Record<string, unknown>) => h(ScrollView, props),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assert(marked(legend, "data-custom-scroll"));
  assertEquals(texts(legend), ["item 0", "item 1", "item 2"]);
  await legend.unmount();
});

// ---- automaticallyAdjustKeyboardInsets -----------------------------------------------------

Deno.test("automaticallyAdjustKeyboardInsets: room for the covered part after the last item", async () => {
  const vv = fakeViewport(800);
  const frames = frameQueue();
  await withGlobals({
    innerHeight: 800,
    visualViewport: vv,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
  }, async () => {
    const props = (on: boolean, horizontal = false) =>
      h(FlatList as never, {
        data: items(50),
        getItemLayout: layout40,
        horizontal,
        automaticallyAdjustKeyboardInsets: on,
        renderItem: ({ item }: { item: Item }) => row(item),
      });
    const screen = await render(props(true));
    assertEquals(endRoom(screen), 0, "no keyboard, no room");
    vv.height = 500; // a 300 px keyboard
    await act(() => {
      vv.fire("resize");
      frames.flush();
    });
    assertEquals(endRoom(screen), 300, "the keyboard's overlap with the list");
    await screen.rerender(props(false));
    assertEquals(endRoom(screen), 0, "off: nothing added");
    await screen.rerender(props(true, true));
    assertEquals(endRoom(screen), 0, "horizontal lists are not adjusted (React Native)");
    await screen.unmount();
  });
});

// ---- FlashList's benchmark exports ---------------------------------------------------------

/** Run `fn` with a manual frame queue and a controllable `Date.now`. */
async function withClock(
  fn: (
    tick: (ms: number) => void,
    frames: ReturnType<typeof frameQueue>,
  ) => Promise<void>,
): Promise<void> {
  const frames = frameQueue();
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await withGlobals({
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
    }, () => fn((ms) => (now += ms), frames));
  } finally {
    Date.now = realNow;
  }
}

Deno.test("FlashList autoScroll + Cancellable: 7 px/ms per frame to the target; cancel stops it", async () => {
  await withClock(async (tick, frames) => {
    const calls: Array<[number, number]> = [];
    const done = autoScroll((x, y) => calls.push([x, y]), 0, 0, 0, 100, 1);
    assertEquals(calls, [[0, 0]], "starts at the origin, unanimated");
    tick(10);
    frames.flush();
    assertEquals(calls.at(-1), [0, 70]);
    tick(10);
    frames.flush();
    assertEquals(calls.at(-1), [0, 100], "clamped to the target");
    assertEquals(await done, true);
    const cancellable = new Cancellable();
    const stopped = autoScroll(() => {}, 0, 0, 0, 1e6, 1, cancellable);
    cancellable.cancel();
    assert(cancellable.isCancelled());
    frames.flush();
    assertEquals(await stopped, false);
  });
});

Deno.test("FlashList JSFPSMonitor: counts frames; one run per instance", async () => {
  await withClock((tick, frames) => {
    const monitor = new JSFPSMonitor();
    monitor.startTracking();
    assertThrows(() => monitor.startTracking(), Error, "already been run");
    for (let i = 0; i < 120; i++) {
      tick(1000 / 60);
      frames.flush();
    }
    const fps = monitor.stopAndGetData();
    assertEquals(fps.averageFPS, 60);
    assert(fps.minFPS > 0 && fps.minFPS <= fps.maxFPS);
    assertEquals(frames.queue.size, 0, "stopping cancels the frame loop");
    return Promise.resolve();
  });
});

Deno.test("FlashList useDataMultiplier: repeats the data, copying objects", async () => {
  const data = items(2);
  let out: Item[] = [];
  let numbers: number[] = [];
  function Probe(): VNode {
    [out] = useDataMultiplier(data, 5);
    [numbers] = useDataMultiplier([1, 2], 3);
    return h("i", null);
  }
  const screen = await render(h(Probe, null));
  assertEquals(out.map((m) => m.id), ["m0", "m1", "m0", "m1", "m0"]);
  assert(out[0] !== data[0], "objects are copies");
  assertEquals(numbers, [1, 2, 1]);
  await screen.unmount();
});

Deno.test("FlashList useBenchmark: scrolls a FlashList to its end and back, reports FPS + suggestions", async () => {
  await withClock(async (tick, frames) => {
    const results: BenchmarkResult[] = [];
    let start: (() => void) | null = null;
    const offsets: number[] = [];
    let screen: Awaited<ReturnType<typeof render>> | null = null;
    const top = () =>
      Number((scrollerOf(screen!) as unknown as { scrollTop?: number }).scrollTop) || 0;
    function Bench(): VNode {
      const ref = useRef<FlashListRef<Item> | null>(null);
      const b = useBenchmark(ref as never, (r) => results.push(r), { startManually: true });
      start = b.startBenchmark;
      return h(FlashList as never, {
        ref,
        data: items(100),
        getItemType: () => "row",
        renderItem: ({ item }: { item: Item }) => row(item),
      });
    }
    screen = await render(h(Bench, null));
    await act(() => start!());
    for (let i = 0; i < 200 && results.length === 0; i++) {
      tick(16);
      await act(() => frames.flush());
      offsets.push(top());
    }
    assertEquals(results.length, 1, "the callback ran once");
    const r = results[0];
    assertEquals(r.interrupted, false);
    assert(r.js && r.js.averageFPS > 0);
    assert(r.suggestions.some((s) => s.includes("useDataMultiplier")), "fewer than 200 items");
    assert(r.formattedString?.startsWith("Results:"));
    assert(Math.max(...offsets) > 1000, "it scrolled the list toward its end");
    assertEquals(offsets.at(-1), 0, "and back");
    await screen.unmount();
  });
});

Deno.test("FlashList useBenchmark: a pass that throws stops the FPS monitor and the run", async () => {
  await withClock(async (_tick, frames) => {
    const errors: unknown[] = [];
    const onError = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      errors.push(event.reason);
    };
    globalThis.addEventListener("unhandledrejection", onError);
    let bench: { startBenchmark: () => void; isBenchmarkRunning: boolean } | null = null;
    // A list whose measurement throws mid-run (a ref that went stale, a broken adapter).
    const broken = {
      props: { data: items(10) },
      getWindowSize: () => {
        throw new Error("gone");
      },
    };
    function Bench(): VNode {
      bench = useBenchmark({ current: broken } as never, () => {}, { startManually: true });
      return h("i", null);
    }
    try {
      const screen = await render(h(Bench, null));
      await act(() => bench!.startBenchmark());
      await act(() => new Promise((r) => setTimeout(r, 0)));
      assertEquals(frames.queue.size, 0, "no frame loop left counting after the failure");
      assertEquals(bench!.isBenchmarkRunning, false, "another run can start");
      assertEquals(errors.map((e) => (e as Error).message), ["gone"], "the failure surfaces");
      await screen.unmount();
    } finally {
      globalThis.removeEventListener("unhandledrejection", onError);
    }
  });
});

Deno.test("FlashList useFlatListBenchmark: scrolls to targetOffset and back; empty data throws", async () => {
  await withClock(async (tick, frames) => {
    const results: BenchmarkResult[] = [];
    const calls: number[] = [];
    let start: (() => void) | null = null;
    const fake = { current: { scrollToOffset: (p: { offset: number }) => calls.push(p.offset) } };
    function Bench(): VNode {
      start = useFlatListBenchmark(fake, (r) => results.push(r), {
        targetOffset: 70,
        startManually: true,
      }).startBenchmark;
      return h("i", null);
    }
    const screen = await render(h(Bench, null));
    await act(() => start!());
    for (let i = 0; i < 20 && results.length === 0; i++) {
      tick(10);
      await act(() => frames.flush());
    }
    assertEquals(Math.max(...calls), 70);
    assertEquals(calls.at(-1), 0, "and back");
    assertEquals(results[0].suggestions, []);
    await screen.unmount();
    let startEmpty: (() => void) | null = null;
    function Empty(): VNode {
      startEmpty = useFlatListBenchmark(
        { current: { props: { data: [] }, scrollToOffset: () => {} } },
        () => {},
        { targetOffset: 1, startManually: true },
      ).startBenchmark;
      return h("i", null);
    }
    const empty = await render(h(Empty, null));
    assertThrows(() => startEmpty!(), Error, "Data is empty");
    await empty.unmount();
  });
});

Deno.test("FlashList benchmark exports reach the aliased package (manifest → generated module)", () => {
  const pkg = LIST_PACKAGES["@shopify/flash-list"];
  assertEquals(pkg.omitted, []);
  const source = listPackageSource(pkg);
  for (const name of ["autoScroll", "Cancellable", "JSFPSMonitor", "useBenchmark"]) {
    assert(source.includes(name), name);
  }
  assert(source.includes("useDataMultiplier") && source.includes("useFlatListBenchmark"));
});

// ---- LegendList ----------------------------------------------------------------------------

Deno.test("LegendList anchoredEndSpace: room keeps the anchor at the start; onSizeChanged / onReady", async () => {
  const sizes: number[] = [];
  const ready: AnchoredEndSpaceReadyInfo[] = [];
  const props = (data: Item[], anchorIndex: number, anchorOffset = 0) =>
    h(LegendList as never, {
      data,
      getFixedItemSize: () => 40,
      ListFooterComponent: h("b", null, "f"),
      ListFooterComponentStyle: { height: 30 },
      contentContainerStyle: { paddingBottom: 10 },
      anchoredEndSpace: {
        anchorIndex,
        anchorOffset,
        onSizeChanged: (s: number) => sizes.push(s),
        onReady: (info: AnchoredEndSpaceReadyInfo) => ready.push(info),
      },
      renderItem: ({ item }: { item: Item }) => row(item),
    });
  const data = items(30);
  // The 800 px viewport (no layout) − the anchor (40) − the footer (30) − the padding (10).
  const screen = await render(props(data, 29));
  assertEquals(endRoom(screen), 720);
  assertEquals(sizes.at(-1), 720);
  assertEquals(ready.at(-1), { anchorIndex: 29, anchorKey: "m29", size: 720 });
  // A reply appended below the anchor takes its share of the room.
  const more = [...data, ...items(1, 30)];
  await screen.rerender(props(more, 29, 100));
  assertEquals(endRoom(screen), 800 - 80 - 30 - 10 - 100);
  assertEquals(sizes.at(-1), 580);
  // Without the config the room goes away.
  await screen.rerender(h(LegendList as never, {
    data: more,
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(endRoom(screen), 0);
  await screen.unmount();
});

Deno.test("LegendList anchoredEndSpace: unknown sizes wait for measurement; then ready", async () => {
  await withRO(async () => {
    const ready: AnchoredEndSpaceReadyInfo[] = [];
    const sizes: number[] = [];
    const screen = await render(h(LegendList as never, {
      data: items(40),
      anchoredEndSpace: {
        anchorIndex: 38,
        onSizeChanged: (s: number) => sizes.push(s),
        onReady: (info: AnchoredEndSpaceReadyInfo) => ready.push(info),
      },
      renderItem: ({ item }: { item: Item }) => row(item),
    }));
    assertEquals(ready, [], "the anchor and the item after it are not measured yet");
    assertEquals(endRoom(screen), 0);
    assert(texts(screen).includes("item 39"), "the anchor's tail stays rendered");
    await measureAll((i) => (i >= 38 ? 100 : 50));
    assertEquals(ready.at(-1), { anchorIndex: 38, anchorKey: "m38", size: 600 });
    assertEquals(endRoom(screen), 600);
    assertEquals(sizes, [600]);
    await screen.unmount();
  });
});

Deno.test("LegendList anchoredEndSpace: a batch of first measurements is one pass, not one per item", async () => {
  await withRO(async () => {
    const n = 200;
    let lookups = 0;
    const screen = await render(h(LegendList as never, {
      data: items(n),
      // Counts the anchored-space walk: it asks each item from the anchor to the end.
      getFixedItemSize: () => void lookups++,
      anchoredEndSpace: { anchorIndex: 0 },
      renderItem: ({ item }: { item: Item }) => row(item),
    }));
    lookups = 0;
    await measureAll(() => 20);
    // Every item from the anchor on is mounted and measured at once: n reports. Recomputing the
    // space for each would walk the n items n times (O(n²)).
    assert(lookups <= 4 * n, `${lookups} lookups for ${n} items`);
    await screen.unmount();
  });
});

Deno.test("LegendList onItemSizeChanged: each measured size change, with the item", async () => {
  await withRO(async () => {
    const seen: Array<{ index: number; size: number; previous: number; itemKey: string }> = [];
    const screen = await render(h(LegendList as never, {
      data: items(10),
      estimatedItemSize: 50,
      onItemSizeChanged: (
        info: { index: number; size: number; previous: number; itemKey: string; itemData: Item },
      ) => {
        assertEquals(info.itemData.id, info.itemKey);
        seen.push({
          index: info.index,
          size: info.size,
          previous: info.previous,
          itemKey: info.itemKey,
        });
      },
      renderItem: ({ item }: { item: Item }) => row(item),
    }));
    await measureAll((i) => (i === 3 ? 80 : 50));
    assertEquals(
      seen,
      [{ index: 3, size: 80, previous: 50, itemKey: "m3" }],
      "equal sizes are not changes",
    );
    await measureAll((i) => (i === 3 ? 90 : 50));
    assertEquals(seen.at(-1), { index: 3, size: 90, previous: 80, itemKey: "m3" });
    await screen.unmount();
  });
});

Deno.test("LegendList onMetricsChange: header and footer sizes on mount and on change", async () => {
  const seen: LegendListMetrics[] = [];
  const props = (header: number) =>
    h(LegendList as never, {
      data: items(3),
      ListHeaderComponent: h("b", null, "h"),
      ListHeaderComponentStyle: { height: header },
      ListFooterComponent: () => h("b", null, "f"),
      ListFooterComponentStyle: { height: 20 },
      onMetricsChange: (m: LegendListMetrics) => seen.push(m),
      renderItem: ({ item }: { item: Item }) => row(item),
    });
  const screen = await render(props(50));
  assertEquals(seen.at(-1), { headerSize: 50, footerSize: 20 });
  const count = seen.length;
  await screen.rerender(props(50));
  assertEquals(seen.length, count, "unchanged metrics are not reported again");
  await screen.rerender(props(70));
  assertEquals(seen.at(-1), { headerSize: 70, footerSize: 20 });
  await screen.unmount();
});

Deno.test("LegendList snapToIndices: those items snap to the start; the content's start too", async () => {
  const screen = await render(h(LegendList as never, {
    data: items(20),
    getFixedItemSize: () => 40,
    snapToIndices: [0, 5, 10],
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  const snapped = all(screen).filter((e) =>
    (e.getAttribute("style") ?? "").includes("scroll-snap-align:start") &&
    e.getAttribute("data-dnx-snap") === null
  ).map((e) => texts({ container: e })[0]);
  assertEquals(snapped, ["item 0", "item 5", "item 10"]);
  assert((scrollerOf(screen).getAttribute("style") ?? "").includes("scroll-snap-type:y mandatory"));
  assert(marked(screen, "data-dnx-snap"), "the content's start is a snap point (snapToStart)");
  await screen.unmount();
});

// ---- the engine's reports ------------------------------------------------------------------

Deno.test("VirtualList onItemMeasured + getItemLayout().measured", async () => {
  await withRO(async () => {
    const reports: Array<{ index: number; size: number; previous: number }> = [];
    let handle:
      | { getItemLayout(i: number): { measured: boolean; size: number } | undefined }
      | null = null;
    const screen = await render(list({
      data: items(20),
      estimatedItemSize: 30,
      ref: (r: Any) => (handle = r),
      onItemMeasured: (info) => reports.push({ ...info }),
      renderItem: (item: Item) => row(item),
    }));
    assertEquals(handle!.getItemLayout(2)!.measured, false);
    await measureAll((i) => (i === 2 ? 45 : 30));
    assertEquals(handle!.getItemLayout(2), { offset: 60, size: 45, measured: true } as never);
    assert(reports.some((r) => r.index === 0 && r.size === 30 && r.previous === 30), "first ones");
    assert(reports.some((r) => r.index === 2 && r.size === 45 && r.previous === 30));
    const n = reports.length;
    await measureAll((i) => (i === 2 ? 45 : 30));
    assertEquals(reports.length, n, "an unchanged size is not reported again");
    await screen.unmount();
  });
});

// ---- the documented waiver -----------------------------------------------------------------

Deno.test("lists parity: SectionList's type-only data / getItem / getItemCount are waived, nothing else", () => {
  const expected = {
    "react-native#SectionList": { props: ["data", "getItem", "getItemCount", "sections", "x"] },
    "react-native#FlatList": { props: ["getItem"] },
  };
  const actual = { "react-native#SectionList": { props: ["sections"] } };
  const gaps = listGaps(expected, actual).map((g) => `${g.target}:${g.name}`);
  assertEquals(gaps, ["react-native#FlatList:getItem", "react-native#SectionList:x"]);
  const unwaived = listGaps(expected, actual, []).map((g) => g.name);
  assertEquals(unwaived.sort(), ["data", "getItem", "getItem", "getItemCount", "x"]);
  assert(LIST_WAIVERS.every((w) => w.reason.length > 40), "each waiver says why");
});
