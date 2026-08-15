// Partial Prerendering (PPR) support for Cache Components (Next.js 16).
//
// A PPR page renders in two conceptual passes:
//
//   1. Prerender — produce a *static shell*: everything that does NOT depend on
//      the request. A dynamic read (`cookies()`/`headers()`/`connection()`)
//      reached during this pass, *outside* a `use cache` scope, cannot be
//      resolved — there is no real request yet. It "postpones": throws a
//      {@link Postpone} signal, caught at the nearest Suspense boundary, whose
//      fallback goes into the shell and whose real subtree becomes a per-request
//      dynamic hole. `use cache` bodies are static, so their reads must NOT
//      postpone — see {@link withoutPostpone}.
//
//   2. Resume — per request, re-run the tree with the real request context (no
//      postponing) and stream only the postponed holes into the cached shell.
//
// This module owns the postpone signal and the ambient prerender scope. It has
// no dependency on the request context or the cache, so both can import it
// without a cycle.

import { AsyncLocalStorage } from "node:async_hooks";

const POSTPONE = Symbol.for("denext.postpone");

/**
 * The signal thrown by a dynamic read reached during a prerender pass (outside a
 * `use cache` scope). Caught at the nearest Suspense boundary, which becomes a
 * per-request dynamic hole in the otherwise-static shell.
 */
export class Postpone {
  readonly [POSTPONE] = true as const;
  /** The dynamic API that triggered the postpone (for diagnostics). */
  constructor(readonly api: string) {}
}

/** Is `x` a {@link Postpone} signal? */
export function isPostpone(x: unknown): x is Postpone {
  return typeof x === "object" && x !== null &&
    (x as Record<symbol, unknown>)[POSTPONE] === true;
}

/** Ambient prerender-pass state; the presence of a store means we are prerendering. */
interface PrerenderState {
  /** When true, postponing is suppressed (we are inside a `use cache` body). */
  suppressed: boolean;
}

const prerenderStorage = new AsyncLocalStorage<PrerenderState>();

/**
 * Run `fn` as a prerender pass: dynamic reads outside a `use cache` scope
 * postpone instead of resolving. Nestable and concurrency-safe (state is scoped
 * to the async subtree, not a shared flag).
 */
export function withPrerender<T>(fn: () => T): T {
  return prerenderStorage.run({ suppressed: false }, fn);
}

/** True when the caller is prerendering and postponing is not suppressed. */
export function shouldPostpone(): boolean {
  const s = prerenderStorage.getStore();
  return s !== undefined && !s.suppressed;
}

/** True when a prerender pass is active (regardless of suppression). */
export function isPrerendering(): boolean {
  return prerenderStorage.getStore() !== undefined;
}

/** Throw the {@link Postpone} signal for a named dynamic API. */
export function postponeDynamic(api: string): never {
  throw new Postpone(api);
}

/**
 * Run `fn` with postponing suppressed — used while executing a `use cache` body,
 * whose reads are static and must not postpone. A no-op outside a prerender pass.
 * Suppression is scoped to this async subtree (a nested store), so concurrent
 * cache bodies do not interfere with each other or with dynamic siblings.
 */
export function withoutPostpone<T>(fn: () => Promise<T>): Promise<T> {
  const s = prerenderStorage.getStore();
  if (!s) return fn();
  return prerenderStorage.run({ suppressed: true }, fn);
}
