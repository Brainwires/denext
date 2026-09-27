/**
 * `VirtualMasonry` — a virtualized masonry layout (`denext/virtual-masonry`): variable-height
 * items in `numColumns` columns, each placed in the shortest column, only the items near the
 * viewport rendered. Items are measured as they render; a late size change moves only the
 * items below it in its column, and one above the viewport is compensated so the view does not
 * jump (deferred to the end of a touch fling, as `VirtualList` does on iOS). A separate entry
 * point: `VirtualList` users bundle none of it.
 *
 * @module
 */

import { h } from "../../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../../jsx/types.ts";
import {
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
} from "../../runtime/hooks.ts";
import { EdgeTracker } from "./edges.ts";
import { MasonryLayout } from "./masonry.ts";
import { defaultKey, px, slot } from "./shared.ts";
import type { VirtualListKey, VirtualListSlot } from "./types.ts";

/** The imperative handle of a `VirtualMasonry`. */
export interface VirtualMasonryHandle {
  /** Scroll item `index` to the top of the viewport (or centre / bottom with `align`). */
  scrollToIndex(
    index: number,
    options?: { readonly align?: "start" | "center" | "end"; readonly behavior?: ScrollBehavior },
  ): void;
  /** Scroll to `offset` px from the top of the items. */
  scrollToOffset(offset: number, options?: { readonly behavior?: ScrollBehavior }): void;
  /** The items currently rendered (index order). */
  getRenderedIndices(): readonly number[];
}

/** Props of {@linkcode VirtualMasonry}. */
export interface VirtualMasonryProps<T> {
  /** The items. Pass a new array when they change (appends are incremental). */
  readonly data: readonly T[];
  /** Render one item. */
  readonly renderItem: (item: T, index: number) => VNodeChild;
  /** An item's stable key. Default: `item.key`, `item.id`, else the index. */
  readonly keyExtractor?: (item: T, index: number) => VirtualListKey;
  /** Number of columns. Default 2. */
  readonly numColumns?: number;
  /** Px between items, both ways (CSS `gap`). */
  readonly gap?: number;
  /** Px between items in a column (overrides `gap`). */
  readonly rowGap?: number;
  /** Px between columns (overrides `gap`). */
  readonly columnGap?: number;
  /** Height assumed for items not measured yet. Default 200. */
  readonly estimatedItemSize?: number;
  /** A per-item estimate (e.g. from an image's aspect ratio and the column width). */
  readonly getEstimatedItemSize?: (item: T, index: number) => number;
  /** An item's exact height: it is not measured. */
  readonly getItemSize?: (item: T, index: number) => number;
  /** Px rendered beyond the viewport on each side. Default: one viewport. */
  readonly overscan?: number;
  /** Called once per data change when the view nears the end (or the items are shorter). */
  readonly onEndReached?: () => void;
  /** Distance from the end, in viewports. Default 0.5. */
  readonly onEndReachedThreshold?: number;
  /** What scrolls: the component itself (default) or the page. */
  readonly scrollElement?: "self" | "window";
  /** Viewport height assumed without layout (SSR, tests). Default 800. */
  readonly viewportSize?: number;
  /** Rendered above the items. */
  readonly ListHeaderComponent?: VirtualListSlot;
  /** Rendered below the items. */
  readonly ListFooterComponent?: VirtualListSlot;
  /** Rendered when there are no items. */
  readonly ListEmptyComponent?: VirtualListSlot;
  /** Class of the outer element. */
  readonly class?: string;
  /** React spelling of `class`. */
  readonly className?: string;
  /** Style of the outer element (give it a height when it scrolls itself). */
  readonly style?: Readonly<Record<string, string | number>>;
  /** Accessible name of the list. */
  readonly "aria-label"?: string;
  /** Receives the {@linkcode VirtualMasonryHandle}. */
  readonly ref?: Ref<VirtualMasonryHandle>;
}

/** An observed element's border-box block size (its content rect's height when unreported). */
function entryBlockSize(e: ResizeObserverEntry): number {
  const box = e.borderBoxSize as unknown as ResizeObserverSize[] | ResizeObserverSize;
  const b = Array.isArray(box) ? box[0] : box;
  return b ? b.blockSize : e.contentRect.height;
}

