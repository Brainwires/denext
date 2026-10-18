// denext's managed fastlane: one pinned fastlane release, run on a pinned portable Ruby, fetched on
// first need into the toolchain cache beside the managed Deno and Gleam
// (`<DENO_DIR>/denext-deno/fastlane/<fastlane version>/<target>/`):
//
//   ruby/          Homebrew's portable Ruby (the Ruby `brew` itself runs: relocatable, OpenSSL and
//                  libyaml built in), its tarball SHA-256 + size pinned per host in
//                  `fastlane-toolchain-pin.json` (regenerated, lock included, by
//                  `deno task fastlane:pin`) and verified by the toolchain's own download
//                  (`downloadPinned` in deno-toolchain.ts) before anything is extracted;
//   Gemfile, Gemfile.lock
//                  denext's pinned ones (the pin file carries both). The lock's CHECKSUMS section
//                  pins every gem's SHA-256, and Bundler refuses a gem that doesn't match it;
//   gems/          what `bundle install` (frozen to that lock) installed;
//   .denext-fastlane.json
//                  the stamp, written last.
//
// The install runs under the cache lock in a `.tmp-*` directory renamed into place, so a crash or
// a failed gem build leaves nothing that looks installed. Several of fastlane's gems build C
// extensions (bigdecimal, cgi, nkf, json, …) and none ships prebuilt, so the first install needs a
// C compiler: the Command Line Tools on macOS (Xcode has them), `cc` + `make` on Linux. Windows
// is not supported (fastlane's iOS half needs macOS and Homebrew ships no Windows Ruby).
//
// Resolution: `DENEXT_FASTLANE=<path>` (that fastlane, unverified, run as is: a team's own install
// or a `bundle exec` wrapper), else the managed one. A `fastlane` on PATH is never picked up
// implicitly. Runs are isolated from the user's Ruby setup: inherited `GEM_*`, `BUNDLE_*` and
// `RUBY*` variables are dropped and Bundler points at the cache.
//
// Plugins (`fastlane/Pluginfile`) need the project's own Gemfile: the managed fastlane runs
// denext's pinned bundle, so `denext fastlane` warns when the project lists plugins.

import { DELIMITER, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import {
  type DenoToolchainArtifact,
  denoToolchainCacheRoot,
  denoToolchainTarget,
  DenoToolchainUnavailableError,
  downloadPinned,
  type EnsureDenoToolchainOptions,
  pathOverrideStatus,
  toolchainEnvValue,
} from "./deno-toolchain.ts";
import { acquireCacheLock } from "./project-locks.ts";
import { renameRetrying } from "./desktop-runtime.ts";
import { extractArchive } from "./safe-extract.ts";
import { readJsonFile, sha256File, sweepLeftovers } from "./verified-download.ts";
import pinJson from "./fastlane-toolchain-pin.json" with { type: "json" };

/** The pinned fastlane (`fastlane-toolchain-pin.json`). */
export interface FastlaneToolchainPin {
  readonly schema: 1;
  /** The fastlane version (`2.240.1`). */
  readonly fastlane: string;
  /** When that fastlane was published (pins are at least two weeks old). */
  readonly published?: string;
  readonly ruby: {
    /** The portable Ruby's version (`4.0.7_1`). */
    readonly version: string;
    readonly source?: string;
    /** The Ruby's directory inside the tarball (`portable-ruby/4.0.7_1`). */
    readonly root: string;
    /** Per host target (`darwin-aarch64`, `linux-x86_64`, …). */
    readonly targets: Readonly<Record<string, DenoToolchainArtifact>>;
  };
  /** The Gemfile that pins fastlane. */
  readonly gemfile: string;
  /** Its lock, with a CHECKSUMS section (Bundler 2.6+). */
  readonly gemfileLock: string;
}

/** The fastlane denext pins. */
export const FASTLANE_TOOLCHAIN: FastlaneToolchainPin = pinJson as FastlaneToolchainPin;

/** `DENEXT_FASTLANE=<path>`: run that fastlane (unverified) instead of the managed one. */
export const FASTLANE_ENV = "DENEXT_FASTLANE";

/** The command that installs the managed fastlane ahead of time (for offline work). */
export const FASTLANE_PREFETCH = "denext toolchain install --with fastlane";

/**
 * A short hash of the fastlane pin (the Ruby per host, the Gemfile and its lock): the generated CI
 * workflow's cache key, so a pin bump starts a fresh cache.
 *
 * @param pin Defaults to {@linkcode FASTLANE_TOOLCHAIN}.
 * @returns 16 hex characters.
 */
export function fastlanePinHash(pin: FastlaneToolchainPin = FASTLANE_TOOLCHAIN): string {
  return createHash("sha256").update(JSON.stringify(pin)).digest("hex").slice(0, 16);
}

/** The stamp written last into an installed slot. */
const STAMP = ".denext-fastlane.json";

/** Env reader. */
type EnvGet = (k: string) => string | undefined;
const processEnv: EnvGet = (k) => {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined;
  }
};

