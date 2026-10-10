// Packaging for `desktop.sidecars`: a Node backend sidecar (`run: { module, nodeModules }`) is
// bundled into `.deno-desktop/sidecars/<name>/main.mjs`, which the package scripts embed into the
// app (`--include`) and the runtime runs in a worker.
//
// Why a bundle: a module the app loads at run time resolves bare imports through the app's own
// resolver, which knows the app's deno.json, not the backend's `node_modules` (a worker shares the
// process's resolver). So every npm import is inlined, except packages that cannot be: those with a
// native addon (a `.node` file, `binding.gyp`, a `gypfile` / `napi` / `binary` field) and the ones
// listed in `run.external` (packages that read their own files at run time). Those are copied whole
// into `.deno-desktop/sidecars/<name>/node_modules/` with their dependencies (a pnpm layout is
// followed through its links) and loaded with `require()`, which resolves from the bundle's folder.
// Prebuilt addons for other operating systems (`prebuilds/<os>-<arch>/`) are left out.
//
// `node:sea` (Node's single-executable API, which Deno lacks) resolves to a stub whose `isSea()` is
// `false`: a sidecar is never a single executable.
//
// Loaded only while packaging (`desktopIncludeArgs` imports it dynamically): esbuild must never be
// compiled into the app.

import * as esbuild from "esbuild";
import { builtinModules } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "@std/path";
import {
  SIDECAR_BUNDLE_DIR,
  SIDECAR_BUNDLE_MAIN,
  type SidecarDefinition,
} from "../desktop/sidecar.ts";
import type { DesktopOs } from "./desktop-capabilities.ts";

/** What {@linkcode bundleDesktopSidecar} wrote. */
export interface SidecarBundleReport {
  /** The sidecar's name. */
  readonly name: string;
  /** The bundle folder, relative to the project (`.deno-desktop/sidecars/<name>`). */
  readonly dir: string;
  /** The packages copied whole (native addons and `external`), by name. */
  readonly copied: readonly string[];
  /** The copied packages that hold a native addon. */
  readonly natives: readonly string[];
  /** Total bytes written. */
  readonly bytes: number;
  /** Problems worth reading (a missing dependency, a version conflict, a missing `ffi` grant). */
  readonly warnings: readonly string[];
}

/** Node's names for the OSes (`prebuilds/<platform>-<arch>`). */
const NODE_PLATFORM: Record<DesktopOs, string> = {
  darwin: "darwin",
  linux: "linux",
  windows: "win32",
};

/** The prebuild platforms there are (a `prebuilds/` subfolder of another is left out). */
const PREBUILD_PLATFORMS = ["darwin", "linux", "win32", "android", "freebsd", "openbsd", "sunos"];

/** `node:sea` for a sidecar: not a single executable, no assets. */
const SEA_STUB = `export const isSea = () => false;
const none = (key) => { throw new Error("node:sea: no asset " + key + " (not a single executable)"); };
export const getAsset = none;
export const getRawAsset = none;
export const getAssetAsBlob = none;
export const getAssetKeys = () => [];
export default { isSea, getAsset, getRawAsset, getAssetAsBlob, getAssetKeys };
`;

/** `require`, `__filename` and `__dirname` for the bundle's CommonJS parts and copied packages. */
const BANNER = 'import { createRequire as __denextCreateRequire } from "node:module";\n' +
  'import { fileURLToPath as __denextFileURLToPath } from "node:url";\n' +
  "const require = __denextCreateRequire(import.meta.url);\n" +
  "const __filename = __denextFileURLToPath(import.meta.url);\n" +
  'const __dirname = __filename.slice(0, Math.max(__filename.lastIndexOf("/"), __filename.lastIndexOf("\\\\")));\n';

/** A bare specifier's package name (`@scope/pkg/sub` → `@scope/pkg`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Whether `specifier` names a Node built-in. */
function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(packageNameOf(specifier));
}

/** `path` exists. */
async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

