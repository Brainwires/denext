/**
 * `VirtualList` — denext's virtualized list component: renders only the rows near the
 * viewport of a list of any size (1M–10M rows), measuring rows as they render (no size
 * estimates required), keeping the visible rows still when content above changes, with chat
 * anchoring, sticky rows, grids, exact `scrollToIndex`, find-in-page, keyboard navigation,
 * viewability, scroll restoration and React Native's scroll events. Built with `h()`
 * (framework source carries no JSX).
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { Component, VNode, VNodeChild, VNodeChildren } from "../../jsx/types.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../../runtime/hooks.ts";
import type { RowView, VirtualController } from "./controller.ts";
import { px, slot } from "./shared.ts";
import {
  hasSnapPoints,
  snapContainerStyle,
  snapMarkers,
  snapPositions,
  snapWindow,
} from "./snap.ts";
import { useVirtualController } from "./use-virtual-list.ts";
import { devFamily } from "../dev-family.ts";
import type { VirtualListProps } from "./types.ts";

/** Default cap on find-in-page stubs. */
const FIND_LIMIT = 2000;

/** Delay before a row-count change is announced (coalesces bursts). */
const ANNOUNCE_MS = 500;

/** Visually hidden, still read by screen readers. */
const VISUALLY_HIDDEN: Record<string, string> = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: "0",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: "0",
};

/** Props of the memoized row body. */
interface RowBodyProps<T> {
  readonly item: T;
  readonly index: number;
  readonly type: string | number;
  readonly render: VirtualListProps<T>["renderItem"];
}

/**
 * One row's content. A plain component: denext bails out of re-rendering a component whose
 * props are shallow-equal, so a row re-renders only when its item, index, type or
 * `renderItem` changes — scrolling and data changes elsewhere leave it alone.
 */
const RowBody = /* @__PURE__ */ devFamily(
  function RowBody<T>(props: RowBodyProps<T>): VNode {
    return props.render(props.item, props.index, { type: props.type }) as VNode;
  },
  "denext:virtual-list#RowBody",
);

/** Whether `hidden="until-found"` + `beforematch` are supported (Chromium 102+). */
function findSupported(): boolean {
  const g = globalThis as { document?: Document; HTMLElement?: { prototype: object } };
  if (!g.document || !g.HTMLElement) return false;
  return "onbeforematch" in g.HTMLElement.prototype;
}

