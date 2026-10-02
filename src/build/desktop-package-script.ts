// The shared plumbing of the scaffolded `scripts/package-{macos,linux,windows}.ts`: their command
// line, the tool probe, and the run's setup (installer plan, `.deno-desktop/app.json` sync, package
// metadata). Kept here — reached through `denext/desktop` — so the three scripts stay short and a
// fix reaches every project that regenerates them.

import { desktopIncludeArgs, type DesktopOs, desktopPackageFlags } from "./desktop-capabilities.ts";
import { syncDesktopAppConfig, writeLaufeyLaunchConfig } from "./desktop-app-config.ts";
import { desktopDenoFlagArgs } from "./desktop-deno-flags.ts";
import { desktopRuntimeEnv } from "./desktop-runtime.ts";
import {
  type DesktopInstallerPlan,
  desktopInstallerPlan,
  type DesktopPackageMeta,
  desktopPackageMeta,
  loadConfigBeside,
  readDenoJson,
} from "./desktop-installers.ts";
import { fromFileUrl, join, toFileUrl } from "@std/path";

/** A package script's parsed command line. */
export interface DesktopPackageArgs {
  /** `--arch` (`host` unless given). */
  readonly arch: string;
  /** `false` with `--no-export` (reuse the existing `out/`). */
  readonly export: boolean;
  /** `false` with `--no-sign` (Windows: skip Authenticode even with a certificate). */
  readonly sign: boolean;
  /** `--format` values (comma lists allowed). */
  readonly formats: string[];
  /** Installers a legacy flag adds (`--dmg`, `--appimage`). */
  readonly add: string[];
}

/** What {@linkcode parseDesktopPackageArgs} accepts. */
export interface DesktopPackageArgSpec {
  /** The valid `--arch` values. */
  readonly arches: readonly string[];
  /** Legacy flags that add an installer format (`{ "--dmg": "dmg" }`). */
  readonly legacy?: Readonly<Record<string, string>>;
}

/** Apply one value-taking option (`--arch x`, `--arch=x`); returns how many args it used, or 0. */
function valueOption(
  argv: readonly string[],
  i: number,
  name: string,
  set: (v: string) => void,
): number {
  if (argv[i] === name) {
    set(argv[i + 1] ?? "");
    return 2;
  }
  if (argv[i].startsWith(`${name}=`)) {
    set(argv[i].slice(name.length + 1));
    return 1;
  }
  return 0;
}

/**
 * Parse a package script's arguments: `--arch <mode>`, `--no-export`, `--no-sign`,
 * `--format <list>` (repeatable), the script's legacy installer flags, and `-h` / `--help`.
 * An unknown argument or an `--arch` outside `spec.arches` throws.
 *
 * @param argv The script's `Deno.args`.
 * @param spec The valid arches and legacy flags.
 * @returns The parsed arguments.
 */
export function parseDesktopPackageArgs(
  argv: readonly string[],
  spec: DesktopPackageArgSpec,
): DesktopPackageArgs {
  const o = {
    arch: "host",
    export: true,
    sign: true,
    formats: [] as string[],
    add: [] as string[],
  };
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    const used = valueOption(argv, i, "--arch", (v) => o.arch = v) ||
      valueOption(argv, i, "--format", (v) => o.formats.push(v));
    if (used) {
      i += used;
      continue;
    }
    if (a === "--no-export") o.export = false;
    else if (a === "--no-sign") o.sign = false;
    else if (spec.legacy?.[a]) o.add.push(spec.legacy[a]);
    else if (a === "-h" || a === "--help") {
      console.log("See the header comment of this script for its usage.");
      Deno.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
    i++;
  }
  if (!spec.arches.includes(o.arch)) {
    throw new Error(`--arch must be one of ${spec.arches.join(", ")}`);
  }
  return o;
}

/**
 * The bundle arches a Linux / Windows run builds: both for `both`, the machine's own for `host`.
 *
 * @param arch The `--arch` value.
 * @returns The arches.
 */
