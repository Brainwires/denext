// How `denext desktop run` and `denext desktop dev` open a window: build the app with `deno desktop`
// into a scratch directory OUTSIDE the project, then launch the built executable directly and stream
// its output until it exits.
//
// Why a build: Deno 2.9.7's `deno desktop <entry>` is a compiler. Without `--hmr` / `--inspect` it
// packages a bundle (`<name>.app` in the working directory, named from deno.json `desktop.app.name`)
// and opens no window; the permissions are the `--allow-*` flags it is given, baked into the
// binary, so a bare `deno desktop <entry>` produces an app with none (`NotCapable: PORT`). Its own
// `--hmr` run mode starts a file watcher and a framework dev server of its own, which is not the
// `denext dev` attach `desktop dev` documents.
//
// So both verbs build exactly what a packaging script builds — the same least-privilege flags from
// `desktop.capabilities` (`desktopBuildFlags`), `desktop.denoFlags`, the extension modules and the
// npm args — into a temp directory, and launch the bundle's executable (macOS: the `.app`'s
// `Contents/MacOS/<CFBundleExecutable>`, so stdout/stderr come back; Linux / Windows: the bundle's
// `<app>` / `<app>.exe`). The webview's launch settings come from `LAUFEY_*` env (an env var wins
// over the bundle's `laufey-launch.json`), so the window gets DevTools as documented and never takes
// the single-instance lock of an installed copy. A key with no env var (deno.json's
// `desktop.app.mediaCapture`) is kept out of the build ({@linkcode desktopRunConfig}).
//
// `desktop dev` builds a generated entry instead of `desktop.ts`: it marks the build as a dev build
// ({@linkcode DESKTOP_DEV_BUILD_KEY}) and then imports the real entry. A built binary is not the
// `deno` CLI, and the runtime honours `DENEXT_DESKTOP_DEV_URL` only under the CLI or in a build that
// carries that mark, which only this verb compiles in — a packaged app still ignores the env.

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
  toFileUrl,
} from "@std/path";
import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
} from "@std/path/posix";
import {
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopNpmArgs,
  type DesktopOs,
  strictPermissionsProblem,
} from "./desktop-capabilities.ts";
import { DESKTOP_DEV_BUILD_KEY } from "./desktop-dev-build.ts";
import { parseModuleForPath } from "./swc-parse.ts";
import { type Node, walkAst } from "./swc-ast.ts";
import { readJson } from "./json-edit.ts";
import { desktopAppName, desktopIconArgs } from "./desktop-package-script.ts";
import {
  desktopNetSplit,
  desktopRuntimeDenoFlags,
  projectDesktopBackend,
} from "./desktop-runtime.ts";

/** The file name of the generated `desktop dev` entry (written into the project's `.denext/`). */
export const DESKTOP_DEV_ENTRY_FILE = "desktop-dev-entry.ts";

/** What {@linkcode desktopLaunchBuildArgs} builds. */
export interface DesktopLaunchBuildInput {
  /** The least-privilege `--allow-*` flags (`desktopBuildFlags(config, os)`). */
  readonly permissionFlags: readonly string[];
  /** `desktop.denoFlags`. */
  readonly denoFlags: readonly string[];
  /** The pinned runtime's flags (`desktopRuntimeDenoFlags`; none from runtime 3.0.0-rc.5). */
  readonly runtimeFlags?: readonly string[];
  /** The extension `--include`s and the npm args (`desktopIncludeArgs` + `desktopNpmArgs`). */
  readonly extraArgs: readonly string[];
  /** `["--icon", path]` or `[]`. */
  readonly iconArgs: readonly string[];
  /** Embed the static export (`run`); `dev` proxies to the dev server and does not need it. */
  readonly includeOut: boolean;
  /** The static export embedded with `includeOut`, relative to the project (default `out`; see
   * {@linkcode desktopEntryOutDir}). */
  readonly outDir?: string;
  /** Hosts to add to `--allow-net` (`--allow-net-connect` under the split grant; `dev --lan`: the dev server's LAN address). */
  readonly netHosts?: readonly string[];
  /** `--config <file>` for the build ({@linkcode desktopRunConfig}; default none). */
  readonly configArgs?: readonly string[];
  /** The `--output` path (see {@linkcode desktopLaunchOutput}). */
  readonly output: string;
  /** The entry module, relative to the project. */
  readonly entry: string;
}

