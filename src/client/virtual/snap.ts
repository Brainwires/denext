/**
 * Snap points for a scroller, as React Native's `snapToInterval` / `snapToOffsets` /
 * `snapToAlignment` / `snapToStart` / `snapToEnd` / `decelerationRate` /
 * `disableIntervalMomentum` describe them, drawn with CSS scroll snap: the scroller gets
 * `scroll-snap-type: <axis> mandatory`, and each snap point is an invisible, absolutely placed
 * (empty) marker with `scroll-snap-align`, so the browser's own momentum ends on one (natively smooth on
 * iOS and Android, no JS during the fling). Only the markers near the viewport are drawn, so a
 * long scroller costs a bounded number of elements.
 *
 * Used by `VirtualList`'s `scrollSnap` and React Native mode's `ScrollView`. Internal module.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";

/** Where a snap point meets the viewport. */
export type ScrollSnapAlign = "start" | "center" | "end";

/** Snap points, React Native's way ({@linkcode VirtualListProps.scrollSnap}). */
export interface ScrollSnapOptions {
  /** Snap every `interval` px of content (React Native's `snapToInterval`). */
  readonly interval?: number;
  /** Snap at these content offsets, in px (`snapToOffsets`; wins over `interval`). */
  readonly offsets?: readonly number[];
  /**
   * Where an interval meets the viewport (`snapToAlignment`, default `"start"`): an interval-
   * wide slot aligns its start, centre or end with the viewport's.
   */
  readonly align?: ScrollSnapAlign;
  /**
   * `"always"`: a fling stops at the next snap point instead of flying past several
   * (`decelerationRate="fast"`, `disableIntervalMomentum`). Default `"normal"`.
   */
  readonly stop?: "normal" | "always";
  /** With `offsets`: the content start is a snap point too (`snapToStart`, default `true`). */
  readonly snapToStart?: boolean;
  /** With `offsets`: the content end is a snap point too (`snapToEnd`, default `true`). */
  readonly snapToEnd?: boolean;
}

/** The most markers drawn at once. */
const MAX_MARKERS = 400;
/** How far around the viewport markers are drawn, in viewports. */
const WINDOW_VIEWPORTS = 4;

/** Whether `opts` asks for snap points at all. */
export function hasSnapPoints(opts: ScrollSnapOptions | null | undefined): boolean {
  if (!opts) return false;
  return (opts.offsets?.length ?? 0) > 0 ||
    (typeof opts.interval === "number" && opts.interval > 0);
}

/**
 * React Native's snap props as {@linkcode ScrollSnapOptions}, or `null` when none is set.
 * `pagingEnabled` is not one: a scroll view pages by its children.
 *
 * @param props The scroll view's props.
 * @returns The options, or `null`.
 */
export function snapOptionsFromProps(props: {
  readonly snapToInterval?: number;
  readonly snapToOffsets?: readonly number[];
  readonly snapToAlignment?: ScrollSnapAlign;
  readonly snapToStart?: boolean;
  readonly snapToEnd?: boolean;
  readonly decelerationRate?: "fast" | "normal" | number;
  readonly disableIntervalMomentum?: boolean;
}): ScrollSnapOptions | null {
  const opts: ScrollSnapOptions = {
    interval: props.snapToInterval,
    offsets: props.snapToOffsets,
    align: props.snapToAlignment,
    snapToStart: props.snapToStart,
    snapToEnd: props.snapToEnd,
    stop: fastDeceleration(props.decelerationRate) || props.disableIntervalMomentum === true
      ? "always"
      : "normal",
  };
  return hasSnapPoints(opts) ? opts : null;
}

/** React Native's `decelerationRate`: `"fast"` (0.99 on iOS) or a rate at or below it. */
function fastDeceleration(rate: "fast" | "normal" | number | undefined): boolean {
  return rate === "fast" || (typeof rate === "number" && rate <= 0.99);
}

