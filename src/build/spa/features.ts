// `features` (denext/feature) and the build target (denext/platform) on the SPA's denext-native
// path, which bundles with plain
// `deno bundle` (no esbuild `define`, no onLoad plugins): the configured flags are seeded as
// `globalThis.__DENEXT_FEATURES__` at the top of the entry (so any `feature()` call reads its
// configured value), and every app module that calls `feature("KEY")` is folded to the boolean
// literal and substituted through the bundle's import map (so the untaken branch is removed).
// The compat (esbuild) path does both in spa-compiler-plugin.ts.

import { join, relative, SEPARATOR } from "@std/path";
import { compileFeatureModules, PLATFORM_SPECIFIER } from "../feature-transform.ts";
import type { Platform } from "../platform-extensions.ts";

/** Folders under the project that are never app source. */
const SKIP_DIRS = new Set(["node_modules", "out", "ios", "android", "dist", "build"]);
/** App source extensions. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Every app source file under `dir` (not in `node_modules`, build output or dot-folders). */
export async function appSourceFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      out.push(...await appSourceFiles(root, path));
    } else if (entry.isFile && SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Every app source file under `root` that mentions `feature` (with `features`) or imports
 * `denext/platform` (the fold's own pre-filter).
 */
async function foldSources(root: string, features: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const path of await appSourceFiles(root)) {
    const source = await Deno.readTextFile(path);
    if ((features && source.includes("feature")) || source.includes(PLATFORM_SPECIFIER)) {
      out.push(path);
    }
  }
  return out;
}

/** Modules substituted in a `deno bundle` build through its import map. */
export interface SpaModuleRedirects {
  /** `original module URL → substituted module URL`, merged into the bundle's import map. */
  readonly importMap: Record<string, string>;
  /** Removes the substituted modules (after bundling). */
  cleanup(): Promise<void>;
}

/** What the SPA's native bundle needs for `features`. */
export interface SpaFeatureFold extends SpaModuleRedirects {
  /** Prepended to the entry: seeds the configured flags. Empty without flags. */
  readonly seed: string;
}

/**
 * Seed and fold the configured `features` and the build target's `platform` for a SPA bundled
 * with `deno bundle`.
 *
 * @param projectDir The app's root.
 * @param features The configured flags.
 * @param fold Fold the calls too (a production bundle); dev only seeds.
 * @param platform The build target `platform` (denext/platform) folds to.
 * @returns The entry seed, the import-map redirects, and the cleanup.
 */
export async function spaFeatureFold(
  projectDir: string,
  features: Record<string, boolean>,
  fold = true,
  platform: Platform = "web",
): Promise<SpaFeatureFold> {
  const flags = Object.keys(features).length > 0;
  const seed = (flags ? `globalThis.__DENEXT_FEATURES__ = ${JSON.stringify(features)};\n` : "") +
    (platform === "web" ? "" : `globalThis.__DENEXT_PLATFORM__ = ${JSON.stringify(platform)};\n`);
  if (!fold) return { seed, importMap: {}, cleanup: () => Promise.resolve() };
  const files = (await foldSources(projectDir, flags)).filter((f) =>
    !relative(projectDir, f).split(SEPARATOR).some((part) => part.startsWith("."))
  );
  if (files.length === 0) return { seed, importMap: {}, cleanup: () => Promise.resolve() };
  const outDir = await Deno.makeTempDir({ prefix: "denext_spa_features_" });
  const importMap = await compileFeatureModules(files, {}, { outDir, features, platform });
  return {
    seed,
    importMap,
    cleanup: () => Deno.remove(outDir, { recursive: true }).catch(() => {}),
  };
}
