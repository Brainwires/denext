// Root event delegation (React 17+'s model). Every root container and every portal target gets
// one capture and one bubble listener per bubbling event type; a handler prop on an element
// registers nothing on that element. When an event reaches a container, the dispatcher finds
// the fiber of the event's target (dom-fiber-map, recorded at commit), walks the fiber tree up
// to the root — through portals, so a portal's events reach the component ancestors that
// rendered it — and runs the matching `on*Capture` handlers root → target, or `on*` handlers
// target → root, reading each element's COMMITTED props. Propagation stops between elements
// once a handler calls `stopPropagation()`; the event a handler gets is the native event with
// `currentTarget` set to the handler's element for the duration of the call.
//
// What stays on the element (dom-props' own listener, as in React): events that do not bubble
// (scroll, load, error, media events, toggle, …), `wheel` / `touch*` (dom-props registers
// `touchstart` / `touchmove` / `wheel` PASSIVE, as React DOM does — see
// runtime/passive-events.ts — so a handler never holds a scroll on the main thread), and
// event types this module does not know (a custom element's events may not bubble).
// `onFocus` / `onBlur` listen to `focusin` / `focusout` (handlers see `type` "focus" /
// "blur"), and `onMouseEnter` / `onMouseLeave` / `onPointerEnter` / `onPointerLeave` are
// derived from the over/out pair, so they fire for the elements actually entered and left,
// outermost first on enter.

import { fiberForNode } from "../dom-fiber-map.ts";
import { beginEventDispatch, endEventDispatch } from "../event-priority.ts";
import { type Fiber, hasBit, UnmountedBit } from "./fiber.ts";
import { handleEventError } from "./boundaries.ts";

/** The bubbling event types dispatched from the containers. */
const DELEGATED = /* @__PURE__ */ new Set(
  ("click contextmenu copy cut paste dblclick auxclick drag dragend dragenter dragleave " +
    "dragover dragstart drop input beforeinput keydown keypress keyup mousedown " +
    "mousemove mouseout mouseover mouseup pointercancel pointerdown pointermove pointerout " +
    "pointerover pointerup gotpointercapture lostpointercapture submit reset focusin focusout " +
    "compositionstart compositionend compositionupdate animationstart animationend " +
    "animationiteration transitionstart transitionend transitionrun transitioncancel").split(" "),
);

/** The handler props seen per DOM type (`type` bubble, `type!` capture), in first-seen order. */
const propsByType = new Map<string, string[]>();
/** Enter/leave handlers seen: 1 = mouse, 2 = pointer. Until then over/out skip the derivation. */
let enterLeave = 0;
/** Containers already listening. */
const listening = new WeakSet<object>();

type Handler = (event: unknown) => unknown;

/**
 * Note an event prop: true when the delegation dispatches it (the element gets no listener of
 * its own), false when the element must listen itself.
 */
export function delegates(type: string, capture: boolean, prop: string): boolean {
  if (!capture && (type === "mouseenter" || type === "mouseleave")) return !!(enterLeave |= 1);
  if (!capture && (type === "pointerenter" || type === "pointerleave")) {
    return !!(enterLeave |= 2);
  }
  if (!DELEGATED.has(type)) return false;
  const key = capture ? type + "!" : type;
  let list = propsByType.get(key);
  if (list === undefined) propsByType.set(key, list = []);
  if (!list.includes(prop)) list.push(prop);
  return true;
}

/** Listen on a root container or portal target (once per container). */
export function listenOn(container: EventTarget): void {
  if (listening.has(container)) return;
  listening.add(container);
  for (const type of DELEGATED) {
    container.addEventListener(type, onCapture, true);
    container.addEventListener(type, onBubble, false);
  }
}

function onCapture(event: Event): void {
  dispatch(event, true);
}

/** The over/out events enter/leave derive from: 1 = mouse, 2 = pointer (see `enterLeave`). */
const OVER_OUT: Record<string, number> = {
  mouseover: 1,
  mouseout: 1,
  pointerover: 2,
  pointerout: 2,
};

function onBubble(event: Event): void {
  dispatch(event, false);
  // After the event's own `on*Over` / `on*Out` handlers, as React orders its plugins.
  if ((enterLeave & OVER_OUT[event.type]) !== 0) dispatchEnterLeave(event);
}

/** The root or portal fiber `f` renders under, or null for a detached (unmounted) fiber. */
function ownerOf(f: Fiber): Fiber | null {
  if (hasBit(f, UnmountedBit)) return null;
  for (let p = f.return; p !== null; p = p.return) {
    if (p.tag === "root" || p.tag === "portal") return p;
  }
  return null;
}

