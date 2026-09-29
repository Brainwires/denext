// React Native mode's list adapters, behaviour (denext/testing's in-memory DOM, no browser):
// FlatList / SectionList / VirtualizedList on denext's VirtualList — inverted chat semantics,
// getItemLayout exactness, numColumns, sections with sticky headers and scrollToLocation,
// viewability tokens (with `section`), the refreshControl default, ListEmptyComponent,
// onEndReached and the ref methods; FlashList v2 and LegendList compat. The build wiring is in
// react-native-lists-build.test.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import {
  createFlatList,
  createSectionList,
  createVirtualizedList,
} from "../src/react-native/mod.ts";
import type {
  FlatListRef,
  ListPrimitives,
  SectionListRef,
  ViewableItemsInfo,
} from "../src/react-native/lists/types.ts";
import {
  all,
  measureAll,
  scrollerOf,
  scrollTo,
  visualTops,
  withRO,
} from "./helpers/virtual-list.ts";
import {
  createFlashList,
  type FlashListRef,
  LayoutCommitObserver,
  RenderTargetOptions,
  useFlashListContext,
  useFlashRecyclingState,
  useLayoutState,
  useMappingHelper,
} from "../src/react-native/flash-list.ts";
import {
  createLegendList,
  type LegendListRef,
  useAdaptiveRender,
  useAdaptiveRenderChange,
  useIsLastItem,
  useListScrollSize,
  useRecyclingEffect,
  useRecyclingState as useLegendRecyclingState,
  useSyncLayout,
  useViewability,
  useViewabilityAmount,
} from "../src/react-native/legend-list.ts";

/** A react-native-web `View` stand-in: a div with the flattened style array. */
function View(props: { style?: unknown; children?: VNodeChild }): VNode {
  const flat: Record<string, unknown> = {};
  const add = (s: unknown): void => {
    if (Array.isArray(s)) s.forEach(add);
    else if (s && typeof s === "object") Object.assign(flat, s);
  };
  add(props.style);
  return h("div", { "data-rn-view": "", style: flat }, props.children);
}

/** A RefreshControl stand-in: marks the wrapper and forwards the props it received. */
function RefreshControl(
  props: { refreshing?: boolean; onRefresh?: () => void; children?: VNodeChild; style?: unknown },
): VNode {
  return h("div", {
    "data-refresh": String(!!props.refreshing),
    "data-has-onrefresh": String(typeof props.onRefresh === "function"),
  }, props.children);
}

const PRIM: ListPrimitives = { View, RefreshControl };
const FlatList = createFlatList(PRIM);
const SectionList = createSectionList(PRIM);
const VirtualizedList = createVirtualizedList(PRIM);
const FlashList = createFlashList(PRIM);
const LegendList = createLegendList(PRIM);

type Item = { id: string; text: string };
const items = (n: number, from = 0): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, text: `item ${from + i}` }));

/** The texts of the rendered `[data-text]` elements, in DOM order. */
const texts = (screen: { container: unknown }): string[] =>
  all(screen as never).filter((e) => e.getAttribute("data-text") !== null).map((e) =>
    e.getAttribute("data-text")!
  );
const row = (item: Item): VNode => h("span", { "data-text": item.text }, item.text);
const layout40 = (_: unknown, index: number) => ({ length: 40, offset: 40 * index, index });

function fl(props: Record<string, unknown>): VNode {
  return h(FlatList as never, props);
}

Deno.test("FlatList: data + renderItem({item, index, separators}) + keyExtractor; getItemLayout is exact", async () => {
  const seen: number[] = [];
  const screen = await render(fl({
    data: items(1000),
    keyExtractor: (m: Item) => m.id,
    getItemLayout: layout40,
    renderItem: (
      { item, index, separators }: { item: Item; index: number; separators: unknown },
    ) => {
      seen.push(index);
      assert(typeof (separators as { highlight: unknown }).highlight === "function");
      return row(item);
    },
  }));
  // 800 px viewport (no layout) / 40 px rows = 20 rows, plus the engine's overscan.
  const shown = texts(screen);
  assertEquals(shown[0], "item 0");
  assert(shown.length >= 20 && shown.length < 1000, `virtualized: ${shown.length} rows`);
  assert(seen.includes(19));
  await screen.unmount();
});

