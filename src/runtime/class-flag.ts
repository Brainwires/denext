/// <reference path="../globals.d.ts" />
/**
 * The single gate for class-component support. Every class code path is guarded by
 * {@link CLASS_COMPONENTS_ENABLED} so that:
 *
 * - **In a build**, esbuild's `define` replaces `__DENEXT_CLASS_COMPONENTS__` with a
 *   literal `true`/`false`; the initializer folds to that literal, esbuild inlines
 *   the const into each guard, and `if (false && …)` branches (plus their
 *   `class-component.ts` imports) are dead-code-eliminated — so a project with
 *   `classComponents` off pays **zero bytes**.
 * - **Un-bundled** (dev server, `deno test`, `deno run`), `__DENEXT_CLASS_COMPONENTS__`
 *   is not defined, so `typeof` is `"undefined"` and this defaults **on** — letting
 *   tests and dev exercise class components without a bundling step.
 *
 * @module
 */

/** Whether class-component code paths are active. See the module doc for folding. */
export const CLASS_COMPONENTS_ENABLED: boolean = typeof __DENEXT_CLASS_COMPONENTS__ !== "undefined"
  ? __DENEXT_CLASS_COMPONENTS__
  : true;
