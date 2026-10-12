// The process's root async context: run work as if no request (and no other AsyncLocalStorage
// scope) were active.
//
// Why it exists: Deno leaves the async context of the code that called `import()` active after a
// module is loaded for the first time — the next task the runtime starts on its own (a
// `Deno.serve` handler for an unrelated request, the test runner's next test) inherits it. And a
// module evaluated for the first time inside a request runs its top-level code in that request's
// context, so a timer or promise it creates keeps that request for the life of the process. Either
// way a later, unrelated piece of code would see `currentContext()` return a finished request —
// and run an `authorize` check with another user's session.
//
// Work that outlives the request that happened to trigger it — a shared lazy loader (a wasm codec,
// a route module), a memoized promise, a coalescing timer, a scheduled task — therefore starts in
// the root context: `inRootContext(() => import("@denext/photon"))`. The importer's own
// continuation still resumes in its request; only the shared work and what the runtime does next
// are detached from it.
//
// The root is a snapshot taken when this module first evaluates (at server startup, before any
// request, since `request-context.ts` imports it). It is kept on `globalThis` under a global
// Symbol so a second copy of this module (a next-compat server bundle inlines the runtime) reuses
// the first copy's root instead of snapshotting whatever context it happens to evaluate in. The
// same function is published as `__denextInRootContext` for client-safe modules that must not
// import `node:async_hooks` (see src/runtime/root-context-bridge.ts).

import { AsyncLocalStorage } from "node:async_hooks";

/** Run a function in a captured async context (the shape of `AsyncLocalStorage.snapshot()`). */
type ContextRunner = <R>(fn: () => R) => R;

const ROOT_CONTEXT_KEY = Symbol.for("denext.rootAsyncContext");
type RootHolder = {
  [ROOT_CONTEXT_KEY]?: ContextRunner;
  __denextInRootContext?: ContextRunner;
};

const holder = globalThis as RootHolder;
const root: ContextRunner = holder[ROOT_CONTEXT_KEY] ??= AsyncLocalStorage.snapshot();
holder.__denextInRootContext ??= root;

/**
 * Run `fn` in the process's root async context: no request context, and no other
 * `AsyncLocalStorage` value, is visible to it or to anything it schedules. Use it for work shared
 * across requests that a request merely triggers — a lazy `import()`, a memoized load promise, a
 * coalescing timer, a scheduled task — so neither that work nor what the runtime runs after it
 * inherits the triggering request.
 *
 * @param fn The work to run; its return value (a promise included) is returned unchanged.
 * @returns What `fn` returns.
 */
export function inRootContext<T>(fn: () => T): T {
  return root(fn);
}
