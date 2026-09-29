/**
 * React Native's `SectionList` for React Native mode, on denext's `VirtualList`: the sections
 * flatten into one list of rows — each section's header, its items and its footer, React
 * Native's `count + 2` rows per section, so `getItemLayout` indices and `scrollToLocation`'s
 * `itemIndex` (0 = the header) mean exactly what they mean in React Native — with the headers
 * as the engine's sticky rows. Viewability tokens carry `section` (and `index: null` for
 * headers and footers).
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../../jsx/types.ts";
import { useImperativeHandle, useMemo, useRef } from "../../runtime/hooks.ts";
import type { ViewToken } from "../../client/virtual/types.ts";
import { nativePlatform } from "../../mobile/bridge.ts";
import { type CoreHandle, CoreList, defaultRNKey, type EngineOptions } from "./virtualized.ts";
import { afterFrames } from "./kit.ts";
import type {
  ListPrimitives,
  ListRenderItemInfo,
  SectionData,
  SectionListProps,
  SectionListRef,
  VirtualizedListProps,
} from "./types.ts";

/** The engine's estimate for a row that renders something. */
const ROW_ESTIMATE = 48;

/** One flattened row. */
interface SectionRow {
  /** Header, item or footer. */
  readonly kind: "header" | "item" | "footer";
  /** Its section. */
  readonly section: SectionData<unknown>;
  /** The section's index. */
  readonly sectionIndex: number;
  /** The item's index in the section (items only; −1 otherwise). */
  readonly itemIndex: number;
  /** The item (items only). */
  readonly item: unknown;
  /** The section's key (`section.key`, else its index). */
  readonly sectionKey: string;
}

/** Every section's header, items and footer, in order. */
function flattenSections(sections: readonly SectionData<unknown>[]): SectionRow[] {
  const rows: SectionRow[] = [];
  sections.forEach((section, sectionIndex) => {
    const sectionKey = section.key ?? String(sectionIndex);
    const base = { section, sectionIndex, sectionKey };
    rows.push({ ...base, kind: "header", itemIndex: -1, item: undefined });
    section.data.forEach((item, itemIndex) =>
      rows.push({ ...base, kind: "item", itemIndex, item })
    );
    rows.push({ ...base, kind: "footer", itemIndex: -1, item: undefined });
  });
  return rows;
}

/** Whether this is an Android-like platform (the Android shell, or an Android browser). */
function androidLike(): boolean {
  if (nativePlatform() === "android") return true;
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "";
  return /Android/i.test(ua);
}

/** An item row's key, as React Native computes it. */
function itemKey(
  row: SectionRow,
  keyExtractor: ((item: unknown, index: number) => string) | null | undefined,
): string {
  const k = row.section.keyExtractor ?? keyExtractor;
  return k ? String(k(row.item, row.itemIndex)) : defaultRNKey(row.item, row.itemIndex);
}

/** The separator after (before, inverted) a row: item separators and section separators. */
function sectionSeparator(
  props: SectionListProps<unknown>,
): (index: number, row: unknown, extra: Record<string, unknown>) => VNodeChild {
  const { ItemSeparatorComponent, SectionSeparatorComponent } = props;
  return (_index, value, extra) => {
    const row = value as SectionRow;
    const data = row.section.data;
    const common = { highlighted: false, section: row.section };
    if (row.kind === "header") {
      if (!SectionSeparatorComponent || data.length === 0) return null;
      return h(SectionSeparatorComponent, { ...common, trailingItem: data[0], ...extra });
    }
    if (row.kind === "footer") return null;
    const last = row.itemIndex === data.length - 1;
    const Separator: VNodeType | null | undefined = last
      ? SectionSeparatorComponent
      : row.section.ItemSeparatorComponent ?? ItemSeparatorComponent;
    if (!Separator) return null;
    return h(Separator, {
      ...common,
      leadingItem: row.item,
      trailingItem: last ? undefined : data[row.itemIndex + 1],
      ...extra,
    });
  };
}

/** Viewability tokens in React Native's section form. */
function sectionTokens(
  keys: { current: SectionListProps<unknown>["keyExtractor"] },
): (tokens: ViewToken<unknown>[]) => ViewToken<unknown>[] {
  return (tokens) =>
    tokens.map((t) => {
      const row = t.item as SectionRow;
      if (row.kind !== "item") {
        return { ...t, item: row.section, key: row.sectionKey, index: null, section: row.section };
      }
      return {
        ...t,
        item: row.item,
        key: itemKey(row, keys.current),
        index: row.itemIndex,
        section: row.section,
      };
    });
}

/** The row renderer: section headers, footers and items. */
function sectionRender(
  props: SectionListProps<unknown>,
): (info: ListRenderItemInfo<unknown>) => VNodeChild {
  const { renderItem, renderSectionHeader, renderSectionFooter } = props;
  return (info) => {
    const row = info.item as SectionRow;
    const section = row.section;
    if (row.kind === "header") return renderSectionHeader ? renderSectionHeader({ section }) : null;
    if (row.kind === "footer") return renderSectionFooter ? renderSectionFooter({ section }) : null;
    const render = section.renderItem ?? renderItem;
    return render
      ? render({ item: row.item, index: row.itemIndex, section, separators: info.separators })
      : null;
  };
}

