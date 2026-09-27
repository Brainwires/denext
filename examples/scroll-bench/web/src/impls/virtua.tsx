// `virtua`: VList. Count-based: `data` is an ArrayLike `{ length }` and the row is looked up by
// index in the render function, so no index array is built. Prepend uses virtua's `shift`
// (keeps the visible rows in place). virtua has no sticky-header support, so `sections`
// headers scroll with the rows (reported in the ready notes).

import { useLayoutEffect, useMemo, useRef } from "denext";
import { VList, type VListHandle } from "virtua";
import { FIXED } from "../../../shared/theme.ts";
import { ESTIMATED_SIZE } from "../../../shared/theme.ts";
import { ItemView } from "../rows.tsx";
import type { ImplProps } from "./types.ts";

// virtua types its viewport attributes (`style`, `className`) through the global `React`
// namespace of @types/react, which denext's compat types do not declare, so they type-check as
// missing. They work at run time; pass them through an untyped spread.
const VIEWPORT_PROPS: Record<string, unknown> = { style: { height: "100%" } };

export default function VirtuaList({ list, handleRef }: ImplProps) {
  const ref = useRef<VListHandle>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const data = useMemo(() => ({ length: list.count }), [list]);
  const lastStart = useRef(list.start);
  const shift = list.start !== lastStart.current;
  useLayoutEffect(() => {
    lastStart.current = list.start;
  });

  useLayoutEffect(() => {
    handleRef.current = {
      scrollToIndex: (pos) => ref.current?.scrollToIndex(pos, { align: "start" }),
      scrollToEnd: () => ref.current?.scrollToIndex(listRef.current.count - 1, { align: "end" }),
      scrollToStart: () => ref.current?.scrollTo(0),
      isAtEnd: () => {
        const h = ref.current;
        return !!h && h.scrollOffset + h.viewportSize >= h.scrollSize - 4;
      },
    };
  }, []);

  return (
    <VList
      ref={ref}
      data={data}
      shift={shift}
      itemSize={list.fixedLayout ? FIXED.height : ESTIMATED_SIZE[list.kind]}
      {...VIEWPORT_PROPS}
    >
      {(_: unknown, pos: number) => (
        <div key={list.keyOf(list.start + pos)}>
          <ItemView item={list.getItem(pos)} />
        </div>
      )}
    </VList>
  );
}
