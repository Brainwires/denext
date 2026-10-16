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
//   client:interaction on the first pointerdown / click / keydown / focusin / touchstart inside
//                      it: the island hydrates synchronously while the event bubbles, so the root
//                      listener that runs next dispatches that event to the island's handlers
//   client:only        no server render (an empty wrapper); mounts after the page hydrates
//
// The server renders the same shape (`IsoIslandServer`, src/jsx/iso-island-server.ts): one component level
// around a `<div data-dnx-island style="display:contents">` holding the component, so `useId`
// matches on both sides. A component that first mounts on the client (no server DOM to keep)
// renders at once inside the same wrapper.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { FOREIGN_PROP, isoIslandProps, parseStrategy } from "../runtime/lazy-directive.ts";
import {
  dispatchInteraction,
  dropDetachedLazyIslands,
  INTERACTION_EVENTS,
  registerLazyIsland,
} from "./lazy-hydrate.ts";
import { flushSync } from "./fiber/root.ts";
import type { Fiber } from "./fiber/fiber.ts";
import { hydrateChildrenOf, isHydrating, setIslandHydration } from "./fiber/hydration.ts";
import { setIslandRender } from "./fiber/render-component.ts";
import { islandType } from "../jsx/iso-island-server.ts";

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
 * The wrapper's render, in place of the component's own (the fiber keeps the component's type, so
 * a re-render never remounts it): the directive is read, the component renders as its child.
 */
function IsoIsland(type: unknown, props: Record<string, unknown>): VNode {
  const { strategy, param, rest } = parseStrategy(props);
  const s = strategy!;
  // A first render while the page hydrates keeps the server DOM until the trigger; one on the
  // client alone (a navigation, a conditional mount) has nothing to keep.
  const [phase, setPhase] = useState(() => (isHydrating ? KEPT : LIVE));
  const box = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (phase !== KEPT || !el) return;
    let mounted = true;
    let registering = true;
    const go = () => {
      if (mounted) flushSync(() => setPhase(s === "only" ? LIVE : HYDRATE));
    };
    // A trigger that fires while registering (`load`, `only`, a media query already matching)
    // waits for this commit to finish; any later one (an interaction) hydrates at once.
    const hydrate = () => (registering ? queueMicrotask(go) : go());
    const off = s === "interaction" ? listen(el) : undefined;
    registerLazyIsland({ container: el, strategy: s, param, hydrate });
    registering = false;
    return () => {
      mounted = false;
      off?.();
      queueMicrotask(dropDetachedLazyIslands);
    };
  }, []);
  return h(
    "div",
    {
      ...isoIslandProps(s, param),
      ref: box,
      // KEPT: adopt the wrapper, leave its children (the server DOM) alone. HYDRATE: its children
      // hydrate against that DOM in this render (see `hydrateChildrenOf`).
      [FOREIGN_PROP]: phase === KEPT ? true : phase === HYDRATE ? "hydrate" : undefined,
    },
    phase === KEPT ? null : h(type as never, rest),
  );
}

/**
 * Hydrate on the first interaction inside the wrapper. The listener runs while the event bubbles
 * through the wrapper, before the root's delegated listener: the island hydrates synchronously
 * here, so that event reaches the handlers it just attached.
 */
function listen(el: Element): () => void {
  const on = (e: Event): void => void dispatchInteraction(e.target as Element | null);
  for (const type of INTERACTION_EVENTS) el.addEventListener(type, on, { passive: true });
  return () => {
    for (const type of INTERACTION_EVENTS) el.removeEventListener(type, on);
  };
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
  if (alt === null ? !hasDirective(props) || !islandType(type) : !islands.has(alt)) return null;
  islands.add(fiber);
  return wrapperFor(type);
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
