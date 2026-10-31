// `denext build --compile`: the app's production server as ONE executable.
//
// After `denext build`, this runs `deno compile` (on denext's Deno toolchain) over a generated
// entry (`.denext/compile/main.ts`) that calls `runStandalone` (src/standalone/mod.ts) — the same
// `startProdServer` `denext start` runs, plus the `job` and `db` verbs. What it embeds:
//
// - the project's server modules (`app/`, the root config, middleware and instrumentation,
//   `jobs/`, `services/`, `functions/`) — each embedded directory's modules join the compiled module graph, so
//   their imports (the framework, `jsr:` / `npm:` packages) are embedded too;
// - the build's outputs (an allow-list of `.denext/` entries, {@linkcode BUILD_OUTPUTS}: the client
//   bundles, the manifest, the server copies — relocatable, so they import the embedded project by
//   relative paths — and the first-party plugins' outputs), `public/` and the migrations. The rest
//   of `.denext/` is development and run-time state (stack backups, the backend's dev keys, the
//   codebase index, dev-server state) and is never embedded; an entry the list doesn't know is
//   named in the result's `skipped`, and `compile.include` can add it;
// - `compile.include` paths.
//
// The stylesheet imports need no import map at run time: every module that reaches one is served
// through its server copy, which imports the stylesheet's JS shim instead (./server-copies.ts).
// The compile still resolves the CSS import map, so the original modules' graph resolves.
//
// Never embedded, wherever they are (`compile.include` too): `.env*` files, SQLite databases,
// database dumps, `.npmrc` files and the backend's dev key file (the binary reads its environment
// and writes its state in the working directory at run time).
//
// The compile resolves the app's dependencies as its lockfile locks them, under its
// dependency-age rule (./compile-lock.ts). The `--allow-*` baked in are the Docker image's
// least-privilege set plus `compile.permissions` ({@linkcode compileBuildFlags}); `--allow-all`
// only when the app opts in.

import { basename, dirname, join, relative, resolve, toFileUrl } from "@std/path";
import type { CompileConfig } from "../server/config.ts";
import {
  frameworkImports,
  frameworkRootUrl,
  minDepAgeArgs,
  minDepAgeConfig,
  readFrameworkJson,
} from "./bundle.ts";
import { relocatableImportMap } from "./desktop-import-map.ts";
import { runsFromCheckout } from "./checkout-file.ts";
import { denoExecutable } from "./deno-executable.ts";
import { readConfig, readImportsAbsolute } from "./module-config.ts";
import { supplyChainConfig } from "./workspace-imports.ts";
import { CONFIG_FILES, type ProjectPaths, resolveProject } from "./paths.ts";
import { relativeSpecifier } from "./swc-ast.ts";
import { NET_SPLIT_RELEASE, netSplitFlags, supportsNetSplit } from "./net-permissions.ts";
import { currentDenoIdentity } from "./deno-version.ts";
import {
  type CompileSignDeps,
  type CompileSignResult,
  signCompiledBinary,
} from "./compile-sign.ts";
import { childToolchainMarker, toolchainRuntimeFlags } from "../cli/self-exec.ts";
import { idleTrimCompileFlags, readEnv } from "./idle-trim.ts";
import { tlsCompileFlags } from "./start-tls-deploy.ts";
import { compileLimitFlags } from "./resource-limits.ts";
import {
  carryNpmrc,
  type CompileLock,
  seedCompileLock,
  settleCompileLock,
} from "./compile-lock.ts";
import {
  denortTargetKey,
  type DenoToolchainPin,
  ensureDenort,
  shippingToolchainPin,
} from "./deno-toolchain.ts";
import { assertRuntimeShippable } from "./runtime-revocations.ts";

/** The targets `deno compile --target` takes. */
export const COMPILE_TARGETS: readonly string[] = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];