/** The nearest recorded host fiber at or above `node`, stopping at `stop`. */
function nearestFiber(node: unknown, stop: unknown): Fiber | undefined {
  for (let n = node as Node | null; n != null && n !== stop; n = n.parentNode) {
    const f = fiberForNode(n);
    if (f !== undefined) return f;
  }
  return undefined;
}

/**
 * The fiber an event at `container` starts from: the target's fiber when `container` owns it.
 * A target in a portal is dispatched by the portal's own container; a target in a root nested
 * inside this container's tree (an island) continues here from the element hosting that root,
 * unless `direct`.
 */
function startFiber(target: unknown, container: unknown, direct?: boolean): Fiber | null {
  let node = target;
  for (;;) {
    const f = nearestFiber(node, container);
    if (f === undefined) return null;
    const owner = ownerOf(f);
    if (owner === null) return null;
    if (owner.stateNode === container) return f;
    if (direct || owner.tag !== "root") return null;
    node = owner.stateNode;
  }
}

/** The fiber holding `f`'s committed props: the one recorded for its element. */
function committed(f: Fiber): Fiber {
  const s = fiberForNode(f.stateNode);
  return s !== undefined && (s === f || s === f.alternate) ? s : f;
}

/**
 * The host fibers from `f` up to its root (through portals), each with its committed props.
 * Flattened triples: fiber, element, props.
 */
function hostPath(f: Fiber | null): unknown[] {
  const out: unknown[] = [];
  for (; f !== null && f.tag !== "root"; f = f.return) {
    if (f.tag !== "host" && f.tag !== "singleton") continue;
    const c = committed(f);
    out.push(c, f.stateNode, c.vnode.props);
  }
  return out;
}

/** React's event `type` for the DOM events its props listen to under another name. */
const REACT_TYPE: Record<string, string> = { focusin: "focus", focusout: "blur" };

function dispatch(event: Event, capture: boolean): void {
  const names = propsByType.get(capture ? event.type + "!" : event.type);
  if (names === undefined) return;
  const start = startFiber(event.target, event.currentTarget);
  // Capture runs root → target, bubble target → root.
  if (start !== null) run(event, collect(hostPath(start), names, capture), REACT_TYPE[event.type]);
}

/** The (fiber, element, handler) triples for `names` along `path`, in order or reversed. */
function collect(path: unknown[], names: string[], reverse: boolean): unknown[] {
  const calls: unknown[] = [];
  for (let k = 0; k < path.length; k += 3) {
    const i = reverse ? path.length - 3 - k : k;
    const props = path[i + 2] as Record<string, unknown> | null;
    for (const name of names) {
      const h = props?.[name];
      if (typeof h === "function") calls.push(path[i], path[i + 1], h);
    }
  }
  return calls;
}

/**
 * Run `calls` (fiber, element, handler triples) against `event`: `currentTarget` (and, for a
 * focus event, `type`) shadowed per handler and restored after, propagation checked between
 * elements, a thrown or rejected handler routed to its element's error boundary.
 */
function run(event: Event, calls: unknown[], type?: string): void {
  if (calls.length === 0) return;
  const e = event as unknown as Record<string, unknown>;
  const ownTarget = Object.getOwnPropertyDescriptor(e, "currentTarget");
  const ownType = Object.getOwnPropertyDescriptor(e, "type");
  beginEventDispatch();
  addSyntheticEventMembers(event);
  if (type !== undefined) shadow(e, "type", type);
  let el: unknown = null;
  try {
    for (let i = 0; i < calls.length; i += 3) {
      if (calls[i + 1] !== el) {
        if (el !== null && e.cancelBubble === true) break;
        el = calls[i + 1];
        shadow(e, "currentTarget", el);
      }
      const fiber = calls[i] as Fiber;
      try {
        const r = (calls[i + 2] as Handler)(event);
        if (r && typeof (r as { then?: unknown }).then === "function") {
          (r as Promise<unknown>).then(undefined, (err) => handleEventError(fiber, err));
        }
      } catch (err) {
        handleEventError(fiber, err);
      }
    }
  } finally {
    restore(e, "currentTarget", ownTarget);
    if (type !== undefined) restore(e, "type", ownType);
    endEventDispatch();
  }
}

function shadow(e: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(e, key, { value, configurable: true, writable: true });
}

function restore(e: Record<string, unknown>, key: string, own?: PropertyDescriptor): void {
  if (own) Object.defineProperty(e, key, own);
  else delete e[key];
}

/**
 * The fibers an over/out event leaves and enters, or null when this container does not own it.
 * An over from an element this runtime renders was already handled by that element's out.
 */
