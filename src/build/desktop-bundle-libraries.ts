// The packager's half of `desktop.bundle.libraries` (src/desktop/bundled-libraries.ts has the shape
// and the run-time lookup):
//
//   - `bundleDesktopLibraries`: copy each library built for the target being packaged into the
//     bundle `deno desktop` wrote (`Contents/Frameworks` in a macOS `.app`, `lib/` in a Linux
//     bundle, beside the `.exe` on Windows). Called by `buildDesktopBundle` (Linux, Windows) and by
//     scripts/package-macos.ts after each build, before signing: the macOS script's inside-out
//     signing pass then signs every Mach-O in the bundle, the libraries included, with the app's
//     identity (Hardened Runtime and a secure timestamp when it has one) before the bundle itself,
//     and the Windows script Authenticode-signs every PE file it finds in the bundle. Every
//     installer is built from the bundle directory, so each one carries them.
//   - `desktopBundledLibraryTable`: the `bundledLibraries` table the desktop sync writes into
//     `.deno-desktop/config.json` (per target, each name's project-relative file), which the running
//     app reads through `bundledLibraryPath`.
//   - `desktopLibrariesFfiNote`: `Deno.dlopen` needs `--allow-ffi`, and a baked grant can only name
//     a path known at build time; where the app gets installed is not, so the app needs the unscoped
//     grant (`desktop.extraPermissions: { ffi: ["*"] }`) or installed paths it knows.

import { fromFileUrl, join } from "@std/path";
import {
  type BundledLibraryTable,
  DESKTOP_LIBRARY_TARGETS,
  desktopBundleProblem,
  desktopLibrariesForTarget,
  desktopLibraryDir,
  type DesktopLibraryTarget,
  desktopLibraryTarget,
} from "../desktop/bundled-libraries.ts";
import { loadConfigBeside } from "./desktop-config-beside.ts";
import { desktopBuildFlags, type DesktopOs, desktopTargetArch } from "./desktop-capabilities.ts";

/** `config.desktop.bundle` (unvalidated). */
function bundleOf(config: unknown): unknown {
  return (config as { desktop?: { bundle?: unknown } } | null | undefined)?.desktop?.bundle;
}

/** `config.desktop.bundle.libraries`, after checking `desktop.bundle`; throws on a bad value. */
function librariesOf(config: unknown): unknown[] {
  const bundle = bundleOf(config);
  const problem = desktopBundleProblem(bundle);
  if (problem) throw new Error(`invalid denext config: \`${problem[0]}\` ${problem[1]}`);
  const libraries = (bundle as { libraries?: unknown[] } | undefined)?.libraries;
  return Array.isArray(libraries) ? libraries : [];
}

/** Whether `path` is a regular file (following symbolic links). */
async function isFile(path: string): Promise<boolean> {
  return await Deno.stat(path).then((i) => i.isFile, () => false);
}

/**
 * The `bundledLibraries` table for `.deno-desktop/config.json`: for every target, each library
 * whose file exists in the project, by name; with `projectDir` (a `denext desktop run` / `dev`
 * build) the project's absolute path too, so the running app answers the project's own files.
 * `undefined` when the config lists no libraries.
 *
 * @param root The project root.
 * @param config The project config.
 * @param projectDir The project, for an unpackaged build only.
 * @returns The table, or `undefined`.
 * @throws {Error} When `desktop.bundle` is invalid.
 */
export async function desktopBundledLibraryTable(
  root: string,
  config: unknown,
  projectDir?: string,
): Promise<BundledLibraryTable | undefined> {
  const libraries = librariesOf(config);
  if (libraries.length === 0) return undefined;
  const targets: Partial<Record<DesktopLibraryTarget, Record<string, string>>> = {};
  for (const target of Object.keys(DESKTOP_LIBRARY_TARGETS) as DesktopLibraryTarget[]) {
    const found: Record<string, string> = {};
    for (const lib of desktopLibrariesForTarget(libraries, target)) {
      if (await isFile(join(root, ...lib.path.split("/")))) found[lib.name] = lib.path;
    }
    if (Object.keys(found).length > 0) targets[target] = found;
  }
  return projectDir === undefined ? { targets } : { targets, projectDir };
}

