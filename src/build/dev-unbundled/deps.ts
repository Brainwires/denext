// Unbundled dev: the dependency pre-bundles — the native denext `@dep` set, the compat
// react→denext runtime, and the compat on-demand npm bundle (Vite optimizeDeps).

import { denoLoaderPlugins } from "../deno-loader-plugins.ts";
import * as esbuild from "esbuild";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  BROWSER_CONDITIONS,
  browserProcessShimPath,
  catalogResolverPlugin,
  DEFAULT_ASSET_LOADERS,
  frameworkPatchPlugins,
  nodeBuiltinStubPlugin,
  prebuildDenextRuntime,
  serverStubPlugin,
  viteAssetPlugin,
} from "../next-compat.ts";
import { generateServerStub } from "../bundle.ts";
import {
  buildReactNativeDeps,
  crawlReactNativeGraph,
  dependencySignature,
} from "./react-native.ts";
import { compatDepUrl, ensureMergedConfig, libraryDepUrl } from "./resolve.ts";
import {
  crawlModuleGraph,
  DEP_ENTRYPOINTS,
  depSlug,
  norm,
  NPM_PREFIX,
  type UnbundledState,
} from "./state.ts";
import { transform } from "./transform.ts";

/** Bundle the native denext `@dep` set once (shared core hoisted into one chunk). */
async function buildDeps(st: UnbundledState): Promise<void> {
  const cfg = await ensureMergedConfig(st);
  // Resolve each denext dep to its framework source URL (file:// from a checkout,
  // https:// from JSR) so the deno-loader can fetch it either way.
  const base = new URL("../../../", import.meta.url).href;
  const entryPoints: Record<string, string> = {};
  for (const [slug, rel] of Object.entries(DEP_ENTRYPOINTS)) {
    entryPoints[slug] = new URL(rel, base).href;
  }
  await ensureDir(st.depDir);
  await esbuild.build({
    entryPoints,
    outdir: st.depDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "denext",
    // Native helper packages (used by next/og etc.) are lazily imported at
    // runtime — never reached by native App Router client code; keep external.
    external: ["@denext/photon", "@denext/avif", "@denext/og"],
    plugins: [
      ...(await frameworkPatchPlugins(st.opts.projectDir, base)),
      ...denoLoaderPlugins({ configPath: cfg }),
    ],
  });
}

/** The native `@dep` pre-bundle (built once, awaited by every caller). */
export function ensureDeps(st: UnbundledState): Promise<void> {
  return st.depsBuilt ??= buildDeps(st);
}

/**
 * compat: prebuild the react→denext runtime (react/react-dom/next/* + denext client,
 * jsx, live, lazy) into ONE shared graph (esbuild `splitting` → a single denext
 * instance). Served under DEP_PREFIX; the app's own react/npm imports point here.
 */
function ensureRuntime(st: UnbundledState): Promise<void> {
  return st.runtimeBuilt ??= prebuildDenextRuntime({
    outDir: st.runtimeDir,
    configPath: st.opts.configPath,
    classComponents: st.opts.classComponents ?? true,
    projectDir: st.opts.projectDir,
  }).then(() => {});
}

/** The @dep pre-bundle the client entry needs before it runs: runtime (compat) or denext (native). */
export function ensureClientDeps(st: UnbundledState): Promise<void> {
  return st.compat ? ensureRuntime(st) : ensureDeps(st);
}

/**
 * compat: an esbuild plugin marking react-family / next/* / denext-runtime specifiers
 * EXTERNAL, pointing at the shared prebuilt runtime's dev URLs — so an npm package's
 * own `import "react"` resolves to denext's single React (never a second copy).
 */
