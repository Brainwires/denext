/**
 * The momentum-safe scroll engine behind `denext/mobile`'s `installMomentumSafeScroll` and the
 * client runtime's automatic install on iOS (src/client/momentum-boot.ts).
 *
 * In iOS WebKit (Safari, WKWebView, Capacitor) any programmatic scroll write during a touch
 * fling (`scrollBy`, `scrollTo`, or assigning `scrollTop`) stops the momentum dead.
 * Virtualized lists with scroll anchoring (LegendList, react-virtuoso, TanStack Virtual) issue
 * exactly such writes while the user scrolls, to compensate for rows that measured taller or
 * shorter than estimated. This module defers those writes while a gesture is in flight, keeps
 * the picture correct with a CSS `translate` on the scroller's children, and applies the
 * accumulated offset in one step once the scroller comes to rest.
 *
 * Only element scrollers are deferred: the document scroller (`document.scrollingElement`,
 * `<html>`, `<body>`) is never shifted, since a transform on its children would re-parent every
 * `position: fixed` descendant. Its writes always go straight through.
 *
 * This module imports nothing on purpose: the runtime loads it as its own chunk on iOS only, and
 * a module shared with the runtime's static graph would be split into yet another shared chunk.
 * The platform gate lives with the callers (momentum.ts, momentum-boot.ts).
 *
 * @module
 */

/** Options for `installMomentumSafeScroll` and `useMomentumSafeScroll` (`denext/mobile`). */
export interface MomentumSafeScrollOptions {
  /**
   * Install on every platform, not only iOS/iPadOS WebKit (for tests and other WebKit
   * embeds that show the same bug). Default `false`.
   */
  readonly force?: boolean;
  /**
   * How long, in ms, a scroller must go without a `scroll` event after the finger lifts before
   * its momentum counts as settled, for WebKit builds without `scrollend`. Where `scrollend` is
   * supported it ends the fling instead, and only a 1 s idle fallback remains. Default `250`.
   */
  readonly settleMs?: number;
}

/** The default quiet period that ends a fling without a `scrollend` event. */
const DEFAULT_SETTLE_MS = 250;

/**
 * The idle window of the two safety nets: a finger that has shown no activity for this long is
 * treated as lifted (its `touchend` may have gone to a node removed mid-touch), and a flinging
 * scroller with `scrollend` support that has not scrolled for this long is flushed.
 */
const IDLE_MS = 1000;

/** The prototype members this module patches. `scroll` is `scrollTo`'s alias. */
const MEMBERS = ["scrollTop", "scrollLeft", "scrollBy", "scrollTo", "scroll"] as const;

/** One required patched member of `Element.prototype`. */
type Member = typeof MEMBERS[number];

/** A scroll axis: `x` is `scrollLeft` / `left`, `y` is `scrollTop` / `top`. */
type Axis = "x" | "y";

/** The offset accessor behind each axis. */
const OFFSET_MEMBER: Record<Axis, "scrollLeft" | "scrollTop"> = { x: "scrollLeft", y: "scrollTop" };

/** The content extents, patched to read as unshifted. */
type Extent = "scrollWidth" | "scrollHeight";

/** The content and viewport extents behind each axis' maximum offset. */
const EXTENT: Record<Axis, readonly [Extent, string]> = {
  x: ["scrollWidth", "clientWidth"],
  y: ["scrollHeight", "clientHeight"],
};

/** A scroll call's arguments, normalized: an axis left `undefined` is not written. */
interface ScrollTarget {
  readonly x?: number;
  readonly y?: number;
  readonly smooth: boolean;
}

/** An inline style holder: the part of `HTMLElement` this module touches. */
interface Styled {
  readonly style?: { translate?: string };
}

/** One translated child: its previous inline value, its own translate, and what was written. */
interface Shift {
  readonly previous: string;
  /** The child's own translate components (computed, read once), `[]` for none. */
  readonly base: readonly string[];
  applied: string;
  /** The inline value as read back after the write (a browser may normalize `calc()`). */
  readback: string | undefined;
}