/**
 * `flags` with `hosts` added to its `--allow-net=` list (kept sorted, without duplicates). An
 * unscoped `--allow-net` already allows them; with no `--allow-net` at all one is added.
 *
 * @param flags The `--allow-*` flags.
 * @param hosts The hosts to allow.
 * @returns The flags.
 */
export function withNetHosts(flags: readonly string[], hosts: readonly string[]): string[] {
  // Under the split network grant the hosts are outbound (the window's server reaches the dev
  // server): they join `--allow-net-connect`.
  const kind = flags.some((f) => /^--allow-net-(connect|listen)(=|$)/.test(f))
    ? "--allow-net-connect"
    : "--allow-net";
  if (hosts.length === 0 || flags.includes(kind)) return [...flags];
  const at = flags.findIndex((f) => f.startsWith(`${kind}=`));
  const current = at === -1 ? [] : flags[at].slice(kind.length + 1).split(",");
  const flag = `${kind}=${[...new Set([...current, ...hosts])].filter(Boolean).sort().join(",")}`;
  if (at === -1) return [...flags, flag];
  return flags.map((f, i) => i === at ? flag : f);
}

/**
 * The `deno desktop` args (after `deno`) that build the app for `desktop run` / `dev`: the same
 * flags, in the same order, as the scaffolded packaging scripts (`--no-prompt`, the permissions,
 * `desktop.denoFlags`, the pinned runtime's flags, the export, the extensions and npm args, the icon), then the scratch
 * `--output` and the entry.
 *
 * @param input What to build.
 * @returns The args.
 */
export function desktopLaunchBuildArgs(input: DesktopLaunchBuildInput): string[] {
  return [
    "desktop",
    // A window started from a terminal could prompt, but the packaged app cannot: fail the same way.
    "--no-prompt",
    ...withNetHosts(input.permissionFlags, input.netHosts ?? []),
    ...input.denoFlags,
    ...input.runtimeFlags ?? [],
    ...(input.includeOut ? ["--include", input.outDir ?? "out"] : []),
    ...input.extraArgs,
    ...input.iconArgs,
    ...input.configArgs ?? [],
    "--output",
    input.output,
    input.entry,
  ];
}

/**
 * The bundle name `desktop run` / `dev` build under: the app's slug, made safe for every OS's
 * naming rule in `deno desktop` (Linux drops a leading `lib` and cuts the runtime library's name
 * at the last dot, so neither is kept).
 *
 * @param appName The app name (`desktop.app.name`, else `"app"`).
 * @returns The name.
 */
export function desktopLaunchName(appName: string): string {
  const slug = appName.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "app";
  return /^lib/i.test(slug) ? `app-${slug}` : slug;
}

/**
 * The `--output` path for a build in `scratch`: `<scratch>/<name>` (on macOS `deno desktop`
 * appends `.app`).
 *
 * @param scratch The scratch directory.
 * @param name {@linkcode desktopLaunchName}.
 * @returns The path.
 */
function desktopLaunchOutput(scratch: string, name: string): string {
  return join(scratch, name);
}

/**
 * Where `deno desktop --output <output>` puts the bundle: `<output>.app` on macOS, the directory
 * `<output>` on Linux and Windows.
 *
 * @param os The host OS.
 * @param output The `--output` path.
 * @returns The bundle path.
 */
export function desktopLaunchBundle(os: DesktopOs, output: string): string {
  return os === "darwin" ? `${output}.app` : output;
}

/**
 * The executable to launch in a bundle: macOS reads `CFBundleExecutable` from the `.app`'s
 * `Info.plist` (the laufey host, `Contents/MacOS/laufey_webview` on the webview backend); Linux
 * and Windows run the launcher `deno desktop` names after the bundle (`<app>`, `<app>.exe`).
 *
 * @param os The host OS.
 * @param bundle {@linkcode desktopLaunchBundle}.
 * @param readText Reads a file (injected in tests).
 * @returns The executable's path.
 * @throws {Error} When the macOS `Info.plist` names no executable.
 */
