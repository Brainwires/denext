/**
 * next-compat bundling: run **real npm React libraries** (Radix, react-hook-form,
 * sonner, lucide, …) on denext's single React by rewriting `react`/`react-dom`/
 * `react-is`/`react/*` → denext at bundle time — the same importer-insensitive
 * alias mechanism Preact uses for `preact/compat`, but applied through esbuild so
 * it also rewrites imports *inside* npm packages (which a Deno import-map alias
 * cannot reach).
 *
 * The one subtlety this module solves: esbuild + the Deno loader would otherwise
 * instantiate denext **twice** — app-code importers land in esbuild's `file`
 * namespace while npm importers land in the Deno loader's namespace, so the same
 * denext module resolves under two `(path, namespace)` keys → two hook
 * dispatchers → "no dispatcher installed" at SSR. We funnel **all** denext-runtime
 * code (the prebuilt compat bundle) through one dedicated esbuild namespace so it
 * can only ever be one instance.
 *
 * esbuild + `@luca/esbuild-deno-loader` are **build-time only** — they never enter
 * a shipped bundle or the denext runtime.
 *
 * @module
 */

import { denoPlugins } from "@luca/esbuild-deno-loader";
import * as esbuild from "esbuild";
import { dirname, join, resolve, toFileUrl } from "@std/path";
import { frameworkRoot } from "./bundle.ts";

/** The esbuild namespace all prebuilt denext-runtime modules are funneled into. */
const DENEXT_NS = "denext-runtime";

/**
 * The react-family specifiers rewritten to denext, mapped to the prebuilt entry
 * file name (within the runtime dir). Order/coverage matches what the ecosystem
 * imports (react, react-dom + client, react-is, the JSX runtimes).
 */
const REACT_ALIASES: Record<string, string> = {
  "react": "react.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",
  "react-is": "react-is.js",
  "react/jsx-runtime": "jsx-runtime.js",
  "react/jsx-dev-runtime": "jsx-runtime.js",
};

/** denext source entrypoints prebuilt into the shared runtime (one graph). */
function runtimeEntryPoints(root: string): Record<string, string> {
  return {
    "react": join(root, "src/compat/react.ts"),
    "react-dom": join(root, "src/compat/react-dom.ts"),
    "react-dom-client": join(root, "src/compat/react-dom-client.ts"),
    "react-is": join(root, "src/compat/react-is.ts"),
    "jsx-runtime": join(root, "src/jsx/jsx-runtime.ts"),
    // The SSR renderer must come from the SAME prebuilt graph as the aliased
    // react, or the server renders with a different dispatcher than the app's
    // components use.
    "ssr": join(root, "src/jsx/render-to-string.ts"),
    "ssr-stream": join(root, "src/jsx/render-to-stream.ts"),
    "client": join(root, "src/client/mod.ts"),
  };
}

/** Options for {@link prebuildDenextRuntime}. */
export interface PrebuildOptions {
  /** Output directory for the prebuilt runtime files. */
  outDir: string;
  /** denext framework root (defaults to the running framework). */
  frameworkRoot?: string;
  /** Path to the project's `deno.json` (for the deno loader's resolution). */
  configPath?: string;
}

/**
 * Prebuild denext's compat + SSR entrypoints into one shared, self-contained
 * runtime (esbuild `splitting` dedupes the denext core into a single chunk, so
 * every entry shares one hook dispatcher / reconciler). Produces plain ESM JS
 * with no bare `@std`/`jsr:` imports left, so the app build can load it with
 * esbuild's own resolver.
 *
 * @param options Where to emit + which framework/config to resolve against.
 * @returns The absolute runtime directory.
 */
export async function prebuildDenextRuntime(options: PrebuildOptions): Promise<string> {
  const root = options.frameworkRoot ?? frameworkRoot();
  const outDir = resolve(options.outDir);
  await Deno.mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: runtimeEntryPoints(root),
    outdir: outDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    plugins: [...denoPlugins({ configPath: options.configPath ?? join(root, "deno.json") })],
  });
  return outDir;
}

