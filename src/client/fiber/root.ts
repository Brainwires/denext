// Public API: createRoot / hydrateRoot / createPortal / flushSync / act, plus the dev
// Fast Refresh root retention. Wires the render entry points into the scheduler.

import { activeRoots, fiberToRoot } from "./state.ts";
import type { RootHandle } from "./state.ts";
import { walk } from "./fiber-utils.ts";
import {
  flushRoots,
  reclaimTransitions,
  runTransitionDone,
  scheduleUpdate,
  setFlushHandlers,
} from "./scheduler.ts";
import { reportCommit } from "./devtools-bridge.ts";
import { commitDeletion, flushPassiveEffects } from "./commit.ts";
import { beginConcurrentRender, renderRoot, resumeConcurrent } from "./work-loop.ts";
import { PORTAL, type VNode, type VNodeChild } from "../../jsx/types.ts";
import { rootScope } from "../../jsx/tree-id.ts";
import {
  familyMatchActive,
  familyResolveActive,
  resolveFamilyCurrent,
  setRootRefresh,
} from "../vnode-utils.ts";
import { createFiber, type Fiber, NoLane, SyncLane, TransitionLane } from "./fiber.ts";

// Wire the work loop into the scheduler (see `FlushHandlers` for why it is injected).
setFlushHandlers(renderRoot, beginConcurrentRender, resumeConcurrent);

// Dev per-module HMR: let the Fast Refresh runtime re-render every mounted root
// after an edited module re-imports (family-current substitution takes effect on
// the live tree). A plain function-pointer handoff; only invoked in dev.
setRootRefresh(refreshAllRoots);

/**
 * Render `children` into a different DOM `container` while keeping their place in
 * the component and context tree. Backs `react-dom`'s `createPortal`.
 */
export function createPortal(
  children: VNodeChild,
  container: Element,
  key?: string | null,
): VNode {
  return {
    type: PORTAL as unknown as VNode["type"],
    props: { target: container, children },
    key: key ?? null,
  };
}

/**
 * Options accepted by {@link createRoot}/{@link hydrateRoot} for React parity.
 * `identifierPrefix` is wired into the root's `useId` scope; the three error callbacks
 * observe error handling without changing denext's default behavior (a boundary still
 * catches, an uncaught error still surfaces, a hydration mismatch still keeps the
 * client render).
 */
export interface RootOptions {
  /** Invoked when an error boundary catches an error (render, effect, or event). */
  onCaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /** Invoked when an error reaches the root uncaught (it still surfaces afterward). */
  onUncaughtError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /**
   * Invoked when denext recovers from an error — currently a hydration mismatch,
   * where the client render is kept. Replaces the dev-only mismatch console warning.
   */
  onRecoverableError?: (error: unknown, errorInfo: { componentStack?: string }) => void;
  /**
   * Prefix seeded into this root's `useId` scope so ids don't collide across multiple
   * roots on one page. On hydration it must match the server render's `identifierPrefix`.
   */
  identifierPrefix?: string;
}

/** A mounted (or hydrated) render root that can be re-rendered or torn down. */
export interface Root {
  /** Render (or re-render) `vnode` into this root's container. */
  render(vnode: VNode): void;
  /** Unmount the tree and remove its DOM nodes from the container. */
  unmount(): void;
}

function makeRootFiber(container: Element, identifierPrefix = ""): Fiber {
  const fiber = createFiber("root", { type: "#root", props: {}, key: null });
  fiber.stateNode = container;
  fiber.host = fiber;
  fiber.listeners = new Map();
  // The root's children slot into a fresh root id scope seeded with `identifierPrefix`
  // (default "" — byte-identical to before). Two roots on one page with distinct
  // prefixes yield non-colliding `useId` values; on hydration the prefix must match the
  // server render's `identifierPrefix` so ids align.
  fiber.idParentScope = rootScope(identifierPrefix);
  return fiber;
}

// Dev Fast Refresh (SPA mode): the retained root per container. A foreign SPA's
// `main.tsx` calls `createRoot(el).render(app)` itself, so a refresh re-imports the
// whole entry — which would call `createRoot(el)` a SECOND time. In production that
// must make a fresh root; under Fast Refresh (the only time `familyMatchActive()` is
// true) we instead hand back the container's existing root, so the re-import's
// fresh component refs reconcile onto the live fiber tree (family-matched) and hook
// state survives — exactly what a route entry gets from `startClient`'s retained
// root. Keyed weakly so a container that leaves the DOM is collectable.
const retainedRootByContainer = new WeakMap<Element, Root>();