export async function desktopLaunchExecutable(
  os: DesktopOs,
  bundle: string,
  readText: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<string> {
  const name = basename(bundle);
  if (os === "windows") return join(bundle, `${name}.exe`);
  if (os === "linux") return join(bundle, name);
  const plist = await readText(join(bundle, "Contents", "Info.plist"));
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!exe) throw new Error(`no CFBundleExecutable in ${bundle}/Contents/Info.plist`);
  return join(bundle, "Contents", "MacOS", exe);
}

/**
 * A `--entry` as the project-relative path every desktop step reads it as, or an error when it is
 * not one of the project's files: the build writes beside the entry (a Node backend's bundles, and
 * drops stale ones there; the UI export) and embeds what it loads, so an entry outside the project
 * would write and delete outside it.
 *
 * @param projectDir The project.
 * @param entry The `--entry` value (relative to the project, or absolute).
 * @returns The entry, relative to the project.
 * @throws {Error} When the entry is the project itself or outside it.
 */
export function desktopProjectEntry(projectDir: string, entry: string): string {
  const abs = resolve(projectDir, entry);
  if (!isInsideDir(abs, projectDir) || resolve(abs) === resolve(projectDir)) {
    throw new Error(
      `--entry ${entry} is outside the project (${projectDir}): pass a file inside it`,
    );
  }
  // `/`-separated, as the flag is usually written (every step reads either separator).
  return relative(resolve(projectDir), abs).replaceAll(SEPARATOR, "/");
}

/** Whether `path` is `dir` or inside it. */
export function isInsideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith(SEPARATOR) && !/^[A-Za-z]:/.test(rel));
}

/**
 * A fresh scratch directory for one `desktop run` / `dev` build, outside the project (the system
 * temp dir); removed when the window exits.
 *
 * @param projectDir The project.
 * @param makeTempDir Creates the directory (injected in tests).
 * @returns The directory.
 * @throws {Error} When the temp dir is inside the project (a `TMPDIR` pointing into it).
 */
export async function desktopLaunchScratchDir(
  projectDir: string,
  makeTempDir: (options: Deno.MakeTempOptions) => Promise<string> = Deno.makeTempDir,
): Promise<string> {
  const dir = await makeTempDir({ prefix: "denext-desktop-run-" });
  if (isInsideDir(dir, projectDir)) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw new Error(
      `the temp directory ${dir} is inside the project; set TMPDIR to a directory outside it.`,
    );
  }
  return dir;
}

/**
 * The source of the generated `desktop dev` entry: set the dev-build mark, then import the real
 * entry (a literal dynamic import, so `deno desktop` embeds it; static imports would run first).
 *
 * @param entryFromDevEntry The real entry relative to the generated file (`../desktop.ts`).
 * @returns The module source.
 */
export function desktopDevEntrySource(entryFromDevEntry: string): string {
  const spec = entryFromDevEntry.replaceAll("\\", "/");
  const rel = spec.startsWith(".") ? spec : `./${spec}`;
  return "// Generated by `denext desktop dev` (rewritten each session): marks this build as a dev\n" +
    "// build, which lets it honour DENEXT_DESKTOP_DEV_URL, then runs the desktop entry.\n" +
    `(globalThis as Record<symbol, unknown>)[Symbol.for(${
      JSON.stringify(DESKTOP_DEV_BUILD_KEY)
    })] = true;\n` +
    `await import(${JSON.stringify(rel)});\n`;
}

/**
 * Write the generated `desktop dev` entry into `buildDir` (the project's `.denext/`).
 *
 * @param projectDir The project.
 * @param buildDir The project's build directory.
 * @param entry The desktop entry, relative to the project.
 * @returns The generated entry, relative to the project (what `deno desktop` is given).
 */
