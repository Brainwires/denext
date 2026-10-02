// The shared plumbing of the scaffolded `scripts/package-{macos,linux,windows}.ts`: their command
// line, the tool probe, and the run's setup (installer plan, `.deno-desktop/app.json` sync, package
// metadata). Kept here — reached through `denext/desktop` — so the three scripts stay short and a
// fix reaches every project that regenerates them.

import { desktopIncludeArgs, type DesktopOs, desktopPackageFlags } from "./desktop-capabilities.ts";
import { syncDesktopAppConfig, writeLaufeyLaunchConfig } from "./desktop-app-config.ts";
import { desktopRuntimeEnv } from "./desktop-runtime.ts";
import {
  type DesktopInstallerPlan,
  desktopInstallerPlan,
  type DesktopPackageMeta,
  desktopPackageMeta,
} from "./desktop-installers.ts";

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
  const appName = await desktopAppName();
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

/**
 * The app's name for artifact paths: `DENEXT_APP_NAME`, else deno.json `desktop.app.name` in the
 * working directory, else `"app"`.
 *
 * @returns The name.
 */
export async function desktopAppName(): Promise<string> {
  const env = Deno.env.get("DENEXT_APP_NAME");
  if (env) return env;
  try {
    const n = JSON.parse(await Deno.readTextFile("deno.json"))?.desktop?.app?.name;
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no/invalid deno.json */ }
  return "app";
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
  /** Candidate icon paths; the first that exists is passed as `--icon`. */
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
    "--include",
    "out",
    ...await desktopIncludeArgs(entryUrl),
    "--target",
    o.target,
  ];
  for (const icon of o.icons) {
    if (await Deno.stat(icon).then(() => true, () => false)) {
      cmd.push("--icon", icon);
      break;
    }
  }
  cmd.push("--output", o.out, "desktop.ts");
  return cmd;
}

/**
 * Build a Linux / Windows bundle directory with `deno desktop` on denext's pinned runtime: the
 * least-privilege flags from `desktop.capabilities` (with `--no-prompt`: a packaged GUI has no TTY to
 * answer a prompt), the export and the extension modules embedded, the first existing icon, then
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
