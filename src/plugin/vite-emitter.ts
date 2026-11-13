// Run a Vite plugin's `generateBundle` emitter as a denext build step.
//
// Many Vite plugins only publish a generated file: a licence manifest, a version stamp, a
// sitemap. They do it from `generateBundle(options, bundle)` with
// `this.emitFile({ type: "asset", fileName, source })`. `viteEmitterPlugin(vitePlugin)` wraps
// such a plugin unchanged: at `denext build` / `denext export` it calls the hook with a
// Rollup-like `this` whose `emitFile` publishes through {@linkcode PluginBuildContext.emitFile},
// and a `bundle` holding one synthetic chunk whose `modules` are the client bundle's modules
// when the build knows them (`clientModules`), so a plugin that inspects the bundled modules
// sees them. An asset emitted by `name` alone gets Rollup's default content-hashed name
// (`assets/[name]-[hash][extname]`, in `spa.assetsDir` when set), which `this.getFileName(ref)`
// returns. What it does not provide: a chunk-type `emitFile`, a custom `assetFileNames` pattern,
// `setAssetSource`, the per-chunk breakdown of a real Rollup bundle, and every other Vite hook
// (transform, resolveId, configureServer, …) — `denext migrate` flags plugins that rely on those.

/**
 * `viteEmitterPlugin`: run a Vite plugin's `generateBundle` file emitter as a denext build step;
 * `viteBuildPlugin`: run Vite plugins' build hooks (`configResolved`, `buildStart`,
 * `generateBundle`, `writeBundle`, `closeBundle`) as one.
 * The same function `denext/plugin-kit` exports, on an entry light enough for
 * `denext.config.ts` (which a Deno Desktop app's `desktop.ts` imports at runtime): no bundler,
 * no npm package.
 *
 * @module
 */

// The plugin types are spelled structurally here (a subset of `PluginBuildContext` and
// `PluginContext`) rather than imported, so this entry stays light and self-documenting; the
// returned plugin is assignable to `DenextPlugin` (tests/plugin-emit.test.ts registers it).

/** The parts of a plugin build step's context the emitter uses (a subset of `PluginBuildContext`). */
export interface ViteEmitterBuildContext {
  /** The build output directory. */
  readonly outDir: string;
  /** The resolved project config (`spa.assetsDir` places the synthetic entry chunk). */
  readonly config: { readonly spa?: { readonly assetsDir?: string } };
  /** The client bundle's modules (absolute paths), when the build knows them. */
  readonly clientModules?: readonly string[];
  /**
   * Publish a file at the site root: at its `fileName`, or under a content-hashed name made from
   * its `name` (resolves to the file name).
   */
  emitFile(
    asset:
      | { readonly fileName: string; readonly source: string | Uint8Array }
      | { readonly name: string; readonly source: string | Uint8Array },
  ): Promise<unknown>;
}

/** The setup context `viteEmitterPlugin`'s plugin uses (a subset of `PluginContext`). */
export interface ViteEmitterSetupContext {
  /** Register a build step (runs at `denext build` / `denext export`). */
  addBuildStep(step: (build: ViteEmitterBuildContext) => void | Promise<void>): void;
}

/** The denext plugin {@linkcode viteEmitterPlugin} returns (assignable to `DenextPlugin`). */
export interface ViteEmitterDenextPlugin {
  /** `vite:<the Vite plugin's name>`. */
  readonly name: string;
  /** Registers the emitter's build step. */
  setup(ctx: ViteEmitterSetupContext): void;
}

import { normalizeSpaAssetsDir } from "../server/config-validate.ts";
import { hashedAssetFileName } from "./asset-name.ts";

/** A Rollup `emitFile` argument (only `type: "asset"`, with a `fileName` or a `name`). */
export interface ViteEmittedFile {
  /** `"asset"` (a `"chunk"` / `"prebuilt-chunk"` is refused). */
  type: string;
  /** Where the file is published, relative to the site root. */
  fileName?: string;
  /**
   * Rollup's name-for-hashing: without a `fileName`, the file is published as
   * `assets/[name]-[hash][extname]` (in `spa.assetsDir` when set), hashed from `source`.
   */
  name?: string;
  /** The file's contents. */
  source?: string | Uint8Array;
}