/** The folder of package `name` that holds `file` (walking up to its `package.json`). */
async function packageRoot(file: string, name: string): Promise<string | undefined> {
  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (await exists(manifest)) {
      try {
        if (JSON.parse(await Deno.readTextFile(manifest)).name === name) return dir;
      } catch { /* not this one */ }
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Whether the folder holds a `.node` file (bounded walk; nested `node_modules` skipped). */
async function hasNodeFile(dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile && e.name.endsWith(".node")) return true;
  }
  for (const e of entries) {
    if (e.isDirectory && e.name !== "node_modules" && !e.name.startsWith(".")) {
      if (await hasNodeFile(join(dir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Whether the package at `root` carries a native addon: a `gypfile` / `napi` / `binary` field, a
 * `binding.gyp`, or a `.node` file.
 *
 * @param root The package folder.
 * @returns Whether it is native.
 */
export async function isNativePackage(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json")));
    if (pkg.gypfile === true || pkg.napi !== undefined || pkg.binary !== undefined) return true;
  } catch { /* no manifest: look at the files */ }
  if (await exists(join(root, "binding.gyp"))) return true;
  return await hasNodeFile(root);
}

/**
 * The runtime dependencies (`dependencies` + `optionalDependencies`) of the package at `dir`, or
 * `undefined` when it has no `package.json` (then every installed package counts).
 */
async function runtimeDependencies(dir: string): Promise<Set<string> | undefined> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(dir, "package.json")));
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
  } catch {
    return undefined;
  }
}

/** Package `name` as `fromDir`'s code would `require` it: the nearest `node_modules/<name>`, real path. */
async function findPackage(fromDir: string, name: string): Promise<string | undefined> {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (await exists(join(candidate, "package.json"))) return await Deno.realPath(candidate);
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Whether a package's subfolder stays behind: its own `node_modules` (dependencies are copied
 * beside it, see copyPackages) and another OS's `prebuilds/<os>-<arch>`.
 */
function skipFolder(parent: string, name: string, platform: string): boolean {
  if (name === "node_modules") return true;
  if (basename(parent) !== "prebuilds") return false;
  const os = name.split("-")[0];
  return PREBUILD_PLATFORMS.includes(os) && os !== platform;
}

/** Copy `from` into `to` (files, links followed), leaving out other OSes' prebuilds. */
async function copyTree(from: string, to: string, platform: string): Promise<number> {
  let bytes = 0;
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    const src = join(from, e.name), dst = join(to, e.name);
    const info = await Deno.stat(src).catch(() => null);
    if (!info) continue;
    if (info.isDirectory) {
      if (!skipFolder(from, e.name, platform)) bytes += await copyTree(src, dst, platform);
    } else if (info.isFile) {
      await Deno.copyFile(src, dst);
      bytes += info.size;
    }
  }
  return bytes;
}

/** Whether a package's `os` field (npm's) allows `platform` (no field: every OS). */
async function supportsPlatform(root: string, platform: string): Promise<boolean> {
  try {
    const os = JSON.parse(await Deno.readTextFile(join(root, "package.json"))).os;
    if (!Array.isArray(os) || os.length === 0) return true;
    if (os.includes(`!${platform}`)) return false;
    const allowed = os.filter((o: unknown) => typeof o === "string" && !o.startsWith("!"));
    return allowed.length === 0 || allowed.includes(platform);
  } catch {
    return true;
  }
}

/** The target of a package `exports` value for the first of `conditions` it has. */
function exportTarget(value: unknown, conditions: readonly string[]): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  for (const key of conditions) {
    const t = exportTarget(v[key], conditions);
    if (t) return t;
  }
  return undefined;
}

/** The file `require(<package>)` (`kind: "require"`) or its `import` loads. */
function packageEntry(root: string, kind: "require" | "import"): string {
  const pkg = JSON.parse(Deno.readTextFileSync(join(root, "package.json")));
  const exp = pkg.exports;
  const dot = typeof exp === "object" && exp !== null && !Array.isArray(exp) && "." in exp
    ? exp["."]
    : exp;
  const conditions = kind === "require"
    ? ["node", "require", "default"]
    : ["node", "import", "default", "require"];
  const fallback = kind === "require" ? pkg.main : pkg.module ?? pkg.main;
  return join(root, exportTarget(dot, conditions) ?? fallback ?? "index.js");
}

/**
 * Whether `require(<package>)` loads an ES module (no CommonJS build): such a package's own bare
 * imports would go through the app's resolver, so it is bundled in place rather than copied.
 */
