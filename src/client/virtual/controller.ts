/**
 * The DOM side of `VirtualList` / `useVirtualList`: reads scroll offsets and viewport metrics,
 * feeds measurements from one shared `ResizeObserver`, tracks touch gestures, applies the
 * layout the engine computes (the inner element's size and the rendered window's offset) and
 * performs the scroll writes it asks for — never while a touch gesture or its fling is in
 * flight (iOS WebKit cancels momentum on any scroll write), always in one synchronous step with
 * the matching layout so no frame paints in between.
 *
 * It also owns the list's opt-in behaviours, each costing nothing unless its prop is set:
 * grids (`numColumns`: the engine sizes lines of items), rows kept mounted off-screen (focus,
 * `keepMounted`, a text selection's ends), progressive rendering, print mode, sticky-header
 * push, viewability, React Native scroll events, scroll restoration and layout animations.
 *
 * Without a `ResizeObserver` (server, `denext/testing`, very old engines) nothing is measured
 * and every size comes from `getItemSize` / estimates: the deterministic test mode.
 *
 * @module
 */

import { type CoreConfig, type CoreSource, DEFAULT_CONFIG, type Key, VirtualCore } from "./core.ts";
import { DEFAULT_MAX_PHYSICAL_SIZE } from "./scale.ts";
import type { SizeTree } from "./size-tree.ts";
import { createTextEstimator } from "./text-estimate.ts";
import { RecyclePool } from "./recycle.ts";
import { defaultKey, px } from "./shared.ts";
import { FlipSnapshot, type ItemLayoutAnimationOptions } from "./animate.ts";
import { historyEntryId, loadSnapshot, type RestoreSnapshot, saveSnapshot } from "./restore.ts";
import { devRestoreEnabled, devRestoreKey, devSnapshotApplies, devStamp } from "./dev-restore.ts";
import {
  scrollEvent,
  ScrollSession,
  type VirtualListScrollEvent,
  wantsScrollEvents,
} from "./scroll-events.ts";
import { ViewabilityTracker, type ViewportRow } from "./viewability.ts";
import type {
  ScrollToIndexOptions,
  VirtualListHandle,
  VirtualListOptions,
  VirtualListProps,
  VirtualListRange,
} from "./types.ts";

/** The viewport assumed without layout (SSR, first render, tests). */
const DEFAULT_VIEWPORT = 800;

/** Quiet period (ms) after the finger lifts that ends a fling where `scrollend` is missing. */
const SETTLE_MS = 250;

/** Idle fallback (ms) that ends a fling even where `scrollend` exists. */
const IDLE_MS = 1000;

/**
 * Quiet period (ms) with no measurement after which a landed scroll target is released even if
 * rows in the window never reported a size (hidden or placeholder rows).
 */
const TARGET_QUIET_MS = 500;

/** Time budget (ms) of one background hint-seeding slice. */
const SEED_SLICE_MS = 4;

/**
 * Most rows rendered before the first measurement of a list given no size information (React
 * Native's `initialNumToRender` default): they are sized by a guess, and laying out many more
 * rows than fit before the first paint is the bulk of such a list's time to first render.
 */
const PROBE_ROWS = 10;

/** Whether frames are painted here (a browser): the first window then waits for one. */
function paints(): boolean {
  return typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ===
    "function";
}

/** A learned default row size is replaced when the measured average moves by this fraction. */
const LEARN_TOLERANCE = 0.1;

/** Quiet period (ms) after a non-touch scroll that counts as "at rest". */
const REST_MS = 150;

/** A scroll event this soon (ms) after the list's own write, at its offset, is programmatic. */
const WRITE_ECHO_MS = 250;

/** Default cap on rows rendered for printing. */
const DEFAULT_PRINT_LIMIT = 1000;

/** Time budget (ms) of one progressive-rendering slice. */
const PROGRESS_BUDGET_MS = 6;

/** Most rows the typeahead search visits per key press. */
const TYPEAHEAD_SCAN = 100_000;

/** Most rows searched for a persisted (kept-mounted) key before it counts as gone. */
const PERSIST_SCAN = 1_000_000;

/** How the rows are positioned: flowing inside a shifted window, or absolutely by offset. */
export type LayoutMode = "flow" | "absolute";

/** How the list scrolls. */
type ScrollMode = "self" | "window" | "element";

/** The DOM names behind one scroll axis. */
interface Axis {
  /** Element scroll offset. */
  readonly offset: "scrollTop" | "scrollLeft";
  /** Element viewport size. */
  readonly client: "clientHeight" | "clientWidth";
  /** Element viewport size across the axis. */
  readonly crossClient: "clientWidth" | "clientHeight";
  /** Element content extent. */
  readonly extent: "scrollHeight" | "scrollWidth";
  /** Rect size. */
  readonly size: "height" | "width";
  /** Window scroll offset. */
  readonly winOffset: "scrollY" | "scrollX";
  /** Window viewport size. */
  readonly winSize: "innerHeight" | "innerWidth";
  /** Window viewport size across the axis. */
  readonly winCross: "innerWidth" | "innerHeight";
  /** The flow window's offset property (CSS). */
  readonly margin: "margin-top" | "margin-left" | "margin-right";
  /** A detached sticky row's trailing margin (CSS). */
  readonly trailingMargin: "margin-bottom" | "margin-right" | "margin-left";
  /** The inset a sticky row sticks by (CSS). */
  readonly inset: "top" | "left" | "right";
  /** The border width before the content box (`clientTop` / `clientLeft`), if any. */
  readonly border: "clientTop" | "clientLeft" | null;
  /** A rect's leading edge, in coordinates that grow along the list. */
  lead(r: DOMRect): number;
  /** A rect's trailing edge, in the same coordinates. */
  trail(r: DOMRect): number;
}

const VERTICAL: Axis = {
  offset: "scrollTop",
  client: "clientHeight",
  crossClient: "clientWidth",
  extent: "scrollHeight",
  size: "height",
  winOffset: "scrollY",
  winSize: "innerHeight",
  winCross: "innerWidth",
  margin: "margin-top",
  trailingMargin: "margin-bottom",
  inset: "top",
  border: "clientTop",
  lead: (r) => r.top,
  trail: (r) => r.bottom,
};

const HORIZONTAL: Axis = {
  offset: "scrollLeft",
  client: "clientWidth",
  crossClient: "clientHeight",
  extent: "scrollWidth",
  size: "width",
  winOffset: "scrollX",
  winSize: "innerWidth",
  winCross: "innerHeight",
  margin: "margin-left",
  trailingMargin: "margin-right",
  inset: "left",
  border: "clientLeft",
  lead: (r) => r.left,
  trail: (r) => r.right,
};

/**
 * Horizontal in a right-to-left context: the list grows leftward. A plain literal, not a
 * spread of `HORIZONTAL`: a module-level spread is not provably side-effect free, so the
 * bundler would keep these tables in every app importing `denext`, list or not.
 */
const HORIZONTAL_RTL: Axis = {
  offset: "scrollLeft",
  client: "clientWidth",
  crossClient: "clientHeight",
  extent: "scrollWidth",
  size: "width",
  winOffset: "scrollX",
  winSize: "innerWidth",
  winCross: "innerHeight",
  margin: "margin-right",
  trailingMargin: "margin-left",
  inset: "right",
  border: null,
  lead: (r) => -r.right,
  trail: (r) => -r.left,
};

/** Lead / tail when there is no layout. */
const NO_LAYOUT = { lead: 0, tail: 0 } as const;

/** A numeric DOM property, 0 when missing or not a number. */
function num(obj: unknown, key: string): number {
  return Number((obj as Record<string, unknown> | null | undefined)?.[key]) || 0;
}

/** Whether a rect comes from a real layout (test DOMs report all-zero rects). */
function hasLayout(rect: DOMRect | undefined): rect is DOMRect {
  return rect !== undefined && (rect.width !== 0 || rect.height !== 0);
}

/**
 * Search outward from `center` over `[0, n)` — `center`, `center + 1`, `center − 1`, … — for
 * the first index `match` accepts (at most {@linkcode PERSIST_SCAN} steps each way); −1 if none.
 */
function scanOutward(center: number, n: number, match: (i: number) => boolean): number {
  for (let d = 0; d < n && d <= PERSIST_SCAN; d++) {
    const lo = center - d;
    const hi = center + d;
    if (lo < 0 && hi >= n) break;
    if (hi < n && match(hi)) return hi;
    if (d > 0 && lo >= 0 && match(lo)) return lo;
  }
  return -1;
}

/** The last index of the sorted sticky `lines` whose natural offset is at or above `v` (−1). */
function activeStickyAt(lines: readonly number[], tree: SizeTree, v: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tree.offsetOf(lines[mid]) <= v + 0.5) {
      active = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return active;
}

/** The grid column under the cross-axis coordinate `across` of a `[start, start + size)` span. */
function columnAt(across: number, start: number, size: number, cols: number): number {
  if (!(size > 0)) return 0;
  return Math.max(0, Math.min(cols - 1, Math.floor(((across - start) / size) * cols)));
}

/** The item count the props describe (`data`'s length, else `count`). */
function itemCountOf<T>(props: ControllerProps<T>): number {
  return props.data ? props.data.length : Math.max(0, Math.floor(props.count ?? 0));
}

/** Items per engine row (`numColumns`, at least 1). */
function columnsOf<T>(props: ControllerProps<T>): number {
  return Math.max(1, Math.floor(props.numColumns ?? 1));
}

/** The gap between engine rows (`rowGap`, else `gap`; never negative). */
function rowGapOf<T>(props: ControllerProps<T>): number {
  return Math.max(0, props.rowGap ?? props.gap ?? 0);
}

/** Item `i` of `data`, else of `getItem` (undefined when neither is set). */
function itemFrom<T>(
  data: readonly T[] | undefined,
  getItem: ((i: number) => T) | undefined,
  i: number,
): T {
  return data ? data[i] : (getItem ? getItem(i) : undefined as T);
}

/** The average of the non-negative `value(i)` over up to 32 evenly spaced `i` in `[0, n)`. */
function sampledAverage(n: number, value: (i: number) => number): number | undefined {
  const samples = Math.min(n, 32);
  let sum = 0;
  let got = 0;
  for (let k = 0; k < samples; k++) {
    const v = value(Math.floor((k * (n - 1)) / Math.max(1, samples - 1)));
    if (v >= 0) {
      sum += v;
      got++;
    }
  }
  return got > 0 ? sum / got : undefined;
}

