// `lists: "denext"`: `@legendapp/list/react` (LegendList's DOM build) on denext's VirtualList.
// The API against the pinned package (the lists parity baseline's DOM targets), the build
// wiring (browser bundles load the prebuilt runtime module, server bundles keep the framework
// source external, the unbundled dev loop maps the specifier, the config switch), and the DOM
// build's behaviour in denext/testing's in-memory DOM: classes and DOM attributes on the scroll
// element, the ref's element getters, chat lists anchored at the end (`initialScrollAtEnd`,
// `maintainScrollAtEnd`, `alignItemsAtEnd`), the ref's scroll methods, `getState()` and its
// `listen` / `listenToPosition` subscribers.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { DOM_LIST_PACKAGES, domListAliases, domListsPlugin } from "../src/build/dom-lists.ts";
import { DENEXT_RUNTIME_FILES, runtimeEntryPoints } from "../src/build/next-compat.ts";
import { domListsEnabled } from "../src/server/config.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { compatDepUrl } from "../src/build/dev-unbundled/resolve.ts";
import { createUnbundledState } from "../src/build/dev-unbundled/state.ts";
import {
  LegendList,
  type LegendListDomRef,
  useAdaptiveRender,
  useAdaptiveRenderChange,
  useIsLastItem,
  useRecyclingState,
} from "../src/lists/legend-list.ts";
import { isScrollerAttribute } from "../src/react-native/legend-list.ts";
import { scrollVelocity } from "../src/react-native/lists/legend-render.ts";
import { denextListSurfaces, listGaps } from "../scripts/parity/native/lists.ts";
import { fireEventOn } from "../src/testing/dom.ts";
import { all, measureAll, scrollerOf, scrollTo, withRO } from "./helpers/virtual-list.ts";

const ROOT = new URL("../", import.meta.url).pathname;

// ── API: the DOM build's props, ref methods and exports vs the pinned @legendapp/list ──────

Deno.test("dom lists parity: every prop, ref method and export of @legendapp/list/react 3.4.0 is provided", async () => {
  const baseline = JSON.parse(
    await Deno.readTextFile(join(ROOT, "scripts/parity/native/baselines/lists.baseline.json")),
  );
  const targets = ["@legendapp/list/react#LegendList", "@legendapp/list/react"];
  const expected = Object.fromEntries(targets.map((t) => [t, baseline.targets[t]]));
  for (const t of targets) assert(expected[t], `baseline has ${t} (parity:native:refresh)`);
  assert(expected["@legendapp/list/react#LegendList"].props.length > 60, "DOM props captured");
  const actual = await denextListSurfaces(ROOT);
  assertEquals(listGaps(expected, actual), []);
  // The names T3 Code's lists use, explicitly.
  const props = new Set(actual["@legendapp/list/react#LegendList"].props);
  for (
    const p of [
      "className",
      "contentContainerClassName",
      "estimatedItemSize",
      "recycleItems",
      "keyExtractor",
      "onEndReached",
      "ListHeaderComponent",
      "ListFooterComponent",
      "onScroll",
      "maintainScrollAtEnd",
      "maintainScrollAtEndThreshold",
      "alignItemsAtEnd",
      "initialScrollAtEnd",
      "anchoredEndSpace",
      "contentInsetEndAdjustment",
      "onItemSizeChanged",
      "alwaysRender",
      "dataVersion",
      "getItemType",
      "drawDistance",
      "extraData",
      "ItemSeparatorComponent",
      "onLoad",
    ]
  ) assert(props.has(p), p);
});

// ── build wiring ────────────────────────────────────────────────────────────────────────────

Deno.test("dom lists: the runtime module is a prebuilt runtime entry", () => {
  const pkg = DOM_LIST_PACKAGES["@legendapp/list/react"];
  assertEquals(pkg.runtime, "denext/lists/legend-list");
  assertEquals(DENEXT_RUNTIME_FILES[pkg.runtime], "lists-legend-list.js");
  const entries = runtimeEntryPoints("file:///fw/");
  assertEquals(entries["lists-legend-list"], "file:///fw/src/lists/legend-list.ts");
  assertEquals(domListAliases(), { "@legendapp/list/react": "denext/lists/legend-list" });
});

