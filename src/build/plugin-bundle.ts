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
 * This module is a deliberately **narrow, semver-stable** re-export: only the two
 * bundling entry points and their option/output types. Everything else in the
 * build pipeline (route-entry generation, Flight, CSS) stays internal — a plugin
 * generates its own entry source strings and passes them here.
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

export { bundleRoutes, bundleSource } from "./bundle.ts";
export type { BundleOptions, BundleOutput, MultiBundleOutput } from "./bundle.ts";