/**
 * The snap positions (content px) between `from` and `to`, at most {@linkcode MAX_MARKERS}:
 * the offsets (plus the start and end, unless turned off), or each multiple of the interval
 * inside the content.
 *
 * @param opts The snap options.
 * @param content The content's length, px.
 * @param from The window's start, px.
 * @param to The window's end, px.
 * @returns The positions, ascending.
 */
export function snapPositions(
  opts: ScrollSnapOptions,
  content: number,
  from: number,
  to: number,
): number[] {
  const lo = Math.max(0, from);
  const hi = Math.min(Math.max(0, content), to);
  if (opts.offsets && opts.offsets.length > 0) {
    const all = new Set(opts.offsets.filter((o) => Number.isFinite(o) && o >= 0));
    if (opts.snapToStart !== false) all.add(0);
    if (opts.snapToEnd !== false && content > 0) all.add(content);
    return [...all].filter((o) => o >= lo && o <= hi).sort((a, b) => a - b).slice(0, MAX_MARKERS);
  }
  const step = opts.interval ?? 0;
  if (!(step > 0) || hi < lo) return [];
  const out: number[] = [];
  for (let k = Math.ceil(lo / step); k * step <= hi && out.length < MAX_MARKERS; k++) {
    out.push(k * step);
  }
  return out;
}

/**
 * The content window markers are drawn for: {@linkcode WINDOW_VIEWPORTS} viewports either side
 * of `offset`, snapped to whole viewports so it moves (and re-renders) rarely.
 *
 * @param offset The scroll offset, px.
 * @param viewport The viewport's length, px (anything under 1 counts as 1000).
 * @returns `[from, to]` in content px.
 */
export function snapWindow(offset: number, viewport: number): [number, number] {
  const vp = viewport >= 1 ? viewport : 1000;
  const page = Math.floor(Math.max(0, offset) / vp);
  return [(page - WINDOW_VIEWPORTS) * vp, (page + 1 + WINDOW_VIEWPORTS) * vp];
}

/** The scroller's style for snapping along one axis. */
export function snapContainerStyle(horizontal: boolean): Record<string, string> {
  return { scrollSnapType: `${horizontal ? "x" : "y"} mandatory` };
}

/**
 * The invisible markers for `positions`, placed in the scroller's coordinates (`shift` px from
 * content coordinates). An interval marker spans the interval, so `center` / `end` alignment
 * centres or ends that slot in the viewport; an offset marker is a point aligned to the start.
 *
 * @param opts The snap options.
 * @param positions Content positions ({@linkcode snapPositions}).
 * @param content The content's length, px (a marker never reaches past it, so it never
 * lengthens the scroll range).
 * @param horizontal Whether the scroller scrolls sideways.
 * @param shift Scroller px minus content px (0 unless the scroller maps them).
 * @param side The inline start side of a horizontal scroller (`"left"`, or `"right"` in RTL).
 * @returns The marker elements.
 */
export function snapMarkers(
  opts: ScrollSnapOptions,
  positions: readonly number[],
  content: number,
  horizontal: boolean,
  shift = 0,
  side: "left" | "right" = "left",
): VNode[] {
  const byOffsets = (opts.offsets?.length ?? 0) > 0;
  const span = byOffsets ? 0 : opts.interval ?? 0;
  const align = byOffsets ? "start" : opts.align ?? "start";
  const stop = opts.stop === "always" ? "always" : "normal";
  return positions.map((p) => {
    const size = `${Math.max(0, Math.min(span, content - p))}px`;
    return h("div", {
      key: `snap-${p}`,
      "aria-hidden": "true",
      "data-dnx-snap": String(p),
      style: {
        position: "absolute",
        pointerEvents: "none",
        scrollSnapAlign: align,
        scrollSnapStop: stop,
        ...(horizontal
          ? { top: "0", [side]: `${p + shift}px`, width: size, height: "1px" }
          : { left: "0", top: `${p + shift}px`, height: size, width: "1px" }),
      },
    });
  });
}
