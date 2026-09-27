// `legend`: @legendapp/list's DOM build (`@legendapp/list/react`), on denext's React. It needs
// a `data` array: the list's virtual indices (list.indexArray()). Fixed-layout kinds pass
// `getFixedItemSize`; rows are stateless, so `recycleItems` is on (the library's fast path).
// Chat uses `maintainScrollAtEnd` + data-change `maintainVisibleContentPosition`, its own
// answers to streaming append and history prepend.

import { useLayoutEffect, useMemo, useRef } from "denext";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ESTIMATED_SIZE } from "../../../shared/theme.ts";
import { ItemView } from "../rows.tsx";
import type { ImplProps } from "./types.ts";

export default function LegendImpl({ list, handleRef }: ImplProps) {
  const ref = useRef<LegendListRef>(null);
  const data = useMemo(() => list.indexArray(), [list]);
  const sticky = useMemo(() => list.stickyIndices(), [list]);
  const chat = list.kind === "chat";

  useLayoutEffect(() => {
    handleRef.current = {
      scrollToIndex: (pos) => void ref.current?.scrollToIndex({ index: pos, animated: false }),
      scrollToEnd: () => void ref.current?.scrollToEnd({ animated: false }),
      scrollToStart: () => void ref.current?.scrollToOffset({ offset: 0, animated: false }),
      isAtEnd: () => ref.current?.getState().isAtEnd ?? false,
      sticksToEnd: chat,
    };
  }, []);

  return (
    <LegendList
      ref={ref}
      data={data}
      keyExtractor={(v: number) => list.keyOf(v)}
      renderItem={({ item }: { item: number }) => <ItemView item={list.itemAt(item)} />}
      estimatedItemSize={ESTIMATED_SIZE[list.kind]}
      getFixedItemSize={list.fixedLayout
        ? (_v: number, i: number) => list.fixedSize(i) ?? undefined
        : undefined}
      recycleItems
      stickyHeaderIndices={sticky.length ? sticky : undefined}
      maintainScrollAtEnd={chat}
      maintainVisibleContentPosition={chat ? true : undefined}
      style={{ height: "100%" }}
    />
  );
}
