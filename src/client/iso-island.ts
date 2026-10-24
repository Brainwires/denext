// Per-island hydration on the isomorphic (non-Flight) path, import-gated: the generated route
// entry emits `installIsoIslands()` only when the app's sources write a `client:*` directive (the
// `appUsesIsoIslands` build scan), so an app without one ships none of it. On a Flight route an
// island is its own root (lazy-hydrate.ts); here the page is ONE client tree, so an island stays
// in it: the component element with the directive renders
// a wrapper that adopts its server DOM untouched while the page hydrates (a foreign host), and
// when the strategy fires the wrapper's children hydrate against that DOM in the same tree, so
// context, events and errors flow through the page as they would without the directive.
//
//   client:load        hydrate right after the page
//   client:idle        when the main thread is idle
//   client:visible     when the island nears the viewport
//   client:media="q"   when the media query matches
//   client:interaction on the first pointerdown / click / keydown / focusin / touchstart inside it
//   client:only        no server render (an empty wrapper); mounts after the page hydrates
//
// The server renders the same shape (`IsoIslandServer`, src/jsx/iso-island-server.ts): one component level
// around a `<div data-dnx-island style="display:contents">` holding the component, so `useId`
// matches on both sides. A component that first mounts on the client (no server DOM to keep)
// renders at once inside the same wrapper.
//
// Split islands: the production build rewrites a directive element whose component is imported
// only for directive elements (src/build/iso-islands.ts) to an `isoIslandChunk(loader)` stand-in,
// so the component's module leaves the page bundle for a chunk of its own. The stand-in renders
// as the island wrapper like any island; when the strategy fires its chunk is imported first,
// then its children hydrate as above. The server rendered a class or `lazy()` component eagerly
// (no wrapper): the stand-in then renders it itself, suspending the hydration until its chunk
// lands, as an id-transparent level (the component takes the stand-in's `useId` slot).
//
// Events before hydration (React's selective hydration): a capture listener above the document
// sees a user event on a kept island's server DOM first. The island hydrates synchronously then,
// whatever its strategy (and so does an island nested in it), so the event runs through the page
// once, `on*Capture` handlers included. A split island whose chunk is still loading holds the
// event (stopped before any other listener sees it) with every later one on it, and replays them
// in order once it has hydrated.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import {
  FOREIGN_PROP,
  ISLAND_MARKER_ATTR,
  isoIslandProps,
  parseStrategy,
} from "../runtime/lazy-directive.ts";
import {
  dropDetachedLazyIslands,
  type HydrationStrategy,
  INTERACTION_EVENTS,
  registerLazyIsland,
} from "./lazy-hydrate.ts";
import { flushSync } from "./fiber/root.ts";
import { currentFiber } from "./fiber/hooks-dispatcher.ts";
import type { Fiber } from "./fiber/fiber.ts";
import {
  cursorNode,
  hydrateChildrenOf,
  isHydrating,
  setIslandHydration,
} from "./fiber/hydration.ts";
import { setIslandRender } from "./fiber/render-component.ts";
import { islandType } from "../jsx/iso-island-server.ts";

/** A split island's code: its chunk's loader and, once imported, the component (or the error). */
interface Chunk {
  readonly load: () => Promise<unknown>;
  promise?: Promise<unknown>;
  C?: unknown;
  error?: unknown;
}

/** The chunk behind each `isoIslandChunk` stand-in. */
const chunks = /* @__PURE__ */ new WeakMap<object, Chunk>();

/** Import a chunk once; settles with the component recorded (or the error). */
function loadChunk(chunk: Chunk): Promise<unknown> {
  return chunk.promise ??= chunk.load().then(
    (C) => (chunk.C = C),
    (error) => {
      chunk.error = error;
      throw error;
    },
  );
}

/**
 * The stand-in the build writes for a split island's component (`<Chart client:visible />` with
 * `Chart` in its own chunk): it renders as the island wrapper, importing the chunk when the
 * strategy fires. Rendered on its own (the server rendered the component eagerly: a class or a
 * `lazy()` one) it suspends until the chunk lands, then renders the component.
 *
 * @param load Imports the component (`() => import("./chart.tsx").then((m) => m.default)`).
 * @returns A component standing in for the imported one.
 */
