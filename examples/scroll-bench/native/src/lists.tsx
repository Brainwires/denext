// The native list impls. Each renders the same rows (rows.tsx) from the same shared data and
// registers a ListHandle, so the runner (app.tsx) drives every impl the same way.
//
//   flatlist    FlatList (react-native); fixed-layout kinds get getItemLayout (its fast path)
//   flash       @shopify/flash-list v2 (no size estimates needed); chat pins the end through
//               maintainVisibleContentPosition.autoscrollToBottomThreshold
//   legend      @legendapp/list (react-native build); getFixedItemSize for fixed layouts,
//               recycleItems, maintainScrollAtEnd for chat
//   sectionlist SectionList, `sections` only (sticky section headers)

import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { type JSX, useLayoutEffect, useMemo, useRef } from "react";
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  SectionList,
  StyleSheet,
} from "react-native";
import { type BenchList, type HeaderItem, sectionOf } from "../../shared/data.ts";
import { ESTIMATED_SIZE } from "../../shared/theme.ts";
import { frames, type ListHandle } from "./bench";
import { HeaderRow, ItemView } from "./rows";

export interface ImplProps {
  list: BenchList;
  handleRef: { current: ListHandle | null };
  /** Called whenever a row is rendered (the runner's "content is on screen" signal). */
  onRow: () => void;
}

const fill = StyleSheet.create({ list: { flex: 1 } }).list;

/** onScroll → whether the list is scrolled to its end. */
function useAtEnd() {
  const atEnd = useRef(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 4;
  };
  return { atEnd, onScroll };
}

/** The part of a FlatList / FlashList ref the scrollToIndex fallback needs. */
interface IndexScrollable {
  scrollToOffset(p: { offset: number; animated?: boolean }): void;
  scrollToIndex(p: { index: number; animated?: boolean }): unknown;
}

/** RN's idiom for scrollToIndex beyond the rendered window without getItemLayout. */
function scrollToIndexFailed(ref: { current: IndexScrollable | null }) {
  return (info: { index: number; averageItemLength: number }) => {
    ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    void frames(2).then(() => ref.current?.scrollToIndex({ index: info.index, animated: false }));
  };
}

export function FlatListImpl({ list, handleRef, onRow }: ImplProps) {
  const ref = useRef<FlatList<number>>(null);
  const data = useMemo(() => list.indexArray(), [list]);
  const sticky = useMemo(() => list.stickyIndices(), [list]);
  const { atEnd, onScroll } = useAtEnd();
  useLayoutEffect(() => {
    handleRef.current = {
      scrollToIndex: (pos) => ref.current?.scrollToIndex({ index: pos, animated: false }),
      scrollToEnd: () => ref.current?.scrollToEnd({ animated: false }),
      scrollToStart: () => ref.current?.scrollToOffset({ offset: 0, animated: false }),
      isAtEnd: () => atEnd.current,
    };
  }, []);
  return (
    <FlatList
      ref={ref}
      style={fill}
      data={data}
      keyExtractor={(v) => list.keyOf(v)}
      renderItem={({ item }) => {
        onRow();
        return <ItemView item={list.itemAt(item)} />;
      }}
      getItemLayout={list.fixedLayout
        ? (_d, i) => ({
          length: list.fixedSize(i) ?? 0,
          offset: list.fixedOffset(i) ?? 0,
          index: i,
        })
        : undefined}
      onScrollToIndexFailed={scrollToIndexFailed(ref)}
      stickyHeaderIndices={sticky.length ? sticky : undefined}
      maintainVisibleContentPosition={list.kind === "chat" ? { minIndexForVisible: 0 } : undefined}
      onScroll={onScroll}
    />
  );
}

