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
// over a `laufey-launch.json`, and the bundle has none), so the window gets DevTools as documented
// and never takes the single-instance lock of an installed copy.
//
// `desktop dev` builds a generated entry instead of `desktop.ts`: it marks the build as a dev build
// ({@linkcode DESKTOP_DEV_BUILD_KEY}) and then imports the real entry. A built binary is not the
// `deno` CLI, and the runtime honours `DENEXT_DESKTOP_DEV_URL` only under the CLI or in a build that
// carries that mark, which only this verb compiles in — a packaged app still ignores the env.

import { basename, dirname, join, relative, resolve, SEPARATOR, toFileUrl } from "@std/path";
import {
  desktopBuildFlags,
  desktopIncludeArgs,
  desktopNpmArgs,
  type DesktopOs,
} from "./desktop-capabilities.ts";
import { DESKTOP_DEV_BUILD_KEY } from "./desktop-dev-build.ts";
import { desktopAppName, desktopIconArgs } from "./desktop-package-script.ts";

/** The file name of the generated `desktop dev` entry (written into the project's `.denext/`). */
export const DESKTOP_DEV_ENTRY_FILE = "desktop-dev-entry.ts";

/** What {@linkcode desktopLaunchBuildArgs} builds. */
export interface DesktopLaunchBuildInput {
  /** The least-privilege `--allow-*` flags (`desktopBuildFlags(config, os)`). */
  readonly permissionFlags: readonly string[];
  /** `desktop.denoFlags`. */
  readonly denoFlags: readonly string[];
  /** The extension `--include`s and the npm args (`desktopIncludeArgs` + `desktopNpmArgs`). */
  readonly extraArgs: readonly string[];
  /** `["--icon", path]` or `[]`. */
  readonly iconArgs: readonly string[];
  /** Embed the static export (`run`); `dev` proxies to the dev server and does not need it. */
  readonly includeOut: boolean;
  /** Hosts to add to `--allow-net` (`dev --lan`: the dev server's LAN address). */
  readonly netHosts?: readonly string[];
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
  if (hosts.length === 0 || flags.includes("--allow-net")) return [...flags];
  const at = flags.findIndex((f) => f.startsWith("--allow-net="));
  const current = at === -1 ? [] : flags[at].slice("--allow-net=".length).split(",");
  const flag = `--allow-net=${
    [...new Set([...current, ...hosts])].filter(Boolean).sort().join(",")
  }`;
  if (at === -1) return [...flags, flag];
  return flags.map((f, i) => i === at ? flag : f);
}

/**
 * The `deno desktop` args (after `deno`) that build the app for `desktop run` / `dev`: the same
 * flags, in the same order, as the scaffolded packaging scripts (`--no-prompt`, the permissions,
 * `desktop.denoFlags`, the export, the extensions and npm args, the icon), then the scratch
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
    ...(input.includeOut ? ["--include", "out"] : []),
    ...input.extraArgs,
    ...input.iconArgs,
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
  /** The entry to build, relative to the project. */
  readonly entry: string;
  /** `desktop dev` (no export embedded) vs `desktop run`. */
  readonly dev: boolean;
  /** Hosts to add to `--allow-net` (`dev --lan`). */
  readonly netHosts?: readonly string[];
  /** The scratch directory ({@linkcode desktopLaunchScratchDir}). */
  readonly scratch: string;
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
 * `desktop.capabilities`, the extension modules, the npm args, the icon and the app name.
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
  const args = desktopLaunchBuildArgs({
    permissionFlags: desktopBuildFlags(input.config, input.os),
    denoFlags: input.denoFlags,
    extraArgs: [
      ...await desktopIncludeArgs(scriptUrl, input.os),
      ...await desktopNpmArgs(scriptUrl),
    ],
    iconArgs: await desktopIconArgs(scriptUrl, input.os),
    includeOut: !input.dev,
    netHosts: input.netHosts,
    output,
    entry: input.entry,
  });
  return { args, bundle: desktopLaunchBundle(input.os, output) };
}