export function isoIslandChunk(
  load: () => Promise<unknown>,
): (props: Record<string, unknown>) => VNode {
  const chunk: Chunk = { load };
  const Island = (props: Record<string, unknown>): VNode => {
    const f = currentFiber!;
    idTransparent(f);
    if (chunk.error !== undefined) throw chunk.error;
    if (chunk.C === undefined) {
      const p = loadChunk(chunk);
      if (isHydrating) {
        const r = () => rewind(f);
        p.then(r, r);
      }
      throw p;
    }
    return h(chunk.C as never, props);
  };
  chunks.set(Island, chunk);
  return Island;
}

/**
 * Make a stand-in rendered on its own an id-transparent level: it gives back the slot it took in
 * its parent's id scope and lends that scope to its child, so the component it renders takes the
 * slot the server's eager render gave it and `useId` below it matches (the server rendered no
 * stand-in). Runs at the top of each render; only the first changes anything.
 */
function idTransparent(f: Fiber): void {
  const s = f.idScope!;
  if (s === f.idParentScope || !s.parent) return;
  s.parent.count = s.slot;
  f.idScope = s.parent;
}

/**
 * A hydration that suspended on a stand-in renders again, every component below its Suspense
 * boundary (or the root) new, as none committed: rewind that scope's slot count before the retry
 * (this runs ahead of it, registered on the chunk first), so the retry's components take the
 * slots the server gave them, not the ones after the discarded attempt's.
 */
function rewind(f: Fiber): void {
  for (let p = f.return; p; p = p.return) {
    if (p.tag === "suspense" || p.tag === "root") {
      (p.tag === "root" ? p.idParentScope : p.idScope)!.count = 0;
      return;
    }
  }
}

const noop = (): void => {};

/** Whether the server node about to be claimed is an island wrapper (the server deferred it). */
function serverWrapped(): boolean {
  const node = cursorNode() as Element | null;
  return node?.nodeType === 1 && node.hasAttribute(ISLAND_MARKER_ATTR);
}

/** Whether an element's props carry a `client:*` directive (one naming a strategy). */
function hasDirective(props: Record<string, unknown>): boolean {
  for (const k in props) {
    if (k.startsWith("client:")) return parseStrategy(props).strategy !== null;
  }
  return false;
}

/** The island's state: kept (its server DOM untouched), hydrating now, or live. */
const KEPT = 0, HYDRATE = 1, LIVE = 2;

/**
 * The wrapper's foreign mark per state. KEPT: adopt the wrapper, leave its children (the server
 * DOM) alone. HYDRATE: its children hydrate against that DOM in this render (see
 * `hydrateChildrenOf`). LIVE: an ordinary element.
 */
const FOREIGN = [true, "hydrate", undefined] as const;

/**
 * The wrapper's render, in place of the component's own (the fiber keeps the component's type, so
 * a re-render never remounts it): the directive is read, the component renders as its child.
 */
function IsoIsland(type: unknown, props: Record<string, unknown>): VNode {
  const { strategy, param, rest } = parseStrategy(props);
  const s = strategy!;
  const chunk = chunks.get(type as object);
  // A first render while the page hydrates keeps the server DOM until the trigger; one on the
  // client alone (a navigation, a conditional mount) has nothing to keep.
  const [phase, setPhase] = useState(() => (isHydrating ? KEPT : LIVE));
  // A split island mounted on the client alone renders once its chunk lands.
  const [, setLoaded] = useState(false);
  const box = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (phase === KEPT && el) return arm(el, s, param, chunk, setPhase);
    return chunk && importNow(chunk, () => setLoaded(true));
  }, []);
  return h(
    "div",
    { ...isoIslandProps(s, param), ref: box, [FOREIGN_PROP]: FOREIGN[phase] },
    content(phase, s, chunk, type, rest),
  );
}

/** What the wrapper holds: nothing while kept (or loading), else the component. */
function content(
  phase: number,
  s: HydrationStrategy,
  chunk: Chunk | undefined,
  type: unknown,
  rest: Record<string, unknown>,
): VNode | null {
  if (phase === KEPT) {
    prefetch(s, chunk);
    return null;
  }
  if (!chunk) return h(type as never, rest);
  if (chunk.error !== undefined) throw chunk.error;
  return chunk.C === undefined ? null : h(chunk.C as never, rest);
}