/** Bundle `entry` (importing `@legendapp/list/react`) with the plugin for `platform`. */
async function bundleWith(
  platform: "browser" | "deno" | null,
): Promise<{ code: string; result?: Record<string, unknown> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_dom_lists_" });
  const write = async (rel: string, text: string) => {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  };
  try {
    await write(
      "node_modules/@legendapp/list/package.json",
      JSON.stringify({ name: "@legendapp/list", exports: { "./react": "./react.js" } }),
    );
    await write(
      "node_modules/@legendapp/list/react.js",
      'export const LegendList = "REAL_DOM_LegendList";\n',
    );
    // A package that itself imports the DOM build (as a design-system package would).
    await write(
      "node_modules/picker/package.json",
      JSON.stringify({ name: "picker", main: "index.js" }),
    );
    await write(
      "node_modules/picker/index.js",
      'export { LegendList as PickerList } from "@legendapp/list/react";\n',
    );
    await write(
      "entry.js",
      'import { LegendList } from "@legendapp/list/react";\nimport { PickerList } from "picker";\n' +
        "export const result = { LegendList, PickerList };\n",
    );
    const standIn: esbuild.Plugin = {
      name: "runtime-stand-in",
      setup(build) {
        build.onResolve({ filter: /^denext\/lists\/legend-list$/ }, (args) => ({
          path: args.path,
          namespace: "stand-in",
        }));
        build.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({
          contents: 'export const LegendList = "DENEXT_LegendList";\n',
          loader: "js",
        }));
      },
    };
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      absWorkingDir: dir,
      plugins: [...(platform ? [domListsPlugin(platform)] : []), standIn],
    });
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    if (platform === "deno") return { code };
    const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(code)))}`;
    return { code, result: (await import(url)).result };
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("dom lists: a browser bundle resolves @legendapp/list/react (app and packages) to denext's module", async () => {
  const { result } = await bundleWith("browser");
  assertEquals(result, { LegendList: "DENEXT_LegendList", PickerList: "DENEXT_LegendList" });
});

Deno.test("dom lists: without the plugin the real package resolves", async () => {
  const { result } = await bundleWith(null);
  assertEquals(result, { LegendList: "REAL_DOM_LegendList", PickerList: "REAL_DOM_LegendList" });
});

Deno.test("dom lists: a server bundle keeps the framework module external", async () => {
  const { code } = await bundleWith("deno");
  assertStringIncludes(code, "src/lists/legend-list.ts");
  assert(!code.includes("REAL_DOM_LegendList"), "the real package is not bundled");
});

Deno.test("dom lists: config switch and validation", () => {
  assertEquals(domListsEnabled({ lists: "denext" }), true);
  assertEquals(domListsEnabled({ lists: "library" }), false);
  assertEquals(domListsEnabled({}), false);
  assertEquals(domListsEnabled(null), false);
  validateDenextConfig({ lists: "denext" });
  validateDenextConfig({ lists: "library" });
  assertThrows(
    () => validateDenextConfig({ lists: "virtual" as never }),
    Error,
    '`lists` must be "denext" or "library"',
  );
});

Deno.test("dom lists: the unbundled dev loop serves the aliased specifier from the runtime", () => {
  const base = { projectDir: "/p", appDir: "/p/app", configPath: "/p/deno.json", outDir: "/p/out" };
  const plain = createUnbundledState({ ...base, compat: true });
  assertStringIncludes(compatDepUrl(plain, "@legendapp/list/react")!, "/@npm/");
  const aliased = createUnbundledState({ ...base, compat: true, specAliases: domListAliases() });
  const url = compatDepUrl(aliased, "@legendapp/list/react")!;
  assertStringIncludes(url, "lists-legend-list.js");
  assert(!url.includes("/@npm/"), url);
});

Deno.test("dom lists: which props are scroll-element attributes", () => {
  for (const name of ["id", "role", "tabIndex", "data-testid", "aria-label", "onKeyDown"]) {
    assert(isScrollerAttribute(name), name);
  }
  for (
    const name of ["onScroll", "onEndReached", "onLayout", "className", "style", "data", "ref"]
  ) assert(!isScrollerAttribute(name), name);
});

// ── behaviour ───────────────────────────────────────────────────────────────────────────────

type Msg = { id: string; text: string };
const msgs = (n: number, from = 0): Msg[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${from + i}`, text: `message ${from + i}` }));
const texts = (screen: { container: unknown }): string[] =>
  all(screen as never).filter((e) => e.getAttribute("data-text") !== null).map((e) =>
    e.getAttribute("data-text")!
  );

