/**
 * The page side of the `DenextNativeViews` plugin behind `NativeViewSlot` (denext/mobile): the
 * plugin's JS surface, and one tracker per page that keeps every native view on its slot. The
 * tracker measures each slot's box, what its clipping ancestors and the viewport leave visible,
 * whether page content covers it, and the DOM overlays drawn over it, and sends what changed to
 * the native side in one `update` call per frame.
 *
 * It measures every animation frame while the page moves (a scroll, a resize, the keyboard, a CSS
 * transition or animation, a touch drag; for 500 ms after the last such event) and every 250 ms
 * otherwise, so a layout change with no event (content inserted above the slot) is caught within
 * a quarter second. Nothing runs until the first slot mounts, and everything stops after the last
 * one unmounts. Internal to `denext/mobile`; not re-exported.
 *
 * @module
 */

import {
  type Box,
  boxOf,
  clippingAncestors,
  type ClipStyle,
  type GeometryElement,
  intersect,
  isOccluded,
  nearestScroller,
  paddingBox,
  roundBox,
  samplePoints,
  toScreen,
  type ViewportLike,
  visiblePart,
} from "./native-view-geometry.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";
import { nativePlatform } from "./bridge.ts";

/**
 * Where a native view is drawn relative to the WebView.
 *
 * - `"embed"` (iOS): inside the page's own layer tree, in the native scroll view WebKit makes for
 *   an `overflow: scroll` element (what `@capacitor/google-maps` does). The compositor moves,
 *   clips and transforms it with the page, and DOM overlays draw above it.
 * - `"under"`: behind a transparent WebView, seen through a transparent hole in the page. DOM
 *   drawn over the slot shows above it; every ancestor of the slot must be transparent there.
 * - `"over"`: above the WebView, clipped to the slot's visible part. Needs nothing from the page,
 *   but no DOM can draw over it: it hides while page content covers any part of it.
 */
export type NativeViewPlacement = "embed" | "under" | "over";

/**
 * The scroll container a slot scrolls with: the document, or its nearest scrolling ancestor. The
 * native side follows its offset itself, in the same frame as the scroll (iOS: every
 * UIScrollView; Android: the document only), so a scroll needs no message from the page.
 */
