// Gate for the next-compat pipeline: does this project use npm React libraries
// (so its route trees must be react→denext-rewritten at SSR to avoid dual React)?
//
// Project-level detection. A pure denext-native app (no npm React) keeps the
// zero-overhead source-load path. `config.compatibilityMode` forces it on/off.

import { join } from "@std/path";
import type { ProjectPaths } from "./paths.ts";
import { reactNativeOptions } from "../server/config.ts";

/**
 * True when the build/serve should use the next-compat (react→denext-rewritten)
 * SSR + client path. Order: `reactNative` on the App Router (always compat), then an
 * explicit `config.compatibilityMode` override, else "auto" —
 * `node_modules/react` present OR `package.json` lists `react`/`next`.
 */
export async function detectNextCompat(paths: ProjectPaths): Promise<boolean> {
  // React Native mode needs the esbuild path (its resolvers live there). On the App Router it
  // implies compat; the config refuses it beside `compatibilityMode: false` there. (An SPA
  // decides this itself: its React Native bundle is always the compat one.)
  if (paths.config?.mode !== "spa" && reactNativeOptions(paths.config) !== null) return true;
  const override = paths.config?.compatibilityMode;
  if (override === true) return true;
  if (override === false) return false;

  try {
    if ((await Deno.stat(join(paths.projectDir, "node_modules", "react"))).isDirectory) {
      return true;
    }
  } catch {
    // no node_modules/react
  }
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(paths.projectDir, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.react || deps.next) return true;
  } catch {
    // no/invalid package.json
  }
  return false;
}
