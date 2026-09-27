/**
 * `useVirtualList` — the headless half of denext's virtual list: the same engine as
 * `VirtualList` (O(log n) offsets, anchoring, momentum-safe corrections, exact `scrollToIndex`,
 * scroll scaling past the browser's height limit), returning positioned items for a custom
 * layout (grids, tables, masonry).
 *
 * @module
 */

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
} from "../../runtime/hooks.ts";
import { type LayoutMode, VirtualController } from "./controller.ts";
import { px } from "./shared.ts";
import type { UseVirtualListResult, VirtualItem, VirtualListOptions } from "./types.ts";

/** The reducer behind the controller's re-render trigger. */
function bump(n: number): number {
  return n + 1;
}

/** The controller held in `ref`, created on first use. */
function controllerIn<T>(
  ref: { current: VirtualController<T> | null },
  layout: LayoutMode,
): VirtualController<T> {
  if (ref.current === null) ref.current = new VirtualController<T>(layout);
  return ref.current;
}

/**
 * The per-list controller, fed the latest props every render and bound to the commit
 * lifecycle (internal; shared by `VirtualList` and `useVirtualList`).
 */
export function useVirtualController<T>(
  props: VirtualListOptions<T>,
  layout: LayoutMode,
): VirtualController<T> {
  const [, force] = useReducer(bump, 0);
  const ctl = controllerIn(useRef<VirtualController<T> | null>(null), layout);
  ctl.force = force as () => void;
  ctl.sync(props);
  const se = props.scrollElement;
  const scrollKey = se && typeof se === "object" && "current" in se ? se.current : se;
  // A new scroll element or axis detaches; the next commit re-attaches.
  useLayoutEffect(() => () => ctl.unmount(), [ctl, scrollKey, props.horizontal]);
  useLayoutEffect(() => {
    ctl.afterCommit();
  });
  // An ancestor scroll element's ref attaches after this list's layout effects.
  useEffect(() => {
    if (!ctl.mounted) ctl.afterCommit();
  });
  useImperativeHandle(props.ref, () => ctl.handle, [ctl]);
  return ctl;
}

/**
 * Virtualize a list with your own markup: spread `scrollProps` on the scroll container and
 * `innerProps` on the element holding the rows, then render `items`, each placed at its
 * `offset` (absolutely, e.g. `transform: translateY(offset)`) with `measureRef` attached so
 * variable sizes are measured. It takes the same options as `VirtualList` except the
 * rendering ones.
 *
 * @param options Data, sizing, anchoring and callbacks — see {@linkcode VirtualListOptions}.
 * @returns Props for the two elements, the positioned `items`, and the imperative `handle`.
 *
 * @example A two-column grid (the recipe for `numColumns`: virtualize rows of N items)
 * ```tsx
 * "use client";
 * import { useVirtualList } from "denext";
 *
 * export function Grid({ photos }: { photos: { id: string; src: string }[] }) {
 *   const columns = 2;
 *   const rows = Math.ceil(photos.length / columns);
 *   const list = useVirtualList({ count: rows, getItem: (r) => r, estimatedItemSize: 180 });
 *   return (
 *     <div {...list.scrollProps} style={{ ...list.scrollProps.style, height: "100vh" }}>
 *       <div {...list.innerProps}>
 *         {list.items.map((row) => (
 *           <div
 *             key={row.key}
 *             ref={row.measureRef}
 *             style={{
 *               position: "absolute", top: 0, left: 0, right: 0,
 *               transform: `translateY(${row.offset}px)`,
 *               display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: "8px",
 *             }}
 *           >
 *             {photos.slice(row.index * columns, row.index * columns + columns).map((p) => (
 *               <img key={p.id} src={p.src} />
 *             ))}
 *           </div>
 *         ))}
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useVirtualList<T>(options: VirtualListOptions<T>): UseVirtualListResult {
  const ctl = useVirtualController(options, "absolute");
  const core = ctl.core;
  const horizontal = !!options.horizontal;
  const items: VirtualItem[] = [];
  // The window's rows plus any kept mounted outside it (focus, `keepMounted`, a selection's
  // ends): every item carries its absolute offset, so they need no special placement.
  const keys = ctl.rows(undefined, options.recycle === true);
  for (const row of keys) {
    items.push({
      index: row.index,
      key: row.cell,
      type: row.type,
      offset: core.physicalOffset(row.index),
      size: core.tree.sizeOf(row.index),
      measureRef: ctl.measureRef(row.key),
    });
  }
  const totalSize = core.physicalSize();
  const self = options.scrollElement === undefined || options.scrollElement === "self";
  const scrollStyle: Record<string, string> = self
    ? {
      [horizontal ? "overflowX" : "overflowY"]: "auto",
      overflowAnchor: "none",
      position: "relative",
    }
    : {};
  return {
    scrollProps: { ref: ctl.rootRef, style: scrollStyle },
    innerProps: {
      ref: ctl.innerRef,
      style: {
        position: "relative",
        flex: "none",
        [horizontal ? "width" : "height"]: px(totalSize),
        [horizontal ? "height" : "width"]: "100%",
      },
    },
    totalSize,
    items,
    handle: ctl.handle,
  };
}