/** A `generateBundle` hook: a function, or Rollup's `{ handler }` object form. */
export type GenerateBundleHook =
  | ((this: ViteEmitterContext, options: unknown, bundle: unknown, isWrite: boolean) => unknown)
  | {
    handler: (
      this: ViteEmitterContext,
      options: unknown,
      bundle: unknown,
      isWrite: boolean,
    ) => unknown;
  };

/** The slice of a Vite plugin {@linkcode viteEmitterPlugin} runs. */
export interface VitePluginLike {
  /** The plugin's name (the denext plugin is named `vite:<name>`). */
  name?: string;
  /**
   * `"serve"` plugins never run at build; `"build"` and unset ones do. A function form is
   * called with Vite's production-build environment.
   */
  apply?: string | ((config: unknown, env: { command: string; mode: string }) => boolean);
  /** The hook that emits files. */
  generateBundle?: GenerateBundleHook;
}

/** The plugin context (`this`) the hook runs with: the parts of Rollup's an emitter uses. */
export interface ViteEmitterContext {
  /** Publish an asset at the site root; returns its reference (the published file name). */
  emitFile(file: ViteEmittedFile): string;
  /** The published file name of a reference `emitFile` returned. */
  getFileName(referenceId: string): string;
  /** Log a warning. */
  warn(message: unknown): void;
  /** Fail the build with `message`. */
  error(message: unknown): never;
  /** Which framework is running the hook. */
  meta: { framework: "denext" };
}

/** Whether a Vite plugin's `apply` admits a production build. */
function appliesToBuild(apply: VitePluginLike["apply"]): boolean {
  if (typeof apply === "function") return apply({}, { command: "build", mode: "production" });
  return apply !== "serve";
}

/**
 * The synthetic Rollup bundle handed to the hook (see the module doc). Its entry chunk is named
 * where the client entry is published: under `spa.assetsDir` when set (Vite's `build.assetsDir`),
 * else `_denext/client/`.
 */
function syntheticBundle(build: ViteEmitterBuildContext): Record<string, unknown> {
  const assetsDir = build.config.spa?.assetsDir;
  const dir = (assetsDir === undefined ? null : normalizeSpaAssetsDir(assetsDir)) ??
    "_denext/client";
  const fileName = `${dir}/index.js`;
  const modules = Object.fromEntries((build.clientModules ?? []).map((id) => [id, {}]));
  return {
    [fileName]: {
      type: "chunk",
      fileName,
      name: "index",
      isEntry: true,
      modules,
      moduleIds: Object.keys(modules),
    },
  };
}

/** The file name an emitted asset is published under (see {@linkcode ViteEmittedFile}). */
function emittedFileName(build: ViteEmitterBuildContext, file: ViteEmittedFile): string {
  if (file.type !== "asset") {
    throw new Error(
      `denext: a Vite plugin emitted a "${file.type}"; only type "asset" files are supported`,
    );
  }
  if (file.fileName) return file.fileName;
  if (!file.name) {
    throw new Error(
      "denext: a Vite plugin emitted an asset without a fileName or a name (unsupported)",
    );
  }
  if (file.source === undefined) {
    throw new Error(
      `denext: a Vite plugin emitted the asset ${JSON.stringify(file.name)} without a source ` +
        "(setAssetSource is unsupported)",
    );
  }
  return hashedAssetFileName(file.name, file.source, build.config);
}

