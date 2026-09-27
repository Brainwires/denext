// React Native mode's list adapters, behaviour (denext/testing's in-memory DOM, no browser):
// FlatList / SectionList / VirtualizedList on denext's VirtualList — inverted chat semantics,
// getItemLayout exactness, numColumns, sections with sticky headers and scrollToLocation,
// viewability tokens (with `section`), the refreshControl default, ListEmptyComponent,
// onEndReached and the ref methods; FlashList v2 and LegendList compat. The build wiring is in
// react-native-lists-build.test.ts.

import { assert, assertEquals } from "@std/assert";
import { render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import {
  createFlatList,
  createSectionList,
  createVirtualizedList,
} from "../src/react-native/mod.ts";
import type { ListPrimitives, SectionListRef } from "../src/react-native/lists/types.ts";
import { all } from "./helpers/virtual-list.ts";

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
