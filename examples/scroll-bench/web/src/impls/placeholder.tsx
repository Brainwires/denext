// `denext`: denext's own VirtualList, count-based (`count` + `getItem`, no index array). Fixed
// layouts pass exact sizes (never measured); chat starts at the end and stays pinned there
// (`anchor="end"`), and a prepend keeps the visible rows in place by key; section headers are
// the list's sticky rows.

import { useLayoutEffect, useMemo, useRef, VirtualList, type VirtualListHandle } from "denext";
import type { Item } from "../../../shared/data.ts";
import { ESTIMATED_SIZE } from "../../../shared/theme.ts";
import { ItemView } from "../rows.tsx";
import type { ImplProps } from "./types.ts";

export default function DenextVirtualList({ list, handleRef }: ImplProps) {
  const ref = useRef<VirtualListHandle>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const chat = list.kind === "chat";
  const sticky = useMemo(() => list.stickyIndices(), [list]);
  const getItem = useMemo(() => (pos: number) => list.getItem(pos), [list]);
  const getItemSize = useMemo(
    () => list.fixedLayout ? (_item: Item, pos: number) => list.fixedSize(pos) ?? 0 : undefined,
    [list],
  );

  useLayoutEffect(() => {
    handleRef.current = {
      scrollToIndex: (pos) => ref.current?.scrollToIndex(pos),
      scrollToEnd: () => ref.current?.scrollToEnd(),
      scrollToStart: () => ref.current?.scrollToOffset(0),
      isAtEnd: () => ref.current?.isAtEnd() ?? false,
      sticksToEnd: chat,
    };
  }, []);

  return (
    <VirtualList<Item>
      ref={ref}
      count={list.count}
      getItem={getItem}
      keyExtractor={(_item, pos) => listRef.current.keyOf(listRef.current.start + pos)}
      getItemSize={getItemSize}
      estimatedItemSize={ESTIMATED_SIZE[list.kind]}
      anchor={chat ? "end" : "start"}
      stickyIndices={sticky.length ? sticky : undefined}
      renderItem={(item) => <ItemView item={item} />}
      style={{ height: "100%" }}
    />
  );
}