/** The per-instance state (a ref; scrolling re-renders only when the rendered set changes). */
class MasonryController<T> {
  layout = new MasonryLayout(2);
  props!: VirtualMasonryProps<T>;
  force: () => void = () => {};
  root: HTMLElement | null = null;
  inner: HTMLElement | null = null;
  keys: VirtualListKey[] = [];
  readonly known = new Map<VirtualListKey, number>();
  data: readonly T[] | undefined;
  cols = 0;
  gap = -1;
  scroll = 0;
  vp = 0;
  lead = 0;
  rendered: number[] = [];
  touching = false;
  momentum = false;
  pending = 0;
  keyIdx = new Map<VirtualListKey, number>();
  readonly #refs = new Map<VirtualListKey, (el: Element | null) => void>();
  readonly edges = new EdgeTracker();
  readonly elKey = new WeakMap<Element, VirtualListKey>();
  /** Mounted item elements (re-observed when the observer is re-created). */
  readonly live = new Set<Element>();
  ro: ResizeObserver | undefined;
  cleanup: (() => void) | undefined;
  settle: ReturnType<typeof setTimeout> | undefined;
  lastScroll = 0;
  dir = 0;

  sizeHint(i: number): number {
    const p = this.props;
    const item = p.data[i];
    const exact = p.getItemSize?.(item, i);
    if (exact !== undefined) return exact;
    const known = this.known.get(this.keys[i]);
    if (known !== undefined) return known;
    return p.getEstimatedItemSize?.(item, i) ?? p.estimatedItemSize ?? 200;
  }

  sync(p: VirtualMasonryProps<T>): void {
    this.props = p;
    const cols = Math.max(1, Math.floor(p.numColumns ?? 2));
    const gap = Math.max(0, p.rowGap ?? p.gap ?? 0);
    if (!this.vp) this.vp = p.viewportSize ?? 800;
    if (p.data === this.data && cols === this.cols && gap === this.gap) return;
    const old = this.keys;
    const keys = p.data.map((item, i) =>
      p.keyExtractor ? p.keyExtractor(item, i) : defaultKey(item, i)
    );
    this.keys = keys;
    this.keyIdx = new Map(keys.map((k, i) => [k, i]));
    const append = cols === this.cols && gap === this.gap && old.length > 0 &&
      keys.length >= old.length && old.every((k, i) => keys[i] === k);
    if (append) this.layout.append(keys.length, (i) => this.sizeHint(i));
    else this.layout.rebuild(keys.length, (i) => this.sizeHint(i), cols, gap);
    this.data = p.data;
    this.cols = cols;
    this.gap = gap;
    this.edges.data(`${keys.length}\u0000${keys[0] ?? ""}\u0000${keys[keys.length - 1] ?? ""}`);
    this.range();
  }

  /** Recompute the rendered items; whether they changed. */
  range(): boolean {
    const over = this.props.overscan ?? this.vp;
    const top = this.scroll - this.lead;
    const next = this.layout.visible(top - over, top + this.vp + over);
    const same = next.length === this.rendered.length &&
      next.every((v, i) => v === this.rendered[i]);
    if (!same) this.rendered = next;
    return !same;
  }

  isWindow(): boolean {
    return this.props.scrollElement === "window";
  }

  readScroll(): number {
    if (this.isWindow()) return Number((globalThis as { scrollY?: number }).scrollY) || 0;
    return Number(this.root?.scrollTop) || 0;
  }

  readMetrics(): void {
    const win = this.isWindow();
    const vp = win
      ? Number((globalThis as { innerHeight?: number }).innerHeight) || 0
      : Number(this.root?.clientHeight) || 0;
    if (vp > 0) this.vp = vp;
    const inner = this.inner?.getBoundingClientRect?.();
    if (inner && (inner.width || inner.height)) {
      const base = win ? 0 : this.root?.getBoundingClientRect?.().top ?? 0;
      this.lead = inner.top - base + this.readScroll();
    }
  }

  writeScroll(top: number, smooth = false): void {
    const behavior: ScrollBehavior = smooth ? "smooth" : "instant";
    if (this.isWindow()) {
      (globalThis as { scrollTo?: (o: ScrollToOptions) => void }).scrollTo?.({ top, behavior });
    } else if (this.root) {
      if (smooth && typeof this.root.scrollTo === "function") this.root.scrollTo({ top, behavior });
      else this.root.scrollTop = top;
    }
    this.dir = Math.sign(top - this.scroll) || this.dir;
    this.scroll = top;
  }

