/**
 * The macOS Dock helper of `desktop.app.dock: "while-window-open"`, at packaging time.
 *
 * On macOS the Dock adds a tile to its recent apps whenever the running tile of an app it does not
 * keep goes away (the app quits, or a regular app turns accessory), but only for an app whose
 * bundle lives under `/Applications`. So a tray app that should show a Dock icon while its window is
 * open stays accessory itself, and a small helper app it copies out of its bundle into its data
 * folder (`~/Library/Application Support/<identifier>/dock-helper/<Name>.app`) holds the icon: a
 * regular app with no window of its own, which the tray app runs while a window shows. Activating
 * the helper (its Dock icon, Cmd-Tab) hands the activation back to the tray app.
 *
 * This module builds the helper into the packaged bundle (`Contents/Helpers/<Name>.app`, compiled
 * with clang for the architectures of the app's own executable, named and iconed like the app,
 * signed with the app by the package script), and names the grants the app needs to copy it out
 * and run it. src/desktop/dock-helper.ts is the runtime half.
 *
 * @module
 */

import { join } from "@std/path";
import { dictGet, parsePlist, type PlistNode, renderPlist, stringOf } from "./plist-value.ts";

/** The `desktop.app.dock` value that turns the helper on. */
const DOCK_HELPER_MODE = "while-window-open";
/** The folder under the app's data folder the helper is copied into. */
export const DOCK_HELPER_FOLDER = "dock-helper";
/** The folder of the packaged bundle the helper ships in. */
export const DOCK_HELPER_BUNDLE_FOLDER = "Contents/Helpers";
/** The helper's Info.plist key naming the app it belongs to (its bundle identifier). */
export const DOCK_HELPER_OWNER_KEY = "DenextDockHelperFor";
/** Appended to the app's identifier for the helper's own. */
const DOCK_HELPER_ID_SUFFIX = ".dock";
/** The environment variable that marks a launch by the app (the helper otherwise opens the app). */
export const DOCK_HELPER_ENV = "DENEXT_DOCK_HELPER";
/** The oldest macOS the helper runs on. */
const DOCK_HELPER_MIN_MACOS = "11.0";
/** The token the runtime expands to the app's data folder (src/build/desktop-capabilities.ts). */
const DATA_TOKEN = "$DENO_DESKTOP_DATA";

/** `desktop.app` of an untyped config, or `{}`. */
function appOf(config: unknown): Record<string, unknown> {
  const app = (config as { desktop?: { app?: unknown } } | null | undefined)?.desktop?.app;
  return typeof app === "object" && app !== null ? app as Record<string, unknown> : {};
}

/** A non-empty trimmed string, or `undefined`. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Whether a build for `os` carries the Dock helper: macOS, `desktop.app.dock: "while-window-open"`
 * and a `desktop.app.identifier` (the data folder the helper is copied into is named after it).
 *
 * @param config The project config.
 * @param os The target OS (`darwin`, `linux`, `windows`).
 * @returns Whether to build it.
 */
export function dockHelperWanted(config: unknown, os: string): boolean {
  const app = appOf(config);
  return os === "darwin" && app.dock === DOCK_HELPER_MODE && str(app.identifier) !== undefined;
}

/**
 * The name the helper shows in the Dock, in Cmd-Tab and to System Events: the app's
 * (`desktop.app.name` in the config, else deno.json's, else the identifier's last part).
 *
 * @param config The project config.
 * @param denoJson The project's deno.json, parsed (optional).
 * @returns The name, or `undefined` without an identifier to fall back on.
 */
export function dockHelperDisplayName(config: unknown, denoJson?: unknown): string | undefined {
  const fromConfig = str(appOf(config).name) ?? str(appOf(denoJson).name);
  if (fromConfig) return fromConfig;
  const id = str(appOf(config).identifier) ?? str(appOf(denoJson).identifier);
  return id?.split(".").filter((p) => p !== "").at(-1);
}

/**
 * The helper's bundle folder and executable name for a display name: the characters a single entry
 * of a permission list and a file name can hold (letters, digits, space, `.`, `_`, `-`), every
 * other one a `-`; never empty, never hidden.
 *
 * @param displayName The app's name.
 * @returns The file name (without `.app`).
 */
export function dockHelperFileName(displayName: string): string {
  const name = displayName.replace(/[^A-Za-z0-9 ._-]/g, "-").replace(/^[.\s]+/, "").trim();
  return name === "" ? "App" : name;
}

/** The program the app opens the helper's copy with (LaunchServices). */
const OPEN_PROGRAM = "/usr/bin/open";

/**
 * The grants the packaged app needs for its Dock helper, as baked values: `write` for the folder it
 * is copied into (`$DENO_DESKTOP_DATA/dock-helper`; the copy and its session file live there) and
 * `run` for `/usr/bin/open`, which launches the copy through LaunchServices. The copy itself is
 * never a run grant: Deno denies writes to a run path and to every folder above it, so the app
 * could not refresh a copy it runs. The connection to the helper is a loopback one, inside the
 * listen grant every desktop app has. `undefined` when the build carries no helper.
 *
 * @param config The project config.
 * @param os The target OS.
 * @returns The grants.
 */