/** Options for {@linkcode compileApp}. */
export interface CompileAppOptions {
  /** A `deno compile --target` triple (default: this machine). */
  target?: string;
  /** The executable's path (default `dist/<name>`, `.exe` for Windows), relative to the cwd. */
  output?: string;
  /** The `deno` to compile with (default: {@linkcode denoExecutable}, the toolchain). */
  deno?: string;
  /**
   * `--sign`: code-sign the binary, failing when a credential or tool is missing (without it,
   * `compile.sign` signs and only warns). See ./compile-sign.ts.
   */
  sign?: boolean;
  /** Seams for the signing step (tests). */
  signDeps?: CompileSignDeps;
  /** Where a warning goes (default: stderr). */
  warn?: (message: string) => void;
}

/** What {@linkcode compileApp} produced. */
export interface CompileAppResult {
  /** The executable's absolute path. */
  output: string;
  /** The `--allow-*` baked into it. */
  permissions: string[];
  /** The signing step's outcome, when signing was asked for. */
  signing?: CompileSignResult;
  /**
   * The build directory's entries left out because they are not known build outputs (add one
   * with `compile.include` when the server reads it at run time).
   */
  skipped: string[];
}

/** Where the generated entry and config live, under the out dir. */
const COMPILE_DIR = "compile";

/**
 * The project's directories embedded whole (when present), beside the app dir and the build:
 * `pages/` is the Pages Router's (`@denext/pages-router` scans it at startup, so its modules are
 * no import of the app dir's).
 */
const EMBEDDED_DIRS = [
  "pages",
  "src/pages",
  "public",
  "jobs",
  "services",
  "functions",
  "migrations",
  "supabase/migrations",
];

/** The project's root files embedded (when present). */
const EMBEDDED_FILES = [
  ...CONFIG_FILES,
  "deno.json",
  "deno.jsonc",
  "package.json",
  "content.config.ts",
];

/**
 * The build directory's entries the binary may need at run time — the only ones embedded. Build
 * outputs of the framework (bundles, the manifest, server copies, transformed modules, generated
 * modules an app may import) and of the first-party plugins.
 */
const BUILD_OUTPUTS: ReadonlySet<string> = new Set([
  "manifest.json",
  "deploy-manifest.json",
  "client",
  "client-runtime",
  "server",
  "server-copies",
  "next-compat",
  "compile",
  "compiled",
  "asyncctx",
  "qrl",
  "features",
  "platform-imports",
  "iso-islands",
  "css-shims",
  "emitted",
  "pages-client",
  "pages-static",
  "pages-compat",
  // Generated modules an app imports (`import "../.denext/content.ts"`, the Lustre kits).
  "api.ts",
  "routes.ts",
  "rest.ts",
  "content.ts",
  "lustre.ts",
  "lustre-server.ts",
  "lustre-view.ts",
  "lustre",
  // First-party plugins: content collections, React Router, TanStack Start, OpenAPI, GraphQL.
  "content-data.json",
  "content",
  "react-router",
  "tanstack-start",
  "openapi.json",
  "schema.graphql",
]);

/**
 * Build-dir entries known NOT to be build outputs — development, tooling and run-time state — left
 * out without a mention (an entry neither here nor in {@linkcode BUILD_OUTPUTS} is reported).
 */
const KNOWN_STATE: ReadonlySet<string> = new Set([
  "backups", // `denext stack backup`'s database dumps
  "rag", // the MCP codebase index
  "dev.json",
  "dev-unbundled",
  "refresh",
  "commands.json",
  "notices.json",
  "services.json",
  "mobile-dev-backup.json",
  "mobile-build",
  "deploy",
  "deno-dir",
  "deno.lock",
  "bin",
  "export",
  "tanstack-start-export",
  ".client.staging",
  "typescript-check",
  "analyze-meta.json",
  "app-config.pre-css.json",
  "desktop-preload.dev.js",
]);

/** Build-dir entries that are run-time state or build scratch, never embedded. */
const BUILD_DIR_EXCLUDES = [
  // The npm tree Deno creates beside the build's CSS config (`nodeModulesDir`): the compile
  // embeds its own npm snapshot, and these files are no modules of the binary.
  "node_modules",
  "server-cache",
  "sourcemaps",
  "css-config.json",
  "module-config.json",
  "dev",
  "dev-copies",
];

