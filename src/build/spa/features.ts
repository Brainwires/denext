// `features` (denext/feature) on the SPA's denext-native path, which bundles with plain
// `deno bundle` (no esbuild `define`, no onLoad plugins): the configured flags are seeded as
// `globalThis.__DENEXT_FEATURES__` at the top of the entry (so any `feature()` call reads its
// configured value), and every app module that calls `feature("KEY")` is folded to the boolean
// literal and substituted through the bundle's import map (so the untaken branch is removed).
// The compat (esbuild) path does both in spa-compiler-plugin.ts.

import { join, relative, SEPARATOR } from "@std/path";
import { compileFeatureModules } from "../feature-transform.ts";

/** Folders under the project that are never app source. */
const SKIP_DIRS = new Set(["node_modules", "out", "ios", "android", "dist", "build"]);
/** App source extensions. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Every app source file under `dir` that mentions `feature` (the fold's own pre-filter). */
async function featureSources(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      out.push(...await featureSources(root, path));
    } else if (entry.isFile && SOURCE.test(entry.name)) {
      if ((await Deno.readTextFile(path)).includes("feature")) out.push(path);
    }
  }
  return out;
}

/** What the SPA's native bundle needs for `features`. */
export interface SpaFeatureFold {
  /** Prepended to the entry: seeds the configured flags. Empty without flags. */
  readonly seed: string;
  /** `original module URL → folded module URL`, merged into the bundle's import map. */
  readonly importMap: Record<string, string>;
  /** Removes the folded modules (after bundling). */
  cleanup(): Promise<void>;
}

/**
 * Seed and fold the configured `features` for a SPA bundled with `deno bundle`.
 *
 * @param projectDir The app's root.
 * @param features The configured flags.
 * @param fold Fold the calls too (a production bundle); dev only seeds.
 * @returns The entry seed, the import-map redirects, and the cleanup.
 */
export async function spaFeatureFold(
  projectDir: string,
  features: Record<string, boolean>,
  fold = true,
): Promise<SpaFeatureFold> {
  if (Object.keys(features).length === 0) {
    return { seed: "", importMap: {}, cleanup: () => Promise.resolve() };
  }
  const seed = `globalThis.__DENEXT_FEATURES__ = ${JSON.stringify(features)};\n`;
  if (!fold) return { seed, importMap: {}, cleanup: () => Promise.resolve() };
  const files = (await featureSources(projectDir)).filter((f) =>
    !relative(projectDir, f).split(SEPARATOR).some((part) => part.startsWith("."))
  );
  const outDir = await Deno.makeTempDir({ prefix: "denext_spa_features_" });
  const importMap = await compileFeatureModules(files, {}, { outDir, features });
  return {
    seed,
    importMap,
    cleanup: () => Deno.remove(outDir, { recursive: true }).catch(() => {}),
  };
}
