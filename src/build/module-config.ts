// Merged framework+app deno config for the CLI's module re-exec. When a project
// has its own deno.json that anchors module resolution to itself — a manual
// `node_modules` (file: shims / pinned deps) or a `npm:` import — a locally-run
// source `cli.ts` must re-exec with a config that resolves BOTH the framework's own
// imports (esbuild, @std/*, denext/*) and the app's npm deps, or a bare
// `import "drizzle-orm"` in an app server module is "not a dependency and not in
// import map". This module builds that config; cli.ts drives the re-exec.

import { dirname, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";

/** A minimal view of a deno config's fields relevant to module resolution. */
export interface DenoConfigView {
  /** The `nodeModulesDir` setting (e.g. "auto" | "manual" | "none"), if any. */
  nodeModulesDir?: unknown;
  /** The import map. */
  imports?: Record<string, string>;
  /** Compiler options passed through to the merged config. */
  compilerOptions?: unknown;
}

/**
 * Whether `appCfg` anchors module resolution to itself and so needs the merged
 * config: a **manual** `node_modules`, or any `npm:` import in its map. A plain
 * project (relative/jsr imports, `nodeModulesDir: "auto"` or unset) does NOT — Deno
 * resolves it under the framework config unchanged.
 *
 * @param appCfg The app's parsed deno config.
 */
export function configAnchorsResolution(appCfg: DenoConfigView): boolean {
  if (appCfg.nodeModulesDir === "manual") return true;
  return Object.values(appCfg.imports ?? {}).some((v) => String(v).startsWith("npm:"));
}

/** Parse a deno config file, returning `{}` for a missing/invalid/JSONC file. */
export async function readConfig(configPath: string): Promise<DenoConfigView> {
  try {
    return JSON.parse(await Deno.readTextFile(configPath)) as DenoConfigView;
  } catch {
    return {};
  }
}

/** Read a config's `imports`, resolving relative values to absolute `file:` URLs. */
export async function readImportsAbsolute(configPath: string): Promise<Record<string, string>> {
  const cfg = await readConfig(configPath);
  const dir = dirname(configPath);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg.imports ?? {})) {
    out[key] = value.startsWith("./") || value.startsWith("../")
      ? toFileUrl(resolve(dir, value)).href
      : value;
  }
  return out;
}

/**
 * Merge framework + app imports (app wins on overlap) into a deno config object,
 * carrying the app's `compilerOptions` and a non-"none" `nodeModulesDir` through.
 * Pure — no IO — so the precedence/passthrough rules are unit-testable.
 *
 * @param frameworkImports The framework's absolutized import map.
 * @param appImports The app's absolutized import map.
 * @param appCfg The app's parsed config (for compilerOptions + nodeModulesDir).
 */
export function mergeModuleConfig(
  frameworkImports: Record<string, string>,
  appImports: Record<string, string>,
  appCfg: DenoConfigView,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    compilerOptions: appCfg.compilerOptions,
    imports: { ...frameworkImports, ...appImports },
  };
  const nmd = appCfg.nodeModulesDir;
  if (nmd && nmd !== "none" && nmd !== false) merged.nodeModulesDir = nmd;
  return merged;
}

/**
 * Write the merged framework+app config into `outDir` and (for a manual
 * `node_modules`) link the project's real `node_modules` in beside it, since a
 * manual dir is anchored to the config file's own directory. Returns the config path.
 *
 * @param outDir The project's `.denext` output dir.
 * @param appConfigPath The app's own `deno.json`.
 * @param frameworkConfigPath The framework's `deno.json`.
 */
export async function writeMergedModuleConfig(
  outDir: string,
  appConfigPath: string,
  frameworkConfigPath: string,
): Promise<string> {
  const appCfg = await readConfig(appConfigPath);
  const merged = mergeModuleConfig(
    await readImportsAbsolute(frameworkConfigPath),
    await readImportsAbsolute(appConfigPath),
    appCfg,
  );
  await ensureDir(outDir);
  const configPath = join(outDir, "module-config.json");
  // Remove any pre-existing entry before writing: Deno.writeTextFile follows a
  // symlink and truncates its target, so a symlink planted at this predictable
  // path (e.g. on a shared host) could otherwise be used to clobber an arbitrary
  // file. Deno.remove unlinks the symlink itself rather than following it. Mirrors
  // the remove-then-create used for the node_modules link below.
  await Deno.remove(configPath).catch(() => {});
  await Deno.writeTextFile(configPath, JSON.stringify(merged, null, 2));
  if (merged.nodeModulesDir === "manual") {
    const link = join(outDir, "node_modules");
    try {
      await Deno.remove(link);
    } catch { /* absent */ }
    try {
      await Deno.symlink(join(dirname(outDir), "node_modules"), link);
    } catch { /* best effort — a missing link only breaks manual-mode resolution */ }
  }
  return configPath;
}