/** A line's size hint from its items' hints: the tallest item, plus the gap unless last. */
function lineHint(
  one: (i: number) => number,
  items: number,
  cols: number,
  count: number,
  gap: number,
): ((line: number) => number) | undefined {
  if (cols === 1 && gap === 0) return one;
  return (line: number) => {
    let size = 0;
    for (let i = line * cols; i < Math.min(items, line * cols + cols); i++) {
      size = Math.max(size, one(i));
    }
    return size + (line < count - 1 ? gap : 0);
  };
}

/** A row about to render. */
export interface RowView<T> {
  /** Engine row (the line, in a grid). */
  readonly index: number;
  readonly key: Key;
  /** Reconciler key (the recycling cell key, or `key`). */
  readonly cell: Key;
  /** The row's item (a grid line's first item). */
  readonly item: T;
  readonly type: string | number;
  /** Where it sits relative to the rendered window. */
  readonly placement: "flow" | "sticky-detached" | "persisted";
  /** Its content has rendered (progressive mode renders a placeholder first). */
  readonly ready: boolean;
}

/** Props the controller reads beyond the shared options (VirtualList's). */
type ControllerProps<T> =
  & VirtualListOptions<T>
  & Partial<
    Pick<
      VirtualListProps<T>,
      | "numColumns"
      | "rowGap"
      | "gap"
      | "stickyIndices"
      | "progressive"
      | "printLimit"
      | "itemLayoutAnimation"
      | "findInPage"
      | "typeahead"
      | "keyboardInset"
    >
  >;

// ---- style helpers ----------------------------------------------------------------------

/** An element's inline style declaration, when it has one. */
function styleOf(el: Element): CSSStyleDeclaration | undefined {
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  return style && typeof style.setProperty === "function" ? style : undefined;
}

/**
 * Set one inline style property (CSS name; `""` removes it). Elements without a style
 * declaration (the in-memory test DOM) get their `style` attribute rewritten with the
 * property merged in.
 */
function setStyleProperty(el: Element, name: string, value: string): void {
  const style = styleOf(el);
  if (style) {
    if (style.getPropertyValue(name) === value) return;
    if (value === "") style.removeProperty(name);
    else style.setProperty(name, value);
    return;
  }
  const decls = new Map<string, string>();
  for (const part of (el.getAttribute?.("style") ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at > 0) decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  if ((decls.get(name) ?? "") === value) return;
  if (value === "") decls.delete(name);
  else decls.set(name, value);
  el.setAttribute?.("style", [...decls].map(([k, v]) => `${k}:${v}`).join(";"));
}

// ---- the shared ResizeObserver ----------------------------------------------------------

/** The one ResizeObserver every list shares, with each element's owning handler. */
interface SharedObserver {
  readonly ctor: unknown;
  readonly ro: ResizeObserver;
  readonly owners: WeakMap<Element, (entries: ResizeObserverEntry[]) => void>;
}

let shared: SharedObserver | undefined;

/** The shared observer (created on first use; re-created if the global was replaced). */
function sharedObserver(): SharedObserver | undefined {
  const Ctor = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof Ctor !== "function") return undefined;
  if (shared && shared.ctor === Ctor) return shared;
  const owners = new WeakMap<Element, (entries: ResizeObserverEntry[]) => void>();
  const ro = new Ctor((entries) => {
    const groups = new Map<(entries: ResizeObserverEntry[]) => void, ResizeObserverEntry[]>();
    for (const entry of entries) {
      const owner = owners.get(entry.target);
      if (!owner) continue;
      let list = groups.get(owner);
      if (!list) groups.set(owner, list = []);
      list.push(entry);
    }
    for (const [owner, list] of groups) owner(list);
  });
  shared = { ctor: Ctor, ro, owners };
  return shared;
}

/** An entry's border-box size along the axis. */
function entrySize(entry: ResizeObserverEntry, horizontal: boolean): number {
  const box = entry.borderBoxSize as unknown as
    | ResizeObserverSize
    | readonly ResizeObserverSize[]
    | undefined;
  const b = Array.isArray(box) ? box[0] : box as ResizeObserverSize | undefined;
  if (b) return horizontal ? b.inlineSize : b.blockSize;
  const rect = rectOf(entry.target);
  if (rect) return horizontal ? rect.width : rect.height;
  return horizontal ? entry.contentRect?.width ?? 0 : entry.contentRect?.height ?? 0;
}

/** `el.getBoundingClientRect()` where supported. */
function rectOf(el: Element | null | undefined): DOMRect | undefined {
  const fn = (el as { getBoundingClientRect?: () => DOMRect } | null | undefined)
    ?.getBoundingClientRect;
  if (typeof fn !== "function") return undefined;
  try {
    return fn.call(el);
  } catch {
    return undefined;
  }
}

/** Whether the development flag is on. */
function isDev(): boolean {
  return (globalThis as { __denextDev?: boolean }).__denextDev === true;
}

/** A clock in ms. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Listener options for scroll/touch listeners. */
const PASSIVE: AddEventListenerOptions = { passive: true };

/** The global scope as an event target (`window`), or `undefined` off the browser. */
function windowTarget(): EventTarget | undefined {
  const g = globalThis as { addEventListener?: unknown; document?: unknown };
  return typeof g.addEventListener === "function" && g.document
    ? globalThis as EventTarget
    : undefined;
}

/** The document, when there is one with listeners. */
function documentTarget(): (EventTarget & { body?: Element | null }) | undefined {
  const d = (globalThis as { document?: EventTarget & { body?: Element | null } }).document;
  return d && typeof d.addEventListener === "function" ? d : undefined;
}