/** What one scroller carries while a gesture is in flight. */
interface ScrollState {
  /** Deferred scroll delta not yet applied to the real offset. */
  readonly pending: { x: number; y: number };
  /** The delta currently shown by the children's translate (pending, clamped to the range). */
  readonly shown: { x: number; y: number };
  /** The finger has lifted and the scroller may still be flinging. */
  momentum: boolean;
  /** The settle timer that ends `momentum`. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Each child this module translated. */
  readonly shifted: Map<Styled, Shift>;
  /** Re-applies the translate to children mounted while `pending` is non-zero. */
  observer: MutationObserver | undefined;
}

/** A listener target: the document, the window, or the node a touch started on. */
interface Listenable {
  addEventListener(type: string, fn: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (event: Event) => void, options?: unknown): void;
}

/** One installation: the saved descriptors, the gesture flag and the tracked scrollers. */
interface Session {
  readonly isElement: (value: unknown) => value is Element;
  readonly doc: Document;
  readonly win: Listenable | undefined;
  readonly computed: ((el: Element) => { translate?: string }) | undefined;
  readonly saved: Readonly<Record<Member, PropertyDescriptor>>;
  readonly savedIntoView: PropertyDescriptor | undefined;
  readonly savedExtent: Partial<Record<Extent, PropertyDescriptor>>;
  readonly settleMs: number;
  /** Every scroller with a pending delta or a scroll during the current gesture. */
  readonly states: Map<Element, ScrollState>;
  /** Touch pointers down (from `pointerdown`), so `pointerup` ends only the last finger. */
  readonly pointers: Set<number>;
  touching: boolean;
  /** `scrollend` is supported (detected at install, or seen fired): no quiet-period flush. */
  scrollEnd: boolean;
  /** The idle watchdog that ends a touch whose `touchend` never arrived. */
  watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Removes the one-shot `touchend`/`touchcancel` listeners on the touched node. */
  untrack: (() => void) | undefined;
}

/** Listener options for every document- and window-level listener. */
const LISTEN: AddEventListenerOptions = { capture: true, passive: true };

// ---- offsets ------------------------------------------------------------------

/** The element's real scroll offset on `axis`, through the original getter. */
function realOffset(s: Session, el: Element, axis: Axis): number {
  return Number(s.saved[OFFSET_MEMBER[axis]].get!.call(el)) || 0;
}

/**
 * The element's content extent on `axis` (`scrollHeight`/`scrollWidth`) as if unshifted: a
 * translated child counts toward the scrollable overflow, so the shown shift is added back.
 * `NaN` when the element has no such extent.
 */
function extentOf(s: Session, el: Element, axis: Axis): number {
  const name = EXTENT[axis][0];
  const getter = s.savedExtent[name]?.get;
  const raw = getter ? getter.call(el) : (el as unknown as Record<string, unknown>)[name];
  return Number(raw) + (s.states.get(el)?.shown[axis] ?? 0);
}

/** The element's largest real offset on `axis`, or `Infinity` when its extents are unknown. */
function maxOffset(s: Session, el: Element, axis: Axis): number {
  const t = extentOf(s, el, axis);
  const v = Number((el as unknown as Record<string, unknown>)[EXTENT[axis][1]]);
  if (!(t > 0) || !Number.isFinite(v)) return Infinity;
  return Math.max(0, t - v);
}

/** `value` clamped to the element's scroll range on `axis`. */
function clampOffset(s: Session, el: Element, axis: Axis, value: number): number {
  return Math.min(maxOffset(s, el, axis), Math.max(0, value));
}

/** The offset a caller expects: real plus whatever is still deferred, within the range. */
function virtualOffset(s: Session, el: Element, axis: Axis): number {
  const pending = s.states.get(el)?.pending[axis] ?? 0;
  const real = realOffset(s, el, axis);
  return pending === 0 ? real : clampOffset(s, el, axis, real + pending);
}

