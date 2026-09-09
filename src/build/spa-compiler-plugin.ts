// SPA-mode source transforms: a per-module esbuild transform chaining the auto-memo compiler
// and the feature-flag fold.
//
// The App Router runs these as build-pipeline transforms over the app's component modules
// (see `build-pipeline/transforms.ts` — auto-memo gated on `experimental.reactCompiler`, the
// feature fold on `experimental.features`). A SPA has no such pipeline — its app source is
// bundled straight through esbuild (the compat path) — so without this plugin a migrated app
// loses that transformation. This plugin closes the gap.
//
// esbuild takes the FIRST `onLoad` result for a path, so the two transforms cannot be separate
// plugins — they are chained inside one `onLoad`, applied in order (auto-memo, then fold) with
// each fed the previous output. Only a PRODUCTION SPA build is transformed (dev keeps Fast
// Refresh and a fast, untransformed rebuild). Correctness-first: each transform bails to
// identity on anything it can't prove, and any parse/transform failure leaves the module
// exactly as written — never miscompiled.

import type * as esbuild from "esbuild";
import { toFileUrl } from "@std/path";
import { featureFlags, reactCompilerEnabled } from "../server/config.ts";
import type { ProjectPaths } from "./paths.ts";
import { transformModule } from "./compiler.ts";
import { transformFeatures } from "./feature-transform.ts";
import { firstPartyTsxPlugin } from "./spa-onload.ts";

/** A per-module source transform: `(source, absPath) → new source | null` (null = unchanged). */
type SourceTransform = (source: string, path: string) => Promise<string | null>;

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

/** The feature-flag fold as a per-module transform (in place — no relocation, so no absolutize). */
function featureFoldTransform(features: Record<string, boolean>): SourceTransform {
  return async (source) => {
    const { code, changed } = await transformFeatures(source, features);
    return changed ? code : null;
  };
}

/**
 * An esbuild plugin applying denext's enabled SPA source transforms (auto-memo compiler and/or
 * feature-flag fold) to the app's own first-party component modules as they load. Returns
 * `undefined` when neither is enabled, so nothing extra runs.
 *
 * @param projectDir Absolute project root — only first-party source under it is transformed.
 * @param config The resolved denext config (gates each transform).
 */
export function spaSourceTransformPlugin(
  projectDir: string,
  config: ProjectPaths["config"],
): esbuild.Plugin | undefined {
  const transforms: SourceTransform[] = [];
  if (reactCompilerEnabled(config)) transforms.push(autoMemoTransform());
  const features = featureFlags(config);
  if (Object.keys(features).length > 0) transforms.push(featureFoldTransform(features));
  if (transforms.length === 0) return undefined;
  return firstPartyTsxPlugin("denext-spa-transforms", projectDir, async (source, path) => {
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
  });
}