Deno.test("FlatList inverted: a logical reversal — item 0 at the bottom, no scaleY, header at the bottom", async () => {
  const data = items(5);
  const screen = await render(fl({
    data,
    inverted: true,
    getItemLayout: layout40,
    ListHeaderComponent: h("span", { "data-text": "HEADER" }, "h"),
    ListFooterComponent: h("span", { "data-text": "FOOTER" }, "f"),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(texts(screen), [
    "FOOTER",
    "item 4",
    "item 3",
    "item 2",
    "item 1",
    "item 0",
    "HEADER",
  ]);
  const html = all(screen).map((e) => e.getAttribute("style") ?? "").join(";");
  assert(!html.includes("scale"), "no transform flip");
  await screen.unmount();
});

Deno.test("VirtualizedList: getItem + getItemCount over any data source", async () => {
  const screen = await render(h(VirtualizedList as never, {
    data: { size: 3 },
    getItemCount: (d: { size: number }) => d.size,
    getItem: (_d: unknown, i: number) => ({ id: `v${i}`, text: `virt ${i}` }),
    getItemLayout: layout40,
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(texts(screen), ["virt 0", "virt 1", "virt 2"]);
  await screen.unmount();
});

Deno.test("SectionList: headers, items and footers flatten in order; the ref carries scrollToLocation", async () => {
  let ref: SectionListRef | null = null;
  const sections = [
    { key: "a", title: "A", data: items(3) },
    { key: "b", title: "B", data: items(3, 3) },
  ];
  const screen = await render(h(SectionList as never, {
    sections,
    ref: (r: SectionListRef | null) => (ref = r),
    getItemLayout: layout40,
    renderSectionHeader: ({ section }: { section: { title: string } }) =>
      h("b", { "data-text": `H ${section.title}` }, section.title),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(texts(screen), [
    "H A",
    "item 0",
    "item 1",
    "item 2",
    "H B",
    "item 3",
    "item 4",
    "item 5",
  ]);
  assert(ref !== null, "the ref receives the SectionList methods");
  assertEquals(typeof (ref as SectionListRef).scrollToLocation, "function");
  await screen.unmount();
});

const scrollTop = (screen: { container: unknown }): number =>
  Number((scrollerOf(screen as never) as unknown as { scrollTop: number }).scrollTop) || 0;

Deno.test("FlatList inverted: chat semantics — onEndReached is the visual top; scrollToIndex / scrollToOffset mirror", async () => {
  let ref: FlatListRef<Item> | null = null;
  const ends: number[] = [];
  const starts: number[] = [];
  const screen = await render(fl({
    data: items(200),
    inverted: true,
    ref: (r: FlatListRef<Item> | null) => (ref = r),
    getItemLayout: layout40,
    onEndReached: () => ends.push(1),
    onStartReached: () => starts.push(1),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  // Starts at the bottom: item 0 is the last rendered (visual) row.
  const shown = texts(screen);
  assertEquals(shown.at(-1), "item 0");
  assertEquals(scrollTop(screen), 200 * 40 - 800, "the view starts at the bottom");
  await act(() => ref!.scrollToIndex({ index: 150, animated: false }));
  // Inverted viewPosition 0: item 150's bottom sits at the viewport's bottom.
  assertEquals(scrollTop(screen), (200 - 1 - 150) * 40 + 40 - 800);
  await act(() => ref!.scrollToOffset({ offset: 0, animated: false }));
  assertEquals(scrollTop(screen), 200 * 40 - 800, "offset 0 is the bottom when inverted");
  await act(() => ref!.scrollToOffset({ offset: 400, animated: false }));
  assertEquals(scrollTop(screen), 200 * 40 - 800 - 400, "offsets count up from the bottom");
  await scrollTo(screen, scrollTop(screen)); // the browser's scroll event: no longer at the end
  await act(() => ref!.scrollToEnd({ animated: false }));
  assertEquals(scrollTop(screen), 0, "the data's end is the visual top");
  await scrollTo(screen, 5000);
  const before = ends.length;
  await scrollTo(screen, 1000);
  await scrollTo(screen, 100);
  assert(ends.length > before, "onEndReached fires at the visual top (older history)");
  await screen.unmount();
});

Deno.test("FlatList: scrollToIndex is exact without getItemLayout; out of range throws like RN", async () => {
  let ref: FlatListRef<Item> | null = null;
  const screen = await render(fl({
    data: items(500),
    ref: (r: FlatListRef<Item> | null) => (ref = r),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  await act(() => ref!.scrollToIndex({ index: 300, animated: false }));
  assertEquals(scrollTop(screen), 300 * 48, "estimates are exact without layout (48 px default)");
  await act(() => ref!.scrollToIndex({ index: 300, viewPosition: 1, animated: false }));
  assertEquals(scrollTop(screen), 301 * 48 - 800);
  await act(() => ref!.scrollToIndex({ index: 300, viewOffset: 10, animated: false }));
  assertEquals(scrollTop(screen), 300 * 48 - 10);
  assertThrows(() => ref!.scrollToIndex({ index: 500 }), Error, "maximum is 499");
  assertThrows(() => ref!.scrollToIndex({ index: -1 }), Error, "minimum is 0");
  assert(ref!.getScrollableNode() !== null);
  assertEquals(typeof ref!.getNativeScrollRef()?.scrollTo, "function");
  await screen.unmount();
});

Deno.test("FlatList: numColumns groups items into RN rows; row indices; one viewability token per item", async () => {
  const seen: ViewableItemsInfo<Item>[] = [];
  const screen = await render(fl({
    data: items(10),
    numColumns: 3,
    columnWrapperStyle: { gap: 4 },
    getItemLayout: layout40,
    onViewableItemsChanged: (i: ViewableItemsInfo<Item>) => seen.push(i),
    renderItem: ({ item, index }: { item: Item; index: number }) =>
      h("span", { "data-text": `${item.text}@${index}` }, item.text),
  }));
  assertEquals(texts(screen), [
    "item 0@0",
    "item 1@1",
    "item 2@2",
    "item 3@3",
    "item 4@4",
    "item 5@5",
    "item 6@6",
    "item 7@7",
    "item 8@8",
    "item 9@9",
  ]);
  const rowsEl = all(screen).filter((e) =>
    (e.getAttribute("style") ?? "").includes("flex-direction:row")
  );
  assertEquals(rowsEl.length, 4, "4 rows of up to 3");
  assert((rowsEl[0].getAttribute("style") ?? "").includes("gap:4"), "columnWrapperStyle applies");
  const tokens = seen.at(-1)!.viewableItems;
  assertEquals(tokens.map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(tokens[4].key, "m4");
  await screen.unmount();
});

Deno.test("FlatList: separators get highlighted / leadingItem; separators.highlight() updates both neighbours", async () => {
  const seps: { highlighted: boolean; leading: string }[][] = [];
  let hl: (() => void) | null = null;
  function Sep(p: { highlighted: boolean; leadingItem: Item }): VNode {
    return h("hr", { "data-sep": `${p.leadingItem.id}:${p.highlighted}` });
  }
  const screen = await render(fl({
    data: items(3),
    getItemLayout: layout40,
    ItemSeparatorComponent: Sep,
    renderItem: (
      { item, index, separators }: { item: Item; index: number; separators: { highlight(): void } },
    ) => {
      if (index === 1) hl = () => separators.highlight();
      return row(item);
    },
  }));
  const sepAttrs = () =>
    all(screen).filter((e) => e.getAttribute("data-sep") !== null).map((e) =>
      e.getAttribute("data-sep")
    );
  assertEquals(
    sepAttrs(),
    ["m0:false", "m1:false"],
    "between items only, leadingItem = the item above",
  );
  await act(() => hl!());
  assertEquals(sepAttrs(), ["m0:true", "m1:true"], "the separators above and below item 1");
  seps.length = 0;
  await screen.unmount();
});

Deno.test("FlatList: ListEmptyComponent fills the list; onRefresh alone gets the default RefreshControl", async () => {
  let refreshed = 0;
  const screen = await render(fl({
    data: [],
    refreshing: true,
    onRefresh: () => refreshed++,
    ListEmptyComponent: () => h("p", { "data-text": "EMPTY" }, "nothing"),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(texts(screen), ["EMPTY"]);
  const control = all(screen).find((e) => e.getAttribute("data-refresh") !== null)!;
  assertEquals(control.getAttribute("data-refresh"), "true");
  assertEquals(control.getAttribute("data-has-onrefresh"), "true");
  const scroller = scrollerOf(screen);
  assert(control.children.includes(scroller), "the control wraps the scroller");
  await screen.unmount();
});

Deno.test("FlatList: onEndReached gets distanceFromEnd, once per data change, within RN's default 2 viewports", async () => {
  const calls: number[] = [];
  const screen = await render(fl({
    data: items(200),
    getItemLayout: layout40,
    onEndReached: (i: { distanceFromEnd: number }) => calls.push(i.distanceFromEnd),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  assertEquals(calls.length, 0, "not on mount");
  await scrollTo(screen, 1000);
  assertEquals(calls.length, 0, "6200 px from the end: not yet");
  await scrollTo(screen, 200 * 40 - 800 - 1500);
  assertEquals(calls.length, 1, "within 2 viewports (1600 px)");
  assertEquals(calls[0], 1500);
  await scrollTo(screen, 200 * 40 - 800);
  assertEquals(calls.length, 1, "once until the data changes");
  await screen.unmount();
});

Deno.test("FlatList: the ref methods — scrollToItem, getItemLayout-exact scrollToIndex, recordInteraction, no-ops", async () => {
  let ref: FlatListRef<Item> | null = null;
  const layouts: unknown[] = [];
  const data = items(300);
  const screen = await render(fl({
    data,
    ref: (r: FlatListRef<Item> | null) => (ref = r),
    onLayout: (e: unknown) => layouts.push(e),
    getItemLayout: (_: unknown, i: number) => ({ length: 30 + (i % 3) * 10, offset: 0, index: i }),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  let expected = 0;
  for (let i = 0; i < 120; i++) expected += 30 + (i % 3) * 10;
  await act(() => ref!.scrollToItem({ item: data[120], animated: false }));
  assertEquals(scrollTop(screen), expected, "sizes from getItemLayout, summed exactly");
  await act(() => ref!.scrollToIndex({ index: 120, viewPosition: 0.5, animated: false }));
  assertEquals(scrollTop(screen), expected + 30 / 2 - 400);
  ref!.recordInteraction();
  ref!.flashScrollIndicators();
  assertEquals(layouts.length, 1, "onLayout on mount");
  ref!.setNativeProps({});
  assert(ref!.getScrollResponder()?.getScrollResponder() === ref!.getScrollResponder());
  await screen.unmount();
});

Deno.test("FlatList: onContentSizeChange reports the content size on mount, then only changes", async () => {
  const sizes: Array<[number, number]> = [];
  const props = {
    data: items(20),
    getItemLayout: layout40,
    onContentSizeChange: (w: number, h: number) => sizes.push([w, h]),
    renderItem: ({ item }: { item: Item }) => row(item),
  };
  const screen = await render(fl(props));
  assertEquals(sizes.length, 1, "on mount");
  assert(sizes[0].every((n) => typeof n === "number"));
  await screen.rerender(fl({ ...props, extraData: 1 }));
  assertEquals(sizes.length, 1, "the same size is not reported again");
  await screen.unmount();
});

Deno.test("SectionList: sticky headers, scrollToLocation below the header, tokens with section", async () => {
  let ref: SectionListRef | null = null;
  const seen: ViewableItemsInfo<unknown>[] = [];
  const sections = [
    { key: "a", title: "A", data: items(30) },
    { key: "b", title: "B", data: items(30, 30) },
  ];
  const screen = await render(h(SectionList as never, {
    sections,
    ref: (r: SectionListRef | null) => (ref = r),
    stickySectionHeadersEnabled: true,
    getItemLayout: layout40,
    onViewableItemsChanged: (i: ViewableItemsInfo<unknown>) => seen.push(i),
    renderSectionHeader: ({ section }: { section: { title: string } }) =>
      h("b", { "data-text": `H ${section.title}` }, section.title),
    renderItem: ({ item }: { item: Item }) => row(item),
  }));
  const first = seen.at(-1)!.viewableItems;
  assertEquals(first[0].index, null, "the header's token has index null");
  assertEquals((first[0].section as { key: string }).key, "a");
  assertEquals(first[1].index, 0);
  assertEquals(first[1].key, "m0");
  // Section b's header is flattened row 32 (header + 30 items + footer); itemIndex 3 = item 2.
  await act(() => ref!.scrollToLocation({ sectionIndex: 1, itemIndex: 3, animated: false }));
  assertEquals(scrollTop(screen), (32 + 3) * 40 - 40, "the item lands below the sticky header");
  const sticky = all(screen).filter((e) =>
    e.getAttribute("data-vl-row") !== null && (e.getAttribute("style") ?? "").includes("sticky")
  );
  assert(sticky.length >= 1, "headers are the engine's sticky rows");
  await screen.unmount();
});

Deno.test("FlashList: renderItem({item, index, target}), getItemType, overrideItemLayout spans, item-index ref", async () => {
  let ref: FlashListRef<Item> | null = null;
  const types: (string | number)[] = [];
  const screen = await render(h(FlashList as never, {
    data: items(7),
    numColumns: 3,
    estimatedItemSize: 999, // accepted and ignored (v2)
    ref: (r: FlashListRef<Item> | null) => (ref = r),
    getItemType: (_: Item, i: number) => i === 0 ? "wide" : "cell",
    overrideItemLayout: (layout: { span?: number }, _: Item, i: number) => {
      if (i === 0) layout.span = 3;
    },
    renderItem: ({ item, index, target }: { item: Item; index: number; target: string }) => {
      types.push(target);
      return h("span", { "data-text": `${item.text}@${index}` }, item.text);
    },
  }));
  assertEquals(texts(screen).length, 7);
  const rowsEl = all(screen).filter((e) =>
    (e.getAttribute("style") ?? "").includes("flex-direction:row")
  );
  assertEquals(rowsEl.length, 3, "a full-width item, then 3 + 3");
  assert((rowsEl[0].children[0].getAttribute("style") ?? "").includes("width:100%"));
  assert(types.every((t) => t === "Cell"));
  assertEquals(ref!.computeVisibleIndices(), { startIndex: 0, endIndex: 6 });
  assertEquals(typeof ref!.scrollToIndex({ index: 4, animated: false }).then, "function");
  assertEquals(ref!.getLayout(4)?.y, 96, "item 4 starts the third row");
  await screen.unmount();
});

Deno.test("FlashList: maintainVisibleContentPosition.startRenderingFromBottom + autoscrollToBottomThreshold (chat)", async () => {
  let data = items(100);
  const props = () => ({
    data,
    maintainVisibleContentPosition: {
      startRenderingFromBottom: true,
      autoscrollToBottomThreshold: 50,
    },
    renderItem: ({ item }: { item: Item }) => row(item),
  });
  const screen = await render(h(FlashList as never, props()));
  assertEquals(scrollTop(screen), 100 * 48 - 800, "starts at the bottom");
  await scrollTo(screen, scrollTop(screen) - 20); // near the end (20 px)
  data = [...data, ...items(3, 100)];
  await screen.rerender(h(FlashList as never, props()));
  assertEquals(scrollTop(screen), 103 * 48 - 800, "appended messages scroll into view");
  await screen.unmount();
});

Deno.test("FlashList: useRecyclingState resets when its deps change", async () => {
  let set: ((v: number) => void) | null = null;
  function Cell(p: { id: string }): VNode {
    const [n, setN] = useFlashRecyclingState(0, [p.id]);
    set = setN;
    return h("i", { "data-text": `${p.id}=${n}` });
  }
  const screen = await render(h(Cell, { id: "a" }));
  await act(() => set!(5));
  assertEquals(texts(screen), ["a=5"]);
  await screen.rerender(h(Cell, { id: "b" }));
  assertEquals(texts(screen), ["b=0"]);
  await screen.unmount();
});

Deno.test("LegendList: renderItem props, ItemSeparator leadingItem, cell hooks, maintainScrollAtEnd", async () => {
  let ref: LegendListRef | null = null;
  let data = items(50);
  const seenViewable = new Set<string>();
  function Row(p: { item: Item }): VNode {
    const last = useIsLastItem();
    const [n] = useLegendRecyclingState(({ index }) => index * 10);
    useViewability((t) => {
      if (t.isViewable) seenViewable.add(t.key);
    });
    return h("span", { "data-text": `${p.item.text}:${n}${last ? ":last" : ""}` });
  }
  const props = () => ({
    data,
    ref: (r: LegendListRef | null) => (ref = r),
    getFixedItemSize: () => 40,
    maintainScrollAtEnd: true,
    initialScrollAtEnd: true,
    ItemSeparatorComponent: (p: { leadingItem: Item }) => h("hr", { "data-sep": p.leadingItem.id }),
    renderItem: (p: { item: Item; index: number; data: readonly Item[] }) => {
      assertEquals(p.data, data);
      return h(Row, { item: p.item });
    },
  });
  const screen = await render(h(LegendList as never, props()));
  const shown = texts(screen);
  assertEquals(shown.at(-1), "item 49:490:last");
  assert(seenViewable.has("m49"), "useViewability reports the cell's item");
  data = [...data, ...items(2, 50)];
  await screen.rerender(h(LegendList as never, props()));
  assertEquals(texts(screen).at(-1), "item 51:510:last", "maintainScrollAtEnd follows appends");
  const state = ref!.getState();
  assertEquals(state.isAtEnd, true);
  assertEquals(state.end, 51);
  assertEquals(typeof ref!.scrollToIndex({ index: 0, animated: false }).then, "function");
  await screen.unmount();
});

Deno.test("LegendList: children mode, numColumns with columnWrapperStyle gaps", async () => {
  const screen = await render(h(LegendList as never, {
    numColumns: 2,
    columnWrapperStyle: { columnGap: 8, rowGap: 4 },
    children: [0, 1, 2].map((i) => h("span", { key: i, "data-text": `c${i}` }, `c${i}`)),
  }));
  assertEquals(texts(screen), ["c0", "c1", "c2"]);
  const rowsEl = all(screen).filter((e) =>
    (e.getAttribute("style") ?? "").includes("flex-direction:row")
  );
  assert((rowsEl[0].getAttribute("style") ?? "").includes("column-gap:8"));
  assert((rowsEl[0].getAttribute("style") ?? "").includes("padding-bottom:4"));
  await screen.unmount();
});

Deno.test("FlashList helpers: useLayoutState, useMappingHelper, LayoutCommitObserver, RenderTargetOptions", async () => {
  let commits = 0;
  function Item(): VNode {
    const [n] = useLayoutState(() => 7);
    const { getMappingKey } = useMappingHelper();
    assertEquals(useFlashListContext(), undefined);
    return h("i", { "data-text": `${n}:${getMappingKey("k", 1)}` });
  }
  const screen = await render(
    h(LayoutCommitObserver, { onCommitLayoutEffect: () => commits++ }, h(Item, null)),
  );
  assertEquals(texts(screen), ["7:k"]);
  assert(commits >= 1);
  assertEquals(RenderTargetOptions.Cell, "Cell");
  await screen.unmount();
});

Deno.test("LegendList cell hooks: useRecyclingEffect, useViewabilityAmount, useListScrollSize, adaptive render", async () => {
  const effects: number[] = [];
  const amounts = new Map<string, number>();
  let size: { width: number; height: number } | null = null;
  function Row(p: { item: Item }): VNode {
    useRecyclingEffect(({ index }) => {
      effects.push(index);
    });
    useViewabilityAmount((t) => amounts.set(t.key, t.sizeVisible));
    size = useListScrollSize();
    assertEquals(useAdaptiveRender(), "normal");
    useAdaptiveRenderChange(() => {});
    assertEquals(typeof useSyncLayout(), "function");
    return row(p.item);
  }
  const screen = await render(h(LegendList as never, {
    data: items(40),
    getFixedItemSize: () => 40,
    renderItem: (p: { item: Item }) => h(Row, { item: p.item }),
  }));
  assert(effects.includes(0) && effects.includes(19));
  assert(size !== null);
  await scrollTo(screen, 20);
  assertEquals(amounts.get("m0"), 20, "half of item 0 is visible after a 20 px scroll");
  await screen.unmount();
});

Deno.test("FlatList: scrollToIndex lands exactly on unmeasured variable rows; a prepend at the top shows", async () => {
  await withRO(async () => {
    const truth = (i: number) => 20 + ((i * 37) % 90);
    let ref: FlatListRef<Item> | null = null;
    let data = items(3000);
    const props = () => ({
      data,
      ref: (r: FlatListRef<Item> | null) => (ref = r),
      renderItem: ({ item }: { item: Item }) => row(item),
    });
    const screen = await render(fl(props()));
    await measureAll(truth);
    await act(() => ref!.scrollToIndex({ index: 2100, animated: false }));
    await measureAll(truth);
    assertEquals(Math.round(visualTops(screen, truth).get(2100)!), 0, "row 2100 at the top");
    await act(() => ref!.scrollToOffset({ offset: 0, animated: false }));
    await scrollTo(screen, 0);
    await measureAll((i) => truth(i + 5));
    data = [...items(5, 9000), ...data];
    await screen.rerender(fl(props()));
    await measureAll((i) => i < 5 ? 30 : truth(i - 5));
    assertEquals(scrollTop(screen), 0, "at the top, the new first items show (RN)");
    assertEquals(texts(screen)[0], "item 9000");
    await screen.unmount();
  });
});
