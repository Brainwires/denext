// The shared plumbing of the scaffolded `scripts/package-{macos,linux,windows}.ts`: their command
// line, the tool probe, and the run's setup (installer plan, `.deno-desktop/app.json` sync, package
// metadata). Kept here — reached through `denext/desktop` — so the three scripts stay short and a
// fix reaches every project that regenerates them.

import { desktopPlatform, PLATFORM_ENV } from "./platform-extensions.ts";
import {
  desktopIncludeArgs,
  desktopNpmArgs,
  type DesktopOs,
  desktopPackageFlags,
} from "./desktop-capabilities.ts";
import { syncDesktopAppConfig, writeLaufeyLaunchConfig } from "./desktop-app-config.ts";
import { desktopDenoFlagArgs } from "./desktop-deno-flags.ts";
import { desktopRuntimeEnv } from "./desktop-runtime.ts";
import {
  type DesktopInstallerPlan,
  desktopInstallerPlan,
  type DesktopPackageMeta,
  desktopPackageMeta,
  desktopPackageMetaWarnings,
  linuxPackageVersion,
  loadConfigBeside,
  msiProductVersion,
  readDenoJson,
} from "./desktop-installers.ts";
import { peVersionWords, stampPeResources } from "./pe-resources.ts";
import { basename, fromFileUrl, join, toFileUrl } from "@std/path";

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

/** How to install each tool a package script shells out to. */
const TOOL_HINTS: Readonly<Record<string, string>> = {
  rpmbuild: "install rpm-build — Fedora/RHEL: sudo dnf install rpm-build; Debian/Ubuntu: " +
    "sudo apt install rpm; macOS: brew install rpm",
  appimagetool: "download it from https://github.com/AppImage/appimagetool/releases, " +
    "chmod +x it and put it on PATH",
  wix: "WiX 5: dotnet tool install --global wix --version 5.0.2 (needs the .NET SDK)",
  signtool:
    "it ships with the Windows SDK: https://developer.microsoft.com/windows/downloads/windows-sdk/",
  zip: "install zip, or use bsdtar (tar -a), which Windows 10+ and macOS include",
  tar: "install tar (GNU tar or bsdtar)",
};

/** How to install `tool` (one line), or `undefined` for a tool denext has no hint for. */
function desktopToolHint(tool: string): string | undefined {
  return TOOL_HINTS[tool];
}

/**
 * {@linkcode desktopToolGate} for a tool that must be on PATH (the reason carries the install hint).
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
  const hint = desktopToolHint(tool);
  const why = (await desktopHasTool(tool))
    ? undefined
    : `${tool} not found on PATH${hint ? ` (${hint})` : ""}`;
  return desktopToolGate(why, format, explicit);
}

/**
 * Why `version` (deno.json `version`) cannot be the package version of `format` — MSI packs
 * `major.minor.build` into 8/8/16 bits, Debian and RPM need a leading digit and a small character
 * set — or `undefined` when it can (see `msiProductVersion` / `linuxPackageVersion`).
 *
 * @param format The installer.
 * @param version The app version.
 * @returns The reason, or `undefined`.
 */
export function desktopVersionProblem(
  format: "msi" | "deb" | "rpm",
  version: string | undefined,
): string | undefined {
  try {
    if (format === "msi") msiProductVersion(version);
    else linuxPackageVersion(version);
    return undefined;
  } catch (err) {
    return `${err instanceof Error ? err.message : String(err)}; set a deno.json "version" ` +
      `the ${format === "msi" ? "MSI" : "package"} can express`;
  }
}

/** The WiX major version the `.msi` builder is pinned to (WiX 6+ carries the OSMF EULA). */
const WIX_MAJOR = 5;

