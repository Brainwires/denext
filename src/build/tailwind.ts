// Tailwind CSS, driven by denext. We download and manage the Tailwind v4
// *standalone* binary (a self-contained executable, no npm) and run it to compile
// the project's Tailwind input into a plain CSS file that denext's own CSS
// pipeline then consumes. This keeps the zero-runtime-npm-dependency rule (the
// binary is a build-time tool, like the @denext/lightningcss wasm) while giving projects
// first-class Tailwind support.

import { runToExit } from "./exited-output.ts";
import { isAbsolute, join, resolve } from "@std/path";
import { userHomeDir } from "./deno-cache-dir.ts";
import { denoExecutable } from "./deno-executable.ts";
import { ensureDir } from "@std/fs";
import { repairAdhocSignature } from "./macho-adhoc.ts";
import type { TailwindConfig } from "../server/config.ts";

/**
 * Pinned Tailwind standalone version. Overridable with `DENEXT_TAILWIND_VERSION`
 * (e.g. `v4.1.11`) if a project needs a different release.
 */
export const DEFAULT_TAILWIND_VERSION = "v4.3.0";

/** The Tailwind standalone release version to use (env override or the default). */
export function tailwindVersion(): string {
  return Deno.env.get("DENEXT_TAILWIND_VERSION") ?? DEFAULT_TAILWIND_VERSION;
}

/**
 * Map a Deno `(os, arch)` pair to the Tailwind standalone release asset name.
 * Throws for platforms Tailwind does not publish a standalone binary for. Windows on Arm takes the
 * x64 build: Tailwind publishes no Arm64 one for Windows, and Windows 11 on Arm runs x64 binaries.
 *
 * @param os `Deno.build.os` (e.g. `"darwin"`, `"linux"`, `"windows"`).
 * @param arch `Deno.build.arch` (`"x86_64"` or `"aarch64"`).
 */
export function tailwindAssetName(os: string, arch: string): string {
  const cpu = arch === "aarch64" ? "arm64" : arch === "x86_64" ? "x64" : null;
  if (!cpu) throw new Error(`Tailwind: unsupported architecture "${arch}".`);
  switch (os) {
    case "darwin":
      return `tailwindcss-macos-${cpu}`;
    case "linux":
      return `tailwindcss-linux-${cpu}`;
    case "windows":
      return "tailwindcss-windows-x64.exe";
    default:
      throw new Error(`Tailwind: unsupported OS "${os}".`);
  }
}

/** GitHub release download URL for a Tailwind standalone asset. */
export function tailwindDownloadUrl(version: string, asset: string): string {
  return `https://github.com/tailwindlabs/tailwindcss/releases/download/${version}/${asset}`;
}

/** Cache directory denext stores downloaded Tailwind binaries in. */
function cacheDir(): string {
  const xdg = Deno.env.get("XDG_CACHE_HOME");
  const home = userHomeDir();
  const base = xdg && isAbsolute(xdg) ? xdg : home ? join(home, ".cache") : undefined;
  if (!base) {
    // Never the working directory: a repository could ship the binary there.
    throw new Error(
      "denext: no cache directory for the Tailwind binary — set HOME (or XDG_CACHE_HOME) to an " +
        "absolute path.",
    );
  }
  return join(base, "denext", "tailwind", tailwindVersion());
}

/** Seams of {@linkcode resolveTailwindBin} (all default to the process). */
interface ResolveTailwindBinOptions {
  /** The cache directory (default: `$XDG_CACHE_HOME/denext/tailwind/<version>`). */
  readonly cacheDir?: string;
  /** The OS (default `Deno.build.os`). */
  readonly os?: string;
  /** The CPU architecture (default `Deno.build.arch`). */
  readonly arch?: string;
  /** The fetch to download with. */
  readonly fetch?: typeof fetch;
  /** Where the download is announced (default `console.log`). */
  readonly log?: (line: string) => void;
}

/**
 * The binaries this process already checked, keyed `<path>\0<release pin>`: re-checked when the
 * pin changes (another `DENEXT_TAILWIND_VERSION` / `DENEXT_TAILWIND_SHA256`), not on every compile.
 */
const verifiedBins = new Set<string>();

/**
 * Whether the cached binary at `dest` is the pinned one: re-hashed once per process (a binary
 * changed since, truncated by a crashed download, or put there by hand is not). On macOS the cache
 * holds the release asset with its ad-hoc signature repaired ({@linkcode installTailwind}), pinned
 * by {@linkcode installedTailwindSha256}; a cached asset as published (written by an older denext)
 * is verified against the release pin and repaired in place ({@linkcode runnableTailwind}).
 * Throws when no hash is pinned for it.
 */
