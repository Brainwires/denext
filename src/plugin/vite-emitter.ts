// Run a Vite plugin's `generateBundle` emitter as a denext build step.
//
// Many Vite plugins only publish a generated file: a licence manifest, a version stamp, a
// sitemap. They do it from `generateBundle(options, bundle)` with
// `this.emitFile({ type: "asset", fileName, source })`. `viteEmitterPlugin(vitePlugin)` wraps
// such a plugin unchanged: at `denext build` / `denext export` it calls the hook with a
// Rollup-like `this` whose `emitFile` publishes through {@linkcode PluginBuildContext.emitFile},
// and a `bundle` holding one synthetic chunk whose `modules` are the client bundle's modules
// when the build knows them (`clientModules`), so a plugin that inspects the bundled modules
// sees them. What it does not provide: a chunk-type `emitFile`, a hashed asset named by `name`
// alone, the per-chunk breakdown of a real Rollup bundle, and every other Vite hook (transform,
// resolveId, configureServer, …) — `denext migrate` flags plugins that rely on those.

import type { DenextPlugin, PluginBuildContext } from "./mod.ts";
import { normalizeSpaAssetsDir } from "../server/config-validate.ts";

/** A Rollup `emitFile` argument (only `type: "asset"` with a `fileName` is supported). */
export interface ViteEmittedFile {
  /** `"asset"` (a `"chunk"` / `"prebuilt-chunk"` is refused). */
  type: string;
  /** Where the file is published, relative to the site root. */
  fileName?: string;
  /** Rollup's name-for-hashing (unsupported without a `fileName`). */
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
  /** Publish an asset at the site root; returns its reference (the `fileName`). */
  emitFile(file: ViteEmittedFile): string;
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
function syntheticBundle(build: PluginBuildContext): Record<string, unknown> {
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

/** The `this` a hook runs with, collecting the writes its `emitFile` calls start. */
function emitterContext(build: PluginBuildContext, writes: Promise<void>[]): ViteEmitterContext {
  return {
    emitFile(file) {
      if (file.type !== "asset") {
        throw new Error(
          `denext: a Vite plugin emitted a "${file.type}"; only type "asset" files are supported`,
        );
      }
      if (!file.fileName) {
        throw new Error("denext: a Vite plugin emitted an asset without a fileName (unsupported)");
      }
      writes.push(build.emitFile({ fileName: file.fileName, source: file.source ?? "" }));
      return file.fileName;
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
 * import { viteEmitterPlugin } from "denext/plugin-kit";
 * import { licensesPlugin } from "./scripts/licenses.ts";
 * export default { plugins: [viteEmitterPlugin(licensesPlugin({ out: "licenses.json" }))] };
 * ```
 *
 * @param vitePlugin The Vite plugin object (what its factory returns).
 * @returns A denext plugin named `vite:<name>`.
 */
export function viteEmitterPlugin(vitePlugin: VitePluginLike): DenextPlugin {
  const name = `vite:${vitePlugin.name ?? "anonymous"}`;
  return {
    name,
    setup(ctx) {
      const hook = vitePlugin.generateBundle;
      if (!hook || !appliesToBuild(vitePlugin.apply)) return;
      const fn = typeof hook === "function" ? hook : hook.handler;
      ctx.addBuildStep(async (build) => {
        const writes: Promise<void>[] = [];
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