/** `wix --version` (e.g. `5.0.2+aa65968c`), or `null` when `wix` does not run. */
async function wixVersion(): Promise<string | null> {
  try {
    const out = await new Deno.Command("wix", {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    })
      .output();
    return out.code === 0 ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}

/** Seams for {@linkcode desktopMsiProblem}. */
export interface DesktopMsiProbe {
  /** The host OS (default `Deno.build.os`). */
  readonly os?: string;
  /** Reads `wix --version` (`null`: not installed). */
  readonly wixVersion?: () => Promise<string | null>;
}

/**
 * Why the `.msi` cannot be built here, or `undefined` when it can: WiX runs on Windows only, the
 * app version must fit an MSI ProductVersion, and `wix` must be WiX 5 (not just present).
 *
 * @param version deno.json `version`.
 * @param probe Seams.
 * @returns The reason, or `undefined`.
 */
export async function desktopMsiProblem(
  version: string | undefined,
  probe: DesktopMsiProbe = {},
): Promise<string | undefined> {
  if ((probe.os ?? Deno.build.os) !== "windows") return "WiX builds an .msi on Windows only";
  const bad = desktopVersionProblem("msi", version);
  if (bad) return bad;
  const found = await (probe.wixVersion ?? wixVersion)();
  if (found === null) return `wix not found (${TOOL_HINTS.wix})`;
  const major = Number(/^v?(\d+)\./.exec(found)?.[1]);
  if (major === WIX_MAJOR) return undefined;
  return `wix ${found} is not WiX ${WIX_MAJOR} (WiX 6+ carries the Open Source Maintenance Fee ` +
    `EULA): dotnet tool update --global wix --version 5.0.2`;
}

/**
 * Build an installer whose failure must not sink the run when it is only a default: an asked-for
 * one (`explicit`) rethrows, a default one warns and resolves `null` (the caller falls back).
 *
 * @param format The installer, for the warning (`.msi for x86_64`).
 * @param explicit Whether it was asked for.
 * @param build Builds it.
 * @returns What `build` resolved, or `null`.
 */
export async function desktopOptionalInstaller<T>(
  format: string,
  explicit: boolean,
  build: () => Promise<T>,
): Promise<T | null> {
  try {
    return await build();
  } catch (err) {
    if (explicit) throw err;
    console.warn(
      `  building the ${format} failed (${err instanceof Error ? err.message : String(err)}) — ` +
        "skipping it; ask for it with --format to make this an error.",
    );
    return null;
  }
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
 * `desktop.installers.<os>`, else the defaults), `dist/`, unless `--no-export` the static export
 * (`deno task export`), then the `.deno-desktop/app.json` + `compile.include` + deno.json
 * `desktop.app` sync and the package metadata (read after that sync wrote the deep links into
 * deno.json; a made-up version or identifier is warned about).
 *
 * The sync runs AFTER the export, right before `deno desktop` reads deno.json: under
 * `denext desktop package` the CLI's CSS re-exec keeps a backup of the project's deno.json while the
 * script runs, and the export's own CLI restores that backup when it starts, which undid a sync
 * done before it (the bundle then took deno.json's identifier, not `denext.config.ts`'s).
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
  await Deno.mkdir("dist", { recursive: true });
  if (args.export) await desktopRun(["deno", "task", "export"], desktopExportEnv(os));
  await syncDesktopAppConfig(entryUrl);
  const meta = await desktopPackageMeta(entryUrl, appName);
  for (const line of await desktopPackageMetaWarnings(entryUrl, meta)) console.warn(line);
  return { name: desktopSlug(appName), plan, meta };
}

/**
 * The environment of a package run's `deno task export`: the TARGET OS's platform (`windows`
 * when cross-packaging from a Mac), so the export resolves its `.windows` / `.desktop` files,
 * not the host's.
 *
 * @param os The target OS.
 */
export function desktopExportEnv(os: DesktopOs): Record<string, string> {
  return { [PLATFORM_ENV]: desktopPlatform(os) };
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
    ...await desktopNpmArgs(entryUrl),
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
  if (os === "windows") {
    await desktopWindowsCefLayout(
      o.out,
      await desktopPackageMeta(entryUrl, await desktopAppName(entryUrl)),
    );
  }
  await writeLaufeyLaunchConfig(entryUrl, os, o.out);
  return o.out;
}

