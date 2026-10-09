// SPA mode: bundle the single entry (native `deno bundle`, or the next-compat esbuild
// react→denext rewrite) and extract its stylesheet. Shared by build, export and dev.

import {
  type Platform,
  platformResolution,
  projectPlatformRedirects,
} from "../platform-extensions.ts";
import { join, resolve, toFileUrl } from "@std/path";
import type * as esbuild from "esbuild";
import {
  domListsEnabled,
  featureFlags,
  momentumSafeScrollEnabled,
  nodeResolveEnabled,
  reactNativeOptions,
  type SpaConfig,
} from "../../server/config.ts";
import {
  appRendersDocumentTags,
  appUsesActivity,
  appUsesViewTransition,
  bundleSourceFiles,
  momentumScrollSeedImport,
  writeBundleOutput,
} from "../bundle.ts";
import { type AppCss, buildAppCss, extractRouteCss } from "../css.ts";
import type { GraphImportMap } from "../module-graph.ts";
import { stylesheetImportMap } from "../platform-imports.ts";
import { buildNextCompatClientEntries } from "../next-compat-build.ts";
import { detectNextCompat } from "../next-compat-detect.ts";
import { expoRouterRoot, expoRouterRouteFiles } from "../expo-router.ts";
import { stopNextCompat } from "../next-compat.ts";
import type { ProjectPaths } from "../paths.ts";
import {
  spaIslandsTransform,
  spaSourceTransform,
  spaSourceTransformPlugin,
} from "../spa-compiler-plugin.ts";
import { spaIslandRedirects, spaIslandSources } from "../spa-islands.ts";
import { tanstackCodeSplitPlugin } from "../tanstack-code-split.ts";
import { spaFeatureFold } from "./features.ts";
import { spaNativeRefresh } from "../refresh-modules.ts";
import { spaRefreshPlugin } from "../spa-refresh-plugin.ts";
import {
  autoOptimizePackageImports,
  optimizePackageImportsList,
} from "../optimize-package-imports.ts";
import { reactNativeBundleOptions } from "../react-native.ts";
import { tailwindPaths } from "../tailwind.ts";
import {
  CLIENT_PREFIX,
  ENTRY_FILE,
  generateSpaEntry,
  spaClientPrefix,
  STYLE_FILE,
} from "./shared.ts";
import { CHUNK_ERROR_SEED, wrapDynamicImports } from "./chunk-error.ts";
import { hasPluginBuildSteps } from "../../plugin/mod.ts";

type DependencyGroups = Partial<
  Record<
    "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies",
    Record<string, string>
  >
>;

/**
 * Package names whose version in the project's `package.json` is a pnpm
 * `catalog:` / `workspace:*` reference. The esbuild deno-loader's resolver can't
 * parse those version strings (the real version lives in `pnpm-workspace.yaml`),
 * so denext front-runs the loader and resolves these packages straight from
 * `node_modules`. Empty for a non-pnpm-catalog app (or no/invalid `package.json`).
 */