export function FlashImpl({ list, handleRef, onRow }: ImplProps) {
  const ref = useRef<FlashListRef<number>>(null);
  const data = useMemo(() => list.indexArray(), [list]);
  const sticky = useMemo(() => list.stickyIndices(), [list]);
  const chat = list.kind === "chat";
  const { atEnd, onScroll } = useAtEnd();
  useLayoutEffect(() => {
    handleRef.current = {
      scrollToIndex: (pos) => void ref.current?.scrollToIndex({ index: pos, animated: false }),
      scrollToEnd: () => ref.current?.scrollToEnd({ animated: false }),
      scrollToStart: () => ref.current?.scrollToOffset({ offset: 0, animated: false }),
      isAtEnd: () => atEnd.current,
      sticksToEnd: chat,
    };
  }, []);
  return (
    <FlashList
      ref={ref}
      style={fill}
      data={data}
      keyExtractor={(v) => list.keyOf(v)}
      getItemType={(v) => list.itemAt(v).type}
      renderItem={({ item }) => {
        onRow();
        return <ItemView item={list.itemAt(item)} />;
      }}
      stickyHeaderIndices={sticky.length ? sticky : undefined}
      maintainVisibleContentPosition={chat
        ? { autoscrollToBottomThreshold: 0.2, startRenderingFromBottom: true }
        : undefined}
      onScroll={onScroll}
    />
  );
}

export function LegendImpl({ list, handleRef, onRow }: ImplProps) {
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
      style={fill}
      data={data}
      keyExtractor={(v: number) => list.keyOf(v)}
      renderItem={({ item }: { item: number }) => {
        onRow();
        return <ItemView item={list.itemAt(item)} />;
      }}
      estimatedItemSize={ESTIMATED_SIZE[list.kind]}
      getFixedItemSize={list.fixedLayout
        ? (_v: number, i: number) => list.fixedSize(i) ?? undefined
        : undefined}
      recycleItems
      stickyHeaderIndices={sticky.length ? sticky : undefined}
      maintainScrollAtEnd={chat}
      maintainVisibleContentPosition={chat ? true : undefined}
    />
  );
}

interface SectionLocation {
  sectionIndex: number;
  itemIndex: number;
  animated: boolean;
}

export function SectionListImpl({ list, handleRef, onRow }: ImplProps) {
  const ref = useRef<SectionList<number, { key: string; header: HeaderItem }>>(null);
  const sections = useMemo(() => list.sections(), [list]);
  const starts = useMemo(() => list.stickyIndices(), [list]);
  const { atEnd, onScroll } = useAtEnd();
  const lastLocation = useRef<SectionLocation | null>(null);
  useLayoutEffect(() => {
    const locate = (pos: number): SectionLocation => {
      const s = sectionOf(starts, pos);
      return { sectionIndex: s, itemIndex: Math.max(0, pos - starts[s] - 1), animated: false };
    };
    handleRef.current = {
      scrollToIndex: (pos) => {
        lastLocation.current = locate(pos);
        ref.current?.scrollToLocation(lastLocation.current);
      },
      scrollToEnd: () => {
        const last = sections.length - 1;
        ref.current?.scrollToLocation({
          sectionIndex: last,
          itemIndex: Math.max(0, sections[last].data.length - 1),
          animated: false,
        });
      },
      scrollToStart: () =>
        ref.current?.scrollToLocation({ sectionIndex: 0, itemIndex: 0, animated: false }),
      isAtEnd: () => atEnd.current,
    };
  }, []);
  return (
    <SectionList
      ref={ref}
      style={fill}
      sections={sections}
      keyExtractor={(v) => list.keyOf(v)}
      renderItem={({ item }) => {
        onRow();
        return <ItemView item={list.itemAt(item)} />;
      }}
      renderSectionHeader={({ section }) => <HeaderRow item={section.header} />}
      stickySectionHeadersEnabled
      onScrollToIndexFailed={(info) => {
        // SectionList has no scrollToOffset: scroll its responder to the estimate, then retry.
        ref.current?.getScrollResponder()?.scrollTo({
          y: info.averageItemLength * info.index,
          animated: false,
        });
        const again = lastLocation.current;
        if (again) void frames(2).then(() => ref.current?.scrollToLocation(again));
      }}
      onScroll={onScroll}
    />
  );
}

export const NATIVE_IMPLS: Record<string, (p: ImplProps) => JSX.Element> = {
  flatlist: FlatListImpl,
  flash: FlashImpl,
  legend: LegendImpl,
  sectionlist: SectionListImpl,
};