/**
 * A file that must never be embedded: an env file (secrets), a SQLite database or its journal
 * (data, and it may hold sessions), a database dump (`denext stack backup`'s `.dump` and full
 * `.tar.gz` backups), the backend's dev key file (its secret and signing keys), an `.npmrc` (it
 * may hold registry tokens), or a lock.
 */
export function neverEmbedded(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) ||
    /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(name) ||
    /\.dump$/i.test(name) || /^stack-.*\.tar\.gz$/i.test(name) ||
    name === "backend-keys.json" || name === ".npmrc" ||
    name.startsWith(".denext-lock");
}

/**
 * The build directory's entries to embed (the {@linkcode BUILD_OUTPUTS} present) and the ones
 * left out, project-relative and by name.
 */
async function buildDirEntries(
  outDir: string,
  rel: (p: string) => string,
): Promise<{ embedded: string[]; skipped: string[] }> {
  const embedded: string[] = [];
  const skipped: string[] = [];
  for await (const entry of Deno.readDir(outDir)) {
    if (BUILD_OUTPUTS.has(entry.name)) embedded.push(rel(join(outDir, entry.name)));
    else if (
      !BUILD_DIR_EXCLUDES.includes(entry.name) && !KNOWN_STATE.has(entry.name) &&
      !neverEmbedded(entry.name)
    ) {
      skipped.push(entry.name);
    }
  }
  return { embedded: embedded.sort(), skipped: skipped.sort() };
}

/**
 * The `--allow-*` flags baked into the binary: the Docker image's least-privilege start
 * (`--allow-net --allow-env --allow-read --allow-write=.denext`, relative paths resolving against
 * the working directory at run time) with `compile.permissions` unioned in per kind, or
 * `--allow-all` when the app opts in with `permissions: "all"`.
 *
 * The network grant: with `netSplit` (the binary runs on denext's Deno from 3.0.0-rc.2, which
 * splits `--allow-net` by direction) and `compile.permissions.netConnect` / `netListen` set, the
 * directional pair (`--allow-net-connect[=<hosts>]`, `--allow-net-listen[=<addrs>]`, an unset
 * direction unscoped); otherwise the unscoped `--allow-net` (the port is the binary's `--port` /
 * `$PORT`, chosen at run time, so nothing narrower is baked unasked).
 *
 * @param compile The project's `compile` config.
 * @param options `netSplit`: the runtime has the direction-split network flags.
 * @returns The flags, ready for `deno compile`.
 */
export function compileBuildFlags(
  compile: CompileConfig | undefined,
  options: { readonly netSplit?: boolean } = {},
): string[] {
  const extra = compile?.permissions;
  if (extra === "all") return ["--allow-all"];
  const flag = (kind: string, values: readonly string[]): string[] => {
    const set = new Set(values);
    if (set.size === 0) return [];
    return set.has("*") ? [`--allow-${kind}`] : [`--allow-${kind}=${[...set].sort().join(",")}`];
  };
  return [
    ...(options.netSplit && wantsNetSplit(compile)
      ? netSplitFlags(extra?.netConnect, extra?.netListen)
      : ["--allow-net"]),
    "--allow-env",
    "--allow-read",
    ...flag("write", [".denext", ...(extra?.write ?? [])]),
    ...flag("sys", extra?.sys ?? []),
    ...flag("run", extra?.run ?? []),
    ...flag("ffi", extra?.ffi ?? []),
  ];
}

/**
 * Whether `compile.permissions` scopes the network by direction (`netConnect` or `netListen`).
 *
 * @param compile The project's `compile` config.
 * @returns Whether either directional list is set.
 */
export function wantsNetSplit(compile: CompileConfig | undefined): boolean {
  const p = compile?.permissions;
  return typeof p === "object" && (p.netConnect !== undefined || p.netListen !== undefined);
}