/** What a `bundle install` run returned. */
export interface BundleRunResult {
  readonly code: number;
  /** Its combined output (the tail is shown on failure). */
  readonly output: string;
}

/** Runs a command to completion (the `bundle install` seam). */
export type BundleRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
) => Promise<BundleRunResult>;

/** Options for the managed fastlane's functions. */
export interface FastlaneToolchainOptions extends Omit<EnsureDenoToolchainOptions, "pin"> {
  /** Defaults to {@linkcode FASTLANE_TOOLCHAIN}. */
  readonly pin?: FastlaneToolchainPin;
  /** Env reader (default `Deno.env.get`). */
  readonly env?: EnvGet;
  /** The `bundle install` runner (test seam; default spawns it). */
  readonly runBundle?: BundleRunner;
  /**
   * What the gem build lacks on this host, or `null` when a C compiler is there.
   * Test seam; default {@linkcode compilerProblem}.
   */
  readonly compiler?: (os: string) => Promise<CompilerProblem | null>;
}

/** The installed managed fastlane. */
export interface ManagedFastlane {
  /** The slot (`<cache>/fastlane/<version>/<target>`). */
  readonly dir: string;
  /** The portable Ruby's `ruby`. */
  readonly ruby: string;
  readonly version: string;
  readonly target: string;
  /** Whether nothing was installed. */
  readonly cached: boolean;
}

/** How to run a fastlane: the command, the arguments before the lane's, and the environment. */
export interface FastlaneInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** The full environment for the child (already isolated for the managed one). */
  readonly env: Record<string, string>;
  /** The pinned version, or `path` under {@linkcode FASTLANE_ENV}. */
  readonly version: string;
  /** Say this once (the unverified override). */
  readonly warning?: string;
}

/** Raised on a host the managed fastlane does not run on (Windows). */
export class FastlaneUnsupportedError extends DenoToolchainUnavailableError {
  override name = "FastlaneUnsupportedError";
}

/** Raised when the gems can't be installed (no compiler, a failed build, a checksum refusal). */
export class FastlaneInstallError extends Error {
  override name = "FastlaneInstallError";
}

/** The stamp's shape. */
interface FastlaneStamp {
  readonly schema: 1;
  readonly fastlane: string;
  readonly target: string;
  readonly ruby: { readonly version: string; readonly sha256: string };
  /** SHA-256 of the Gemfile + lock the gems were installed from. */
  readonly bundleSha256: string;
  /** The extracted `ruby` binary (re-hashed by `status --verify`). */
  readonly binary: { readonly size: number; readonly sha256: string };
}

/** SHA-256 (hex) of a string. */
async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The pin's Gemfile + lock, hashed as one (a changed lock re-installs the gems). */
function bundleSha256(pin: FastlaneToolchainPin): Promise<string> {
  return sha256Text(`${pin.gemfile}\0${pin.gemfileLock}`);
}

/** The message for Windows (or another host the pin has no Ruby for). */
function unsupportedMessage(pin: FastlaneToolchainPin, target: string): string {
  const os = target.split("-")[0];
  const why = os === "windows"
    ? "fastlane does not support Windows (its iOS lanes need macOS, and denext's portable Ruby " +
      "has no Windows build). Run the lanes on macOS, or on Linux / macOS for Android (in CI, " +
      "for example)"
    : `denext's managed fastlane ${pin.fastlane} has no Ruby for ${target} (it has: ` +
      `${Object.keys(pin.ruby.targets).join(", ") || "none"})`;
  return `denext: ${why}. To run a fastlane you installed yourself, set ${FASTLANE_ENV}=<path>.`;
}