function legend(props: Record<string, unknown>): VNode {
  return h(LegendList as never, props);
}

Deno.test("LegendList (DOM): classes, styles and DOM attributes land on the scroll element; the ref's getters return it", async () => {
  let ref: LegendListDomRef | null = null;
  let scrollView: unknown = null;
  let keyed = 0;
  const screen = await render(legend({
    data: msgs(3),
    ref: (r: LegendListDomRef | null) => (ref = r),
    refScrollView: (el: unknown) => (scrollView = el),
    keyExtractor: (m: Msg) => m.id,
    estimatedItemSize: 40,
    className: "timeline scroll-fade",
    contentContainerClassName: "px-2",
    style: { maxHeight: 224 },
    id: "timeline",
    "data-testid": "messages",
    "aria-label": "Messages",
    onKeyDown: () => keyed++,
    renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }, item.text),
  }));
  const scroller = scrollerOf(screen);
  assertEquals(scroller.getAttribute("class"), "timeline scroll-fade");
  assertEquals(scroller.getAttribute("id"), "timeline");
  assertEquals(scroller.getAttribute("data-testid"), "messages");
  assertEquals(scroller.getAttribute("aria-label"), "Messages");
  assertStringIncludes(scroller.getAttribute("style") ?? "", "max-height");
  const content = all(screen).find((e) => e.getAttribute("data-vl-content") !== null);
  assertEquals(content?.getAttribute("class"), "px-2");
  assertEquals(ref!.getScrollableNode(), scroller as unknown as Element);
  assertEquals(ref!.getNativeScrollRef(), scroller as unknown as Element);
  assertEquals(ref!.getScrollResponder(), scroller as unknown as Element);
  assertEquals(ref!.getAnimatableRef(), scroller as unknown as Element);
  assertEquals(scrollView, scroller);
  await act(() => fireEventOn(scroller, "keydown"));
  assertEquals(keyed, 1, "a DOM event handler on the scroll element");
  assertEquals(texts(screen), ["message 0", "message 1", "message 2"]);
  await screen.unmount();
});

Deno.test("LegendList (DOM) chat: initialScrollAtEnd + maintainScrollAtEnd follow appends; the ref scrolls and reports", async () => {
  await withRO(async () => {
    let ref: LegendListDomRef | null = null;
    let data = msgs(200);
    const scrolled: number[] = [];
    let ended = 0;
    function Row(p: { item: Msg }): VNode {
      const last = useIsLastItem();
      const [seen] = useRecyclingState(({ index }) => index);
      return h("span", { "data-text": `${p.item.text}:${seen}${last ? ":last" : ""}` });
    }
    const props = () => ({
      data,
      ref: (r: LegendListDomRef | null) => (ref = r),
      keyExtractor: (m: Msg) => m.id,
      estimatedItemSize: 90,
      recycleItems: true,
      initialScrollAtEnd: true,
      maintainScrollAtEnd: true,
      maintainScrollAtEndThreshold: 1,
      onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) =>
        scrolled.push(e.nativeEvent.contentOffset.y),
      onEndReached: () => ended++,
      ListHeaderComponent: h("span", { "data-text": "HISTORY" }),
      ListFooterComponent: h("span", { "data-text": "COMPOSER-SPACE" }),
      renderItem: ({ item }: { item: Msg }) => h(Row, { item }),
    });
    const screen = await render(legend(props()));
    await measureAll(() => 90);
    let shown = texts(screen);
    assertEquals(shown.at(-1), "COMPOSER-SPACE", "footer after the items");
    assertEquals(shown.at(-2), "message 199:199:last", "starts at the end");
    assertEquals(shown[0], "HISTORY", "the header leads");
    assert(!shown.some((t) => t.startsWith("message 0:")), "the start is virtualized away");
    const before = ref!.getState();
    assertEquals(before.isAtEnd, true);
    assertEquals(before.end, 199);
    assertEquals(before.data.length, 200);
    assertEquals(before.indexByKey("m150"), 150);
    assertEquals(before.sizeAtIndex(199), 90);
    data = [...data, ...msgs(3, 200)];
    await screen.rerender(legend(props()));
    await measureAll(() => 90);
    shown = texts(screen);
    assertEquals(shown.at(-2), "message 202:202:last", "maintainScrollAtEnd follows appends");
    assertEquals(ref!.getState().isAtEnd, true);
    // The ref's scroll methods are promises (T3 awaits them), and land where asked.
    await act(async () => {
      const p = ref!.scrollToIndex({ index: 0, animated: false });
      assertEquals(typeof p.then, "function");
      await p;
    });
    const top = () => (scrollerOf(screen) as unknown as { scrollTop: number }).scrollTop;
    assertEquals(top(), 0, "item 0 at the viewport's start (the header is unmeasured here)");
    assertEquals(ref!.getState().isAtEnd, false);
    await scrollTo(screen, top()); // the browser's scroll event: no longer at the end
    await act(() => ref!.scrollToOffset({ offset: 900, animated: false }));
    assertEquals(Math.round(ref!.getState().scroll), 900);
    await act(() => ref!.scrollToEnd({ animated: false }));
    await measureAll(() => 90);
    assertEquals(ref!.getState().isAtEnd, true);
    await scrollTo(screen, 1000);
    assert(scrolled.length > 0, "onScroll fired");
    assert(ended >= 0);
    await screen.unmount();
  });
});