function runtimeExternalPlugin(st: UnbundledState): esbuild.Plugin {
  return {
    name: "denext-runtime-external",
    setup(build) {
      // A package's import of an aliased specifier (`lists: "denext"`) → its runtime module.
      const aliased = Object.keys(st.opts.specAliases ?? {});
      if (aliased.length > 0) {
        const filter = new RegExp(
          `^(?:${aliased.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`,
        );
        build.onResolve({ filter }, (args) => {
          const u = compatDepUrl(st, args.path);
          return u ? { path: u, external: true } : null;
        });
      }
      build.onResolve(
        {
          filter:
            /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$|^next$|^next\/|^denext(\/|$)/,
        },
        (args) => {
          // A CommonJS package's `require()` of Next's server surface (an npm island's whole
          // CJS graph is bundled, server files included): the browser gets a module whose
          // functions throw when called — loading the server runtime would import `node:*`.
          if (args.kind === "require-call" && SERVER_NEXT.test(args.path)) {
            return { path: args.path, namespace: SERVER_NEXT_NS };
          }
          const u = libraryDepUrl(args.path, args.importer) ?? compatDepUrl(st, args.path);
          if (!u) return null;
          // A CommonJS `require("react")` cannot reach an external ES module (esbuild's output
          // throws "Dynamic require … is not supported"): require a wrapper module instead,
          // which imports the external statically and re-exports it.
          return args.kind === "require-call"
            ? { path: u, namespace: CJS_EXTERNAL_NS }
            : { path: u, external: true };
        },
      );
      // The wrapper's own import: the runtime module's dev URL, external.
      build.onResolve({ filter: /^\/_denext\//, namespace: CJS_EXTERNAL_NS }, (args) => ({
        path: args.path,
        external: true,
      }));
      build.onLoad({ filter: /.*/, namespace: SERVER_NEXT_NS }, (args) => ({
        contents: serverOnlyStub(args.path),
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: CJS_EXTERNAL_NS }, (args) => ({
        contents: cjsExternalWrapper(args.path),
        loader: "js",
      }));
    },
  };
}

/** Next's server-only surfaces (`next/headers`, `next/server`, `next/cache`, `next/og`). */
const SERVER_NEXT = /^next\/(?:headers|server|cache|og)(?:\.js)?$/;
/** The esbuild namespace of {@link serverOnlyStub} modules. */
const SERVER_NEXT_NS = "denext-server-next-stub";

/**
 * A CommonJS stand-in for a server-only `next/*` module in the browser: any export is a function
 * that throws when called (`headers()` in a client component), never at import.
 */
export function serverOnlyStub(spec: string): string {
  return `const fail = (name) => () => {
` +
    `  throw new Error(${JSON.stringify(spec)} + "." + String(name) + "() is server-only");
` +
    `};
` +
    `module.exports = new Proxy({ __esModule: true }, {
` +
    `  get: (t, k) => (k in t || typeof k === "symbol" ? t[k] : fail(k)),
` +
    `});
`;
}

/** The esbuild namespace of {@link cjsExternalWrapper} modules. */
const CJS_EXTERNAL_NS = "denext-cjs-external";

/**
 * An ES module re-exporting the external runtime module at `url` — what a CommonJS package's
 * `require()` of a react-family / `next/*` / `denext` specifier gets in the dev npm bundle (an
 * npm package's CJS build: `@clerk/nextjs`'s islands). esbuild converts a required ES module
 * to its exports object, and keeps the static import of `url` external.
 */
export function cjsExternalWrapper(url: string): string {
  const u = JSON.stringify(url);
  return `import * as m from ${u};
export * from ${u};
export default (m.default ?? m);
`;
}

/** One npm optimizeDeps pass over every discovered specifier (see ensureNpmBundle). */
async function buildNpmBundle(st: UnbundledState): Promise<void> {
  await ensureDir(st.npmDir);
  // A rebuild renames the shared chunks: a page that already loaded the previous bundle (a
  // module discovered a new package after the first build) would fetch chunks that are gone.
  const underLivePage = st.npmBuiltOnce;
  do {
    // A rebuild waits a moment first: a lazily loaded route discovers its packages in a burst
    // of module requests, and they should ride one build (and one reload), not one each.
    if (st.npmBuiltOnce) await new Promise((r) => setTimeout(r, NPM_REBUILD_DEBOUNCE_MS));
    const specs = [...st.npmSpecs];
    await npmBuildIsolated(st, specs);
    st.npmBuilds++;
    st.npmBuilt = new Set(specs);
    st.npmBuiltOnce = true;
  } while (!npmBundleCurrent(st));
  if (underLivePage) st.opts.onDepsRebuilt?.();
}

/** How long a rebuild under a live page waits to batch a burst of newly found packages. */
const NPM_REBUILD_DEBOUNCE_MS = 400;

/** Whether the npm bundle holds every specifier found so far. */
function npmBundleCurrent(st: UnbundledState): boolean {
  return [...st.npmSpecs].every((s) => st.npmBuilt.has(s));
}