async function cachedTailwindOk(
  dest: string,
  version: string,
  asset: string,
  os: string,
): Promise<boolean> {
  const info = await Deno.stat(dest).catch(() => null);
  if (!info?.isFile) return false;
  const release = expectedTailwindSha256(version, asset);
  const memo = `${dest}\0${release}`;
  if (release !== undefined && verifiedBins.has(memo)) return true;
  const ok = await cachedTailwindVerified(dest, await Deno.readFile(dest), version, asset, os);
  if (ok) verifiedBins.add(memo);
  return ok;
}

/**
 * Check the cached bytes against the installed pin, else the release pin (an asset as published,
 * cached by a denext from before the repair, is repaired in place). Throws with no release pin.
 */
async function cachedTailwindVerified(
  dest: string,
  bytes: Uint8Array,
  version: string,
  asset: string,
  os: string,
): Promise<boolean> {
  const installed = installedTailwindSha256(version, asset);
  if (installed !== undefined && await sha256Hex(bytes) === installed) return true;
  try {
    await assertTailwindIntegrity(bytes, version, asset);
  } catch (err) {
    if (expectedTailwindSha256(version, asset) === undefined) throw err; // no pin: refuse
    return false;
  }
  const runnable = await runnableTailwind(bytes, os);
  if (runnable !== bytes) await installTailwind(dest, runnable, os);
  return true;
}

/** GET the release asset at `url`. */
async function fetchTailwind(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(
      `denext: failed to download Tailwind from ${url} (${res.status} ${res.statusText}). ` +
        `Set TAILWIND_BIN to a local binary, or DENEXT_TAILWIND_VERSION to a valid release.`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The bytes to cache for a verified release asset. On macOS the ad-hoc signature's page hashes are
 * recomputed: the Tailwind releases are Bun-compiled executables whose signature carries a stale
 * hash for its last page, and an Apple Silicon kernel SIGKILLs the process (exit 137) as soon as it
 * maps that page (every launch of v4.3.0 on macOS 27). Only the hash slots change, from bytes
 * already verified against the pin.
 */
async function runnableTailwind(bytes: Uint8Array, os: string): Promise<Uint8Array> {
  return os === "darwin" ? (await repairAdhocSignature(bytes)) ?? bytes : bytes;
}

/**
 * Put verified `bytes` at `dest`: a temp file of this process's own (never one another build is
 * writing), then a rename, so a concurrent build never sees, or runs, a partial binary.
 */
async function installTailwind(dest: string, bytes: Uint8Array, os: string): Promise<void> {
  const tmp = `${dest}.download-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tmp, bytes, { createNew: true, mode: 0o755 });
    if (os !== "windows") await Deno.chmod(tmp, 0o755);
    await Deno.rename(tmp, dest);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

/**
 * Resolve the Tailwind standalone binary, downloading it on first use.
 *
 * Resolution order:
 *   1. `TAILWIND_BIN` — an explicit path to a Tailwind executable.
 *   2. A previously-downloaded binary in denext's cache, once it hashes to the pin.
 *   3. Download the pinned version from GitHub releases into the cache, verified before it is
 *      written in place.
 *
 * @param options Seams for tests.
 * @returns Absolute path to an executable Tailwind binary.
 */
export async function resolveTailwindBin(
  options: ResolveTailwindBinOptions = {},
): Promise<string> {
  const override = Deno.env.get("TAILWIND_BIN");
  if (override) return override;
  const { os = Deno.build.os, arch = Deno.build.arch, log = console.log } = options;
  const asset = tailwindAssetName(os, arch);
  const dir = options.cacheDir ?? cacheDir();
  const dest = join(dir, os === "windows" ? "tailwindcss.exe" : "tailwindcss");
  const version = tailwindVersion();
  if (await cachedTailwindOk(dest, version, asset, os)) return dest;
  if (await Deno.stat(dest).catch(() => null)) {
    log(
      `  denext: the cached Tailwind at ${dest} does not match its pinned SHA-256; re-downloading.`,
    );
  }
  await ensureDir(dir);
  const url = tailwindDownloadUrl(version, asset);
  log(`  denext: downloading Tailwind ${version} (${asset})…`);
  // Integrity: this binary is fetched outside Deno's module graph, so `deno.lock` gives
  // it no coverage. Digest it and fail closed on a mismatch or a missing pin — otherwise a
  // compromised GitHub release asset (or a `DENEXT_TAILWIND_VERSION` pointed at an attacker
  // tag) is silent build-time code execution.
  const bytes = await fetchTailwind(url, options.fetch ?? fetch);
  await assertTailwindIntegrity(bytes, version, asset);
  await installTailwind(dest, await runnableTailwind(bytes, os), os);
  verifiedBins.add(`${dest}\0${expectedTailwindSha256(version, asset)}`);
  return dest;
}

/**
 * Verify a downloaded Tailwind binary's SHA-256 against its pin, failing closed: a mismatch is
 * refused, and so is a version with no pin (a `DENEXT_TAILWIND_VERSION` other than the default
 * needs `DENEXT_TAILWIND_SHA256` for this machine's asset), as the esbuild and Deno toolchain
 * downloads are. `TAILWIND_BIN` (a vetted local binary) skips the download. Exported for testing.
 */
export async function assertTailwindIntegrity(
  bytes: Uint8Array,
  version: string,
  asset: string,
): Promise<void> {
  const digest = await sha256Hex(bytes);
  const expected = expectedTailwindSha256(version, asset);
  if (!expected) {
    throw new Error(
      `denext: no pinned sha256 for Tailwind ${asset} @ ${version}; refusing to run an ` +
        `unverified binary. Set DENEXT_TAILWIND_SHA256 to the asset's published sha256 ` +
        `(this download is ${digest}; check it against the release's sha256sums.txt), or ` +
        `TAILWIND_BIN to a vetted local binary.`,
    );
  }
  if (digest !== expected) {
    throw new Error(
      `denext: Tailwind binary integrity check FAILED for ${asset} @ ${version}.\n` +
        `  expected sha256 ${expected}\n  got      sha256 ${digest}\n` +
        `Refusing to run a binary that does not match the pinned hash. Verify the ` +
        `release, or set TAILWIND_BIN to a vetted local binary.`,
    );
  }
}