/** Where the slot for `target` lives, and its pinned Ruby (or why there is none). */
function fastlaneSlot(options: FastlaneToolchainOptions) {
  const pin = options.pin ?? FASTLANE_TOOLCHAIN;
  const target = options.target ?? denoToolchainTarget();
  const artifact = pin.ruby.targets[target];
  if (!artifact) throw new FastlaneUnsupportedError(unsupportedMessage(pin, target));
  const root = options.cacheRoot ?? denoToolchainCacheRoot(options.env ?? processEnv);
  const parent = join(root, "fastlane", pin.fastlane);
  return {
    pin,
    target,
    artifact,
    root,
    parent,
    dir: join(parent, target),
    os: options.os ?? target.split("-")[0],
  };
}

type Slot = ReturnType<typeof fastlaneSlot>;

/** The slot's `ruby`. */
function rubyPath(dir: string): string {
  return join(dir, "ruby", "bin", "ruby");
}

/** `ok` (stamp matches the pin and the files are there), `missing`, or `bad` (re-installed). */
async function slotVerdict(slot: Slot, rehash: boolean): Promise<"ok" | "missing" | "bad"> {
  const stamp = await readJsonFile<FastlaneStamp>(join(slot.dir, STAMP));
  const info = await Deno.stat(rubyPath(slot.dir)).catch(() => null);
  if (!stamp && !info) return "missing";
  if (!stamp || !(await stampMatchesPin(stamp, slot))) return "bad";
  return await slotFilesOk(slot.dir, info, stamp, rehash) ? "ok" : "bad";
}

/** Whether `stamp` records this slot's pin: the fastlane, the host, the Ruby and the bundle. */
async function stampMatchesPin(stamp: FastlaneStamp, slot: Slot): Promise<boolean> {
  const key = (s: Partial<FastlaneStamp>) =>
    JSON.stringify([s.schema, s.fastlane, s.target, s.ruby?.sha256, s.bundleSha256]);
  return key(stamp) === key({
    schema: 1,
    fastlane: slot.pin.fastlane,
    target: slot.target,
    ruby: { version: slot.pin.ruby.version, sha256: slot.artifact.sha256 },
    bundleSha256: await bundleSha256(slot.pin),
  });
}

/** Whether the stamped Ruby (size; with `rehash`, its SHA-256) and the gem tree are there. */
async function slotFilesOk(
  dir: string,
  ruby: Deno.FileInfo | null,
  stamp: FastlaneStamp,
  rehash: boolean,
): Promise<boolean> {
  if (!ruby?.isFile || ruby.size !== stamp.binary?.size) return false;
  if (!(await Deno.stat(join(dir, "gems")).catch(() => null))?.isDirectory) return false;
  return !rehash || await sha256File(rubyPath(dir)) === stamp.binary.sha256;
}

/** Whether `name` resolves to an executable on `PATH`. */
async function onPath(name: string, env: EnvGet): Promise<boolean> {
  const path = env("PATH") ?? "";
  // The host's list separator: `;` on Windows, where `:` is part of every drive path.
  for (const dir of path.split(DELIMITER)) {
    if (!dir) continue;
    const info = await Deno.stat(join(dir, name)).catch(() => null);
    if (info?.isFile && ((info.mode ?? 0o111) & 0o111) !== 0) return true;
  }
  return false;
}

/** What a gem build lacks on a host, and how to get it. */
export interface CompilerProblem {
  /** What is missing (`C compiler (cc)`, `make`, …). */
  readonly missing: string;
  /** How to install it. */
  readonly fix: string;
}

/**
 * What a gem build lacks on this host, or `null` when it has a C compiler: on macOS the Command
 * Line Tools (`xcrun --find clang`), on Linux `cc` (or `gcc`) and `make` on PATH.
 *
 * @param os The host OS.
 * @param env Env reader (for PATH).
 * @returns What is missing and how to install it, or `null`.
 */
export async function compilerProblem(
  os: string,
  env: EnvGet = processEnv,
): Promise<CompilerProblem | null> {
  if (os === "darwin") {
    const found = await new Deno.Command("xcrun", {
      args: ["--find", "clang"],
      stdout: "null",
      stderr: "null",
    }).output().then((o) => o.success, () => false);
    return found ? null : {
      missing: "C compiler",
      fix: "install the Command Line Tools (`xcode-select --install`) or Xcode",
    };
  }
  const missing: string[] = [];
  if (!(await onPath("cc", env)) && !(await onPath("gcc", env))) missing.push("C compiler (cc)");
  if (!(await onPath("make", env))) missing.push("make");
  if (missing.length === 0) return null;
  return {
    missing: missing.join(" or "),
    fix: "install them (Debian/Ubuntu: `sudo apt install build-essential`; Fedora: " +
      "`sudo dnf install gcc make`; Alpine: `apk add build-base`)",
  };
}

