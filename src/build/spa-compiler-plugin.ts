// SPA-mode auto-memo compiler: a per-module esbuild transform.
//
// The App Router runs denext's auto-memo compiler (`compiler.ts`) over the app's
// component modules as a build-pipeline transform (see `build-pipeline/transforms.ts`,
// gated on `experimental.reactCompiler`), rewriting each component to cache its own
// output so the reconciler can bail out of unchanged subtrees. A SPA has no such
// pipeline — its app source is bundled straight through esbuild (the compat path) — so
// without this plugin a migrated app that relied on React Compiler for pervasive
// auto-memoization loses ALL of it and re-renders far more than it did on Vite.
//
// This plugin closes that gap. On the esbuild `onLoad` for each app `.tsx`/`.jsx`
// source it runs the same `transformModule` the App Router uses (with `absolutize:
// false` — an in-place onLoad keeps the module's own path as the resolve base, so its
// relative imports stay as-is). It is added only to a PRODUCTION SPA build (dev keeps
// Fast Refresh and a fast, untransformed rebuild) and only when the compiler is enabled
// (`experimental.reactCompiler`; `denext migrate` turns it on when it detects React
// Compiler in a Vite config). Correctness-first: the compiler bails to identity on
// anything it can't prove, and any parse/transform failure here leaves the module
// exactly as written — never miscompiled.

import type * as esbuild from "esbuild";
import { toFileUrl } from "@std/path";
import { transformModule } from "./compiler.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";

/**
 * An esbuild plugin that applies denext's auto-memo compiler to the app's own component
 * modules as they load. Add it to a production compat-SPA bundle when the auto-memo
 * compiler is enabled.
 *
 * @param projectDir Absolute project root — only first-party source under it is transformed.
 */
export function spaCompilerPlugin(projectDir: string): esbuild.Plugin {
  return firstPartyTsxPlugin("denext-spa-auto-memo", projectDir, async (source, path) => {
    // `absolutize: false` — the in-place onLoad keeps the module's own path as the resolve
    // base, so its relative imports stay as-is; only the memoization is applied. A module the
    // compiler can't prove is returned unchanged (`null`).
    const { code, changed } = await transformModule(source, toFileUrl(path).href, {
      absolutize: false,
    });
    return changed ? code : null;
  });
}