/** The page's own scroller: never shifted, so its writes always go straight through. */
function isDocumentScroller(s: Session, el: Element): boolean {
  const d = s.doc as Partial<Document>;
  return el === d.scrollingElement || el === d.documentElement || el === d.body;
}

/** A scroll write is deferred while a finger is down or the element is still flinging. */
function isActive(s: Session, el: Element): boolean {
  if (!s.touching && s.states.get(el)?.momentum !== true) return false;
  return !isDocumentScroller(s, el);
}

/** The element's state, created on first use. */
function stateOf(s: Session, el: Element): ScrollState {
  let st = s.states.get(el);
  if (!st) {
    st = {
      pending: { x: 0, y: 0 },
      shown: { x: 0, y: 0 },
      momentum: false,
      timer: undefined,
      shifted: new Map(),
      observer: undefined,
    };
    s.states.set(el, st);
  }
  return st;
}

// ---- the visual shift -----------------------------------------------------------

/** Split a CSS value into its top-level space-separated components (`calc(a + b)` is one). */
function components(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (token) out.push(token);
      token = "";
    } else token += ch;
  }
  if (token) out.push(token);
  return out;
}

/** The child's own `translate` components: its computed value where available, else inline. */
function baseTranslate(s: Session, child: Styled): string[] {
  let value = child.style?.translate ?? "";
  try {
    if (s.computed && s.isElement(child)) value = s.computed(child).translate ?? value;
  } catch {
    // No computed style (a detached node): the inline value is the best available.
  }
  return value === "none" ? [] : components(value);
}

/** One axis of the composed translate: the child's own offset plus the shift. */
function composeAxis(base: string | undefined, delta: number): string {
  if (base === undefined || /^[+-]?0(?:px)?$/.test(base)) return `${delta}px`;
  return delta === 0 ? base : `calc(${base} + ${delta}px)`;
}

/** The inline `translate` that moves a child by `-shown` on top of its own translate. */
function composed(base: readonly string[], x: number, y: number): string {
  const value = `${composeAxis(base[0], -x)} ${composeAxis(base[1], -y)}`;
  return base[2] === undefined ? value : `${value} ${base[2]}`;
}

/**
 * Put every element child of `el` at `-pending` (clamped to the scroll range), composed with the
 * child's own translate. A child already showing this value is not written again (a `scroll`
 * event re-runs this for children mounted late, and a style write on every child each frame
 * would re-run style for the whole list).
 */
function applyShift(s: Session, el: Element, st: ScrollState): void {
  const x = virtualOffset(s, el, "x") - realOffset(s, el, "x");
  const y = virtualOffset(s, el, "y") - realOffset(s, el, "y");
  st.shown.x = x;
  st.shown.y = y;
  if (x === 0 && y === 0) return restoreShift(st);
  for (const child of Array.from(el.children) as Styled[]) {
    let shift = st.shifted.get(child);
    if (!shift) {
      const previous = child.style?.translate ?? "";
      shift = { previous, base: baseTranslate(s, child), applied: "", readback: undefined };
      st.shifted.set(child, shift);
    }
    const value = composed(shift.base, x, y);
    if (shift.applied === value && child.style?.translate === shift.readback) continue;
    shift.applied = value;
    setTranslate(child, value);
    shift.readback = child.style?.translate;
  }
}

/** Write one inline `translate`; a child that rejects it (no style, a throwing setter) is skipped. */
function setTranslate(child: Styled, value: string): void {
  try {
    if (child.style) child.style.translate = value;
  } catch {
    // A child that cannot be shifted stays where it is; the rest of the list still moves.
  }
}

/** Give every translated child its previous inline `translate` back. */
function restoreShift(st: ScrollState): void {
  for (const [child, shift] of st.shifted) setTranslate(child, shift.previous);
  st.shifted.clear();
  st.shown.x = 0;
  st.shown.y = 0;
}