export function desktopPackageArches(arch: string): Array<"x86_64" | "arm64"> {
  if (arch === "both") return ["x86_64", "arm64"];
  if (arch === "host") return [Deno.build.arch === "aarch64" ? "arm64" : "x86_64"];
  return [arch as "x86_64" | "arm64"];
}

/**
 * Whether a command is on PATH. No shell is involved: on Windows `where.exe` is run with the name
 * as one argument; elsewhere each `PATH` directory is checked for an executable file of that name.
 * A name that is not a plain command (a path separator, whitespace, a shell or wildcard character)
 * is never found.
 *
 * @param cmd The command.
 * @returns Whether it resolves.
 */
export async function desktopHasTool(cmd: string): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(cmd)) return false;
  if (Deno.build.os === "windows") {
    const probe = new Deno.Command("where.exe", { args: [cmd], stdout: "null", stderr: "null" });
    return await probe.output().then((r) => r.code === 0, () => false);
  }
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!dir) continue;
    try {
      const st = await Deno.stat(`${dir}/${cmd}`);
      if (st.isFile && st.mode !== null && (st.mode & 0o111) !== 0) return true;
    } catch { /* not in this directory */ }
  }
  return false;
}

/**
 * Whether `why` (a reason the tool for `format` cannot run, or `undefined` when it can) still
 * lets the format build: a default format is skipped with a warning, an asked-for one fails.
 *
 * @param why Why the tool is unavailable, or `undefined`.
 * @param format The installer it builds.
 * @param explicit Whether the format was asked for.
 * @returns `true` when the format can be built.
 */
export function desktopToolGate(
  why: string | undefined,
  format: string,
  explicit: boolean,
): boolean {
  if (!why) return true;
  if (explicit) throw new Error(`cannot build the ${format}: ${why}`);
  console.warn(`  ${why} — skipping the ${format}.`);
  return false;
}

/**
 * {@linkcode desktopToolGate} for a tool that must be on PATH.
 *
 * @param tool The command.
 * @param format The installer it builds.
 * @param explicit Whether the format was asked for.
 * @returns `true` when the tool is there.
 */
export async function desktopRequireTool(
  tool: string,
  format: string,
  explicit: boolean,
): Promise<boolean> {
  const why = (await desktopHasTool(tool)) ? undefined : `${tool} not found on PATH`;
  return desktopToolGate(why, format, explicit);
}

/** What {@linkcode prepareDesktopPackage} resolved. */
export interface PreparedDesktopPackage {
  /** The artifact base name ({@linkcode desktopSlug} of the app name). */
  readonly name: string;
  /** The installers to build. */
  readonly plan: DesktopInstallerPlan;
  /** What they say about the app. */
  readonly meta: DesktopPackageMeta;
}

/**
 * A package run's setup: the app name, the installer plan (`--format`, else
 * `desktop.installers.<os>`, else the defaults), the `.deno-desktop/app.json` + `compile.include`
 * sync, the package metadata (read after that sync wrote the deep links into deno.json), `dist/`,
 * and — unless `--no-export` — the static export (`deno task export`).
 *
 * @param entryUrl `import.meta.url` of the script.
 * @param os The target OS.
 * @param args The parsed arguments.
 * @returns The name, plan and metadata.
 */
export async function prepareDesktopPackage(
  entryUrl: string,
  os: DesktopOs,
  args: Pick<DesktopPackageArgs, "formats" | "add" | "export">,
): Promise<PreparedDesktopPackage> {
  const appName = await desktopAppName(entryUrl);
  const plan = await desktopInstallerPlan(entryUrl, os, args.formats, args.add);
  await syncDesktopAppConfig(entryUrl);
  const meta = await desktopPackageMeta(entryUrl, appName);
  await Deno.mkdir("dist", { recursive: true });
  if (args.export) await desktopRun(["deno", "task", "export"]);
  return { name: desktopSlug(appName), plan, meta };
}

