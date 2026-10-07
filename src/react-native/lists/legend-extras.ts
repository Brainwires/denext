/**
 * LegendList's layout reports for React Native mode's `LegendList` adapter: the header and
 * footer sizes (`onMetricsChange`, measured with `onLayout` on a `View` around each, as LegendList
 * does) and `anchoredEndSpace` (room after the last item that keeps an anchor item at the
 * viewport's start, with LegendList's own size rule and `onSizeChanged` / `onReady` timing).
 * Internal to `legend-list.ts`.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNodeType } from "../../jsx/types.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "../../runtime/hooks.ts";
import { slotElement } from "./virtualized.ts";
import type { CoreHandle } from "./virtualized.ts";
import { type Packing, rowOfItem } from "./grid.ts";
import type { LayoutEvent, RNSlot, RNStyle, VirtualizedListProps } from "./types.ts";

/** LegendList's header and footer sizes (`onMetricsChange`). */
export interface LegendListMetrics {
  /** The header's size along the scroll axis, px (0 without one). */
  readonly headerSize: number;
  /** The footer's size along the scroll axis, px (0 without one). */
  readonly footerSize: number;
}

/** What `anchoredEndSpace.onReady` receives. */
export interface AnchoredEndSpaceReadyInfo {
  /** The anchor item's index. */
  readonly anchorIndex: number | undefined;
  /** The anchor item's key. */
  readonly anchorKey: string | undefined;
  /** The trailing space, px. */
  readonly size: number;
}

/** LegendList's `anchoredEndSpace`. */
export interface AnchoredEndSpaceConfig {
  /** The item whose row stays anchored at the start when trailing space is added. */
  readonly anchorIndex: number;
  /** Px between the viewport's start and the anchored item. Default 0. */
  readonly anchorOffset?: number;
  /** Caps the anchor item's own contribution to the content below it, px. */
  readonly anchorMaxSize?: number;
  /** Called whenever the trailing space changes. */
  readonly onSizeChanged?: (size: number) => void;
  /** Called once the anchor and every item after it have known sizes. */
  readonly onReady?: (info: AnchoredEndSpaceReadyInfo) => void;
}

/** The slice of LegendList's props these reports read. */
export interface LegendExtrasProps {
  readonly horizontal?: boolean | null;
  readonly ListHeaderComponent?: RNSlot;
  readonly ListHeaderComponentStyle?: RNStyle;
  readonly ListFooterComponent?: RNSlot;
  readonly ListFooterComponentStyle?: RNStyle;
  readonly contentContainerStyle?: RNStyle;
  readonly onMetricsChange?: (metrics: LegendListMetrics) => void;
  readonly anchoredEndSpace?: AnchoredEndSpaceConfig;
  readonly getFixedItemSize?: (item: never, index: number, type: never) => number | undefined;
  readonly getItemType?: (item: never, index: number) => string | undefined;
}

/** No header, no footer. */
const NO_METRICS: LegendListMetrics = { headerSize: 0, footerSize: 0 };

/**
 * Hook: the header and footer sizes, measured with `onLayout` on a `View` around each while
 * `onMetricsChange` or `anchoredEndSpace` needs them; `onMetricsChange` is called on mount and
 * whenever one changes. Returns the sizes and the slot props that measure them.
 */
export function useSlotMetrics(
  props: LegendExtrasProps,
  View: VNodeType,
): { metrics: LegendListMetrics; slots: Partial<VirtualizedListProps<unknown>> } {
  const wanted = !!props.onMetricsChange || !!props.anchoredEndSpace;
  const [measured, setMeasured] = useState<LegendListMetrics>(NO_METRICS);
  const horizontal = !!props.horizontal;
  const handlers = useMemo(() => {
    const on = (key: keyof LegendListMetrics) => (e: LayoutEvent): void => {
      const l = e.nativeEvent.layout;
      const size = horizontal ? l.width : l.height;
      setMeasured((m) => m[key] === size ? m : { ...m, [key]: size });
    };
    return { header: on("headerSize"), footer: on("footerSize") };
  }, [horizontal]);
  const metrics = useMemo((): LegendListMetrics => ({
    headerSize: props.ListHeaderComponent ? measured.headerSize : 0,
    footerSize: props.ListFooterComponent ? measured.footerSize : 0,
  }), [measured, !!props.ListHeaderComponent, !!props.ListFooterComponent]);
  useMetricsReport(props.onMetricsChange, metrics);
  if (!wanted) return { metrics, slots: {} };
  const wrap = (slot: RNSlot, style: RNStyle, onLayout: (e: LayoutEvent) => void) =>
    slot ? h(View, { style, onLayout }, slotElement(slot)) : slot;
  return {
    metrics,
    slots: {
      ListHeaderComponent: wrap(
        props.ListHeaderComponent,
        props.ListHeaderComponentStyle,
        handlers.header,
      ),
      ListHeaderComponentStyle: undefined,
      ListFooterComponent: wrap(
        props.ListFooterComponent,
        props.ListFooterComponentStyle,
        handlers.footer,
      ),
      ListFooterComponentStyle: undefined,
    },
  };
}