/**
 * The Windows CEF bundle layout behind CEF's bootstrap. A runtime whose laufey runs web content
 * in Chromium's sandbox on Windows ships CEF's `bootstrap.exe` as laufey's CEF executable and the
 * CEF host as `laufey.dll` beside it. The stock `deno desktop` (2.9.7) names the executable
 * `<App>.exe` and writes the runtime to `<App>.dll`, but the bootstrap loads its client, the
 * host, as `<App>.dll`, and the host loads the runtime as `<App>.runtime.dll`. So this moves
 * `<App>.dll` to `<App>.runtime.dll` and `laufey.dll` to `<App>.dll`, and gives `<App>.exe` the
 * app's icon (`AppIcon.ico`, when the bundle has one) and a version resource naming the app in
 * place of CEF's ("CEF bootstrap" in Task Manager otherwise). Signing comes after this.
 *
 * A bundle without `laufey.dll` (the webview backend; a CEF runtime without the sandbox, such as
 * denext.9) is left as it is.
 *
 * @param bundleDir The bundle directory `deno desktop` wrote (`dist/<name>-<label>`).
 * @param meta The package metadata: the version resource's name, publisher and version.
 * @returns Whether the bundle had the CEF bootstrap layout (and was rearranged).
 */
export async function desktopWindowsCefLayout(
  bundleDir: string,
  meta: Pick<DesktopPackageMeta, "name" | "publisher" | "version">,
): Promise<boolean> {
  const host = join(bundleDir, "laufey.dll");
  if (!(await Deno.stat(host).then((s) => s.isFile, () => false))) return false;
  const stem = basename(bundleDir);
  if (stem.toLowerCase() === "laufey") {
    throw new Error(`a CEF app can't be named "laufey": its host library takes that name`);
  }
  const exe = join(bundleDir, `${stem}.exe`);
  const runtime = join(bundleDir, `${stem}.dll`);
  await Deno.rename(runtime, join(bundleDir, `${stem}.runtime.dll`));
  await Deno.rename(host, runtime);
  const icon = await Deno.readFile(join(bundleDir, "AppIcon.ico")).catch(() => undefined);
  const version = peVersionWords(meta.version);
  await Deno.writeFile(
    exe,
    stampPeResources(await Deno.readFile(exe), {
      icon,
      version,
      strings: {
        CompanyName: meta.publisher,
        FileDescription: meta.name,
        FileVersion: version.join("."),
        InternalName: stem,
        OriginalFilename: `${stem}.exe`,
        ProductName: meta.name,
        ProductVersion: meta.version,
      },
    }),
  );
  return true;
}

/**
 * Whether a built Windows bundle runs behind CEF's bootstrap, laying it out first when the stock
 * `deno desktop` built it ({@linkcode desktopWindowsCefLayout}). A `deno desktop` that knows the
 * layout writes it itself: no `laufey.dll` is left, and the runtime is already
 * `<App>.runtime.dll`.
 *
 * @param bundleDir The bundle directory `deno desktop` wrote (`<App>/`).
 * @param meta The app's name, publisher and version, for the executable's version resource.
 * @returns Whether the bundle has the bootstrap layout.
 */
export async function desktopWindowsBootstrapBundle(
  bundleDir: string,
  meta: Pick<DesktopPackageMeta, "name" | "publisher" | "version">,
): Promise<boolean> {
  if (await desktopWindowsCefLayout(bundleDir, meta)) return true;
  return await isFileAt(bundleDir, `${basename(bundleDir)}.runtime.dll`);
}

/** How many files one `signtool sign` call takes (keeps the command line short on Windows). */
const SIGN_BATCH = 32;
/** The RFC-3161 timestamp server used when `DENEXT_SIGN_TIMESTAMP_URL` is unset. */
const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

/**
 * Whether `path` holds a PE image: `MZ`, then `PE\0\0` at the offset the DOS header's
 * `e_lfanew` names. The header decides, not the extension: an `.exe`, a `.dll`, a CEF helper or a
 * native `.node` addon are all PE files, and a renamed one still is.
 */
