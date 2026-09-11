// The one place the on-demand class-component runtime is loaded from. The generated browser
// entry calls `loadClassRuntime()` before hydrating when the document carries the
// `#__denext_classes` marker (the server rendered a class component); the reconciler can call
// it too when a class first appears client-side. Keeping the dynamic `import()` HERE — rather
// than in each generated entry — gives the runtime a single importer, so the bundler emits it
// as one chunk named after the module (`class-runtime-<hash>.js`) instead of hoisting it into
// an anonymous chunk shared by every route entry. A relative specifier resolves on every path
// (native `deno bundle`, the compat prebuilt runtime, the unbundled dev loop) with no import
// map involvement.

let pending: Promise<void> | undefined;

/**
 * Load and install the class-component runtime (the `denext/class-runtime` chunk) once.
 * Idempotent and coalescing: concurrent callers share one in-flight load; a failed load is
 * forgotten so the next call retries.
 *
 * @returns Resolves once `installClassSupport()` has run.
 */
export function loadClassRuntime(): Promise<void> {
  return pending ??= import("../class-runtime.ts")
    .then((m) => m.installClassSupport())
    .catch((err) => {
      pending = undefined;
      throw err;
    });
}