/**
 * {@linkcode compileBuildFlags} for a compile onto `ownDenort` (the toolchain's own `denort`, or
 * `deno compile`'s choice): the split network flags need both the compiling CLI and the binary's
 * runtime to know them, so only the toolchain compiling onto its own denort, 3.0.0-rc.2 or later,
 * bakes them. A `netConnect` / `netListen` it cannot bake warns.
 *
 * @param compile The project's `compile` config.
 * @param ownDenort Whether the binary runs on the toolchain's own `denort`.
 * @param warn Where the warning goes (default: stderr).
 * @param version The toolchain version this process runs on (default: detected).
 * @returns The flags.
 */
export function compilePermissionFlags(
  compile: CompileConfig | undefined,
  ownDenort: boolean,
  warn: (message: string) => void = (m) => console.error(m),
  version: string | undefined = toolchainVersion(),
): string[] {
  const netSplit = ownDenort && supportsNetSplit(version);
  if (!netSplit && wantsNetSplit(compile)) {
    warn(
      `  ⚠ compile.permissions.netConnect / netListen need denext's Deno ${NET_SPLIT_RELEASE} or ` +
        "later (its own denort for this target); baking the unscoped --allow-net instead.",
    );
  }
  return compileBuildFlags(compile, { netSplit });
}

/** The executable's default name: deno.json's `name` (without its scope), else the dir's. */
async function appName(paths: ProjectPaths): Promise<string> {
  const cfg = await readConfig(join(paths.projectDir, "deno.json")) as { name?: unknown };
  const raw = typeof cfg.name === "string" && cfg.name ? cfg.name : basename(paths.projectDir);
  return raw.replace(/^@[^/]+\//, "").replace(/[^\w.-]+/g, "-") || "app";
}

/** The toolchain version this process runs on (`DENEXT_TOOLCHAIN_ACTIVE`), else `undefined`. */
function toolchainVersion(): string | undefined {
  const env = (name: string) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  };
  const marker = childToolchainMarker(env, currentDenoIdentity());
  return marker !== undefined && marker !== "path" ? marker : undefined;
}

/**
 * The flags only a toolchain compile gets (`version`: the toolchain's, `undefined` off it):
 * `--exclude-unused-npm` embeds only the npm packages the server's graph reaches, not the whole
 * lockfile snapshot (the framework's build tools are no part of the server), and the toolchain's
 * runtime flags are baked into the binary's metadata (`--unstable-no-legacy-abort` before runtime
 * 3.0.0-rc.5, where it became the default: the server runs as under `denext start`; the
 * toolchain's denort keeps it from 2.9.7-denext.21, so the first request prints no legacy-abort
 * notice).
 *
 * @param version The toolchain version this process runs on, or `undefined`.
 * @returns The flags (none off the toolchain).
 */
export function toolchainCompileFlags(version: string | undefined): string[] {
  return version === undefined ? [] : ["--exclude-unused-npm", ...toolchainRuntimeFlags(version)];
}

/** How {@linkcode denortBinary} reaches the toolchain (tests pass fakes). */
export interface DenortBinaryDeps {
  /** The toolchain version this process runs on, or `undefined` off the toolchain. */
  readonly toolchain?: () => string | undefined;
  /**
   * The pin of the toolchain this process runs (default {@linkcode shippingToolchainPin}: the pin
   * in force, or its rollback when the command that started this one ran that and the
   * revoked-runtimes list still picks it).
   */
  readonly pin?: () => DenoToolchainPin | Promise<DenoToolchainPin>;
  /**
   * Refuse a revoked denort (default: the revoked-runtimes list, `DENEXT_ALLOW_REVOKED_RUNTIME`
   * to override; src/build/runtime-revocations.ts).
   */
  readonly shippable?: (version: string, triple: string) => Promise<void>;
  /** Fetch and verify one (default {@linkcode ensureDenort}). */
  readonly ensure?: (options: { pin: DenoToolchainPin; target: string }) => Promise<
    { denort: string }
  >;
}