/** The `this` a hook runs with, collecting the writes its `emitFile` calls start. */
function emitterContext(
  build: ViteEmitterBuildContext,
  writes: Promise<unknown>[],
): ViteEmitterContext {
  // Every published file name (a reference is its file name): an asset emitted twice with the
  // same name and contents is written once, as Rollup deduplicates it.
  const emitted = new Set<string>();
  return {
    emitFile(file) {
      const fileName = emittedFileName(build, file);
      if (emitted.has(fileName) && !file.fileName) return fileName;
      emitted.add(fileName);
      const source = file.source ?? "";
      writes.push(
        file.fileName ? build.emitFile({ fileName, source }) : build.emitFile({
          name: file.name!,
          source,
        }),
      );
      return fileName;
    },
    getFileName(referenceId) {
      if (emitted.has(referenceId)) return referenceId;
      throw new Error(`denext: getFileName: no file was emitted as ${JSON.stringify(referenceId)}`);
    },
    warn(message) {
      console.warn("denext: (vite plugin)", message);
    },
    error(message) {
      throw message instanceof Error ? message : new Error(String(message));
    },
    meta: { framework: "denext" },
  };
}

/**
 * Wrap a Vite plugin whose `generateBundle` emits files (`this.emitFile({ type: "asset",
 * fileName, source })`) as a denext plugin: the hook runs as a build step at `denext build` and
 * `denext export`, and each file it emits is published at the site root.
 *
 * @example
 * ```ts
 * // denext.config.ts
 * import { viteEmitterPlugin } from "denext/plugin-kit/vite-emitter";
 * import { licensesPlugin } from "./scripts/licenses.ts";
 * export default { plugins: [viteEmitterPlugin(licensesPlugin({ out: "licenses.json" }))] };
 * ```
 *
 * @param vitePlugin The Vite plugin object (what its factory returns).
 * @returns A denext plugin named `vite:<name>`.
 */
export function viteEmitterPlugin(vitePlugin: VitePluginLike): ViteEmitterDenextPlugin {
  const name = `vite:${vitePlugin.name ?? "anonymous"}`;
  return {
    name,
    setup(ctx) {
      const hook = vitePlugin.generateBundle;
      if (!hook || !appliesToBuild(vitePlugin.apply)) return;
      const fn = typeof hook === "function" ? hook : hook.handler;
      ctx.addBuildStep(async (build) => {
        const writes: Promise<unknown>[] = [];
        await fn.call(
          emitterContext(build, writes),
          { dir: build.outDir, format: "es" },
          syntheticBundle(build),
          true,
        );
        await Promise.all(writes);
      });
    },
  };
}

/** A Rollup / Vite hook: a function, or the `{ handler }` object form. */
type HookValue = ((this: ViteEmitterContext, ...args: unknown[]) => unknown) | {
  handler: (this: ViteEmitterContext, ...args: unknown[]) => unknown;
};

/** A Vite plugin as {@linkcode viteBuildPlugin} reads it: its build hooks, by name. */
export interface VitePluginObject extends VitePluginLike {
  /** `"pre"` plugins run first, `"post"` ones last. */
  enforce?: "pre" | "post";
  /** Any other hook. */
  [hook: string]: unknown;
}

/** What {@linkcode viteBuildPlugin} takes: plugins, nested arrays, promises, or a module / config. */
export type VitePluginInput =
  | VitePluginObject
  | null
  | false
  | undefined
  | Promise<unknown>
  | readonly unknown[]
  | { default?: unknown; plugins?: unknown };

/**
 * The Vite / Rollup build hooks {@linkcode viteBuildPlugin} runs, in this order: `configResolved`
 * (with a resolved-config stand-in), `buildStart`, `generateBundle`, `writeBundle`, `closeBundle`
 * (each with `this.emitFile`, `this.warn`, `this.error`). The module-graph hooks below are not
 * run, since denext bundles with esbuild, not Rollup; a plugin that has them is named in a warning.
 */
export const VITE_BUILD_HOOKS = [
  "configResolved",
  "buildStart",
  "generateBundle",
  "writeBundle",
  "closeBundle",
] as const;

/** The hooks a Vite plugin may have that denext's build does not run. */
export const VITE_UNSUPPORTED_HOOKS = [
  "resolveId",
  "load",
  "transform",
  "renderChunk",
  "transformIndexHtml",
  "moduleParsed",
  "renderStart",
  "augmentChunkHash",
] as const;

