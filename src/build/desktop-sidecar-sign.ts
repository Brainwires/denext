// Code-signing the native code a bundled Node backend sidecar loads at run time (the packages its
// bundle copies whole: native addons such as `pty.node`, `node-pty`'s `spawn-helper`, a prebuilt
// `.dylib`), before they are archived into `modules.pack` (see ../desktop/sidecar-modules.ts).
//
// Why here and not in the package script's bundle signing: the archive is data to `codesign`,
// `notarytool` and `signtool` alike, so nothing inside it is signed or checked when the app is; the
// app unpacks it into its cache folder and loads the files from there. Signed now, each file
// carries the app's own identity when it is loaded:
//
// - macOS, with `DENEXT_CODESIGN_IDENTITY`: every Mach-O (found by its magic, not its extension;
//   universal files sign every slice) and every code bundle inside the copies (`.app`,
//   `.framework`, `.bundle`, …) is signed innermost first with that identity, the Hardened Runtime
//   and a secure timestamp, keeping whatever entitlements it already carries (the per-file policy
//   the package script applies to nested code that is not a CEF helper), then verified. The addons
//   then pass library validation as the app's own team's code even when the main executable's
//   entitlements turn `disable-library-validation` off, and they meet the notary service's rules
//   should it ever look inside. Without an identity (an ad-hoc package), only code that carries no
//   signature at all is signed ad-hoc: Apple silicon runs no unsigned code, and a vendor's
//   signature is kept.
// - Windows, with `DENEXT_WINDOWS_CERT` / `DENEXT_WINDOWS_CERT_THUMBPRINT` (and no `--no-sign` on
//   the package script's command line): every PE file (`.node`, `.dll`, `.exe`, by header) is
//   Authenticode-signed through `desktopSignWindows`, as the bundle's own PE files are.
//
// Loaded only while packaging (the bundler imports it).

import { join } from "@std/path";
import { macosCodesignArgs, processSigningEnv, type SigningEnv } from "./code-signing.ts";
import type { DesktopOs } from "./desktop-capabilities.ts";
import { isMachO, runtimeProgram } from "./desktop-runtime.ts";
import { runToExit } from "./exited-output.ts";

/** Directory suffixes `codesign` signs as one code bundle. */
const CODE_BUNDLE_SUFFIXES = [".app", ".framework", ".bundle", ".xpc", ".appex", ".plugin"];

/**
 * Whether the folder `path` is a code bundle: its suffix, and a `Contents/Info.plist` (or, for a
 * framework, a `Versions/` folder or `Resources/Info.plist`). A package folder that merely ends
 * in `.plugin` is not one.
 */
async function isCodeBundle(path: string): Promise<boolean> {
  if (!CODE_BUNDLE_SUFFIXES.some((s) => path.endsWith(s))) return false;
  const has = (rel: string) => Deno.stat(join(path, rel)).then(() => true, () => false);
  if (await has(join("Contents", "Info.plist"))) return true;
  return path.endsWith(".framework") &&
    (await has("Versions") || await has(join("Resources", "Info.plist")));
}

/** How deep `path` sits under `root` (its number of path segments). */
function depth(path: string, root: string): number {
  return path.slice(root.length).split(/[\\/]/).filter(Boolean).length;
}

/**
 * The code to sign under `dir`, innermost first: every Mach-O file (symlinks skipped) and every
 * code bundle, deepest first, so a bundle is signed after everything inside it (`codesign`
 * refuses a bundle whose nested code is unsigned, and signing nested code afterwards would break
 * the bundle's seal). Paths at the same depth are sorted.
 *
 * @param dir The folder (a staged `node_modules` tree).
 * @returns The paths.
 */
export async function sidecarMachOTargets(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for await (const e of Deno.readDir(folder)) {
      const path = join(folder, e.name);
      if (e.isDirectory) {
        await walk(path);
        if (await isCodeBundle(path)) out.push(path);
      } else if (e.isFile && await isMachO(path)) out.push(path);
    }
  };
  await walk(dir);
  return out.sort((a, b) => depth(b, dir) - depth(a, dir) || (a < b ? -1 : a > b ? 1 : 0));
}

/** A command's exit code and its output (stdout + stderr). */
type Captured = { code: number; text: string };
/** Runs a command, its output captured. */
type Runner = (argv: readonly string[]) => Promise<Captured>;

/** What {@linkcode signSidecarNativeCode} runs commands and reads settings through (tests stub them). */
export interface SidecarSigningDeps {
  /** Runs a command (default: the program with `args`, its output captured). */
  readonly run?: Runner;
  /** Whether a program resolves on `PATH` (default: `codesign` / `signtool` probed by running). */
  readonly has?: (cmd: string) => Promise<boolean>;
  /** Reads a signing variable (default the environment). */
  readonly env?: SigningEnv;
  /** The package script's arguments (default `Deno.args`): `--no-sign` skips Windows signing. */
  readonly args?: readonly string[];
  /** Authenticode-signs PE files (default `desktopSignWindows`); whether it signed. */
  readonly signWindows?: (files: readonly string[]) => Promise<boolean>;
  /** Lists the PE files under a folder (default `desktopPeFiles`). */
  readonly peFiles?: (dir: string) => Promise<string[]>;
}

/** What {@linkcode signSidecarNativeCode} did. */
export interface SidecarSigningReport {
  /** `"identity"` (macOS Developer ID), `"ad-hoc"`, `"authenticode"`, or `"none"`. */
  readonly how: "identity" | "ad-hoc" | "authenticode" | "none";
  /** The files and bundles signed, in signing order. */
  readonly signed: readonly string[];
}