export async function writeDesktopDevEntry(
  projectDir: string,
  buildDir: string,
  entry: string,
): Promise<string> {
  const file = join(buildDir, DESKTOP_DEV_ENTRY_FILE);
  await Deno.mkdir(dirname(file), { recursive: true });
  await Deno.writeTextFile(
    file,
    desktopDevEntrySource(relative(dirname(file), resolve(projectDir, entry))),
  );
  return relative(projectDir, file);
}

/**
 * Where `denext desktop run` / `build` export the UI for an entry, relative to the project and
 * `/`-separated: the folder the app serves it from (`runDesktop`'s `resolveOutDir`: `out`, or the
 * literal `outDir: "<path>"` the entry passes `runDesktop`, resolved against the entry's
 * `import.meta.url`). `out` for a
 * root `desktop.ts` that passes no `outDir`, as always; `app/out` for `--entry app/desktop.ts`;
 * `ui` for a root entry with `outDir: "ui"`.
 *
 * @param projectDir The project.
 * @param entry The entry that calls `runDesktop`, relative to the project.
 * @returns The export folder, relative to the project.
 */
export async function desktopEntryOutDir(projectDir: string, entry: string): Promise<string> {
  const entryDir = posixDirname(posixNormalize(entry.replaceAll("\\", "/")));
  const outDir = await entryOutDirLiteral(projectDir, entry) ?? "out";
  if (isAbsolute(outDir)) return relative(projectDir, outDir).replaceAll("\\", "/");
  return posixNormalize(posixJoin(entryDir, outDir.replaceAll("\\", "/"))).replace(/(.)\/+$/, "$1");
}

/**
 * The literal `outDir` the entry passes `runDesktop`, else `undefined`: read from the module's
 * syntax tree, so a comment, a string or another object's `outDir` is never taken for it. The
 * options are the call's first argument, an object literal or a top-level `const` bound to one;
 * `outDir` must be a string (or a template without expressions). A spread, a computed value or
 * an unparsable entry gives `undefined` (`out`), as `runDesktop` serves without one.
 */
async function entryOutDirLiteral(projectDir: string, entry: string): Promise<string | undefined> {
  const source = await Deno.readTextFile(join(projectDir, entry)).catch(() => "");
  if (!source.includes("runDesktop")) return undefined;
  const parsed = await parseModuleForPath(entry, source);
  return parsed ? runDesktopOutDir(parsed.body) : undefined;
}

/** The `outDir` string literal of the first `runDesktop(…)` call in `body`, if any. */
function runDesktopOutDir(body: Node[]): string | undefined {
  const objects = new Map<string, Node>();
  const calls: Node[] = [];
  walkAst({ body }, (n) => {
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier") {
      if (n.init?.type === "ObjectExpression") objects.set(n.id.value, n.init);
    } else if (n.type === "CallExpression" && isRunDesktopCallee(n.callee)) {
      calls.push(n);
    }
  });
  for (const call of calls) {
    const arg = call.arguments?.[0];
    if (!arg || arg.spread) continue;
    const options = arg.expression?.type === "Identifier"
      ? objects.get(arg.expression.value)
      : arg.expression;
    if (options?.type === "ObjectExpression") return outDirProperty(options);
  }
  return undefined;
}

/** Whether a callee is `runDesktop` or `<anything>.runDesktop`. */
function isRunDesktopCallee(callee: Node): boolean {
  if (callee?.type === "Identifier") return callee.value === "runDesktop";
  return callee?.type === "MemberExpression" && callee.property?.type === "Identifier" &&
    callee.property.value === "runDesktop";
}

/** An options object's own `outDir: "<path>"` (the last one wins, as in JavaScript). */
function outDirProperty(options: Node): string | undefined {
  const props: Node[] = (options.properties ?? []).filter((p: Node) =>
    propertyName(p) === "outDir"
  );
  const found = props.length > 0 ? stringValue(props[props.length - 1].value) : undefined;
  return found || undefined;
}

/** A `key: value` property's literal key (`outDir` or `"outDir"`), else `undefined`. */
function propertyName(prop: Node): string | undefined {
  if (prop.type !== "KeyValueProperty") return undefined;
  const key = prop.key;
  return key?.type === "Identifier" || key?.type === "StringLiteral" ? key.value : undefined;
}