/**
 * The `denort` (Deno's standalone runtime) a compiled app is built on, for `target` (undefined:
 * this machine), as a path for `DENORT_BIN`: on denext's toolchain, the release's own `denort`
 * from the toolchain pin (2.9.7-denext.20 on), downloaded into the toolchain cache and
 * SHA-256-verified like the toolchain itself ({@linkcode ensureDenort}), so a compiled app has
 * `Deno.SQL` and the toolchain's patches. `undefined` — `deno compile` then picks its own — when the
 * compile runs on another Deno (`DENEXT_DENO=stock` / `=<path>`, or a `deno` given explicitly),
 * when that Deno is not the pinned version, or when the pin names no denort for the target. A
 * failed download or a hash mismatch throws: nothing is compiled onto an unverified runtime.
 *
 * @param target The `deno compile --target` triple, or undefined for this machine.
 * @param deps Test seams.
 * @returns The denort path, or undefined to let `deno compile` choose.
 */
export async function denortBinary(
  target: string | undefined,
  deps: DenortBinaryDeps = {},
): Promise<string | undefined> {
  const version = (deps.toolchain ?? toolchainVersion)();
  if (version === undefined) return undefined;
  const pin = await (deps.pin ?? (() => shippingToolchainPin()))();
  if (pin.version !== version) return undefined;
  const triple = target ?? Deno.build.target;
  const key = denortTargetKey(triple);
  if (key === undefined || !pin.denort?.[key]) return undefined;
  // Never compile onto a runtime the maintainers revoked for this target (the pin's rollback,
  // when there is one, is what this process already runs on).
  await (deps.shippable ?? shippableDenort)(version, triple);
  return (await (deps.ensure ?? ensureDenort)({ pin, target: key })).denort;
}

