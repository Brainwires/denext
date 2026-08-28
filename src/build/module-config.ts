// Merged framework+app deno config for the CLI's module re-exec. When a project
// has its own deno.json that anchors module resolution to itself — a manual
// `node_modules` (file: shims / pinned deps) or a `npm:` import — a locally-run
// source `cli.ts` must re-exec with a config that resolves BOTH the framework's own
// imports (esbuild, @std/*, denext/*) and the app's npm deps, or a bare
// `import "drizzle-orm"` in an app server module is "not a dependency and not in
// import map". This module builds that config; cli.ts drives the re-exec.

import { dirname, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { denoExecutable, readFrameworkJson } from "./bundle.ts";

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
    if (!(value.startsWith("./") || value.startsWith("../"))) {
      out[key] = value;
      continue;
    }
    const abs = toFileUrl(resolve(dir, value)).href;
    // Preserve a trailing slash: a prefix mapping (`"denext/": "../src/"`) needs its
    // value to keep the trailing slash — Deno rejects a package-prefix target that
    // doesn't end with "/" (`resolve` normalizes it away).
    out[key] = value.endsWith("/") && !abs.endsWith("/") ? abs + "/" : abs;
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

/** Parse a leading `major[.minor[.patch]]` (partial ranges like `^3` → `[3,0,0]`). */
function semverTriple(v: string): [number, number, number] {
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

/** Whether `version` satisfies a caret/`~`/plain `range` (npm caret semantics). */
function satisfiesRange(version: string, range: string): boolean {
  const [rMaj, rMin, rPat] = semverTriple(range.replace(/^[\^~>=v ]+/, ""));
  const [maj, min, pat] = semverTriple(version);
  if (maj !== rMaj) return false;
  // `^0.x` locks the minor too; `~` locks the minor; otherwise any minor ≥ is fine.
  const lockMinor = rMaj === 0 || range.startsWith("~");
  if (lockMinor && min !== rMin) return false;
  if (min !== rMin) return min > rMin;
  return pat >= rPat;
}

/**
 * Rewrite `npm:name@<range>` specifiers to the exact versions resolved in the framework's
 * `deno.lock` (whose `npm` section keys are `name@version`), so the framework's build
 * machinery installs the tested versions rather than drifting to a newer in-range one.
 * For a name with several locked versions, picks the highest that satisfies the range;
 * a dep absent from the lock keeps its original range.
 */
function pinNpmToLock(
  npm: Record<string, string>,
  lock: Record<string, unknown>,
): Record<string, string> {
  const lockNpm = (lock.npm ?? {}) as Record<string, unknown>;
  const versionsByName = new Map<string, string[]>();
  for (const key of Object.keys(lockNpm)) {
    const at = key.lastIndexOf("@");
    if (at <= 0) continue; // scoped names keep their leading @
    const name = key.slice(0, at);
    (versionsByName.get(name) ?? versionsByName.set(name, []).get(name)!).push(key.slice(at + 1));
  }
  const out: Record<string, string> = {};
  for (const [k, spec] of Object.entries(npm)) {
    const body = spec.slice("npm:".length); // name@range
    const at = body.lastIndexOf("@");
    const name = at > 0 ? body.slice(0, at) : body;
    const range = at > 0 ? body.slice(at + 1) : "";
    const candidates = (versionsByName.get(name) ?? []).filter((v) => satisfiesRange(v, range));
    candidates.sort((a, b) => {
      const [aM, aMi, aP] = semverTriple(a), [bM, bMi, bP] = semverTriple(b);
      return aM - bM || aMi - bMi || aP - bP;
    });
    const pinned = candidates.at(-1);
    out[k] = pinned ? `npm:${name}@${pinned}` : spec;
  }
  return out;
}

/**
 * Materialize the framework's own npm build deps (esbuild, sass, lightningcss-wasm,
 * `@swc/wasm-web`, `@mdx-js/mdx`, ws) into `<outDir>/node_modules`. Returns `true`
 * once they are in place.
 *
 * Needed only when the re-exec runs under `nodeModulesDir: "manual"` (a converted
 * pnpm/yarn app): manual mode resolves **every** npm specifier — the framework's own
 * build machinery included — from the `node_modules` beside the `--config`, and the
 * app's `node_modules` carries only the app's deps, never denext's Deno-side ones. The
 * app's **own** npm deps still resolve correctly: Deno resolves each module's imports
 * against the config nearest it on disk, so an app route's `import "drizzle-orm"` binds
 * to the app's own manual `node_modules`. This helper only has to supply the framework
 * half — hence a **framework-only** dir here, not the app's `node_modules` (which lacks
 * esbuild and would fail the re-exec the moment the build loads `next-compat.ts`).
 *
 * Implementation: write an isolated synthetic project (`<outDir>/.fwdeps/deno.json`)
 * listing just the framework's `npm:` imports with `nodeModulesDir: "auto"`, run
 * `deno install` there (which builds a correct `.deno` layout + platform binaries out
 * of the global cache — no network when already cached), then symlink
 * `<outDir>/node_modules` at it. Idempotent: an install whose dep set is unchanged is
 * reused, so only the first manual-mode build of a given app pays the install cost.
 *
 * @param outDir The project's `.denext` output dir (holds the merged `--config`).
 */
export async function ensureFrameworkNodeModules(outDir: string): Promise<boolean> {
  const cfg = await readFrameworkJson("deno.json");
  const imports = (cfg.imports ?? {}) as Record<string, string>;
  const npm: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) {
    if (v.startsWith("npm:")) npm[k] = v;
  }
  if (Object.keys(npm).length === 0) return false;

  // Pin to the framework's own resolved versions (from its deno.lock) instead of the
  // caret ranges, so this build machinery can't resolve a different, newer-in-range (or
  // maliciously published) version than the framework was tested against. Falls back to
  // the range for any dep the lock doesn't cover.
  const pinned = pinNpmToLock(npm, await readFrameworkJson("deno.lock"));

  const fwDir = join(outDir, ".fwdeps");
  const nm = join(fwDir, "node_modules");
  // A synthetic project carrying ONLY the framework's npm deps. `auto` lets Deno
  // build the node_modules from the global cache; being isolated in its own dir, its
  // resolution never walks up into the app's `package.json` (catalog:/workspace: refs
  // Deno cannot parse).
  const denoJson = JSON.stringify({ nodeModulesDir: "auto", imports: pinned }, null, 2);
  const stamp = join(fwDir, ".deps.json");

  // Reuse a prior install when the (exact-pinned) dep set is byte-identical AND the
  // install actually completed — check for a materialized package, not just that the dir
  // exists, so a partial/interrupted install is re-run rather than trusted.
  let cached = false;
  try {
    cached = (await Deno.readTextFile(stamp)) === denoJson &&
      (await Deno.stat(join(nm, ".deno"))).isDirectory;
  } catch { /* first run / stale / partial / removed */ }

  if (!cached) {
    await ensureDir(fwDir);
    await Deno.writeTextFile(join(fwDir, "deno.json"), denoJson);
    const { code, stderr } = await new Deno.Command(denoExecutable(), {
      args: ["install", "--quiet"],
      cwd: fwDir,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code !== 0) {
      console.error(
        "denext: could not materialize the framework's build deps (esbuild/sass/…) " +
          "for a manual-`node_modules` app; the build may fail to resolve them.\n" +
          new TextDecoder().decode(stderr),
      );
      return false;
    }
    // Only stamp after a clean install so a failed run re-installs next time.
    await Deno.writeTextFile(stamp, denoJson);
  }

  // Symlink <outDir>/node_modules -> <outDir>/.fwdeps/node_modules. Remove any existing
  // entry first (unlinking the symlink itself, not following it — the same guard used
  // for the merged config below), then point manual-mode resolution at the fw deps.
  const link = join(outDir, "node_modules");
  try {
    await Deno.remove(link);
  } catch { /* absent */ }
  try {
    await Deno.symlink(nm, link);
  } catch (err) {
    // A missing link leaves the framework's build deps unresolvable under manual mode,
    // which then fails later with a cryptic "npm:esbuild not found". Symlinks commonly
    // fail on Windows without Developer Mode / elevation — surface that clearly here.
    console.error(
      `denext: could not link the framework's build deps into ${link} ` +
        `(${err instanceof Error ? err.message : err}). On Windows, enable Developer ` +
        `Mode or run elevated so Deno can create symlinks; the build may otherwise fail ` +
        `to resolve esbuild/sass/….`,
    );
    return false;
  }
  return true;
}

/**
 * Write the merged framework+app config into `outDir` and return its path. A manual
 * `node_modules` app additionally needs the framework's own build deps beside this
 * config (a manual dir is anchored to the config file's own directory) — the CLI
 * re-exec supplies those via {@link ensureFrameworkNodeModules}, kept separate so this
 * stays a pure, network-free config writer.
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
  // Manual mode needs the framework's own npm build deps (esbuild, …) beside this
  // config — the app's tree does not carry them. The install itself is driven by the
  // CLI re-exec (see {@link ensureFrameworkNodeModules}), kept out of this pure config
  // writer so it stays network-free and unit-testable.
  return configPath;
}
