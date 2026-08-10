/// <reference path="../globals.d.ts" />
/**
 * Class-component build gate — the **un-bundled** runtime default.
 *
 * Guard sites across the runtime read the bare `__DENEXT_CLASS_COMPONENTS__`
 * identifier directly (`if (__DENEXT_CLASS_COMPONENTS__) { …class runtime… }`),
 * because that is the *only* form esbuild reliably folds: its `define` replaces the
 * identifier with a literal, `if (false)` branches (and the `class-component.ts`
 * imports they alone reference) are dead-code-eliminated, and a project with
 * `classComponents` off pays **zero bytes** for the class runtime. An imported
 * `const`/`typeof` indirection defeats that folding across esbuild's code-splitting
 * chunks, so it is deliberately avoided.
 *
 * Un-bundled (dev server, `deno test`, `deno run`), no esbuild `define` runs, so the
 * bare identifier would be undefined. Importing this module for its side effect
 * installs a `globalThis` default (**on**) so those bare reads resolve — letting
 * tests and the dev server exercise class components without a bundling step. In a
 * build, `define` makes `typeof __DENEXT_CLASS_COMPONENTS__` a literal, so this whole
 * block folds away (verified: it leaves zero bytes in both the on and off bundles).
 *
 * @module
 */

if (typeof __DENEXT_CLASS_COMPONENTS__ === "undefined") {
  (globalThis as { __DENEXT_CLASS_COMPONENTS__?: boolean }).__DENEXT_CLASS_COMPONENTS__ = true;
}