/** A string literal's value, or a template's without expressions; else `undefined`. */
function stringValue(value: Node): string | undefined {
  if (value?.type === "StringLiteral") return value.value;
  const plainTemplate = value?.type === "TemplateLiteral" && !value.expressions?.length;
  return plainTemplate ? quasiText(value.quasis?.[0]) : undefined;
}

/** A template element's text (swc gives `cooked` / `raw` as a string, or `{ value }`). */
function quasiText(quasi: Node): string | undefined {
  const text = quasi?.cooked ?? quasi?.raw;
  return typeof text === "string" ? text : text?.value;
}

/**
 * Why the packaged app would serve no UI, or `null`: the root `desktop.ts`, which every packaging
 * script compiles, passes `runDesktop` an `outDir` other than `out`, while the scripts export to
 * and embed `out/` (`deno task export`, `--include out`).
 *
 * @param projectDir The project.
 * @returns The message (one line), or `null`.
 */
export async function desktopPackageOutDirProblem(projectDir: string): Promise<string | null> {
  const outDir = await desktopEntryOutDir(projectDir, "desktop.ts");
  if (outDir === "out") return null;
  return `desktop.ts passes runDesktop outDir "${await entryOutDirLiteral(
    projectDir,
    "desktop.ts",
  )}" (${outDir}/), but the packaging scripts export to and embed out/, so the packaged window ` +
    "would have no UI";
}

/** What to do about {@linkcode desktopPackageOutDirProblem}. */
export const DESKTOP_PACKAGE_OUT_DIR_FIX =
  'remove outDir from desktop.ts (runDesktop serves out/ by default), or set it to "out"';

/** The `.gitignore` `denext desktop run` / `build` write into an export folder other than `out`. */
export const DESKTOP_EXPORT_GITIGNORE =
  "# The UI export of `denext desktop run` / `build` (replaced on each run).\n*\n";

/**
 * Why `denext desktop run` / `build` must not export to `outDir` (relative to the project), or
 * `null`: the export replaces the folder wholesale, so a folder other than the root `out` is used
 * only when it does not exist yet, is empty, or is already a denext export (it holds the
 * {@linkcode DESKTOP_EXPORT_GITIGNORE} or a `_denext/` folder).
 *
 * @param projectDir The project.
 * @param outDir The export folder, relative to the project.
 * @returns The message, or `null`.
 */
export async function desktopExportTargetProblem(
  projectDir: string,
  outDir: string,
): Promise<string | null> {
  if (outDir === "out") return null;
  const dir = join(projectDir, outDir);
  const info = await Deno.lstat(dir).catch(() => null);
  if (info === null) return null;
  if (!info.isDirectory) return `${outDir} exists and is not a folder`;
  const ignore = await Deno.readTextFile(join(dir, ".gitignore")).catch(() => null);
  if (ignore === DESKTOP_EXPORT_GITIGNORE) return null;
  if (await Deno.stat(join(dir, "_denext")).then((i) => i.isDirectory, () => false)) return null;
  for await (const _ of Deno.readDir(dir)) {
    return `${outDir}/ exists and is not a denext export; the export replaces it wholesale. ` +
      "Move it, or point the entry's outDir at another folder";
  }
  return null;
}

/**
 * Mark an export folder other than the root `out` as build output: write its
 * {@linkcode DESKTOP_EXPORT_GITIGNORE} (the export has just replaced the folder, so it holds
 * nothing of the user's).
 *
 * @param projectDir The project.
 * @param outDir The export folder, relative to the project.
 */
export async function markDesktopExport(projectDir: string, outDir: string): Promise<void> {
  if (outDir === "out") return;
  await Deno.writeTextFile(join(projectDir, outDir, ".gitignore"), DESKTOP_EXPORT_GITIGNORE);
}

