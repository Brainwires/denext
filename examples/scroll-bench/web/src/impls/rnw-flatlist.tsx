// `rnw-flatlist`: react-native-web's FlatList, the same component an RN app ships, rendering
// the same DOM rows as every other web impl (RNW Views are divs; the row content is ours).
// `react-native` resolves to react-native-web through denext's `reactNative: true` mode
// (denext.config.ts). It needs a `data` array (list.indexArray()). Fixed-layout kinds get
// `getItemLayout` (the documented FlatList fast path); measured kinds scroll to far indices
// through `onScrollToIndexFailed`, the RN idiom.

import { useLayoutEffect, useMemo, useRef } from "denext";
// @ts-ignore: `react-native` resolves to react-native-web through denext's reactNative mode at
// build time (not through deno.json), and react-native-web ships no types.
import { FlatList } from "react-native";
import { ItemView } from "../rows.tsx";
import { frames, scrollerHandle } from "../bench.ts";
import type { ImplProps } from "./types.ts";

// deno-lint-ignore no-explicit-any
type FlatListRef = any; // react-native-web ships no types; the instance is RN's FlatList

export default function RnwFlatList({ list, handleRef }: ImplProps) {
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