/** Lowercase hex SHA-256 of `bytes` (via WebCrypto). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Known-good SHA-256 for each `${version}/${asset}` Tailwind binary of the pinned release, from
 * the downloaded assets and cross-checked against the release's own `sha256sums.txt`. An env pin
 * (`DENEXT_TAILWIND_SHA256`, this machine's asset) wins, for a custom version; bump these with
 * {@linkcode DEFAULT_TAILWIND_VERSION}.
 */
const TAILWIND_SHA256: Record<string, string> = {
  "v4.3.0/tailwindcss-linux-arm64":
    "8f48dcb72be3b351c10563c5329b4638ba8516820dc3b3a1609625a166e87cbd",
  "v4.3.0/tailwindcss-linux-x64":
    "73f0e5459054e5cfaa8ab6f3b940f3fbe0f13cc7fd83bc24e7c655033c203400",
  "v4.3.0/tailwindcss-macos-arm64":
    "56b4bbc62dbdc4614a78930d9c6986423a2ec63e4e640144a59a5d95c914322e",
  "v4.3.0/tailwindcss-macos-x64":
    "2ba252f770817091e6d0d12a84e0dd531bcc29aad1bfd9d976a3aff1a071b67a",
  "v4.3.0/tailwindcss-windows-x64.exe":
    "e4303d06a337899d426583508f55c143ce89a585f90ed080f482d02fd83093c1",
};

/**
 * SHA-256 of each pinned macOS binary as {@linkcode installTailwind} caches it: the release asset
 * with its ad-hoc signature repaired ({@linkcode repairAdhocSignature} is deterministic). The x64
 * asset keeps Bun's own (not ad-hoc) signature, which is left as published, so it caches as is.
 */
const TAILWIND_INSTALLED_SHA256: Record<string, string> = {
  "v4.3.0/tailwindcss-macos-arm64":
    "8e0df05f54961bac850eee4417ef751674adf7daf2d78c889eaa5a77bf2c8800",
};

/**
 * The expected hash of the cached binary for a (version, asset) when it differs from the release
 * asset's (a repaired macOS signature), or undefined. A custom version's repaired binary has no
 * pin: its cache is re-verified by downloading the asset again in each process.
 */
function installedTailwindSha256(version: string, asset: string): string | undefined {
  const key = `${version}/${asset}`;
  const installed = TAILWIND_INSTALLED_SHA256[key];
  return installed !== undefined && expectedTailwindSha256(version, asset) === TAILWIND_SHA256[key]
    ? installed
    : undefined;
}