export function dockHelperGrants(
  config: unknown,
  os: string,
): { run: string[]; write: string[] } | undefined {
  if (!dockHelperWanted(config, os)) return undefined;
  return { run: [OPEN_PROGRAM], write: [`${DATA_TOKEN}/${DOCK_HELPER_FOLDER}`] };
}

/** What the helper's Info.plist says. */
export interface DockHelperPlistOptions {
  /** The name shown (`CFBundleName`). */
  readonly displayName: string;
  /** The executable's file name. */
  readonly executable: string;
  /** The app's bundle identifier (the helper's is it plus {@linkcode DOCK_HELPER_ID_SUFFIX}). */
  readonly owner: string;
  /** `CFBundleShortVersionString` (the app's). */
  readonly version?: string;
  /** `CFBundleVersion` (the app's). */
  readonly build?: string;
  /** `CFBundleIconFile` (the app's icon, copied in), if any. */
  readonly icon?: string;
}

/**
 * The helper's Info.plist: a regular app (no `LSUIElement`), its own identifier, the app's name,
 * version and icon, and {@linkcode DOCK_HELPER_OWNER_KEY}.
 *
 * @param o The values.
 * @returns The XML.
 */
export function dockHelperInfoPlist(o: DockHelperPlistOptions): string {
  const s = (text: string): PlistNode => ({ kind: "string", text });
  const entries: Array<[string, PlistNode]> = [
    ["CFBundleDevelopmentRegion", s("en")],
    ["CFBundleExecutable", s(o.executable)],
    ["CFBundleIdentifier", s(`${o.owner}${DOCK_HELPER_ID_SUFFIX}`)],
    ["CFBundleInfoDictionaryVersion", s("6.0")],
    ["CFBundleName", s(o.displayName)],
    ["CFBundleDisplayName", s(o.displayName)],
    ["CFBundlePackageType", s("APPL")],
    ["CFBundleShortVersionString", s(o.version ?? "1.0")],
    ["CFBundleVersion", s(o.build ?? o.version ?? "1")],
    ["LSMinimumSystemVersion", s(DOCK_HELPER_MIN_MACOS)],
    ["NSHighResolutionCapable", { kind: "bool", value: true }],
    ["NSPrincipalClass", s("NSApplication")],
    [DOCK_HELPER_OWNER_KEY, s(o.owner)],
  ];
  if (o.icon) entries.splice(2, 0, ["CFBundleIconFile", s(o.icon)]);
  return renderPlist({ kind: "dict", entries });
}

/** The tools {@linkcode addMacosDockHelper} runs (tests replace them). */
export interface DockHelperBuildSeams {
  /** The architectures of a Mach-O file (`lipo -archs`). */
  archs?(file: string): Promise<string[]>;
  /** Compile the helper's source for `arch` into `out` (clang). */
  compile?(source: string, arch: string, out: string): Promise<void>;
  /** Merge per-arch executables into `out` (`lipo -create`). */
  lipo?(inputs: string[], out: string): Promise<void>;
}