/** The default {@linkcode BundleRunner}: spawn it, output collected. */
const spawnBundle: BundleRunner = async (command, args, { cwd, env }) => {
  const out = await new Deno.Command(command, {
    args: [...args],
    cwd,
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  return { code: out.code, output: text };
};

/** The variables a managed run drops: a user's Ruby / Bundler setup must not leak in. */
function isRubySetupVar(name: string): boolean {
  return /^(GEM_|BUNDLE_|BUNDLER_|RUBY)/i.test(name) || name === "RBENV_VERSION" ||
    name === "RUBYOPT" || name === "RUBYLIB";
}

/**
 * The environment the managed fastlane (and its `bundle install`) runs with: `base` without the
 * user's Ruby / Bundler variables, Bundler pointed at the slot (frozen to the pinned lock), the
 * Ruby first on PATH, a UTF-8 locale when none is set, and fastlane's update check off (the version
 * is pinned).
 *
 * @param dir The slot (or the temp directory being installed).
 * @param base The environment to start from.
 * @returns The child's full environment.
 */
export function managedFastlaneEnv(
  dir: string,
  base: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (!isRubySetupVar(k)) env[k] = v;
  env.PATH = [join(dir, "ruby", "bin"), base.PATH].filter(Boolean).join(":");
  env.BUNDLE_GEMFILE = join(dir, "Gemfile");
  env.BUNDLE_PATH = join(dir, "gems");
  env.BUNDLE_APP_CONFIG = join(dir, ".bundle");
  env.BUNDLE_USER_HOME = join(dir, ".bundle-home");
  env.BUNDLE_FROZEN = "true";
  env.BUNDLE_DISABLE_SHARED_GEMS = "true";
  if (!base.LANG && !base.LC_ALL) env.LANG = "en_US.UTF-8";
  env.FASTLANE_SKIP_UPDATE_CHECK ??= "1";
  return env;
}

/** The last `n` lines of `text`. */
function tail(text: string, n: number): string {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

/** Download the pinned Ruby, verify it, and leave its tree at `<tmp>/ruby`. */
async function fetchRuby(slot: Slot, tmp: string, options: FastlaneToolchainOptions) {
  const { pin, artifact, target } = slot;
  const archive = join(tmp, artifact.file.replace(/[\\/]/g, "_"));
  const mb = artifact.size ? ` (${(artifact.size / 1024 / 1024).toFixed(1)} MB)` : "";
  (options.log ?? ((l: string) => console.error(l)))(
    `  denext: downloading the Ruby for denext's fastlane ${pin.fastlane} (${target})${mb}…`,
  );
  await downloadPinned(
    {
      artifact,
      what: "fastlane Ruby",
      offlineHint: `Run \`${FASTLANE_PREFETCH}\` once while online, or set ${FASTLANE_ENV}=<path>.`,
    },
    archive,
    options.fetch ?? fetch,
    options.log,
  );
  const extracted = join(tmp, "x");
  await extractArchive(archive, artifact.format === "zip" ? "zip" : "tar.gz", extracted);
  await Deno.remove(archive);
  const rubyRoot = join(extracted, ...pin.ruby.root.split("/"));
  if (!(await Deno.stat(join(rubyRoot, "bin", "ruby")).catch(() => null))?.isFile) {
    throw new Error(`denext: ${artifact.file} has no ${pin.ruby.root}/bin/ruby`);
  }
  await renameRetrying(rubyRoot, join(tmp, "ruby"));
  await Deno.remove(extracted, { recursive: true });
}

/** `bundle install` the pinned Gemfile + lock into `<tmp>/gems` with the Ruby in `tmp`. */
async function installGems(slot: Slot, tmp: string, options: FastlaneToolchainOptions) {
  const { pin } = slot;
  await Deno.writeTextFile(join(tmp, "Gemfile"), pin.gemfile);
  await Deno.writeTextFile(join(tmp, "Gemfile.lock"), pin.gemfileLock);
  (options.log ?? ((l: string) => console.error(l)))(
    `  denext: installing fastlane ${pin.fastlane}'s gems (checksums pinned; native extensions ` +
      "compile, which takes a few minutes)…",
  );
  const run = options.runBundle ?? spawnBundle;
  const result = await run(rubyPath(tmp), ["-S", "bundle", "install", "--jobs", "4"], {
    cwd: tmp,
    env: managedFastlaneEnv(tmp, Deno.env.toObject()),
  });
  if (result.code !== 0) {
    throw new FastlaneInstallError(
      `denext: installing fastlane ${pin.fastlane}'s gems failed (bundle install exited ` +
        `${result.code}):\n${tail(result.output, 25)}`,
    );
  }
  // The downloaded .gem files are only needed by the install.
  const gemRoot = join(tmp, "gems", "ruby");
  const abis = await Array.fromAsync(Deno.readDir(gemRoot)).catch(() => []);
  for (const e of abis) {
    await Deno.remove(join(gemRoot, e.name, "cache"), { recursive: true }).catch(() => {});
  }
}

/** Download + extract the Ruby and install the gems into `tmp`; returns the stamp. */
async function installInto(
  slot: Slot,
  tmp: string,
  options: FastlaneToolchainOptions,
): Promise<FastlaneStamp> {
  await fetchRuby(slot, tmp, options);
  await installGems(slot, tmp, options);
  const binary = rubyPath(tmp);
  return {
    schema: 1,
    fastlane: slot.pin.fastlane,
    target: slot.target,
    ruby: { version: slot.pin.ruby.version, sha256: slot.artifact.sha256 },
    bundleSha256: await bundleSha256(slot.pin),
    binary: { size: (await Deno.stat(binary)).size, sha256: await sha256File(binary) },
  };
}

/** Install the slot (the write lock is held): into `.tmp-*`, stamped, renamed into place. */
async function install(slot: Slot, options: FastlaneToolchainOptions): Promise<void> {
  const problem = await (options.compiler ?? ((os) => compilerProblem(os, options.env)))(slot.os);
  if (problem !== null) {
    throw new FastlaneInstallError(
      `denext: fastlane's gems build C extensions, and this machine has no ${problem.missing}: ` +
        `${problem.fix}. Then run \`${FASTLANE_PREFETCH}\` (or your fastlane command) again.`,
    );
  }
  await Deno.mkdir(slot.parent, { recursive: true });
  await sweepLeftovers(slot.parent);
  const tmp = await Deno.makeTempDir({ dir: slot.parent, prefix: `.tmp-${slot.target}-` });
  try {
    const stamp = await installInto(slot, tmp, options);
    await Deno.writeTextFile(join(tmp, STAMP), JSON.stringify(stamp, null, 2) + "\n");
    await Deno.remove(slot.dir, { recursive: true }).catch(() => {});
    await renameRetrying(tmp, slot.dir);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/**
 * Make the managed fastlane for this host available in the toolchain cache — the Ruby verified
 * against its pinned SHA-256, the gems against the pinned lock's checksums — and return it.
 * Throws {@linkcode FastlaneUnsupportedError} (Windows), {@linkcode FastlaneInstallError} (no
 * compiler, a failed gem build) and the toolchain's download errors.
 *
 * @param options Seams; all default to the process.
 * @returns The installed fastlane.
 */
export async function ensureFastlaneToolchain(
  options: FastlaneToolchainOptions = {},
): Promise<ManagedFastlane> {
  const slot = fastlaneSlot(options);
  const done = (cached: boolean): ManagedFastlane => ({
    dir: slot.dir,
    ruby: rubyPath(slot.dir),
    version: slot.pin.fastlane,
    target: slot.target,
    cached,
  });
  await Deno.mkdir(slot.root, { recursive: true });
  const descr = "fastlane cache";
  {
    using _shared = await acquireCacheLock(slot.root, "shared", descr);
    if (await slotVerdict(slot, false) === "ok") return done(true);
  }
  using _write = await acquireCacheLock(slot.root, "mutate", descr);
  // Re-check once granted: the process this one waited on may have installed it.
  const verdict = await slotVerdict(slot, true);
  if (verdict === "ok") return done(true);
  if (verdict === "bad") {
    (options.log ?? ((l: string) => console.error(l)))(
      `  denext: the cached fastlane at ${slot.dir} does not match its pin; re-installing.`,
    );
  }
  await install(slot, options);
  if (await slotVerdict(slot, false) !== "ok") {
    throw new Error(`denext: the fastlane at ${slot.dir} did not verify after install`);
  }
  return done(false);
}

/**
 * The fastlane `denext fastlane` runs: `DENEXT_FASTLANE=<path>` when set (it must be a file; run
 * as is with the caller's environment), else the managed one, installed on first need
 * ({@linkcode ensureFastlaneToolchain}) and run through Bundler with an isolated environment.
 *
 * @param options Seams; all default to the process.
 * @param baseEnv The environment the child starts from (default the process's).
 * @returns How to run it.
 */
export async function resolveFastlane(
  options: FastlaneToolchainOptions = {},
  baseEnv: Readonly<Record<string, string>> = Deno.env.toObject(),
): Promise<FastlaneInvocation> {
  const raw = toolchainEnvValue(options.env ?? processEnv, FASTLANE_ENV);
  if (raw !== "") {
    const path = resolve(raw);
    if (!(await Deno.stat(path).catch(() => null))?.isFile) {
      throw new DenoToolchainUnavailableError(`denext: ${FASTLANE_ENV}=${path} is not a file.`);
    }
    return {
      command: path,
      args: [],
      env: { ...baseEnv },
      version: "path",
      warning: `denext: using the fastlane at ${path} (${FASTLANE_ENV}); it is not downloaded, ` +
        "pinned or verified.",
    };
  }
  const managed = await ensureFastlaneToolchain(options);
  return {
    command: managed.ruby,
    args: ["-S", "bundle", "exec", "fastlane"],
    env: managedFastlaneEnv(managed.dir, baseEnv),
    version: managed.version,
  };
}

/**
 * The plugins a project's `fastlane/Pluginfile` lists (`gem "fastlane-plugin-…"`). The managed
 * fastlane runs denext's pinned bundle, which doesn't load them.
 *
 * @param projectDir The directory fastlane runs in.
 * @returns The plugin gem names (empty without a Pluginfile).
 */
export async function pluginfileGems(projectDir: string): Promise<string[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(projectDir, "fastlane", "Pluginfile"));
  } catch {
    return [];
  }
  return [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** The managed fastlane on this machine (`denext toolchain status`, `mobile doctor`). */
export interface FastlaneToolchainStatus {
  /** `pinned`, or `path` under `DENEXT_FASTLANE`. */
  readonly mode: "pinned" | "path";
  readonly version: string;
  readonly target: string;
  /** `cached` = installed + matches the pin; `missing` = installs on first need; `invalid` = re-installs. */
  readonly state: "cached" | "missing" | "invalid" | "unsupported" | "n/a";
  /** The slot directory, or the `DENEXT_FASTLANE` path (`null` when there is none). */
  readonly path: string | null;
  /** Whether nothing needs fixing (a missing cache is fine: it installs on first need). */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
}

const STATE_TEXT: Record<FastlaneToolchainStatus["state"], string> = {
  cached: "installed + verified",
  missing: `not installed yet (installed on first use, or now with \`${FASTLANE_PREFETCH}\`)`,
  invalid: "install does NOT match its pin (re-installed on next use)",
  unsupported: `not supported on this host (set ${FASTLANE_ENV}=<path>)`,
  "n/a": "",
};

/**
 * Report the managed fastlane: its version and whether it is installed and matches its pin. Never
 * downloads. An unsupported host (Windows) is `ok`: nothing there needs fixing until a lane runs.
 *
 * @param options Seams, plus `verify` to re-hash the installed Ruby.
 * @returns The status.
 */
export async function fastlaneToolchainStatus(
  options: FastlaneToolchainOptions & { readonly verify?: boolean } = {},
): Promise<FastlaneToolchainStatus> {
  const pin = options.pin ?? FASTLANE_TOOLCHAIN;
  const target = options.target ?? denoToolchainTarget();
  const raw = toolchainEnvValue(options.env ?? processEnv, FASTLANE_ENV);
  const base = { version: pin.fastlane, target };
  if (raw !== "") return { ...base, ...(await pathOverrideStatus(raw, FASTLANE_ENV)) };
  if (!pin.ruby.targets[target]) {
    return {
      ...base,
      mode: "pinned",
      state: "unsupported",
      path: null,
      ok: true,
      detail: `fastlane ${pin.fastlane} for ${target}; ${STATE_TEXT.unsupported}`,
    };
  }
  const slot = fastlaneSlot({ ...options, pin, target });
  const verdict = await slotVerdict(slot, options.verify === true);
  const state = verdict === "ok" ? "cached" : verdict === "bad" ? "invalid" : "missing";
  return {
    ...base,
    mode: "pinned",
    state,
    path: slot.dir,
    ok: state !== "invalid",
    detail: `fastlane ${pin.fastlane} (Ruby ${pin.ruby.version}) for ${target}; ${
      STATE_TEXT[state]
    }`,
  };
}