function requiresAsEsm(root: string): boolean {
  let file: string;
  try {
    file = packageEntry(root, "require");
  } catch {
    return false;
  }
  if (file.endsWith(".cjs")) return false;
  if (file.endsWith(".mjs")) return true;
  for (let dir = dirname(file); dir.length >= root.length; dir = dirname(dir)) {
    try {
      return JSON.parse(Deno.readTextFileSync(join(dir, "package.json"))).type === "module";
    } catch { /* no manifest here */ }
    if (dir === root) break;
  }
  return false;
}

/** A package's runtime dependency names (`dependencies` + `optionalDependencies`). */
async function dependencyNames(root: string): Promise<{ required: string[]; optional: string[] }> {
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json")));
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    const required = Object.keys(pkg.dependencies ?? {}).filter((n) => !optional.includes(n));
    return { required, optional };
  } catch {
    return { required: [], optional: [] };
  }
}

/** The installed dependencies of package `name` not copied yet (a missing required one is warned). */
async function dependenciesToCopy(
  name: string,
  root: string,
  copied: ReadonlyMap<string, string>,
  warnings: string[],
): Promise<Array<[string, string]>> {
  const { required, optional } = await dependencyNames(root);
  const out: Array<[string, string]> = [];
  for (const dep of [...required, ...optional]) {
    if (copied.has(dep)) continue;
    const found = await findPackage(dirname(root), dep) ?? await findPackage(root, dep);
    if (found) out.push([dep, found]);
    else if (required.includes(dep)) warnings.push(`${name} needs ${dep}, which is not installed`);
  }
  return out;
}

/**
 * Copy each package in `roots` and its dependencies (as installed, a pnpm layout followed through
 * its links) into `<out>/node_modules/`, flat. Returns the names copied and the bytes.
 */
async function copyPackages(
  roots: ReadonlyMap<string, string>,
  out: string,
  platform: string,
  warnings: string[],
  bundled: ReadonlySet<string> = new Set(),
): Promise<{ names: string[]; bytes: number }> {
  const copied = new Map<string, string>();
  for (const name of bundled) copied.set(name, "(bundled)");
  let bytes = 0;
  const queue = [...roots.entries()];
  while (queue.length > 0) {
    const [name, root] = queue.shift()!;
    const prior = copied.get(name);
    if (prior !== undefined) {
      if (prior !== root && prior !== "(bundled)") {
        warnings.push(`two copies of ${name}; kept ${prior}`);
      }
      continue;
    }
    if (!await supportsPlatform(root, platform)) continue;
    copied.set(name, root);
    bytes += await copyTree(root, join(out, "node_modules", name), platform);
    queue.push(...await dependenciesToCopy(name, root, copied, warnings));
  }
  return { names: [...copied.keys()].filter((n) => !bundled.has(n)), bytes };
}

/**
 * The packages directly in a `node_modules` folder (scoped ones included), as `[name, real dir]`.
 *
 * @param dir The `node_modules` folder.
 * @returns The packages; throws when the folder does not exist.
 */
// Loaded by `desktop add sidecar` through a computed specifier, which the analysis cannot follow.
// fallow-ignore-next-line unused-export
export async function installedPackages(dir: string): Promise<Array<[string, string]>> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    throw new Error(`no node_modules folder at ${dir}`);
  }
  const out: Array<[string, string]> = [];
  const add = async (name: string, path: string) => {
    if (!await exists(join(path, "package.json"))) return;
    out.push([name, await Deno.realPath(path)]);
  };
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      for await (const s of Deno.readDir(join(dir, e.name))) {
        await add(`${e.name}/${s.name}`, join(dir, e.name, s.name));
      }
    } else await add(e.name, join(dir, e.name));
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** A Node backend sidecar's `run`. */
interface BundledRun {
  readonly module: string;
  readonly nodeModules?: string;
  readonly external?: readonly string[];
  readonly entries?: readonly string[];
}

/** What one bundling run collects: the packages to copy (name → folder) and the native ones. */
interface BundleState {
  readonly external: ReadonlySet<string>;
  readonly toCopy: Map<string, string>;
  readonly natives: Set<string>;
  readonly nativeCache: Map<string, Promise<boolean>>;
  readonly warnings: string[];
}

/**
 * The packages copied whatever the bundle imports. A native addon is often loaded at run time
 * (`createRequire(import.meta.url)("node-pty")`), where the bundler cannot see it: every native
 * package among the backend's runtime dependencies in `nodeModules` is copied, as is every
 * `external` one.
 */
