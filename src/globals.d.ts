// Build-time flags injected by esbuild `define` in src/build/next-compat.ts.
// Guard sites read the bare identifier directly (e.g. `if (__DENEXT_CLASS_COMPONENTS__)`)
// so esbuild's `define` folds the branch and dead-code-eliminates the class runtime
// when off. Absent when running un-bundled (deno test / deno run) — importing
// src/runtime/class-flag.ts (a side-effect module) installs a `globalThis` default
// (on) so the bare reads resolve. Any module referencing this must both
// `/// <reference path=".../globals.d.ts" />` and import class-flag for its side effect.

/** True when the class-component runtime is compiled in (see `classComponents` config). */
declare const __DENEXT_CLASS_COMPONENTS__: boolean;

/**
 * Build-seeded map of enabled feature flags — read by `denext/feature`'s runtime shim for
 * any `feature("KEY")` call the fold didn't resolve statically (unconfigured key, non-literal
 * argument, or an unreached module). Folded calls become literals and never read it. Absent
 * un-bundled until src/runtime/feature-flags.ts installs an empty default; seeded from
 * `features` by the server (resolveProject) and the esbuild compat `define`.
 */
declare const __DENEXT_FEATURES__: Record<string, boolean>;

/**
 * The build target `denext/platform`'s runtime fallback reads (`"ios"`, `"web"`, …) for a read
 * the build-time fold did not replace. Seeded by the esbuild paths' `define` (and the native SPA
 * entry); absent elsewhere, where the constant reads `"web"`.
 */
declare const __DENEXT_PLATFORM__: string | undefined;

/**
 * Build-scan gates of the native `deno bundle --define` path (src/build/bundle.ts's
 * `nativeBundleDefines`): `false` when a scan of the app's own sources found no use, so the
 * runtime they guard folds out. A guard site reads `typeof X === "undefined" || X` — no define
 * (dev, `deno test`, a stock Deno with no `--define`, the esbuild paths) keeps the runtime on.
 */
/** `next/image` blur placeholders: the boot's clearing of them in server-only trees. */
declare const __DENEXT_IMAGE_BLUR__: boolean | undefined;
/** Function-valued `<form action>` / `formAction`: the reconciler's submit seam. */
declare const __DENEXT_FORM_ACTIONS__: boolean | undefined;
/** Route-pattern hrefs (`{ pathname: "/blog/[slug]", params }`): filling the pattern from `params`. */
declare const __DENEXT_HREF_PARAMS__: boolean | undefined;
/** Preact's `useErrorBoundary`: a function component that is an error boundary (the reconciler). */
declare const __DENEXT_HOOK_BOUNDARIES__: boolean | undefined;