/** Shift children that mount while a delta is pending (where `MutationObserver` exists). */
function watchChildren(s: Session, el: Element, st: ScrollState): void {
  if (st.observer || typeof MutationObserver !== "function") return;
  st.observer = new MutationObserver(safely(() => applyShift(s, el, st)));
  st.observer.observe(el, { childList: true });
}

// ---- defer / flush --------------------------------------------------------------

/** Add `dx`/`dy` to the element's pending delta and move its children to match. */
function defer(s: Session, el: Element, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const st = stateOf(s, el);
  st.pending.x += dx;
  st.pending.y += dy;
  try {
    watchChildren(s, el, st);
    applyShift(s, el, st);
  } catch (error) {
    // The original member will perform this write instead: take it back out of `pending`.
    st.pending.x -= dx;
    st.pending.y -= dy;
    throw error;
  }
}

/** Scroll the real offset by `x`/`y` without animation, through the original members. */
function realScrollBy(s: Session, el: Element, x: number, y: number): void {
  try {
    s.saved.scrollBy.value.call(el, { left: x, top: y, behavior: "instant" });
  } catch {
    // An engine without the "instant" behavior rejects the dictionary before scrolling.
    s.saved.scrollLeft.set!.call(el, realOffset(s, el, "x") + x);
    s.saved.scrollTop.set!.call(el, realOffset(s, el, "y") + y);
  }
}

/** Stop tracking `el` and give its children their translate back; returns the dropped delta. */
function release(s: Session, el: Element): { x: number; y: number } | undefined {
  const st = s.states.get(el);
  if (!st) return undefined;
  s.states.delete(el);
  clearTimeout(st.timer);
  st.observer?.disconnect();
  restoreShift(st);
  return st.pending;
}

/**
 * End the element's gesture: restore its children's `translate`, then scroll the real offset by
 * the pending delta, in one synchronous step so no frame paints between the two.
 */
function flush(s: Session, el: Element): void {
  const pending = release(s, el);
  if (pending && (pending.x !== 0 || pending.y !== 0)) realScrollBy(s, el, pending.x, pending.y);
}

/** Flush every tracked element. */
function flushAll(s: Session): void {
  for (const el of Array.from(s.states.keys())) flush(s, el);
}

/**
 * (Re)start the timer that ends the element's momentum: the quiet period where `scrollend` is
 * unsupported, else only the idle fallback (a main-thread stall must not flush mid-fling).
 */
function armSettle(s: Session, el: Element, st: ScrollState): void {
  clearTimeout(st.timer);
  const ms = s.scrollEnd ? Math.max(s.settleMs, IDLE_MS) : s.settleMs;
  st.timer = setTimeout(safely(() => flush(s, el)), ms);
}

// ---- patched members -------------------------------------------------------------