/**
 * compat: crawl the app's import graph from `roots` (the SPA entry, a route's modules, the
 * Flight islands) before the npm bundle builds, so the first build already holds every package
 * the page will import. Without it each module request found a few packages at a time and every
 * find rebuilt the bundle and reloaded the page: T3 Code's graph never finished loading. The
 * crawl runs in the background; {@link ensureNpmBundle} waits for it. Each root is crawled once.
 */
export function prewarmNpmBundle(st: UnbundledState, roots: readonly string[]): void {
  if (!st.compat || st.opts.reactNative) return;
  const fresh = roots.map(norm).filter((abs) => !st.npmCrawledRoots.has(abs));
  if (fresh.length === 0) return;
  for (const abs of fresh) st.npmCrawledRoots.add(abs);
  const previous = st.npmCrawl;
  const crawl: Promise<void> = (async () => {
    await previous;
    await crawlModuleGraph(fresh, (abs) => transform(st, abs));
  })().catch(() => {}).finally(() => {
    if (st.npmCrawl === crawl) st.npmCrawl = null;
  });
  st.npmCrawl = crawl;
}

/** The npm bundle's entry points: one per specifier, named by its slug. */
function npmEntries(specs: readonly string[]): Record<string, string> {
  const entryPoints: Record<string, string> = {};
  for (const s of specs) entryPoints[depSlug(s)] = s;
  return entryPoints;
}

