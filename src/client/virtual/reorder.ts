/**
 * `useVirtualReorder` — drag-to-reorder for `VirtualList` rows (and grid cells): a pointer
 * drag on a handle (mouse, pen, touch) with auto-scroll near the viewport's edges, and a
 * keyboard mode (Space / Enter to pick up, arrows to move — into rows not rendered yet —
 * Space / Enter to drop, Escape to cancel) announced through a polite live region. The
 * dragged row stays mounted while it is carried far from where it started (it is passed back
 * as `keepMounted`). A separate module: a list that never imports it bundles none of it.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { useEffect, useRef, useState } from "../../runtime/hooks.ts";
import type { VirtualListHandle, VirtualListKey } from "./types.ts";

/** Options of {@linkcode useVirtualReorder}. */
export interface VirtualReorderOptions {
  /** The ref passed to the list's `ref` (its handle). */
  readonly list: { readonly current: VirtualListHandle | null };
  /** How many items the list has. */
  readonly count: number;
  /**
   * Called on drop: move the item at `from` so it ends up at index `to` (remove it, then
   * insert it at `to` — `Array.prototype.splice` semantics).
   */
  readonly onReorder: (from: number, to: number) => void;
  /** The list scrolls horizontally (arrows and edges follow the x axis). */
  readonly horizontal?: boolean;
  /** Distance (px) from a viewport edge where dragging auto-scrolls. Default 48. */
  readonly autoScrollEdge?: number;
  /** Fastest auto-scroll, in px per frame. Default 24. */
  readonly autoScrollSpeed?: number;
  /** The live-region messages (defaults are English). */
  readonly messages?: {
    readonly lifted?: (position: number, count: number) => string;
    readonly moved?: (position: number, count: number) => string;
    readonly dropped?: (from: number, to: number, count: number) => string;
    readonly cancelled?: (position: number) => string;
  };
}

/** What {@linkcode useVirtualReorder} returns. */
export interface VirtualReorder {
  /** The item being moved, or `null`. */
  readonly dragging: number | null;
  /** Where it would land now (final index), or `null`. */
  readonly target: number | null;
  /** Pass to the list's `keepMounted`: the dragged row stays mounted wherever it is carried. */
  readonly keepMounted: readonly VirtualListKey[];
  /** Spread on the drag handle inside a row (a button). */
  handleProps(index: number): Record<string, unknown>;
  /** Spread on a row's content to show the drop indicator (`data-vl-drop`). */
  itemProps(index: number): Record<string, unknown>;
  /** The current announcement. */
  readonly announcement: string;
  /** A visually hidden `role="status"` region carrying `announcement`; render it once. */
  readonly liveRegion: VNode;
}

/** The drag in flight (a ref: pointer moves never re-render). */
interface Drag {
  readonly from: number;
  readonly pointer: boolean;
  readonly startX: number;
  readonly startY: number;
  readonly startOffset: number;
  readonly el: HTMLElement | null;
  x: number;
  y: number;
  target: number;
  raf: number;
}

const HIDDEN: Record<string, string> = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: "0",
};

/** `root`'s viewport rect when it scrolls along the axis (else the window scrolls: undefined). */
function scrollingRect(root: HTMLElement | null, horizontal: boolean): DOMRect | undefined {
  if (!root) return undefined;
  const scrolls = horizontal
    ? root.scrollWidth > root.clientWidth
    : root.scrollHeight > root.clientHeight;
  return scrolls ? root.getBoundingClientRect() : undefined;
}

/** The window's inner size along the axis (0 when unknown). */
function viewportExtent(horizontal: boolean): number {
  const g = globalThis as { innerHeight?: number; innerWidth?: number };
  return (horizontal ? g.innerWidth : g.innerHeight) ?? 0;
}

/**
 * The auto-scroll step for pointer position `at` in the `[start, end)` viewport: up to `max`
 * px toward an edge the pointer is within `edge` px of, scaled by how deep it is; else 0.
 */
function edgeVelocity(at: number, start: number, end: number, edge: number, max: number): number {
  if (!(end > start)) return 0;
  if (at < start + edge) return -max * Math.min(1, (start + edge - at) / edge);
  if (at > end - edge) return max * Math.min(1, (at - (end - edge)) / edge);
  return 0;
}

/** The nearest ancestor (or self) carrying attribute `attr`. */
function closestWith(el: Element | null, attr: string): HTMLElement | null {
  for (let n: Element | null = el; n; n = n.parentElement ?? (n.parentNode as Element | null)) {
    if (n.getAttribute?.(attr) !== null && n.getAttribute?.(attr) !== undefined) {
      return n as HTMLElement;
    }
  }
  return null;
}

/** The final index for "insert before position `slot`" (0..count) when moving `from`. */
export function finalIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