/** Refuse a denort the revoked-runtimes list revokes for `triple`. */
function shippableDenort(version: string, triple: string): Promise<void> {
  return assertRuntimeShippable("cli", version, triple, "compile onto");
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

/**
 * The generated entry module's source. `idleTrimBaked` tells the binary its idle trim is baked in,
 * so a `DENEXT_IDLE_TRIM=0` when it runs can still hold it off (src/build/idle-trim.ts);
 * `limitsBaked` names the `start.limits` flags baked in. With them, the module lifts the limits
 * for `job` and `db` with `Deno.disarmResourceLimits()` (denext's Deno from 3.0.0-denext.8, which
 * honours it only from the main module's own code while it evaluates, hence here and not in
 * `runStandalone`); on an older runtime, which has no such function, those verbs keep running
 * under them and say so (src/build/resource-limits.ts `bakedLimitsNotice`).
 */
export function entrySource(
  entryUrl: string,
  projectUrl: string,
  idleTrimBaked = false,
  limitsBaked: readonly string[] = [],
): string {
  const root = relativeSpecifier(entryUrl, projectUrl) ?? projectUrl;
  const lift = limitsBaked.length > 0;
  const fields = [
    ...(idleTrimBaked ? ["idleTrimBaked: true"] : []),
    ...(lift ? [`limitsBaked: ${JSON.stringify(limitsBaked)}`, "limitsLifted"] : []),
  ];
  const options = fields.length > 0 ? `, Deno.args, { ${fields.join(", ")} }` : "";
  const specifier = JSON.stringify(standaloneSpecifier(entryUrl));
  return [
    "// Generated by `denext build --compile`: the compiled app's main module. Do not edit.",
    lift
      ? `import { runStandalone, standaloneVerb } from ${specifier};`
      : `import { runStandalone } from ${specifier};`,
    "",
    ...(lift ? LIFT_LIMITS : []),
    `await runStandalone(new URL(${JSON.stringify(root)}, import.meta.url)${options});`,
    "",
  ].join("\n");
}

/**
 * The entry's lines that lift the baked `start.limits` for `job` and `db`: the runtime (denext's
 * Deno from 3.0.0-denext.8) lets only the main module's own top level do it, so it is generated
 * here; `false` on an older runtime (no function) or when it refuses.
 */
const LIFT_LIMITS = [
  "// `job` and `db` run past the server's start.limits: lift them (only this module may, now).",
  "const verb = standaloneVerb(Deno.args);",
  "let limitsLifted = false;",
  'if (verb === "job" || verb === "db") {',
  "  try {",
  "    limitsLifted =",
  "      (Deno as unknown as { disarmResourceLimits?: () => boolean }).disarmResourceLimits?.() ===",
  "        true;",
  "  } catch {",
  "    // Refused: the limits stay, and the verb says so.",
  "  }",
  "}",
  "",
];

/**
 * The framework's import map a compile carries: a checkout's (its modules import their
 * dependencies bare, resolved through its deno.json), none for a published copy — from JSR, or
 * reached by path under `vendor/jsr.io/` or `node_modules/` — whose imports are fully qualified
 * and which carries no repository deno.json to read.
 *
 * @param root The framework root URL.
 * @returns The absolutized import map, or `{}`.
 */
export async function compileFrameworkImports(
  root: string = frameworkRootUrl(),
): Promise<Record<string, string>> {
  return runsFromCheckout(root) ? await frameworkImports() : {};
}

/**
 * The deno config the compile resolves with: the app's import map (plus the framework's, for a
 * local checkout, and the build's CSS import map, so the original modules' stylesheet imports
 * resolve to their shims), every local target made relative to the written config so the binary
 * resolves it to the embedded copy; the app's lockfile and `.npmrc` beside it (./compile-lock.ts).
 */
async function writeCompileConfig(
  paths: ProjectPaths,
  dir: string,
  entryUrl: string,
): Promise<{ file: string; lock: CompileLock }> {
  const appCfg = await readConfig(paths.configPath);
  const lock = await seedCompileLock(
    paths.configPath,
    appCfg.lock,
    dir,
    standaloneSpecifier(entryUrl),
  );
  await carryNpmrc(paths.projectDir, dir);
  const css = await readConfig(join(paths.outDir, "css-config.json"));
  const cssRedirects = Object.fromEntries(
    Object.entries(css.imports ?? {}).filter(([k]) => k.endsWith(".css") || k.endsWith(".scss")),
  );
  const imports = {
    ...await compileFrameworkImports(),
    ...await readImportsAbsolute(paths.configPath),
    ...cssRedirects,
  };
  const compilerOptions = appCfg.compilerOptions ??
    (await readFrameworkJson("deno.json")).compilerOptions;
  const file = join(dir, "deno.json");
  const map = relocatableImportMap({ imports }, toFileUrl(file), dir, true) ?? { imports };
  const mapped = Object.fromEntries(
    Object.entries(map.imports ?? {}).filter(([key]) => !(key in cssRedirects)),
  );
  const configUrl = toFileUrl(file).href;
  const config: Record<string, unknown> = {
    compilerOptions,
    ...map,
    imports: {
      ...mapped,
      ...relativeCssRedirects(cssRedirects, configUrl),
      ...relativeCssRedirects(buildOnlyStubs(), configUrl),
    },
    ...resolutionSettings(appCfg, lock),
    // the project's npm supply-chain policy (paranoid, advisoryCheck, the jail) holds here too
    ...await supplyChainConfig(paths.configPath),
  };
  await Deno.writeTextFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, lock };
}

/**
 * The compile config's resolution settings from the app's: the lock copied beside it (or none, as
 * the app has none), a non-`none` `nodeModulesDir`, and the dependency-age hold.
 */
function resolutionSettings(
  appCfg: { nodeModulesDir?: unknown; minimumDependencyAge?: unknown },
  lock: CompileLock,
): Record<string, unknown> {
  const nmd = appCfg.nodeModulesDir;
  return {
    lock: lock.path ? "./deno.lock" : false,
    ...(nmd && nmd !== "none" ? { nodeModulesDir: nmd } : {}),
    // The app's dependency-age hold (a scaffold's excludes `jsr:@denext/*`), or the operator's
    // DENEXT_MIN_DEP_AGE: dropped, `deno compile` refused a just-published @denext/denext for a
    // day.
    ...minDepAgeConfig(appCfg.minimumDependencyAge),
  };
}

/**
 * The framework's build-only modules a server's graph may still reach, by framework path: the
 * plugin kit's build-step primitives (the Remix codegen included) and the public build entrypoints (`denext/build/next-compat`,
 * `denext/bundle`, `denext/build/css`), which a plugin's runtime code imports but only calls from
 * a build step.
 */
