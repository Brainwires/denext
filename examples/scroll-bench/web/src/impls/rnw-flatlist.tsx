// `rnw-flatlist-denext`: React Native's FlatList API as an RN
// app ships it — `import { FlatList } from "react-native"` — which in denext's React Native mode
// (`reactNative: true`, denext.config.ts) runs on denext's VirtualList ENGINE: denext replaces
// react-native-web's FlatList module with its adapter (the default, `reactNative.lists:
// "denext"`). `rnw-flatlist-rnw.tsx` renders react-native-web's own FlatList engine in the same
// app, through the per-list escape hatch. Both share this component; only the FlatList differs.
// It needs a `data` array (list.indexArray()). Fixed-layout kinds get `getItemLayout` (the
// documented FlatList fast path); measured kinds scroll to far indices through
// `onScrollToIndexFailed`, the RN idiom (denext's adapter never calls it: its scrollToIndex is
// exact; react-native-web's does).

import { useLayoutEffect, useMemo, useRef } from "denext";
// @ts-ignore: `react-native` resolves to react-native-web through denext's reactNative mode at
// build time (not through deno.json), and react-native-web ships no types.
import { FlatList as DenextFlatList } from "react-native";
import { ItemView } from "../rows.tsx";
import { frames, scrollerHandle } from "../bench.ts";
import type { ImplProps } from "./types.ts";

// deno-lint-ignore no-explicit-any
type FlatListRef = any; // react-native-web ships no types; the instance is RN's FlatList

// deno-lint-ignore no-explicit-any
type FlatListComponent = any; // RN's FlatList, from either engine

/** The shared FlatList impl over `FlatList` (denext's adapter or react-native-web's own). */
export function FlatListImpl(
  { list, handleRef, FlatList }: ImplProps & { FlatList: FlatListComponent },
) {
  const ref = useRef<FlatListRef>(null);
  const data = useMemo(() => list.indexArray(), [list]);
  const sticky = useMemo(() => list.stickyIndices(), [list]);

  useLayoutEffect(() => {
    const node = () => (ref.current?.getScrollableNode?.() ?? null) as HTMLElement | null;
    const dom = scrollerHandle(node);
    handleRef.current = {
      scrollToIndex: (pos) => ref.current?.scrollToIndex({ index: pos, animated: false }),
      scrollToEnd: () => ref.current?.scrollToEnd({ animated: false }),
      scrollToStart: () => ref.current?.scrollToOffset({ offset: 0, animated: false }),
      isAtEnd: dom.isAtEnd,
    };
  }, []);

  return (
    <FlatList
      ref={ref}
      data={data}
      keyExtractor={(v: number) => list.keyOf(v)}
      renderItem={({ item }: { item: number }) => <ItemView item={list.itemAt(item)} />}
      getItemLayout={list.fixedLayout
        ? (_d: unknown, i: number) => ({
          length: list.fixedSize(i) ?? 0,
          offset: list.fixedOffset(i) ?? 0,
          index: i,
        })
        : undefined}
      onScrollToIndexFailed={(
        info: { index: number; averageItemLength: number },
      ) => {
        ref.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: false,
        });
        void frames(2).then(() =>
          ref.current?.scrollToIndex({ index: info.index, animated: false })
        );
      }}
      stickyHeaderIndices={sticky.length ? sticky : undefined}
      maintainVisibleContentPosition={list.kind === "chat" ? { minIndexForVisible: 0 } : undefined}
      style={{ height: "100%" }}
    />
  );
}

/** `rnw-flatlist-denext`: `FlatList` from `react-native`, on denext's engine. */
export default function RnwFlatListDenext(props: ImplProps) {
  return <FlatListImpl {...props} FlatList={DenextFlatList} />;
}