export interface NativeViewScroller {
  /** Stable per scroll container on the page (the document is 0). */
  readonly id: number;
  readonly kind: "document" | "element";
  /** Its padding box on screen (visual viewport CSS px; the viewport for the document). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/** One slot's position, as the native side applies it. */
export interface NativeViewFrame {
  readonly id: string;
  /** The slot's box on screen (visual viewport CSS px), as of this measurement. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The visible part of the slot on screen, or null when none of it is visible. */
  readonly clip: Box | null;
  /** The scroll container the slot scrolls with. */
  readonly scroller: NativeViewScroller;
  /** The slot's box in that container's content coordinates (unchanged by scrolling it). */
  readonly content: Box;
  /**
   * The part of the slot (slot coordinates) that clipping boxes between it and its scroller
   * leave visible, or null when they hide all of it. The scrollers' own clips are native.
   */
  readonly localClip: Box | null;
  /**
   * Draw nothing: inactive, covered while drawn over the page, or (where the native side does not
   * follow the scroller) scrolled out of view.
   */
  readonly hidden: boolean;
  /** The slot's `active` prop. */
  readonly active: boolean;
  /** Page content covers part of the slot (a modal, a sheet, a sticky header). */
  readonly covered: boolean;
  /** Whether touches over the visible part go to the native view (false while covered). */
  readonly interactive: boolean;
  /** Regions (slot coordinates) that belong to the page: its DOM overlays. */
  readonly passthrough: readonly Box[];
  /** `"embed"`: the marker of the slot's scroller, which the native side attaches the view to. */
  readonly embedMarker?: number;
}

/** What `create` sends. */
export interface NativeViewCreateOptions {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly placement: NativeViewPlacement;
  /** `"embed"`: the slot's scroller is this many px taller than its box (how iOS finds it). */
  readonly embedMarker?: number;
}

/** The JS surface of the native `DenextNativeViews` plugin (`denext mobile add native-views`). */
export interface NativeViewsPlugin {
  /** The registered view types. */
  types(): Promise<{ types?: string[] }>;
  /** Make a view of `type`; resolves with the placement used (`"embed"` may fall back). */
  create(options: NativeViewCreateOptions): Promise<{ placement?: NativeViewPlacement }>;
  /** Move, clip, hide the views (`dpr` converts CSS px to device px on Android). */
  update(options: { frames: NativeViewFrame[]; dpr: number }): Promise<void>;
  /** Replace a view's props. */
  setProps(options: { id: string; props: Readonly<Record<string, unknown>> }): Promise<void>;
  /** Run a view's command (`play`, `setRegion`, …). */
  command(
    options: { id: string; name: string; args: Readonly<Record<string, unknown>> },
  ): Promise<Record<string, unknown> | undefined>;
  /** Remove a view. */
  destroy(options: { id: string }): Promise<void>;
  addListener(
    event: "nativeViewEvent",
    fn: (e: { id?: string; name?: string; data?: unknown }) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The plugin's JS name. */
const NATIVE_VIEWS_PLUGIN = "DenextNativeViews";

/** The `DenextNativeViews` plugin inside the shell, or undefined (web, SSR, not installed). */
export function nativeViewsPlugin(): NativeViewsPlugin | undefined {
  return nativePlugin<NativeViewsPlugin>(NATIVE_VIEWS_PLUGIN, [
    "types",
    "create",
    "update",
    "setProps",
    "command",
    "destroy",
  ]);
}

/** Everything the tracker reads from the page, injectable for tests. */
export interface TrackerEnv {
  now(): number;
  raf(cb: () => void): number;
  caf(id: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** The layout viewport, in its own coordinates. */
  viewport(): Box;
  visualViewport(): ViewportLike | undefined;
  styleOf(el: GeometryElement): ClipStyle | undefined;
  /** The elements at a point, topmost first. */
  hitTest(x: number, y: number): readonly unknown[];
  dpr(): number;
  /** The document's scroll offset and size. */
  pageScroll(): { x: number; y: number; width: number; height: number };
  /** Whether the native side follows a scroller of `kind` itself (no message per scroll). */
  nativeFollows(kind: NativeViewScroller["kind"]): boolean;
  /** Add a listener to the document (capture), the window or the visual viewport. */
  listen(
    target: "document" | "window" | "visualViewport",
    type: string,
    fn: () => void,
  ): () => void;
  /** Observe `el`'s size; returns the disconnect function. */
  observeResize(el: GeometryElement, fn: () => void): () => void;
}

/** A slot as the tracker follows it. */
export interface TrackedSlot {
  readonly id: string;
  readonly el: GeometryElement;
  readonly placement: NativeViewPlacement;
  /** `"embed"`: the slot scroller's marker (a view taken over by a new slot re-attaches by it). */
  readonly marker?: number;
  /** The DOM overlay container, whose children are passthrough regions. */
  overlay(): GeometryElement | null;
  /** Whether the view should show (the slot's `active` prop). */
  active(): boolean;
}

interface Entry {
  readonly slot: TrackedSlot;
  clippers: GeometryElement[] | null;
  last: string;
  stopResize: () => void;
  /** The covered answer in effect, and how many measurements in a row said otherwise. */
  covered: boolean | undefined;
  flips: number;
  /** The last raw (undebounced) covered answer, for the diagnostics. */
  raw?: boolean;
}

/**
 * Device-test diagnostics: with `globalThis.__DENEXT_NV_DEBUG__` set (a probe build sets it),
 * every change of a slot's raw covered answer is logged with the evidence (the visible part, the
 * sample points and the top of each point's hit-test stack). Off otherwise.
 */
function logOcclusion(env: TrackerEnv, entry: Entry, covered: boolean): void {
  if (!(globalThis as { __DENEXT_NV_DEBUG__?: boolean }).__DENEXT_NV_DEBUG__) return;
  const el = entry.slot.el;
  const visible = visiblePart(
    boxOf(el.getBoundingClientRect()),
    entry.clippers ?? [],
    env.viewport(),
  );
  const describe = (hit: unknown) => {
    const e = hit as { tagName?: string; className?: unknown; contains?: (o: unknown) => boolean };
    const cls = typeof e?.className === "string" && e.className
      ? `.${e.className.replaceAll(" ", ".")}`
      : "";
    const rel = hit === el
      ? "slot"
      : el.contains?.(hit)
      ? "inside"
      : e?.contains?.(el)
      ? "ancestor"
      : "OTHER";
    return `${(e?.tagName ?? "?").toLowerCase()}${cls}(${rel})`;
  };
  const points = visible
    ? samplePoints(visible).map(([x, y]) => ({
      x,
      y,
      stack: env.hitTest(x, y).slice(0, 4).map(describe),
    }))
    : [];
  console.log(
    "[nv-occ]",
    entry.slot.id,
    covered ? "covered" : "clear",
    JSON.stringify({
      viewport: env.viewport(),
      visible,
      points,
    }),
  );
}

/** How many measurements in a row must disagree before the covered answer changes. */
const COVER_CONFIRMATIONS = 2;

/**
 * `frame` with the covered answer debounced: it changes only after {@linkcode COVER_CONFIRMATIONS}
 * measurements in a row agree (a stray sample during a scroll, a row laid out for a frame over
 * the slot, never flickers the view). The first measurement is taken as is.
 */
function debounceCover(entry: Entry, frame: NativeViewFrame, placement: NativeViewPlacement) {
  if (entry.covered === undefined || frame.covered === entry.covered) {
    entry.covered = frame.covered;
    entry.flips = 0;
    return frame;
  }
  if (++entry.flips >= COVER_CONFIRMATIONS) {
    entry.covered = frame.covered;
    entry.flips = 0;
    return frame;
  }
  const covered = entry.covered;
  const over = placement === "over";
  // Hidden for another reason (inactive, off-screen) stays hidden.
  const otherwise = frame.hidden && !(frame.covered && over);
  return {
    ...frame,
    covered,
    interactive: frame.active && !covered,
    hidden: otherwise || (covered && over),
  };
}

/** How long the tracker keeps measuring every frame after the page last moved. */
const HOT_MS = 500;
/** How often it measures while the page is still. */
const IDLE_MS = 250;
/** The document events that mean the page is moving. */
const DOCUMENT_EVENTS = [
  "scroll",
  "transitionrun",
  "transitionend",
  "animationstart",
  "animationend",
  "touchmove",
  "pointermove",
  "visibilitychange",
] as const;

type Loose = Record<string, unknown> & { [k: string]: unknown };

/** The page's `window` (globalThis in a browser). */
function win(): Loose {
  return globalThis as unknown as Loose;
}

/** Call `fn` on `target` when it is a function there, else return `fallback`. */
function callOn<T>(target: unknown, name: string, args: unknown[], fallback: T): T {
  const fn = (target as Loose | undefined)?.[name];
  return typeof fn === "function" ? fn.apply(target, args) as T : fallback;
}

/** The tracker's environment in a browser. */
function browserEnv(): TrackerEnv {
  const w = win();
  const doc = w.document as Loose | undefined;
  return {
    now: () => (w.performance as { now?: () => number } | undefined)?.now?.() ?? Date.now(),
    raf: (cb) => callOn(w, "requestAnimationFrame", [cb], 0),
    caf: (id) => callOn(w, "cancelAnimationFrame", [id], undefined),
    setTimeout: (cb, ms) => Number(setTimeout(cb, ms)),
    clearTimeout: (id) => clearTimeout(id),
    viewport: () => {
      // What is on screen: the visual viewport (in layout viewport coordinates) where there is
      // one; innerHeight can include what the keyboard or the browser's chrome covers.
      const vv = w.visualViewport as ViewportLike | undefined;
      if (vv && vv.width > 0 && vv.height > 0) {
        return { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height };
      }
      return { x: 0, y: 0, width: Number(w.innerWidth) || 0, height: Number(w.innerHeight) || 0 };
    },
    visualViewport: () => w.visualViewport as ViewportLike | undefined,
    styleOf: (el) => callOn(w, "getComputedStyle", [el], undefined),
    hitTest: (x, y) => {
      const all = callOn<unknown[] | undefined>(doc, "elementsFromPoint", [x, y], undefined);
      return all ?? [callOn(doc, "elementFromPoint", [x, y], null)];
    },
    dpr: () => Number(w.devicePixelRatio) || 1,
    pageScroll: () => {
      const root = (doc?.scrollingElement ?? doc?.documentElement) as GeometryElement | undefined;
      return {
        x: Number(w.scrollX) || 0,
        y: Number(w.scrollY) || 0,
        width: root?.scrollWidth ?? 0,
        height: root?.scrollHeight ?? 0,
      };
    },
    nativeFollows: (kind) => nativePlatform() === "ios" || kind === "document",
    listen: (target, type, fn) => {
      const t = target === "document" ? doc : target === "window" ? w : w.visualViewport;
      const opts = { capture: target === "document", passive: true };
      callOn(t, "addEventListener", [type, fn, opts], undefined);
      return () => callOn(t, "removeEventListener", [type, fn, opts], undefined);
    },
    observeResize: (el, fn) => {
      const RO = w.ResizeObserver as (new (cb: () => void) => Loose) | undefined;
      if (typeof RO !== "function") return () => {};
      const ro = new RO(fn);
      callOn(ro, "observe", [el], undefined);
      return () => callOn(ro, "disconnect", [], undefined);
    },
  };
}

/** The passthrough regions of `overlay` (each child's box), in slot coordinates. */
function passthroughOf(overlay: GeometryElement | null, slotBox: Box): Box[] {
  const children = (overlay as { children?: ArrayLike<GeometryElement> } | null)?.children;
  if (!children) return [];
  const out: Box[] = [];
  const whole = { x: 0, y: 0, width: slotBox.width, height: slotBox.height };
  for (const child of Array.from(children)) {
    const b = boxOf(child.getBoundingClientRect());
    const r = intersect({ ...b, x: b.x - slotBox.x, y: b.y - slotBox.y }, whole);
    if (r) out.push(roundBox(r));
  }
  return out;
}

/** `b` moved into the coordinates of a space whose origin is at `origin`. */
function relativeTo(b: Box, origin: { x: number; y: number }): Box {
  return { x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height };
}

/** Ids for scroll containers (the document is 0), one set per tracker. */
type ScrollerIds = WeakMap<object, number> & { next?: number };

/** The scroller a slot scrolls with, and the slot's box in its content coordinates. */
function scrollerOf(
  env: TrackerEnv,
  ids: ScrollerIds,
  scroller: GeometryElement | null,
  layoutBox: Box,
): { info: NativeViewScroller; content: Box } {
  const vv = env.visualViewport();
  if (!scroller) {
    const page = env.pageScroll();
    const view = toScreen(env.viewport(), vv);
    return {
      info: {
        id: 0,
        kind: "document",
        ...roundBox(view),
        scrollLeft: page.x,
        scrollTop: page.y,
        scrollWidth: page.width,
        scrollHeight: page.height,
      },
      content: roundBox({ ...layoutBox, x: layoutBox.x + page.x, y: layoutBox.y + page.y }),
    };
  }
  let id = ids.get(scroller);
  if (id === undefined) ids.set(scroller, id = ids.next = (ids.next ?? 0) + 1);
  const pad = paddingBox(scroller);
  const left = scroller.scrollLeft ?? 0;
  const top = scroller.scrollTop ?? 0;
  return {
    info: {
      id,
      kind: "element",
      ...roundBox(toScreen(pad, vv)),
      scrollLeft: left,
      scrollTop: top,
      scrollWidth: scroller.scrollWidth ?? pad.width,
      scrollHeight: scroller.scrollHeight ?? pad.height,
    },
    content: roundBox({
      ...relativeTo(layoutBox, pad),
      x: layoutBox.x - pad.x + left,
      y: layoutBox.y - pad.y + top,
    }),
  };
}

/** The part of the slot the clippers inside its scroller leave, in slot coordinates. */
function localClipOf(layoutBox: Box, inner: readonly GeometryElement[]): Box | null {
  let visible: Box | null = layoutBox;
  for (const c of inner) {
    if (!visible) return null;
    visible = intersect(visible, paddingBox(c));
  }
  return visible && roundBox(relativeTo(visible, layoutBox));
}

/** Measure one slot into the frame the native side applies. */
export function measureSlot(
  env: TrackerEnv,
  slot: TrackedSlot,
  clippers: readonly GeometryElement[],
  ids: ScrollerIds = new WeakMap(),
): NativeViewFrame {
  const vv = env.visualViewport();
  const layoutBox = boxOf(slot.el.getBoundingClientRect());
  const visibleLayout = visiblePart(layoutBox, clippers, env.viewport());
  const scrollerEl = nearestScroller(clippers, (el) => env.styleOf(el));
  const inner = scrollerEl ? clippers.slice(0, clippers.indexOf(scrollerEl)) : clippers;
  const { info, content } = scrollerOf(env, ids, scrollerEl, layoutBox);
  const active = slot.active();
  const covered = visibleLayout !== null && active &&
    isOccluded(slot.el, visibleLayout, (x, y) => env.hitTest(x, y));
  const follows = env.nativeFollows(info.kind);
  return {
    id: slot.id,
    ...roundBox(toScreen(layoutBox, vv)),
    clip: visibleLayout && roundBox(toScreen(visibleLayout, vv)),
    scroller: info,
    content,
    localClip: localClipOf(layoutBox, inner),
    // Drawn over the page, a covered view would draw over what covers it: hide it instead.
    hidden: !active || (covered && slot.placement === "over") || (!follows && !visibleLayout),
    active,
    covered,
    interactive: active && !covered,
    passthrough: passthroughOf(slot.overlay(), layoutBox),
    ...(slot.placement === "embed" && slot.marker ? { embedMarker: slot.marker } : {}),
  };
}

/**
 * What decides whether a frame must be sent: everything but the scroll-driven fields when the
 * native side follows the scroller itself (then a scroll sends nothing).
 */
function frameKey(env: TrackerEnv, f: NativeViewFrame): string {
  if (!env.nativeFollows(f.scroller.kind)) return JSON.stringify(f);
  const { x: _x, y: _y, clip: _clip, scroller, ...rest } = f;
  const { x: _sx, y: _sy, scrollLeft: _l, scrollTop: _t, ...size } = scroller;
  return JSON.stringify({ ...rest, size });
}

/** Keeps every mounted slot's native view on its slot. */
export class NativeViewTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #scrollerIds: ScrollerIds = new WeakMap();
  readonly #stops: Array<() => void> = [];
  #hotUntil = 0;
  #frame: number | undefined;
  #timer: number | undefined;

  constructor(readonly plugin: NativeViewsPlugin, readonly env: TrackerEnv) {}

  /** Follow `slot`, measuring it right away. */
  add(slot: TrackedSlot): void {
    if (this.#entries.size === 0) this.#listen();
    const entry: Entry = {
      slot,
      clippers: null,
      last: "",
      stopResize: () => {},
      covered: undefined,
      flips: 0,
    };
    entry.stopResize = this.env.observeResize(slot.el, () => {
      entry.clippers = null;
      this.kick();
    });
    this.#entries.set(slot.id, entry);
    this.kick();
  }

  /** Stop following slot `id`. */
  remove(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.stopResize();
    this.#entries.delete(id);
    if (this.#entries.size === 0) this.#stop();
  }

  /** The page moved: measure every frame for the next {@linkcode HOT_MS}. */
  kick(): void {
    this.#hotUntil = this.env.now() + HOT_MS;
    if (this.#frame !== undefined) return;
    if (this.#timer !== undefined) {
      this.env.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#frame = this.env.raf(() => {
      this.#frame = undefined;
      this.tick();
    });
  }

  /** Measure every slot, send what changed, and schedule the next measurement. */
  tick(): void {
    const changed: NativeViewFrame[] = [];
    for (const entry of this.#entries.values()) {
      entry.clippers ??= clippingAncestors(entry.slot.el, (el) => this.env.styleOf(el));
      const measured = measureSlot(this.env, entry.slot, entry.clippers, this.#scrollerIds);
      if (measured.covered !== entry.raw) {
        entry.raw = measured.covered;
        logOcclusion(this.env, entry, measured.covered);
      }
      const frame = debounceCover(entry, measured, entry.slot.placement);
      const key = frameKey(this.env, frame);
      if (key === entry.last) continue;
      entry.last = key;
      changed.push(frame);
    }
    if (changed.length > 0) {
      this.plugin.update({ frames: changed, dpr: this.env.dpr() }).catch(() => {});
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#entries.size === 0) return;
    if (this.env.now() < this.#hotUntil) {
      this.#frame = this.env.raf(() => {
        this.#frame = undefined;
        this.tick();
      });
      return;
    }
    this.#timer = this.env.setTimeout(() => {
      this.#timer = undefined;
      this.tick();
    }, IDLE_MS);
  }

  #listen(): void {
    const kick = () => this.kick();
    for (const type of DOCUMENT_EVENTS) this.#stops.push(this.env.listen("document", type, kick));
    for (const type of ["resize", "orientationchange"]) {
      this.#stops.push(this.env.listen("window", type, kick));
    }
    for (const type of ["resize", "scroll"]) {
      this.#stops.push(this.env.listen("visualViewport", type, kick));
    }
  }

  #stop(): void {
    for (const stop of this.#stops.splice(0)) stop();
    if (this.#frame !== undefined) this.env.caf(this.#frame);
    if (this.#timer !== undefined) this.env.clearTimeout(this.#timer);
    this.#frame = undefined;
    this.#timer = undefined;
    this.#hotUntil = 0;
  }
}

/** The page's tracker and event routing, made on first use. */
interface PageState {
  tracker: NativeViewTracker;
  handlers: Map<string, (name: string, data: unknown) => void>;
  stopEvents: (() => void) | undefined;
}

let page: PageState | undefined;

/** The page's tracker for `plugin` (a new one when the plugin changed, e.g. across tests). */
export function pageTracker(plugin: NativeViewsPlugin, env?: TrackerEnv): NativeViewTracker {
  if (page?.tracker.plugin !== plugin) {
    page?.stopEvents?.();
    page = {
      tracker: new NativeViewTracker(plugin, env ?? browserEnv()),
      handlers: new Map(),
      stopEvents: undefined,
    };
  }
  return page.tracker;
}

/**
 * Route the plugin's `nativeViewEvent`s for view `id` to `fn` until the returned function runs.
 * One plugin listener serves every view on the page.
 */
export function onNativeViewEvent(
  plugin: NativeViewsPlugin,
  id: string,
  fn: (name: string, data: unknown) => void,
): () => void {
  pageTracker(plugin);
  const state = page!;
  state.handlers.set(id, fn);
  state.stopEvents ??= listenerDisposer(
    plugin.addListener("nativeViewEvent", (e) => {
      if (typeof e?.id !== "string" || typeof e.name !== "string") return;
      state.handlers.get(e.id)?.(e.name, e.data);
    }),
  );
  return () => {
    state.handlers.delete(id);
    if (state.handlers.size > 0) return;
    state.stopEvents?.();
    state.stopEvents = undefined;
  };
}

let typesCache: { plugin: NativeViewsPlugin; types: Promise<string[]> } | undefined;

/**
 * The view types the native side has registered (asked once per page). The first ask also
 * resets the plugin: views an earlier page left (a reload, an over-the-air UI switch) are
 * removed before this page makes any. (A Fast Refresh keeps this module, so it keeps its views.)
 */
export function registeredTypes(plugin: NativeViewsPlugin): Promise<string[]> {
  if (typesCache?.plugin !== plugin) {
    const reset = (plugin as { reset?: () => Promise<void> }).reset;
    const fresh = typeof reset === "function"
      ? Promise.resolve().then(() => reset.call(plugin)).catch(() => {})
      : Promise.resolve();
    const types = fresh.then(() => plugin.types()).then(
      (r) => Array.isArray(r?.types) ? r.types.filter((t) => typeof t === "string") : [],
      () => [],
    );
    typesCache = { plugin, types };
  }
  return typesCache.types;
}