export const BUILD_ONLY_MODULES: readonly string[] = [
  "src/build/plugin-kit-build.ts",
  "src/build/remix-codegen.ts",
  "src/build/next-compat-public.ts",
  "src/build/plugin-bundle.ts",
  "src/build/plugin-css.ts",
];

/**
 * {@linkcode BUILD_ONLY_MODULES}, each mapped to ./build-only-stub.ts (their exports, the build
 * ones refusing): the binary then embeds none of the build tooling behind them (esbuild, swc,
 * lightningcss, sass, `@mdx-js/mdx`). Keys and values are the running framework's URLs: a local
 * checkout's `file:` URLs, or, for the CLI an app pins from JSR (`jsr:@denext/denext@<range>/cli`),
 * the version's `https://jsr.io/@denext/denext/<version>/…` URLs, which Deno's import map applies
 * to the package's own relative imports too. An app on another copy of denext keeps the real
 * modules (a larger binary, nothing broken).
 *
 * @param root The framework root URL (default: the running framework's, {@linkcode frameworkRootUrl}).
 * @returns Module URL → the stub's URL.
 */
export function buildOnlyStubs(root: string = frameworkRootUrl()): Record<string, string> {
  const stub = new URL("src/build/build-only-stub.ts", root).href;
  return Object.fromEntries(BUILD_ONLY_MODULES.map((m) => [new URL(m, root).href, stub]));
}

/**
 * The stylesheet → shim redirects with both sides relative to the compile config at `configUrl`
 * (the caller drops the absolute keys). Relative, they name the embedded copies at
 * run time too: a module the binary loads without a server copy (a Pages Router page) imports its
 * stylesheet at the binary's own path, which an absolute key — this checkout's — never matches.
 *
 * @param redirects The CSS import map's `.css` / `.scss` entries (absolute file URLs).
 * @param configUrl The compile config's file URL.
 * @returns The redirects, relative where both sides are local files.
 */
export function relativeCssRedirects(
  redirects: Readonly<Record<string, string>>,
  configUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(redirects)) {
    const relKey = relativeSpecifier(configUrl, key);
    const relTarget = relativeSpecifier(configUrl, target);
    out[relKey ?? key] = relTarget ?? target;
  }
  return out;
}

/** The project-relative paths to embed (those that exist), and the build entries left out. */
async function embeddedPaths(
  paths: ProjectPaths,
  compile: CompileConfig | undefined,
): Promise<{ included: string[]; skipped: string[] }> {
  const rel = (p: string) => relative(paths.projectDir, p).replaceAll("\\", "/");
  const build = await buildDirEntries(paths.outDir, rel);
  const candidates = [
    rel(paths.appDir),
    ...build.embedded,
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
  return { included: out, skipped: build.skipped };
}

/**
 * Every file under `dir` that must not be embedded, by the path `deno compile --include` sees it
 * at. Links are followed — what a linked directory holds is embedded through the link — and a
 * linked file counts by its own name and by its target's (`config.txt` → `../.env` is a `.env`).
 * `ancestors` (the real directories above this one on the walk) keeps a link cycle from looping.
 */
async function neverEmbeddedUnder(
  dir: string,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const real = await Deno.realPath(dir).catch(() => null);
  if (real === null || ancestors.has(real)) return [];
  const seen = new Set([...ancestors, real]);
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    let isDirectory = entry.isDirectory;
    let target = entry.name;
    if (entry.isSymlink) {
      const resolved = await Deno.realPath(path).catch(() => null);
      if (resolved === null) continue; // dangling: nothing to embed
      isDirectory = (await Deno.stat(resolved)).isDirectory;
      target = basename(resolved);
    }
    if (isDirectory) out.push(...await neverEmbeddedUnder(path, seen));
    else if (neverEmbedded(entry.name) || neverEmbedded(target)) out.push(path);
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
      if (neverEmbedded(basename(abs)) || neverEmbedded(basename(await Deno.realPath(abs)))) {
        out.add(p);
      }
      continue;
    }
    for (const path of await neverEmbeddedUnder(abs)) out.add(rel(path));
  }
  const outRel = rel(output);
  if (!outRel.startsWith("..")) out.add(outRel);
  return [...out].sort();
}

