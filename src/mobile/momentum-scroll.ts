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
   * its momentum counts as settled, for WebKit builds without `scrollend`. Default `120`.
   */
  readonly settleMs?: number;
}

/** The default quiet period that ends a fling without a `scrollend` event. */
const DEFAULT_SETTLE_MS = 120;

/** The prototype members this module patches. `scroll` is `scrollTo`'s alias. */
const MEMBERS = ["scrollTop", "scrollLeft", "scrollBy", "scrollTo", "scroll"] as const;

/** One patched member of `Element.prototype`. */
type Member = typeof MEMBERS[number];

/** A scroll axis: `x` is `scrollLeft` / `left`, `y` is `scrollTop` / `top`. */
type Axis = "x" | "y";

/** The offset accessor behind each axis. */
const OFFSET_MEMBER: Record<Axis, "scrollLeft" | "scrollTop"> = { x: "scrollLeft", y: "scrollTop" };

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

/** What one scroller carries while a gesture is in flight. */
interface ScrollState {
  /** Deferred scroll delta not yet applied to the real offset. */
  readonly pending: { x: number; y: number };
  /** The finger has lifted and the scroller may still be flinging. */
  momentum: boolean;
  /** The settle timer that ends `momentum` without a `scrollend`. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Each child this module translated, with its previous inline `translate`. */
  readonly shifted: Map<Styled, string>;
  /** Re-applies the translate to children mounted while `pending` is non-zero. */
  observer: MutationObserver | undefined;
}

/** One installation: the saved descriptors, the gesture flag and the tracked scrollers. */
interface Session {
  readonly isElement: (value: unknown) => value is Element;
  readonly doc: Document;
  readonly saved: Readonly<Record<Member, PropertyDescriptor>>;
  readonly settleMs: number;
  /** Every scroller with a pending delta or a scroll during the current gesture. */
  readonly states: Map<Element, ScrollState>;
  touching: boolean;
}

/** Listener options for every document-level listener. */
const LISTEN: AddEventListenerOptions = { capture: true, passive: true };

// ---- offsets ------------------------------------------------------------------

/** The element's real scroll offset on `axis`, through the original getter. */
function realOffset(s: Session, el: Element, axis: Axis): number {
  return Number(s.saved[OFFSET_MEMBER[axis]].get!.call(el)) || 0;
}

/** The offset a caller expects: real plus whatever is still deferred. */
function virtualOffset(s: Session, el: Element, axis: Axis): number {
  return realOffset(s, el, axis) + (s.states.get(el)?.pending[axis] ?? 0);
}

/** A scroll write is deferred while a finger is down or the element is still flinging. */
function isActive(s: Session, el: Element): boolean {
  return s.touching || s.states.get(el)?.momentum === true;
}

