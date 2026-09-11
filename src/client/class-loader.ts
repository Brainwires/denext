// The one place the on-demand class-component runtime is loaded from. The generated browser
// entry calls `loadClassRuntime()` before hydrating when the document carries the
// `#__denext_classes` marker (the server rendered a class component); the reconciler can call
// it too when a class first appears client-side. Keeping the dynamic `import()` HERE — rather
// than in each generated entry — gives the runtime a single importer, so the bundler emits it
// as one chunk named after the module (`class-runtime-<hash>.js`) instead of hoisting it into
// an anonymous chunk shared by every route entry. A relative specifier resolves on every path
// (native `deno bundle`, the compat prebuilt runtime, the unbundled dev loop) with no import
// map involvement.

let mod: Promise<typeof import("../class-runtime.ts")> | undefined;

/**
 * Load and install the class-component runtime (the `denext/class-runtime` chunk).
 * The module import is coalesced and memoized (one fetch, however many callers race); the
 * install runs on every call — it is idempotent and cheap, and it keeps the reconciler seam
 * (the truth) in sync even if it was cleared after an earlier load. A failed import is
 * forgotten so the next call retries.
 *
 * @returns Resolves once `installClassSupport()` has run.
 */
export function loadClassRuntime(): Promise<void> {
  mod ??= import("../class-runtime.ts").catch((err) => {
    mod = undefined;
    throw err;
  });
  return mod.then((m) => m.installClassSupport());
}