/** Options for {@linkcode desktopRun}. */
export interface DesktopRunOptions {
  /**
   * Values that must never appear in the failure message (a certificate password a tool only
   * takes on its command line): each is shown as `***`.
   */
  readonly secrets?: readonly string[];
}

/**
 * Run a command with inherited stdio; throws on a non-zero exit. The error names the command
 * line with every {@linkcode DesktopRunOptions.secrets} value redacted.
 *
 * @param cmd The command and its arguments.
 * @param env Extra environment variables.
 * @param options Redaction.
 */
export async function desktopRun(
  cmd: string[],
  env?: Record<string, string>,
  options: DesktopRunOptions = {},
): Promise<void> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await p.output();
  if (code === 0) return;
  const secrets = (options.secrets ?? []).filter((s) => s.length > 0);
  const shown = cmd.map((a) => secrets.reduce((t, s) => t.replaceAll(s, "***"), a));
  throw new Error(`command failed (${code}): ${shown.join(" ")}`);
}

/** A script URL in the working directory's `scripts/` (what an older script's call implies). */
function cwdScriptUrl(): string {
  return toFileUrl(join(Deno.cwd(), "scripts", "package.ts")).href;
}

/** The project root of the script at `entryUrl` (its parent's parent). */
function projectRootOf(entryUrl: string): string {
  return fromFileUrl(new URL("../", entryUrl));
}

/** `desktop.app` of a parsed config / deno.json, or `{}`. */
function appOf(value: unknown): Record<string, unknown> {
  const app = (value as { desktop?: { app?: unknown } } | null | undefined)?.desktop?.app;
  return typeof app === "object" && app !== null ? app as Record<string, unknown> : {};
}

/**
 * The app's name for artifact paths: `DENEXT_APP_NAME`, else `desktop.app.name` in the project's
 * `denext.config.ts`, else deno.json `desktop.app.name`, else `"app"`.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder (default: the
 *   working directory is the project).
 * @returns The name.
 */
export async function desktopAppName(entryUrl: string = cwdScriptUrl()): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  for (const source of [await loadConfigBeside(entryUrl), await denoJsonBeside(entryUrl)]) {
    const n = appOf(source).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return "app";
}

/** The project's deno.json, parsed (`{}` when there is none or it is not a file URL). */
async function denoJsonBeside(entryUrl: string): Promise<unknown> {
  return new URL(entryUrl).protocol === "file:" ? await readDenoJson(projectRootOf(entryUrl)) : {};
}

/** The `desktop.app.icons` key of each OS. */
const ICON_KEY: Readonly<Record<DesktopOs, "macos" | "linux" | "windows">> = {
  darwin: "macos",
  linux: "linux",
  windows: "windows",
};

/** The icon files tried, in order, when neither file configures one. */
const DEFAULT_ICONS: Readonly<Record<DesktopOs, readonly string[]>> = {
  darwin: ["icons/app.icns", "icons/app.png", "desktop-icon.png"],
  linux: ["icons/app.png", "desktop-icon.png"],
  windows: ["icons/app.ico", "desktop-icon.ico"],
};

/** Whether `path` (relative to `root`) is a file. */
async function isFileAt(root: string, path: string): Promise<boolean> {
  return await Deno.stat(join(root, path)).then((st) => st.isFile, () => false);
}

/**
 * The `--icon <file>` args for `deno desktop` on `os`: `desktop.app.icons.<macos|linux|windows>` in
 * `denext.config.ts`, else the same key in deno.json, else the first of `candidates` that exists
 * (none: no icon, and `deno desktop` uses its default). Paths are relative to the project.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param os The target OS.
 * @param candidates The files tried when nothing is configured (default: `icons/app.icns` /
 *   `icons/app.png` / `icons/app.ico` for the OS, then `desktop-icon.png` / `.ico`).
 * @returns `["--icon", path]` or `[]`.
 * @throws {Error} When a configured icon does not exist.
 */
