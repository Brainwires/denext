// `denext build --compile`: the app's production server as ONE executable.
//
// After `denext build`, this runs `deno compile` (on denext's Deno toolchain) over a generated
// entry (`.denext/compile/main.ts`) that calls `runStandalone` (src/standalone/mod.ts) — the same
// `startProdServer` `denext start` runs, plus the `job` and `db` verbs. What it embeds:
//
// - the project's server modules (`app/`, the root config, middleware and instrumentation,
//   `jobs/`, `functions/`) — each embedded directory's modules join the compiled module graph, so
//   their imports (the framework, `jsr:` / `npm:` packages) are embedded too;
// - the build (`.denext/`: the client bundles, the manifest, the server copies — relocatable, so
//   they import the embedded project by relative paths), `public/` and the migrations;
// - `compile.include` paths.
//
// The stylesheet imports need no import map at run time: every module that reaches one is served
// through its server copy, which imports the stylesheet's JS shim instead (./server-copies.ts).
// The compile still resolves the CSS import map, so the original modules' graph resolves.
//
// Never embedded: `.env*` files and SQLite databases (the binary reads its environment and writes
// its state in the working directory at run time). The `--allow-*` baked in are the Docker image's
// least-privilege set plus `compile.permissions` ({@linkcode compileBuildFlags}); `--allow-all`
// only when the app opts in.

import { basename, dirname, join, relative, resolve, toFileUrl } from "@std/path";
import { walk } from "@std/fs";
import type { CompileConfig } from "../server/config.ts";
import { frameworkImports, frameworkRootUrl, readFrameworkJson } from "./bundle.ts";
import { relocatableImportMap } from "./desktop-import-map.ts";
import { denoExecutable } from "./deno-executable.ts";
import { readConfig, readImportsAbsolute } from "./module-config.ts";
import { CONFIG_FILES, type ProjectPaths, resolveProject } from "./paths.ts";
import { relativeSpecifier } from "./swc-ast.ts";
import { childToolchainMarker } from "../cli/self-exec.ts";

/** The targets `deno compile --target` takes. */
export const COMPILE_TARGETS: readonly string[] = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
];

/** Options for {@linkcode compileApp}. */
export interface CompileAppOptions {
  /** A `deno compile --target` triple (default: this machine). */
  target?: string;
  /** The executable's path (default `dist/<name>`, `.exe` for Windows), relative to the cwd. */
  output?: string;
  /** The `deno` to compile with (default: {@linkcode denoExecutable}, the toolchain). */
  deno?: string;
}

/** What {@linkcode compileApp} produced. */
export interface CompileAppResult {
  /** The executable's absolute path. */
  output: string;
  /** The `--allow-*` baked into it. */
  permissions: string[];
}

/** Where the generated entry and config live, under the out dir. */
const COMPILE_DIR = "compile";

/** The project's directories embedded whole (when present), beside the app dir and the build. */
const EMBEDDED_DIRS = ["public", "jobs", "services", "functions", "migrations", "supabase/migrations"];

/** The project's root files embedded (when present). */
const EMBEDDED_FILES = [
  ...CONFIG_FILES,
  "deno.json",
  "deno.jsonc",
  "package.json",
  "content.config.ts",
];

/** Build-dir entries that are run-time state or build scratch, never embedded. */
const BUILD_DIR_EXCLUDES = [
  "server-cache",
  "sourcemaps",
  "css-config.json",
  "module-config.json",
  "dev",
  "dev-copies",
];

/**
 * A file that must never be embedded: an env file (secrets), a SQLite database or its journal
 * (data, and it may hold sessions), or a lock.
 */
export function neverEmbedded(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) ||
    /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(name) ||
    name.startsWith(".denext-lock");
}

/**
 * The `--allow-*` flags baked into the binary: the Docker image's least-privilege start
 * (`--allow-net --allow-env --allow-read --allow-write=.denext`, relative paths resolving against
 * the working directory at run time) with `compile.permissions` unioned in per kind, or
 * `--allow-all` when the app opts in with `permissions: "all"`.
 *
 * @param compile The project's `compile` config.
 * @returns The flags, ready for `deno compile`.
 */