/**
 * A `client:load` / `client:only` chunk is wanted as soon as the page hydrates: start its import
 * with the page's render, so the fetch overlaps the hydration (idempotent; an error surfaces when
 * the trigger awaits it).
 */
function prefetch(s: HydrationStrategy, chunk: Chunk | undefined): void {
  if (chunk && (s === "load" || s === "only")) loadChunk(chunk).catch(noop);
}

/** A split island mounted on the client alone: import its chunk now, `done` once it settles. */
function importNow(chunk: Chunk, done: () => void): (() => void) | undefined {
  if (chunk.C !== undefined) return;
  let mounted = true;
  const settle = () => void (mounted && done());
  loadChunk(chunk).then(settle, settle);
  return () => void (mounted = false);
}

/**
 * Register a kept island for its strategy; when it fires, turn it to hydrating (a split island
 * imports its chunk first, a failure rendering into the nearest error boundary). Until then an
 * event on its server DOM wakes it at once (see {@link onEarly}). Returns the cleanup.
 */
function arm(
  el: Element,
  s: HydrationStrategy,
  param: string | undefined,
  chunk: Chunk | undefined,
  setPhase: (phase: number) => void,
): () => void {
  let mounted = true;
  let registering = true;
  const go = (phase: number) => {
    waiting.delete(el);
    if (mounted) flushSync(() => setPhase(phase));
    const held = w.held;
    w.held = null;
    if (held) { for (const e of held) replay(e); }
  };
  const hydrated = () => go(s === "only" ? LIVE : HYDRATE);
  // A trigger that fires while registering (`load`, `only`, a media query already matching)
  // waits for this commit to finish; any later one (an event) hydrates at once.
  // Once: a trigger or an event, whichever comes first (the other then finds it started).
  let started = false;
  const hydrate = (): void | Promise<void> => {
    if (started) return;
    started = true;
    if (chunk && chunk.C === undefined) return loadChunk(chunk).then(hydrated, () => go(LIVE));
    return registering ? queueMicrotask(hydrated) : hydrated();
  };
  const w: Waiting = { el, wake: hydrate, held: null };
  // `client:only` has no server DOM to take events on.
  if (s !== "only") {
    waiting.set(el, w);
    listenEarly(el);
  }
  registerLazyIsland({ container: el, strategy: s, param, hydrate });
  registering = false;
  return () => {
    mounted = false;
    waiting.delete(el);
    queueMicrotask(dropDetachedLazyIslands);
  };
}

/** A kept island: its trigger, and the events held while its chunk loads (null until one is). */
interface Waiting {
  el: Element;
  wake: () => unknown;
  held: Event[] | null;
}

/** The kept islands by wrapper, until they hydrate. */
const waiting = /* @__PURE__ */ new Map<Element, Waiting>();

/**
 * The event types an island takes before it hydrates: the discrete ones a user starts (and the
 * `input` / `change` / `submit` they lead to), as React's selective hydration replays.
 */
const EARLY_EVENTS = [
  ...INTERACTION_EVENTS,
  "pointerup",
  "mousedown",
  "mouseup",
  "keyup",
  "focusout",
  "input",
  "change",
  "submit",
];

/** The nearest kept island at or above `node`. */
function waitingFor(node: unknown): Waiting | undefined {
  for (let n = node as Node | null; n; n = n.parentNode) {
    const w = waiting.get(n as Element);
    if (w) return w;
  }
}

/**
 * An event on a kept island's server DOM, seen first (a capture listener above the document):
 * the island hydrates now, whatever its strategy, so the event then runs through the page as
 * usual, capture handlers included; one it holds (a nested island) wakes next. A split island
 * whose chunk is still loading holds the event instead (and every later one on it), stopping it
 * here so no listener sees it twice; it is replayed, in order, once the island has hydrated. A
 * held `click` / `submit` has its default action cancelled: the replay performs it.
 */
