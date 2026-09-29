// A server-rendered list: every row as plain HTML (a Server Component, so no client JS for the
// list itself). `cv` adds `content-visibility: auto` + `contain-intrinsic-size` per row (the
// SPA's `cv` classes); `control` adds one per-row control, whose mechanism the route picks.

import type { JSX } from "denext";
import { makeItems } from "../../shared/data.ts";
import type { SsrQuery } from "../../shared/ssr-cells.ts";
import { ItemView } from "../../web/src/rows.tsx";

export interface StaticListProps extends SsrQuery {
  cv: boolean;
  /** The row's control (a client island, a resumable island or a plain button), if any. */
  control?: () => JSX.Element;
}

export function StaticList({ kind, n, seed, cv, control }: StaticListProps) {
  const list = makeItems(kind, n, seed);
  const rows: JSX.Element[] = [];
  for (let pos = 0; pos < list.count; pos++) {
    rows.push(
      <div key={pos} className="sb-item" role="listitem" data-i={pos}>
        <ItemView item={list.getItem(pos)} />
        {control?.()}
      </div>,
    );
  }
  return (
    <div
      className={cv ? `sb-scroller sb-page sb-cv k-${kind}` : "sb-scroller sb-page"}
      role="list"
      aria-label="Bench list"
    >
      {rows}
    </div>
  );
}

/** A like button as plain HTML: the delegated impl's LikeDelegate island makes it live. */
export function StaticLike() {
  return (
    <button type="button" className="sb-like" data-like="" aria-pressed="false" aria-label="Like">
      ♡
    </button>
  );
}