/** Flatten an input into its plugin objects (awaiting promises; a module's `default`, a config's `plugins`). */
export async function flattenVitePlugins(input: unknown): Promise<VitePluginObject[]> {
  const value = await input;
  if (!value) return [];
  if (Array.isArray(value)) return (await Promise.all(value.map(flattenVitePlugins))).flat();
  if (typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if ("default" in o && !("name" in o)) return flattenVitePlugins(o.default);
  if ("plugins" in o && !("name" in o)) return flattenVitePlugins(o.plugins);
  return [o as VitePluginObject];
}

/** The plugins in Vite's order: `enforce: "pre"`, then the rest, then `"post"`. */
function vitePluginOrder(plugins: VitePluginObject[]): VitePluginObject[] {
  const rank = (p: VitePluginObject) => p.enforce === "pre" ? 0 : p.enforce === "post" ? 2 : 1;
  return plugins.filter((p) => appliesToBuild(p.apply)).sort((a, b) => rank(a) - rank(b));
}

/** A hook's function (its `handler` in the object form), if the plugin has it. */
function hookFn(plugin: VitePluginObject, name: string) {
  const hook = plugin[name] as HookValue | undefined;
  if (!hook) return undefined;
  return typeof hook === "function" ? hook : hook.handler;
}

/** The arguments each build hook is called with. */
function hookArgs(name: string, build: ViteEmitterBuildContext): unknown[] {
  const output = { dir: build.outDir, format: "es" };
  if (name === "configResolved") {
    const config = { root: ".", command: "build", mode: "production", isProduction: true };
    return [{ ...config, build: { outDir: build.outDir } }];
  }
  if (name === "generateBundle") return [output, syntheticBundle(build), true];
  if (name === "writeBundle") return [output, syntheticBundle(build)];
  return [];
}

/** Warn once per plugin about the hooks of it denext does not run. */
function warnUnsupported(plugin: VitePluginObject): void {
  const missing = VITE_UNSUPPORTED_HOOKS.filter((h) => plugin[h] !== undefined);
  if (missing.length === 0) return;
  console.warn(
    `denext: Vite plugin ${plugin.name ?? "(anonymous)"}: ${missing.join(", ")} not run ` +
      "(denext bundles with esbuild); its build hooks run",
  );
}

/** Run every plugin's build hooks in order (see {@linkcode VITE_BUILD_HOOKS}). */
async function runViteBuildHooks(
  plugins: VitePluginObject[],
  build: ViteEmitterBuildContext,
): Promise<void> {
  for (const p of plugins) warnUnsupported(p);
  for (const name of VITE_BUILD_HOOKS) {
    for (const plugin of plugins) {
      const fn = hookFn(plugin, name);
      if (!fn) continue;
      const writes: Promise<unknown>[] = [];
      await fn.call(emitterContext(build, writes), ...hookArgs(name, build));
      await Promise.all(writes);
    }
  }
}

/**
 * Run Vite plugins' build hooks as one denext build step (see {@linkcode VITE_BUILD_HOOKS}): a
 * Fresh 2 app's other Vite plugins, carried by `denext migrate`. `input` may be the plugins
 * (nested arrays and promises included), a Vite config or a module exporting one, or a function
 * returning any of those, called at build so a plugin package loads only then; a plugin that
 * fails to load is skipped with a warning.
 *
 * @example
 * ```ts
 * // denext.config.ts
 * import { viteBuildPlugin } from "denext/plugin-kit/vite-emitter";
 * export default { plugins: [viteBuildPlugin(() => import("./vite.plugins.ts"))] };
 * ```
 *
 * @param input The plugins, or what loads them.
 * @returns A denext plugin named `vite:build`.
 */
export function viteBuildPlugin(
  input: VitePluginInput | (() => VitePluginInput),
): ViteEmitterDenextPlugin {
  return {
    name: "vite:build",
    setup(ctx) {
      ctx.addBuildStep(async (build) => {
        let plugins: VitePluginObject[];
        try {
          plugins = await flattenVitePlugins(typeof input === "function" ? input() : input);
        } catch (err) {
          console.warn("denext: the Vite plugins could not be loaded; skipped:", err);
          return;
        }
        await runViteBuildHooks(vitePluginOrder(plugins), build);
      });
    },
  };
}
