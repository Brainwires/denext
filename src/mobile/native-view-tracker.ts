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
  roundBox,
  toScreen,
  type ViewportLike,
  visiblePart,
} from "./native-view-geometry.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

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

/** One slot's position, as the native side applies it (visual viewport CSS px). */
export interface NativeViewFrame {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The visible part of the slot, or null when none of it is visible. */
  readonly clip: Box | null;
  /** Draw nothing (off-screen, inactive, or covered while drawn over the page). */
  readonly hidden: boolean;
  /** The slot's `active` prop (an embedded view, which the compositor clips, hides only for it). */
  readonly active: boolean;
  /** Whether touches over the visible part go to the native view (false while covered). */
  readonly interactive: boolean;
  /** Regions over the slot that belong to the page (its DOM overlays): touches there go to it. */
  readonly passthrough: readonly Box[];
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
  hitTest(x: number, y: number): unknown;
  dpr(): number;
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
    viewport: () => ({
      x: 0,
      y: 0,
      width: Number(w.innerWidth) || 0,
      height: Number(w.innerHeight) || 0,
    }),
    visualViewport: () => w.visualViewport as ViewportLike | undefined,
    styleOf: (el) => callOn(w, "getComputedStyle", [el], undefined),
    hitTest: (x, y) => callOn(doc, "elementFromPoint", [x, y], null),
    dpr: () => Number(w.devicePixelRatio) || 1,
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

/** The passthrough regions of `overlay` (each child's box), clipped to `clip`. */
function passthroughOf(overlay: GeometryElement | null, clip: Box, vv?: ViewportLike): Box[] {
  const children = (overlay as { children?: ArrayLike<GeometryElement> } | null)?.children;
  if (!children) return [];
  const out: Box[] = [];
  for (const child of Array.from(children)) {
    const r = intersect(toScreen(boxOf(child.getBoundingClientRect()), vv), clip);
    if (r) out.push(roundBox(r));
  }
  return out;
}

/** Measure one slot into the frame the native side applies. */
export function measureSlot(
  env: TrackerEnv,
  slot: TrackedSlot,
  clippers: readonly GeometryElement[],
): NativeViewFrame {
  const vv = env.visualViewport();
  const layoutBox = boxOf(slot.el.getBoundingClientRect());
  const visibleLayout = visiblePart(layoutBox, clippers, env.viewport());
  const box = roundBox(toScreen(layoutBox, vv));
  const active = slot.active();
  const base = { id: slot.id, ...box, active };
  if (!visibleLayout || !active) {
    return { ...base, clip: null, hidden: true, interactive: false, passthrough: [] };
  }
  const clip = roundBox(toScreen(visibleLayout, vv));
  const covered = isOccluded(slot.el, visibleLayout, (x, y) => env.hitTest(x, y));
  return {
    ...base,
    clip,
    // Drawn over the page, a covered view would draw over what covers it: hide it instead.
    hidden: covered && slot.placement === "over",
    interactive: !covered,
    passthrough: passthroughOf(slot.overlay(), clip, vv),
  };
}

/** Keeps every mounted slot's native view on its slot. */
export class NativeViewTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #stops: Array<() => void> = [];
  #hotUntil = 0;
  #frame: number | undefined;
  #timer: number | undefined;

  constructor(readonly plugin: NativeViewsPlugin, readonly env: TrackerEnv) {}

  /** Follow `slot`, measuring it right away. */
  add(slot: TrackedSlot): void {
    if (this.#entries.size === 0) this.#listen();
    const entry: Entry = { slot, clippers: null, last: "", stopResize: () => {} };
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
      const frame = measureSlot(this.env, entry.slot, entry.clippers);
      const key = JSON.stringify(frame);
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

/** The view types the native side has registered (asked once per page). */
export function registeredTypes(plugin: NativeViewsPlugin): Promise<string[]> {
  if (typesCache?.plugin !== plugin) {
    const types = plugin.types().then(
      (r) => Array.isArray(r?.types) ? r.types.filter((t) => typeof t === "string") : [],
      () => [],
    );
    typesCache = { plugin, types };
  }
  return typesCache.types;
}