Deno.test("LegendList (DOM) chat: alignItemsAtEnd bottom-aligns a short conversation", async () => {
  const screen = await render(legend({
    data: msgs(2),
    keyExtractor: (m: Msg) => m.id,
    getFixedItemSize: () => 40,
    alignItemsAtEnd: true,
    renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
  }));
  assertEquals(texts(screen), ["message 0", "message 1"]);
  // The bottom-align spacer comes before the rows and fills the rest of the viewport.
  const html = all(screen).map((e) => e.getAttribute("style") ?? "").join(";");
  assert(/flex-grow:\s*1|flex:\s*1/.test(html), "a growing spacer pushes the rows down");
  await screen.unmount();
});

Deno.test("LegendList (DOM): getState().listen and listenToPosition call back on change", async () => {
  await withRO(async () => {
    let ref: LegendListDomRef | null = null;
    let data = msgs(5);
    const props = () => ({
      data,
      ref: (r: LegendListDomRef | null) => (ref = r),
      keyExtractor: (m: Msg) => m.id,
      estimatedItemSize: 30,
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    });
    const screen = await render(legend(props()));
    const totals: unknown[] = [];
    const keys: unknown[] = [];
    const positions: number[] = [];
    const state = ref!.getState();
    assertEquals(state.contentLength, 150, "estimates before measurement");
    const stopTotal = state.listen("totalSize", (v) => totals.push(v));
    state.listen("lastItemKeys", (v) => keys.push(v));
    state.listenToPosition("m3", (v) => positions.push(v));
    await measureAll(() => 50);
    assertEquals(totals.at(-1), 250, "totalSize follows the measured rows");
    assertEquals(positions.at(-1), 150, "m3's position after the rows above were measured");
    data = [...data, ...msgs(1, 5)];
    await screen.rerender(legend(props()));
    await measureAll(() => 50);
    assertEquals(keys.at(-1), ["m5"]);
    assertEquals(totals.at(-1), 300);
    stopTotal();
    const heard = totals.length;
    data = [...data, ...msgs(1, 6)];
    await screen.rerender(legend(props()));
    await measureAll(() => 50);
    assertEquals(totals.length, heard, "an unsubscribed listener hears nothing");
    // A type denext does not report never calls back (and unsubscribes cleanly).
    ref!.getState().listen("snapToOffsets" as never, () => {
      throw new Error("unexpected");
    })();
    await screen.unmount();
  });
});