/**
 * Drag-to-reorder for a `VirtualList`. Put `handleProps(index)` on a handle in each row,
 * `itemProps(index)` on the row content (drop indicator), pass `keepMounted` to the list and
 * render `liveRegion` once.
 *
 * @param options The list's ref, the item count and `onReorder`.
 * @returns Props for handles and rows, the drag state, and the live region.
 *
 * @example
 * ```tsx
 * "use client";
 * import { useRef, useVirtualReorder, VirtualList, type VirtualListHandle } from "denext";
 *
 * export function Playlist({ songs, move }) {
 *   const list = useRef<VirtualListHandle>(null);
 *   const reorder = useVirtualReorder({ list, count: songs.length, onReorder: move });
 *   return (
 *     <>
 *       <VirtualList
 *         ref={list}
 *         data={songs}
 *         keepMounted={reorder.keepMounted}
 *         style={{ height: 480 }}
 *         renderItem={(s, i) => (
 *           <div {...reorder.itemProps(i)}>
 *             <button {...reorder.handleProps(i)} aria-label={`Move ${s.title}`}>⠿</button>
 *             {s.title}
 *           </div>
 *         )}
 *       />
 *       {reorder.liveRegion}
 *     </>
 *   );
 * }
 * ```
 */
export function useVirtualReorder(options: VirtualReorderOptions): VirtualReorder {
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<Drag | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const msg = {
    lifted: (p: number, n: number) =>
      latest.current.messages?.lifted?.(p, n) ??
        `Picked up item ${p} of ${n}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
    moved: (p: number, n: number) =>
      latest.current.messages?.moved?.(p, n) ?? `Moved to position ${p} of ${n}.`,
    dropped: (f: number, t: number, n: number) =>
      latest.current.messages?.dropped?.(f, t, n) ??
        `Dropped. Moved from position ${f} to ${t} of ${n}.`,
    cancelled: (p: number) =>
      latest.current.messages?.cancelled?.(p) ?? `Cancelled. Item returned to position ${p}.`,
  };

  const handle = () => latest.current.list.current;
  const horizontal = () => !!latest.current.horizontal;

  /** Where a pointer at (x, y) would drop the dragged item (final index). */
  const targetAt = (d: Drag, x: number, y: number): number => {
    const list = handle();
    const n = latest.current.count;
    if (!list || n === 0) return d.from;
    const j = list.indexAtPoint(x, y);
    if (j < 0) {
      // Past the rows: before the first or after the last.
      const along = horizontal() ? x - d.startX : y - d.startY;
      return along < 0 ? 0 : n - 1;
    }
    const root = d.el ? closestWith(d.el, "data-denext-virtual-list") : null;
    const cell = (root as (HTMLElement & { querySelector?: (s: string) => Element | null }) | null)
      ?.querySelector?.(`[data-vl-item="${j}"]`) ??
      (root as (HTMLElement & { querySelector?: (s: string) => Element | null }) | null)
        ?.querySelector?.(`[data-vl-row][data-index="${j}"]`);
    let after = j > d.from;
    const r = cell?.getBoundingClientRect?.();
    if (r && (r.width > 0 || r.height > 0)) {
      after = horizontal() ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    }
    return Math.max(0, Math.min(n - 1, finalIndex(d.from, after ? j + 1 : j)));
  };

  /** Move the dragged element under the pointer (compensating the scroll since the start). */
  const follow = (d: Drag): void => {
    if (!d.el?.style) return;
    const list = handle();
    const scrolled = list ? list.getScrollOffset() - d.startOffset : 0;
    const dx = horizontal() ? d.x - d.startX + scrolled : 0;
    const dy = horizontal() ? 0 : d.y - d.startY + scrolled;
    d.el.style.transform = `translate(${dx}px, ${dy}px)`;
  };

  /** The auto-scroll step for the pointer's distance to the viewport edges. */
  const edgeStep = (d: Drag): number => {
    const h = horizontal();
    const rect = scrollingRect(d.el ? closestWith(d.el, "data-denext-virtual-list") : null, h);
    const start = rect ? (h ? rect.left : rect.top) : 0;
    const end = rect ? (h ? rect.right : rect.bottom) : viewportExtent(h);
    const edge = latest.current.autoScrollEdge ?? 48;
    const max = latest.current.autoScrollSpeed ?? 24;
    return edgeVelocity(h ? d.x : d.y, start, end, edge, max);
  };

  const update = (d: Drag): void => {
    follow(d);
    const t = targetAt(d, d.x, d.y);
    if (t !== d.target) {
      d.target = t;
      setTarget(t);
    }
  };

  const loop = (): void => {
    const d = drag.current;
    if (!d?.pointer) return;
    const step = edgeStep(d);
    const list = handle();
    if (step !== 0 && list) {
      list.scrollToOffset(list.getScrollOffset() + step);
      update(d);
    }
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
      .requestAnimationFrame;
    d.raf = typeof raf === "function" ? raf(loop) : 0;
  };

  const finish = (drop: boolean): void => {
    const d = drag.current;
    drag.current = null;
    cleanup.current?.();
    cleanup.current = null;
    if (!d) return;
    if (d.el?.style) d.el.style.transform = "";
    const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void })
      .cancelAnimationFrame;
    if (d.raf && typeof caf === "function") caf(d.raf);
    setDragging(null);
    setTarget(null);
    const n = latest.current.count;
    if (drop && d.target !== d.from) {
      latest.current.onReorder(d.from, d.target);
      setAnnouncement(msg.dropped(d.from + 1, d.target + 1, n));
    } else if (!d.pointer) setAnnouncement(msg.cancelled(d.from + 1));
  };

  const start = (from: number, el: HTMLElement | null, pointer: boolean, x = 0, y = 0): Drag => {
    const list = handle();
    const d: Drag = {
      from,
      pointer,
      startX: x,
      startY: y,
      startOffset: list ? list.getScrollOffset() : 0,
      el,
      x,
      y,
      target: from,
      raf: 0,
    };
    drag.current = d;
    setDragging(from);
    setTarget(from);
    return d;
  };

  const onPointerDown = (index: number) => (e: PointerEvent): void => {
    if (e.button !== undefined && e.button !== 0) return;
    const handleEl = e.currentTarget as HTMLElement;
    const el = closestWith(handleEl, "data-vl-item") ?? closestWith(handleEl, "data-vl-row");
    e.preventDefault?.();
    try {
      handleEl.setPointerCapture?.(e.pointerId);
    } catch { /* not capturable */ }
    const d = start(index, el, true, e.clientX, e.clientY);
    const move = (ev: Event): void => {
      const p = ev as PointerEvent;
      d.x = p.clientX;
      d.y = p.clientY;
      update(d);
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    const key = (ev: Event): void => {
      if ((ev as KeyboardEvent).key === "Escape") finish(false);
    };
    handleEl.addEventListener("pointermove", move);
    handleEl.addEventListener("pointerup", up);
    handleEl.addEventListener("pointercancel", cancel);
    globalThis.addEventListener?.("keydown", key);
    cleanup.current = () => {
      handleEl.removeEventListener("pointermove", move);
      handleEl.removeEventListener("pointerup", up);
      handleEl.removeEventListener("pointercancel", cancel);
      globalThis.removeEventListener?.("keydown", key);
    };
    loop();
  };

  const onKeyDown = (index: number) => (e: KeyboardEvent): void => {
    const d = drag.current;
    const n = latest.current.count;
    const fwd = horizontal() ? "ArrowRight" : "ArrowDown";
    const back = horizontal() ? "ArrowLeft" : "ArrowUp";
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation?.();
      if (!d) {
        start(index, null, false);
        setAnnouncement(msg.lifted(index + 1, n));
      } else if (!d.pointer) finish(true);
      return;
    }
    if (!d || d.pointer) return;
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
      return;
    }
    const step = e.key === fwd ? 1 : e.key === back ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    e.stopPropagation?.();
    const t = Math.max(0, Math.min(n - 1, d.target + step));
    if (t === d.target) return;
    d.target = t;
    setTarget(t);
    setAnnouncement(msg.moved(t + 1, n));
    handle()?.scrollToIndex(t, { align: "auto" });
  };

  const keepKey = dragging === null ? undefined : handle()?.keyAt(dragging);
  return {
    dragging,
    target,
    keepMounted: keepKey === undefined ? [] : [keepKey],
    handleProps: (index) => ({
      role: "button",
      tabIndex: 0,
      "aria-roledescription": "sortable",
      "aria-pressed": dragging === index ? "true" : "false",
      "data-vl-reorder-handle": String(index),
      onPointerDown: onPointerDown(index),
      onKeyDown: onKeyDown(index),
      style: { touchAction: "none", cursor: dragging === index ? "grabbing" : "grab" },
    }),
    itemProps: (index) => {
      if (dragging === null || target === null) return {};
      const out: Record<string, unknown> = {};
      if (index === dragging) out["data-vl-dragging"] = "";
      if (index === target && target !== dragging) {
        const after = target > dragging;
        out["data-vl-drop"] = after ? "after" : "before";
        const edge = horizontal()
          ? (after ? "inset -3px 0 0 0 currentColor" : "inset 3px 0 0 0 currentColor")
          : (after ? "inset 0 -3px 0 0 currentColor" : "inset 0 3px 0 0 currentColor");
        out.style = { boxShadow: edge };
      }
      return out;
    },
    announcement,
    liveRegion: h("div", { role: "status", "aria-live": "polite", style: HIDDEN }, announcement),
  };
}