/** The text of an esbuild failure (its `errors` list), or the error's message. */
function buildErrorText(err: unknown): string {
  const errors = (err as { errors?: esbuild.Message[] })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) =>
      e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}` : e.text
    ).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The module served for a specifier whose package fails to bundle for the browser: it names the
 * package and the build errors in the console (the dev Console tab captures it) and throws, so
 * only the modules that import it fail — never every npm module of the page.
 */
export function npmErrorModule(spec: string, errors: string): string {
  const msg = `denext dev: the npm package "${spec}" failed to bundle for the browser:\n${errors}`;
  return `const message = ${JSON.stringify(msg)};\nconsole.error(message);\n` +
    `throw new Error(message);\n`;
}

/**
 * Bisect `specs` (whose build failed with `err`) down to the specifiers that fail on their own,
 * by trial builds that write nothing. Each failing specifier lands in `out` with its errors.
 */
async function findFailingSpecs(
  st: UnbundledState,
  specs: readonly string[],
  err: unknown,
  out: Map<string, string>,
): Promise<void> {
  if (specs.length === 1) {
    out.set(specs[0], buildErrorText(err));
    return;
  }
  const mid = specs.length >> 1;
  for (const half of [specs.slice(0, mid), specs.slice(mid)]) {
    try {
      await npmBuild(st, npmEntries(half), false);
    } catch (e) {
      await findFailingSpecs(st, half, e, out);
    }
  }
}

/**
 * Build the npm bundle for `specs` in one pass. When that fails, one broken package must not
 * fail every npm module: the specifiers that fail on their own are found by bisection, the rest
 * are bundled together (one instance per shared package, as before), and each failing one is
 * served as {@link npmErrorModule}. Rethrows when no single specifier is to blame. Returns the
 * failing specifiers with their errors. Exported for testing.
 */
export async function npmBuildIsolated(
  st: UnbundledState,
  specs: readonly string[],
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  try {
    await npmBuild(st, npmEntries(specs));
    return failures;
  } catch (err) {
    await findFailingSpecs(st, specs, err, failures);
    if (failures.size === 0) throw err;
  }
  const good = specs.filter((s) => !failures.has(s));
  if (good.length > 0) await npmBuild(st, npmEntries(good));
  for (const [spec, errors] of failures) {
    console.error(`denext dev: the npm package "${spec}" failed to bundle:\n${errors}`);
    await Deno.writeTextFile(join(st.npmDir, `${depSlug(spec)}.js`), npmErrorModule(spec, errors));
  }
  return failures;
}

/**
 * One esbuild pass into the npm dir: the dependency bundle, or a `?worker` module one of its
 * packages imports. Vite-style asset imports (`x.mp3?url`, `?raw`, `?inline`, `?worker`), which
 * a workspace package may use as it does in a Vite app, go through the build's own asset plugin
 * and are served from the npm dir like the chunks. The app's own asset imports ride here too
 * (see `rewriteSpecifier`): a bare `./logo.png` loads as a file, and every emitted file's URL
 * is absolute under the npm prefix, so it resolves from any page.
 */
async function npmBuild(
  st: UnbundledState,
  entryPoints: Record<string, string>,
  write = true,
): Promise<void> {
  const workerBuild = (entryPath: string, outName: string) =>
    npmBuild(st, { [outName]: entryPath }, write);
  await esbuild.build({
    entryPoints,
    write,
    outdir: st.npmDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    sourcemap: "inline",
    jsx: "automatic",
    jsxImportSource: "react",
    absWorkingDir: st.opts.projectDir,
    loader: DEFAULT_ASSET_LOADERS,
    publicPath: NPM_PREFIX,
    // `process.env.NODE_ENV` / `NEXT_PUBLIC_*` in npm code, as in a build's browser bundle (the
    // public env comes from the page's public-env island).
    inject: [await browserProcessShimPath(st.npmDir, "development")],
    logLevel: "silent",
    plugins: [
      // An npm island's `"use server"` import (its package's action module) → a client stub.
      serverStubPlugin(st.npmServerRefs, generateServerStub),
      viteAssetPlugin({ publicPath: NPM_PREFIX }, workerBuild),
      runtimeExternalPlugin(st),
      catalogResolverPlugin(st.opts.projectDir, "all", BROWSER_CONDITIONS),
      nodeBuiltinStubPlugin(),
    ],
  });
}

/**
 * React Native mode's dependency bundle ({@linkcode buildReactNativeDeps}), current for the
 * app's whole import graph: every module reachable from the entry and expo-router's routes is
 * transformed first (a cache hit when unchanged), so the bundle already carries every
 * specifier and name the page will import — a module linking against a bundle that lacks one
 * of its imports fails to load.
 */
async function ensureReactNativeBundle(st: UnbundledState): Promise<void> {
  const epoch = st.graphEpoch;
  await crawlReactNativeGraph(st, (abs) => transform(st, abs));
  const sig = dependencySignature(st);
  if (sig !== st.npmBuiltSig) {
    // A rebuild over a current bundle (not the first build, not an invalidation that already
    // reloaded the page): the page holds the previous bundle's modules.
    const underLivePage = st.npmBuiltSig !== null;
    await ensureRuntime(st);
    await buildReactNativeDeps(st);
    st.npmBuiltSig = sig;
    if (underLivePage) {
      st.npmLiveRebuilds++;
      st.opts.onDepsRebuilt?.();
    }
  }
  st.npmCheckedEpoch = epoch;
}

/**
 * React Native mode, after a batch of edits: bring the dependency bundle up to date with the
 * edited modules' imports BEFORE the page is told to hot-swap them. An edit that imports a new
 * name (or package) needs a rebuilt bundle; hot-swapping first would link the new module
 * against the page's old bundle ("does not provide an export named …") and fall into a
 * reload, then the rebuild's own reload. Resolves true when the bundle was rebuilt — the
 * rebuild has already told the page to reload, so the caller sends nothing else.
 */
export async function refreshReactNativeDeps(st: UnbundledState): Promise<boolean> {
  if (!st.opts.reactNative || st.npmBuiltSig === null) return false;
  const before = st.npmLiveRebuilds;
  await ensureNpmBundle(st);
  return st.npmLiveRebuilds !== before;
}

/**
 * compat: on-demand npm dependency bundle (Vite optimizeDeps). ALL discovered npm
 * specifiers are bundled together in one `splitting` pass so packages sharing a
 * transitive dep get one instance; `react` is external (shared runtime). Rebuilt when
 * a newly-transformed module discovers a spec not yet in the bundle.
 */
export async function ensureNpmBundle(st: UnbundledState): Promise<void> {
  // The graph crawl first: the bundle then builds once with everything it found.
  while (st.npmCrawl) await st.npmCrawl;
  while (st.npmBuilding) await st.npmBuilding;
  if (st.opts.reactNative) {
    // React Native mode: re-checked once per batch of edits (a new specifier or name).
    if (st.npmCheckedEpoch === st.graphEpoch && st.npmBuiltSig !== null) return;
  } else if (st.npmSpecs.size === 0 || npmBundleCurrent(st)) return;
  st.npmBuilding = st.opts.reactNative ? ensureReactNativeBundle(st) : buildNpmBundle(st);
  try {
    await st.npmBuilding;
  } finally {
    st.npmBuilding = null;
  }
}
