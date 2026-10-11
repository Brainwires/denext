// Build-time switch for AsyncContext-scoped transitions. Default `null`: the
// reconciler keeps its time-window entanglement for async `startTransition`,
// byte-for-byte unchanged (no regression, no added cost).
//
// When `asyncContext` is enabled, the build instruments client
// modules (src/build/async-context-transform.ts) so context survives `await`, and
// redirects THIS module — via the same import-map seam the transform uses — to a
// generated module exporting a fresh `Variable` (async-context.ts). The reconciler then
// scopes transition priority by that variable's identity instead of the window. Only the
// generated module imports `Variable`, so a build without `asyncContext` carries none of it.
//
// The server always loads this original (`null`); server transitions run
// synchronously (the scheduler is null there), so it is inert on that path.

import type { Variable } from "./async-context.ts";

/**
 * The transition-identity variable the reconciler scopes async-transition priority by, or
 * `null` when AsyncContext scoping is off (this original; the `asyncContext` build swaps in
 * a module that exports a `Variable`).
 */
export const transitionScope: Variable<object | null> | null = null;