  notify(): void {
    const r = this.edges.check({
      v: this.scroll - this.lead,
      vp: this.vp,
      total: this.layout.height,
      dir: this.dir,
      endThreshold: this.props.onEndReachedThreshold ?? 0.5,
      startThreshold: 0,
      hasRows: this.layout.count > 0,
    });
    this.dir = 0;
    if (r.end) this.props.onEndReached?.();
  }

  onScroll = (): void => {
    const s = this.readScroll();
    const d = Math.sign(s - this.scroll);
    if (d !== 0) this.dir = d;
    this.scroll = s;
    if (this.momentum) this.armSettle();
    this.notify();
    if (this.range()) this.force();
  };

  armSettle(): void {
    clearTimeout(this.settle);
    this.settle = setTimeout(() => this.flush(), 250);
  }

  /** The fling ended: apply size corrections deferred during the touch and its momentum. */
  flush(): void {
    clearTimeout(this.settle);
    this.momentum = false;
    if (this.touching || this.pending === 0) return;
    const d = this.pending;
    this.pending = 0;
    this.writeScroll(this.readScroll() + d);
  }

  onResize = (entries: ResizeObserverEntry[]): void => {
    if (this.props.getItemSize) return;
    let changed = false;
    let above = 0;
    const top = this.scroll - this.lead;
    for (const e of entries) {
      const i = this.indexOfEl(e.target);
      if (i === undefined) continue;
      const size = entryBlockSize(e);
      const place = this.layout.placement(i);
      this.known.set(this.keys[i], size);
      const d = this.layout.setSize(i, size);
      if (d === 0) continue;
      changed = true;
      if (place.top + place.size <= top) above += d;
    }
    if (changed) this.afterResize(above);
  };

  /** The item index of an observed element (undefined once it is no longer rendered). */
  indexOfEl(el: Element): number | undefined {
    const key = this.elKey.get(el);
    return key === undefined ? undefined : this.keyIdx.get(key);
  }

  /** Sizes changed: hold the view still across `above` px of change above it, then re-lay. */
  afterResize(above: number): void {
    if (above !== 0) {
      // Keep the view still: an item above the viewport grew or shrank.
      // Never write the scroll offset mid-gesture (iOS cancels the fling): defer to its end.
      if (this.touching || this.momentum) this.pending += above;
      else this.writeScroll(this.readScroll() + above);
    }
    if (this.inner) this.inner.style.height = px(this.layout.height);
    this.range();
    this.force();
  }

  mount(): void {
    if (this.cleanup) return;
    const target: EventTarget | null = this.isWindow()
      ? (typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function"
        ? globalThis as EventTarget
        : null)
      : this.root;
    const offs: (() => void)[] = [];
    const on = (type: string, fn: (e: Event) => void) => {
      if (!target || typeof target.addEventListener !== "function") return;
      target.addEventListener(type, fn, { passive: true });
      offs.push(() => target.removeEventListener(type, fn));
    };
    on("scroll", this.onScroll);
    on("touchstart", () => {
      this.touching = true;
    });
    on("touchend", () => {
      this.touching = false;
      this.momentum = true;
      this.armSettle();
    });
    on("scrollend", () => this.flush());
    this.observer();
    for (const el of this.live) this.ro?.observe(el);
    this.cleanup = () => {
      for (const off of offs) off();
      this.ro?.disconnect();
      this.ro = undefined;
      clearTimeout(this.settle);
      this.cleanup = undefined;
    };
  }

  /** The ResizeObserver (created on first use; absent without one: the test mode). */
  observer(): ResizeObserver | undefined {
    if (this.ro) return this.ro;
    const Ctor = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof Ctor === "function") this.ro = new Ctor(this.onResize);
    return this.ro;
  }

  /** The stable measure ref of item `key` (unobserves its element on unmount). */
  itemRef(key: VirtualListKey): (el: Element | null) => void {
    let fn = this.#refs.get(key);
    if (!fn) {
      let current: Element | null = null;
      fn = (el) => {
        if (current) {
          this.ro?.unobserve(current);
          this.live.delete(current);
        }
        current = el;
        if (!el) {
          this.#refs.delete(key);
          return;
        }
        this.elKey.set(el, key);
        this.live.add(el);
        this.observer()?.observe(el);
      };
      this.#refs.set(key, fn);
    }
    return fn;
  }
}

