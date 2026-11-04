// SPA-mode source transforms: a per-module esbuild transform chaining the auto-memo compiler
// and the feature-flag fold.
//
// The App Router runs these as build-pipeline transforms over the app's component modules
// (see `build-pipeline/transforms.ts` — auto-memo gated on `reactCompiler`, the
// feature fold on `features`). A SPA has no such pipeline — its app source is
// bundled straight through esbuild (the compat path) — so without this plugin a migrated app
// loses that transformation. This plugin closes the gap.
//
// esbuild takes the FIRST `onLoad` result for a path, so the two transforms cannot be separate
// plugins — they are chained inside one `onLoad`, applied in order (auto-memo, then fold) with
// each fed the previous output. Only a PRODUCTION SPA build is transformed (dev keeps Fast
// Refresh and a fast, untransformed rebuild). Correctness-first: each transform bails to
// identity on anything it can't prove, and any parse/transform failure leaves the module
// exactly as written — never miscompiled.

import type * as esbuild from "./esbuild/mod.ts";
import { toFileUrl } from "@std/path";
import { featureFlags, reactCompilerEnabled } from "../server/config.ts";
import type { ProjectPaths } from "./paths.ts";
import { transformModule } from "./compiler.ts";
import { type BuildConstants, foldBuildConstants } from "./feature-transform.ts";
import type { Platform } from "./platform-extensions.ts";
import { platformFoldPlugin } from "./platform-fold-plugin.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";
import { transformSpaIslands } from "./spa-islands.ts";

/** A per-module source transform: `(source, absPath) → new source | null` (null = unchanged). */
export type SourceTransform = (source: string, path: string) => Promise<string | null>;

/**
 * The auto-memo compiler as a per-module transform. `absolutize: false` — the in-place onLoad
 * keeps the module's own path as the resolve base, so its relative imports stay as-is; only the
 * memoization is applied. A module the compiler can't prove is returned unchanged (`null`).
 */
function autoMemoTransform(): SourceTransform {
  return async (source, path) => {
    const { code, changed } = await transformModule(source, toFileUrl(path).href, {
      absolutize: false,
    });
    return changed ? code : null;
  };
}

/**
 * The build-constant fold (`feature("KEY")`, and `platform` from denext/platform) as a per-module
 * transform (in place — no relocation, so no absolutize).
 */
export function constantsFoldTransform(constants: BuildConstants): SourceTransform {
  return async (source) => {
    const { code, changed } = await foldBuildConstants(source, constants);
    return changed ? code : null;
  };
}

/**
 * SPA mode's `client:*` rewrite as a per-module transform (deferred mounts, split chunks).
 * `path` (the module's own) is where a module-level `hydrate` default is looked up from.
 */
export async function spaIslandsTransform(
  source: string,
  path?: string,
): Promise<string | null> {
  const { code, changed } = await transformSpaIslands(source, { importer: path || undefined });
  return changed ? code : null;
}

/**
 * An esbuild plugin applying denext's enabled SPA source transforms (the `client:*` island
 * rewrite, the auto-memo compiler and/or the feature-flag fold) to the app's own first-party
 * component modules as they load; with `features` configured, the fold also covers the app's
 * plain `.ts`/`.mts`/`.js`/`.mjs` modules that import `denext/feature`, and with `platform`, any
 * module that imports `denext/platform` has `platform` folded to the target. Returns `undefined`
 * when none is enabled, so nothing extra runs.
 *
 * @param projectDir Absolute project root — only first-party source under it is transformed.
 * @param config The resolved denext config (gates each transform).
 * @param islands The app carries a `client:*` directive (runs the island rewrite first).
 * @param platform The build target `platform` folds to (omit to leave it alone).
 */
export function spaSourceTransformPlugin(
  projectDir: string,
  config: ProjectPaths["config"],
  islands = false,
  platform?: Platform,
): esbuild.Plugin | undefined {
  const transform = spaSourceTransform(config, islands, platform);
  const plugins: esbuild.Plugin[] = [];
  if (transform) plugins.push(firstPartyTsxPlugin("denext-spa-transforms", projectDir, transform));
  const features = featureFlags(config);
  // A hook or store in a plain `.ts`/`.mts`/`.js`/`.mjs` module calling `feature()` is folded
  // too (the App Router's client-module fold does the same). Only a module that imports
  // `denext/feature` is claimed — every other one loads through the deno-loader untouched.
  if (Object.keys(features).length > 0) {
    plugins.push(firstPartyTsxPlugin(
      "denext-spa-feature-fold",
      projectDir,
      constantsFoldTransform({ features, platform }),
      { filter: PLAIN_MODULE_FILTER, deferUnless: FEATURE_SPECIFIER },
    ));
  }
  // Whatever module the plugins above left that imports `denext/platform`.
  if (platform !== undefined) plugins.push(platformFoldPlugin(projectDir, platform));
  if (plugins.length === 0) return undefined;
  if (plugins.length === 1) return plugins[0];
  return {
    name: "denext-spa-transforms",
    setup(build) {
      for (const plugin of plugins) plugin.setup(build);
    },
  };
}

/** The plain (non-component) module sources the feature fold also claims. */
const PLAIN_MODULE_FILTER = /\.(?:m?ts|m?js)$/;

/** Every foldable `feature()` call is bound by an import of this specifier. */
const FEATURE_SPECIFIER = "denext/feature";

/**
 * The enabled SPA source transforms (auto-memo compiler, then the feature-flag fold) chained into
 * one `(source, absPath) → new source | null` transform, or `undefined` when neither is on. A
 * plugin that claims a module's `onLoad` itself (esbuild runs only the first `onLoad` that
 * answers) applies this to its own output, so the module is not left untransformed. With
 * `platform`, the fold also replaces `platform` (denext/platform) in the modules the chain
 * claims; `platform` alone does not make a chain.
 *
 * @param config The resolved denext config (gates each transform).
 * @param islands The app carries a `client:*` directive (runs the island rewrite first).
 * @param platform The build target `platform` folds to (omit to leave it alone).
 */
export function spaSourceTransform(
  config: ProjectPaths["config"],
  islands = false,
  platform?: Platform,
): SourceTransform | undefined {
  const transforms: SourceTransform[] = islands ? [spaIslandsTransform] : [];
  if (reactCompilerEnabled(config)) transforms.push(autoMemoTransform());
  const features = featureFlags(config);
  const flags = Object.keys(features).length > 0;
  if (transforms.length === 0 && !flags) return undefined;
  if (flags || platform !== undefined) {
    transforms.push(constantsFoldTransform({ features, platform }));
  }
  return async (source, path) => {
    let out = source;
    let any = false;
    for (const t of transforms) {
      const next = await t(out, path);
      if (next != null) {
        out = next;
        any = true;
      }
    }
    return any ? out : null;
  };
}
