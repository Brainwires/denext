"use client";

// The VirtualList impl as ONE island: the server renders its first window, the client hydrates
// the whole list once. Props are only the cell (kind, n, seed): the rows are generated from
// the seed on both sides, so no row data crosses the Flight boundary (a real app that ships
// its rows as props pays their JSON on top; results.md reports that size).

import { useEffect, useMemo, VirtualList } from "denext";
import { type Item, makeItems } from "../../shared/data.ts";
import { itemText, type SsrQuery } from "../../shared/ssr-cells.ts";
import { ESTIMATED_SIZE } from "../../shared/theme.ts";
import { ItemView } from "../../web/src/rows.tsx";
import { markHydrated } from "./hydrated.ts";
import { Like } from "./like.tsx";

export function VirtualIsland({ kind, n, seed, find }: SsrQuery & { find?: boolean }) {
  const list = useMemo(() => makeItems(kind, n, seed), [kind, n, seed]);
  useEffect(() => markHydrated(), []);
  return (
    <VirtualList<Item>
      className="sb-page"
      style={{ height: "100vh" }}
      aria-label="Bench list"
      count={list.count}
      getItem={(pos) => list.getItem(pos)}
      keyExtractor={(_item, pos) => list.keyOf(list.start + pos)}
      getItemSize={list.fixedLayout ? (_item, pos) => list.fixedSize(pos) ?? 0 : undefined}
      estimatedItemSize={ESTIMATED_SIZE[kind]}
      findInPage={find ? { text: itemText } : undefined}
      renderItem={(item) => (
        <div className="sb-item">
          <ItemView item={item} />
          <Like />
        </div>
      )}
    />
  );
}
