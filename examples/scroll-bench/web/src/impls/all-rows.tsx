// `dom` and `cv`: every row in the DOM, no virtualization. `cv` adds
// `content-visibility: auto` + `contain-intrinsic-size` per row (styles.ts), so the browser
// skips layout and paint of the rows off screen. Prepend keeps its place through the
// browser's scroll anchoring (`overflow-anchor`, Chromium; WebKit has none).

import { useLayoutEffect, useRef } from "denext";
import { ItemView } from "../rows.tsx";
import { scrollerHandle } from "../bench.ts";
import type { ImplProps } from "./types.ts";

export function AllRows({ list, handleRef, cv }: ImplProps & { cv: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    handleRef.current = scrollerHandle(() => ref.current);
  }, []);
  const rows = [];
  for (let pos = 0; pos < list.count; pos++) {
    const item = list.getItem(pos);
    rows.push(
      <div
        key={list.keyOf(list.start + pos)}
        className={item.type === "header" ? "sb-item sb-sticky" : "sb-item"}
      >
        <ItemView item={item} />
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      className={cv ? `sb-scroller sb-cv k-${list.kind}` : "sb-scroller"}
    >
      {rows}
    </div>
  );
}