export function compileBuildFlags(compile: CompileConfig | undefined): string[] {
  const extra = compile?.permissions;
  if (extra === "all") return ["--allow-all"];
  const flag = (kind: string, values: readonly string[]): string[] => {
    const set = new Set(values);
    if (set.size === 0) return [];
    return set.has("*") ? [`--allow-${kind}`] : [`--allow-${kind}=${[...set].sort().join(",")}`];
  };
  return [
    "--allow-net",
    "--allow-env",
    "--allow-read",
    ...flag("write", [".denext", ...(extra?.write ?? [])]),
    ...flag("sys", extra?.sys ?? []),
    ...flag("run", extra?.run ?? []),
    ...flag("ffi", extra?.ffi ?? []),
  ];
}

/** The executable's default name: deno.json's `name` (without its scope), else the dir's. */
async function appName(paths: ProjectPaths): Promise<string> {
  const cfg = await readConfig(join(paths.projectDir, "deno.json")) as { name?: unknown };
  const raw = typeof cfg.name === "string" && cfg.name ? cfg.name : basename(paths.projectDir);
  return raw.replace(/^@[^/]+\//, "").replace(/[^\w.-]+/g, "-") || "app";
}

/** Whether the `deno` {@linkcode denoExecutable} resolves is denext's toolchain (a known build). */
function onToolchain(): boolean {
  const env = (name: string) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  };
  const marker = childToolchainMarker(env, Deno.version.deno);
  return marker !== undefined && marker !== "path";
}

/** `path` exists (file or directory). */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `denext/standalone` specifier the entry at `entryUrl` imports: relative for a local
 * checkout (so it is found inside the binary), the exact published version from JSR.
 */
function standaloneSpecifier(entryUrl: string): string {
  const own = new URL("src/standalone/mod.ts", frameworkRootUrl()).href;
  if (own.startsWith("file:")) return relativeSpecifier(entryUrl, own) ?? own;
  const jsr = /^https:\/\/jsr\.io\/@denext\/denext\/([^/]+)\//.exec(own);
  return jsr ? `jsr:@denext/denext@${jsr[1]}/standalone` : own;
}

/** The generated entry module's source. */
function entrySource(entryUrl: string, projectUrl: string): string {
  const root = relativeSpecifier(entryUrl, projectUrl) ?? projectUrl;
  return [
    "// Generated by `denext build --compile`: the compiled app's main module. Do not edit.",
    `import { runStandalone } from ${JSON.stringify(standaloneSpecifier(entryUrl))};`,
    "",
    `await runStandalone(new URL(${JSON.stringify(root)}, import.meta.url));`,
    "",
  ].join("\n");
}

/**
 * The deno config the compile resolves with: the app's import map (plus the framework's, for a
 * local checkout, and the build's CSS import map, so the original modules' stylesheet imports
 * resolve to their shims), every local target made relative to the written config so the binary
 * resolves it to the embedded copy.
 */