/** Options for {@link bundleNextCompat}. */
export interface BundleNextCompatOptions {
  /** Entry module (a route/client entry or a server render module). */
  entry: string;
  /** The prebuilt runtime dir from {@link prebuildDenextRuntime}. */
  runtimeDir: string;
  /** Output file path. */
  outfile: string;
  /** Project `deno.json` (for resolving app + npm deps via the deno loader). */
  configPath: string;
  /** Bundle target: browser (client) or deno (SSR). */
  platform?: "browser" | "deno";
  /** Minify (production). */
  minify?: boolean;
  /** Extra esbuild `alias` entries (e.g. `@radix-ui/*` → denext primitives later). */
  extraAlias?: Record<string, string>;
  /**
   * Use `@luca/esbuild-deno-loader` for jsr:/@std/https: specifiers. When the app
   * graph is npm + react/denext only (react handled by our plugin, npm by
   * esbuild's native node resolution), this can be `false` to avoid the loader's
   * npm sub-dep quirks. Default `true`.
   */
  denoLoader?: boolean;
  /** Absolute working directory (where node_modules lives) for native resolution. */
  absWorkingDir?: string;
}

/**
 * The esbuild plugin that funnels every react-family import (from app code AND
 * npm packages) into the single prebuilt denext runtime, all under one namespace
 * so denext is instantiated exactly once.
 */
function denextRuntimePlugin(runtimeDir: string): esbuild.Plugin {
  return {
    name: "denext-runtime",
    setup(build) {
      // react-family bare specifiers → prebuilt runtime file, in our namespace.
      const filter = /^react$|^react\/|^react-dom$|^react-dom\/|^react-is$/;
      build.onResolve({ filter }, (args) => {
        const file = REACT_ALIASES[args.path];
        if (!file) return null;
        return { path: join(runtimeDir, file), namespace: DENEXT_NS };
      });
      // denext's own SSR renderer, aliased to the SAME prebuilt graph.
      build.onResolve({ filter: /^denext\/(ssr|ssr-stream|client)$/ }, (args) => {
        const file = args.path.slice("denext/".length) + ".js";
        return { path: join(runtimeDir, file), namespace: DENEXT_NS };
      });
      // Relative imports *within* the prebuilt runtime (shared chunks) stay in the
      // namespace, keyed by absolute path → single instance.
      build.onResolve({ filter: /.*/, namespace: DENEXT_NS }, (args) => ({
        path: resolve(dirname(args.importer), args.path),
        namespace: DENEXT_NS,
      }));
      // Load prebuilt runtime files from disk as plain JS.
      build.onLoad({ filter: /.*/, namespace: DENEXT_NS }, async (args) => ({
        contents: await Deno.readTextFile(args.path),
        loader: "js",
        resolveDir: dirname(args.path),
      }));
    },
  };
}

/**
 * Bundle `entry` (client hydration entry or SSR render module) with all react
 * imports — including those inside npm packages — rewritten to the single
 * prebuilt denext runtime.
 *
 * @param options Bundle configuration.
 */
export async function bundleNextCompat(options: BundleNextCompatOptions): Promise<void> {
  const plugins: esbuild.Plugin[] = [denextRuntimePlugin(options.runtimeDir)];
  if (options.denoLoader ?? true) {
    // The portable loader resolves npm/jsr in-process (no spawned `deno`).
    plugins.push(...denoPlugins({ configPath: options.configPath, loader: "portable" }));
  }
  await esbuild.build({
    entryPoints: [options.entry],
    outfile: options.outfile,
    bundle: true,
    format: "esm",
    // "node" for the SSR bundle (Deno emulates Node; enables node_modules lookup +
    // node export conditions), "browser" for the client bundle.
    platform: options.platform === "deno" ? "node" : "browser",
    minify: options.minify ?? false,
    jsx: "automatic",
    jsxImportSource: "react",
    alias: options.extraAlias,
    absWorkingDir: options.absWorkingDir,
    plugins,
  });
}

/** Release esbuild's worker (call once at process end). */
export function stopNextCompat(): Promise<void> {
  return esbuild.stop();
}

/** Convert a filesystem path to a `file://` URL string (for dynamic import). */
export function toImportUrl(path: string): string {
  return toFileUrl(resolve(path)).href;
}
