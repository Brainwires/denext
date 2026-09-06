/**
 * next-compat page pipeline: build a page whose components import **real npm
 * React libraries** into a server (SSR) bundle and a client (hydration) bundle,
 * both running on denext's single React (via {@link bundleNextCompat}). This is
 * the wiring that lets `denext build`/`dev` serve a Next-style app on denext.
 *
 * A next-compat page is a plain React component (default export) taking
 * `{ params, searchParams }` — exactly the denext page contract, but its subtree
 * may pull in npm Radix/shadcn/etc.
 *
 * @module
 */

import { join } from "@std/path";
import { keyedBundleRef } from "./next-compat-loader.ts";
import type * as esbuild from "esbuild";
import {
  type AssetOptions,
  bundleNextCompat,
  bundleNextCompatModules,
  type MdxBuildOptions,
  prebuildDenextRuntime,
  serverStubPlugin,
  toImportUrl,
  withEsbuild,
} from "./next-compat.ts";
import {
  frameworkFileUrl,
  frameworkRootUrl,
  generateFlightEntry,
  generateServerStub,
} from "./bundle.ts";
import type { BoundaryManifest } from "./module-graph.ts";
// Re-exported so plugins (e.g. @denext/pages-router) can route their own SSR module
// loading through the compat bundles — running npm-React page modules on denext's single
// React and fixing Deno's native CJS default-interop (e.g. `import styled from
// "@emotion/styled"`) the same way the App Router does.
export { createNextCompatServerLoader } from "./next-compat-loader.ts";
export { detectNextCompat } from "./next-compat-detect.ts";
// Re-exported for the same reason: the public `createNextCompatServerLoader` /
// `detectNextCompat` reference these types, whose defining modules aren't in the
// doc-lint entry set.
export type { NextCompatServerLoaderOptions } from "./next-compat-loader.ts";
export type { ProjectPaths } from "./paths.ts";
// Re-exported so the public `BuildNextCompatFlightOptions.boundary` field doesn't
// reference them as doc-private types (their defining module isn't in the doc-lint
// set). `BoundaryRef` rides along because `BoundaryManifest` references it.
export type { BoundaryManifest, BoundaryRef } from "./module-graph.ts";
// Re-exported for the same reason: `BuildNextCompatClientOptions.assets` is public but
// `AssetOptions` (and the `AssetLoader` it references) is defined in a module that isn't in
// the doc-lint entry set. `MdxBuildOptions` rides along — the `mdxOptions` fields are public.
export type { AssetLoader, AssetOptions, MdxBuildOptions } from "./next-compat.ts";

/** A built next-compat page: paths to its server + client bundles. */
export interface BuiltNextCompatPage {
  /** Route path (e.g. `/about`). */
  routePath: string;
  /** Absolute path to the SSR bundle (exports `render(props)`). */
  serverBundle: string;
  /** Absolute path to the client hydration bundle. */
  clientBundle: string;
}

/** A page to build: its route + the source module (default-export component). */
export interface NextCompatPageInput {
  /** Route path. */
  routePath: string;
  /** Absolute path to the page source (`.tsx`). */
  filePath: string;
  /**
   * Absolute paths to the App Router layout chain wrapping this page, outermost
   * first (e.g. `[app/layout.tsx, app/(marketing)/layout.tsx]`). Each layout is a
   * default-export component receiving `{ children, params }`.
   */
  layouts?: string[];
}

