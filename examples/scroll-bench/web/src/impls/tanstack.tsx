// `tanstack`: @tanstack/react-virtual, headless. Count-based (never builds an index array).
// Fixed-layout kinds get exact sizes and are not measured (the library's recommended setup);
// chat and images are measured with `measureElement`. Sticky section headers use the
// library's documented `rangeExtractor` recipe. No built-in "keep position on prepend": the
// handle re-anchors on the first visible row after a prepend (what an app would do).

import { useLayoutEffect, useMemo, useRef } from "denext";
import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { type BenchList, sectionOf } from "../../../shared/data.ts";
import { ESTIMATED_SIZE } from "../../../shared/theme.ts";
import { ItemView } from "../rows.tsx";
import { type ListHandle, scrollerHandle } from "../bench.ts";
import type { ImplProps } from "./types.ts";

/** The library's documented sticky recipe: always render the active section header. */
function stickyRange(sticky: number[]): ((range: Range) => number[]) | undefined {
  if (!sticky.length) return undefined;
  return (range) => {
    const out = defaultRangeExtractor(range);
    const active = sticky[sectionOf(sticky, range.startIndex)];
    return out.includes(active) ? out : [active, ...out];
  };
}

const activeHeader = (sticky: number[], first: number) =>
  sticky.length ? sticky[sectionOf(sticky, first)] : -1;

const STICKY = { position: "sticky", top: 0, zIndex: 1 } as const;
const placed = (start: number) => ({
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  transform: `translateY(${start}px)`,
} as const);

type Virtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, HTMLDivElement>>;

function tanstackHandle(
  v: Virtualizer,
  listRef: { current: BenchList },
  el: () => HTMLElement | null,
): ListHandle {
  let firstVisible = 0;
  return {
    scrollToIndex: (pos) => v.scrollToIndex(pos, { align: "start" }),
    scrollToEnd: () => v.scrollToIndex(listRef.current.count - 1, { align: "end" }),
    scrollToStart: () => v.scrollToOffset(0),
    isAtEnd: scrollerHandle(el).isAtEnd,
    beforePrepend: () => {
      firstVisible = v.range?.startIndex ?? 0;
    },
    afterPrepend: (k) => v.scrollToIndex(firstVisible + k, { align: "start" }),
  };
}

export default function TanstackList({ list, handleRef }: ImplProps) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const sticky = useMemo(() => list.stickyIndices(), [list]);

  const v = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: list.count,
    getScrollElement: () => ref.current,
    estimateSize: (i) => listRef.current.fixedSize(i) ?? ESTIMATED_SIZE[listRef.current.kind],
    getItemKey: (i) => listRef.current.keyOf(listRef.current.start + i),
    overscan: 4,
    rangeExtractor: stickyRange(sticky),
  });

  useLayoutEffect(() => {
    handleRef.current = tanstackHandle(v, listRef, () => ref.current);
  }, []);

  const active = activeHeader(sticky, v.range?.startIndex ?? 0);
  // Fixed layouts are exact (no measuring); chat and images are measured.
  const measure = list.fixedLayout ? undefined : v.measureElement;
  return (
    <div ref={ref} className="sb-scroller">
      <div style={{ height: `${v.getTotalSize()}px`, position: "relative", width: "100%" }}>
        {v.getVirtualItems().map((vi) => (
          <div
            key={String(vi.key)}
            data-index={vi.index}
            ref={measure}
            style={vi.index === active ? STICKY : placed(vi.start)}
          >
            <ItemView item={list.getItem(vi.index)} />
          </div>
        ))}
      </div>
    </div>
  );
}
