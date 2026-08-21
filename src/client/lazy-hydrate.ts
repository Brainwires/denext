// Island-level lazy hydration — the first stage of resumability.
//
// Today a page hydrates as ONE root: `startClient` runs `hydrateRoot` over the
// whole tree, re-executing every component to attach listeners. An island tagged
// with a `client:*` directive instead registers here and stays as inert server
// DOM until its strategy fires, at which point only that island's subtree is
// hydrated. This defers (and, for `interaction`, may entirely avoid) the work.
//
//   client:load        hydrate immediately (parity with today, but per-island)
//   client:idle        hydrate when the main thread is idle
//   client:visible     hydrate when the island scrolls into view
//   client:interaction hydrate on the first interaction inside the island
//
// `interaction` uses a single delegated BUBBLE-phase document listener per event
// type (installed by `installQrlDispatch`, generalizing the router's click
// interceptor). Listening in the bubble phase means the triggering event has
// already passed the target with no live handler, so after the delegated handler
// resumes the island it REPLAYS the event to the just-attached real handler — which
// is why the triggering interaction is not lost (see `qrl-dispatch.ts`).

import type { HydrationStrategy } from "../runtime/lazy-directive.ts";
export type { HydrationStrategy };

/** A server-rendered island awaiting hydration under its strategy. */
export interface LazyIsland {
  /** The island's root container element (the server DOM to adopt in place). */
  container: Element;
  /** When to hydrate. */
  strategy: HydrationStrategy;
  /** Idempotent: performs the scoped hydrate of this island over `container`. */
  hydrate: () => void;
}

interface Registered extends LazyIsland {
  done: boolean;
  /** Strategy-specific listener/observer cleanup, run once when hydration fires. */
  teardown?: () => void;
}

const islands = new Set<Registered>();

/**
 * Deferred-hydration scheduling primitives. Injectable so tests drive `idle` and
 * `visible` deterministically instead of waiting on real idle/observer callbacks.
 */
export interface LazyScheduler {
  /** Invoke `cb` when the main thread is idle. */
  idle(cb: () => void): void;
  /** Invoke `cb` when `el` is first visible; return a disconnect function. */
  visible(el: Element, cb: () => void): () => void;
}

let scheduler: LazyScheduler = defaultScheduler();

/** Replace the scheduling primitives (tests). Pass no argument to reset to default. */
export function setLazyScheduler(s: LazyScheduler = defaultScheduler()): void {
  scheduler = s;
}

/** Drop all pending islands (tests) — real pages never unregister globally. */
export function resetLazyIslands(): void {
  for (const r of islands) r.teardown?.();
  islands.clear();
}

function runHydrate(r: Registered): void {
  if (r.done) return; // idempotent: a strategy may fire more than once
  r.done = true;
  r.teardown?.();
  islands.delete(r);
  r.hydrate();
}

/**
 * Register a server-rendered island for deferred hydration under its strategy.
 * `load` hydrates synchronously here; `idle`/`visible` schedule via the scheduler;
 * `interaction` waits for {@link dispatchInteraction}.
 */
export function registerLazyIsland(island: LazyIsland): void {
  const r: Registered = { ...island, done: false };
  islands.add(r);
  switch (r.strategy) {
    case "load":
      runHydrate(r);
      break;
    case "idle":
      scheduler.idle(() => runHydrate(r));
      break;
    case "visible":
      r.teardown = scheduler.visible(r.container, () => runHydrate(r));
      break;
    case "interaction":
      // Hydrated by the delegated dispatcher on first interaction (see below).
      break;
  }
}

/** Interaction events that trigger first-touch hydration of an `interaction` island. */
export const INTERACTION_EVENTS = [
  "pointerdown",
  "click",
  "keydown",
  "focusin",
  "touchstart",
] as const;

/** True if `target` is `container` or a descendant of it. */
function containsOrEquals(container: Element, target: Element | null): boolean {
  let n: { parentNode?: unknown } | null = target as unknown as
    | { parentNode?: unknown }
    | null;
  while (n) {
    if (n === (container as unknown)) return true;
    n = (n.parentNode ?? null) as { parentNode?: unknown } | null;
  }
  return false;
}

/**
 * Resolve an interaction on `target` to the nearest pending `interaction`-strategy
 * island (walking ancestors) and hydrate it. Returns true if an island hydrated.
 * Called by the delegated resumability dispatcher (`installQrlDispatch`).
 */
export function dispatchInteraction(target: Element | null): boolean {
  for (const r of islands) {
    if (r.strategy !== "interaction") continue;
    if (containsOrEquals(r.container, target)) {
      runHydrate(r);
      return true;
    }
  }
  return false;
}

function defaultScheduler(): LazyScheduler {
  return {
    idle(cb) {
      const g = globalThis as unknown as {
        requestIdleCallback?: (cb: () => void) => void;
      };
      if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(cb);
      else setTimeout(cb, 0);
    },
    visible(el, cb) {
      const g = globalThis as unknown as {
        IntersectionObserver?: new (
          cb: (entries: Array<{ isIntersecting: boolean }>) => void,
        ) => { observe(el: Element): void; disconnect(): void };
      };
      if (typeof g.IntersectionObserver !== "function") {
        cb(); // no observer available (SSR/old runtime): hydrate now to stay correct
        return () => {};
      }
      const obs = new g.IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            cb();
            break;
          }
        }
      });
      obs.observe(el);
      return () => obs.disconnect();
    },
  };
}