/** Nothing signed. */
const NOTHING: SidecarSigningReport = { how: "none", signed: [] };

/** Run `argv` with its output captured (`codesign` from the OS's own tool folder, never PATH). */
async function capture(argv: readonly string[]): Promise<Captured> {
  const out = await runToExit(runtimeProgram(argv[0]), { args: argv.slice(1) });
  const d = new TextDecoder();
  return { code: out.code, text: d.decode(out.stdout) + d.decode(out.stderr) };
}

/** Whether `cmd` can be started at all (as {@linkcode capture} would start it). */
async function canRun(cmd: string): Promise<boolean> {
  try {
    await runToExit(runtimeProgram(cmd), { args: [], stdout: "null", stderr: "null" });
    return true;
  } catch {
    return false;
  }
}

/** Run `argv`; throw with its output when it fails. */
async function runOrThrow(run: Runner, argv: readonly string[]): Promise<void> {
  const r = await run(argv);
  if (r.code !== 0) {
    throw new Error(`denext: ${argv.join(" ")} failed (exit ${r.code}): ${r.text.trim()}`);
  }
}

/** The macOS identity in `DENEXT_CODESIGN_IDENTITY`, or `undefined` for an ad-hoc signature. */
function macosIdentity(deps: SidecarSigningDeps): string | undefined {
  const raw = (deps.env ?? processSigningEnv)("DENEXT_CODESIGN_IDENTITY");
  return raw && raw !== "-" ? raw : undefined;
}

/** Ad-hoc sign each of `targets` that carries no signature at all; the ones signed. */
async function signUnsignedAdHoc(targets: readonly string[], run: Runner): Promise<string[]> {
  const signed: string[] = [];
  for (const t of targets) {
    if (!(await run(["codesign", "-dv", t])).text.includes("not signed at all")) continue;
    await runOrThrow(run, ["codesign", "--force", "--sign", "-", t]);
    signed.push(t);
  }
  return signed;
}

/** Sign each of `targets` with `identity` (Hardened Runtime, timestamp, entitlements kept), then verify. */
async function signWithIdentity(
  targets: readonly string[],
  identity: string,
  run: Runner,
): Promise<void> {
  const entitlementArgs = ["--preserve-metadata=entitlements"];
  for (const t of targets) {
    await runOrThrow(run, macosCodesignArgs(t, { identity, entitlementArgs }));
  }
  for (const t of targets) await runOrThrow(run, ["codesign", "--verify", "--strict", t]);
}

/** macOS: sign the Mach-O code under `dir` (see the module comment). */
async function signMacos(dir: string, deps: SidecarSigningDeps): Promise<SidecarSigningReport> {
  const targets = await sidecarMachOTargets(dir);
  if (targets.length === 0) return NOTHING;
  const identity = macosIdentity(deps);
  if (!await (deps.has ?? canRun)("codesign")) {
    if (!identity) return NOTHING;
    throw new Error(
      "denext: DENEXT_CODESIGN_IDENTITY is set but codesign is not available, so the sidecar's " +
        "native addons can't be signed: package the macOS app on a Mac with the Xcode command " +
        "line tools.",
    );
  }
  const run = deps.run ?? capture;
  if (!identity) return { how: "ad-hoc", signed: await signUnsignedAdHoc(targets, run) };
  await signWithIdentity(targets, identity, run);
  return { how: "identity", signed: targets };
}

/** Whether a Windows certificate is configured and the package script was not run `--no-sign`. */
function windowsSigningWanted(deps: SidecarSigningDeps): boolean {
  const env = deps.env ?? processSigningEnv;
  const cert = env("DENEXT_WINDOWS_CERT") ?? env("DENEXT_WINDOWS_CERT_THUMBPRINT");
  return cert !== undefined && !(deps.args ?? Deno.args).includes("--no-sign");
}

/** Windows: Authenticode-sign the PE files under `dir` when a certificate is configured. */
async function signWindows(dir: string, deps: SidecarSigningDeps): Promise<SidecarSigningReport> {
  if (!windowsSigningWanted(deps)) return NOTHING;
  // The Windows signing helpers live with the package script's (loaded only when needed).
  const script = await import("./desktop-package-script.ts");
  const files = await (deps.peFiles ?? script.desktopPeFiles)(dir);
  if (files.length === 0) return NOTHING;
  const env = deps.env ?? processSigningEnv;
  const sign = deps.signWindows ??
    ((f: readonly string[]) => script.desktopSignWindows(f, { env: (n) => env(n) }));
  return await sign(files) ? { how: "authenticode", signed: files } : NOTHING;
}

/**
 * Sign the native code under `dir` (a sidecar's staged packages) for the OS packaged for: macOS
 * Mach-O with `DENEXT_CODESIGN_IDENTITY` (or ad-hoc where unsigned), Windows PE files with
 * `DENEXT_WINDOWS_CERT`; Linux has nothing to sign. See the module comment.
 *
 * @param dir The folder.
 * @param os The OS packaged for.
 * @param deps The command runner, tool probe and environment (tests stub them).
 * @returns What was signed.
 */
export async function signSidecarNativeCode(
  dir: string,
  os: DesktopOs,
  deps: SidecarSigningDeps = {},
): Promise<SidecarSigningReport> {
  if (os === "darwin") return await signMacos(dir, deps);
  if (os === "windows") return await signWindows(dir, deps);
  return NOTHING;
}