/** The expected hash for a (version, asset), or undefined when none is pinned. */
function expectedTailwindSha256(version: string, asset: string): string | undefined {
  const env = Deno.env.get("DENEXT_TAILWIND_SHA256")?.trim().toLowerCase();
  if (env) return env;
  return TAILWIND_SHA256[`${version}/${asset}`];
}

/**
 * Resolve a project's Tailwind config to absolute input/output paths (or
 * `undefined` when the project has no Tailwind config).
 *
 * @param projectDir Absolute project root.
 * @param cfg The `tailwind` config from `denext.config.ts`, if any.
 */
export function tailwindPaths(
  projectDir: string,
  cfg: TailwindConfig | undefined | null,
): { input: string; output: string } | undefined {
  if (!cfg) return undefined;
  return {
    input: resolve(projectDir, cfg.input),
    output: resolve(projectDir, cfg.output),
  };
}

/** Options for {@linkcode compileTailwind}. */
export interface CompileTailwindOptions {
  /** Absolute path to the Tailwind input stylesheet. */
  input: string;
  /** Absolute path to write the compiled CSS to. */
  output: string;
  /** Minify the output (production builds). */
  minify?: boolean;
  /** Explicit binary path (skips resolution/download); mainly for testing. */
  bin?: string;
  /** Working directory for Tailwind's content scan (defaults to the input's project). */
  cwd?: string;
  /**
   * The project whose `node_modules/tailwindcss` decides the compiler: a Tailwind **v3**
   * install (a `tailwind.config.*` + `@tailwind` directives app) is compiled with its OWN
   * `tailwindcss` CLI — the v4 standalone binary can't read v3 configs/plugins. Absent or
   * v4+: the standalone binary.
   */
  projectDir?: string;
}

/** The project's installed `tailwindcss` version, or null when it has none. */
async function installedTailwindVersion(projectDir: string): Promise<string | null> {
  try {
    const pkg = await Deno.readTextFile(
      join(projectDir, "node_modules", "tailwindcss", "package.json"),
    );
    return (JSON.parse(pkg) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compile with the project's own Tailwind v3 CLI (`deno run npm:tailwindcss@3`, which
 * resolves the config, plugins and presets from the app's `node_modules`). `--postcss` is
 * added when the app has a PostCSS config (nesting, autoprefixer) and dropped on a retry
 * if that config can't load under Deno.
 */
async function compileTailwindV3(
  version: string,
  opts: CompileTailwindOptions,
): Promise<void> {
  const cwd = opts.cwd ?? opts.projectDir!;
  const hasPostcss = (await Promise.all(
    ["postcss.config.js", "postcss.config.cjs", "postcss.config.mjs", "postcss.config.ts"]
      .map((f) => Deno.stat(join(cwd, f)).then(() => true, () => false)),
  )).some(Boolean);
  const attempt = async (postcss: boolean): Promise<string> => {
    const args = [
      "run",
      "-A",
      "--node-modules-dir=manual",
      "--no-lock",
      `npm:tailwindcss@${version}`,
      "-i",
      opts.input,
      "-o",
      opts.output,
      ...(opts.minify ? ["--minify"] : []),
      ...(postcss ? ["--postcss"] : []),
    ];
    const { code, stderr } = await runToExit(denoExecutable(), {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    return code === 0 ? "" : new TextDecoder().decode(stderr) || `exit ${code}`;
  };
  let failure = await attempt(hasPostcss);
  if (failure && hasPostcss) failure = await attempt(false);
  if (failure) {
    throw new Error(`denext: Tailwind v${version} compile failed:
${failure}`);
  }
}

/**
 * Compile a Tailwind input file to CSS with the standalone binary (one-shot). The
 * caller is responsible for feeding the *output* through denext's CSS pipeline.
 *
 * @param opts Input/output paths and flags.
 */
export async function compileTailwind(opts: CompileTailwindOptions): Promise<void> {
  if (!opts.bin && opts.projectDir) {
    const installed = await installedTailwindVersion(opts.projectDir);
    if (installed && /^3\./.test(installed)) return compileTailwindV3(installed, opts);
  }
  const bin = opts.bin ?? await resolveTailwindBin();
  const args = ["-i", opts.input, "-o", opts.output];
  if (opts.minify) args.push("--minify");
  const { code, stderr } = await runToExit(bin, {
    args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  if (code !== 0) {
    throw new Error(
      `denext: Tailwind compile failed (${code}):\n${new TextDecoder().decode(stderr)}`,
    );
  }
}