/** A native listener target. */
interface Listenable {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** Focus + find-in-page listeners on the list's root element. */
function useRootListeners<T>(ctl: VirtualController<T>): void {
  useLayoutEffect(() => {
    const root = ctl.root as unknown as Partial<Listenable> | null;
    if (!root || typeof root.addEventListener !== "function") return;
    const target = root as Listenable;
    const onFocusIn = (e: Event): void => ctl.focusIn(e.target);
    const onFocusOut = (e: Event): void => ctl.focusOut((e as FocusEvent).relatedTarget);
    const onMatch = (e: Event): void => {
      const raw = (e.target as Element | null)?.getAttribute?.("data-vl-stub");
      if (raw !== null && raw !== undefined) ctl.reveal(Number(raw));
    };
    target.addEventListener("focusin", onFocusIn);
    target.addEventListener("focusout", onFocusOut);
    target.addEventListener("beforematch", onMatch);
    return () => {
      target.removeEventListener("focusin", onFocusIn);
      target.removeEventListener("focusout", onFocusOut);
      target.removeEventListener("beforematch", onMatch);
    };
  }, [ctl]);
}

/**
 * The polite live region's message for `announceChanges`: set (after a short delay) when the
 * row count changes, never on mount.
 */
function useCountAnnouncement(
  count: number,
  option: VirtualListProps<unknown>["announceChanges"],
): string {
  const [message, setMessage] = useState("");
  const prev = useRef<number | null>(null);
  const latest = useRef(option);
  latest.current = option;
  useEffect(() => {
    const before = prev.current;
    prev.current = count;
    if (!latest.current || before === null || before === count) return;
    const timer = setTimeout(() => {
      const opt = latest.current;
      if (!opt) return;
      setMessage(typeof opt === "function" ? opt(count, before) : `${count} items`);
    }, ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [count]);
  return message;
}

/** The inline-start side along a horizontal list (right in RTL). */
function startSide<T>(ctl: VirtualController<T>): "left" | "right" {
  return ctl.rtl ? "right" : "left";
}

/** The padding property that holds the row gap after a row. */
function gapSide<T>(ctl: VirtualController<T>, horizontal: boolean): string {
  if (!horizontal) return "paddingBottom";
  return ctl.rtl ? "paddingLeft" : "paddingRight";
}

/** The trailing margin property (a detached sticky row takes no space in the flow). */
function trailingMarginSide<T>(ctl: VirtualController<T>, horizontal: boolean): string {
  if (!horizontal) return "marginBottom";
  return ctl.rtl ? "marginLeft" : "marginRight";
}

/** The style of one row element. */
function rowStyle<T>(
  ctl: VirtualController<T>,
  row: RowView<T>,
  sticky: boolean,
  props: VirtualListProps<T>,
  last: boolean,
): Record<string, string> | undefined {
  const horizontal = !!props.horizontal;
  const style: Record<string, string> = horizontal ? { flex: "none" } : {};
  const rowGap = props.rowGap ?? props.gap ?? 0;
  if (rowGap > 0 && !last) style[gapSide(ctl, horizontal)] = px(rowGap);
  if (row.placement === "persisted") return persistedStyle(ctl, row, style, horizontal);
  if (sticky) {
    style.position = "sticky";
    style[horizontal ? startSide(ctl) : "top"] = "0";
    style.zIndex = "1";
  }
  if (row.placement === "sticky-detached") {
    style[trailingMarginSide(ctl, horizontal)] = px(-ctl.core.tree.sizeOf(row.index));
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/** A persisted row (kept mounted outside the window): absolutely placed at its offset. */
function persistedStyle<T>(
  ctl: VirtualController<T>,
  row: RowView<T>,
  style: Record<string, string>,
  horizontal: boolean,
): Record<string, string> {
  const tree = ctl.core.tree;
  const at = px(tree.offsetOf(row.index) - tree.offsetOf(ctl.core.range.first));
  return horizontal
    ? { ...style, position: "absolute", [startSide(ctl)]: at, top: "0", bottom: "0" }
    : { ...style, position: "absolute", top: at, left: "0", right: "0" };
}

/** How find-in-page reads an item's text: `findInPage.text`, `estimateText`, or a string item. */
function stubTextOf<T>(
  opt: { text?: (item: T, index: number) => string | undefined },
  props: VirtualListProps<T>,
): (item: T, index: number) => string | undefined {
  if (opt.text) return opt.text;
  const estimate = props.estimateText;
  if (estimate) return (item: T) => estimate.text(item);
  return (item: T) => typeof item === "string" ? item : undefined;
}

/** The searchable text of engine row `line` (its items' texts, space-joined; "" when none). */
function lineText<T>(
  ctl: VirtualController<T>,
  line: number,
  textOf: (item: T, index: number) => string | undefined,
): string {
  const [a, b] = ctl.itemsOf(line);
  const parts: string[] = [];
  for (let i = a; i < b; i++) {
    const t = textOf(ctl.itemAt(i), i);
    if (t) parts.push(t);
  }
  return parts.join(" ");
}

/** The find-in-page stubs for rows outside the rendered window. */
function findStubs<T>(ctl: VirtualController<T>, props: VirtualListProps<T>): VNode[] {
  const opt = typeof props.findInPage === "object" ? props.findInPage : {};
  const textOf = stubTextOf(opt, props);
  const core = ctl.core;
  const n = core.tree.count;
  const limit = Math.max(0, opt.limit ?? FIND_LIMIT);
  const from = Math.max(0, Math.min(n - limit, core.visible().first - (limit >> 1)));
  const to = Math.min(n - 1, from + limit - 1);
  const horizontal = !!props.horizontal;
  const side = startSide(ctl);
  const out: VNode[] = [];
  for (let line = from; line <= to; line++) {
    if (line >= core.range.first && line <= core.range.last) continue;
    const text = lineText(ctl, line, textOf);
    if (!text) continue;
    const at = px(core.physicalOffset(line));
    out.push(h("div", {
      key: ctl.keyAt(line),
      hidden: "until-found",
      "data-vl-stub": String(line),
      style: horizontal
        ? { position: "absolute", top: "0", [side]: at }
        : { position: "absolute", left: "0", right: "0", top: at },
    }, text));
  }
  return out;
}

// `devFamily`: a bundled dev Fast Refresh that re-evaluates this module reconciles the list
// (and its rows) in place instead of remounting them at the top (see dev-family.ts).
/**
 * A virtualized list: renders only the rows near the viewport, so 1M–10M rows scroll as fast
 * as 100. Rows are measured as they render (`estimatedItemSize` is only a hint), rows keep
 * their identity (and state) across data changes, and content changes above the viewport
 * never move what you are looking at — including on iOS, where the list never writes the
 * scroll offset during a fling. Past the browser's element-height limit the scroll space is
 * scaled, and `scrollToIndex` still lands exactly.
 *
 * **Chat:** `anchor="end"` starts at the bottom, bottom-aligns short content, stays pinned
 * while at the bottom (appends, a streaming last message, the keyboard opening with
 * `keyboardInset`), and `onStartReached` loads history without a jump. **Sections:**
 * `stickyIndices` (the real row sticks, so it stays focusable; the next header pushes it up).
 * **Grids:** `numColumns` + `gap`. **Accessibility:** `role="list"` / `"listitem"` with
 * `aria-setsize` / `aria-posinset`, Arrow / Page / Home / End (and optional typeahead)
 * navigation into rows not yet rendered, and the focused row stays mounted while scrolled
 * away. **SSR:** the server renders the first window (at `initialScrollIndex`, or the end
 * for `anchor="end"`), which hydrates without moving. **React Native parity:**
 * `onViewableItemsChanged`, `onScroll` / momentum events, `refreshControl`,
 * `contentContainerStyle`, `ListHeaderComponentStyle`.
 *
 * **Testing:** without a `ResizeObserver` (as under `denext/testing`) nothing is measured:
 * sizes come from `getItemSize` (exact) or the estimates, and the viewport from the scroller's
 * `clientHeight`, else `viewportSize` (default 800) — so `render(<VirtualList>)` shows a
 * deterministic set of rows with no layout engine.
 *
 * @param props See {@linkcode VirtualListProps}; the `ref` receives a
 * {@linkcode VirtualListHandle}.
 * @returns The list element.
 *
 * @example A chat thread
 * ```tsx
 * "use client";
 * import { VirtualList } from "denext";
 *
 * export function Thread({ messages, loadOlder }) {
 *   return (
 *     <VirtualList
 *       style={{ height: "100%" }}
 *       data={messages}
 *       keyExtractor={(m) => m.id}
 *       anchor="end"
 *       onStartReached={loadOlder}
 *       renderItem={(m) => <Message message={m} />}
 *     />
 *   );
 * }
 * ```
 */
export const VirtualList: <T>(props: VirtualListProps<T>) => VNode = /* @__PURE__ */ devFamily(
  function VirtualList<T>(
    props: VirtualListProps<T>,
  ): VNode {
    const ctl = useVirtualController(props, "flow");
    const [findReady, setFindReady] = useState(false);
    const wantFind = !!props.findInPage;
    useEffect(() => {
      setFindReady(wantFind && findSupported());
    }, [wantFind]);
    useRootListeners(ctl);
    const announcement = useCountAnnouncement(
      ctl.itemCount(),
      props.announceChanges as VirtualListProps<unknown>["announceChanges"],
    );
    const self = props.scrollElement === undefined || props.scrollElement === "self";
    const control = props.refreshControl;
    const scroller = h(
      "div",
      {
        ...props.scrollerProps,
        ref: ctl.rootRef,
        class: control ? undefined : props.class ?? props.className,
        "data-denext-virtual-list": "",
        ...(ctl.printing ? { "data-vl-printing": "" } : {}),
        style: outerStyle(props, self, ctl.printing, !!control),
      },
      contentContainer(props, scrollContent(ctl, props, self, findReady)),
      ...snapNodes(ctl, props, self),
      props.announceChanges ? announceRegion(announcement) : null,
    );
    return control ? refreshWrapper(control, props, scroller) : scroller;
  },
  "denext:virtual-list#VirtualList",
);

/** An element whose size moves the list (header, footer, bottom-align spacer). */
function metricsSlot<T>(
  ctl: VirtualController<T>,
  key: string,
  attr: string | null,
  content: VNodeChild,
  style?: Readonly<Record<string, string | number>>,
): VNode {
  return h("div", {
    key,
    ref: ctl.metricsRef(key),
    ...(attr ? { [attr]: "" } : {}),
    style: { flex: content === null ? "1 1 auto" : "none", ...style },
  }, content);
}

/** The scroller's content: spacer, header, rows (or empty state), footer, keyboard room. */
function scrollContent<T>(
  ctl: VirtualController<T>,
  props: VirtualListProps<T>,
  self: boolean,
  findReady: boolean,
): VNodeChild[] {
  const count = ctl.core.tree.count;
  const printing = ctl.printing;
  const bottomAlign = self && props.anchor === "end" && count > 0 && !printing;
  const header = props.ListHeaderComponent;
  const footer = props.ListFooterComponent;
  return [
    bottomAlign ? metricsSlot(ctl, "spacer", null, null) : null,
    header
      ? metricsSlot(ctl, "header", "data-vl-header", slot(header), props.ListHeaderComponentStyle)
      : null,
    count === 0 ? emptyBody(props) : listBody(ctl, props, findReady && !printing),
    footer
      ? metricsSlot(ctl, "footer", "data-vl-footer", slot(footer), props.ListFooterComponentStyle)
      : null,
    keyboardRoom(props),
  ];
}

/** Room after the rows for an overlaying on-screen keyboard (`keyboardInset`). */
function keyboardRoom<T>(props: VirtualListProps<T>): VNode | null {
  const inset = Math.max(0, props.keyboardInset ?? 0);
  if (inset <= 0) return null;
  return h("div", {
    key: "keyboard",
    "data-vl-keyboard": "",
    "aria-hidden": "true",
    style: { flex: "none", [props.horizontal ? "width" : "height"]: px(inset) },
  });
}

/** The content wrapped in the content container when it is styled (`contentContainerStyle`). */
function contentContainer<T>(props: VirtualListProps<T>, content: VNodeChild[]): VNodeChildren {
  const containerClass = props.contentContainerClass ?? props.contentContainerClassName;
  if (!props.contentContainerStyle && !containerClass) return content;
  return h("div", {
    key: "content",
    "data-vl-content": "",
    class: containerClass,
    style: {
      display: "flex",
      flexDirection: props.horizontal ? "row" : "column",
      flex: "1 0 auto",
      ...props.contentContainerStyle,
    },
  }, ...content);
}

/**
 * The snap markers of `scrollSnap` near the viewport, in scroller coordinates (a content offset
 * sits `delta` px earlier in the scroller). None while printing, for an external scroller, or
 * when the scroll space is scaled (offsets there are not 1:1).
 */
function snapNodes<T>(
  ctl: VirtualController<T>,
  props: VirtualListProps<T>,
  self: boolean,
): VNode[] {
  const opts = props.scrollSnap;
  const core = ctl.core;
  if (!opts || !hasSnapPoints(opts) || !self || ctl.printing || core.scaled) return [];
  const content = core.lead + core.total + core.tail;
  const [from, to] = snapWindow(core.v + core.lead, core.vp);
  const positions = snapPositions(opts, content, from, to);
  return snapMarkers(opts, positions, content, !!props.horizontal, -core.delta, startSide(ctl));
}

/** The polite live region of `announceChanges`. */
function announceRegion(message: string): VNode {
  return h("div", {
    key: "announce",
    role: "status",
    "aria-live": "polite",
    "data-vl-announce": "",
    style: VISUALLY_HIDDEN,
  }, message);
}

/** The pull-to-refresh control around the scroller (React Native's `refreshControl`). */
function refreshWrapper<T>(
  control: NonNullable<VirtualListProps<T>["refreshControl"]>,
  props: VirtualListProps<T>,
  scroller: VNode,
): VNode {
  const outer = {
    class: props.class ?? props.className,
    style: { display: "flex", flexDirection: "column", ...props.style },
  };
  if (typeof control === "function") {
    return h(control, {
      refreshing: props.refreshing === true,
      onRefresh: props.onRefresh,
      progressViewOffset: props.progressViewOffset,
      ...outer,
    }, scroller);
  }
  const el = control as VNode;
  const own = el.props as Record<string, unknown>;
  return h(el.type as Component<Record<string, unknown>>, {
    ...own,
    key: el.key ?? undefined,
    class: own.class ?? outer.class,
    style: own.style ?? outer.style,
    children: undefined,
  }, scroller);
}

/** The outer element's style: a flex scroller (self) or a flex container. */
function outerStyle<T>(
  props: VirtualListProps<T>,
  self: boolean,
  printing: boolean,
  wrapped: boolean,
): Record<string, string | number> {
  const horizontal = !!props.horizontal;
  const flex = { display: "flex", flexDirection: horizontal ? "row" : "column" };
  const user = wrapped ? {} : props.style;
  if (printing) {
    return { ...flex, ...user, overflow: "visible", height: "auto", maxHeight: "none" };
  }
  if (!self) return { ...flex, ...user };
  return {
    [horizontal ? "overflowX" : "overflowY"]: "auto",
    overflowAnchor: "none",
    position: "relative",
    ...(hasSnapPoints(props.scrollSnap) ? snapContainerStyle(horizontal) : {}),
    ...flex,
    [horizontal ? "width" : "height"]: "100%",
    ...(wrapped ? { flex: "1 1 auto", minHeight: "0", minWidth: "0" } : {}),
    ...user,
  };
}

/** The empty state (it grows to fill the viewport). */
function emptyBody<T>(props: VirtualListProps<T>): VNode | null {
  if (!props.ListEmptyComponent) return null;
  return h("div", {
    key: "empty",
    "data-vl-empty": "",
    style: { flex: "1 1 auto", display: "flex", flexDirection: "column" },
  }, slot(props.ListEmptyComponent));
}

/** The inner element: the flow window of rows, and the find-in-page stubs. */
function listBody<T>(
  ctl: VirtualController<T>,
  props: VirtualListProps<T>,
  findReady: boolean,
): VNode {
  const horizontal = !!props.horizontal;
  const printing = ctl.printing;
  const margin = horizontal ? (ctl.rtl ? "marginRight" : "marginLeft") : "marginTop";
  return h(
    "div",
    {
      key: "inner",
      ref: ctl.innerRef,
      "data-vl-inner": "",
      style: {
        position: "relative",
        flex: "none",
        display: "flow-root",
        [horizontal ? "width" : "height"]: printing ? "auto" : px(ctl.core.physicalSize()),
        ...(horizontal ? {} : { width: "100%" }),
      },
    },
    h("div", {
      ref: ctl.winRef,
      role: "list",
      "aria-label": props["aria-label"],
      "aria-labelledby": props["aria-labelledby"],
      onKeyDown: keyHandler(ctl, props),
      style: {
        position: "relative",
        [margin]: printing ? "0px" : px(ctl.windowOffset),
        ...(horizontal ? { display: "flex", flexDirection: "row" } : {}),
      },
    }, rowNodes(ctl, props)),
    findReady
      ? h("div", {
        "data-vl-find": "",
        style: { position: "absolute", top: "0", left: "0", width: "100%", height: "0" },
      }, findStubs(ctl, props))
      : null,
  );
}

/** What every row of one render shares. */
interface RowContext<T> {
  readonly ctl: VirtualController<T>;
  readonly props: VirtualListProps<T>;
  /** Engine rows. */
  readonly count: number;
  /** Items. */
  readonly items: number;
  readonly cols: number;
  readonly keyboard: boolean;
  /** The roving-tabindex position (an engine row, or an item in a grid). */
  readonly tabbable: number;
  readonly stickyLines: ReadonlySet<number>;
}

/** The rendered rows: the range plus any detached sticky / persisted row. */
function rowNodes<T>(ctl: VirtualController<T>, props: VirtualListProps<T>): VNode[] {
  const count = ctl.core.tree.count;
  const items = ctl.itemCount();
  const cols = ctl.columns;
  const rows = ctl.rows(props.stickyIndices, props.recycle === true);
  const active = Math.min(ctl.activeIndex, (cols === 1 ? count : items) - 1);
  const activeLine = ctl.lineOf(active);
  const tabbable = rows.some((r) => r.index === activeLine)
    ? active
    : ctl.itemRange(ctl.core.visible()).first;
  const rc: RowContext<T> = {
    ctl,
    props,
    count,
    items,
    cols,
    keyboard: props.keyboardNavigation !== false,
    tabbable,
    stickyLines: new Set(ctl.stickyLines()),
  };
  return rows.map((row) => rowNode(rc, row));
}

/** One row element: a placeholder, a list item, or a grid line of cells. */
function rowNode<T>(rc: RowContext<T>, row: RowView<T>): VNode {
  const { ctl, props } = rc;
  const last = row.index === rc.count - 1;
  const common = {
    key: row.cell,
    ref: ctl.measureRef(row.key),
    "data-index": String(row.index),
    "data-vl-row": "",
    style: rowStyle(ctl, row, rc.stickyLines.has(row.index), props, last),
  };
  if (!row.ready) return placeholderRow(rc, row, common);
  const Separator = props.ItemSeparatorComponent;
  const separator = Separator && !last ? slot(Separator) : null;
  if (rc.cols === 1) {
    return h(
      "div",
      {
        ...common,
        role: "listitem",
        "aria-setsize": String(rc.count),
        "aria-posinset": String(row.index + 1),
        tabIndex: tabIndexOf(rc, row.index),
      },
      h(RowBody as Component<RowBodyProps<T>>, {
        item: row.item,
        index: row.index,
        type: row.type,
        render: props.renderItem,
      }),
      separator,
    );
  }
  return h(
    "div",
    { ...common, role: "none" },
    h("div", { style: gridLineStyle(props, rc.cols) }, gridCells(rc, row.index)),
    separator,
  );
}

/** The roving `tabIndex` of keyboard position `at` (undefined without keyboard navigation). */
function tabIndexOf<T>(rc: RowContext<T>, at: number): number | undefined {
  if (!rc.keyboard) return undefined;
  return at === rc.tabbable ? 0 : -1;
}

/** A row whose content has not rendered yet (progressive mode): its size, or the placeholder. */
function placeholderRow<T>(
  rc: RowContext<T>,
  row: RowView<T>,
  common: Record<string, unknown>,
): VNode {
  const { ctl, props } = rc;
  const size = px(ctl.core.tree.sizeOf(row.index));
  return h(
    "div",
    { ...common, role: "none", "aria-hidden": "true", "data-vl-placeholder": "" },
    props.renderPlaceholder
      ? props.renderPlaceholder(row.index * rc.cols)
      : h("div", { style: { [props.horizontal ? "width" : "height"]: size } }),
  );
}

/** The cells of grid line `line`. */
function gridCells<T>(rc: RowContext<T>, line: number): VNode[] {
  const { ctl, props } = rc;
  const [from, to] = ctl.itemsOf(line);
  const cells: VNode[] = [];
  for (let i = from; i < to; i++) {
    cells.push(h("div", {
      key: i - from,
      role: "listitem",
      "aria-setsize": String(rc.items),
      "aria-posinset": String(i + 1),
      "data-vl-item": String(i),
      tabIndex: tabIndexOf(rc, i),
      style: { minWidth: "0", minHeight: "0" },
    }, gridCell(ctl, props, i)));
  }
  return cells;
}

/** Grid item `i`'s content. */
function gridCell<T>(ctl: VirtualController<T>, props: VirtualListProps<T>, i: number): VNode {
  return h(RowBody as Component<RowBodyProps<T>>, {
    item: ctl.itemAt(i),
    index: i,
    type: props.getItemType ? props.getItemType(ctl.itemAt(i), i) : 0,
    render: props.renderItem,
  });
}

/** One grid line's layout: `numColumns` equal tracks with the column gap. */
function gridLineStyle<T>(
  props: VirtualListProps<T>,
  cols: number,
): Record<string, string | number> {
  const gap = px(Math.max(0, props.columnGap ?? props.gap ?? 0));
  const tracks = `repeat(${cols}, minmax(0, 1fr))`;
  return {
    display: "grid",
    ...(props.horizontal
      ? { gridTemplateRows: tracks, rowGap: gap, height: "100%" }
      : { gridTemplateColumns: tracks, columnGap: gap }),
    ...props.columnWrapperStyle,
  };
}

/**
 * Arrow / Page / Home / End on a row (a cell in a grid) — not on controls inside it — moves
 * focus; a letter jumps by typeahead when enabled.
 */
function keyHandler<T>(
  ctl: VirtualController<T>,
  props: VirtualListProps<T>,
): (e: KeyboardEvent) => void {
  const enabled = props.keyboardNavigation !== false;
  const typeahead = !!props.typeahead;
  return (e) => {
    if (!enabled) return;
    const target = e.target as Element | null;
    const isRow = target?.getAttribute?.("data-vl-row") !== null &&
      target?.getAttribute?.("data-vl-row") !== undefined;
    const isCell = target?.getAttribute?.("data-vl-item") !== null &&
      target?.getAttribute?.("data-vl-item") !== undefined;
    if (!(ctl.columns === 1 ? isRow : isCell)) return;
    const from = ctl.positionOf(target);
    if (from === undefined) return;
    let next = ctl.navigationTarget(e.key, from);
    if (
      next === null && typeahead && e.key.length === 1 && e.key !== " " && !e.ctrlKey &&
      !e.metaKey && !e.altKey
    ) {
      next = ctl.typeaheadTarget(e.key, from);
    }
    if (next === null) return;
    e.preventDefault();
    ctl.focusRow(next);
  };
}