export async function pnpmCatalogPackages(projectDir: string): Promise<string[]> {
  let pkg: DependencyGroups;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(projectDir, "package.json")));
  } catch {
    return []; // no/invalid package.json → not a pnpm-catalog app
  }
  const groups = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ];
  const names: string[] = [];
  for (const group of groups) {
    for (const [name, v] of Object.entries(group ?? {})) {
      if (typeof v === "string" && (v.startsWith("catalog:") || v.startsWith("workspace:"))) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The esbuild `define` map for a SPA's compile-time `import.meta.env` values
 * (`spa.env`) — the Vite-`define` analogue. Only meaningful on the next-compat
 * (esbuild) path.
 */
export function spaDefines(spa: SpaConfig, dev: boolean): Record<string, string> {
  // Vite's built-in `import.meta.env` values, with correct types (DEV/PROD/SSR are
  // booleans, not strings) so `if (import.meta.env.DEV)` etc. behave as in Vite.
  const out: Record<string, string> = {
    "import.meta.env.MODE": JSON.stringify(dev ? "development" : "production"),
    "import.meta.env.DEV": String(dev),
    "import.meta.env.PROD": String(!dev),
    "import.meta.env.SSR": "false",
    "import.meta.env.BASE_URL": JSON.stringify("/"),
  };
  // App-provided values (`spa.env`) — strings — override / extend the built-ins.
  for (const [key, value] of Object.entries(spa.env ?? {})) {
    out[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  return out;
}

/**
 * Where the app's stylesheet imports are crawled from: the SPA entry, plus, in React Native
 * mode, every expo-router route file. The crawl (`deno info`) does not see the routes: they are
 * imported only by the route context generated at build time (`expo-router/_ctx`). Without them
 * a route's `import "./global.css"` was left out of `index.css`.
 *
 * The crawl reaches the target's platform files through its redirects ({@linkcode spaCssGraph}).
 * With platform files turned off (`platformExtensions: false`) React Native mode still bundles
 * `.web.*` files, so then every `.web.*` file of the app's own source is a root as well (`./icon`
 * is `icon.tsx` to the crawl while the bundle picks `icon.web.tsx`).
 *
 * @param paths The project.
 * @param entryPath The SPA entry.
 * @param platform The build target.
 */
export async function spaCssRoots(
  paths: ProjectPaths,
  entryPath: string,
  platform: Platform = "web",
): Promise<string[]> {
  if (reactNativeOptions(paths.config) === null) return [entryPath];
  const redirected = platformResolution(paths.config, platform) !== null;
  // A Set: the entry is itself a `.web.*` file when migrate wrote it (index.web.ts).
  return [
    ...new Set([
      entryPath,
      ...await expoRouterRouteFiles(paths.projectDir),
      ...(redirected ? [] : await webPlatformFiles(paths.projectDir)),
    ]),
  ];
}

/**
 * The import map `platform`'s stylesheet crawl resolves through: its platform files (see
 * ../platform-imports.ts `stylesheetImportMap`), so a stylesheet only `look.ios.ts` imports is
 * the iOS build's, as its JS is.
 *
 * @param paths The project.
 * @param platform The build target.
 * @param tag Distinguishes the alias-copy dir of concurrent crawls (a dev session's generation).
 */
export function spaCssGraph(
  paths: ProjectPaths,
  platform: Platform,
  tag = "build",
): Promise<GraphImportMap> {
  const copyDir = join(paths.outDir, "platform-imports", `css-${tag}-${platform}`);
  return stylesheetImportMap(paths.projectDir, paths.config, platform, copyDir);
}

/** Whether the app is a React Native mode app routed by expo-router (it has `app/`). */
export async function usesExpoRouter(paths: ProjectPaths): Promise<boolean> {
  return reactNativeOptions(paths.config) !== null &&
    await expoRouterRoot(paths.projectDir) !== null;
}

/** Directories of an app that hold no source of its own. */
const NOT_SOURCE = new Set(["node_modules", "out", "dist", "ios", "android"]);

/** The app's own `.web.{ts,tsx,js,jsx}` files under `dir` (sorted). */
async function webPlatformFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory && !NOT_SOURCE.has(entry.name)) {
      found.push(...await webPlatformFiles(path));
    } else if (entry.isFile && /\.web\.[jt]sx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

/**
 * The app's CSS assets, crawled from `roots` (the SPA entry: the whole app's import root) through
 * the target's `graph`.
 */
function spaCss(
  paths: ProjectPaths,
  roots: string[],
  minify: boolean,
  graph: GraphImportMap,
): Promise<AppCss | null> {
  return buildAppCss({
    projectDir: paths.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    // Crawling the entry finds `.scss`/`.css` in sibling workspace packages a monorepo
    // app pulls in (e.g. excalidraw's `../packages/*`), which the `projectDir` walk
    // alone can't reach.
    entryFiles: roots,
    tailwind: tailwindPaths(paths.projectDir, paths.config?.tailwind),
    graph,
  });
}

/**
 * next-compat path: when the app uses npm React (node_modules/react present, or
 * `compatibilityMode` forced), bundle through the esbuild react→denext rewrite so the
 * npm libraries' own `import "react"` also resolve to denext's single React — the "two
 * Reacts" fix a plain `deno bundle` can't do. This is also where the `import.meta.env`
 * (`spa.env`) define applies. Emits `index.js` + shared chunks.
 */
async function bundleCompatSpa(
  paths: ProjectPaths,
  entrySource: string,
  clientDir: string,
  css: AppCss | null,
  minify: boolean,
  dev: boolean,
  platform: Platform,
  modules?: string[],
): Promise<void> {
  const config = paths.config!;
  const spa = config.spa!;
  // React Native mode: react-native → react-native-web, `.web.*` first, JSX in `.js`, RN globals.
  const rn = reactNativeBundleOptions(config, paths.projectDir, dev);
  await buildNextCompatClientEntries({
    projectDir: paths.projectDir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    clientDir,
    entries: [{ id: "index", source: entrySource }],
    minify,
    classComponents: config.classComponents ?? true,
    // Vite `import.meta.env` values, plus the feature-flag map seeding the `denext/feature`
    // shim for any `feature()` call the onLoad fold leaves (non-literal arg, unset key).
    define: {
      ...spaDefines(spa, dev),
      ...rn?.define,
      __DENEXT_FEATURES__: JSON.stringify(featureFlags(paths.config)),
    },
    // Vite-style asset imports (?url/?worker/.wasm/…) → files under clientDir, URLs
    // prefixed with the path the SPA servers already serve them at. With `spa.assetsDir` (Vite's
    // `build.assetsDir`) they sit beside the chunks as `name-HASH.ext`, as Vite places them.
    assets: spa.assetsDir === undefined
      ? { publicPath: CLIENT_PREFIX }
      : { publicPath: spaClientPrefix(spa), assetNames: "[name]-[hash]" },
    // pnpm catalog:/workspace: deps the esbuild deno-loader can't resolve — denext
    // resolves these straight from node_modules (front-runs the loader).
    catalogPackages: await pnpmCatalogPackages(paths.projectDir),
    // Resolve ALL app npm deps from node_modules (supersedes the narrow catalog set) —
    // the seamless-migration path. Default-on; `nodeResolve: false` opts out.
    resolveAllNodeModules: nodeResolveEnabled(paths.config),
    // App-configured MDX plugins (denext.config `mdx`) for `.mdx`/`.md` sources.
    mdxOptions: config.mdx,
    // Barrel imports of `optimizePackageImports` packages → their defining modules (lucide's
    // barrel + `dynamicIconImports` otherwise put every icon chunk on the startup path).
    optimizePackageImports: optimizePackageImportsList(config),
    autoOptimizePackageImports: autoOptimizePackageImports(config),
    // `lists: "denext"`: `@legendapp/list/react` on denext's VirtualList (dom-lists.ts).
    domLists: domListsEnabled(config),
    // Redirect stylesheet imports to their shims — covers `.scss` in sibling workspace
    // packages the esbuild default resolver would otherwise choke on.
    cssImportMap: css?.importMap,
    extraPlugins: withPluginsFirst(
      leadingPlugins(rn?.plugins, modules, paths.projectDir),
      spaBundlePlugins(paths.projectDir, dev, paths.config, await usesSpaIslands(paths)),
    ),
    platformExtensions: rn?.platformExtensions,
    // The target's platform files (`BigButton.ios.tsx`) for the app's own modules.
    appPlatform: platformResolution(config, platform),
    jsxInJs: rn?.jsxInJs,
  });
  // Tear the esbuild service down only for a one-shot build/export. In dev this runs on
  // every rebuild, so stopping it would force a cold re-init each keystroke (and could
  // kill the process-shared service mid-flight); the dev server stops it once on shutdown.
  if (!dev) await stopNextCompat();
}

/**
 * Record every module the bundle contains into `sink` (absolute paths; a module from a virtual
 * namespace keeps its `namespace:path` id) — what a plugin build step reads as `clientModules`.
 */
function moduleCollectorPlugin(sink: string[], cwd: string): esbuild.Plugin {
  return {
    name: "denext-client-modules",
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd((result) => {
        for (const id of Object.keys(result.metafile?.inputs ?? {})) {
          sink.push(
            /^[a-z][\w+.-]*:/i.test(id) && !/^[a-z]:[\\/]/i.test(id) ? id : resolve(cwd, id),
          );
        }
      });
    },
  };
}

/** React Native mode's plugins, then the client-module collector when `modules` is wanted. */
function leadingPlugins(
  rn: esbuild.Plugin[] | undefined,
  modules: string[] | undefined,
  projectDir: string,
): esbuild.Plugin[] {
  const out = [...(rn ?? [])];
  if (modules) out.push(moduleCollectorPlugin(modules, projectDir));
  return out;
}

/** `first` ahead of `rest`; `rest` itself (possibly undefined) when there is nothing first. */
function withPluginsFirst(
  first: esbuild.Plugin[] | undefined,
  rest: esbuild.Plugin[] | undefined,
): esbuild.Plugin[] | undefined {
  return first && first.length > 0 ? [...first, ...(rest ?? [])] : rest;
}

/**
 * The extra esbuild onLoad plugins for a SPA bundle: in DEV, Fast Refresh family
 * registrations (front-runs the deno-loader); in PROD, TanStack Router's route code-splitting
 * (`spa.tanstackRouter.autoCodeSplitting`) and the source transforms the app enabled — the
 * auto-memo compiler (`reactCompiler`) and/or the feature-flag fold (`features`), chained in one
 * plugin. All transform only first-party app source
 * and are omitted otherwise so nothing extra runs. (Dev keeps the untransformed fast-rebuild +
 * Fast Refresh; these are prod optimizations.)
 */
function spaBundlePlugins(
  projectDir: string,
  dev: boolean,
  config: ProjectPaths["config"],
  islands: boolean,
): esbuild.Plugin[] | undefined {
  if (dev && islands) return [spaRefreshPlugin(projectDir, spaIslandsTransform)];
  if (dev) return [spaRefreshPlugin(projectDir)];
  const plugins: esbuild.Plugin[] = [];
  // TanStack Router `autoCodeSplitting`: ahead of the source transforms, which it applies itself
  // to the route modules it answers (esbuild runs only the first `onLoad` that answers).
  const tanstack = config?.spa?.tanstackRouter;
  if (tanstack?.autoCodeSplitting === true) {
    plugins.push(
      tanstackCodeSplitPlugin(projectDir, tanstack, spaSourceTransform(config, islands)),
    );
  }
  const plugin = spaSourceTransformPlugin(projectDir, config, islands);
  if (plugin) plugins.push(plugin);
  return plugins.length > 0 ? plugins : undefined;
}

/** Whether the app's own source carries a `client:*` directive (then it is rewritten). */
async function usesSpaIslands(paths: ProjectPaths): Promise<boolean> {
  return (await spaIslandSources(paths.projectDir)).length > 0;
}

/**
 * The denext-native SPA bundle: plain `deno bundle` (fast, no esbuild). The app already imports
 * denext directly, so there is no react alias to rewrite; `features` are seeded and folded here,
 * and in dev the app's components are registered for Fast Refresh (`deno bundle` has no define
 * and no load plugins).
 */
async function bundleNativeSpa(
  paths: ProjectPaths,
  entrySource: string,
  clientDir: string,
  css: AppCss | null | undefined,
  minify: boolean,
  dev: boolean,
  platform: Platform,
): Promise<void> {
  const fold = await spaFeatureFold(paths.projectDir, featureFlags(paths.config), !dev);
  // Dev: the Fast Refresh family registrations the compat path's `spaRefreshPlugin` appends
  // (dev folds no features, so the two never substitute the same module).
  const refresh = dev ? await spaNativeRefresh(paths.projectDir) : null;
  // `client:*` component elements → deferred mounts, over the fold's / refresh's copies.
  const islands = await spaIslandRedirects(paths.projectDir, {
    ...fold.importMap,
    ...refresh?.importMap,
  });
  try {
    const bundle = await bundleSourceFiles(fold.seed + entrySource, {
      configPath: paths.configPath,
      minify,
      importMap: { ...css?.importMap },
      // `deno bundle` cannot probe: the target's platform files are file-URL redirects (with
      // rewritten copies of the modules that reach one through an import-map alias), pointed
      // at the feature-folded / refresh copy of the variant when there is one. A SPA has no
      // server, so it has no action stubs: a `"use server"` module it reaches fails the bundle.
      projectDir: paths.projectDir,
      redirects: await projectPlatformRedirects(paths.projectDir, paths.config, platform),
      rewritten: { ...fold.importMap, ...refresh?.importMap, ...islands.importMap },
      dev,
    });
    await writeBundleOutput(clientDir, bundle, ENTRY_FILE);
  } finally {
    await fold.cleanup();
    await refresh?.cleanup();
    await islands.cleanup();
  }
}

/**
 * Bundle the SPA entry and extract its stylesheet. Writes the entry bundle (+ split
 * chunks) into `clientDir` as `index.js`, and — when the app has CSS reachable from the
 * entry graph — `index.css`.
 *
 * @returns Whether a stylesheet was emitted (so the caller can `<link>` it), and — when a
 *   plugin registered a build step and the bundle went through esbuild — the modules it holds.
 */
export async function bundleSpaInto(
  paths: ProjectPaths,
  entryPath: string,
  clientDir: string,
  minify: boolean,
  dev = false,
  platform: Platform = "web",
): Promise<{ hasStyles: boolean; modules?: readonly string[] }> {
  const spa = paths.config!.spa!;
  const cssRoots = await spaCssRoots(paths, entryPath, platform);
  const css = await spaCss(paths, cssRoots, minify, await spaCssGraph(paths, platform));
  // Auto-detect which reconciler-seam runtimes the entry must install. Class components default
  // ON for SPA (an explicit `classComponents:false` opts out) — a compat SPA bundles npm deps
  // that can render class components, which a source scan wouldn't see. `<Activity>`/
  // `<ViewTransition>` are denext-only APIs the app itself must name, so a source scan detects
  // them precisely (and keeps their runtimes out of a bundle that never uses them).
  const [scannedActivity, viewTransition, singletons] = await Promise.all([
    appUsesActivity(paths.projectDir, [entryPath]),
    appUsesViewTransition(paths.projectDir, [entryPath]),
    appRendersDocumentTags(paths.projectDir, [entryPath]),
  ]);
  // React Native mode's Expo Router navigators keep hidden stack screens in an `Activity`.
  const activity = scannedActivity || reactNativeOptions(paths.config) !== null;
  // The opt-out seed is an import, not a statement: `main.tsx` is imported statically and may
  // call `createRoot` while it evaluates, before any statement of this entry has run.
  // Production: the chunk-load error handler, installed ahead of the app (the rewritten
  // `import()` calls look it up when they fail; see chunk-error.ts).
  const entrySource = (dev ? "" : CHUNK_ERROR_SEED) +
    momentumScrollSeedImport(momentumSafeScrollEnabled(paths.config)) +
    generateSpaEntry(
      toFileUrl(entryPath).href,
      dev,
      paths.instrumentationClientPath,
      {
        classComponents: paths.config?.classComponents ?? true,
        activity,
        viewTransition,
        singletons,
        expoRouterLinks: await usesExpoRouter(paths),
        reactNative: reactNativeOptions(paths.config) !== null,
      },
    );
  // React Native mode needs the esbuild path (its resolver and loaders live there).
  const compat = reactNativeOptions(paths.config) !== null || await detectNextCompat(paths);
  // `spa.env` and Vite-style asset imports (`?url`/`?worker`) only apply on the compat
  // (esbuild) path; a denext-native SPA bundles with plain `deno bundle`. Warn rather
  // than silently ignore, so the footgun surfaces.
  if (!compat && spa.env && Object.keys(spa.env).length > 0) {
    console.warn(
      "  denext: `spa.env` is ignored — it applies only when the app uses npm React " +
        "(node_modules/react, or set `compatibilityMode: true`).",
    );
  }
  // The client modules a plugin build step reads (`clientModules`), collected only when one
  // is registered (esbuild's metafile is otherwise not built).
  const modules = compat && !dev && hasPluginBuildSteps() ? [] as string[] : undefined;
  if (compat) {
    await bundleCompatSpa(paths, entrySource, clientDir, css, minify, dev, platform, modules);
  } else {
    await bundleNativeSpa(paths, entrySource, clientDir, css, minify, dev, platform);
  }
  // A split chunk that fails to load dispatches `vite:preloadError` / `denext:chunkError`.
  if (!dev) await wrapDynamicImports(clientDir, spaClientPrefix(spa));
  if (!css) return { hasStyles: false, modules };
  const text = await extractRouteCss(cssRoots, css);
  if (text.trim().length === 0) return { hasStyles: false, modules };
  await Deno.writeTextFile(join(clientDir, STYLE_FILE), text);
  return { hasStyles: true, modules };
}