/**
 * The note a package run (and `denext desktop run` / `dev`) prints for an app with
 * `desktop.bundle.libraries` whose baked `--allow-ffi` is not the unscoped grant: `Deno.dlopen` of
 * a bundled library needs `--allow-ffi`, and a scoped grant can only name paths known at build
 * time, which the installed bundle's are not. `null` when no library is configured, when the grant
 * is unscoped, or when the config or flags cannot be read (the build reports that itself).
 *
 * @param config The project config.
 * @param os The target OS.
 * @returns The note, or `null`.
 */
export function desktopLibrariesFfiNote(config: unknown, os: DesktopOs): string | null {
  let flags: string[];
  try {
    if (librariesOf(config).length === 0) return null;
    flags = desktopBuildFlags(config, os, { strictFallback: true });
  } catch {
    return null;
  }
  if (flags.includes("--allow-ffi")) return null;
  return "the bundled libraries load with Deno.dlopen, which needs --allow-ffi, and the package " +
    "bakes only paths known at build time (not where the app is installed): add " +
    'desktop.extraPermissions: { ffi: ["*"] } to denext.config.ts, or the installed paths ' +
    "(a .deb / .rpm installs them under /usr/lib/<package>/lib/)";
}

/** What {@linkcode bundleDesktopLibraries} copied, and what it skipped. */
export interface BundledDesktopLibraries {
  /** The files written into the bundle. */
  readonly copied: string[];
  /** The optional libraries skipped for want of a file (`name: path`). */
  readonly skipped: string[];
}

/**
 * Copy the app's native libraries (`desktop.bundle.libraries`) built for `target` into `bundle`:
 * `Contents/Frameworks` in a macOS `.app`, `lib/` in a Linux bundle directory, beside the `.exe` on
 * Windows. A library whose file is missing fails the run, naming the path it looked for, unless
 * its entry is `optional` (then it is skipped with a note); a file the bundle already has (one of
 * the runtime's own) is never overwritten. On macOS call it before code-signing: the script's
 * signing pass signs each library with the app's identity, inside out, before the bundle. Prints
 * {@linkcode desktopLibrariesFfiNote} when it copied any.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param os The target OS.
 * @param bundle The `.app` (macOS) or bundle directory (Linux / Windows) `deno desktop` wrote.
 * @param target The Rust target triple being built (`aarch64-apple-darwin`), or `"host"`.
 * @param log Where the notes go (default `console.log`).
 * @returns What was copied and skipped.
 * @throws {Error} When `desktop.bundle` is invalid, a required library's file is missing, or a
 *   library's file name collides with a file the bundle already has.
 */
export async function bundleDesktopLibraries(
  entryUrl: string,
  os: DesktopOs,
  bundle: string,
  target: string = "host",
  log: (line: string) => void = (line) => console.log(line),
): Promise<BundledDesktopLibraries> {
  const config = await loadConfigBeside(entryUrl);
  const libraries = librariesOf(config);
  const result: BundledDesktopLibraries = { copied: [], skipped: [] };
  if (libraries.length === 0) return result;
  const libTarget = desktopLibraryTarget(os, desktopTargetArch(target))!;
  const root = fromFileUrl(new URL("../", entryUrl));
  const dir = join(bundle, ...desktopLibraryDir(os).split("/").filter(Boolean));
  for (const lib of desktopLibrariesForTarget(libraries, libTarget)) {
    const source = join(root, ...lib.path.split("/"));
    if (!(await isFile(source))) {
      if (lib.optional) {
        result.skipped.push(`${lib.name}: ${lib.path}`);
        log(
          `  denext: no ${lib.path} for ${libTarget}: the optional library "${lib.name}" is skipped`,
        );
        continue;
      }
      throw new Error(
        `desktop.bundle.libraries: the library "${lib.name}" needs ${lib.path} for ${libTarget}, ` +
          "which does not exist: build it first, or mark the entry optional: true",
      );
    }
    const dest = join(dir, lib.file);
    if (await Deno.lstat(dest).then(() => true, () => false)) {
      throw new Error(
        `desktop.bundle.libraries: the library "${lib.name}" (${lib.file}) has the name of a file ` +
          `the bundle already has (${dest}): rename it`,
      );
    }
    await Deno.mkdir(dir, { recursive: true });
    await Deno.copyFile(source, dest);
    result.copied.push(dest);
    log(`  denext: bundled the library "${lib.name}" (${lib.path}) as ${dest}`);
  }
  const note = result.copied.length > 0 ? desktopLibrariesFfiNote(config, os) : null;
  if (note) log(`  denext: NOTE: ${note}`);
  return result;
}