async function seedCopies(
  state: BundleState,
  nodeModules: string | undefined,
  entry: string,
): Promise<void> {
  if (nodeModules) await seedInstalled(state, nodeModules);
  for (const name of state.external) {
    if (state.toCopy.has(name)) continue;
    const root = await findPackage(dirname(entry), name);
    if (root) state.toCopy.set(name, root);
    else state.warnings.push(`external package ${name} is not installed`);
  }
}

/** The native and `external` packages among the backend's runtime dependencies in `nodeModules`. */
async function seedInstalled(state: BundleState, nodeModules: string): Promise<void> {
  const deps = await runtimeDependencies(dirname(nodeModules));
  for (const [name, root] of await installedPackages(nodeModules)) {
    const external = state.external.has(name);
    if (!external && deps !== undefined && !deps.has(name)) continue;
    const native = !external && await isNativePackage(root);
    if (external || native) state.toCopy.set(name, root);
    if (native) state.natives.add(name);
  }
}

/** esbuild's entry points: `main` and each further entry under its path relative to the module. */
function entryPointsOf(entry: string, entries: readonly string[]): Record<string, string> {
  const points: Record<string, string> = { [SIDECAR_BUNDLE_MAIN.replace(/\.mjs$/, "")]: entry };
  for (const extra of entries) {
    const abs = resolve(dirname(entry), extra);
    points[relative(dirname(entry), abs).replace(/\.[cm]?[jt]sx?$/, "")] = abs;
  }
  return points;
}

/** Whether the package at `root` is native (memoized per bundling run). */
function nativeProbe(state: BundleState, root: string): Promise<boolean> {
  let probe = state.nativeCache.get(root);
  if (!probe) state.nativeCache.set(root, probe = isNativePackage(root));
  return probe;
}

/**
 * Where a bare import goes: inlined (esbuild's own resolution), or, for a native or `external`
 * package, a stand-in that `require`s the copied package at run time.
 */
async function resolveBare(
  build: esbuild.PluginBuild,
  args: esbuild.OnResolveArgs,
  state: BundleState,
): Promise<esbuild.OnResolveResult | undefined> {
  // The `require()` of a copied package, from its stand-in module: left to run time.
  if (args.namespace === "denext-require") return { path: args.path, external: true };
  if (args.pluginData?.denextSidecar === true || isBuiltin(args.path)) return undefined;
  if (isAbsolute(args.path)) return undefined;
  const name = packageNameOf(args.path);
  const resolved = await build.resolve(args.path, {
    kind: args.kind,
    resolveDir: args.resolveDir,
    importer: args.importer,
    pluginData: { denextSidecar: true },
  });
  if (resolved.errors.length > 0 || !resolved.path) return undefined;
  const root = await packageRoot(resolved.path, name);
  const external = state.external.has(name);
  const native = root !== undefined && !external && await nativeProbe(state, root);
  if (!root || (!native && !external)) {
    return {
      path: resolved.path,
      namespace: resolved.namespace,
      ...(resolved.sideEffects === false ? { sideEffects: false } : {}),
    };
  }
  if (native) state.natives.add(name);
  state.toCopy.set(name, await Deno.realPath(root));
  return { path: args.path, namespace: "denext-require" };
}

/**
 * The stand-in for a package loaded at run time. An ES module package comes back from `require`
 * as its namespace, and esbuild hands a `.mjs` importer's default import the whole
 * `module.exports` (Node's rule for CommonJS), so the namespace's `default` is what is exported,
 * with the named exports read through to the namespace (a primitive `default` alone is exported
 * as it is).
 */
function requireStub(specifier: string): string {
  return `const m = require(${JSON.stringify(specifier)});
const esm = m && m[Symbol.toStringTag] === "Module" && "default" in m;
const d = esm ? m.default : undefined;
const named = esm && Object.keys(m).some((k) => k !== "default" && k !== "__esModule");
module.exports = typeof d === "function" || (typeof d === "object" && d !== null)
  ? new Proxy(d, { get: (t, k) => (k in m ? m[k] : Reflect.get(t, k)), has: (t, k) => k in m || k in t })
  : esm && !named ? d : m;
`;
}

