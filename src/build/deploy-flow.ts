// The deploy step of the CLI: after `denext build` (and `--compile`), write the deploy manifest
// and run the configured adapter's `prepare`; `denext deploy prepare` runs that on its own, and
// `denext deploy` then runs the adapter's `deploy`.
//
// Build-time only; never imported by a shipped bundle.

import { relative } from "@std/path";
import type { DeployAdapter } from "../deploy/adapter.ts";
import type { DeployCompile, DeployManifest } from "../deploy/manifest.ts";
import type { CompileAppResult } from "./compile-app.ts";
import { readDeployManifest, writeDeployManifest } from "./deploy-manifest.ts";
import {
  type DeployContextOptions,
  resolveDeployAdapter,
  runDeployPrepare,
  runDeployPush,
} from "./deploy-run.ts";
import { type ProjectPaths, resolveProject } from "./paths.ts";
import { setupPlugins } from "./pipeline-shared.ts";

/** What a deploy run is asked to do. */
export interface DeployFlowOptions {
  /** A preset name (`--preset`), instead of the configured adapter. */
  readonly preset?: string;
  /** Write and run nothing (`--dry-run`). */
  readonly dryRun?: boolean;
  /** Replace hand-edited project files too (`--force`). */
  readonly force?: boolean;
  /** The `--compile` output of the build this follows. */
  readonly compile?: CompileAppResult & { target?: string };
  /** Collect the manifest again (after a build) instead of reading the last one. */
  readonly refresh?: boolean;
}

/** The manifest's view of a `--compile` result. */
function compileOf(
  paths: ProjectPaths,
  compile: DeployFlowOptions["compile"],
): DeployCompile | null {
  if (!compile) return null;
  return {
    output: relative(paths.projectDir, compile.output).replaceAll("\\", "/"),
    ...(compile.target ? { target: compile.target } : {}),
    permissions: compile.permissions,
  };
}

/** The manifest: collected now (after a build), else the last build's, else collected now. */
async function manifestFor(
  paths: ProjectPaths,
  options: DeployFlowOptions,
): Promise<DeployManifest> {
  if (!options.refresh) {
    const last = await readDeployManifest(paths.outDir);
    if (last) return last;
    console.log("  no deploy manifest from a build yet — collecting one from the sources");
  }
  return await writeDeployManifest(paths, { compile: compileOf(paths, options.compile) });
}

/** What {@linkcode loadDeploy} resolved. */
export interface LoadedDeploy {
  readonly paths: ProjectPaths;
  readonly manifest: DeployManifest;
  readonly adapter: DeployAdapter | null;
}

/**
 * Resolve the project, its plugins' adapters, the manifest and the adapter to run.
 *
 * @param dir The project directory.
 * @param options The run's switches.
 * @returns The project, the manifest and the adapter (`null`: none configured).
 */
async function loadDeploy(dir: string, options: DeployFlowOptions): Promise<LoadedDeploy> {
  const paths = await resolveProject(dir);
  await setupPlugins(paths, "build");
  const manifest = await manifestFor(paths, options);
  return { paths, manifest, adapter: resolveDeployAdapter(paths, options.preset) };
}

/** The context options for an adapter run. */
function contextOptions(
  loaded: LoadedDeploy & { adapter: DeployAdapter },
  options: DeployFlowOptions,
): DeployContextOptions {
  return {
    paths: loaded.paths,
    manifest: loaded.manifest,
    adapter: loaded.adapter,
    dryRun: options.dryRun,
    force: options.force,
    exportStatic: async () => {
      const { staticExport } = await import("./export.ts");
      return (await staticExport(loaded.paths.projectDir)).outDir;
    },
  };
}

/**
 * After `denext build`: write the deploy manifest and run the configured adapter's `prepare`
 * (nothing more when no adapter is configured).
 *
 * @param dir The project directory.
 * @param compile The `--compile` output, when there was one.
 */
export async function deployAfterBuild(
  dir: string,
  compile?: DeployFlowOptions["compile"],
): Promise<void> {
  const loaded = await loadDeploy(dir, { refresh: true, compile });
  if (!loaded.adapter) return;
  await runDeployPrepare(contextOptions({ ...loaded, adapter: loaded.adapter }, {}));
}

/**
 * `denext deploy prepare` (and the first half of `denext deploy`): run the adapter's `prepare`.
 *
 * @param dir The project directory.
 * @param options The run's switches.
 * @returns The loaded project and adapter (for a following push).
 * @throws When no adapter is configured.
 */
export async function deployPrepare(
  dir: string,
  options: DeployFlowOptions,
): Promise<LoadedDeploy & { adapter: DeployAdapter }> {
  const loaded = await loadDeploy(dir, options);
  if (!loaded.adapter) {
    throw new Error(
      "denext: no deploy adapter — set `deploy: { adapter }` in denext.config.ts (presets in " +
        "denext/deploy) or pass --preset docker | fly | deno-deploy | generic-host | static",
    );
  }
  const withAdapter = { ...loaded, adapter: loaded.adapter };
  await runDeployPrepare(contextOptions(withAdapter, options));
  return withAdapter;
}

/**
 * `denext deploy`: prepare, then run the adapter's `deploy` step.
 *
 * @param dir The project directory.
 * @param options The run's switches.
 */
export async function deployPush(dir: string, options: DeployFlowOptions): Promise<void> {
  const loaded = await deployPrepare(dir, options);
  await runDeployPush(contextOptions(loaded, options));
}