/**
 * Dev per-module HMR: the edited module has already re-imported and updated its
 * component family's `current` impl; this marks exactly the live fibers whose family
 * changed dirty so they re-render, and `renderComponent`'s family substitution then
 * runs the fresh code on those existing fibers with hook state intact. Installed via
 * `setRootRefresh` and invoked by the Fast Refresh runtime; never called in production.
 */
function refreshAllRoots(): void {
  if (!familyResolveActive()) return;
  // Mark exactly the fibers whose component family changed (its `current` impl now
  // differs from the ref the fiber committed with) dirty, then let the scheduler flush.
  // A plain root re-render would bail — the root element is referentially unchanged, so
  // nothing is dirty — whereas `scheduleUpdate` forces those fibers to re-render, and
  // `renderComponent`'s family-current substitution then renders the edited code on the
  // live fiber with hook state intact. Targeting only changed families keeps unaffected
  // subtrees from re-rendering (true per-module HMR, not a whole-tree refresh).
  for (const handle of activeRoots) {
    walk(handle.current, (f) => {
      if (resolveFamilyCurrent(f.vnode.type) !== f.vnode.type) scheduleUpdate(f);
    });
  }
}

/** Register a new root over `container` with the scheduler and return its handle. */
function registerRoot(
  container: Element,
  options: RootOptions | undefined,
  hydrate: boolean,
  pendingElement: VNode | null,
): RootHandle {
  const rootFiber = makeRootFiber(container, options?.identifierPrefix);
  const handle: RootHandle = {
    container,
    current: rootFiber,
    pendingElement,
    pendingLanes: NoLane,
    hydrate,
    onCaughtError: options?.onCaughtError,
    onUncaughtError: options?.onUncaughtError,
    onRecoverableError: options?.onRecoverableError,
  };
  fiberToRoot.set(rootFiber, handle);
  activeRoots.add(handle);
  return handle;
}

/** Render `vnode` into a root synchronously. */
function renderInto(handle: RootHandle, vnode: VNode): void {
  handle.pendingElement = vnode;
  renderRoot(handle, SyncLane);
}

/** Unmount a root's whole tree, then drop the root from scheduling and DevTools. */
function unmountRoot(handle: RootHandle): void {
  for (let c = handle.current.child; c !== null; c = c.sibling) commitDeletion(c);
  handle.current.child = null;
  activeRoots.delete(handle);
  reportCommit(handle);
}

/** Mount `vnode` into `container`, creating fresh DOM. */
export function createRoot(container: Element, options?: RootOptions): Root {
  // Fast Refresh: a second createRoot on a live container reconciles in place.
  if (familyMatchActive()) {
    const existing = retainedRootByContainer.get(container);
    if (existing) return existing;
  }
  const handle = registerRoot(container, options, false, null);
  const root: Root = {
    render: (vnode) => renderInto(handle, vnode),
    unmount() {
      retainedRootByContainer.delete(container);
      unmountRoot(handle);
    },
  };
  if (familyMatchActive()) retainedRootByContainer.set(container, root);
  return root;
}

/** Hydrate `vnode` against server-rendered markup already in `container`. */
export function hydrateRoot(container: Element, vnode: VNode, options?: RootOptions): Root {
  const handle = registerRoot(container, options, true, vnode);
  renderRoot(handle, SyncLane);
  return {
    render: (next) => renderInto(handle, next),
    unmount: () => unmountRoot(handle),
  };
}

/**
 * Run `fn` (if given) and then synchronously flush all pending state updates —
 * including any pending transition work — before returning. Matches React's
 * `flushSync(fn)`.
 */
export function flushSync<T>(fn?: () => T): T | undefined {
  const result = fn ? fn() : undefined;
  reclaimTransitions();
  try {
    flushRoots(SyncLane | TransitionLane);
  } finally {
    runTransitionDone();
  }
  // A transition done-callback (e.g. clearing isPending) may schedule sync work.
  flushRoots(SyncLane);
  // flushSync also drains passive effects synchronously (as React's does), and any
  // sync work they schedule, so the caller sees a fully settled tree.
  flushPassiveEffects();
  flushRoots(SyncLane);
  return result;
}

/**
 * `act(callback)` — the React test helper. Runs `callback`, flushes all pending
 * state updates and effects synchronously, and returns a thenable so both sync
 * and async usage work.
 */
export function act<T>(callback: () => T | Promise<T>): Promise<T> {
  const result = callback();
  flushSync();
  return Promise.resolve(result).then((value) => {
    flushSync();
    return value;
  });
}