/** Options for {@link buildNextCompatPages}. */
export interface BuildNextCompatOptions {
  /** Project directory (contains `deno.json` + `node_modules`). */
  projectDir: string;
  /** Project `deno.json` used to resolve app + npm deps. */
  configPath: string;
  /** Output directory (bundles are written under `outDir/next-compat/`). */
  outDir: string;
  /** Pages to build. */
  pages: NextCompatPageInput[];
  /** Minify (production). */
  minify?: boolean;
  /** Enable the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

// ---------------------------------------------------------------------------
// Server-module re-export bundles (for the MAIN denext build/SSR pipeline)
// ---------------------------------------------------------------------------

/** Options for {@link buildNextCompatModules}. */
export interface BuildNextCompatModulesOptions {
  /** Project directory (contains `deno.json` + `node_modules`). */
  projectDir: string;
  /** Project `deno.json` used to resolve app + npm deps. */
  configPath: string;
  /** Output directory (bundles land under `outDir/server/`). */
  outDir: string;
  /** Absolute paths of the route SOURCE modules to rewrite (page/layout/…). */
  modules: string[];
  /** Minify (production). */
  minify?: boolean;
  /** Enable the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
  /**
   * Resolve every bare npm specifier from `node_modules` (denext's tolerant resolver).
   * Default-on for the compat build; forwarded to
   * {@link BundleNextCompatModulesOptions.resolveAllNodeModules}. Lets the App Router SSR
   * bundle resolve `catalog:`/`workspace:*`/incomplete-`exports` deps like the client path.
   */
  resolveAllNodeModules?: boolean;
  /** App MDX plugin config, forwarded to {@link BundleNextCompatModulesOptions.mdxOptions}. */
  mdxOptions?: MdxBuildOptions;
  /** `cacheComponents` on: apply the `"use cache"` transform inside the server bundle. */
  useCache?: boolean;
  /** CSS shim map, forwarded to {@link BundleNextCompatModulesOptions.cssImportMap}. */
  cssImportMap?: Record<string, string>;
  /**
   * Vite-style asset handling for the SERVER bundle (`import logo from "./logo.svg"`,
   * `tailwind.css?url`), see {@link AssetOptions.emitDir}: assets emit to the client dir
   * with the same URLs the client bundle mints.
   */
  assets?: AssetOptions;
}

/**
 * Build react→denext-rewritten SSR bundles for a set of route source modules,
 * each RE-EXPORTING the source module's shape (`default` + named exports:
 * `metadata`/`generateMetadata`/segment-config/…) rather than wrapping it in a
 * `render()`. The main SSR loader ({@link createNextCompatServerLoader}) returns
 * these instead of the raw source, so the whole route subtree — including npm
 * React libraries imported inside it — runs on denext's single React.
 *
 * All modules are bundled in ONE code-split pass ({@link bundleNextCompatModules})
 * so they share one denext runtime chunk → a single denext instance at runtime.
 *
 * Callers manage the esbuild lifecycle (dev keeps the service warm; a one-shot
 * build should wrap in {@link withEsbuild}). The denext runtime is prebuilt once
 * per call into `outDir/server/runtime/`.
 *
 * SSR bundles inline a prebuilt denext runtime; the hook dispatcher lives on
 * globalThis (see `src/runtime/hooks.ts`), so this bundled denext copy shares the
 * one dispatcher denext's source SSR renderer installs → hooks in the rendered
 * (npm React) components resolve correctly.
 *
 * @param options Build configuration.
 * @returns Map of absolute source path → absolute server bundle path.
 */
export async function buildNextCompatModules(
  options: BuildNextCompatModulesOptions,
): Promise<Map<string, string>> {
  const outRoot = join(options.outDir, "server");
  const runtimeDir = join(outRoot, "runtime");
  const entriesDir = join(outRoot, ".entries");
  await Deno.mkdir(entriesDir, { recursive: true });
  await prebuildDenextRuntime({
    outDir: runtimeDir,
    configPath: options.configPath,
    classComponents: options.classComponents,
  });

  // ONE entry re-exporting every module as a namespace (`export * as m<i>`): the whole
  // server side becomes a single bundle file (plus the chunks dynamic `import()`s split
  // off), and each source module maps to `<bundle>#m<i>`. Module identity is trivially
  // shared, and the server loads ONE module at startup instead of one per route/island —
  // Deno spends ~80 ms per module on a large graph, which made shadcn/ui's 2,700 islands a
  // nine-minute startup as separate entries. `export * as` carries `default` when present.
  await cleanStaleServerBundles(outRoot);
  const keys = new Map<string, string>();
  const lines: string[] = [];
  options.modules.forEach((abs, i) => {
    const key = `m${i}`;
    keys.set(abs, key);
    lines.push(`export * as ${key} from ${JSON.stringify(abs)};`);
  });
  const entryPath = join(entriesDir, "app.tsx");
  await Deno.writeTextFile(entryPath, lines.join("\n") + "\n");

  await bundleNextCompatModules({
    entryPoints: { [SERVER_BUNDLE_NAME]: entryPath },
    runtimeDir,
    outdir: outRoot,
    configPath: options.configPath,
    platform: "deno",
    minify: options.minify,
    classComponents: options.classComponents,
    absWorkingDir: options.projectDir,
    resolveAllNodeModules: options.resolveAllNodeModules,
    mdxOptions: options.mdxOptions,
    useCache: options.useCache,
    cssImportMap: options.cssImportMap,
    assets: options.assets,
  });

  const bundle = join(outRoot, `${SERVER_BUNDLE_NAME}.js`);
  const map = new Map<string, string>();
  for (const [abs, key] of keys) map.set(abs, keyedBundleRef(bundle, key));
  return map;
}

/** Base name of the single compat server bundle (`server/app.js`). */
const SERVER_BUNDLE_NAME = "app";

/**
 * Drop the previous build's server bundle + chunks (not the prebuilt `runtime/` or the
 * generated `.entries/`). Chunk names are content-hashed, so without this every build
 * left its predecessors behind — 448 MB after a dozen builds of a large app.
 */
async function cleanStaleServerBundles(outRoot: string): Promise<void> {
  try {
    for await (const e of Deno.readDir(outRoot)) {
      if (e.isFile && e.name.endsWith(".js")) await Deno.remove(join(outRoot, e.name));
    }
  } catch { /* first build */ }
}

/** A compat client entry to build: an output id + its generated entry source. */
export interface NextCompatClientEntry {
  /** Output base name (route id) → `${id}.js` in the client dir. */
  id: string;
  /** Generated hydration entry source (e.g. from `generateRouteEntry`). */
  source: string;
}

/** Options for {@link buildNextCompatClientEntries}. */
export interface BuildNextCompatClientOptions {
  /** Absolute path to the app/project root (esbuild's working dir). */
  projectDir: string;
  /** Path to the app's `deno.json`, used to resolve imports/aliases. */
  configPath: string;
  /** Output directory for the prebuilt browser runtime (e.g. `.denext/server`). */
  outDir: string;
  /** Directory the client `${id}.js` + shared chunks are written to. */
  clientDir: string;
  /** The client hydration entries to bundle. */
  entries: NextCompatClientEntry[];
  /** Minify the output bundles (production). */
  minify?: boolean;
  /** Compile the class-component runtime into the bundle. */
  classComponents?: boolean;
  /**
   * Compile-time `define` replacements (e.g. `import.meta.env.*`) merged into the
   * esbuild build — the SPA-mode analogue of a Vite `define` block.
   */
  define?: Record<string, string>;
  /**
   * Vite-style asset handling (`?url`/`?worker`/`.wasm`/…). Point `publicPath` at
   * where the client dir is served (e.g. `/_denext/client/`). See {@link AssetOptions}.
   */
  assets?: AssetOptions;
  /**
   * Package names whose version in the app `package.json` is a pnpm
   * `catalog:`/`workspace:*` reference. The esbuild deno-loader's resolver can't
   * parse those version strings, so denext front-runs it and resolves these
   * packages straight from `node_modules`. See {@link BundleNextCompatModulesOptions.catalogPackages}.
   */
  catalogPackages?: string[];
  /**
   * `experimental.nodeResolve`: resolve every bare npm specifier from `node_modules`
   * (supersedes {@link catalogPackages}). Forwarded to
   * {@link BundleNextCompatModulesOptions.resolveAllNodeModules}.
   */
  resolveAllNodeModules?: boolean;
  /** App MDX plugin config, forwarded to {@link BundleNextCompatModulesOptions.mdxOptions}. */
  mdxOptions?: MdxBuildOptions;
  /** `cacheComponents` on: apply the `"use cache"` transform inside the server bundle. */
  useCache?: boolean;
  /** CSS shim map, forwarded to {@link BundleNextCompatModulesOptions.cssImportMap}. */
  cssImportMap?: Record<string, string>;
  /**
   * Extra esbuild plugins (`esbuild.Plugin[]`), inserted BEFORE the built-ins so their
   * `onResolve`/`onLoad` win. SPA-mode dev passes the Fast Refresh instrumentation plugin
   * here; forwarded verbatim to {@link BundleNextCompatModulesOptions.extraPlugins}. Typed
   * as `unknown[]` in the public API so it does not expose esbuild's third-party types.
   */
  extraPlugins?: unknown[];
}

/**
 * Build react→denext-rewritten CLIENT hydration bundles for compat routes, in one
 * code-split pass so every route's client entry shares the one denext runtime
 * chunk (single denext instance in the browser too). Mirrors the native
 * `bundleRoutes` output shape (`${id}.js` + shared chunks in the client dir) so
 * the prod server serves and references them identically.
 *
 * @param options Build configuration (reuses a prebuilt runtime dir).
 */
export async function buildNextCompatClientEntries(
  options: BuildNextCompatClientOptions,
): Promise<void> {
  if (options.entries.length === 0) return;
  // The browser bundle can't leave denext external (no runtime import map), so
  // inline a prebuilt denext runtime shared across all client entries (splitting).
  const runtimeDir = join(options.outDir, "client-runtime");
  await prebuildDenextRuntime({
    outDir: runtimeDir,
    configPath: options.configPath,
    classComponents: options.classComponents,
  });
  const entriesDir = join(options.clientDir, ".entries");
  await Deno.mkdir(entriesDir, { recursive: true });
  const entryPoints: Record<string, string> = {};
  for (const { id, source } of options.entries) {
    const entryPath = join(entriesDir, `${id}.tsx`);
    await Deno.writeTextFile(entryPath, source);
    entryPoints[id] = entryPath;
  }
  await bundleNextCompatModules({
    entryPoints,
    runtimeDir,
    outdir: options.clientDir,
    configPath: options.configPath,
    platform: "browser",
    minify: options.minify,
    classComponents: options.classComponents,
    absWorkingDir: options.projectDir,
    define: options.define,
    assets: options.assets,
    catalogPackages: options.catalogPackages,
    resolveAllNodeModules: options.resolveAllNodeModules,
    mdxOptions: options.mdxOptions,
    cssImportMap: options.cssImportMap,
    // Public type is `unknown[]` (to not expose esbuild's types); the bundler expects
    // real esbuild plugins, which is what callers pass.
    extraPlugins: options.extraPlugins as esbuild.Plugin[] | undefined,
  });
  await Deno.remove(entriesDir, { recursive: true }).catch(() => {});
}

/** Options for {@link buildNextCompatFlightEntry}. */
export interface BuildNextCompatFlightOptions {
  /** Absolute path to the app/project root (esbuild's working dir). */
  projectDir: string;
  /** Path to the app's `deno.json`, used to resolve imports/aliases. */
  configPath: string;
  /** Output directory for the prebuilt browser runtime (e.g. `.denext/server`). */
  outDir: string;
  /** Directory the `flight.js` entry + shared chunks are written to. */
  clientDir: string;
  /** The app's boundary manifest (its `client` islands + `server` action modules). */
  boundary: BoundaryManifest;
  /** Output basename for the flight entry (default `flight.js`). */
  flightFile?: string;
  /** Vite-style asset handling (see {@link AssetOptions.emitDir}); islands import images too. */
  assets?: AssetOptions;
  /** Minify the output bundle (production). */
  minify?: boolean;
  /** Compile the class-component runtime into the bundle. */
  classComponents?: boolean;
  /** Emit Fast Refresh registration for client islands (dev only). */
  dev?: boolean;
  /**
   * Resolve every bare npm specifier from `node_modules` (denext's tolerant resolver).
   * Default-on for the compat build; forwarded to
   * {@link BundleNextCompatModulesOptions.resolveAllNodeModules} so the Flight island
   * bundle resolves the same catalog:/workspace:/incomplete-`exports` deps.
   */
  resolveAllNodeModules?: boolean;
  /** App MDX plugin config, forwarded to {@link BundleNextCompatModulesOptions.mdxOptions}. */
  mdxOptions?: MdxBuildOptions;
  /** `cacheComponents` on: apply the `"use cache"` transform inside the server bundle. */
  useCache?: boolean;
  /** CSS shim map, forwarded to {@link BundleNextCompatModulesOptions.cssImportMap}. */
  cssImportMap?: Record<string, string>;
  /**
   * Whether the app uses a Live feature (build-time `denext/live` scan). When false,
   * the generated Flight entry omits the Live WebSocket transport. Defaults to
   * `true` (safe: keep Live) when unset. See {@link generateFlightEntry}.
   */
  usesLive?: boolean;
}

/**
 * Build the app-wide compat Flight CLIENT bundle: ONLY the `"use client"` island
 * modules (react→denext rewritten), registered by their stable client id, with
 * every `"use server"` module redirected to a client action stub so server code
 * is stripped. This is the esbuild-compat twin of the native {@link bundleFlightEntry}
 * — same generated entry + registry keys, so a compat route's server-rendered
 * Flight payload (islands as references) hydrates through it on denext's single
 * React. Writes `flight.js` (+ shared chunks) into `clientDir`.
 *
 * @param options Build configuration.
 */
export async function buildNextCompatFlightEntry(
  options: BuildNextCompatFlightOptions,
): Promise<void> {
  const runtimeDir = join(options.outDir, "client-runtime");
  await prebuildDenextRuntime({
    outDir: runtimeDir,
    configPath: options.configPath,
    classComponents: options.classComponents,
  });
  const entriesDir = join(options.clientDir, ".entries");
  await Deno.mkdir(entriesDir, { recursive: true });
  const flightFile = options.flightFile ?? "flight.js";
  const flightId = flightFile.replace(/\.js$/, "");
  const entryPath = join(entriesDir, `${flightId}.tsx`);
  await Deno.writeTextFile(
    entryPath,
    generateFlightEntry(options.boundary, options.dev, false, options.usesLive ?? true),
  );
  await bundleNextCompatModules({
    entryPoints: { [flightId]: entryPath },
    runtimeDir,
    outdir: options.clientDir,
    configPath: options.configPath,
    platform: "browser",
    minify: options.minify,
    classComponents: options.classComponents,
    absWorkingDir: options.projectDir,
    resolveAllNodeModules: options.resolveAllNodeModules,
    mdxOptions: options.mdxOptions,
    cssImportMap: options.cssImportMap,
    assets: options.assets,
    // Strip `"use server"` modules (reached transitively via islands) → stubs.
    extraPlugins: [serverStubPlugin(options.boundary.server, generateServerStub)],
  });
  await Deno.remove(entriesDir, { recursive: true }).catch(() => {});
}

// ===========================================================================
// Single-page test harness (NOT the production route pipeline)
// ---------------------------------------------------------------------------
// Everything below builds and SSRs ONE next-compat page in-process on real
// esbuild + real npm React, under its own `__denext_root` / `__DENEXT_PROPS__`
// mount convention. It exists solely to back the focused library-compat e2e
// tests (`tests/e2e/next-compat-*.test.ts`, `tests/integration/next-compat-build.test.ts`):
// dnd-kit, recharts, radix, framer-motion, class components — cases that need a
// real page rendered but not routing/Flight/streaming or a project on disk.
//
// It is deliberately co-located: it reuses this module's private build helpers
// (`withEsbuild`, `prebuildDenextRuntime`, `bundleNextCompat`, `serverStubPlugin`,
// …), so moving it to a test-support file would force exporting those internals.
// The REAL App Router pipeline is `generateRouteEntry` (`bundle.ts`) driven by
// `buildNextCompatModules` / `buildNextCompatClientEntries` / `buildNextCompatFlightEntry`
// above — production code must use those, never `buildNextCompatPages`.
// ===========================================================================

/** Import lines + a `wrap(props)` expression composing the layout chain over the page. */
function composition(filePath: string, layouts: string[]): { imports: string; tree: string } {
  // Import the page + layouts by absolute path (esbuild resolves paths, not file://).
  const imports = [
    `import Page from ${JSON.stringify(filePath)};`,
    ...layouts.map((p, i) => `import Layout${i} from ${JSON.stringify(p)};`),
  ].join("\n");
  // Wrap innermost -> outermost: Layout0(Layout1(...(Page))).
  let tree = "h(Page, props)";
  for (let i = layouts.length - 1; i >= 0; i--) {
    tree = `h(Layout${i}, { children: ${tree}, params: props.params })`;
  }
  return { imports, tree };
}

/** Generate the SSR entry for a page: render its (layout-wrapped) tree to HTML. */
function serverEntry(filePath: string, layouts: string[]): string {
  const { imports, tree } = composition(filePath, layouts);
  return `${imports}
import { h } from "denext/jsx-runtime";
import { renderToString } from "denext/ssr";
export async function render(rawProps) {
  const props = rawProps ?? {};
  return await renderToString(${tree});
}
`;
}

/** Generate the client hydration entry for a page (same layout-wrapped tree). */
function clientEntry(filePath: string, mountId: string, layouts: string[]): string {
  const { imports, tree } = composition(filePath, layouts);
  return `${imports}
import { h } from "denext/jsx-runtime";
import { hydrateRoot } from "denext/client";
const el = document.getElementById(${JSON.stringify(mountId)});
const props = (globalThis.__DENEXT_PROPS__ ?? {});
if (el) hydrateRoot(el, ${tree});
`;
}

/** The DOM id the SSR HTML is mounted under (and the client hydrates). */
export const MOUNT_ID = "__denext_root";

/**
 * Build each page into a server + client bundle on denext's single React.
 * Prebuilds the denext runtime once and reuses it across pages; always releases
 * the esbuild service (even on error).
 *
 * @param options Build configuration.
 * @returns The built pages.
 */
export function buildNextCompatPages(
  options: BuildNextCompatOptions,
): Promise<BuiltNextCompatPage[]> {
  return withEsbuild(async () => {
    const outRoot = join(options.outDir, "next-compat");
    await Deno.mkdir(outRoot, { recursive: true });
    const runtimeDir = await prebuildDenextRuntime({
      outDir: join(outRoot, ".runtime"),
      frameworkRoot: frameworkRootUrl(),
      configPath: frameworkFileUrl("deno.json"),
      classComponents: options.classComponents,
    });
    const tmp = join(outRoot, ".entries");
    await Deno.mkdir(tmp, { recursive: true });

    const built: BuiltNextCompatPage[] = [];
    for (const page of options.pages) {
      const id = routeToId(page.routePath);
      const serverEntryPath = join(tmp, `${id}.server.tsx`);
      const clientEntryPath = join(tmp, `${id}.client.tsx`);
      const layouts = page.layouts ?? [];
      await Deno.writeTextFile(serverEntryPath, serverEntry(page.filePath, layouts));
      await Deno.writeTextFile(clientEntryPath, clientEntry(page.filePath, MOUNT_ID, layouts));

      const serverBundle = join(outRoot, `${id}.server.js`);
      const clientBundle = join(outRoot, `${id}.client.js`);
      await bundleNextCompat({
        entry: serverEntryPath,
        runtimeDir,
        outfile: serverBundle,
        configPath: options.configPath,
        platform: "deno",
        denoLoader: false,
        absWorkingDir: options.projectDir,
        minify: options.minify,
        classComponents: options.classComponents,
      });
      await bundleNextCompat({
        entry: clientEntryPath,
        runtimeDir,
        outfile: clientBundle,
        configPath: options.configPath,
        platform: "browser",
        denoLoader: false,
        absWorkingDir: options.projectDir,
        minify: options.minify,
        classComponents: options.classComponents,
      });
      built.push({ routePath: page.routePath, serverBundle, clientBundle });
    }
    return built;
  });
}

/** Turn a route path into a filesystem-safe bundle id (`/` → `index`). */
export function routeToId(routePath: string): string {
  const clean = routePath.replace(/^\/|\/$/g, "").replace(/[^\w-]/g, "_");
  return clean === "" ? "index" : clean;
}

/** The render function a server bundle exports. */
type PageRenderFn = (props?: unknown) => Promise<string>;

/**
 * SSR a built next-compat page to a full HTML document: server-render the body,
 * embed the props, and reference the client hydration bundle.
 *
 * @param page The built page.
 * @param props Props passed to the page (params/searchParams).
 * @param clientSrc URL path the client bundle is served at.
 * @returns The HTML document.
 */
export async function renderNextCompatPage(
  page: BuiltNextCompatPage,
  props: Record<string, unknown>,
  clientSrc: string,
): Promise<string> {
  const mod = await import(toImportUrl(page.serverBundle)) as { render: PageRenderFn };
  const body = await mod.render(props);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div id="${MOUNT_ID}">${body}</div>` +
    // Escape `<` to `<` so a `</script>` (or `<!--`) inside a prop value —
    // props carry URL-derived params/searchParams — cannot break out of this inline
    // script tag (reflected XSS). Same guard the document shell uses for inline JSON.
    `<script>globalThis.__DENEXT_PROPS__=${
      JSON.stringify(props).replace(/</g, "\\u003c")
    }</script>` +
    `<script type="module" src="${clientSrc}"></script>` +
    `</body></html>`;
}