/** Hook: `onMetricsChange` with the metrics on mount and on each change. */
function useMetricsReport(
  cb: ((metrics: LegendListMetrics) => void) | undefined,
  metrics: LegendListMetrics,
): void {
  const latest = useRef(cb);
  latest.current = cb;
  const last = useRef<LegendListMetrics | null>(null);
  const wanted = !!cb;
  useEffect(() => {
    if (!wanted) {
      last.current = null;
      return;
    }
    const prev = last.current;
    if (prev && prev.headerSize === metrics.headerSize && prev.footerSize === metrics.footerSize) {
      return;
    }
    last.current = metrics;
    latest.current?.(metrics);
  }, [wanted, metrics]);
}

/** A React Native style flattened to one object (arrays merged, falsy entries skipped). */
function flatten(style: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(style)) { for (const s of style) flatten(s, out); }
  else if (style && typeof style === "object") Object.assign(out, style);
  return out;
}

/** The content container's end padding along the axis (`paddingBottom` / `paddingRight`). */
function paddingEnd(style: RNStyle, horizontal: boolean): number {
  const s = flatten(style);
  const pick = horizontal
    ? [s.paddingRight, s.paddingEnd, s.paddingHorizontal, s.padding]
    : [s.paddingBottom, s.paddingVertical, s.padding];
  const v = pick.find((x) => typeof x === "number");
  return typeof v === "number" ? v : 0;
}

/** What the anchored-space rule reads (the latest render's inputs). */
export interface AnchorInputs {
  readonly props: LegendExtrasProps;
  readonly data: readonly unknown[];
  readonly packing: Packing;
  readonly keyOf: (item: unknown, i: number) => string;
  readonly footerSize: number;
}

/** The rule's result for the current layout. */
interface AnchorResult {
  readonly size: number;
  readonly ready: boolean;
  readonly canUpdate: boolean;
  readonly anchorKey: string | undefined;
}

/**
 * A known size of item `i` (LegendList's "known or fixed"): `getFixedItemSize`, else the
 * engine's measurement of its row, else `undefined`.
 */
function knownSize(core: CoreHandle, inputs: AnchorInputs, i: number): number | undefined {
  const { props, data } = inputs;
  const fixed = props.getFixedItemSize as
    | ((item: unknown, index: number, type: string | undefined) => number | undefined)
    | undefined;
  const typeOf = props.getItemType as
    | ((item: unknown, index: number) => string | undefined)
    | undefined;
  const size = fixed?.(data[i], i, typeOf?.(data[i], i));
  if (size !== undefined) return size;
  const layout = core.engine()?.getItemLayout(core.visual(rowOfItem(inputs.packing, i)));
  return layout?.measured ? layout.size : undefined;
}

/**
 * The known size of the items from `anchorIndex` to the end (the anchor's capped at
 * `anchorMaxSize`), and whether any of them has no known size yet.
 */
function contentFrom(
  core: CoreHandle,
  inputs: AnchorInputs,
  anchorIndex: number,
  anchorMaxSize: number | undefined,
): { size: number; unknown: boolean } {
  let size = 0;
  let unknown = false;
  for (let i = anchorIndex; i < inputs.data.length; i++) {
    const known = knownSize(core, inputs, i);
    if (known === undefined) unknown = true;
    const effective = i === anchorIndex && anchorMaxSize !== undefined
      ? Math.min(known ?? 0, Math.max(0, anchorMaxSize))
      : known ?? 0;
    if (effective > 0) size += effective;
  }
  return { size, unknown };
}

