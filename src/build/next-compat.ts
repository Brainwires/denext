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
  "react-dom/server": "react-dom-server.js",
  "react-dom/server.browser": "react-dom-server.js",
  "react-dom/server.edge": "react-dom-server.js",
  "react-dom/test-utils": "react-dom-test-utils.js",
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
    "react-dom-server": join(root, "src/compat/react-dom-server.ts"),
    "react-dom-test-utils": join(root, "src/compat/test-utils.ts"),
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
  /** Compile in the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
}

/** The esbuild `define` that gates the class-component runtime (see class-flag.ts). */
function classDefine(classComponents?: boolean): Record<string, string> {
  return { __DENEXT_CLASS_COMPONENTS__: JSON.stringify(!!classComponents) };
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
    define: classDefine(options.classComponents),
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
  /** Compile in the class-component runtime (default false → DCE'd out). */
  classComponents?: boolean;
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
      // denext's own client/SSR/jsx specifiers, aliased to the SAME prebuilt
      // graph so the generated route entry shares the one denext instance.
      const denextFile: Record<string, string> = {
        "denext/ssr": "ssr.js",
        "denext/ssr-stream": "ssr-stream.js",
        "denext/client": "client.js",
        "denext/jsx-runtime": "jsx-runtime.js",
        "denext/jsx-dev-runtime": "jsx-runtime.js",
      };
      build.onResolve({ filter: /^denext\// }, (args) => {
        const file = denextFile[args.path];
        return file ? { path: join(runtimeDir, file), namespace: DENEXT_NS } : null;
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
 * Node built-ins (with and without the `node:` prefix) that are **safe to stub** with
 * an empty module in a browser bundle — either they have no browser meaning (I/O /
 * system modules), or their browser equivalent is a global so the module import is a
 * Node-path signal (`url` → global `URL`, parsing-only legacy modules).
 *
 * Deliberately excludes browser-relevant / genuinely-polyfilled built-ins (`buffer`,
 * `crypto`, `stream`, `util`, `events`, `process`, `zlib`, `assert`, `timers`,
 * `console`): silently emptying those would turn a real browser dependency into an
 * `undefined` runtime crash, so we let esbuild resolve them (or fail loudly, signalling
 * a genuine polyfill need) rather than hide it.
 */
const STUBBABLE_BUILTINS: ReadonlySet<string> = new Set([
  "fs",
  "path",
  "os",
  "net",
  "tls",
  "dns",
  "dgram",
  "http",
  "http2",
  "https",
  "child_process",
  "cluster",
  "worker_threads",
  "inspector",
  "readline",
  "repl",
  "tty",
  "v8",
  "vm",
  "wasi",
  "module",
  "perf_hooks",
  "async_hooks",
  "diagnostics_channel",
  "trace_events",
  "domain",
  "constants",
  "sys",
  // Node-legacy modules whose browser equivalents are globals / parsing-only:
  "url",
  "querystring",
  "punycode",
  "string_decoder",
]);

/**
 * For **browser** bundles, stub Node built-ins (`fs`, `path`, …) with an empty
 * module — the esbuild parallel to webpack's `resolve.fallback: { fs: false }`.
 * Some browser-capable npm libraries (e.g. `@techstark/opencv-js`, `scribe.js-ocr`)
 * `require("fs")`/`import "node:path"` inside Node-only code paths that never run in
 * the browser; without this, esbuild's browser target fails to resolve them. The
 * empty CommonJS stub lets both default and named imports resolve (to `undefined`),
 * and the Node-only branch simply isn't taken at runtime. Browser-usable built-ins are
 * intentionally NOT stubbed (see {@link STUBBABLE_BUILTINS}).
 */
function nodeBuiltinStubPlugin(): esbuild.Plugin {
  const STUB_NS = "denext-node-stub";
  return {
    name: "denext-node-builtin-stub",
    setup(build) {
      build.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
        const bare = args.path.replace(/^node:/, "").split("/")[0];
        if (!STUBBABLE_BUILTINS.has(bare)) return null;
        return { path: args.path, namespace: STUB_NS };
      });
      // CommonJS empty module: named imports resolve at runtime to `undefined`,
      // so esbuild never errors on "no matching export".
      build.onLoad({ filter: /.*/, namespace: STUB_NS }, () => ({
        contents: "module.exports = {};",
        loader: "js",
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
  // Browser bundles: stub Node built-ins that appear only in npm libs' Node-only
  // code paths (the deno/SSR platform keeps the real built-ins).
  if (options.platform !== "deno") plugins.push(nodeBuiltinStubPlugin());
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
    define: classDefine(options.classComponents),
    plugins,
  });
}

/** Release esbuild's long-lived service process (call once at process end). */
export function stopNextCompat(): Promise<void> {
  return esbuild.stop();
}

/**
 * Run `fn` (typically one or more {@link prebuildDenextRuntime}/
 * {@link bundleNextCompat} calls) and **always** release esbuild's service
 * afterwards — even if `fn` throws. Use this for one-shot builds so a failed
 * build can never orphan the esbuild service process. Long-lived callers (the dev
 * server) should instead call {@link stopNextCompat} on shutdown.
 *
 * @param fn The build work to run.
 * @returns Whatever `fn` resolves to.
 */
export async function withEsbuild<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await esbuild.stop();
  }
}

/** Convert a filesystem path to a `file://` URL string (for dynamic import). */
export function toImportUrl(path: string): string {
  return toFileUrl(resolve(path)).href;
}