/** A coordinate as the browser normalizes it: non-finite reads as 0. */
function coordinate(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize `scrollBy`/`scrollTo` arguments: `(options?)` or `(x, y)`. `undefined` for a shape
 * the browser itself rejects, which is left to the original to throw.
 */
function parseScrollArgs(args: readonly unknown[]): ScrollTarget | undefined {
  const [a, b] = args;
  if (args.length === 0 || a === undefined || a === null) return { smooth: false };
  if (typeof a === "object") {
    const o = a as ScrollToOptions;
    const x = o.left === undefined ? undefined : coordinate(o.left);
    const y = o.top === undefined ? undefined : coordinate(o.top);
    return { x, y, smooth: o.behavior === "smooth" };
  }
  return args.length < 2 ? undefined : { x: coordinate(a), y: coordinate(b), smooth: false };
}

/**
 * The delta a write on `axis` makes: to the target (the value itself, or virtual plus the value
 * when `relative`) clamped to the scroll range, minus the virtual offset.
 */
function deltaOf(
  s: Session,
  el: Element,
  axis: Axis,
  value: number | undefined,
  relative: boolean,
): number {
  if (value === undefined) return 0;
  const virtual = virtualOffset(s, el, axis);
  return clampOffset(s, el, axis, relative ? virtual + value : value) - virtual;
}

/**
 * Defer a `scrollBy` (`relative`) or `scrollTo`/`scroll` call when the element is active.
 * Returns `false` when the original must run. A smooth call is deliberate navigation that
 * reaches the real offset: a smooth `scrollBy` applies the pending delta first (it is relative
 * to the virtual offset); a smooth `scrollTo` drops it (its target is absolute).
 */
function deferCall(s: Session, el: Element, args: readonly unknown[], relative: boolean): boolean {
  if (!isActive(s, el)) return false;
  const target = parseScrollArgs(args);
  if (!target) return false;
  if (target.smooth) {
    if (relative) flush(s, el);
    else release(s, el);
    return false;
  }
  defer(s, el, deltaOf(s, el, "x", target.x, relative), deltaOf(s, el, "y", target.y, relative));
  return true;
}

/** Defer a `scrollTop`/`scrollLeft` assignment when the element is active. */
function deferAssign(s: Session, el: Element, axis: Axis, value: unknown): boolean {
  if (!isActive(s, el)) return false;
  const delta = deltaOf(s, el, axis, coordinate(value), false);
  defer(s, el, axis === "x" ? delta : 0, axis === "y" ? delta : 0);
  return true;
}

/** Run `fn`; any internal error means "not handled", so the original runs instead. */
function guarded(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

/** The `scrollTop`/`scrollLeft` accessor: a virtual getter and a deferring setter. */
function patchOffset(s: Session, axis: Axis): PropertyDescriptor {
  const original = s.saved[OFFSET_MEMBER[axis]];
  return {
    ...original,
    get(this: Element): number {
      try {
        return virtualOffset(s, this, axis);
      } catch {
        return original.get!.call(this);
      }
    },
    set(this: Element, value: unknown): void {
      if (!guarded(() => deferAssign(s, this, axis, value))) original.set!.call(this, value);
    },
  };
}

/** A `scrollBy` (`relative`) or `scrollTo`/`scroll` method that defers while active. */
function patchMethod(s: Session, member: Member, relative: boolean): PropertyDescriptor {
  const original = s.saved[member];
  const fn = original.value as (...args: unknown[]) => void;
  return {
    ...original,
    value: function (this: Element, ...args: unknown[]): void {
      if (!guarded(() => deferCall(s, this, args, relative))) fn.apply(this, args);
    },
  };
}

/**
 * Drop the pending delta of every tracked scroller that contains `el`, restoring its children:
 * a `scrollIntoView` is about to move those scrollers for real, measured without the shift.
 */
function releaseAncestors(s: Session, el: Element): void {
  for (const scroller of Array.from(s.states.keys())) {
    if (scroller !== el && scroller.contains?.(el)) release(s, scroller);
  }
}

/** `scrollIntoView`, always passed through after the scrollers it moves drop their delta. */
function patchIntoView(s: Session, original: PropertyDescriptor): PropertyDescriptor {
  const fn = original.value as (...args: unknown[]) => void;
  return {
    ...original,
    value: function (this: Element, ...args: unknown[]): void {
      try {
        releaseAncestors(s, this);
      } catch {
        // The scroll into view still runs; a stale delta is applied at the next flush.
      }
      fn.apply(this, args);
    },
  };
}

/** Every member's replacement descriptor. */
function patchedMembers(s: Session): PropertyDescriptorMap {
  const members: PropertyDescriptorMap = {
    scrollTop: patchOffset(s, "y"),
    scrollLeft: patchOffset(s, "x"),
    scrollBy: patchMethod(s, "scrollBy", true),
    scrollTo: patchMethod(s, "scrollTo", false),
    scroll: patchMethod(s, "scroll", false),
  };
  if (s.savedIntoView) members.scrollIntoView = patchIntoView(s, s.savedIntoView);
  for (const axis of ["x", "y"] as const) {
    const name = EXTENT[axis][0];
    const original = s.savedExtent[name];
    if (original) members[name] = patchExtent(s, axis, original);
  }
  return members;
}

/**
 * `scrollHeight`/`scrollWidth`, read as if unshifted: a shifted list's children moved its
 * overflow edge by the shown delta, and `scrollTop = scrollHeight` must still reach the bottom.
 */
function patchExtent(s: Session, axis: Axis, original: PropertyDescriptor): PropertyDescriptor {
  return {
    ...original,
    get(this: Element): number {
      try {
        return extentOf(s, this, axis);
      } catch {
        return original.get!.call(this);
      }
    },
  };
}

/**
 * The prototype's own descriptors for every member, or `undefined` when one is missing or not
 * of the expected shape (then nothing is installed).
 */
function saveMembers(proto: object): Record<Member, PropertyDescriptor> | undefined {
  const saved: Partial<Record<Member, PropertyDescriptor>> = {};
  for (const member of MEMBERS) {
    const desc = Object.getOwnPropertyDescriptor(proto, member);
    const ok = member === "scrollTop" || member === "scrollLeft"
      ? typeof desc?.get === "function" && typeof desc.set === "function"
      : typeof desc?.value === "function";
    if (!ok || !desc?.configurable) return undefined;
    saved[member] = desc;
  }
  return saved as Record<Member, PropertyDescriptor>;
}

/** `scrollIntoView`'s own descriptor when it is a patchable method (it is optional). */
function saveIntoView(proto: object): PropertyDescriptor | undefined {
  const desc = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  return typeof desc?.value === "function" && desc.configurable ? desc : undefined;
}

/** The `scrollHeight`/`scrollWidth` getters that are patchable (they are optional). */
function saveExtents(proto: object): Partial<Record<Extent, PropertyDescriptor>> {
  const saved: Partial<Record<Extent, PropertyDescriptor>> = {};
  for (const name of ["scrollWidth", "scrollHeight"] as const) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof desc?.get === "function" && desc.configurable) saved[name] = desc;
  }
  return saved;
}

