// React Native mode's `@legendapp/list/keyboard` and `@legendapp/list/reanimated` (the
// factories in src/react-native/lists/legend-integrations.ts, over `createLegendList`), the
// list's `reportContentInset`, and the `internal` helpers the package's own subpaths import.
// denext/testing's in-memory DOM; a stand-in for Reanimated's shared values.

import { assert, assertEquals } from "@std/assert";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import { useMemo, useRef } from "../src/runtime/hooks.ts";
import type { ListPrimitives } from "../src/react-native/lists/types.ts";
import {
  createLegendList,
  internal,
  legendKeyboardExports,
  type LegendListRef,
  legendReanimatedExports,
} from "../src/react-native/legend-list.ts";
import type { SharedValueLike } from "../src/react-native/lists/legend-integrations.ts";
import { all } from "./helpers/virtual-list.ts";

/** A react-native-web `View` stand-in. */
function View(props: { style?: unknown; children?: VNodeChild }): VNode {
  const flat: Record<string, unknown> = {};
  const add = (s: unknown): void => {
    if (Array.isArray(s)) s.forEach(add);
    else if (s && typeof s === "object") Object.assign(flat, s);
  };
  add(props.style);
  return h("div", { style: flat }, props.children);
}

/** A RefreshControl stand-in. */
function RefreshControl(props: { children?: VNodeChild }): VNode {
  return h("div", null, props.children);
}

const PRIM: ListPrimitives = { View, RefreshControl };
const LegendList = createLegendList(PRIM) as unknown as (p: Record<string, unknown>) => VNode;

/** A Reanimated shared value stand-in: `.value` with the listener API the web build has. */
function sharedValue<T>(initial: T): SharedValueLike<T> {
  let current = initial;
  const listeners = new Map<number, (v: T) => void>();
  return {
    get value() {
      return current;
    },
    set value(v: T) {
      current = v;
      for (const l of listeners.values()) l(v);
    },
    addListener: (id, l) => void listeners.set(id, l),
    removeListener: (id) => void listeners.delete(id),
  };
}

const reanimated = {
  useSharedValue: <T>(initial: T) => useMemo(() => sharedValue(initial), []),
};

const data = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}` }));
const common = {
  data,
  keyExtractor: (item: { id: string }) => item.id,
  getFixedItemSize: () => 40,
  renderItem: ({ item }: { item: { id: string } }) => h("span", null, item.id),
};

/** The end room's height in px (the `[data-vl-keyboard]` spacer), 0 without one. */
function room(screen: { container: unknown }): number {
  const spacer = all(screen as never).find((e) => e.getAttribute("data-vl-keyboard") !== null);
  if (!spacer) return 0;
  return Number(/height:\s*(\d+)/.exec(spacer.getAttribute("style") ?? "")?.[1] ?? NaN);
}

Deno.test("LegendList reportContentInset: a reported end inset is room after the last item", async () => {
  let ref = null as LegendListRef | null;
  const screen = await render(h(LegendList, { ...common, ref: (r: LegendListRef) => (ref = r) }));
  assertEquals(room(screen), 0);
  await act(() => ref!.reportContentInset({ bottom: 90 }));
  assertEquals(room(screen), 90, "merged over contentInset");
  await act(() => ref!.reportContentInset(null));
  assertEquals(room(screen), 0, "null clears it");
  await screen.unmount();
});

Deno.test("KeyboardAwareLegendList: the composer inset (a shared value) plus the static adjustment", async () => {
  const { KeyboardAwareLegendList } = legendKeyboardExports(reanimated, LegendList, {
    dismiss() {},
  });
  const inset = sharedValue(40);
  const screen = await render(h(KeyboardAwareLegendList, {
    ...common,
    contentInsetEndAdjustment: inset,
    contentInsetEndStaticAdjustment: 10,
    keyboardLiftBehavior: "whenAtEnd",
    freeze: sharedValue(false),
  }));
  assertEquals(room(screen), 50);
  await act(() => void (inset.value = 70));
  assertEquals(room(screen), 80, "follows the shared value");
  await screen.unmount();
});

Deno.test("useKeyboardChatComposerInset / useKeyboardScrollToEnd", async () => {
  let dismissed = 0;
  const scrolled: unknown[] = [];
  const { useKeyboardChatComposerInset, useKeyboardScrollToEnd } = legendKeyboardExports(
    reanimated,
    LegendList,
    { dismiss: () => void dismissed++ },
  );
  let api: {
    inset: ReturnType<typeof useKeyboardChatComposerInset>;
    end: ReturnType<typeof useKeyboardScrollToEnd>;
  } | null = null;
  function Host(): VNode {
    const list = useRef({ scrollToEnd: (o?: unknown) => (scrolled.push(o), Promise.resolve()) });
    const composer = useRef({ measure: (cb: (...a: number[]) => void) => cb(0, 0, 390, 64) });
    api = {
      inset: useKeyboardChatComposerInset(list, composer, 20, -4),
      end: useKeyboardScrollToEnd({ listRef: list }),
    };
    return h("i", null);
  }
  const screen = await render(h(Host, null));
  assertEquals(api!.inset.contentInsetEndAdjustment.value, 60, "measured composer − adjustment");
  api!.inset.onComposerLayout({ nativeEvent: { layout: { height: 104 } } });
  assertEquals(api!.inset.contentInsetEndAdjustment.value, 100);
  await api!.end.scrollMessageToEnd({ animated: false, closeKeyboard: true });
  assertEquals([scrolled, dismissed, api!.end.freeze.value], [[{ animated: false }], 1, false]);
  await screen.unmount();
});

Deno.test("AnimatedLegendList: the list, with sharedValues kept current", async () => {
  const { AnimatedLegendList } = legendReanimatedExports(LegendList);
  const atEnd = sharedValue<boolean | null>(null);
  const offset = sharedValue(-1);
  let ref = null as LegendListRef | null;
  const screen = await render(h(AnimatedLegendList, {
    ...common,
    ref: (r: LegendListRef) => (ref = r),
    itemLayoutAnimation: { duration: 280 },
    sharedValues: { isAtEnd: atEnd, scrollOffset: offset },
  }));
  assert(ref !== null && typeof ref!.getState === "function", "the ref is the list's");
  assertEquals(atEnd.value, ref!.getState().isAtEnd, "mirrors the list's state");
  assertEquals(offset.value, 0, "the scroll offset");
  assertEquals(all(screen).filter((e) => e.tagName === "SPAN").length, 5);
  await screen.unmount();
});

Deno.test("internal: the generic helpers @legendapp/list's own subpaths import", () => {
  const { typedForwardRef, typedMemo, useCombinedRef, useLatestRef } = internal as Record<
    string,
    unknown
  >;
  for (const f of [typedForwardRef, typedMemo, useCombinedRef, useLatestRef]) {
    assertEquals(typeof f, "function");
  }
});
