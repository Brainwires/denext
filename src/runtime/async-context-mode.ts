// Build-time switch for AsyncContext-scoped transitions. Default `false`: the
// reconciler keeps its time-window entanglement for async `startTransition`,
// byte-for-byte unchanged (no regression, no added cost).
//
// When `experimental.asyncContext` is enabled, the build instruments client
// modules (src/build/async-context-transform.ts) so context survives `await`, and
// redirects THIS module — via the same import-map seam the transform uses — to a
// generated `export const asyncContextScopingEnabled = true;`. The reconciler then
// scopes transition priority by identity instead of the window. Because it's a bare
// `const`, the unused branch tree-shakes out of whichever build wins.
//
// The server always loads this original (`false`); server transitions run
// synchronously (the scheduler is null there), so it is inert on that path.

/** Whether the reconciler scopes async-transition priority by AsyncContext identity. */
export const asyncContextScopingEnabled = false;