// ---- gesture tracking --------------------------------------------------------------

/** The element a `scroll`/`scrollend` event belongs to (the document means its scroller). */
function scrollerOf(s: Session, target: EventTarget | null): Element | undefined {
  if (target === s.doc) return s.doc.scrollingElement ?? s.doc.documentElement ?? undefined;
  return s.isElement(target) ? target : undefined;
}

/** (Re)start the watchdog that ends a touch after {@linkcode IDLE_MS} without activity. */
function touchActivity(s: Session): void {
  clearTimeout(s.watchdog);
  s.watchdog = setTimeout(
    safely(() => {
      endTouch(s);
      flushAll(s);
    }),
    IDLE_MS,
  );
}

/**
 * Listen for the end of this touch on the node it started on, once: WebKit dispatches
 * `touchend` to that node even after it left the document, where no document listener sees it.
 */
function trackTarget(s: Session, target: EventTarget | null): void {
  s.untrack?.();
  s.untrack = undefined;
  const node = target as Partial<Listenable> | null;
  if (!node || target === s.doc || typeof node.addEventListener !== "function") return;
  const end = safely((event: Event) => onTouchEnd(s, event));
  node.addEventListener("touchend", end, LISTEN);
  node.addEventListener("touchcancel", end, LISTEN);
  s.untrack = () => {
    node.removeEventListener?.("touchend", end, LISTEN);
    node.removeEventListener?.("touchcancel", end, LISTEN);
  };
}

/** A finger went down: the gesture starts, and anything still pending is applied first. */
function onTouchStart(s: Session, event: Event): void {
  s.touching = true;
  trackTarget(s, event.target);
  touchActivity(s);
  flushAll(s);
}