/**
 * Run `deno compile`, then settle its lockfile against the app's (./compile-lock.ts): a frozen
 * lock that refuses what the compile resolved leaves no binary behind.
 */
async function runDenoCompile(
  deno: string,
  args: string[],
  cwd: string,
  denort: string | undefined,
  lock: CompileLock,
  output: string,
): Promise<void> {
  const { code } = await new Deno.Command(deno, {
    args,
    cwd,
    ...(denort ? { env: { DENORT_BIN: denort } } : {}),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) throw new Error(`deno compile failed (exit ${code})`);
  try {
    await settleCompileLock(lock);
  } catch (err) {
    await Deno.remove(output).catch(() => {});
    throw err;
  }
}

/** `--sign` / `compile.sign` over the written binary (./compile-sign.ts). */
function signOutput(
  output: string,
  projectDir: string,
  compile: CompileConfig | undefined,
  permissions: readonly string[],
  options: CompileAppOptions,
): Promise<CompileSignResult | undefined> {
  return signCompiledBinary(output, {
    explicit: options.sign === true,
    config: compile?.sign,
    target: options.target ?? Deno.build.target,
    projectDir,
    ffi: permissions.some((p) => p === "--allow-all" || p.startsWith("--allow-ffi")),
  }, options.signDeps);
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
  // An app without `app/` (a Pages Router app) builds no App Router manifest; its plugins' build
  // output is the build.
  const built = await exists(join(paths.appDir))
    ? join(paths.outDir, "manifest.json")
    : paths.outDir;
  if (!(await exists(built))) {
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
  // The production server's idle trim, baked in (src/build/idle-trim.ts).
  const trimFlags = options.deno ? [] : idleTrimCompileFlags({
    runtime: toolchainVersion(),
    configOff: paths.config?.start?.idleTrim === false,
    env: readEnv,
  });
  // `start.limits`, baked in (src/build/resource-limits.ts): denort enforces them on every run of
  // the binary, `job` and `db` included, and takes no flag or variable to lift them.
  const limitFlags = compileLimitFlags(
    paths.config?.start?.limits,
    options.deno ? undefined : toolchainVersion(),
    options.warn,
  );
  await Deno.writeTextFile(
    entry,
    entrySource(entryUrl, toFileUrl(paths.projectDir + "/").href, trimFlags.length > 0, limitFlags),
  );
  const { file: config, lock } = await writeCompileConfig(paths, dir, entryUrl);
  const { included, skipped } = await embeddedPaths(paths, compile);
  const excluded = await excludedPaths(paths, included, output);
  // Only for the toolchain compile ({@linkcode onToolchain}): an explicit `deno` keeps its own.
  const denort = options.deno ? undefined : await denortBinary(options.target);
  const permissions = compilePermissionFlags(compile, denort !== undefined, options.warn);
  await Deno.mkdir(dirname(output), { recursive: true });
  const deno = options.deno ?? denoExecutable();
  const args = [
    "compile",
    "--no-check",
    "--unstable-sloppy-imports",
    ...(options.deno ? [] : [...toolchainCompileFlags(toolchainVersion()), ...trimFlags]),
    ...limitFlags,
    // start.tls with several certificates needs the unstable net APIs, and the compile config
    // above carries no `unstable` from the project's deno.json.
    ...tlsCompileFlags(paths.config?.start?.tls),
    ...permissions,
    ...minDepAgeArgs(),
    "--config",
    config,
    ...included.flatMap((p) => ["--include", p]),
    ...excluded.flatMap((p) => ["--exclude", p]),
    ...(options.target ? ["--target", options.target] : []),
    "--output",
    output,
    entry,
  ];
  await runDenoCompile(deno, args, paths.projectDir, denort, lock, output);
  const signing = await signOutput(output, paths.projectDir, compile, permissions, options);
  return { output, permissions, signing, skipped };
}