async function isPeFile(path: string): Promise<boolean> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return false;
  }
  try {
    const dos = new Uint8Array(64);
    if ((await file.read(dos)) !== 64 || dos[0] !== 0x4d || dos[1] !== 0x5a) return false;
    const peAt = new DataView(dos.buffer).getUint32(0x3c, true);
    if (peAt < 64 || peAt > 64 * 1024 * 1024) return false;
    await file.seek(peAt, Deno.SeekMode.Start);
    const sig = new Uint8Array(4);
    if ((await file.read(sig)) !== 4) return false;
    return sig[0] === 0x50 && sig[1] === 0x45 && sig[2] === 0 && sig[3] === 0;
  } finally {
    file.close();
  }
}

/**
 * Every PE file under a Windows bundle directory, recursively, sorted (symlinks are not
 * followed). The runtime refuses an update of a signed app unless EVERY PE file in it carries the
 * running app's signature — the `.exe`, `<App>.dll`, `WebView2Loader.dll`, the app-local VC++
 * runtime, CEF's DLLs and helpers and any `.node` addon — so all of them are signed, third-party
 * files included.
 *
 * @param dir The bundle directory.
 * @returns The PE files' paths.
 */
export async function desktopPeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const path = join(d, e.name);
      if (e.isDirectory) await walk(path);
      else if (e.isFile && await isPeFile(path)) out.push(path);
    }
  };
  await walk(dir);
  return out.sort();
}

/** What {@linkcode desktopSignWindows} runs commands and reads settings through (tests stub them). */
export interface DesktopSignWindowsDeps {
  /** Runs a command (default {@linkcode desktopRun}). */
  readonly run?: typeof desktopRun;
  /** Whether a tool resolves (default {@linkcode desktopHasTool}). */
  readonly has?: (cmd: string) => Promise<boolean>;
  /** Reads an environment variable (default `Deno.env.get`). */
  readonly env?: (name: string) => string | undefined;
  /** Prints a warning (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

/**
 * Authenticode-sign `files` with the certificate in `DENEXT_WINDOWS_CERT` (password
 * `DENEXT_WINDOWS_CERT_PASSWORD`, timestamped by `DENEXT_SIGN_TIMESTAMP_URL`), batched a few
 * dozen files per `signtool sign` call. Without a certificate, or without `signtool` (off
 * Windows), nothing is signed and a warning says so. The password, which signtool takes only as
 * `/p`, is redacted from a failure message.
 *
 * @param files The files to sign (a bundle's PE files from {@linkcode desktopPeFiles}, or an .msi).
 * @param deps The command runner, tool probe, environment and warning sink.
 * @returns Whether the files were signed.
 */
export async function desktopSignWindows(
  files: readonly string[],
  deps: DesktopSignWindowsDeps = {},
): Promise<boolean> {
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  if (files.length === 0) return false;
  const what = files.length === 1 ? files[0] : `${files.length} files`;
  const cert = env("DENEXT_WINDOWS_CERT");
  if (!cert) {
    warn(`  no DENEXT_WINDOWS_CERT set — ${what} not Authenticode-signed.`);
    return false;
  }
  if (!(await (deps.has ?? desktopHasTool)("signtool"))) {
    warn(`  signtool not found (Windows SDK) — ${what} not signed; sign on a Windows host/CI.`);
    return false;
  }
  const timestamp = env("DENEXT_SIGN_TIMESTAMP_URL") ?? DEFAULT_TIMESTAMP_URL;
  const args = ["sign", "/f", cert, "/fd", "sha256", "/tr", timestamp, "/td", "sha256"];
  const pass = env("DENEXT_WINDOWS_CERT_PASSWORD");
  if (pass) args.push("/p", pass);
  const run = deps.run ?? desktopRun;
  for (let i = 0; i < files.length; i += SIGN_BATCH) {
    await run(["signtool", ...args, ...files.slice(i, i + SIGN_BATCH)], undefined, {
      secrets: pass ? [pass] : [],
    });
  }
  return true;
}