/**
 * A virtualized masonry (Pinterest-style) layout: items of any height in `numColumns`
 * balanced columns, only those near the viewport rendered. Items are measured as they render
 * (give `getEstimatedItemSize`, e.g. from an image's aspect ratio, for a steadier scrollbar);
 * appends keep every placed item where it is; `onEndReached` loads the next page once per
 * data change. Import from `denext/virtual-masonry`.
 *
 * @param props See {@linkcode VirtualMasonryProps}.
 * @returns The masonry element.
 * @example
 * ```tsx
 * "use client";
 * import { VirtualMasonry } from "denext/virtual-masonry";
 *
 * export function Pins({ pins, more }) {
 *   return (
 *     <VirtualMasonry
 *       style={{ height: "100dvh" }}
 *       data={pins}
 *       numColumns={3}
 *       gap={8}
 *       getEstimatedItemSize={(p) => 240 / p.aspect}
 *       onEndReached={more}
 *       renderItem={(p) => <img src={p.src} style={{ width: "100%", aspectRatio: p.aspect }} />}
 *     />
 *   );
 * }
 * ```
 */
export function VirtualMasonry<T>(props: VirtualMasonryProps<T>): VNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const force = bump as unknown as () => void;
  const ref = useRef<MasonryController<T> | null>(null);
  if (ref.current === null) ref.current = new MasonryController<T>();
  const ctl = ref.current;
  ctl.force = force;
  ctl.sync(props);
  useLayoutEffect(() => () => ctl.cleanup?.(), [ctl]);
  useLayoutEffect(() => {
    ctl.mount();
    ctl.readMetrics();
    const s = ctl.readScroll();
    ctl.scroll = s;
    ctl.notify();
    if (ctl.range()) force();
  });
  useImperativeHandle(props.ref, () => ({
    scrollToIndex: (index, options) => {
      const n = ctl.layout.count;
      if (n === 0) return;
      const i = Math.max(0, Math.min(n - 1, Math.floor(index)));
      const p = ctl.layout.placement(i);
      const align = options?.align ?? "start";
      const at = align === "end"
        ? p.top + p.size - ctl.vp
        : align === "center"
        ? p.top + p.size / 2 - ctl.vp / 2
        : p.top;
      ctl.writeScroll(Math.max(0, at + ctl.lead), options?.behavior === "smooth");
      if (ctl.range()) force();
    },
    scrollToOffset: (offset, options) => {
      ctl.writeScroll(Math.max(0, offset + ctl.lead), options?.behavior === "smooth");
      if (ctl.range()) force();
    },
    getRenderedIndices: () => ctl.rendered,
  }), [ctl]);
  const cols = ctl.cols;
  const colGap = Math.max(0, props.columnGap ?? props.gap ?? 0);
  const width = `calc((100% - ${px(colGap * (cols - 1))}) / ${cols})`;
  const self = props.scrollElement !== "window";
  const n = props.data.length;
  return h(
    "div",
    {
      ref: (el: HTMLElement | null) => void (ctl.root = el),
      class: props.class ?? props.className,
      "data-denext-virtual-masonry": "",
      style: self
        ? {
          overflowY: "auto",
          overflowAnchor: "none",
          position: "relative",
          height: "100%",
          ...props.style,
        }
        : { ...props.style },
    },
    props.ListHeaderComponent ? h("div", { key: "header" }, slot(props.ListHeaderComponent)) : null,
    n === 0 && props.ListEmptyComponent
      ? h("div", { key: "empty", "data-vl-empty": "" }, slot(props.ListEmptyComponent))
      : h(
        "div",
        {
          key: "inner",
          ref: (el: HTMLElement | null) => void (ctl.inner = el),
          role: "list",
          "aria-label": props["aria-label"],
          style: { position: "relative", height: px(ctl.layout.height), width: "100%" },
        },
        ctl.rendered.map((i) => {
          const p = ctl.layout.placement(i);
          return h("div", {
            key: ctl.keys[i],
            ref: ctl.itemRef(ctl.keys[i]),
            role: "listitem",
            "aria-setsize": String(n),
            "aria-posinset": String(i + 1),
            "data-index": String(i),
            "data-column": String(p.column),
            style: {
              position: "absolute",
              top: px(p.top),
              left: `calc((${width} + ${px(colGap)}) * ${p.column})`,
              width,
            },
          }, props.renderItem(props.data[i], i));
        }),
      ),
    props.ListFooterComponent ? h("div", { key: "footer" }, slot(props.ListFooterComponent)) : null,
  );
}
