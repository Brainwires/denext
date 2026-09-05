// Merged framework+app deno config for the CLI's module re-exec. When a project
// has its own deno.json that anchors module resolution to itself — a manual
// `node_modules` (file: shims / pinned deps) or a `npm:` import — a locally-run
// source `cli.ts` must re-exec with a config that resolves BOTH the framework's own
// imports (esbuild, @std/*, denext/*) and the app's npm deps, or a bare
// `import "drizzle-orm"` in an app server module is "not a dependency and not in
// import map". This module builds that config; cli.ts drives the re-exec.

import { dirname, join, resolve, toFileUrl } from "@std/path";
import { ensureDir } from "@std/fs";
import { parse as parseJsonc } from "@std/jsonc";
import { denoExecutable, minDepAgeConfig, readFrameworkJson } from "./bundle.ts";

/** A minimal view of a deno config's fields relevant to module resolution. */
export interface DenoConfigView {
  /** The `nodeModulesDir` setting (e.g. "auto" | "manual" | "none"), if any. */
  nodeModulesDir?: unknown;
  /** The app's own minimum-dependency-age policy, if any (propagated to the merged config). */
  minimumDependencyAge?: unknown;
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

/**
 * Parse a deno config file. A missing file is `{}` (an app need not have its own
 * deno.json). A present-but-malformed file is `{}` too — but with a stderr warning
 * rather than silence, since a dropped import map surfaces later as a cryptic "not in
 * import map". Parses as **JSONC** (deno.json permits comments/trailing commas), so a
 * commented deno.json no longer loses its imports.
 */
export async function readConfig(configPath: string): Promise<DenoConfigView> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch {
    return {}; // absent — expected
  }
  try {
    return (parseJsonc(text) ?? {}) as DenoConfigView;
  } catch (err) {
    console.warn(
      `denext: could not parse ${configPath} (${err instanceof Error ? err.message : err}); ` +
        "its import map / settings will be ignored. Fix the JSON to restore them.",
    );
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
  Object.assign(merged, minDepAgeConfig(appCfg.minimumDependencyAge));
  return merged;
}

/** Parse a leading `major[.minor[.patch]]` (partial ranges like `^3` → `[3,0,0]`). */
function semverTriple(v: string): [number, number, number] {
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

/** Whether `version` satisfies a caret/`~`/plain `range` (npm caret semantics). */
export function satisfiesRange(version: string, range: string): boolean {
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
export function pinNpmToLock(
  npm: Record<string, string>,
  lock: Record<string, unknown>,
): Record<string, string> {
  const versionsByName = lockedNpmVersions(lock);
  const out: Record<string, string> = {};
  for (const [k, spec] of Object.entries(npm)) {
    const { name, range } = splitNameRange(spec.slice("npm:".length));
    const pinned = highestSatisfying(versionsByName.get(name) ?? [], range);
    out[k] = pinned ? `npm:${name}@${pinned}` : spec;
  }
  return out;
}

/** The lock's `npm` section (`name@version` keys) indexed by package name. */
function lockedNpmVersions(lock: Record<string, unknown>): Map<string, string[]> {
  const lockNpm = (lock.npm ?? {}) as Record<string, unknown>;
  const versionsByName = new Map<string, string[]>();
  for (const key of Object.keys(lockNpm)) {
    const at = key.lastIndexOf("@");
    if (at <= 0) continue; // scoped names keep their leading @
    const name = key.slice(0, at);
    (versionsByName.get(name) ?? versionsByName.set(name, []).get(name)!).push(key.slice(at + 1));
  }
  return versionsByName;
}

/** `name@range` → its parts (a bare `name` has an empty range). */
function splitNameRange(body: string): { name: string; range: string } {
  const at = body.lastIndexOf("@");
  return at > 0
    ? { name: body.slice(0, at), range: body.slice(at + 1) }
    : { name: body, range: "" };
}

/** The highest of `versions` satisfying `range`, or undefined. */
function highestSatisfying(versions: string[], range: string): string | undefined {
  const candidates = versions.filter((v) => satisfiesRange(v, range));
  candidates.sort((a, b) => {
    const [aM, aMi, aP] = semverTriple(a), [bM, bMi, bP] = semverTriple(b);
    return aM - bM || aMi - bMi || aP - bP;
  });
  return candidates.at(-1);
}

/**
 * Serialize the `.fwdeps` install across concurrent builds sharing one app's `.denext`
 * (a `dev` + a `build`, or parallel CI tasks) so they don't run `deno install` into the
 * same directory at once and corrupt it. Acquires an exclusive lock file; while another
 * build holds it, waits — re-checking `isCached` so a build that lost the race skips the
 * install entirely once the winner finishes. Steals a lock older than the stale timeout
 * (a crashed holder). Returns `true` if THIS caller acquired the lock (must install, then
 * release), `false` if a concurrent build already completed the install.
 *
 * @param lockPath The lock file (inside `.fwdeps`).
 * @param isCached Re-checks whether the install is complete (stamp + `node_modules/.deno`).
 */
export async function acquireFwdepsInstall(
  lockPath: string,
  isCached: () => Promise<boolean>,
): Promise<boolean> {
  const STALE_MS = 120_000; // a crashed holder's lock becomes stealable after this
  while (true) {
    if (await isCached()) return false; // a concurrent build finished it — skip the install
    try {
      (await Deno.open(lockPath, { createNew: true, write: true })).close();
      return true; // we hold the lock — install, then release
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    }
    // Held by another build. Steal it if stale (the holder crashed mid-install).
    try {
      const st = await Deno.stat(lockPath);
      const age = st.mtime ? Date.now() - st.mtime.getTime() : Number.POSITIVE_INFINITY;
      if (age > STALE_MS) {
        await Deno.remove(lockPath).catch(() => {});
        continue;
      }
    } catch { /* lock vanished (holder released) — loop re-checks the cache */ }
    await new Promise((r) => setTimeout(r, 250));
  }
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
  const npm = await frameworkNpmImports();
  if (Object.keys(npm).length === 0) return false;
  // Pin to the framework's own resolved versions (from its deno.lock) instead of the
  // caret ranges, so this build machinery can't resolve a different, newer-in-range (or
  // maliciously published) version than the framework was tested against. Falls back to
  // the range for any dep the lock doesn't cover.
  const pinned = pinNpmToLock(npm, await readFrameworkJson("deno.lock"));
  const fwDir = join(outDir, ".fwdeps");
  const nm = join(fwDir, "node_modules");
  // A synthetic project carrying ONLY the framework's npm deps. `auto` lets Deno build the
  // node_modules from the global cache; being isolated in its own dir, its resolution
  // never walks up into the app's `package.json` (catalog:/workspace: refs Deno cannot parse).
  const denoJson = JSON.stringify({ nodeModulesDir: "auto", imports: pinned }, null, 2);
  if (!(await installFwdeps(fwDir, nm, denoJson))) return false;
  return await linkFrameworkNodeModules(outDir, nm);
}

/** The framework's own `npm:` imports (its `deno.json` import map). */
async function frameworkNpmImports(): Promise<Record<string, string>> {
  const cfg = await readFrameworkJson("deno.json");
  const imports = (cfg.imports ?? {}) as Record<string, string>;
  const npm: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) if (v.startsWith("npm:")) npm[k] = v;
  return npm;
}

/**
 * Run `deno install` in the synthetic `.fwdeps` project unless a prior install with the
 * byte-identical (exact-pinned) dep set completed — checked against a materialized
 * package, not just the dir, so a partial/interrupted install is re-run rather than
 * trusted. Serialized across concurrent builds ({@link acquireFwdepsInstall}); only
 * stamped after a clean install so a failed run re-installs next time.
 */
async function installFwdeps(fwDir: string, nm: string, denoJson: string): Promise<boolean> {
  const stamp = join(fwDir, ".deps.json");
  const isCached = async (): Promise<boolean> => {
    try {
      return (await Deno.readTextFile(stamp)) === denoJson &&
        (await Deno.stat(join(nm, ".deno"))).isDirectory;
    } catch {
      return false; // first run / stale / partial / removed
    }
  };
  if (await isCached()) return true;
  await ensureDir(fwDir);
  const lockPath = join(fwDir, ".install.lock");
  // A concurrent build may complete the install while we wait — then the cache is ready.
  if (!(await acquireFwdepsInstall(lockPath, isCached))) return true;
  try {
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
    await Deno.writeTextFile(stamp, denoJson);
    return true;
  } finally {
    await Deno.remove(lockPath).catch(() => {});
  }
}

/**
 * Symlink `<outDir>/node_modules` → `<outDir>/.fwdeps/node_modules`. Removes any existing
 * entry first (unlinking the symlink itself, not following it), then points manual-mode
 * resolution at the framework deps. A missing link leaves the framework's build deps
 * unresolvable under manual mode, which then fails later with a cryptic "npm:esbuild not
 * found" — symlinks commonly fail on Windows without Developer Mode / elevation, so that
 * is surfaced clearly here.
 */
async function linkFrameworkNodeModules(outDir: string, nm: string): Promise<boolean> {
  const link = join(outDir, "node_modules");
  await Deno.remove(link).catch(() => {});
  try {
    await Deno.symlink(nm, link);
    return true;
  } catch (err) {
    console.error(
      `denext: could not link the framework's build deps into ${link} ` +
        `(${err instanceof Error ? err.message : err}). On Windows, enable Developer ` +
        `Mode or run elevated so Deno can create symlinks; the build may otherwise fail ` +
        `to resolve esbuild/sass/….`,
    );
    return false;
  }
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