Deno.test("LegendList (DOM): getState().contentLength is the whole scroll content; totalSize the items", async () => {
  await withRO(async () => {
    let ref: LegendListDomRef | null = null;
    const screen = await render(legend({
      data: msgs(5),
      ref: (r: LegendListDomRef | null) => (ref = r),
      keyExtractor: (m: Msg) => m.id,
      estimatedItemSize: 30,
      ListHeaderComponent: h("span", { "data-text": "HISTORY" }),
      ListFooterComponent: h("span", { "data-text": "COMPOSER-SPACE" }),
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    }));
    const totals: unknown[] = [];
    ref!.getState().listen("totalSize", (v) => totals.push(v));
    await measureAll(() => 50);
    // Laid out: the scroll element's scroll size (header + items + footer + end room), which
    // T3 Code's timeline subtracts `scroll` and `scrollLength` from to find the gap below.
    (scrollerOf(screen) as unknown as { scrollHeight: number }).scrollHeight = 420;
    assertEquals(ref!.getState().contentLength, 420, "the scroll element's scroll size");
    assertEquals(totals.at(-1), 250, "listen('totalSize') reports the items alone");
    await screen.unmount();
  });
});

Deno.test("LegendList (DOM): contentInsetEndAdjustment and contentInset's end add room after the last item", async () => {
  const room = async (props: Record<string, unknown>) => {
    const screen = await render(legend({
      data: msgs(50),
      getFixedItemSize: () => 40,
      ...props,
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    }));
    const spacer = all(screen).find((e) => e.getAttribute("data-vl-keyboard") !== null);
    const style = spacer?.getAttribute("style") ?? "";
    await screen.unmount();
    return style;
  };
  assertEquals(await room({}), "");
  assertStringIncludes(await room({ contentInsetEndAdjustment: 120 }), "120px");
  assertStringIncludes(
    await room({ contentInset: { bottom: 30 }, contentInsetEndAdjustment: 10 }),
    "40px",
  );
});

// ── LegendList's render controls: contentInset's start, waitForInitialLayout, itemsAreEqual,
// experimental_adaptiveRender ────────────────────────────────────────────────────────────────

Deno.test("LegendList (DOM): contentInset's start adds room before the content", async () => {
  const room = async (props: Record<string, unknown>) => {
    const screen = await render(legend({
      data: msgs(5),
      getFixedItemSize: () => 40,
      ...props,
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    }));
    const spacer = all(screen).find((e) => e.getAttribute("data-vl-start-inset") !== null);
    const style = spacer?.getAttribute("style") ?? null;
    await screen.unmount();
    return style;
  };
  assertEquals(await room({}), null);
  assertEquals(await room({ contentInset: { bottom: 30 } }), null, "the end inset alone");
  assertStringIncludes((await room({ contentInset: { top: 24 } }))!, "height:24px");
  assertStringIncludes(
    (await room({ horizontal: true, contentInset: { left: 12, top: 99 } }))!,
    "width:12px",
  );
});

Deno.test("LegendList (DOM): waitForInitialLayout keeps the list invisible until its first items are measured", async () => {
  await withRO(async () => {
    const opacity0 = (screen: Parameters<typeof scrollerOf>[0]) =>
      (scrollerOf(screen).getAttribute("style") ?? "").replace(/\s/g, "").includes("opacity:0");
    const screen = await render(legend({
      data: msgs(5),
      waitForInitialLayout: true,
      estimatedItemSize: 40,
      keyExtractor: (m: Msg) => m.id,
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    }));
    assert(opacity0(screen), "hidden before the first measurement");
    await measureAll(() => 40);
    assert(!opacity0(screen), "shown once measured");
    await screen.unmount();

    const plain = await render(legend({
      data: msgs(5),
      renderItem: ({ item }: { item: Msg }) => h("span", { "data-text": item.text }),
    }));
    assert(!opacity0(plain), "without the prop the list shows at once");
    await plain.unmount();

    const empty = await render(legend({ data: [], waitForInitialLayout: true }));
    assert(!opacity0(empty), "an empty list has nothing to wait for");
    await empty.unmount();
  });
});

