// Run a deploy adapter (src/deploy/adapter.ts): pick it (`--preset`, the config's
// `deploy.adapter`, or one a plugin contributed), build its context — file writes that never
// clobber a hand-edited project file, the environment for credentials, a terminal-attached
// `run`, `denext export` — and call its `prepare` (after `denext build`, and from
// `denext deploy prepare`) or its `deploy` (`denext deploy` only).
//
// Build-time only; never imported by a shipped bundle.

import { DELIMITER, dirname, isAbsolute, join } from "@std/path";
import type { DeployAdapter, DeployContext, DeployWriteOptions } from "../deploy/adapter.ts";
import type { DeployManifest } from "../deploy/manifest.ts";
import { PRESET_NAMES, presetAdapter } from "../deploy/presets.ts";
import { getPluginDeployAdapters } from "../plugin/mod.ts";
import type { ProjectPaths } from "./paths.ts";

/** Where every adapter's output goes, under the build directory. */
const DEPLOY_DIR = "deploy";

/**
 * The adapter to run: a named preset (`--preset`, with its default options), else the config's
 * `deploy.adapter`, else the first one a plugin contributed; `null` when none is configured.
 *
 * @param paths The resolved project.
 * @param preset A preset name from `--preset`.
 * @returns The adapter, or `null`.
 * @throws When `preset` names no preset.
 */
export function resolveDeployAdapter(paths: ProjectPaths, preset?: string): DeployAdapter | null {
  if (preset !== undefined) {
    const adapter = presetAdapter(preset);
    if (!adapter) {
      throw new Error(
        `denext: unknown deploy preset "${preset}" (expected: ${PRESET_NAMES.join(", ")})`,
      );
    }
    return adapter;
  }
  return paths.config?.deploy?.adapter ?? getPluginDeployAdapters()[0] ?? null;
}

/** Refuse a write path that could leave its root. */
function safeRelative(path: string): string[] {
  const segments = path.split("/");
  if (
    path === "" || path.includes("\\") || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(
      `denext: a deploy adapter may only write relative, /-separated paths (got ${
        JSON.stringify(path)
      })`,
    );
  }
  return segments;
}

/** Whether `path` is a regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The first of `names` on `PATH` (with Windows' executable extensions), or `null`. */
async function which(names: readonly string[]): Promise<string | null> {
  const dirs = (Deno.env.get("PATH") ?? "").split(DELIMITER).filter(Boolean);
  const exts = Deno.build.os === "windows" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const candidates = names.flatMap((name) =>
    dirs.flatMap((dir) => exts.map((ext) => join(dir, name + ext)))
  );
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return null;
}

/** Options for {@linkcode createDeployContext}. */
export interface DeployContextOptions {
  /** The resolved project. */
  readonly paths: ProjectPaths;
  /** The manifest. */
  readonly manifest: DeployManifest;
  /** The adapter (its name picks the output directory). */
  readonly adapter: DeployAdapter;
  /** Write and run nothing. */
  readonly dryRun?: boolean;
  /** Replace hand-edited project files too. */
  readonly force?: boolean;
  /** Runs `denext export` (the CLI passes the real one). */
  readonly exportStatic?: () => Promise<string>;
  /** Where progress goes (default `console.log`). */
  readonly log?: (line: string) => void;
}

/** Write one generated project file unless a hand-edited one is there. */
async function writeProjectFile(
  target: string,
  contents: string,
  marker: string | undefined,
  options: DeployContextOptions,
  warn: (m: string) => void,
): Promise<boolean> {
  if (!marker) throw new Error("denext: a deploy adapter's project file needs a marker");
  let existing: string | undefined;
  try {
    existing = await Deno.readTextFile(target);
  } catch { /* absent */ }
  if (existing === contents) return false;
  if (existing !== undefined && !existing.includes(marker) && !options.force) {
    warn(`left ${target} alone: it was not generated (or was edited); --force replaces it`);
    return false;
  }
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.writeTextFile(target, contents);
  return true;
}

/**
 * The context an adapter's `prepare` / `deploy` receives.
 *
 * @param options The project, the manifest, the adapter and the switches.
 * @returns The context.
 */
export function createDeployContext(options: DeployContextOptions): DeployContext {
  const { paths, adapter } = options;
  // The name is a directory under the build's deploy/, emptied before each prepare.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(adapter.name) || adapter.name.includes("..")) {
    throw new Error(
      `denext: a deploy adapter's name must be letters, digits and ._- (got ${
        JSON.stringify(adapter.name)
      })`,
    );
  }
  const dryRun = options.dryRun === true;
  const out = options.log ?? ((line: string) => console.log(line));
  const log = (m: string) => out(`  ${m}`);
  const warn = (m: string) => out(`  warning: ${m}`);
  const outDir = join(paths.outDir, DEPLOY_DIR, adapter.name);
  return {
    manifest: options.manifest,
    projectDir: paths.projectDir,
    outDir,
    dryRun,
    log,
    warn,
    env: (name) => Deno.env.get(name),
    which: (...names) => which(names),
    writeFile: async (path: string, contents: string, opts: DeployWriteOptions = {}) => {
      const root = opts.in === "project" ? paths.projectDir : outDir;
      const target = join(root, ...safeRelative(path));
      if (dryRun) {
        log(`would write ${target}`);
        return false;
      }
      if (opts.in === "project") {
        const wrote = await writeProjectFile(target, contents, opts.marker, options, warn);
        if (wrote) log(`wrote ${target}`);
        return wrote;
      }
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeTextFile(target, contents);
      log(`wrote ${target}`);
      return true;
    },
    run: async (command, runOptions = {}) => {
      log(`$ ${command.join(" ")}`);
      if (dryRun) return 0;
      const child = new Deno.Command(command[0], {
        args: command.slice(1),
        cwd: runOptions.cwd ?? paths.projectDir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      return (await child.status).code;
    },
    exportStatic: () => {
      if (!options.exportStatic) {
        throw new Error("denext: this deploy run cannot export (no export step was given)");
      }
      return options.exportStatic();
    },
  };
}

/**
 * Run an adapter's `prepare`, emptying its output directory first (so a file it no longer writes
 * does not linger).
 *
 * @param options The project, the manifest, the adapter and the switches.
 */
export async function runDeployPrepare(options: DeployContextOptions): Promise<void> {
  const context = createDeployContext(options);
  if (!context.dryRun) await Deno.remove(context.outDir, { recursive: true }).catch(() => {});
  context.log(`deploy: ${options.adapter.name}${context.dryRun ? " (dry run)" : ""}`);
  await options.adapter.prepare(context);
}

/**
 * Run an adapter's `deploy` step.
 *
 * @param options The project, the manifest, the adapter and the switches.
 * @throws When the adapter has no deploy step.
 */
export async function runDeployPush(options: DeployContextOptions): Promise<void> {
  const { adapter } = options;
  if (!adapter.deploy) {
    throw new Error(
      `denext: the ${adapter.name} adapter has no deploy step — its output is in ` +
        `${
          join(options.paths.outDir, DEPLOY_DIR, adapter.name)
        } (see https://denext.dev/docs/deploy#deploy-adapters)`,
    );
  }
  await adapter.deploy(createDeployContext(options));
}
