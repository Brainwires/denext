/**
 * `@denext/denext/build/css` — the CSS build pipeline, exposed for **plugins** that
 * bundle their own client entries and need `.css` / CSS-Modules imports to work.
 *
 * denext compiles CSS with lightningcss and, instead of feeding raw CSS to the
 * JS bundler, redirects every `.css` import to a generated JS **shim** (a global
 * `.css` shim exports `{}`; a `*.module.css` shim exports its local→scoped class
 * map). The redirects live in {@linkcode AppCss.importMap}, which a plugin passes
 * as `BundleOptions.importMap` to {@link https://jsr.io/@denext/denext/doc/bundle | `bundleRoutes`}
 * so `deno bundle` never parses CSS as JavaScript. The real CSS is kept separately
 * and delivered per route via a `<link rel="stylesheet">`.
 *
 * This is a deliberately **narrow** re-export: whole-project asset generation
 * ({@linkcode buildAppCss}) and per-route extraction ({@linkcode extractRouteCss}).
 * The reference consumer is `@denext/pages-router`.
 *
 * > Note: for a project whose config anchors resolution (it has `npm:` imports or
 * > `nodeModulesDir` — typically a converted Next.js app), {@linkcode buildAppCss}
 * > writes the css→shim redirects into the project's `deno.json` so the runtime
 * > module loader can resolve `.css` imports. The write is idempotent (identical
 * > content each run), and it matches what the App Router build already does.
 *
 * @example Make CSS-aware client bundles for a plugin
 * ```ts
 * import { buildAppCss, extractRouteCss } from "@denext/denext/build/css";
 * import { bundleRoutes } from "@denext/denext/bundle";
 *
 * const css = await buildAppCss({ projectDir, configPath, outDir, minify: true });
 * const { files, entries } = await bundleRoutes(entriesSource, {
 *   configPath,
 *   minify: true,
 *   importMap: css?.importMap, // .css → shim, so bundling succeeds
 * });
 * const routeCss = css ? await extractRouteCss([pageFile, appFile], css) : "";
 * ```
 *
 * @module
 */

export { buildAppCss, extractRouteCss } from "./css.ts";
/**
 * The result of {@linkcode buildAppCss} (and its {@linkcode CssAssets} base). Treat
 * it as an **opaque handle**: pass it back to {@linkcode extractRouteCss}, and read
 * only {@linkcode CssAssets.importMap} (css-URL → shim-URL, feed it to `bundleRoutes`'
 * `importMap`). Its other fields (path-keyed `Map`s of transformed CSS / class maps)
 * are internal representation — don't build assumptions on their shape or keys.
 */
export type { AppCss, CssAssets } from "./css.ts";