/** The element's state, created on first use. */
function stateOf(s: Session, el: Element): ScrollState {
  let st = s.states.get(el);
  if (!st) {
    st = {
      pending: { x: 0, y: 0 },
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

/** Put every element child of `el` at `-pending`, remembering its previous inline value. */
function applyShift(el: Element, st: ScrollState): void {
  const { x, y } = st.pending;
  if (x === 0 && y === 0) return restoreShift(st);
  const value = `${-x}px ${-y}px`;
  for (const child of Array.from(el.children) as Styled[]) {
    if (!st.shifted.has(child)) st.shifted.set(child, child.style?.translate ?? "");
    setTranslate(child, value);
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
  for (const [child, previous] of st.shifted) setTranslate(child, previous);
  st.shifted.clear();
}

/** Shift children that mount while a delta is pending (where `MutationObserver` exists). */
function watchChildren(el: Element, st: ScrollState): void {
  if (st.observer || typeof MutationObserver !== "function") return;
  st.observer = new MutationObserver(() => applyShift(el, st));
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
    watchChildren(el, st);
    applyShift(el, st);
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

/**
 * End the element's gesture: restore its children's `translate`, then scroll the real offset by
 * the pending delta, in one synchronous step so no frame paints between the two.
 */
function flush(s: Session, el: Element): void {
  const st = s.states.get(el);
  if (!st) return;
  s.states.delete(el);
  clearTimeout(st.timer);
  st.observer?.disconnect();
  restoreShift(st);
  const { x, y } = st.pending;
  if (x !== 0 || y !== 0) realScrollBy(s, el, x, y);
}

/** Flush every tracked element. */
function flushAll(s: Session): void {
  for (const el of Array.from(s.states.keys())) flush(s, el);
}

/** (Re)start the quiet-period timer that ends the element's momentum. */
function armSettle(s: Session, el: Element, st: ScrollState): void {
  clearTimeout(st.timer);
  st.timer = setTimeout(safely(() => flush(s, el)), s.settleMs);
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

/** The delta a write on `axis` makes: the value itself (`relative`) or target minus virtual. */
function deltaOf(
  s: Session,
  el: Element,
  axis: Axis,
  value: number | undefined,
  relative: boolean,
): number {
  if (value === undefined) return 0;
  return relative ? value : value - virtualOffset(s, el, axis);
}

/**
 * Defer a `scrollBy` (`relative`) or `scrollTo`/`scroll` call when the element is active.
 * Returns `false` when the original must run. A smooth call is deliberate navigation: it
 * flushes the pending delta first, so its target is reached in real coordinates.
 */
function deferCall(s: Session, el: Element, args: readonly unknown[], relative: boolean): boolean {
  if (!isActive(s, el)) return false;
  const target = parseScrollArgs(args);
  if (!target) return false;
  if (target.smooth) {
    flush(s, el);
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

/** Every member's replacement descriptor. */
function patchedMembers(s: Session): Record<Member, PropertyDescriptor> {
  return {
    scrollTop: patchOffset(s, "y"),
    scrollLeft: patchOffset(s, "x"),
    scrollBy: patchMethod(s, "scrollBy", true),
    scrollTo: patchMethod(s, "scrollTo", false),
    scroll: patchMethod(s, "scroll", false),
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

// ---- gesture tracking --------------------------------------------------------------

/** The element a `scroll`/`scrollend` event belongs to (the document means its scroller). */
function scrollerOf(s: Session, target: EventTarget | null): Element | undefined {
  if (target === s.doc) return s.doc.scrollingElement ?? s.doc.documentElement ?? undefined;
  return s.isElement(target) ? target : undefined;
}

/** A finger went down: the gesture starts, and anything still pending is applied first. */
function onTouchStart(s: Session): void {
  s.touching = true;
  flushAll(s);
}

/** The last finger lifted: every scroller of this gesture enters momentum. */
function onTouchEnd(s: Session, event: Event): void {
  if (((event as TouchEvent).touches?.length ?? 0) > 0) return;
  s.touching = false;
  for (const [el, st] of s.states) {
    st.momentum = true;
    armSettle(s, el, st);
  }
}

/** A scroll: track it during a touch, extend momentum, and keep late children shifted. */
function onScroll(s: Session, event: Event): void {
  const el = scrollerOf(s, event.target);
  if (!el) return;
  const st = s.touching ? stateOf(s, el) : s.states.get(el);
  if (!st) return;
  if (st.momentum) armSettle(s, el, st);
  if (st.pending.x !== 0 || st.pending.y !== 0) applyShift(el, st);
}

/** `scrollend` ends momentum immediately where WebKit fires it. */
function onScrollEnd(s: Session, event: Event): void {
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

/** Add the document listeners; returns their removal. */
function listen(s: Session): () => void {
  const pairs: [string, (event: Event) => void][] = [
    ["touchstart", () => onTouchStart(s)],
    ["touchend", (event) => onTouchEnd(s, event)],
    ["touchcancel", (event) => onTouchEnd(s, event)],
    ["scroll", (event) => onScroll(s, event)],
    ["scrollend", (event) => onScrollEnd(s, event)],
  ];
  for (const pair of pairs) pair[1] = safely(pair[1]);
  for (const [type, fn] of pairs) s.doc.addEventListener(type, fn, LISTEN);
  return () => {
    for (const [type, fn] of pairs) s.doc.removeEventListener(type, fn, LISTEN);
  };
}

// ---- install ------------------------------------------------------------------------

/** The live installation, if any. */
let current: { readonly uninstall: () => void; explicit: boolean } | undefined;

/** Mounted `useMomentumSafeScroll` hooks. */
let hookRefs = 0;

/** A no-op uninstaller, for a page without a DOM. */
const NOOP = (): void => {};

/** Patch `Element.prototype` and listen on the document; returns the exact undo. */
function start(options: MomentumSafeScrollOptions): (() => void) | undefined {
  const g = globalThis as { document?: Document; Element?: typeof Element };
  const ElementCtor = g.Element;
  if (!g.document || typeof ElementCtor !== "function") return undefined;
  const proto = ElementCtor.prototype;
  const saved = saveMembers(proto);
  if (!saved) return undefined;
  const s: Session = {
    isElement: (value): value is Element => value instanceof ElementCtor,
    doc: g.document,
    saved,
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    states: new Map(),
    touching: false,
  };
  const unlisten = listen(s);
  Object.defineProperties(proto, patchedMembers(s));
  return () => {
    unlisten();
    flushAll(s);
    Object.defineProperties(proto, saved);
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