/** The bundler plugin: `node:sea` stubbed, native and `external` packages left to `require`. */
function sidecarPlugin(state: BundleState): esbuild.Plugin {
  return {
    name: "denext-sidecar",
    setup(build) {
      build.onResolve({ filter: /^node:sea$/ }, () => ({ path: "sea", namespace: "denext-stub" }));
      build.onLoad({ filter: /.*/, namespace: "denext-stub" }, () => ({
        contents: SEA_STUB,
        loader: "js",
      }));
      build.onResolve({ filter: /^[^./]/ }, (args) => resolveBare(build, args, state));
      build.onLoad({ filter: /.*/, namespace: "denext-require" }, (args) => ({
        contents: requireStub(args.path),
        loader: "js",
      }));
    },
  };
}

/** One esbuild run of the sidecar's shape (ESM for Node, the require banner). */
async function runEsbuild(o: {
  points: Record<string, string>;
  outdir: string;
  plugin: esbuild.Plugin;
  nodeModules: string | undefined;
  failure: string;
}): Promise<void> {
  try {
    await esbuild.build({
      entryPoints: o.points,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      outdir: o.outdir,
      outExtension: { ".js": ".mjs" },
      banner: { js: BANNER },
      plugins: [o.plugin],
      ...(o.nodeModules ? { nodePaths: [o.nodeModules] } : {}),
      logLevel: "silent",
      legalComments: "none",
      write: true,
    });
  } catch (err) {
    const errors = (err as { errors?: esbuild.Message[] }).errors ?? [];
    const detail = errors.slice(0, 5).map((e) =>
      `\n    ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ""}`
    ).join("");
    throw new Error(`cannot bundle ${o.failure}:${detail || ` ${err}`}`);
  }
}

/**
 * Bundle in place every copied package that `require` would load as an ES module (its own bare
 * imports would go through the app's resolver): npm imports inlined, native addons required. A
 * bundle may turn up more; repeat until none is left. Returns their names.
 */
async function bundleEsmCopies(
  state: BundleState,
  out: string,
  build: (points: Record<string, string>, outdir: string, what: string) => Promise<void>,
): Promise<string[]> {
  const bundled: string[] = [];
  for (;;) {
    const next = [...state.toCopy.entries()].find(([name, root]) =>
      !state.natives.has(name) && !bundled.includes(name) && requiresAsEsm(root)
    );
    if (!next) return bundled;
    const [name, root] = next;
    bundled.push(name);
    state.toCopy.delete(name);
    const dir = join(out, "node_modules", ...name.split("/"));
    await build({ index: packageEntry(root, "import") }, dir, name);
    const { version } = JSON.parse(await Deno.readTextFile(join(root, "package.json")));
    const manifest = {
      name,
      version,
      type: "module",
      main: "./index.mjs",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" },
    };
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
}

/** The bytes of the bundle's own files and of the packages bundled in place. */
async function bundleBytes(out: string, bundled: readonly string[]): Promise<number> {
  let bytes = 0;
  for await (const e of Deno.readDir(out)) {
    if (e.isFile) bytes += (await Deno.stat(join(out, e.name))).size;
  }
  for (const name of bundled) {
    bytes += (await Deno.stat(join(out, "node_modules", ...name.split("/"), "index.mjs"))).size;
  }
  return bytes;
}

/** Options for {@linkcode bundleDesktopSidecar}. */
export interface BundleSidecarOptions {
  /** The project root. */
  readonly projectDir: string;
  /** The sidecar (a module sidecar with `nodeModules`). */
  readonly definition: SidecarDefinition;
  /** The OS packaged for (its prebuilt addons are kept). Default: the host's. */
  readonly os?: DesktopOs;
  /** Whether `ffi` is granted (`permissions.ffi` or `desktop.extraPermissions.ffi`). */
  readonly ffiGranted?: boolean;
}

/**
 * Bundle one Node backend sidecar into `.deno-desktop/sidecars/<name>/` (replacing what was there).
 *
 * @param options The project, the sidecar and the target OS.
 * @returns What was written.
 */
export async function bundleDesktopSidecar(
  options: BundleSidecarOptions,
): Promise<SidecarBundleReport> {
  const def = options.definition;
  const run = def.run as BundledRun;
  const projectDir = resolve(options.projectDir);
  const entry = resolve(projectDir, run.module);
  const nodeModules = run.nodeModules ? resolve(projectDir, run.nodeModules) : undefined;
  const platform = NODE_PLATFORM[options.os ?? (Deno.build.os as DesktopOs)] ?? "linux";
  const relDir = `${SIDECAR_BUNDLE_DIR}/${def.name}`;
  const out = join(projectDir, ...relDir.split("/"));
  const state: BundleState = {
    external: new Set(run.external ?? []),
    toCopy: new Map(),
    natives: new Set(),
    nativeCache: new Map(),
    warnings: [],
  };
  await seedCopies(state, nodeModules, entry);
  await Deno.remove(out, { recursive: true }).catch(() => {});
  await Deno.mkdir(out, { recursive: true });
  const plugin = sidecarPlugin(state);
  const build = (points: Record<string, string>, outdir: string, what: string) =>
    runEsbuild({ points, outdir, plugin, nodeModules, failure: `sidecar "${def.name}" (${what})` });
  let bundled: string[];
  try {
    await build(entryPointsOf(entry, run.entries ?? []), out, run.module);
    bundled = await bundleEsmCopies(state, out, build);
  } finally {
    await esbuild.stop().catch(() => {});
  }
  const copied = await copyPackages(state.toCopy, out, platform, state.warnings, new Set(bundled));
  if (state.natives.size > 0 && options.ffiGranted !== true) {
    state.warnings.push(
      `loads native addons (${[...state.natives].join(", ")}): add permissions: { ffi: ["*"] } ` +
        "to the sidecar, or the packaged app refuses to load them",
    );
  }
  return {
    name: def.name,
    dir: relDir,
    copied: [...bundled, ...copied.names],
    natives: [...state.natives],
    bytes: await bundleBytes(out, bundled) + copied.bytes,
    warnings: state.warnings,
  };
}

/** Write `.deno-desktop/sidecars/.gitignore` (the bundles are build output) and drop stale bundles. */
async function tidyBundleDir(projectDir: string, keep: readonly string[]): Promise<void> {
  const dir = join(projectDir, ...SIDECAR_BUNDLE_DIR.split("/"));
  await Deno.mkdir(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if ((await Deno.readTextFile(ignore).catch(() => "")) !== "*\n") {
    await Deno.writeTextFile(ignore, "*\n");
  }
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory && !keep.includes(e.name)) {
      await Deno.remove(join(dir, e.name), { recursive: true });
    }
  }
}

