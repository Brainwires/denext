/**
 * `@denext/denext/bundle` — the browser bundler, exposed for **plugins** that
 * generate their own client entries.
 *
 * denext bundles client JavaScript by shelling out to `deno bundle` (the Deno
 * CLI's built-in bundler — no npm toolchain), with code splitting on so a
 * runtime chunk imported by every entry is hoisted and downloaded once. The App
 * Router build uses this internally; a plugin like
 * {@link https://jsr.io/@denext/pages-router | `@denext/pages-router`} that owns
 * a distinct render path (its own `pages/` routes) must generate and bundle its
 * own hydration entries, so it needs the same primitive.
 *
 * This module is a deliberately **narrow, semver-stable** re-export: a single
 * multi-entry bundling function and its option/output types. Everything else in
 * the build pipeline (route-entry generation, single-entry helpers, Flight, CSS)
 * stays internal — a plugin generates its own entry source strings and passes them
 * here. To bundle one entry, call {@linkcode bundleRoutes} with a one-element array.
 *
 * @example Bundle several route entries in one code-split pass
 * ```ts
 * import { bundleRoutes } from "@denext/denext/bundle";
 *
 * const { entries, files } = await bundleRoutes(
 *   [{ key: "/", source: entrySourceForHome }, { key: "/about", source: entrySourceForAbout }],
 *   { configPath: "/abs/deno.json", minify: true },
 * );
 * // entries: Map "/" -> "entry_0.js"; files: every emitted .js (entries + shared chunks)
 * ```
 *
 * @module
 */

import type { DenextConfig } from "../server/config.ts";
import { type Platform, projectPlatformRedirects } from "./platform-extensions.ts";

export { bundleRoutes } from "./bundle.ts";
export type { BundleOptions, ClassRuntimeMode, MultiBundleOutput } from "./bundle.ts";
export type { ServerModuleRef, ServerModules } from "./client-imports.ts";

/**
 * The redirects that make a plugin's client bundle resolve the app's
 * [platform-specific files](https://denext.dev/docs/platform-files) (`Button.web.tsx`) as the
 * server render does: pass them to {@linkcode bundleRoutes}' `redirects` (with `projectDir`),
 * which follows them through relative imports and the app's import-map aliases alike. Empty when
 * the app has no platform files or turned them off.
 *
 * @example Hydrate the files the server rendered
 * ```ts
 * import { bundleRoutes, platformClientRedirects } from "@denext/denext/plugin-kit";
 *
 * const redirects = await platformClientRedirects("/abs/app", config);
 * await bundleRoutes(entries, { configPath, projectDir: "/abs/app", redirects });
 * ```
 *
 * @param projectDir The project root.
 * @param config The app config (`platformExtensions`, `reactNative`).
 * @param platform The target (default `web`, what `denext build` / `start` / `dev` serve).
 * @returns Module file URL → the file the target loads instead.
 */
export function platformClientRedirects(
  projectDir: string,
  config: DenextConfig | null | undefined,
  platform: Platform = "web",
): Promise<Record<string, string>> {
  return projectPlatformRedirects(projectDir, config, platform);
}