/** A `--config` for `deno desktop` without deno.json's own media grant ({@linkcode desktopRunConfig}). */
export interface DesktopRunConfig {
  /** `["--config", <file>]`, or `[]` when deno.json sets no grant (the build reads it as it is). */
  readonly args: string[];
  /** What was left out (one line, for a warning), or `null`. */
  readonly dropped: string | null;
  /** Remove the generated file (after the build). */
  cleanup(): Promise<void>;
}

/**
 * The config an unpackaged window (`denext desktop run` / `dev`) is built with: deno.json as it is,
 * unless it sets `desktop.app.mediaCapture`. `deno desktop` writes that grant (any exact origins, a
 * loopback dev server's too) into the bundle's `laufey-launch.json`, which the window reads and no
 * `LAUFEY_*` env var overrides; denext's own grant is the packaged app's alone. So the build gets a
 * copy without the key, beside deno.json (its relative paths, lockfile and workspace resolve the
 * same), and never writes the grant: nothing inside the signed bundle is edited afterwards.
 *
 * @param projectDir The project.
 * @returns The `--config` args, the warning and the cleanup.
 */
export async function desktopRunConfig(projectDir: string): Promise<DesktopRunConfig> {
  const none: DesktopRunConfig = { args: [], dropped: null, cleanup: () => Promise.resolve() };
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await Deno.readTextFile(join(projectDir, name)).catch(() => null);
    if (text === null) continue;
    let doc: unknown;
    try {
      doc = readJson(text);
    } catch {
      return none; // `deno desktop` reports a config that does not parse.
    }
    const app = (doc as { desktop?: { app?: Record<string, unknown> } } | null)?.desktop?.app;
    if (typeof app !== "object" || app === null || !("mediaCapture" in app)) return none;
    const granted = JSON.stringify(app.mediaCapture);
    delete app.mediaCapture;
    const file = join(projectDir, `.denext-desktop-run-${crypto.randomUUID()}.deno.json`);
    await Deno.writeTextFile(file, JSON.stringify(doc, null, 2) + "\n");
    return {
      args: ["--config", file],
      dropped: `deno.json's desktop.app.mediaCapture (${granted}) is left out of this window's ` +
        "build: an unpackaged window gets no microphone / camera grant, and the packaged app's is " +
        "denext's own (desktop.capabilities.microphone / camera, the app origin alone)",
      cleanup: () => Deno.remove(file).catch(() => {}),
    };
  }
  return none;
}

/** What {@linkcode desktopLaunchBuildPlan} plans. */
export interface DesktopLaunchPlanInput {
  /** The project. */
  readonly projectDir: string;
  /** The project's loaded `denext.config.ts` (its `desktop.capabilities` give the permissions). */
  readonly config: unknown;
  /** The host OS. */
  readonly os: DesktopOs;
  /** `desktop.denoFlags`. */
  readonly denoFlags: readonly string[];
  /**
   * The build's runtime env (`resolveDesktopRuntimeEnv`): on the pinned runtime the build gets its
   * flags (`desktopRuntimeDenoFlags`), as the packaging scripts do; none when empty (stock).
   */
  readonly runtimeEnv?: Readonly<Record<string, string>>;
  /** The entry to build, relative to the project. */
  readonly entry: string;
  /**
   * The entry that calls `runDesktop`, relative to the project (default {@linkcode entry}): `desktop
   * dev` builds a generated entry that imports it. A program sidecar's `exec` is relative to its
   * folder, as the app resolves it.
   */
  readonly appEntry?: string;
  /** `desktop dev` (no export embedded) vs `desktop run`. */
  readonly dev: boolean;
  /** Hosts to add to `--allow-net` (`dev --lan`). */
  readonly netHosts?: readonly string[];
  /** Whether this build may bake the split network grant (default {@linkcode desktopNetSplit}). */
  readonly netSplit?: () => boolean;
  /** The scratch directory ({@linkcode desktopLaunchScratchDir}). */
  readonly scratch: string;
  /** Where a warning goes (default `console.warn`). */
  readonly warn?: (line: string) => void;
  /**
   * Whether the runtime checks a program sidecar's recorded hash (default
   * `desktopSidecarIntegrityRuntime()`; see `DesktopBuildFlagOptions.sidecarIntegrity`).
   */
  readonly sidecarIntegrity?: boolean;
  /** `--config <file>` for the build ({@linkcode desktopRunConfig}; default none). */
  readonly configArgs?: readonly string[];
}