function enterLeaveEnds(event: Event): [Fiber | null, Fiber | null] | null {
  const over = event.type.endsWith("over");
  const related = (event as MouseEvent).relatedTarget;
  let other = related ? nearestFiber(related, null) ?? null : null;
  if (other !== null && ownerOf(other) === null) other = null;
  if (over && other !== null) return null;
  const here = startFiber(event.target, event.currentTarget, true);
  if (here === null) return null;
  return over ? [null, here] : [here, other];
}

/** How many path entries of `leave` and of `enter` lie below the first element they share. */
function belowCommon(leave: unknown[], enter: unknown[]): [number, number] {
  let cut = 0;
  while (cut < leave.length && !enter.includes(leave[cut + 1])) cut += 3;
  const common = leave[cut + 1];
  let enterCut = 0;
  while (enterCut < enter.length && enter[enterCut + 1] !== common) enterCut += 3;
  return [cut, enterCut];
}

/**
 * Derive enter/leave from an out (or, entering from outside the document, an over) event, as
 * React does: leave every element from the one left up to the common ancestor (innermost
 * first), then enter every element from below that ancestor down to the one entered.
 */
function dispatchEnterLeave(event: Event): void {
  const ends = enterLeaveEnds(event);
  if (ends === null) return;
  const [from, to] = ends;
  const leave = hostPath(from);
  const enter = hostPath(to);
  const [cut, enterCut] = belowCommon(leave, enter);
  const fromEl = from?.stateNode ?? null;
  const toEl = to?.stateNode ?? null;
  const kind = event.type[0] === "p" ? "Pointer" : "Mouse";
  const lower = kind.toLowerCase();
  run(
    derived(event, lower + "leave", fromEl, toEl),
    collect(leave.slice(0, cut), [`on${kind}Leave`], false),
  );
  run(
    derived(event, lower + "enter", toEl, fromEl),
    collect(enter.slice(0, enterCut), [`on${kind}Enter`], true),
  );
}

/**
 * An enter/leave event: the over/out event it derives from (every pointer field, read through)
 * with its own `type`, `target` and `relatedTarget`; it does not bubble.
 */
function derived(native: Event, type: string, target: unknown, relatedTarget: unknown): Event {
  const own: Record<PropertyKey, unknown> = {
    ...SYNTHETIC_MEMBERS,
    type,
    target,
    relatedTarget,
    bubbles: false,
    cancelBubble: false,
    nativeEvent: native,
    stopPropagation() {},
  };
  return new Proxy(native, {
    get(t, k) {
      if (k in own) return own[k];
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
    has: (t, k) => k in own || k in t,
    defineProperty: (_, k, d) => (own[k] = d.value, true),
    deleteProperty: (_, k) => delete own[k],
  });
}

// React's SyntheticEvent members that denext's native event lacks, installed as own
// properties on each dispatched event (never on `Event.prototype`, so nothing leaks into
// code outside denext's handlers). One shared object of methods that read `this`, so no
// per-event closures. `persist()` is a no-op since React 17 (events are never pooled).
const SYNTHETIC_MEMBERS: Record<string, unknown> = {
  persist() {},
  isPersistent: () => true,
  isDefaultPrevented(this: Event): boolean {
    return !!this.defaultPrevented;
  },
  isPropagationStopped(this: Event): boolean {
    // `cancelBubble` reads back the event's stop-propagation flag (DOM Living Standard).
    return !!this.cancelBubble;
  },
};

/**
 * React-compat: give the native event the SyntheticEvent surface libraries call.
 * `nativeEvent` — libraries (Base UI / floating-ui-react, etc.) reach the DOM event via
 * `event.nativeEvent` (and gate on `"nativeEvent" in event`); React's
 * `SyntheticEvent.nativeEvent` IS the DOM event and denext's event already is that DOM
 * event, so the self-reference is faithful. `persist()` / `isPersistent()` — React 17+
 * keeps them as no-op / `true` (react-native-web's ScrollView calls `e.persist()` on every
 * scroll). `isDefaultPrevented()` / `isPropagationStopped()` read the native flags. Runs
 * once per event: a bubbling event keeps the members for the next handler.
 */
export function addSyntheticEventMembers(event: unknown): void {
  if (!event || typeof event !== "object" || "nativeEvent" in event) return;
  try {
    const e = event as Record<string, unknown>;
    for (const k in SYNTHETIC_MEMBERS) if (!(k in e)) e[k] = SYNTHETIC_MEMBERS[k];
    e.nativeEvent = event;
  } catch { /* non-extensible event (rare) — leave as-is */ }
}
