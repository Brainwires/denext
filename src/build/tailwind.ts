// Tailwind CSS, driven by denext. We download and manage the Tailwind v4
// *standalone* binary (a self-contained executable, no npm) and run it to compile
// the project's Tailwind input into a plain CSS file that denext's own CSS
// pipeline then consumes. This keeps the zero-runtime-npm-dependency rule (the
// binary is a build-time tool, like the lightningcss wasm) while giving projects
// first-class Tailwind support.

import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
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
 * Throws for platforms Tailwind does not publish a standalone binary for.
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
      return `tailwindcss-windows-${cpu}.exe`;
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
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const base = Deno.env.get("XDG_CACHE_HOME") ?? join(home, ".cache");
  return join(base, "denext", "tailwind", tailwindVersion());
}

/**
 * Resolve the Tailwind standalone binary, downloading it on first use.
 *
 * Resolution order:
 *   1. `TAILWIND_BIN` — an explicit path to a Tailwind executable.
 *   2. A previously-downloaded binary in denext's cache.
 *   3. Download the pinned version from GitHub releases into the cache.
 *
 * @returns Absolute path to an executable Tailwind binary.
 */
export async function resolveTailwindBin(): Promise<string> {
  const override = Deno.env.get("TAILWIND_BIN");
  if (override) return override;

  const asset = tailwindAssetName(Deno.build.os, Deno.build.arch);
  const dir = cacheDir();
  const binName = Deno.build.os === "windows" ? "tailwindcss.exe" : "tailwindcss";
  const dest = join(dir, binName);
  try {
    await Deno.stat(dest);
    return dest; // already downloaded
  } catch { /* not cached — download below */ }

  await ensureDir(dir);
  const url = tailwindDownloadUrl(tailwindVersion(), asset);
  console.log(`  denext: downloading Tailwind ${tailwindVersion()} (${asset})…`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `denext: failed to download Tailwind from ${url} (${res.status} ${res.statusText}). ` +
        `Set TAILWIND_BIN to a local binary, or DENEXT_TAILWIND_VERSION to a valid release.`,
    );
  }
  // Integrity: this binary is fetched outside Deno's module graph, so `deno.lock` gives
  // it no coverage. Digest it and fail closed on a hash mismatch when a pin is known —
  // otherwise a compromised GitHub release asset (or a `DENEXT_TAILWIND_VERSION` pointed
  // at an attacker tag) is silent build-time code execution.
  const bytes = new Uint8Array(await res.arrayBuffer());
  await assertTailwindIntegrity(bytes, tailwindVersion(), asset);
  // Write to a temp file then rename, so a concurrent build never sees a partial binary.
  const tmp = `${dest}.download`;
  await Deno.writeFile(tmp, bytes, { create: true, mode: 0o755 });
  await Deno.rename(tmp, dest);
  if (Deno.build.os !== "windows") {
    await Deno.chmod(dest, 0o755);
  }
  return dest;
}

/**
 * Verify a downloaded Tailwind binary's SHA-256 against a pin. Throws (fail closed) on a
 * mismatch when a pin is known (`DENEXT_TAILWIND_SHA256` or the built-in table); warns
 * and prints the digest when nothing is pinned, so an operator can capture and pin it
 * rather than run an unverified native binary silently. Exported for testing.
 */
export async function assertTailwindIntegrity(
  bytes: Uint8Array,
  version: string,
  asset: string,
): Promise<void> {
  const digest = await sha256Hex(bytes);
  const expected = expectedTailwindSha256(version, asset);
  if (expected && digest !== expected) {
    throw new Error(
      `denext: Tailwind binary integrity check FAILED for ${asset} @ ${version}.\n` +
        `  expected sha256 ${expected}\n  got      sha256 ${digest}\n` +
        `Refusing to run a binary that does not match the pinned hash. Verify the ` +
        `release, or set TAILWIND_BIN to a vetted local binary.`,
    );
  }
  if (!expected) {
    console.warn(
      `  denext: Tailwind binary is UNVERIFIED (no pinned sha256). Downloaded ${asset} ` +
        `@ ${version} sha256=${digest}. Pin it to fail closed on a tampered release: ` +
        `set DENEXT_TAILWIND_SHA256=${digest} (this machine's asset) or TAILWIND_BIN ` +
        `to a vendored binary.`,
    );
  }
}

/** Lowercase hex SHA-256 of `bytes` (via WebCrypto). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Known-good SHA-256 for a `${version}/${asset}` Tailwind binary. An env pin
 * (`DENEXT_TAILWIND_SHA256`, this machine's asset) wins; otherwise this built-in table
 * is consulted so a default-version download can fail closed out of the box. Empty
 * today — per-platform hashes must be captured from a trusted download, never guessed;
 * a first download prints its digest so an operator can pin it here or via the env.
 */
const TAILWIND_SHA256: Record<string, string> = {};

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
}

/**
 * Compile a Tailwind input file to CSS with the standalone binary (one-shot). The
 * caller is responsible for feeding the *output* through denext's CSS pipeline.
 *
 * @param opts Input/output paths and flags.
 */
export async function compileTailwind(opts: CompileTailwindOptions): Promise<void> {
  const bin = opts.bin ?? await resolveTailwindBin();
  const args = ["-i", opts.input, "-o", opts.output];
  if (opts.minify) args.push("--minify");
  const cmd = new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `denext: Tailwind compile failed (${code}):\n${new TextDecoder().decode(stderr)}`,
    );
  }
}