/** A planned `desktop run` / `dev` build. */
export interface DesktopLaunchBuildPlan {
  /** The `deno` args. */
  readonly args: string[];
  /** The bundle the build writes. */
  readonly bundle: string;
}

/**
 * Plan the `deno desktop` build of `desktop run` / `dev`, reading the project the way the
 * packaging scripts do (a script URL in its `scripts/` folder): the permissions from
 * `desktop.capabilities`, the extension modules, the npm args, the backend for the host, the icon
 * and the app name.
 *
 * `desktop.permissions: "strict"` that cannot be honoured (no `desktop.app.identifier`, or a runtime
 * that does not expand the folder tokens) does not stop this local test build, unlike a packaging
 * build: it warns, naming the reason and the fix, and bakes the default unscoped `--allow-read` /
 * `--allow-env`, so a runtime under development (`DENEXT_DESKTOP_RUNTIME_DIR`) can still be run.
 *
 * @param input The project, config, host OS and scratch directory.
 * @returns The args and the bundle path.
 */
export async function desktopLaunchBuildPlan(
  input: DesktopLaunchPlanInput,
): Promise<DesktopLaunchBuildPlan> {
  // The packaging helpers read the project as a packaging script's parent directory.
  const scriptUrl = toFileUrl(join(input.projectDir, "scripts", "run.ts")).href;
  const output = desktopLaunchOutput(
    input.scratch,
    desktopLaunchName(await desktopAppName(scriptUrl)),
  );
  const strictProblem = strictPermissionsProblem(input.config);
  if (strictProblem !== null) {
    (input.warn ?? ((line: string) => console.warn(line)))(
      `denext: WARNING: ${strictProblem}. This local test build bakes the default (unscoped) ` +
        "--allow-read and --allow-env instead; `denext desktop package` refuses this configuration.",
    );
  }
  const args = desktopLaunchBuildArgs({
    permissionFlags: desktopBuildFlags(input.config, input.os, {
      // Dev only: a strict mode that cannot be honoured warned above and bakes the default.
      strictFallback: true,
      projectDir: input.projectDir,
      // A recorded program sidecar's embedded path is relative to the compiled entry (`desktop dev`
      // compiles `.denext/desktop-dev-entry.ts`).
      entry: input.entry,
      appEntry: input.appEntry ?? input.entry,
      ...(input.sidecarIntegrity === undefined ? {} : { sidecarIntegrity: input.sidecarIntegrity }),
      // The split network grant needs the pinned runtime (a non-empty runtime env) at 3.0.0-rc.2+.
      netSplit: Boolean(input.runtimeEnv?.DENORT_DESKTOP_BIN) &&
        (input.netSplit ?? desktopNetSplit)(),
    }),
    denoFlags: input.denoFlags,
    runtimeFlags: desktopRuntimeDenoFlags(input.runtimeEnv ?? {}, input.denoFlags),
    extraArgs: [
      ...await desktopIncludeArgs(scriptUrl, input.os, input.appEntry ?? input.entry),
      ...await desktopNpmArgs(scriptUrl),
      // The host's engine, as the runtime was fetched for (a per-OS `desktop.backend`).
      "--backend",
      await projectDesktopBackend(input.projectDir, { target: input.os, config: input.config }),
    ],
    iconArgs: await desktopIconArgs(scriptUrl, input.os),
    includeOut: !input.dev,
    // The export the app serves: `out` for a root entry, beside a nested one.
    ...(input.dev
      ? {}
      : { outDir: await desktopEntryOutDir(input.projectDir, input.appEntry ?? input.entry) }),
    netHosts: input.netHosts,
    ...(input.configArgs ? { configArgs: input.configArgs } : {}),
    output,
    entry: input.entry,
  });
  return { args, bundle: desktopLaunchBundle(input.os, output) };
}