/** The touch phase is over (the last finger lifted, or the watchdog gave up on it). */
function endTouch(s: Session): void {
  s.touching = false;
  s.pointers.clear();
  clearTimeout(s.watchdog);
  s.untrack?.();
  s.untrack = undefined;
}

/** The last finger lifted: every scroller of this gesture enters momentum. */
function onTouchEnd(s: Session, event: Event): void {
  if (((event as TouchEvent).touches?.length ?? 0) > 0) return;
  endTouch(s);
  for (const [el, st] of s.states) {
    st.momentum = true;
    armSettle(s, el, st);
  }
}

/** A touch pointer went down (tracked so `pointerup` recognizes the last finger). */
function onPointerDown(s: Session, event: Event): void {
  const e = event as PointerEvent;
  if (e.pointerType === "touch") s.pointers.add(e.pointerId);
}

/**
 * A touch pointer lifted: the last one ends the touch, like `touchend`. `pointercancel` only
 * forgets the pointer: WebKit fires it as soon as a native pan takes the touch over, while the
 * finger is still down.
 */
function onPointerUp(s: Session, event: Event): void {
  const e = event as PointerEvent;
  if (e.pointerType !== "touch" || !s.touching) return;
  s.pointers.delete(e.pointerId);
  if (s.pointers.size === 0) onTouchEnd(s, event);
}

/** A touch pointer was taken over (a native pan) or lost: forget it, keep the gesture. */
function onPointerCancel(s: Session, event: Event): void {
  s.pointers.delete((event as PointerEvent).pointerId);
}

/** A scroll: track it during a touch, extend momentum, and keep late children shifted. */
function onScroll(s: Session, event: Event): void {
  const el = scrollerOf(s, event.target);
  if (!el) return;
  if (s.touching) touchActivity(s);
  const st = s.touching && !isDocumentScroller(s, el) ? stateOf(s, el) : s.states.get(el);
  if (!st) return;
  if (st.momentum) armSettle(s, el, st);
  if (st.pending.x !== 0 || st.pending.y !== 0) applyShift(s, el, st);
}

/** `scrollend` ends momentum immediately, and from now on replaces the quiet-period timer. */
function onScrollEnd(s: Session, event: Event): void {
  s.scrollEnd = true;
  const el = scrollerOf(s, event.target);
  if (el && s.states.get(el)?.momentum) flush(s, el);
}

/** `fn`, with any internal error swallowed: a scroll shim must never break the page's events. */
function safely<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch {
      // Nothing to fall back to: the gesture bookkeeping resets on the next touch.
    }
  };
}

/** Add `pairs` to `target` (each wrapped in {@linkcode safely}); returns their removal. */
function listenOn(target: Listenable, pairs: [string, (event: Event) => void][]): () => void {
  const wrapped = pairs.map(([type, fn]) => [type, safely(fn)] as const);
  for (const [type, fn] of wrapped) target.addEventListener(type, fn, LISTEN);
  return () => {
    for (const [type, fn] of wrapped) target.removeEventListener(type, fn, LISTEN);
  };
}

/** Add the document and window listeners; returns their removal. */
function listen(s: Session): () => void {
  const offDoc = listenOn(s.doc as unknown as Listenable, [
    ["touchstart", (event) => onTouchStart(s, event)],
    ["touchmove", () => touchActivity(s)],
    ["touchend", (event) => onTouchEnd(s, event)],
    ["touchcancel", (event) => onTouchEnd(s, event)],
    ["scroll", (event) => onScroll(s, event)],
    ["scrollend", (event) => onScrollEnd(s, event)],
  ]);
  const offWin = s.win
    ? listenOn(s.win, [
      ["pointerdown", (event) => onPointerDown(s, event)],
      ["pointerup", (event) => onPointerUp(s, event)],
      ["pointercancel", (event) => onPointerCancel(s, event)],
    ])
    : NOOP;
  return () => {
    offDoc();
    offWin();
    endTouch(s);
  };
}

