// Which C library a Linux host runs, and whether denext's Deno binaries run on it.
//
// denext's Deno (the toolchain CLI, `denort` and the Deno Desktop runtime) is built for glibc
// Linux and links symbols up to a glibc version (2.35: the fork builds on Ubuntu 22.04). On an
// older glibc (RHEL / Rocky / Alma 9, Amazon Linux 2023, Debian 11, Ubuntu 20.04) the SHA-256 check
// passes and the binary then fails to exec with `GLIBC_2.35 not found`; on a musl system (Alpine)
// it does not load at all. So before downloading one (and in `denext doctor`) the host is probed
// and an unsupported one stops with the supported distributions named.
//
// The probe spawns `getconf GNU_LIBC_VERSION` (glibc's own answer, `glibc 2.35`), falling back to
// `ldd --version` (musl's ldd names itself), plus a look for musl's loader in /lib. A host the
// probe can't read (no getconf / ldd) is let through: the download then fails as it would have.

import { runToExit } from "./exited-output.ts";

/**
 * The glibc version denext's Linux binaries need when the pin names none.
 *
 * A release whose manifest records the ceiling its "Check binary" step asserts (`cli.glibc`) gets
 * it pinned as `minGlibc` by `deno task desktop:pin-runtime`, and {@linkcode minGlibcFor} prefers
 * that field.
 */
export const DEFAULT_MIN_GLIBC = "2.35";

/** The distributions whose current releases meet {@linkcode DEFAULT_MIN_GLIBC}. */
export const SUPPORTED_LINUX =
  "glibc-based distributions with glibc 2.35 or later: Ubuntu 22.04+, Debian 12+, Fedora 36+, " +
  "RHEL / Rocky / AlmaLinux 10, current Arch and openSUSE Tumbleweed (not RHEL 9 or Amazon " +
  "Linux 2023, and not musl-based ones such as Alpine)";

/**
 * The Linux hosts that run a binary needing glibc `minGlibc` or later, for messages:
 * {@linkcode SUPPORTED_LINUX} at the default, the distributions named for glibc 2.27 (the floor
 * the fork's releases record from `3.0.0-denext.2`), else the version alone.
 *
 * @param minGlibc The glibc the binary needs ({@linkcode minGlibcFor}).
 * @returns One phrase.
 */
export function supportedLinux(minGlibc: string): string {
  if (minGlibc === DEFAULT_MIN_GLIBC) return SUPPORTED_LINUX;
  const named = minGlibc === "2.27"
    ? ": Ubuntu 18.04+, Debian 10+, RHEL / Rocky / AlmaLinux 8+, Amazon Linux 2023, Fedora 28+, " +
      "current Arch and openSUSE"
    : "";
  return `glibc-based distributions with glibc ${minGlibc} or later${named} (not musl-based ones ` +
    "such as Alpine)";
}

/** What a Linux host's C library is. */
export type LinuxLibc =
  | { readonly kind: "glibc"; readonly version: string }
  | { readonly kind: "musl" }
  | { readonly kind: "unknown" };

/** Runs a command, resolving its exit status and combined output (`null`: it could not start). */
export type LibcCommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ readonly success: boolean; readonly output: string } | null>;

/** Seams for {@linkcode probeLinuxLibc}. */
export interface LinuxLibcProbeOptions {
  /** The command runner (default: spawn it, stdout + stderr captured). */
  readonly run?: LibcCommandRunner;
  /** The names in a directory (default: `Deno.readDir`; `[]` when unreadable). */
  readonly list?: (dir: string) => Promise<string[]>;
}

const defaultRun: LibcCommandRunner = async (cmd, args) => {
  try {
    const out = await runToExit(cmd, { args });
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    return { success: out.success, output: text };
  } catch {
    return null;
  }
};

async function defaultList(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) names.push(e.name);
  } catch { /* unreadable: nothing */ }
  return names;
}