/**
 * The flattened row of `scrollToLocation`'s target (React Native's arithmetic: `itemIndex`
 * counts from the section's header).
 */
function locationIndex(
  sections: readonly SectionData<unknown>[],
  sectionIndex: number,
  itemIndex: number,
): number {
  let index = itemIndex;
  for (let i = 0; i < sectionIndex; i++) index += sections[i].data.length + 2;
  return index;
}

/** The SectionList ref. */
function sectionHandle(
  core: { current: CoreHandle | null },
  latest: { current: SectionListProps<unknown> },
  sticky: { current: boolean },
): SectionListRef {
  const c = () => core.current;
  return {
    scrollToLocation(params) {
      const handle = c();
      if (!handle) return;
      const index = locationIndex(latest.current.sections, params.sectionIndex, params.itemIndex);
      const under = params.itemIndex > 0 && sticky.current;
      const go = () => {
        const size = under ? headerSize(handle, index - params.itemIndex) : 0;
        handle.scrollToIndex({ ...params, index, viewOffset: (params.viewOffset ?? 0) + size });
        return size;
      };
      const first = go();
      // The header may not have been measured yet (its size was an estimate): once the scroll
      // has rendered it, land again under its real size.
      if (under) {
        void afterFrames().then(() => {
          if (Math.abs(headerSize(handle, index - params.itemIndex) - first) >= 0.5) {
            go();
          }
        });
      }
    },
    recordInteraction: () => c()?.recordInteraction(),
    flashScrollIndicators() {},
    getScrollResponder: () => c()?.getScrollResponder() ?? null,
    getScrollableNode: () => c()?.getScrollableNode() ?? null,
  };
}

/** A flattened row's current size (measured, else estimated). */
function headerSize(handle: CoreHandle, row: number): number {
  return handle.engine()?.getItemLayout(handle.visual(row))?.size ?? 0;
}

/** The sticky header rows (`+ 1` for a list header, as the core expects React Native's). */
function headerIndices(rows: readonly SectionRow[], listHeader: boolean): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === "header") out.push(i + (listHeader ? 1 : 0));
  });
  return out;
}

/**
 * React Native's `SectionList` on denext's `VirtualList`.
 *
 * @param prim react-native-web's primitives (React Native mode passes the app's own).
 * @returns The component.
 */
export function createSectionList(
  prim: ListPrimitives,
): (props: SectionListProps<unknown>) => VNode {
  function SectionList(props: SectionListProps<unknown>): VNode {
    const core = useRef<CoreHandle | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const keys = useRef(props.keyExtractor);
    keys.current = props.keyExtractor;
    const sticky = useRef(true);
    sticky.current = props.stickySectionHeadersEnabled ?? !androidLike();
    const sections = props.sections;
    const rows = useMemo(() => flattenSections(sections ?? []), [sections]);
    const { renderItem, renderSectionHeader, renderSectionFooter } = props;
    const { ItemSeparatorComponent, SectionSeparatorComponent } = props;
    const render = useMemo(
      () => sectionRender(props),
      [renderItem, renderSectionHeader, renderSectionFooter],
    );
    const separator = useMemo(
      () => sectionSeparator(props),
      [ItemSeparatorComponent, SectionSeparatorComponent],
    );
    const engine = useMemo((): EngineOptions => ({
      separator,
      convertTokens: sectionTokens(keys),
      estimatedSize: (i) => {
        const r = rows[i];
        if (r.kind === "header") return renderSectionHeader ? ROW_ESTIMATE : 0;
        if (r.kind === "footer") return renderSectionFooter ? ROW_ESTIMATE : 0;
        return ROW_ESTIMATE;
      },
    }), [separator, rows, renderSectionHeader, renderSectionFooter]);
    useImperativeHandle(props.ref, () => sectionHandle(core, latest, sticky), []);
    const layout = props.getItemLayout;
    const list: VirtualizedListProps<unknown> = {
      ...props,
      ref: undefined,
      data: rows,
      getItem: getRow,
      getItemCount: countRows,
      renderItem: render,
      keyExtractor: (row: unknown) => rowKey(row as SectionRow, keys.current),
      getItemLayout: layout ? (_rows, i) => layout(latest.current.sections, i) : undefined,
      stickyHeaderIndices: sticky.current
        ? headerIndices(rows, !!props.ListHeaderComponent)
        : props.stickyHeaderIndices,
    };
    return h(CoreList, { list, prim, engine, coreRef: core });
  }
  return SectionList;
}

/** Row `i` of the flattened rows (stable, so the model stays put). */
function getRow(rows: unknown, i: number): unknown {
  return (rows as SectionRow[])[i];
}

/** How many flattened rows there are. */
function countRows(rows: unknown): number {
  return (rows as SectionRow[]).length;
}

/** A flattened row's engine key. */
function rowKey(row: SectionRow, keyExtractor: SectionListProps<unknown>["keyExtractor"]): string {
  if (row.kind === "item") return `${row.sectionKey}:${itemKey(row, keyExtractor)}`;
  return `${row.sectionKey}:${row.kind}`;
}