/** Whether `ffi` is granted to the sidecar or app-wide. */
function ffiGranted(def: SidecarDefinition, config: unknown): boolean {
  const extra = (config as { desktop?: { extraPermissions?: { ffi?: unknown } } } | undefined)
    ?.desktop?.extraPermissions?.ffi;
  return (def.permissions?.ffi?.length ?? 0) > 0 || (Array.isArray(extra) && extra.length > 0);
}

/**
 * Bundle every Node backend sidecar of the project's `desktop.sidecars` (the ones with
 * `run.nodeModules`), print what each holds, and drop bundles of sidecars no longer configured.
 *
 * @param projectDir The project root.
 * @param config The project config.
 * @param os The OS packaged for (default: the host's).
 * @returns The reports.
 */
export async function bundleDesktopSidecars(
  projectDir: string,
  config: unknown,
  os?: DesktopOs,
): Promise<SidecarBundleReport[]> {
  const sidecars = ((config as { desktop?: { sidecars?: unknown } } | undefined)?.desktop
    ?.sidecars ?? []) as SidecarDefinition[];
  const bundled = sidecars.filter((d) =>
    "module" in d.run && (d.run as { nodeModules?: string }).nodeModules !== undefined
  );
  const reports: SidecarBundleReport[] = [];
  for (const def of bundled) {
    const report = await bundleDesktopSidecar({
      projectDir,
      definition: def,
      ...(os ? { os } : {}),
      ffiGranted: ffiGranted(def, config),
    });
    const mb = (report.bytes / 1024 / 1024).toFixed(1);
    console.log(
      `  sidecar ${def.name}: bundled into ${report.dir} (${mb} MB` +
        (report.copied.length ? `; copied ${report.copied.join(", ")}` : "") + ")",
    );
    for (const w of report.warnings) console.warn(`  ⚠ sidecar ${def.name}: ${w}`);
    reports.push(report);
  }
  if (bundled.length > 0 || await exists(join(projectDir, ...SIDECAR_BUNDLE_DIR.split("/")))) {
    await tidyBundleDir(projectDir, bundled.map((d) => d.name));
  }
  return reports;
}
