// `denext desktop add sidecar --name <name> (--entry <module> [--node-modules <dir>] | --exec
// <program>) [--ready <path>] [--proxy]`: append a sidecar to `desktop.sidecars` in
// denext.config.ts (the comment-preserving config splice `desktop add` uses for capabilities).
//
// A Node backend (`--node-modules`) whose node_modules holds a native addon also gets
// `permissions: { ffi: ["*"] }`: the packaged app loads the addon from its embedded files.

import { basename, join, resolve } from "@std/path";
import { CONFIG_FILES } from "./paths.ts";
import { readConfigModel, setConfigValue } from "./config-edit.ts";
import { createUnifiedDiff } from "./patch-diff.ts";
import { sidecarDefinitionError, sidecarListError } from "../desktop/sidecar.ts";

/** Options for {@linkcode addDesktopSidecar}. */
export interface AddDesktopSidecarOptions {
  /** The project directory. */
  readonly dir: string;
  /** The sidecar's name. */
  readonly name: string;
  /** A module to run in the app's runtime (relative to the project). */
  readonly entry?: string;
  /** The module's `node_modules` (a Node backend, bundled at packaging). */
  readonly nodeModules?: string;
  /** A program to spawn instead of a module. */
  readonly exec?: string;
  /** A path polled on its port until it answers 2xx (`/health`). */
  readonly ready?: string;
  /** Point `spa.proxy` at it. */
  readonly proxy?: boolean;
  /** Plan only. */
  readonly dryRun?: boolean;
}

/** What {@linkcode addDesktopSidecar} did (or would do). */
export interface AddDesktopSidecarReport {
  /** The config file. */
  readonly configPath: string;
  /** The sidecar written. */
  readonly sidecar: Record<string, unknown>;
  /** The config diff. */
  readonly diff: string;
  /** Native addon packages found in `nodeModules` (they made it ask for `ffi`). */
  readonly natives: readonly string[];
  /** What to do next. */
  readonly notes: readonly string[];
}

/** The bundler's module, imported by a computed specifier: esbuild stays out of the CLI's graph. */
const BUNDLER = "./desktop-sidecar-bundle.ts";

/** The native addon packages directly in `nodeModules`. */
async function nativePackages(nodeModules: string): Promise<string[]> {
  // Typed locally: even a type-only reference would put esbuild in the CLI's module graph.
  const bundler = await import(new URL(BUNDLER, import.meta.url).href) as {
    installedPackages(dir: string): Promise<Array<[string, string]>>;
    isNativePackage(root: string): Promise<boolean>;
  };
  const natives: string[] = [];
  for (const [name, dir] of await bundler.installedPackages(nodeModules)) {
    if (await bundler.isNativePackage(dir)) natives.push(name);
  }
  return natives.sort();
}

/** The `desktop.sidecars` entry the options describe. */
function sidecarEntry(opts: AddDesktopSidecarOptions, natives: readonly string[]) {
  const run = opts.exec !== undefined
    ? { exec: opts.exec }
    : { module: opts.entry, ...(opts.nodeModules ? { nodeModules: opts.nodeModules } : {}) };
  return {
    name: opts.name,
    run,
    port: "auto",
    ...(opts.ready ? { ready: { http: opts.ready } } : {}),
    ...(opts.proxy ? { proxy: true } : {}),
    ...(natives.length > 0 ? { permissions: { ffi: ["*"] } } : {}),
  } as Record<string, unknown>;
}

/** The project's config file, if it has one. */
async function findConfigFile(dir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILES) {
    if (await Deno.stat(join(dir, name)).then(() => true, () => false)) return join(dir, name);
  }
  return undefined;
}

/** `source` with `sidecar` appended to `desktop.sidecars`; throws with the by-hand entry. */
async function spliceSidecar(
  source: string,
  sidecar: Record<string, unknown>,
  configPath: string,
): Promise<string> {
  const byHand = `Add by hand to desktop.sidecars:\n${JSON.stringify(sidecar, null, 2)}`;
  const desktop = (await readConfigModel(source)).keys.desktop;
  if (desktop && desktop.kind !== "editable") {
    throw new Error(`cannot edit ${configPath} (its desktop value is code). ${byHand}`);
  }
  const current = (desktop?.value as { sidecars?: unknown } | undefined)?.sidecars;
  const list = [...(Array.isArray(current) ? current : []), sidecar];
  const listProblem = sidecarListError(list);
  if (listProblem) throw new Error(`desktop.sidecars${listProblem}`);
  const edit = await setConfigValue(source, ["desktop", "sidecars"], list);
  if (!edit.ok) throw new Error(`cannot edit ${configPath}: ${edit.reason}\n  ${byHand}`);
  return edit.source;
}

/** What to tell the user after the edit. */
function sidecarNotes(opts: AddDesktopSidecarOptions, natives: readonly string[]): string[] {
  const notes = [
    opts.exec !== undefined
      ? "the program gets PORT and one JSON line on stdin ({name, port, bootstrap, secrets}); exit when stdin closes"
      : "the module runs in a worker of the app: read globalThis.denextSidecar (port, bootstrap, secrets, ready())",
  ];
  if (opts.nodeModules) {
    notes.push(`denext desktop run / package bundle it into .deno-desktop/sidecars/${opts.name}`);
  }
  if (natives.length > 0) {
    notes.push(
      `native addons (${natives.join(", ")}): permissions.ffi ["*"] is baked into the package`,
    );
  }
  if (opts.proxy) notes.push("proxy: set spa.proxy.prefixes to the paths the page sends to it");
  return notes;
}

/**
 * Append a sidecar to `desktop.sidecars` (creating the config when there is none).
 *
 * @param opts The sidecar and the project.
 * @returns What changed. Throws for an invalid sidecar, a name already used, or a config whose
 * `desktop` is code rather than data (the message then carries the entry to add by hand).
 */
export async function addDesktopSidecar(
  opts: AddDesktopSidecarOptions,
): Promise<AddDesktopSidecarReport> {
  if ((opts.entry === undefined) === (opts.exec === undefined)) {
    throw new Error("give the sidecar --entry <module> or --exec <program> (one of them)");
  }
  const dir = resolve(opts.dir);
  const natives = opts.nodeModules ? await nativePackages(resolve(dir, opts.nodeModules)) : [];
  const sidecar = sidecarEntry(opts, natives);
  const problem = sidecarDefinitionError(sidecar);
  if (problem) throw new Error(`invalid sidecar: ${problem}`);
  const existing = await findConfigFile(dir);
  const configPath = existing ?? join(dir, "denext.config.ts");
  const before = existing ? await Deno.readTextFile(existing) : "export default {};\n";
  const source = await spliceSidecar(before, sidecar, configPath);
  const label = basename(configPath);
  const diff = createUnifiedDiff(existing ? before : "", source, `a/${label}`, `b/${label}`);
  if (!opts.dryRun) await Deno.writeTextFile(configPath, source);
  return { configPath, sidecar, diff, natives, notes: sidecarNotes(opts, natives) };
}