/** Run a tool; throw its stderr when it fails. */
async function tool(cmd: string, args: string[], what: string): Promise<string> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  } catch (err) {
    throw new Error(`${what}: ${cmd} could not run (${err instanceof Error ? err.message : err})`);
  }
  if (!out.success) {
    throw new Error(`${what}: ${cmd} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return new TextDecoder().decode(out.stdout);
}

/** The fix printed when clang is missing. */
const CLANG_FIX = "install the Xcode Command Line Tools (`xcode-select --install`)";

const DEFAULT_SEAMS: Required<DockHelperBuildSeams> = {
  archs: async (file) =>
    (await tool("lipo", ["-archs", file], "denext: the Dock helper")).trim().split(/\s+/),
  compile: async (source, arch, out) => {
    const dir = await Deno.makeTempDir({ prefix: "denext-dock-helper-" });
    try {
      const file = join(dir, "DockHelper.m");
      await Deno.writeTextFile(file, source);
      await tool(
        "xcrun",
        [
          "clang",
          "-fobjc-arc",
          "-O2",
          "-arch",
          arch,
          `-mmacosx-version-min=${DOCK_HELPER_MIN_MACOS}`,
          "-framework",
          "Cocoa",
          file,
          "-o",
          out,
        ],
        `denext: building the Dock helper (desktop.app.dock "${DOCK_HELPER_MODE}") needs clang; ${CLANG_FIX}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
  lipo: async (inputs, out) => {
    await tool("lipo", ["-create", ...inputs, "-output", out], "denext: the Dock helper");
  },
};

/**
 * The helper's Objective-C source (src/build/native-templates/desktop-dock-helper.ts), from the
 * packed native templates, loaded only when a helper is built: this module is reached from
 * `denext/desktop`, which packaged apps run.
 *
 * @returns The source.
 */
export async function dockHelperSource(): Promise<string> {
  const { NATIVE_TEMPLATES } = await import("./native-templates.packed.ts");
  return NATIVE_TEMPLATES.desktopDockHelper.DESKTOP_DOCK_HELPER_FILES["DockHelper.m"];
}

/**
 * Build the Dock helper into a macOS `.app` that `deno desktop` wrote, when the config asks for it
 * ({@linkcode dockHelperWanted}): `Contents/Helpers/<Name>.app` with the helper compiled for the
 * architectures of the app's main executable, the app's icon, name and version. Call it before the
 * bundle is signed (the package script signs nested code first, so the helper is signed with the
 * app's identity and notarized with it). A bundle that already has one gets it replaced.
 *
 * @param config The project config.
 * @param bundle The `.app`.
 * @param denoJson The project's deno.json, parsed (optional; a name fallback).
 * @param seams The tools (tests).
 * @returns The helper bundle's path, or `undefined` when the config asks for none.
 * @throws When clang is missing or a build step fails: a packaged app that asked for the helper
 *   never ships without it.
 */
export async function addMacosDockHelper(
  config: unknown,
  bundle: string,
  denoJson?: unknown,
  seams: DockHelperBuildSeams = {},
): Promise<string | undefined> {
  if (!dockHelperWanted(config, "darwin")) return undefined;
  const app = await readAppInfo(bundle);
  const display = dockHelperDisplayName(config, denoJson) ?? app.name ?? "App";
  const file = dockHelperFileName(display);
  const helper = join(bundle, DOCK_HELPER_BUNDLE_FOLDER, `${file}.app`);
  await Deno.remove(helper, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(helper, "Contents", "MacOS"), { recursive: true });
  await Deno.mkdir(join(helper, "Contents", "Resources"), { recursive: true });
  const tools = { ...DEFAULT_SEAMS, ...seams };
  const archs = await tools.archs(join(bundle, "Contents", "MacOS", app.executable));
  await compileHelper(tools, archs, join(helper, "Contents", "MacOS", file));
  const icon = await copyAppIcon(bundle, helper, app.icon);
  await Deno.writeTextFile(join(helper, "Contents", "PkgInfo"), "APPL????");
  await Deno.writeTextFile(
    join(helper, "Contents", "Info.plist"),
    dockHelperInfoPlist({
      displayName: display,
      executable: file,
      owner: app.identifier ?? str(appOf(config).identifier)!,
      ...(app.version ? { version: app.version } : {}),
      ...(app.build ? { build: app.build } : {}),
      ...(icon ? { icon } : {}),
    }),
  );
  return helper;
}

/** What the app's Info.plist says that the helper takes over. */
interface AppInfo {
  readonly executable: string;
  readonly identifier?: string;
  readonly name?: string;
  readonly version?: string;
  readonly build?: string;
  readonly icon?: string;
}

/** The app bundle's Info.plist values the helper needs. */
async function readAppInfo(bundle: string): Promise<AppInfo> {
  const info = parsePlist(await Deno.readTextFile(join(bundle, "Contents", "Info.plist")));
  if (info.kind !== "dict") throw new Error(`${bundle}: Info.plist is not a dict`);
  const read = (key: string) => stringOf(dictGet(info, key));
  const executable = read("CFBundleExecutable");
  if (!executable) throw new Error(`${bundle}: Info.plist has no CFBundleExecutable`);
  const values: Record<string, string | undefined> = {
    identifier: read("CFBundleIdentifier"),
    name: read("CFBundleName"),
    version: read("CFBundleShortVersionString"),
    build: read("CFBundleVersion"),
    icon: read("CFBundleIconFile"),
  };
  return {
    executable,
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
  };
}

/** Compile the helper into `exe` for each of `archs` (merged with lipo when there are several). */
async function compileHelper(
  tools: Required<DockHelperBuildSeams>,
  archs: readonly string[],
  exe: string,
): Promise<void> {
  const source = await dockHelperSource();
  if (archs.length === 1) {
    await tools.compile(source, archs[0], exe);
  } else {
    const parts = archs.map((arch) => `${exe}.${arch}`);
    for (const [i, arch] of archs.entries()) await tools.compile(source, arch, parts[i]);
    await tools.lipo(parts, exe);
    for (const part of parts) await Deno.remove(part).catch(() => {});
  }
  await Deno.chmod(exe, 0o755);
}

/**
 * Copy the app's icon (`CFBundleIconFile`, `.icns` added when missing) into the helper; the name to
 * give `CFBundleIconFile`, or `undefined` (no icon: the generic one).
 */
async function copyAppIcon(
  bundle: string,
  helper: string,
  icon: string | undefined,
): Promise<string | undefined> {
  if (!icon) return undefined;
  const file = icon.endsWith(".icns") ? icon : `${icon}.icns`;
  try {
    await Deno.copyFile(
      join(bundle, "Contents", "Resources", file),
      join(helper, "Contents", "Resources", file),
    );
    return icon;
  } catch {
    return undefined;
  }
}