/**
 * The host's C library (call on Linux only): glibc with its version, musl, or `unknown`.
 *
 * @param options Test seams.
 * @returns What the host runs.
 */
export async function probeLinuxLibc(options: LinuxLibcProbeOptions = {}): Promise<LinuxLibc> {
  const run = options.run ?? defaultRun;
  const list = options.list ?? defaultList;
  const getconf = await run("getconf", ["GNU_LIBC_VERSION"]);
  const fromGetconf = getconf?.success ? /glibc\s+(\d+\.\d+)/i.exec(getconf.output) : null;
  if (fromGetconf) return { kind: "glibc", version: fromGetconf[1] };
  const ldd = await run("ldd", ["--version"]);
  if (ldd && /\bmusl\b/i.test(ldd.output)) return { kind: "musl" };
  const fromLdd = ldd ? /(?:glibc|gnu libc)[^\n]*?(\d+\.\d+)\s*$/im.exec(ldd.output) : null;
  if (fromLdd) return { kind: "glibc", version: fromLdd[1] };
  if ((await list("/lib")).some((n) => /^ld-musl-.*\.so\.1$/.test(n))) return { kind: "musl" };
  return { kind: "unknown" };
}

/** `a` ≥ `b` for `major.minor` versions. */
function atLeast(a: string, b: string): boolean {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am !== bm ? am > bm : (an ?? 0) >= (bn ?? 0);
}

/**
 * The glibc a pin's Linux binaries need: its `minGlibc` when it records one, else
 * {@linkcode DEFAULT_MIN_GLIBC}.
 *
 * @param pin A toolchain or desktop-runtime pin (any object).
 * @returns The minimum glibc version (`2.35`).
 */
export function minGlibcFor(pin: unknown): string {
  const v = (pin as { minGlibc?: unknown } | null)?.minGlibc;
  return typeof v === "string" && /^\d+\.\d+$/.test(v) ? v : DEFAULT_MIN_GLIBC;
}

/**
 * Why denext's Linux binaries won't run on a host with `libc`, or `null` when they will (or the
 * host could not be read).
 *
 * @param libc The probe's answer.
 * @param minGlibc The glibc the binaries need.
 * @returns The problem, one sentence, or `null`.
 */
export function linuxLibcProblem(libc: LinuxLibc, minGlibc: string): string | null {
  if (libc.kind === "musl") {
    return `this host uses musl libc, and denext's Deno is built for glibc ${minGlibc} or later`;
  }
  if (libc.kind === "glibc" && !atLeast(libc.version, minGlibc)) {
    return `this host has glibc ${libc.version}, and denext's Deno needs glibc ${minGlibc} or later`;
  }
  return null;
}

/** The process's probe, run once (the host's libc does not change under it). */
let probed: Promise<LinuxLibc> | undefined;

/**
 * Stop before downloading (or running) one of denext's Linux binaries on a host it can't run on:
 * a `denext:` error naming the supported distributions. A no-op off Linux, and when the host's
 * libc can't be read.
 *
 * @param what What was about to be fetched (`the Deno toolchain 3.0.0-rc.5`).
 * @param minGlibc The glibc the binary needs ({@linkcode minGlibcFor}).
 * @param options Test seams: the host OS and the probe's answer.
 * @throws {Error} On musl, or a glibc older than `minGlibc`.
 */
export async function assertLinuxLibc(
  what: string,
  minGlibc: string,
  options: { os?: string; libc?: LinuxLibc } = {},
): Promise<void> {
  if ((options.os ?? Deno.build.os) !== "linux") return;
  const libc = options.libc ?? await (probed ??= probeLinuxLibc());
  const problem = linuxLibcProblem(libc, minGlibc);
  if (problem === null) return;
  throw new Error(
    `denext: can't install ${what}: ${problem}.\n` +
      `  Supported Linux: ${supportedLinux(minGlibc)}.\n` +
      "  Run denext on one of those (a container image such as debian:12 or ubuntu:24.04 works " +
      "on any host).",
  );
}