function onEarly(e: Event): void {
  for (let w = waitingFor(e.target); w; w = waitingFor(e.target)) {
    if (!w.held) {
      w.wake();
      if (!waiting.has(w.el)) continue; // hydrated at once
      w.held = [];
    }
    w.held.push(e);
    e.stopPropagation();
    if (e.type === "click" || e.type === "submit") e.preventDefault();
    return;
  }
}

/** The roots already listening (the document, or the topmost node of a detached tree). */
const early = /* @__PURE__ */ new WeakSet<object>();

/** Listen for early events above the island's whole tree (the window, in a browser), once. */
function listenEarly(el: Element): void {
  let top: Node = el;
  while (top.parentNode) top = top.parentNode;
  const at = ((top as Document).defaultView ?? top) as EventTarget;
  if (early.has(at)) return;
  early.add(at);
  for (const type of EARLY_EVENTS) {
    at.addEventListener(type, onEarly as EventListener, {
      capture: true,
      passive: type !== "click" && type !== "submit",
    });
  }
}

/**
 * Dispatch a copy of a held event on its target. A held `submit` that nothing cancels on replay
 * submits the form (a synthetic `submit` event doesn't).
 */
function replay(e: Event): void {
  const t = e.target as EventTarget | null;
  if (!t || typeof t.dispatchEvent !== "function") return;
  let copy: Event;
  try {
    copy = new (e.constructor as typeof Event)(e.type, e);
  } catch {
    copy = new Event(e.type, { bubbles: true, cancelable: true });
  }
  t.dispatchEvent(copy);
  const F = (globalThis as { HTMLFormElement?: typeof HTMLFormElement }).HTMLFormElement;
  if (e.type === "submit" && !copy.defaultPrevented && F && t instanceof F) {
    F.prototype.submit.call(t);
  }
}

/** One wrapper render function per component type (stable, so the fiber's hooks stay its own). */
const wrappers = /* @__PURE__ */ new WeakMap<object, (props: Record<string, unknown>) => VNode>();

function wrapperFor(type: unknown): (props: Record<string, unknown>) => VNode {
  const key = type as object;
  let w = wrappers.get(key);
  if (!w) wrappers.set(key, w = (props) => IsoIsland(type, props));
  return w;
}

/** The fibers that render as islands (decided at mount: a fiber never switches). */
const islands = /* @__PURE__ */ new WeakSet<Fiber>();

/**
 * The wrapper render of a component fiber whose element carries a `client:*` directive, or null.
 * Decided once per fiber, at mount, so one mounted before this runtime loaded keeps its own render.
 */
function islandRender(
  fiber: Fiber,
  type: unknown,
  props: Record<string, unknown>,
): ((props: Record<string, unknown>) => VNode) | null {
  const alt = fiber.alternate;
  // Either buffer may carry the mark: a fiber the page's re-render cloned without rendering it
  // (a bailout) was never marked itself.
  if (
    alt === null ? !hasDirective(props) || !islandType(type) : !islands.has(alt) &&
      !islands.has(fiber)
  ) return null;
  if (alt === null && rendersItself(type)) return null;
  islands.add(fiber);
  return wrapperFor(type);
}

/**
 * A split island the server rendered eagerly (a class or `lazy()` component) renders itself, as
 * does one mounting on the client once its chunk is known to hold such a component (the content
 * of a Suspense boundary that suspended while hydrating), so its ids match the server's.
 */
function rendersItself(type: unknown): boolean {
  const c = chunks.get(type as object);
  return !!c && (isHydrating ? !serverWrapped() : c.C !== undefined && !islandType(c.C));
}

/** A wrapper turning from kept to hydrating: its children claim the server DOM it kept. */
function islandHydration(wip: Fiber): void {
  if (
    wip.vnode.props?.[FOREIGN_PROP] === "hydrate" &&
    wip.alternate?.vnode.props?.[FOREIGN_PROP] === true
  ) hydrateChildrenOf(wip);
}

/**
 * Install the isomorphic island runtime into the reconciler seams (the route entry emits this
 * before hydrating, when the app writes a `client:*` directive). Idempotent.
 */
export function installIsoIslands(): void {
  setIslandRender(islandRender);
  setIslandHydration(islandHydration);
}