async function writeCompileConfig(paths: ProjectPaths, dir: string): Promise<string> {
  const appCfg = await readConfig(paths.configPath);
  const local = frameworkRootUrl().startsWith("file:");
  const css = await readConfig(join(paths.outDir, "css-config.json"));
  const cssRedirects = Object.fromEntries(
    Object.entries(css.imports ?? {}).filter(([k]) => k.endsWith(".css") || k.endsWith(".scss")),
  );
  const imports = {
    ...(local ? await frameworkImports() : {}),
    ...await readImportsAbsolute(paths.configPath),
    ...cssRedirects,
  };
  const compilerOptions = appCfg.compilerOptions ??
    (await readFrameworkJson("deno.json")).compilerOptions;
  const file = join(dir, "deno.json");
  const map = relocatableImportMap({ imports }, toFileUrl(file), dir, true) ?? { imports };
  const config: Record<string, unknown> = { compilerOptions, ...map };
  const nmd = appCfg.nodeModulesDir;
  if (nmd && nmd !== "none" && nmd !== false) config.nodeModulesDir = nmd;
  await Deno.writeTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** The project-relative paths to embed (those that exist). */
async function embeddedPaths(paths: ProjectPaths, compile: CompileConfig | undefined) {
  const rel = (p: string) => relative(paths.projectDir, p).replaceAll("\\", "/");
  const candidates = [
    rel(paths.appDir),
    rel(paths.outDir),
    ...EMBEDDED_DIRS,
    ...EMBEDDED_FILES,
    ...[paths.middlewarePath, paths.instrumentationPath].filter((p): p is string => !!p).map(rel),
    ...(compile?.include ?? []),
  ];
  const out: string[] = [];
  for (const p of new Set(candidates)) {
    if (await exists(join(paths.projectDir, p))) out.push(p);
  }
  if (paths.publicDir && !out.includes(rel(paths.publicDir))) {
    if (await exists(paths.publicDir)) out.push(rel(paths.publicDir));
  }
  return out;
}

/** The project-relative paths under `included` that must not be embedded. */
async function excludedPaths(
  paths: ProjectPaths,
  included: readonly string[],
  output: string,
): Promise<string[]> {
  const rel = (p: string) => relative(paths.projectDir, p).replaceAll("\\", "/");
  const out = new Set<string>();
  const buildDir = rel(paths.outDir);
  for (const name of BUILD_DIR_EXCLUDES) {
    if (await exists(join(paths.outDir, name))) out.add(`${buildDir}/${name}`);
  }
  for (const p of included) {
    const abs = join(paths.projectDir, p);
    const info = await Deno.stat(abs);
    if (!info.isDirectory) {
      if (neverEmbedded(basename(abs))) out.add(p);
      continue;
    }
    for await (const entry of walk(abs, { includeDirs: false, followSymlinks: false })) {
      if (neverEmbedded(entry.name)) out.add(rel(entry.path));
    }
  }
  const outRel = rel(output);
  if (!outRel.startsWith("..")) out.add(outRel);
  return [...out].sort();
}

/**
 * Compile the built project in `projectDir` into one executable (see the module comment).
 * `denext build` must have run first.
 *
 * @param projectDir The project.
 * @param options The target, the output path and the `deno` to run.
 * @returns The executable and the permissions baked into it.
 */
export async function compileApp(
  projectDir: string,
  options: CompileAppOptions = {},
): Promise<CompileAppResult> {
  const paths = await resolveProject(projectDir);
  if (paths.config?.mode === "spa") {
    throw new Error(
      "denext build --compile builds a server; a SPA has none — `denext export` and any static " +
        "host (or the desktop packager) ship it.",
    );
  }
  if (!(await exists(join(paths.outDir, "manifest.json")))) {
    throw new Error(`No build output at ${paths.outDir}. Run \`denext build\` first.`);
  }
  if (options.target !== undefined && !COMPILE_TARGETS.includes(options.target)) {
    throw new Error(
      `--target ${options.target} is not a deno compile target (${COMPILE_TARGETS.join(", ")})`,
    );
  }
  const compile = paths.config?.compile;
  const windows = (options.target ?? Deno.build.target).includes("windows");
  const output = options.output
    ? resolve(Deno.cwd(), options.output)
    : join(paths.projectDir, "dist", `${await appName(paths)}${windows ? ".exe" : ""}`);
  const dir = join(paths.outDir, COMPILE_DIR);
  await Deno.mkdir(dir, { recursive: true });
  const entry = join(dir, "main.ts");
  const entryUrl = toFileUrl(entry).href;
  await Deno.writeTextFile(entry, entrySource(entryUrl, toFileUrl(paths.projectDir + "/").href));
  const config = await writeCompileConfig(paths, dir);
  const included = await embeddedPaths(paths, compile);
  const excluded = await excludedPaths(paths, included, output);
  const permissions = compileBuildFlags(compile);
  await Deno.mkdir(dirname(output), { recursive: true });
  const deno = options.deno ?? denoExecutable();
  const args = [
    "compile",
    "--no-check",
    "--unstable-sloppy-imports",
    // The toolchain's: embed only the npm packages the server's graph reaches, not the whole
    // lockfile snapshot (the framework's build tools are no part of the server).
    ...(!options.deno && onToolchain() ? ["--exclude-unused-npm"] : []),
    ...permissions,
    "--config",
    config,
    ...included.flatMap((p) => ["--include", p]),
    ...excluded.flatMap((p) => ["--exclude", p]),
    ...(options.target ? ["--target", options.target] : []),
    "--output",
    output,
    entry,
  ];
  const { code } = await new Deno.Command(deno, {
    args,
    cwd: paths.projectDir,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`deno compile failed (exit ${code})`);
  return { output, permissions };
}