Deno.test("LegendList (DOM): itemsAreEqual skips re-rendering an item equal to the one it rendered", async () => {
  const run = async (extra: Record<string, unknown>) => {
    const renders = new Map<string, number>();
    const Row = ({ item }: { item: Msg }) => {
      renders.set(item.id, (renders.get(item.id) ?? 0) + 1);
      return h("span", { "data-text": item.text });
    };
    const props = (data: Msg[], more: Record<string, unknown> = {}) => ({
      data,
      getFixedItemSize: () => 40,
      keyExtractor: (m: Msg) => m.id,
      renderItem: ({ item }: { item: Msg }) => h(Row, { item }),
      ...extra,
      ...more,
    });
    const first = msgs(3);
    const screen = await render(legend(props(first)));
    // Fresh but equal objects, except the second item's text.
    const next = first.map((m) => ({ ...m, text: m.id === "m1" ? "edited" : m.text }));
    await screen.rerender(legend(props(next)));
    const afterData = new Map(renders);
    const shown = texts(screen);
    await screen.rerender(legend(props(next, { extraData: 1 })));
    const afterExtra = new Map(renders);
    await screen.unmount();
    return { afterData, afterExtra, shown };
  };
  const equal = (a: Msg, b: Msg) => a.text === b.text;
  const skipped = await run({ itemsAreEqual: equal });
  assertEquals(skipped.afterData.get("m0"), 1, "equal: not rendered again");
  assertEquals(skipped.afterData.get("m2"), 1, "equal: not rendered again");
  assertEquals(skipped.afterData.get("m1"), 2, "a changed item renders");
  assertEquals(skipped.shown, ["message 0", "edited", "message 2"]);
  assertEquals(skipped.afterExtra.get("m0"), 2, "extraData renders every item again");
  const plain = await run({});
  assertEquals(plain.afterData.get("m0"), 2, "without itemsAreEqual every item renders");
  const unkeyed = await run({ itemsAreEqual: equal, keyExtractor: undefined });
  assertEquals(unkeyed.afterData.get("m0"), 2, "LegendList compares only with a keyExtractor");
});

Deno.test("LegendList adaptive render: the velocity is LegendList's weighted recent motion", () => {
  assertEquals(scrollVelocity([], 0), 0);
  assertEquals(scrollVelocity([{ scroll: 0, time: 0 }, { scroll: 100, time: 10 }], 10), 10);
  assertEquals(
    scrollVelocity([{ scroll: 0, time: 0 }, { scroll: 100, time: 10 }], 5000),
    0,
    "idle for over a second",
  );
  const back = scrollVelocity(
    [{ scroll: 500, time: 0 }, { scroll: 0, time: 10 }, { scroll: 30, time: 20 }],
    20,
  );
  assertEquals(back, 3, "a direction change cuts the window");
});

Deno.test("LegendList (DOM): experimental_adaptiveRender turns light on a fast scroll and back to normal", async () => {
  const run = async (exitDelay: number) => {
    const modes: string[] = [];
    const changes: string[] = [];
    const Row = ({ item }: { item: Msg }) => {
      const mode = useAdaptiveRender();
      if (item.id === "m0") modes.push(mode);
      useAdaptiveRenderChange((m) => item.id === "m0" && changes.push(m));
      return h("span", { "data-text": item.text });
    };
    const onChange: [string, string][] = [];
    return await withRO(async () => {
      const screen = await render(legend({
        data: msgs(200),
        estimatedItemSize: 40,
        keyExtractor: (m: Msg) => m.id,
        alwaysRender: { indices: [0] }, // the first item's hooks stay mounted while scrolled away
        experimental_adaptiveRender: {
          exitDelay,
          onChange: (m: string, reason: string) => onChange.push([m, reason]),
        },
        renderItem: ({ item }: { item: Msg }) => h(Row, { item }),
      }));
      await measureAll(() => 40);
      const before = onChange.length;
      await scrollTo(screen, 5000); // more than a viewport at once: light
      await screen.unmount(); // clears a pending return to normal
      return { modes, changes, onChange, before };
    });
  };
  // A long exit delay: the items render in light mode.
  const held = await run(60_000);
  assertEquals(held.before, 0, "normal before and at ready: no change");
  assertEquals(held.onChange, [["light", "scroll"]]);
  assertEquals(held.changes, ["light"], "useAdaptiveRenderChange hears it");
  assertEquals(held.modes.at(-1), "light", "useAdaptiveRender re-renders the item");
  // exitDelay 0: the next slow frame returns to normal at once.
  const quick = await run(0);
  assertEquals(quick.onChange[0], ["light", "scroll"]);
  assertEquals(quick.changes, ["light", "normal"]);
  assertEquals(quick.onChange.at(-1), ["normal", "scroll"]);

  const Mode = () => h("i", { "data-mode": useAdaptiveRender() });
  const plain = await render(legend({ data: msgs(3), renderItem: () => h(Mode, null) }));
  assert(all(plain).some((e) => e.getAttribute("data-mode") === "normal"), "no config: normal");
  await plain.unmount();
});