// ---- install ------------------------------------------------------------------------

/** The live installation, if any. */
let current: { readonly uninstall: () => void; explicit: boolean } | undefined;

/** Mounted `useMomentumSafeScroll` hooks. */
let hookRefs = 0;

/** A no-op uninstaller, for a page without a DOM. */
const NOOP = (): void => {};

/** The globals the engine reads at install. */
interface Globals {
  document?: Document;
  Element?: typeof Element;
  getComputedStyle?: (el: Element) => { translate?: string };
  addEventListener?: unknown;
  onscrollend?: unknown;
}

/** A new session over `g`'s DOM, or `undefined` without one. */
function createSession(g: Globals, options: MomentumSafeScrollOptions): Session | undefined {
  const ElementCtor = g.Element;
  if (!g.document || typeof ElementCtor !== "function") return undefined;
  const saved = saveMembers(ElementCtor.prototype);
  if (!saved) return undefined;
  const getComputed = g.getComputedStyle;
  return {
    isElement: (value): value is Element => value instanceof ElementCtor,
    doc: g.document,
    win: typeof g.addEventListener === "function" ? g as unknown as Listenable : undefined,
    computed: typeof getComputed === "function" ? (el) => getComputed.call(g, el) : undefined,
    saved,
    savedIntoView: saveIntoView(ElementCtor.prototype),
    savedExtent: saveExtents(ElementCtor.prototype),
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    states: new Map(),
    pointers: new Set(),
    touching: false,
    scrollEnd: "onscrollend" in g,
    watchdog: undefined,
    untrack: undefined,
  };
}

/** Patch `Element.prototype` and listen on the document; returns the exact undo. */
function start(options: MomentumSafeScrollOptions): (() => void) | undefined {
  const s = createSession(globalThis as Globals, options);
  if (!s) return undefined;
  const proto = (globalThis as Globals).Element!.prototype;
  const originals: PropertyDescriptorMap = { ...s.saved, ...s.savedExtent };
  if (s.savedIntoView) originals.scrollIntoView = s.savedIntoView;
  const unlisten = listen(s);
  Object.defineProperties(proto, patchedMembers(s));
  return () => {
    unlisten();
    flushAll(s);
    Object.defineProperties(proto, originals);
  };
}

/** Install once; later calls return the existing uninstaller. */
function acquire(options: MomentumSafeScrollOptions): () => void {
  if (current) return current.uninstall;
  const stop = start(options);
  if (!stop) return NOOP;
  const uninstall = (): void => {
    if (current?.uninstall !== uninstall) return;
    current = undefined;
    stop();
  };
  current = { uninstall, explicit: false };
  return uninstall;
}

/**
 * Install the shim on any platform (the caller already applied the platform gate) and keep it
 * until the returned uninstaller runs: hook unmounts never remove an install made this way.
 * Idempotent: while installed, every call returns the same uninstaller.
 *
 * @param options `{ settleMs }` (`force` is the caller's concern and ignored here).
 * @returns The uninstaller.
 */
export function startMomentumSafeScroll(options: MomentumSafeScrollOptions = {}): () => void {
  const uninstall = acquire(options);
  if (current) current.explicit = true;
  return uninstall;
}

/**
 * Take a hook's share of the shim: installs it if needed; the returned release uninstalls it
 * when the last share goes, unless {@linkcode startMomentumSafeScroll} owns the install.
 *
 * @param options `{ settleMs }`, used only when this call installs.
 * @returns The release, to call once.
 */
export function retainMomentumSafeScroll(options: MomentumSafeScrollOptions = {}): () => void {
  hookRefs++;
  const uninstall = acquire(options);
  return () => {
    hookRefs--;
    if (hookRefs === 0 && current && !current.explicit) uninstall();
  };
}