export async function desktopIconArgs(
  entryUrl: string,
  os: DesktopOs,
  candidates: readonly string[] = DEFAULT_ICONS[os],
): Promise<string[]> {
  const root = projectRootOf(entryUrl);
  const key = ICON_KEY[os];
  const sources: Array<[string, unknown]> = [
    ["denext.config.ts", await loadConfigBeside(entryUrl)],
    ["deno.json", await denoJsonBeside(entryUrl)],
  ];
  for (const [file, source] of sources) {
    const icon = (appOf(source).icons as Record<string, unknown> | undefined)?.[key];
    if (typeof icon !== "string" || icon.trim() === "") continue;
    if (!(await isFileAt(root, icon))) {
      throw new Error(`${file} desktop.app.icons.${key}: no file at ${icon}`);
    }
    return ["--icon", icon];
  }
  for (const icon of candidates) {
    if (await isFileAt(root, icon)) return ["--icon", icon];
  }
  return [];
}

/**
 * A filesystem-safe base name (spaces/punctuation → hyphens) for artifact paths.
 *
 * @param name The app name.
 * @returns The slug (`"app"` when nothing usable remains).
 */
export function desktopSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** What {@linkcode buildDesktopBundle} builds. */
export interface DesktopBundleOptions {
  /** The Rust target triple (`x86_64-unknown-linux-gnu`). */
  readonly target: string;
  /** The bundle directory to write (`dist/<name>-<label>`). */
  readonly out: string;
  /**
   * Candidate icon paths; the first that exists is passed as `--icon` when neither
   * `denext.config.ts` nor deno.json sets `desktop.app.icons.<os>` (see {@linkcode desktopIconArgs}).
   */
  readonly icons: readonly string[];
}

/**
 * The `deno desktop` command {@linkcode buildDesktopBundle} runs (relative to the project).
 *
 * @param entryUrl `import.meta.url` of the script.
 * @param os The target OS.
 * @param o The target, output and icon candidates.
 * @returns The command line.
 */
export async function desktopBundleCommand(
  entryUrl: string,
  os: "linux" | "windows",
  o: DesktopBundleOptions,
): Promise<string[]> {
  const cmd = [
    "deno",
    "desktop",
    "--no-prompt",
    ...await desktopPackageFlags(entryUrl, os),
    // `desktop.denoFlags`: the project's own allow-listed flags (`--node-modules-dir=none`, …).
    ...await desktopDenoFlagArgs(entryUrl),
    "--include",
    "out",
    ...await desktopIncludeArgs(entryUrl),
    "--target",
    o.target,
    ...await desktopIconArgs(entryUrl, os, o.icons),
  ];
  cmd.push("--output", o.out, "desktop.ts");
  return cmd;
}

/**
 * Build a Linux / Windows bundle directory with `deno desktop` on denext's pinned runtime: the
 * least-privilege flags from `desktop.capabilities` (with `--no-prompt`: a packaged GUI has no TTY to
 * answer a prompt), `desktop.denoFlags`, the export and the extension modules embedded, the first
 * existing icon, then
 * the webview backend's `laufey-launch.json` beside the executable.
 *
 * @param entryUrl `import.meta.url` of the script.
 * @param os The target OS.
 * @param o The target, output and icon candidates.
 * @returns The bundle directory.
 */
export async function buildDesktopBundle(
  entryUrl: string,
  os: "linux" | "windows",
  o: DesktopBundleOptions,
): Promise<string> {
  await Deno.remove(o.out, { recursive: true }).catch(() => {});
  const cmd = await desktopBundleCommand(entryUrl, os, o);
  // DENORT_DESKTOP_BIN + LAUFEY_DEV_DIR: denext's pinned runtime for this target (verified, cached).
  await desktopRun(cmd, await desktopRuntimeEnv(entryUrl, o.target));
  await writeLaufeyLaunchConfig(entryUrl, os, o.out);
  return o.out;
}