/** Run `fn` after the next frame paints (rAF + a task), else on a task. */
function afterPaint(fn: () => void): void {
  const raf =
    (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (typeof raf === "function") raf(() => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

/** A row's searchable / typeahead text, from the options that can supply one. */
function textAccessor<T>(
  p: ControllerProps<T>,
  explicit?: ((item: T, index: number) => string) | boolean,
): (item: T, index: number) => string | undefined {
  if (typeof explicit === "function") return explicit;
  const find = typeof p.findInPage === "object" ? p.findInPage.text : undefined;
  if (find) return find;
  const est = p.estimateText?.text;
  if (est) return (item) => est(item);
  return (
    item,
  ) => (typeof item === "string" ? item : typeof item === "number" ? String(item) : undefined);
}

/**
 * The per-list controller: owns the engine, the DOM bindings and the imperative handle.
 * Created once per mounted list (in a ref) and fed the latest props on every render.
 */
export class VirtualController<T> {
  readonly core: VirtualCore = new VirtualCore();
  readonly layout: LayoutMode;
  /** Re-render the component (set by the hook every render). */
  force: () => void = () => {};
  props: ControllerProps<T> = {};

  /** Our outer element (flow) or the user's scroll element (absolute). */
  root: Element | null = null;
  /** The element sized to the physical extent. */
  inner: Element | null = null;
  /** The flow window (rows in normal flow, offset by a margin). */
  win: Element | null = null;

  readonly #elKey = new WeakMap<Element, Key>();
  readonly #keyEl = new Map<Key, Element>();
  readonly #refs = new Map<Key, (el: Element | null) => void>();
  /** Rendered keys → index (rebuilt every render). */
  #keyIndex = new Map<Key, number>();
  #pool: RecyclePool | undefined;

  #mode: ScrollMode = "self";
  #scroller: Element | null = null;
  /** Horizontal list in a right-to-left context. */
  rtl = false;
  #initialized = false;
  #synced = false;
  #mounted = false;
  #touching = false;
  #touchMoved = false;
  #momentum = false;
  #scrollEnd = false;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  #restTimer: ReturnType<typeof setTimeout> | undefined;
  #targetTimer: ReturnType<typeof setTimeout> | undefined;
  /** The first window has painted (the overscan is added after it). */
  #painted = false;
  #paintScheduled = false;
  #seedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Sum and count of every size measured so far (for a list given no size information). */
  #measuredSum = 0;
  #measuredCount = 0;
  /** The default row size learned from measurements (no `estimatedItemSize` or hints given). */
  #learnedSize: number | undefined;
  #pendingWrite: { smooth: boolean } | null = null;
  #renderedFirst = 0;
  #renderedDelta = 0;
  #lastVisible: VirtualListRange = { first: -1, last: -2 };
  #detachedKey: Key | null = null;
  /** The key of the row holding focus (kept mounted while it is scrolled away). */
  focusKey: Key | null = null;
  /** Row keys a non-collapsed text selection starts / ends in (kept mounted). */
  #selectionKeys: Key[] = [];
  /** Key → last known engine row, for rows kept mounted off-screen. */
  readonly #hints = new Map<Key, number>();
  /** Roving-tabindex position: an engine row, or an item in a grid. */
  activeIndex = 0;
  #pendingFocus: number | null = null;
  #crossSize = 0;
  #estimator: { opts: unknown; fn: (item: T) => number } | undefined;
  #cleanup: (() => void) | undefined;
  /** Items per engine row (`numColumns`). */
  #cols = 1;
  /** Cached lead / tail for window / ancestor scrolling (re-read on resize, not per scroll). */
  #leadCache: { lead: number; tail: number } | null = null;
  /**
   * The last lead / tail read could not see the tail: the rendered window overflowed the inner
   * box (rows measured larger than their estimates, the layout not caught up yet), so the
   * overflow covered the footer and the extent read it as 0. Re-read once the layout is applied.
   */
  #tailObscured = false;
  /** Rows whose content has rendered (progressive mode). */
  readonly #ready = new Set<Key>();
  #progressScheduled = false;
  /** Measured render cost per progressive row (ms, moving average). */
  #progressCost = 2;
  #progressStart: { t: number; n: number } | null = null;
  /** Print mode: render up to `printLimit` rows in flow. */
  printing = false;
  #pushedKey: Key | null = null;
  #stickyCache: { src: readonly number[] | undefined; cols: number; lines: number[] } | undefined;
  #session: ScrollSession | undefined;
  #lastWrite = { raw: NaN, t: -Infinity };
  #smoothWrite = false;
  /** The current scroll session was started by the list's own write. */
  #sessionProgrammatic = false;
  #trackers: ViewabilityTracker<T>[] = [];
  /** Scroll restoration: `restoreKey`'s, or the automatic dev one (`dev`: see dev-restore.ts). */
  #restore: { entry: string; key: string; pending: boolean; dev: boolean } | undefined;
  #flip: { snap: FlipSnapshot; oldNear: Set<Key> } | undefined;
  #typeahead = { buffer: "", t: 0 };
  #gridToken: { base: unknown; cols: number; token: object } | undefined;

  /** The imperative handle (stable for the list's lifetime). */
  readonly handle: VirtualListHandle;

  /** @param layout How rows are positioned. */
  constructor(layout: LayoutMode) {
    this.layout = layout;
    this.handle = {
      scrollToIndex: (index, options) => this.scrollToIndex(this.lineOf(index), options),
      scrollToOffset: (offset, options) => this.#jump(offset, options?.behavior === "smooth"),
      scrollToEnd: (options) => this.scrollToEnd(options?.behavior === "smooth"),
      getRange: () => this.itemRange(this.core.visible()),
      isAtEnd: () => this.core.isAtEnd(),
      getScrollOffset: () => this.core.v,
      indexAtPoint: (x, y) => this.indexAtPoint(x, y),
      keyAt: (index) => index >= 0 && index < this.itemCount() ? this.itemKeyAt(index) : undefined,
      recordInteraction: () => {
        for (const t of this.#trackers) t.interact();
        this.#notify();
      },
      getScrollableNode: () => this.#mode === "window" ? null : this.#scroller ?? this.root,
      getItemLayout: (index) => {
        if (!(index >= 0 && index < this.itemCount())) return undefined;
        this.core.flushSeed();
        const line = this.lineOf(Math.floor(index));
        const tree = this.core.tree;
        return {
          offset: tree.offsetOf(line),
          size: tree.sizeOf(line),
          measured: tree.isMeasured(line),
        };
      },
      getScrollMetrics: () => {
        const core = this.core;
        core.flushSeed();
        return {
          offset: core.v,
          viewport: core.vp,
          min: core.vmin,
          max: core.vmax,
          rows: core.total,
        };
      },
    };
  }

  // ---- element refs (stable callbacks) ---------------------------------------------------

  /** Ref for the outer / scroll element. */
  readonly rootRef = (el: Element | null): void => {
    this.root = el;
  };
  /** Ref for the inner element. */
  readonly innerRef = (el: Element | null): void => {
    this.inner = el;
  };
  /** Ref for the flow window. */
  readonly winRef = (el: Element | null): void => {
    this.win = el;
  };
  readonly #metricsRefs = new Map<string, (el: Element | null) => void>();

  /** The ref for a `slot` element whose size moves the list (header, footer, spacer). */
  metricsRef(slot: string): (el: Element | null) => void {
    let fn = this.#metricsRefs.get(slot);
    if (!fn) {
      let current: Element | null = null;
      fn = (el: Element | null): void => {
        const obs = sharedObserver();
        if (current && obs) {
          obs.ro.unobserve(current);
          obs.owners.delete(current);
        }
        current = el;
        if (el && obs) {
          obs.owners.set(el, this.#onResize);
          obs.ro.observe(el);
        }
      };
      this.#metricsRefs.set(slot, fn);
    }
    return fn;
  }

  // ---- items, lines (grids) ----------------------------------------------------------------

  /** Items per engine row. */
  get columns(): number {
    return this.#cols;
  }

  /** The number of items (not lines). */
  itemCount(): number {
    const p = this.props;
    return p.data ? p.data.length : Math.max(0, Math.floor(p.count ?? 0));
  }

  /** Item `i`. */
  itemAt(i: number): T {
    const p = this.props;
    return p.data ? p.data[i] : (p.getItem ? p.getItem(i) : undefined as T);
  }

  /** Item `i`'s key. */
  itemKeyAt(i: number): Key {
    const item = this.itemAt(i);
    return this.props.keyExtractor ? this.props.keyExtractor(item, i) : defaultKey(item, i);
  }

  /** Engine row `i`'s key (a line's first item's key). */
  keyAt(i: number): Key {
    return this.itemKeyAt(i * this.#cols);
  }

  /** Engine row `i`'s type. */
  typeAt(i: number): string | number {
    const first = i * this.#cols;
    return this.props.getItemType ? this.props.getItemType(this.itemAt(first), first) : 0;
  }

  /** The engine row holding item `i`. */
  lineOf(i: number): number {
    return this.#cols === 1 ? i : Math.floor(i / this.#cols);
  }

  /** The items `[from, to)` of engine row `line`. */
  itemsOf(line: number): [number, number] {
    const from = line * this.#cols;
    return [from, Math.min(this.itemCount(), from + this.#cols)];
  }

  /** An engine-row range as an item range. */
  itemRange(r: VirtualListRange): VirtualListRange {
    if (this.#cols === 1 || r.last < r.first) return r;
    return {
      first: r.first * this.#cols,
      last: Math.min(this.itemCount() - 1, (r.last + 1) * this.#cols - 1),
    };
  }

  // ---- render phase ----------------------------------------------------------------------

  /** Feed the latest props to the engine and recompute the rendered range (render phase). */
  sync(props: ControllerProps<T>): void {
    const core = this.core;
    const first = !this.#synced;
    const animate = props.itemLayoutAnimation;
    if (animate && this.#mounted && !this.printing) this.#snapshotFlip(props);
    this.props = props;
    this.#cols = columnsOf(props);
    core.configure(this.#config(props));
    this.#synced = true;
    if (first) core.setMetrics(props.viewportSize ?? DEFAULT_VIEWPORT, 0, 0);
    core.setSource(this.#source(props));
    if (first) {
      if (props.initialScrollIndex !== undefined && core.tree.count > 0) {
        core.initialIndex(
          this.lineOf(props.initialScrollIndex),
          props.initialScrollAlign ?? "start",
        );
      } else if (props.anchor === "end") core.initialEnd();
    }
    core.updateRange();
    this.#renderedFirst = core.range.first;
    this.#renderedDelta = core.delta;
  }

  #config(props: ControllerProps<T>): CoreConfig {
    const prev = this.core.config;
    const unknown = this.#sizesUnknown(props);
    const next: CoreConfig = {
      defaultSize: props.estimatedItemSize ?? this.#sampledSize(props) ??
        (unknown ? this.#learnedSize : undefined) ?? DEFAULT_CONFIG.defaultSize,
      ...this.#window(props, unknown),
      anchor: props.anchor ?? "start",
      maintainVisibleContentPosition: props.maintainVisibleContentPosition ?? true,
      maxPhysicalSize: DEFAULT_MAX_PHYSICAL_SIZE,
      endThreshold: props.onEndReachedThreshold ?? DEFAULT_CONFIG.endThreshold,
      startThreshold: props.onStartReachedThreshold ?? DEFAULT_CONFIG.startThreshold,
      pinOnData: props.pinEndOn?.data,
      pinOnItems: props.pinEndOn?.items,
      pinOnLayout: props.pinEndOn?.layout,
      pinOnFooter: props.pinEndOn?.footer,
    };
    const same = (Object.keys(next) as (keyof CoreConfig)[]).every((k) => prev[k] === next[k]);
    return same ? prev : next;
  }

  #sample: { token: unknown; size: number | undefined } | undefined;

  /**
   * The window's overscan and row cap: none and at most `initialNumToRender` (else
   * {@linkcode PROBE_ROWS}) while probing a list with no size information, none and at most
   * `initialNumToRender` in its first window (see `#firstWindow`), the props' otherwise.
   */
  #window(props: ControllerProps<T>, unknown: boolean): Pick<CoreConfig, "overscan" | "maxRows"> {
    const cap = props.initialNumToRender;
    if (unknown && this.#probing()) return { overscan: 0, maxRows: cap ?? PROBE_ROWS };
    if (cap !== undefined && this.#firstWindow()) return { overscan: 0, maxRows: cap };
    return { overscan: props.overscan, maxRows: undefined };
  }

  /**
   * With `initialNumToRender` set (React Native's first batch): the first render (server and
   * client alike) and, where frames paint, every render until the first paint render the rows
   * filling the viewport only, at most that many; the overscan is added in the idle slice after
   * that paint. Unset, the first commit renders the whole window: one commit, a faster
   * time-to-ready (measured on scroll-bench).
   */
  #firstWindow(): boolean {
    return !this.#synced || (!this.#painted && paints());
  }

  /** After the first paint: add the overscan window (see `#firstWindow`). */
  #schedulePaint(): void {
    if (this.#paintScheduled || this.#painted) return;
    this.#paintScheduled = true;
    if (!paints() || this.props.initialNumToRender === undefined) {
      this.#painted = true;
      return;
    }
    afterPaint(() => {
      this.#painted = true;
      if (!this.#mounted || this.printing) return;
      this.core.configure(this.#config(this.props));
      if (this.core.updateRange()) this.force();
    });
  }

  /** The props give no size information: no estimate, no hints (the default is a guess). */
  #sizesUnknown(props: ControllerProps<T>): boolean {
    return props.estimatedItemSize === undefined && !props.getItemSize &&
      !props.getEstimatedItemSize && !props.estimateText;
  }

  /**
   * Whether the list is still waiting for its first measurement to size rows it knows nothing
   * about: the first render (server and client alike, so hydration matches) and, where a
   * `ResizeObserver` will report, every render until it has. Meanwhile the window is the
   * viewport only, at most {@linkcode PROBE_ROWS} rows — a window sized by a guess renders (and
   * lays out, before the first paint) several times the rows needed when the rows are taller
   * than the guess.
   */
  #probing(): boolean {
    return !this.#synced || (this.#measuredCount === 0 && sharedObserver() !== undefined);
  }

  /**
   * Record measured sizes; for a list given no size information, learn the default size from
   * their average (re-learned when it moves by more than {@linkcode LEARN_TOLERANCE}). Returns
   * whether the engine config changed (a new default, or the first measurement).
   */
  #learn(batch: readonly (readonly [number, number])[]): boolean {
    const first = this.#measuredCount === 0;
    for (const [, size] of batch) {
      this.#measuredSum += size;
      this.#measuredCount++;
    }
    if (!this.#sizesUnknown(this.props)) return false;
    const avg = this.#measuredSum / this.#measuredCount;
    const cur = this.#learnedSize;
    const learned = avg > 0 && (cur === undefined || Math.abs(avg - cur) > cur * LEARN_TOLERANCE);
    if (learned) this.#learnedSize = Math.round(avg * 100) / 100;
    return learned || first;
  }

  /**
   * Without `estimatedItemSize`, the default size of rows not yet hinted is the average hint
   * of up to 32 evenly spaced rows (exact for uniform `getItemSize` lists of any length, a
   * close estimate otherwise), recomputed when the data changes.
   */
  #sampledSize(props: ControllerProps<T>): number | undefined {
    const size = props.getItemSize ?? props.getEstimatedItemSize;
    if (!size && !props.estimateText) return undefined;
    const token = props.data ?? props.getItem ?? props.count;
    const cached = this.#sample;
    if (cached && cached.token === token) return cached.size;
    const { data, getItem } = props;
    const text = size ? undefined : this.#textEstimator(props);
    const avg = sampledAverage(
      itemCountOf(props),
      size ? (i) => size(itemFrom(data, getItem, i), i) : (i) => text!(itemFrom(data, getItem, i)),
    );
    const hinted = avg === undefined ? undefined : avg + rowGapOf(props);
    this.#sample = { token, size: hinted };
    return hinted;
  }

  #source(props: ControllerProps<T>): CoreSource {
    const { data, getItem, keyExtractor } = props;
    const items = itemCountOf(props);
    const cols = columnsOf(props);
    const count = Math.ceil(items / cols);
    const keyAt = (line: number): Key => {
      const i = line * cols;
      const item = itemFrom(data, getItem, i);
      return keyExtractor ? keyExtractor(item, i) : defaultKey(item, i);
    };
    const one = this.#itemHint(props);
    const hint = one ? lineHint(one, items, cols, count, rowGapOf(props)) : undefined;
    return { count, keyAt, hint, exact: !!props.getItemSize, token: this.#dataToken(props, cols) };
  }

  /** Item `i`'s size hint: `getItemSize`, else `getEstimatedItemSize`, else `estimateText`. */
  #itemHint(props: ControllerProps<T>): ((i: number) => number) | undefined {
    const { data, getItem } = props;
    // Built (and cached) whenever `estimateText` is set, even when an explicit hint wins.
    const text = props.estimateText ? this.#textEstimator(props) : undefined;
    const exact = props.getItemSize;
    if (exact) return (i) => exact(itemFrom(data, getItem, i), i);
    const est = props.getEstimatedItemSize;
    if (est) return (i) => est(itemFrom(data, getItem, i), i);
    return text ? (i) => text(itemFrom(data, getItem, i)) : undefined;
  }

  /** The engine's data token: the data itself, or a stable one per (data, columns) in a grid. */
  #dataToken(props: ControllerProps<T>, cols: number): unknown {
    const base = props.data ?? props.getItem ?? itemCountOf(props);
    if (cols === 1) return base;
    // A stable token per (data, columns): the engine treats a new token as new data.
    const g = this.#gridToken;
    if (g && g.base === base && g.cols === cols) return g.token;
    return (this.#gridToken = { base, cols, token: {} }).token;
  }

  #textEstimator(props: ControllerProps<T>): (item: T) => number {
    const opts = props.estimateText!;
    if (this.#estimator?.opts !== opts) {
      const cols = columnsOf(props);
      this.#estimator = {
        opts,
        fn: createTextEstimator(
          opts,
          () => (this.#crossSize || (props.viewportSize ?? DEFAULT_VIEWPORT) / 2) / cols,
        ),
      };
    }
    return this.#estimator.fn;
  }

  /** The sticky engine rows (grid items map to their lines), sorted. */
  stickyLines(): number[] {
    const src = this.props.stickyIndices;
    const c = this.#stickyCache;
    if (c && c.src === src && c.cols === this.#cols) return c.lines;
    const lines = [...new Set((src ?? []).map((i) => this.lineOf(i)))].sort((a, b) => a - b);
    this.#stickyCache = { src, cols: this.#cols, lines };
    return lines;
  }

  /**
   * The rows to render: the range, the nearest sticky row above it (detached), and rows kept
   * mounted outside it (focus, `keepMounted`, a selection's ends: persisted). Rebuilds the
   * key → index map. In print mode: up to `printLimit` rows, all in flow.
   */
  rows(stickyIndices?: readonly number[], recycle = false): RowView<T>[] {
    if (this.printing) return this.#printRows();
    const { first, last } = this.core.range;
    const keyIndex = new Map<Key, number>();
    const out: RowView<T>[] = [];
    const progressive = this.props.progressive === true;
    // Rows of the first (possibly server-rendered) pass render their content: hydration must
    // match. Only rows entering later start as placeholders.
    const gate = progressive && this.#initialized;
    const sticky = this.#stickySet(stickyIndices);
    const detached = this.#detachedSticky(sticky, first);
    const persisted = this.#persistedLines().filter((i) =>
      i !== detached && (i < first || i > last)
    );
    if (detached >= 0) this.#addRow(out, keyIndex, detached, "sticky-detached", gate);
    this.#detachedKey = detached >= 0 ? this.keyAt(detached) : null;
    for (const p of persisted) if (p < first) this.#addRow(out, keyIndex, p, "persisted", gate);
    for (let i = first; i <= last; i++) this.#addRow(out, keyIndex, i, "flow", gate);
    for (const p of persisted) if (p > last) this.#addRow(out, keyIndex, p, "persisted", gate);
    if (recycle) this.#recycle(out, sticky);
    this.#keyIndex = keyIndex;
    if (progressive) this.#pruneReady(keyIndex);
    return out;
  }

  /**
   * Append engine row `index` to `out` (and `keyIndex`). With `gate` (progressive, after the
   * first pass), a flow row not rendered before starts as a placeholder.
   */
  #addRow(
    out: RowView<T>[],
    keyIndex: Map<Key, number>,
    index: number,
    placement: RowView<T>["placement"],
    gate: boolean,
  ): void {
    const key = this.keyAt(index);
    keyIndex.set(key, index);
    const ready = !gate || placement !== "flow" || this.#ready.has(key);
    if (ready && this.props.progressive === true) this.#ready.add(key);
    out.push({
      index,
      key,
      cell: key,
      item: this.itemAt(index * this.#cols),
      type: this.typeAt(index),
      placement,
      ready,
    });
  }

  /** The sticky engine rows for `rows()` (the props' own list maps through `stickyLines`). */
  #stickySet(stickyIndices: readonly number[] | undefined): Set<number> {
    if (stickyIndices === undefined) return new Set<number>();
    return new Set(stickyIndices === this.props.stickyIndices ? this.stickyLines() : stickyIndices);
  }

  /** Forget the readiness of rows no longer rendered (progressive mode). */
  #pruneReady(keyIndex: ReadonlyMap<Key, number>): void {
    for (const key of this.#ready) if (!keyIndex.has(key)) this.#ready.delete(key);
  }

  /** Print mode's rows: every row up to `printLimit` from the first visible one, in flow. */
  #printRows(): RowView<T>[] {
    const n = this.core.tree.count;
    const limit = Math.max(1, Math.floor(this.props.printLimit ?? DEFAULT_PRINT_LIMIT));
    const lines = Math.ceil(limit / this.#cols);
    const start = n <= lines ? 0 : Math.max(0, Math.min(n - lines, this.core.visible().first));
    const keyIndex = new Map<Key, number>();
    const out: RowView<T>[] = [];
    for (let i = start; i < Math.min(n, start + lines); i++) {
      const key = this.keyAt(i);
      keyIndex.set(key, i);
      out.push({
        index: i,
        key,
        cell: key,
        item: this.itemAt(i * this.#cols),
        type: this.typeAt(i),
        placement: "flow",
        ready: true,
      });
    }
    this.#keyIndex = keyIndex;
    return out;
  }

  /** The nearest sticky row above the rendered range (−1 when none). */
  #detachedSticky(sticky: ReadonlySet<number>, first: number): number {
    let detached = -1;
    const n = this.core.tree.count;
    for (const s of sticky) if (s < first && s > detached && s < n) detached = s;
    return detached;
  }

  /**
   * Give the flow and persisted rows recycled cell keys (sticky rows keep theirs). A row keeps
   * its cell for as long as it is rendered: focusing it, or scrolling it out of the window while
   * focused (persisted), must not change its key, or the reconciler remounts it mid-gesture (a
   * tap that focuses a row lost its click).
   */
  #recycle(out: RowView<T>[], sticky: ReadonlySet<number>): void {
    const pooled = out.filter((r) => r.placement !== "sticky-detached" && !sticky.has(r.index));
    if (pooled.length === 0) return;
    this.#pool ??= new RecyclePool();
    const cells = this.#pool.assign(pooled.map((r) => ({ key: r.key, type: r.type })));
    const byKey = new Map<Key, string>(pooled.map((r, i) => [r.key, cells[i]]));
    for (let i = 0; i < out.length; i++) {
      const cell = byKey.get(out[i].key);
      if (cell !== undefined) out[i] = { ...out[i], cell };
    }
  }

  /**
   * Engine rows kept mounted outside the window: the focused row, a text selection's ends,
   * and `keepMounted` keys (item keys; a grid keeps the item's line). Sorted, unique.
   */
  #persistedLines(): number[] {
    const out = new Set<number>();
    if (this.focusKey !== null) {
      const i = this.#findLine(this.focusKey, false);
      if (i >= 0) out.add(i);
      else this.focusKey = null;
    }
    for (const key of this.#selectionKeys) {
      const i = this.#findLine(key, false);
      if (i >= 0) out.add(i);
    }
    for (const key of this.props.keepMounted ?? []) {
      const i = this.#findLine(key, true);
      if (i >= 0) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * The engine row of `key` (a row key, or with `item` an item key), from its last known
   * position when still valid, else a scan (bounded by {@linkcode PERSIST_SCAN}); −1 if gone.
   */
  #findLine(key: Key, item: boolean): number {
    const n = item ? this.itemCount() : this.core.tree.count;
    const match = item
      ? (i: number) => this.itemKeyAt(i) === key
      : (i: number) => this.keyAt(i) === key;
    const hint = this.#hints.get(key);
    const at = hint !== undefined && hint < n && match(hint)
      ? hint
      : scanOutward(Math.min(Math.max(0, hint ?? 0), Math.max(0, n - 1)), n, match);
    if (at < 0) {
      this.#hints.delete(key);
      return -1;
    }
    if (this.#hints.size > 256) this.#hints.clear();
    this.#hints.set(key, at);
    return item ? this.lineOf(at) : at;
  }

  /** The stable measure ref for `key`. */
  measureRef(key: Key): (el: Element | null) => void {
    let fn = this.#refs.get(key);
    if (!fn) {
      fn = (el: Element | null): void => {
        const obs = sharedObserver();
        if (el) {
          this.#elKey.set(el, key);
          this.#keyEl.set(key, el);
          if (obs) {
            obs.owners.set(el, this.#onResize);
            obs.ro.observe(el);
          }
          return;
        }
        const old = this.#keyEl.get(key);
        this.#keyEl.delete(key);
        this.#refs.delete(key);
        if (old && obs) {
          obs.ro.unobserve(old);
          obs.owners.delete(old);
        }
      };
      this.#refs.set(key, fn);
    }
    return fn;
  }

  /** The key of the row element `el` (or of the row containing it, up to the root). */
  rowKeyOf(el: unknown): Key | undefined {
    for (let n = el as Element | null; n && n !== this.root; n = n.parentNode as Element | null) {
      const key = this.#elKey.get(n);
      if (key !== undefined && this.#keyIndex.has(key)) return key;
    }
    return undefined;
  }

  /** The element of a rendered row. */
  elementOf(index: number): Element | undefined {
    for (const [key, i] of this.#keyIndex) if (i === index) return this.#keyEl.get(key);
    return undefined;
  }

  /** The rendered window's physical offset (flow) as of the last render. */
  get windowOffset(): number {
    return this.core.physicalOffset(this.#renderedFirst);
  }

  // ---- commit phase ----------------------------------------------------------------------

  /** Whether listeners are attached. */
  get mounted(): boolean {
    return this.#mounted;
  }

  /** Detach listeners (unmount, or a new scroll element / axis: the next commit re-attaches). */
  unmount(): void {
    this.#saveRestore();
    this.#cleanup?.();
  }

  /** The element that scrolls (none for the window). */
  #resolveScroller(): Element | null {
    const opt = this.props.scrollElement ?? "self";
    this.#mode = opt === "window" ? "window" : opt === "self" ? "self" : "element";
    if (this.#mode === "self") return this.root;
    if (this.#mode === "window") return null;
    return "current" in (opt as object)
      ? (opt as { current: Element | null }).current
      : opt as Element;
  }

  /**
   * Resolve the scroll element and attach listeners; `false` while it is not available yet
   * (an ancestor's ref attaches after this list's layout effects).
   */
  #mount(): boolean {
    this.#cleanup?.();
    this.#scroller = this.#resolveScroller();
    if (this.#mode !== "window" && !this.#scroller) return false;
    this.#mounted = true;
    const offs = this.#listen(this.#mode === "window" ? windowTarget() : this.#scroller);
    this.#scrollEnd = "onscrollend" in globalThis;
    const obs = sharedObserver();
    const observe = (el: Element | null | undefined): void => {
      if (!obs || !el) return;
      obs.owners.set(el, this.#onResize);
      obs.ro.observe(el);
      offs.push(() => {
        obs.ro.unobserve(el);
        obs.owners.delete(el);
      });
    };
    observe(this.#scroller);
    if (this.#mode !== "self") {
      // The cached page / ancestor offset is re-read when the layout around the list moves.
      observe(this.root);
      if (this.#mode === "window") observe(documentTarget()?.body);
    }
    const wasRtl = this.rtl;
    this.rtl = this.#detectRtl();
    this.#leadCache = null;
    this.#cleanup = () => {
      for (const off of offs) off();
      clearTimeout(this.#settleTimer);
      clearTimeout(this.#restTimer);
      clearTimeout(this.#targetTimer);
      clearTimeout(this.#seedTimer);
      this.#seedTimer = undefined;
      for (const t of this.#trackers) t.dispose();
      this.#cleanup = undefined;
      this.#mounted = false;
    };
    if (wasRtl !== this.rtl) this.force();
    return true;
  }

  /** Attach the scroll / touch / window listeners; returns their removals. */
  #listen(target: EventTarget | null | undefined): (() => void)[] {
    const offs: (() => void)[] = [];
    const on = (t: EventTarget | null | undefined, type: string, fn: (e: Event) => void): void => {
      if (typeof (t as { addEventListener?: unknown } | null)?.addEventListener !== "function") {
        return;
      }
      t!.addEventListener(type, fn, PASSIVE);
      offs.push(() => t!.removeEventListener(type, fn, PASSIVE));
    };
    on(target, "scroll", this.#onScroll);
    on(target, "scrollend", this.#onScrollEnd);
    on(target, "touchstart", this.#onTouchStart);
    on(target, "touchend", this.#onTouchEnd);
    on(target, "touchcancel", this.#onTouchEnd);
    const win = windowTarget();
    if (this.#mode === "window") on(win, "resize", this.#onWindowResize);
    on(win, "beforeprint", this.#onBeforePrint);
    on(win, "afterprint", this.#onAfterPrint);
    on(win, "pagehide", this.#onPageHide);
    on(documentTarget(), "selectionchange", this.#onSelectionChange);
    return offs;
  }

  #detectRtl(): boolean {
    const el = this.root ?? this.#scroller;
    if (!this.props.horizontal || !el) return false;
    try {
      const cs = (globalThis as { getComputedStyle?: (el: Element) => { direction?: string } })
        .getComputedStyle?.(el);
      return cs?.direction === "rtl";
    } catch {
      return false;
    }
  }

  /** After every commit: metrics, first scroll, layout, pending writes, focus, callbacks. */
  afterCommit(): void {
    const slice = this.#progressStart;
    if (slice) {
      this.#progressStart = null;
      const perRow = (now() - slice.t) / slice.n;
      this.#progressCost = Math.max(0.05, this.#progressCost * 0.5 + perRow * 0.5);
    }
    if (!this.#mounted && !this.#mount()) return;
    if (this.printing) return;
    // The first render's window was the first screen only (see `#firstWindow`, `#probing`):
    // without frames or a ResizeObserver to wait for, the normal window applies from here.
    this.#schedulePaint();
    this.core.configure(this.#config(this.props));
    // Hints are applied after the commit (never in a render: see core's EAGER_HINT_LIMIT) — at
    // once without a layout engine (deterministic test mode), else in background slices.
    if (sharedObserver() === undefined) this.core.flushSeed();
    this.#readMetrics();
    if (!this.#initialized) {
      this.#initialized = true;
      this.#pendingWrite = { smooth: false };
      this.#initRestore();
    }
    this.#tryRestore();
    this.#applyLayout();
    this.#rereadObscuredTail();
    if (this.#pendingWrite) {
      const smooth = this.#pendingWrite.smooth;
      this.#pendingWrite = null;
      this.#write(this.core.v, smooth);
    } else this.#reconcile(false);
    this.#afterMeasure();
    this.#flushFocus();
    this.#playFlip();
    this.#notify();
    this.#scheduleProgress();
    this.#scheduleSeed();
    if (this.core.updateRange()) this.force();
  }

  /** Apply the remaining size hints in background slices (after the first paint). */
  #scheduleSeed(): void {
    if (this.#seedTimer !== undefined || !this.core.seeding) return;
    this.#seedTimer = setTimeout(() => {
      this.#seedTimer = undefined;
      if (!this.#mounted || this.printing) return;
      this.core.seedPending(SEED_SLICE_MS);
      this.#afterChange();
      this.#scheduleSeed();
    }, 0);
  }

  /** The scroll axis' DOM names. */
  #axis(): Axis {
    return this.props.horizontal ? (this.rtl ? HORIZONTAL_RTL : HORIZONTAL) : VERTICAL;
  }

  /** A viewport size: the window's `winKey`, else the scroller's `key` (0 when unknown). */
  #clientSize(key: string, winKey: string): number {
    return this.#mode === "window" ? num(globalThis, winKey) : num(this.#scroller, key);
  }

  /** Read the viewport, lead and tail from the DOM; returns whether any changed. */
  #readMetrics(): boolean {
    const a = this.#axis();
    const vp = this.#clientSize(a.client, a.winSize) ||
      (this.props.viewportSize ?? DEFAULT_VIEWPORT);
    const cross = this.#clientSize(a.crossClient, a.winCross);
    if (cross > 0) this.#crossSize = cross;
    const lt = this.#leadTail(a);
    this.#leadCache = lt;
    return this.core.setMetrics(vp, lt.lead, lt.tail);
  }

  /**
   * Re-read the metrics after a layout when the last read could not see the tail (see
   * {@linkcode #tailObscured}), and lay out again if they changed. Without it a chat opened at
   * the end over rows larger than their estimate pins the last row, not the footer, to the
   * bottom: the footer (a composer inset, say) stays hidden until something else re-reads.
   */
  #rereadObscuredTail(): void {
    if (this.#tailObscured && this.#readMetrics()) this.#applyLayout();
  }

  /** Space before and after the rows inside the scroller. */
  #leadTail(a: Axis): { lead: number; tail: number } {
    const inner = rectOf(this.inner);
    this.#tailObscured = false;
    if (!hasLayout(inner)) {
      // No layout (tests): the keyboard spacer is the only known space after the rows.
      const inset = Math.max(0, this.props.keyboardInset ?? 0);
      return inset > 0 ? { lead: 0, tail: inset } : NO_LAYOUT;
    }
    const start = a.lead(inner);
    const win = rectOf(this.win);
    const windowExtent = win ? a.trail(win) - start : 0;
    const innerExtent = Math.max(inner[a.size], windowExtent);
    this.#tailObscured = windowExtent > inner[a.size] + 0.5;
    const base = this.#mode === "window" ? this.#windowBase(a) : this.#elementBase(a);
    if (!base) return NO_LAYOUT;
    const lead = start + base.offset;
    const tail = base.extent > 0 ? Math.max(0, base.extent - lead - innerExtent) : 0;
    return { lead: Math.round(lead * 100) / 100, tail: Math.round(tail * 100) / 100 };
  }

  /** Window scrolling: rect → document offset, and the document's extent. */
  #windowBase(a: Axis): { offset: number; extent: number } {
    const de = (globalThis as { document?: Document }).document?.documentElement;
    return { offset: this.#readRaw(), extent: num(de, a.extent) };
  }

  /** Element scrolling: rect → scroller content offset, and the scroller's extent. */
  #elementBase(a: Axis): { offset: number; extent: number } | undefined {
    const sc = rectOf(this.#scroller);
    if (!sc) return undefined;
    const border = a.border ? num(this.#scroller, a.border) : 0;
    return {
      offset: this.#readRaw() - a.lead(sc) - border,
      extent: num(this.#scroller, a.extent),
    };
  }

  /** The scroller's raw offset along the axis (positive along the list, RTL included). */
  #readRaw(): number {
    const a = this.#axis();
    const raw = this.#mode === "window"
      ? num(globalThis, a.winOffset)
      : num(this.#scroller, a.offset);
    return this.rtl ? Math.abs(raw) : raw;
  }

  /** Write the scroller's raw offset. */
  #writeRaw(raw: number, smooth: boolean): void {
    const a = this.#axis();
    const behavior: ScrollBehavior = smooth ? "smooth" : "instant";
    const value = this.rtl ? -raw : raw;
    this.#lastWrite = { raw, t: now() };
    if (smooth) this.#smoothWrite = true;
    const side = a.offset === "scrollTop" ? "top" : "left";
    if (this.#mode === "window") {
      const scrollTo = (globalThis as { scrollTo?: (o: ScrollToOptions) => void }).scrollTo;
      if (typeof scrollTo === "function") scrollTo.call(globalThis, { [side]: value, behavior });
      return;
    }
    const sc = this.#scroller as HTMLElement | null;
    if (!sc) return;
    if (smooth && typeof sc.scrollTo === "function") sc.scrollTo({ [side]: value, behavior });
    else (sc as unknown as Record<string, number>)[a.offset] = value;
  }

  /** Lay out for the engine's current state (inner size, window offset, detached sticky). */
  #applyLayout(): void {
    if (this.printing) return;
    const core = this.core;
    const a = this.#axis();
    if (this.inner) setStyleProperty(this.inner, a.size, px(core.physicalSize()));
    if (this.layout === "absolute") {
      if (Math.abs(core.delta - this.#renderedDelta) >= 0.5) this.force();
      return;
    }
    if (this.win) setStyleProperty(this.win, a.margin, px(this.windowOffset));
    const key = this.#detachedKey;
    const el = key === null ? undefined : this.#keyEl.get(key);
    const idx = key === null ? undefined : this.#keyIndex.get(key);
    if (el && idx !== undefined) {
      setStyleProperty(el, a.trailingMargin, px(-core.tree.sizeOf(idx)));
    }
    this.#pushSticky(a);
  }

  /**
   * Sticky-header push (RN / iOS): the header stuck at the top slides up as the next sticky
   * row reaches it, instead of being overlapped. One inline `top` on one element per frame.
   */
  #pushSticky(a: Axis): void {
    const lines = this.props.stickyIndices ? this.stickyLines() : [];
    const tree = this.core.tree;
    const v = this.core.v;
    // The active header: the last sticky row whose natural position is at or above the top.
    const active = lines.length > 0 ? activeStickyAt(lines, tree, v) : -1;
    let pushKey: Key | null = null;
    let push = 0;
    if (active >= 0 && active + 1 < lines.length) {
      const cur = lines[active];
      const gap = tree.offsetOf(lines[active + 1]) - v - tree.sizeOf(cur);
      if (gap < 0) {
        pushKey = this.keyAt(cur);
        push = gap;
      }
    }
    this.#setPushed(a, pushKey, push);
  }

  /** Move the sticky push to `pushKey` (by `push` px), resetting the previously pushed row. */
  #setPushed(a: Axis, pushKey: Key | null, push: number): void {
    if (this.#pushedKey !== null && this.#pushedKey !== pushKey) {
      const old = this.#keyEl.get(this.#pushedKey);
      if (old) setStyleProperty(old, a.inset, "0px");
    }
    this.#pushedKey = pushKey;
    if (pushKey !== null) {
      const el = this.#keyEl.get(pushKey);
      if (el) setStyleProperty(el, a.inset, px(push));
    }
  }

  /** Show virtual offset `v`: lay out, write, and take what the browser accepted. */
  #write(v: number, smooth: boolean): void {
    const core = this.core;
    if (!this.#scroller && this.#mode !== "window") return;
    const s = core.prepareWrite(v);
    this.#applyLayout();
    this.#writeRaw(s + core.lead, smooth);
    if (smooth) return;
    core.commitWrite(this.#readRaw() - core.lead);
    this.#applyLayout();
  }

  /** Reconcile `delta` into the scroll offset when allowed. */
  #reconcile(settled: boolean): void {
    this.core.deferring = this.#touching || this.#momentum;
    if (this.core.reconcileTarget(settled) === null) return;
    this.#write(this.core.v, false);
  }

  // ---- events ----------------------------------------------------------------------------

  readonly #onScroll = (): void => {
    const core = this.core;
    if (this.printing) return;
    if (this.#mode !== "self") {
      const lt = this.#leadCache ?? this.#leadTail(this.#axis());
      this.#leadCache = lt;
      if (lt.lead !== core.lead || lt.tail !== core.tail) {
        core.setMetrics(core.vp, lt.lead, lt.tail);
      }
    }
    const raw = this.#readRaw();
    const t = now();
    const programmatic = this.#smoothWrite ||
      (t - this.#lastWrite.t < WRITE_ECHO_MS && Math.abs(raw - this.#lastWrite.raw) < 1);
    core.scroll(raw - core.lead, t);
    if (this.#touching) this.#touchMoved = true;
    if (!programmatic) { for (const tr of this.#trackers) tr.interact(); }
    if (this.#momentum) this.#armSettle();
    else if (!this.#touching) this.#armRest();
    this.#applyLayout();
    this.#reconcile(false);
    this.#scrollEvents(t, programmatic);
    this.#notify();
    if (core.updateRange()) this.force();
  };

  readonly #onScrollEnd = (): void => {
    this.#scrollEnd = true;
    this.#settle();
  };

  readonly #onTouchStart = (): void => {
    // A finger stops any fling: apply what is pending first (as the momentum shim does). It
    // also takes the view back from a pending scroll target.
    this.core.target = null;
    clearTimeout(this.#targetTimer);
    this.#momentum = false;
    this.#touching = false;
    clearTimeout(this.#settleTimer);
    this.#reconcile(true);
    this.#touching = true;
    this.#touchMoved = false;
    this.core.deferring = true;
    if (wantsScrollEvents(this.props)) (this.#session ??= new ScrollSession()).touchStart();
  };

  readonly #onTouchEnd = (e: Event): void => {
    if (((e as TouchEvent).touches?.length ?? 0) > 0) return;
    this.#touching = false;
    const ended = this.#session?.touchEnd();
    if (ended?.endDrag) this.#emit("onScrollEndDrag", false);
    this.#momentum = true;
    // A tap (no scroll during the touch) starts no fling: settle after the short quiet period
    // even where `scrollend` exists (it never fires without a scroll).
    if (!this.#touchMoved) {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = setTimeout(() => this.#settle(), SETTLE_MS);
    } else this.#armSettle();
  };

  readonly #onWindowResize = (): void => {
    if (this.#readMetrics()) this.#afterChange();
  };

  readonly #onBeforePrint = (): void => {
    if (this.printing) return;
    this.printing = true;
    this.force();
  };

  readonly #onAfterPrint = (): void => {
    if (!this.printing) return;
    this.printing = false;
    this.#pendingWrite = { smooth: false };
    this.force();
  };

  readonly #onPageHide = (): void => {
    this.#saveRestore();
  };

  readonly #onSelectionChange = (): void => {
    const sel = (globalThis as { getSelection?: () => Selection | null }).getSelection?.();
    const keys: Key[] = [];
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      for (const node of [sel.anchorNode, sel.focusNode]) {
        const key = this.rowKeyOf(node);
        if (key !== undefined && !keys.includes(key)) keys.push(key);
      }
    }
    const same = keys.length === this.#selectionKeys.length &&
      keys.every((k, i) => k === this.#selectionKeys[i]);
    if (same) return;
    // The selection's ends stay mounted (as persisted rows, still found by rowKeyOf) while it
    // lives, so a drag-selection's anchor row survives its other end scrolling far away.
    this.#selectionKeys = keys;
    this.force();
  };

  /** (Re)start the timer that ends a fling. */
  #armSettle(): void {
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => this.#settle(), this.#scrollEnd ? IDLE_MS : SETTLE_MS);
  }

  /**
   * (Re)start the rest timer: a scaled list re-syncs, and the scroll-event session ends, once
   * a non-touch scroll has been quiet for a moment.
   */
  #armRest(): void {
    const scaled = this.core.scaled;
    const events = wantsScrollEvents(this.props);
    if (!scaled && !events && !this.#smoothWrite) return;
    clearTimeout(this.#restTimer);
    this.#restTimer = setTimeout(() => {
      this.core.rest();
      if (scaled) this.#reconcile(true);
      this.#endSession();
    }, REST_MS);
  }

  /** The scroller came to rest: reconcile everything deferred. */
  #settle(): void {
    clearTimeout(this.#settleTimer);
    clearTimeout(this.#restTimer);
    this.#momentum = false;
    this.core.rest();
    const target = this.core.target;
    if (target?.smooth) {
      target.smooth = false;
      this.#write(this.core.targetOffset(target), false);
    } else this.#reconcile(true);
    this.#endSession();
    this.#afterChange();
  }

  /** A scroll session ended: momentum-end and the trailing throttled `onScroll`. */
  #endSession(): void {
    const programmatic = this.#smoothWrite || this.#sessionProgrammatic;
    this.#smoothWrite = false;
    this.#sessionProgrammatic = false;
    const done = this.#session?.settle();
    if (done?.trailing) this.#emit("onScroll", programmatic);
    if (done?.momentumEnd) this.#emit("onMomentumScrollEnd", programmatic);
  }

  readonly #onResize = (entries: ResizeObserverEntry[]): void => {
    if (this.printing) return;
    const { batch, metrics } = this.#rowSizes(entries);
    if (metrics) this.#readMetrics();
    if (batch.length > 0 && this.#learn(batch)) this.core.configure(this.#config(this.props));
    const before = this.props.onItemMeasured ? this.#sizesOf(batch) : null;
    const changed = batch.length > 0 && this.core.measure(batch);
    if (changed && before) this.#reportSizes(before);
    this.#afterChange();
    // Absolute layout: every row's offset is in the rendered props.
    if (changed && this.layout === "absolute") this.force();
  };

  /** The measured lines' sizes before a measurement applies, and whether they were measured. */
  #sizesOf(batch: readonly (readonly [number, number])[]): Map<number, [number, boolean]> {
    const tree = this.core.tree;
    const out = new Map<number, [number, boolean]>();
    for (const [line] of batch) {
      if (line < tree.count) out.set(line, [tree.sizeOf(line), tree.isMeasured(line)]);
    }
    return out;
  }

  /** `onItemMeasured` for every line measured for the first time or to a new size. */
  #reportSizes(before: Map<number, [number, boolean]>): void {
    const tree = this.core.tree;
    const cb = this.props.onItemMeasured;
    for (const [line, [previous, measured]] of before) {
      if (line >= tree.count || !tree.isMeasured(line)) continue;
      const size = tree.sizeOf(line);
      if (measured && size === previous) continue;
      cb?.({ index: this.itemsOf(line)[0], size, previous });
    }
  }

  /**
   * Split resize entries into row sizes (`[row, px]`) and whether any other observed element
   * (the scroller, a header, footer or spacer) resized.
   */
  #rowSizes(entries: ResizeObserverEntry[]): { batch: [number, number][]; metrics: boolean } {
    const horizontal = !!this.props.horizontal;
    const progressive = this.props.progressive === true;
    const batch: [number, number][] = [];
    let metrics = false;
    for (const e of entries) {
      const key = this.#elKey.get(e.target);
      const index = key === undefined ? undefined : this.#keyIndex.get(key);
      if (index === undefined) metrics = true;
      // A placeholder's size is not the row's size.
      else if (!progressive || this.#ready.has(key!)) batch.push([index, entrySize(e, horizontal)]);
    }
    return { batch, metrics };
  }

  /** After sizes or metrics changed outside a render. */
  #afterChange(): void {
    this.#applyLayout();
    this.#rereadObscuredTail();
    this.#reconcile(false);
    this.#afterMeasure();
    this.#notify();
    if (this.core.updateRange()) this.force();
  }

  /**
   * The measure-and-correct loop: keep landing on a pending scroll target — the anchor of
   * every size change meanwhile, whatever `maintainVisibleContentPosition` says — until the
   * view sits on it and the rendered window's sizes are all known, then release it. A window
   * whose rows never all report (hidden rows) releases it once measurements go quiet.
   */
  #afterMeasure(): void {
    const core = this.core;
    if (!core.target) return;
    const measurable = sharedObserver() !== undefined;
    const want = core.targetOffset(core.target);
    if (!core.target.smooth && Math.abs(want - core.v) >= 0.5 && !core.deferring) {
      this.#write(want, false);
    }
    clearTimeout(this.#targetTimer);
    if (core.settleTarget(measurable) || core.target.smooth) return;
    const held = core.target;
    this.#targetTimer = setTimeout(() => {
      if (this.core.target === held) this.core.target = null;
    }, TARGET_QUIET_MS);
  }

  /** Edge callbacks, range change, viewability, blank-area diagnostics. */
  #notify(): void {
    const core = this.core;
    const p = this.props;
    const vis = core.visible();
    if (vis.first !== this.#lastVisible.first || vis.last !== this.#lastVisible.last) {
      this.#lastVisible = vis;
      if (vis.last >= vis.first) {
        const items = this.itemRange(vis);
        p.onRangeChange?.(items.first, items.last);
      }
    }
    const edges = core.edges();
    if (edges.end) p.onEndReached?.();
    if (edges.start) p.onStartReached?.();
    this.#viewability();
    if (p.onBlankArea && isDev()) {
      const blank = core.blankArea();
      if (blank.before > 0 || blank.after > 0) p.onBlankArea(blank);
    }
  }

  // ---- viewability -----------------------------------------------------------------------

  /** Report viewability changes to `onViewableItemsChanged` and each callback pair. */
  #viewability(): void {
    const p = this.props;
    const pairs = p.viewabilityConfigCallbackPairs ?? [];
    const main = p.onViewableItemsChanged;
    const total = (main ? 1 : 0) + pairs.length;
    if (total === 0) return;
    while (this.#trackers.length < total) {
      this.#trackers.push(
        new ViewabilityTracker<T>({
          itemAt: (i) => this.itemAt(i),
          keyAt: (i) => this.itemKeyAt(i),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        }),
      );
    }
    const measure = () => ({ rows: this.#viewportRows(), vp: this.core.vp });
    const { rows, vp } = measure();
    let k = 0;
    if (main) {
      this.#trackers[k++].update(
        p.viewabilityConfig ?? {},
        rows,
        vp,
        (info) => this.props.onViewableItemsChanged?.(info),
        measure,
      );
    }
    for (let j = 0; j < pairs.length; j++) {
      const idx = j;
      this.#trackers[k++].update(
        pairs[j].viewabilityConfig,
        rows,
        vp,
        (info) => this.props.viewabilityConfigCallbackPairs?.[idx]?.onViewableItemsChanged?.(info),
        measure,
      );
    }
  }

  /** Items of the rows intersecting the viewport, in viewport coordinates. */
  #viewportRows(): ViewportRow[] {
    const core = this.core;
    const vis = core.visible();
    const out: ViewportRow[] = [];
    if (core.tree.count === 0 || vis.last < vis.first) return out;
    for (let line = vis.first; line <= vis.last; line++) {
      const top = core.tree.offsetOf(line) - core.v;
      const size = core.tree.sizeOf(line);
      const [from, to] = this.itemsOf(line);
      for (let i = from; i < to; i++) out.push({ index: i, top, size });
    }
    return out;
  }

  // ---- scroll events ---------------------------------------------------------------------

  /** Fire the RN scroll callbacks for a scroll frame (only when any is set). */
  #scrollEvents(t: number, programmatic: boolean): void {
    if (!wantsScrollEvents(this.props)) return;
    this.#session ??= new ScrollSession();
    const r = this.#session.scroll(t, this.props.scrollEventThrottle ?? 0);
    if (r.momentumBegin || r.beginDrag) this.#sessionProgrammatic = programmatic;
    if (r.beginDrag) this.#emit("onScrollBeginDrag", programmatic);
    if (r.momentumBegin) this.#emit("onMomentumScrollBegin", programmatic);
    if (r.scroll) this.#emit("onScroll", programmatic);
  }

  /** Call one scroll callback with an RN-shaped event. */
  #emit(
    name:
      | "onScroll"
      | "onScrollBeginDrag"
      | "onScrollEndDrag"
      | "onMomentumScrollBegin"
      | "onMomentumScrollEnd",
    programmatic: boolean,
  ): void {
    const fn = this.props[name] as ((e: VirtualListScrollEvent) => void) | undefined;
    if (!fn) return;
    const core = this.core;
    fn(scrollEvent(
      !!this.props.horizontal,
      core.v + core.lead,
      core.total + core.lead + core.tail,
      core.vp,
      this.#crossSize,
      programmatic,
    ));
  }

  // ---- scroll restoration ----------------------------------------------------------------

  /**
   * Set up restoration: under `restoreKey`, or — in dev, without one — automatically under the
   * list's position in the document, so a dev edit that remounts the list or reloads the page
   * lands back on the same row (see dev-restore.ts).
   */
  #initRestore(): void {
    const own = this.props.restoreKey;
    const key = own || (devRestoreEnabled() ? devRestoreKey(this.root) : undefined);
    if (!key) return;
    const entry = historyEntryId();
    if (entry) this.#restore = { entry, key, pending: true, dev: !own };
  }

  /** Restore a saved view once the list has rows (after hydration: the first commit). */
  #tryRestore(): void {
    const r = this.#restore;
    if (!r?.pending || this.core.tree.count === 0) return;
    r.pending = false;
    const snap = loadSnapshot(r.entry, r.key);
    if (snap && (!r.dev || devSnapshotApplies(snap))) this.#applySnapshot(snap);
  }

  #applySnapshot(snap: RestoreSnapshot): void {
    this.core.flushSeed();
    const n = this.core.tree.count;
    const hint = Math.max(0, Math.min(n - 1, snap.index));
    const index = scanOutward(hint, n, (i) => String(this.keyAt(i)) === snap.key);
    if (snap.atEnd && this.props.anchor === "end") {
      this.scrollToEnd(false);
      return;
    }
    if (index < 0) return;
    this.#seedSizes(snap, index);
    this.core.pinned = false;
    this.scrollToIndex(index, { align: "start", viewOffset: snap.gap });
  }

  /** Known sizes around the anchor first, so the landing is exact without a remeasure flash. */
  #seedSizes(snap: RestoreSnapshot, index: number): void {
    const n = this.core.tree.count;
    const sizes = new Map(snap.sizes);
    const batch: [number, number][] = [];
    const span = snap.sizes.length;
    for (let i = Math.max(0, index - span); i < Math.min(n, index + span); i++) {
      const size = sizes.get(String(this.keyAt(i)));
      if (size !== undefined) batch.push([i, size]);
    }
    if (batch.length > 0) this.core.measure(batch);
  }

  /** Save the view for `restoreKey` or the dev restore (unmount, pagehide). */
  #saveRestore(): void {
    const r = this.#restore;
    if (!r || !this.#initialized || this.printing) return;
    const core = this.core;
    const at = core.anchor();
    if (!at) return;
    const sizes: [string, number][] = [];
    const { first, last } = core.range;
    for (let i = Math.max(first, at.index - 100); i <= Math.min(last, at.index + 100); i++) {
      if (core.tree.isMeasured(i)) sizes.push([String(this.keyAt(i)), core.tree.sizeOf(i)]);
    }
    saveSnapshot(r.entry, r.key, {
      key: String(this.keyAt(at.index)),
      index: at.index,
      gap: at.gap,
      sizes,
      atEnd: core.isAtEnd(),
      ...(r.dev ? { dev: devStamp() } : {}),
    });
  }

  // ---- layout animations -----------------------------------------------------------------

  /** The FLIP host view of the rendered rows. */
  #flipHost() {
    return {
      rows: () => {
        const out: [Key, Element][] = [];
        for (const key of this.#keyIndex.keys()) {
          const el = this.#keyEl.get(key);
          if (el) out.push([key, el]);
        }
        return out;
      },
      ghostParent: () => this.inner,
    };
  }

  /** Before a data change renders: snapshot the rendered rows' boxes. */
  #snapshotFlip(next: ControllerProps<T>): void {
    const p = this.props;
    const changed = next.data !== p.data || next.getItem !== p.getItem || next.count !== p.count;
    if (!changed || this.#keyIndex.size === 0) return;
    const oldNear = this.#nearKeys();
    this.#flip = { snap: new FlipSnapshot(this.#flipHost(), oldNear), oldNear };
  }

  /** Keys of the rendered rows and 64 rows either side (for "was it in the data?"). */
  #nearKeys(): Set<Key> {
    const out = new Set<Key>(this.#keyIndex.keys());
    const { first, last } = this.core.range;
    const n = this.core.tree.count;
    for (let i = Math.max(0, first - 64); i <= Math.min(n - 1, last + 64); i++) {
      out.add(this.keyAt(i));
    }
    return out;
  }

  /** After the data change committed (and re-anchored): animate. */
  #playFlip(): void {
    const f = this.#flip;
    this.#flip = undefined;
    const opt = this.props.itemLayoutAnimation;
    if (!f || !opt) return;
    const newNear = this.#nearKeys();
    f.snap.play(
      this.#flipHost(),
      (key) => !f.oldNear.has(key),
      (key) => !newNear.has(key),
      opt === true ? {} : opt as ItemLayoutAnimationOptions,
    );
  }

  // ---- progressive rendering -------------------------------------------------------------

  /**
   * Progressive mode: after the frame showing placeholders paints, render the visible rows'
   * content, then the overscan rows' in small batches, each in its own task.
   */
  #scheduleProgress(): void {
    if (this.props.progressive !== true || this.#progressScheduled) return;
    let pending = false;
    for (const key of this.#keyIndex.keys()) {
      if (!this.#ready.has(key)) {
        pending = true;
        break;
      }
    }
    if (!pending) return;
    this.#progressScheduled = true;
    afterPaint(() => {
      this.#progressScheduled = false;
      if (!this.#mounted) return;
      const vis = this.core.visible();
      const visible: Key[] = [];
      const rest: Key[] = [];
      for (const [key, i] of this.#keyIndex) {
        if (this.#ready.has(key)) continue;
        (i >= vis.first && i <= vis.last ? visible : rest).push(key);
      }
      // As many rows as fit a slice of PROGRESS_BUDGET_MS at the measured cost per row,
      // visible rows first; the rest follow in later tasks, frames painting in between.
      const size = Math.max(1, Math.min(64, Math.floor(PROGRESS_BUDGET_MS / this.#progressCost)));
      const batch = [...visible, ...rest].slice(0, size);
      if (batch.length === 0) return;
      for (const k of batch) this.#ready.add(k);
      this.#progressStart = { t: now(), n: batch.length };
      this.force();
    });
  }

  // ---- imperative API --------------------------------------------------------------------

  /** Scroll to virtual offset `v` (drops a pending target). */
  #jump(v: number, smooth: boolean): void {
    this.core.flushSeed();
    this.core.target = null;
    // A jump leaves the end: stop holding the view there (the next scroll event re-checks).
    this.core.pinned = false;
    this.#go(v, smooth);
  }

  #go(v: number, smooth: boolean): void {
    const core = this.core;
    if (smooth) {
      if (core.target) core.target.smooth = true;
      const s = core.prepareWrite(v);
      this.#writeRaw(s + core.lead, true);
      core.updateRange();
      this.force();
      return;
    }
    core.prepareWrite(v);
    core.updateRange();
    this.#pendingWrite = { smooth: false };
    this.force();
  }

  /** `scrollToIndex` (engine row): iterate measure-and-correct until it sits at its alignment. */
  scrollToIndex(index: number, options: ScrollToIndexOptions = {}): void {
    const core = this.core;
    const n = core.tree.count;
    if (n === 0) return;
    core.flushSeed();
    const i = Math.max(0, Math.min(n - 1, Math.floor(index)));
    core.target = {
      index: i,
      align: options.align ?? "start",
      viewOffset: options.viewOffset ?? 0,
      passes: 0,
    };
    this.#go(core.targetOffset(core.target), options.behavior === "smooth");
  }

  /** `scrollToEnd`. */
  scrollToEnd(smooth: boolean): void {
    const core = this.core;
    if (core.tree.count === 0 && core.tail === 0) return;
    core.flushSeed();
    core.pinned = true;
    core.target = {
      index: core.tree.count - 1,
      align: "end",
      viewOffset: 0,
      toEnd: true,
      passes: 0,
    };
    this.#go(core.vmax, smooth);
  }

  /** The item under a viewport point (−1 outside the rows). */
  indexAtPoint(clientX: number, clientY: number): number {
    const core = this.core;
    const horizontal = !!this.props.horizontal;
    const along = horizontal ? (this.rtl ? -clientX : clientX) : clientY;
    const pos = core.v + (along - this.#viewStart());
    if (core.tree.count === 0 || pos < 0 || pos >= core.total) return -1;
    const line = core.tree.indexAt(pos);
    if (this.#cols === 1) return line;
    const col = this.#columnAt(horizontal ? clientY : clientX, horizontal);
    return Math.min(this.itemCount() - 1, line * this.#cols + col);
  }

  /** Where the rows' viewport starts along the axis, in client coordinates (0: the window). */
  #viewStart(): number {
    if (this.#mode === "window") return 0;
    const sc = rectOf(this.#scroller);
    if (!sc) return 0;
    const a = this.#axis();
    return a.lead(sc) + (a.border ? num(this.#scroller, a.border) : 0);
  }

  /** The grid column under the cross-axis client coordinate `across`. */
  #columnAt(across: number, horizontal: boolean): number {
    const inner = rectOf(this.inner);
    if (!inner) return columnAt(across, 0, this.#crossSize, this.#cols);
    return horizontal
      ? columnAt(across, inner.top, inner.height, this.#cols)
      : columnAt(across, inner.left, inner.width, this.#cols);
  }

  // ---- focus + keyboard ------------------------------------------------------------------

  /** A focus moved into a row: remember it (kept mounted) and make it the roving row. */
  focusIn(target: unknown): void {
    const key = this.rowKeyOf(target);
    if (key === undefined) return;
    this.focusKey = key;
    const index = this.#keyIndex.get(key) ?? -1;
    if (index < 0) return;
    this.#hints.set(key, index);
    const item = this.#cols === 1 ? index : this.#itemIndexOf(target) ?? index * this.#cols;
    if (this.activeIndex !== item) {
      this.activeIndex = item;
      this.force();
    }
  }

  /** The grid item index of the cell containing `el` (`data-vl-item`), if any. */
  #itemIndexOf(el: unknown): number | undefined {
    for (let n = el as Element | null; n && n !== this.root; n = n.parentNode as Element | null) {
      const raw = n.getAttribute?.("data-vl-item");
      if (raw !== null && raw !== undefined) return Number(raw);
    }
    return undefined;
  }

  /** The keyboard position (engine row, or grid item) of an event target. */
  positionOf(target: unknown): number | undefined {
    const key = this.rowKeyOf(target);
    if (key === undefined) return undefined;
    const line = this.#keyIndex.get(key);
    if (line === undefined) return undefined;
    return this.#cols === 1 ? line : this.#itemIndexOf(target);
  }

  /** Focus left the list: stop keeping the row mounted. */
  focusOut(related: unknown): void {
    if (related && this.rowKeyOf(related) !== undefined) return;
    if (related && this.root && (this.root as Node).contains?.(related as Node)) return;
    this.focusKey = null;
  }

  /** Move focus to position `index` (a row, or an item in a grid), scrolling it into view. */
  focusRow(index: number): void {
    const n = this.#cols === 1 ? this.core.tree.count : this.itemCount();
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, index));
    const line = this.lineOf(i);
    this.activeIndex = i;
    this.#pendingFocus = i;
    this.focusKey = this.keyAt(line);
    this.#hints.set(this.focusKey, line);
    this.scrollToIndex(line, { align: "auto" });
  }

  #flushFocus(): void {
    const i = this.#pendingFocus;
    if (i === null) return;
    let el = this.elementOf(this.lineOf(i)) as HTMLElement | undefined;
    if (el && this.#cols > 1) {
      el = [...(el.children ?? [])].find((c) => c.getAttribute?.("data-vl-item") === String(i)) as
        | HTMLElement
        | undefined;
    }
    if (!el) return;
    this.#pendingFocus = null;
    try {
      el.focus?.({ preventScroll: true });
    } catch {
      el.focus?.();
    }
  }

  /** The keyboard step for `key` from position `from`, or `null` for other keys. */
  navigationTarget(key: string, from: number): number | null {
    const cols = this.#cols;
    const n = cols === 1 ? this.core.tree.count : this.itemCount();
    const step = this.#keySteps(cols)[key];
    if (step === undefined) return null;
    return Math.max(0, Math.min(n - 1, step === "home" ? 0 : step === "end" ? n - 1 : from + step));
  }

  /** Position deltas per navigation key (reading direction and grid aware). */
  #keySteps(cols: number): Record<string, number | "home" | "end"> {
    const vis = this.core.visible();
    const page = Math.max(1, vis.last - vis.first) * cols;
    const steps: Record<string, number | "home" | "end"> = {
      PageDown: page,
      PageUp: -page,
      Home: "home",
      End: "end",
    };
    const horizontal = !!this.props.horizontal;
    const forward = this.rtl ? "ArrowLeft" : "ArrowRight";
    const backward = this.rtl ? "ArrowRight" : "ArrowLeft";
    // Along the list: a line (`cols` items); across it (grids only): one cell.
    steps[horizontal ? forward : "ArrowDown"] = cols;
    steps[horizontal ? backward : "ArrowUp"] = -cols;
    if (cols > 1) {
      steps[horizontal ? "ArrowDown" : forward] = 1;
      steps[horizontal ? "ArrowUp" : backward] = -1;
    }
    return steps;
  }

  /**
   * Typeahead: `char` extends the typed prefix (reset after 700 ms), and the next position
   * after `from` whose text starts with it (case-insensitive, wrapping) is returned.
   */
  typeaheadTarget(char: string, from: number): number | null {
    const t = now();
    const s = this.#typeahead;
    s.buffer = t - s.t > 700 ? char : s.buffer + char;
    s.t = t;
    // A repeated single letter ("qq") cycles through the rows starting with it.
    const repeated = s.buffer.length > 1 && [...s.buffer].every((c) => c === s.buffer[0]);
    const prefix = (repeated ? s.buffer[0] : s.buffer).toLocaleLowerCase();
    const n = this.itemCount();
    if (n === 0) return null;
    const textOf = textAccessor(this.props, this.props.typeahead);
    // A repeated single letter cycles; a longer prefix may match the current item itself.
    const first = s.buffer.length > 1 && !repeated ? 0 : 1;
    for (let d = first; d < n && d <= TYPEAHEAD_SCAN; d++) {
      const i = (from + d) % n;
      const text = textOf(this.itemAt(i), i);
      if (text && text.trimStart().toLocaleLowerCase().startsWith(prefix)) return i;
    }
    return null;
  }

  /** Scroll so a found (`beforematch`) stub's row is shown. */
  reveal(index: number): void {
    const run = (): void => this.scrollToIndex(index, { align: "center" });
    const raf =
      (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (typeof raf === "function") raf(run);
    else setTimeout(run, 0);
  }
}