/** One `libraries` finding of `denext desktop doctor` (its `DesktopDoctorFinding` shape). */
export interface LibrariesDoctorFinding {
  readonly check: "libraries";
  readonly level: "error" | "warning";
  readonly message: string;
  readonly fix: string;
}

/** What a current macOS package script calls to copy the libraries into the bundle. */
const LIBRARY_COPIERS = /\bbundleDesktopLibraries\b/;

/**
 * Why a macOS package script cannot package this project: it predates `desktop.bundle.libraries`
 * (it never calls {@linkcode bundleDesktopLibraries}), while the project configures libraries,
 * so its `.app` would ship without them. `denext desktop package` refuses it with this message;
 * `denext desktop doctor` reports it.
 *
 * @param config The loaded project config (`{ desktop }`).
 * @param scriptText The text of `scripts/package-macos.ts`.
 * @returns The message, or `null` (no library configured, or a current script).
 */
export function staleLibrariesScriptProblem(config: unknown, scriptText: string): string | null {
  if (LIBRARY_COPIERS.test(scriptText)) return null;
  const bundle = bundleOf(config);
  if (bundle === undefined || desktopBundleProblem(bundle)) return null;
  if (librariesOf(config).length === 0) return null;
  return "scripts/package-macos.ts predates desktop.bundle.libraries: its .app ships without them";
}

/**
 * The `libraries` check of `denext desktop doctor`, from the project's `desktop` config as data:
 * an invalid `desktop.bundle` (an error), a library whose file is missing for the host target
 * (packaging for it fails), a baked `--allow-ffi` that cannot load them
 * ({@linkcode desktopLibrariesFfiNote}), and a macOS package script from before the libraries
 * (it never copies them). `null` when no library is configured.
 *
 * @param dir The project directory.
 * @param desktop The project's `desktop` config (as data).
 * @param host The host's OS and architecture (default `Deno.build`'s).
 * @returns The findings, or `null`.
 */
export async function desktopLibrariesDoctorFindings(
  dir: string,
  desktop: unknown,
  host: { readonly os: string; readonly arch: string } = Deno.build,
): Promise<LibrariesDoctorFinding[] | null> {
  const config = { desktop };
  const bundle = bundleOf(config);
  if (bundle === undefined) return null;
  const problem = desktopBundleProblem(bundle);
  if (problem) {
    return [{
      check: "libraries",
      level: "error",
      message: `${problem[0]} ${problem[1]}`,
      fix: "correct desktop.bundle.libraries in denext.config.ts",
    }];
  }
  const libraries = librariesOf(config);
  if (libraries.length === 0) return null;
  const findings: LibrariesDoctorFinding[] = [];
  const target = desktopLibraryTarget(host.os, host.arch);
  for (const lib of target ? desktopLibrariesForTarget(libraries, target) : []) {
    if (lib.optional || await isFile(join(dir, ...lib.path.split("/")))) continue;
    findings.push({
      check: "libraries",
      level: "warning",
      message: `the library "${lib.name}" has no ${lib.path} for ${target}: packaging for it fails`,
      fix: "build the library for this target, or mark its entry optional: true",
    });
  }
  const os = host.os === "darwin" || host.os === "linux" || host.os === "windows"
    ? host.os
    : "linux";
  const ffi = desktopLibrariesFfiNote(config, os);
  if (ffi) {
    findings.push({
      check: "libraries",
      level: "warning",
      message: ffi,
      fix: 'add desktop.extraPermissions: { ffi: ["*"] } to denext.config.ts',
    });
  }
  const script = await Deno.readTextFile(join(dir, "scripts", "package-macos.ts")).catch(() =>
    null
  );
  const stale = script === null ? null : staleLibrariesScriptProblem(config, script);
  if (stale) {
    findings.push({
      check: "libraries",
      level: "warning",
      message: stale,
      fix: "regenerate it: denext desktop package --regenerate-scripts",
    });
  }
  return findings;
}