/**
 * LegendList's rule: the space after the last item that lets the anchor item sit at the
 * viewport's start (`viewport − content from the anchor to the end − anchorOffset`, at least
 * 0). While an item after the anchor has no known size the space only shrinks.
 */
function anchorSpace(
  core: CoreHandle | null,
  inputs: AnchorInputs,
  previous: number | undefined,
): AnchorResult {
  const cfg = inputs.props.anchoredEndSpace;
  if (!cfg) return { size: 0, ready: true, canUpdate: true, anchorKey: undefined };
  const { anchorIndex, anchorMaxSize, anchorOffset = 0 } = cfg;
  const { data } = inputs;
  const viewport = core?.engine()?.getScrollMetrics().viewport ?? 0;
  if (!(anchorIndex >= 0 && anchorIndex < data.length && viewport > 0 && core)) {
    const waiting = anchorIndex >= 0;
    return { size: 0, ready: !waiting, canUpdate: !waiting, anchorKey: undefined };
  }
  const tail = contentFrom(core, inputs, anchorIndex, anchorMaxSize);
  const below = tail.size + inputs.footerSize +
    paddingEnd(inputs.props.contentContainerStyle, !!inputs.props.horizontal);
  const unknown = tail.unknown;
  const bound = Math.max(0, viewport - below - anchorOffset);
  return {
    size: unknown ? Math.min(previous ?? 0, bound) : bound,
    ready: !unknown,
    canUpdate: true,
    anchorKey: inputs.keyOf(data[anchorIndex], anchorIndex),
  };
}

/** The anchored space's bookkeeping between updates. */
interface AnchorState {
  applied: number | undefined;
  pendingReady: boolean;
  readyIndex: number | undefined;
  readyKey: string | undefined;
}

/**
 * Hook: `anchoredEndSpace` — the trailing space, recomputed after each commit and whenever the
 * returned `update` runs (an item measured, the list resized), with LegendList's
 * `onSizeChanged` / `onReady` calls.
 */
export function useAnchoredEndSpace(
  core: { readonly current: CoreHandle | null },
  inputs: AnchorInputs,
): { size: number; update: () => void } {
  const [size, setSize] = useState(0);
  const latest = useRef(inputs);
  latest.current = inputs;
  const state = useRef<AnchorState>({
    applied: undefined,
    pendingReady: false,
    readyIndex: undefined,
    readyKey: undefined,
  });
  const update = useMemo(() => () => {
    const s = state.current;
    const cfg = latest.current.props.anchoredEndSpace;
    if (!cfg && s.applied === undefined) return;
    const r = anchorSpace(core.current, latest.current, s.applied);
    const changed = s.applied !== r.size;
    const becameReady = r.ready && s.pendingReady;
    s.pendingReady = !r.ready;
    if (r.canUpdate && (r.ready || s.applied !== undefined) && changed) {
      s.applied = r.size;
      setSize(r.size);
      cfg?.onSizeChanged?.(r.size);
    }
    const index = cfg?.anchorIndex;
    const anchorMoved = s.readyIndex !== index || s.readyKey !== r.anchorKey;
    if (r.ready && (changed || anchorMoved || becameReady)) {
      s.readyIndex = index;
      s.readyKey = r.anchorKey;
      cfg?.onReady?.({ anchorIndex: index, anchorKey: r.anchorKey, size: r.size });
    }
  }, [core]);
  useLayoutEffect(update);
  return { size: inputs.props.anchoredEndSpace ? size : 0, update };
}

/** The data rows from the anchor to the end (kept mounted, as LegendList renders them always). */
export function anchorRows(
  cfg: AnchoredEndSpaceConfig | undefined,
  count: number,
  p: Packing,
): number[] {
  if (!cfg || !(cfg.anchorIndex >= 0) || cfg.anchorIndex >= count) return [];
  const out: number[] = [];
  for (let r = rowOfItem(p, Math.floor(cfg.anchorIndex)); r < p.rows; r++) out.push(r);
  return out;
}
