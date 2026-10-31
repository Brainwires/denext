// denext's managed Deno toolchain: the Deno CLI built from the Brainwires/deno fork
// (`2.9.7-denext.N` — stock Deno plus `Deno.SQL` and Vitest/Jest compatibility in `deno test`),
// downloaded on first need and pinned by version + SHA-256 in `deno-toolchain-pin.json`, the same
// way `desktop-runtime.ts` pins the Deno Desktop runtime. Users keep installing stock Deno; the
// CLI re-runs the commands that execute project code under this binary (see
// `maybeReexecToolchain` in src/cli/self-exec.ts), and the `deno` on PATH is never replaced.
//
// {@linkcode ensureDenoToolchain}:
//
//   1. reuses `<DENO_DIR>/denext-deno/<version>/<target>/deno[.exe]` when its stamp names this pin's
//      archive and the binary still has the size and mtime the stamp recorded (no hashing, no
//      network); a binary whose size or mtime changed is re-hashed against the stamp, and a
//      missing stamp means a fresh download;
//   2. else streams the pinned file into a temp file in that same directory, refusing it the
//      moment it outgrows its pinned size, and checks the SHA-256 BEFORE anything else touches it:
//      a mismatch deletes it and refuses (never executed, never extracted);
//   3. extracts `deno` from a verified zip (or takes a verified bare binary), marks it executable,
//      renames it into place atomically and writes the stamp last — under the Cargo-style cache
//      lock, so two first runs download once and the second adopts the first's binary;
//   4. when the pin names an esbuild for the target (2.9.7-denext.17 on: the zip carries
//      `esbuild[.exe]` + `esbuild.LICENSE` beside `deno`), installs it next to `deno` only when it
//      hashes to the pinned SHA-256 and is the esbuild version denext's vendored API speaks, and
//      records it — or why it was refused — in the stamp. A refused esbuild never fails the
//      toolchain: denext's esbuild API (src/build/esbuild/) then uses the npm binary, with one
//      warning ({@linkcode toolchainEsbuild}).
//
// From 2.9.7-denext.20 the pin also names the release's `denort` per target (the standalone
// runtime `deno compile` builds onto, `deno-denort-<version>-<target>.zip`): {@linkcode
// ensureDenort} fetches and verifies it the same way into `<version>/<target>-denort/`, and
// `denext build --compile` hands it to `deno compile` as `DENORT_BIN`, so a compiled app carries
// the fork's patches (`Deno.SQL`) like the toolchain itself.
//
// `DENEXT_DENO=stock` opts out; `DENEXT_DENO=<path>` uses that binary unverified (a warning).
// `DENEXT_TOOLCHAIN_PIN_FILE=<json>` replaces the built-in pin (tests and fork development).

import { encodeHex } from "@std/encoding/hex";
import { dirname, join, resolve } from "@std/path";
import { acquireCacheLock } from "./project-locks.ts";
import { lockTask } from "./file-lock.ts";
import {
  denoCacheDir,
  DESKTOP_RUNTIME_PIN,
  type DesktopRuntimePin,
  renameRetrying,
} from "./desktop-runtime.ts";
import { extractArchive } from "./safe-extract.ts";
import {
  assertTrustedCacheDirs,
  cacheDirChain,
  DownloadIdleError,
  type DownloadProgress,
  downloadProgress,
  fetchWithConnectDeadline,
  readJsonFile,
  responseBody,
  sha256File,
  streamHashed,
  sweepLeftovers,
  withDownloadRetries,
} from "./verified-download.ts";
import { ESBUILD_VERSION } from "./esbuild/version.ts";
import {
  currentDenoIdentity,
  type DenoIdentity,
  denoVersionOutput,
  isDenextDenoVersion,
  isPinnedDenextDeno,
  parseDenoVersionOutput,
} from "./deno-version.ts";
import pinJson from "./deno-toolchain-pin.json" with { type: "json" };
import { assertLinuxLibc, type LinuxLibc, minGlibcFor } from "./linux-libc.ts";
import {
  decideRevocation,
  type LoadRevocationsOptions,
  loadRuntimeRevocations,
  REVOCATION_NOTICED_ENV,
  type RevocationMode,
  revocationNotice,
  revocationStatus,
  type RevocationSubject,
  type RuntimeComponent,
  type RuntimeRevocationStatus,
} from "./runtime-revocations.ts";

/** The esbuild a toolchain archive carries beside `deno` (2.9.7-denext.17 on). */
export interface DenoToolchainEsbuild {
  /** The esbuild release (`0.25.5`). */
  readonly version: string;
  /** Lowercase hex SHA-256 of the archive's `esbuild[.exe]`. */
  readonly sha256: string;
}

/**
 * A native TypeScript 7 build ("tsgo") a toolchain archive carries in a directory beside `deno`:
 * `tsc[.exe]` and the `lib.*.d.ts` files it loads from its own directory. `typescript-check/` is
 * the compiler the runtime type-checks with by default (from the first runtime with native type
 * checking); `typescript-lsp/` is the dated 7.1 nightly `deno lsp`'s tsgo language-service backend
 * runs (`"deno.unstable": ["tsgo-lsp"]`).
 */
export interface DenoToolchainTsgo {
  /** The TypeScript release (`7.0.2`, or a dated nightly such as `7.1.0-dev.20261017.1`). */
  readonly version: string;
  /** Lowercase hex SHA-256 of the directory's `tsc[.exe]`. */
  readonly sha256: string;
  /**
   * Lowercase hex SHA-256 over every file of the directory but `typescript.json`:
   * `<name>\0<sha256>\n` per file, sorted by name (the `tree_sha256` the fork's release manifest
   * records).
   */
  readonly treeSha256: string;
}

/** One pinned toolchain download for a host target. */
export interface DenoToolchainArtifact {
  /** The release asset's file name. */
  readonly file: string;
  readonly url: string;
  /** Lowercase hex SHA-256 of the downloaded file. */
  readonly sha256: string;
  /** Its exact size in bytes (enforced while streaming when given). */
  readonly size?: number;
  /**
   * `zip` (a release archive holding the executable at its top level, the default), `tar.gz`
   * (the same as a gzipped tarball: the pinned Gleam on macOS and Linux) or a bare `binary`.
   */
  readonly format?: "zip" | "tar.gz" | "binary";
  /** The esbuild inside the zip, when the release ships one. */
  readonly esbuild?: DenoToolchainEsbuild;
  /** The native TypeScript compiler inside the zip (`typescript-check/`), when the release ships one. */
  readonly tsgo?: DenoToolchainTsgo;
  /**
   * The TypeScript 7 language server inside the zip (`typescript-lsp/`), when the pin names one:
   * installed beside `deno`, where `deno lsp` finds it before downloading its own copy.
   */
  readonly tsgoLsp?: DenoToolchainTsgo;
  /**
   * Request headers the download needs (a registry's anonymous token, such as ghcr.io's for the
   * portable Ruby behind denext's managed fastlane). Never a secret: pins are public.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Where else the same file can be had, tried in order when `url` fails (offline, an HTTP error,
   * a truncated or mismatching download). Every copy must hash to the one pinned `sha256`.
   */
  readonly fallbacks?: readonly DenoToolchainSource[];
}

/** One more place a pinned artifact can be downloaded from (see `fallbacks`). */
export interface DenoToolchainSource {
  readonly url: string;
  /** Request headers this source needs (public, like `headers`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The pinned toolchain release (`deno-toolchain-pin.json`). */
export interface DenoToolchainPin {
  readonly schema: 1;
  /**
   * The toolchain version (`2.9.7-denext.15`), or `null` while no CLI archives are pinned for
   * this denext version — the toolchain then reports itself not available and stock Deno runs.
   */
  readonly version: string | null;
  /** The release tag the pin came from (`denext-runtime-v<version>`). */
  readonly tag?: string;
  readonly repository?: string;
  /** The Deno release the fork is built from. */
  readonly deno?: string;
  /** Per host target (`darwin-aarch64`, `linux-x86_64`, `windows-x86_64`, …). */
  readonly targets: Readonly<Record<string, DenoToolchainArtifact>>;
  /**
   * The release's `denort` zips (holding `denort[.exe]`), keyed like `targets`; absent before
   * 2.9.7-denext.20.
   */
  readonly denort?: Readonly<Record<string, DenoToolchainArtifact>>;
  /**
   * The previous pin, run instead of this one when the signed revoked-runtimes list revokes this
   * one for the host (src/build/runtime-revocations.ts). Never nests another `rollback`.
   */
  readonly rollback?: DenoToolchainRollback;
}

/** A pin's `rollback`: the previous pinned release, as the pin named it. */
export interface DenoToolchainRollback {
  readonly version: string;
  readonly tag?: string;
  readonly deno?: string;
  /** The glibc its Linux builds need (see `minGlibcFor`). */
  readonly minGlibc?: string;
  readonly targets: Readonly<Record<string, DenoToolchainArtifact>>;
  readonly denort?: Readonly<Record<string, DenoToolchainArtifact>>;
}

/** The toolchain denext pins (see the module header). */
export const DENO_TOOLCHAIN: DenoToolchainPin = pinJson as DenoToolchainPin;

/** `stock` → stock Deno; a path → that binary (unverified); unset / `pinned` → denext's. */
export const TOOLCHAIN_ENV = "DENEXT_DENO";
/** Set on a re-exec'd child (to the toolchain version): never re-exec again. */
export const TOOLCHAIN_ACTIVE_ENV = "DENEXT_TOOLCHAIN_ACTIVE";
/** A pin file that replaces the built-in one (tests, fork development). */
const TOOLCHAIN_PIN_FILE_ENV = "DENEXT_TOOLCHAIN_PIN_FILE";

/** The stamp beside a verified binary. */
export const TOOLCHAIN_STAMP = ".denext-toolchain.json";

/** The cache directory's name under Deno's cache. */
const CACHE_NAME = "denext-deno";
/** What the cache lock's Blocking line names. */
const CACHE_DESCR = "Deno toolchain cache";
/** The size cap for a download whose pin records no size. */
const MAX_DOWNLOAD = 1024 ** 3;
/** The way out of every toolchain failure. */
/** What every refusal to run without the toolchain names: the fix, and the explicit opt-outs. */
const TOOLCHAIN_FIX = "  Fix: run `denext toolchain install` (online), then retry.\n" +
  `  Or opt out explicitly: ${TOOLCHAIN_ENV}=stock runs the deno that started denext (or the ` +
  `\`deno\` on PATH), ${TOOLCHAIN_ENV}=<path> runs that deno binary.`;
/** The one line {@linkcode linkDenoToolchain}'s Windows shim carries (what unlink checks). */
const SHIM_MARK = "REM denext toolchain shim";

/** Env reader. */
type EnvGet = (k: string) => string | undefined;
const processEnv: EnvGet = (k) => {
  try {
    return Deno.env.get(k);
  } catch {
    return undefined; // no env permission
  }
};

/** Raised when no toolchain build exists for this denext version or this host. */
export class DenoToolchainUnavailableError extends Error {
  override name = "DenoToolchainUnavailableError";
}

/** Raised when the toolchain can't be fetched (offline, HTTP error, truncated download). */
export class DenoToolchainDownloadError extends Error {
  override name = "DenoToolchainDownloadError";
}

/** Raised when a download (or a cached binary) does not match its pinned SHA-256. */
export class DenoToolchainHashError extends Error {
  override name = "DenoToolchainHashError";
}

/**
 * Raised when a command needs denext's Deno toolchain and it can't be had (offline on first use,
 * no build for this host, a failed or tampered download, a bad `DENEXT_DENO`): denext no longer
 * falls back to another Deno on its own. The message names the fix and the explicit opt-outs.
 */
export class DenoToolchainRequiredError extends Error {
  override name = "DenoToolchainRequiredError";
}

/**
 * The toolchain target of a host: `<os>-<arch>` as `Deno.build` spells them
 * (`darwin-aarch64`, `linux-x86_64`, `windows-x86_64`, …).
 *
 * @param os The OS.
 * @param arch The CPU architecture.
 * @returns The target key of the pin table.
 */
export function denoToolchainTarget(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): string {
  return `${os}-${arch}`;
}

/**
 * The pin in force: the file `DENEXT_TOOLCHAIN_PIN_FILE` names, else {@linkcode DENO_TOOLCHAIN}.
 *
 * @param env Env reader.
 * @returns The pin.
 */
export function loadDenoToolchainPin(env: EnvGet = processEnv): DenoToolchainPin {
  const file = env(TOOLCHAIN_PIN_FILE_ENV);
  if (!file) return DENO_TOOLCHAIN;
  let pin: DenoToolchainPin;
  try {
    pin = JSON.parse(Deno.readTextFileSync(file));
  } catch (err) {
    throw new Error(`denext: ${TOOLCHAIN_PIN_FILE_ENV}=${file} is not a readable pin: ${err}`);
  }
  if (pin?.schema !== 1 || typeof pin.targets !== "object" || pin.targets === null) {
    throw new Error(`denext: ${TOOLCHAIN_PIN_FILE_ENV}=${file} is not a schema-1 toolchain pin`);
  }
  return pin;
}

/**
 * The pin's `rollback` as a pin of its own (no `rollback` of its own), or `null` when it names none.
 *
 * @param pin The pin.
 * @returns The previous release's pin.
 */
export function rollbackToolchainPin(pin: DenoToolchainPin): DenoToolchainPin | null {
  if (!pin.rollback) return null;
  return {
    schema: 1,
    ...(pin.repository ? { repository: pin.repository } : {}),
    ...pin.rollback,
  };
}

/**
 * The pin of the toolchain this process runs on: the pin in force, or its `rollback` when the
 * toolchain marker (`DENEXT_TOOLCHAIN_ACTIVE`, set by the command that started this one) names the
 * rollback's version — the parent ran the rollback because the pinned release is revoked, and
 * everything this process takes from the pin (its esbuild, TypeScript, `denort`) must match it.
 *
 * @param env Env reader.
 * @returns The pin.
 */
export function activeToolchainPin(env: EnvGet = processEnv): DenoToolchainPin {
  const pin = loadDenoToolchainPin(env);
  const rollback = rollbackToolchainPin(pin);
  const marker = env(TOOLCHAIN_ACTIVE_ENV);
  return rollback && marker === rollback.version ? rollback : pin;
}

/** What {@linkcode shippingToolchainPin} reads (tests pass a fixture pin and its list). */
export interface ShippingToolchainOptions {
  /** The pin in force (default {@linkcode loadDenoToolchainPin}). */
  readonly pin?: DenoToolchainPin;
  /** The host's pin key (default {@linkcode denoToolchainTarget}). */
  readonly target?: string;
  /** The toolchain cache, where the list is cached (default {@linkcode denoToolchainCacheRoot}). */
  readonly cacheRoot?: string;
  /** How the list is read (default: `fetch`). */
  readonly revocations?: ToolchainRevocationOptions;
}

/**
 * The pin of the toolchain a command that SHIPS a runtime runs on (`build --compile` builds onto
 * its `denort`): {@linkcode activeToolchainPin}, but a toolchain marker naming the pin's rollback
 * is believed only when the revoked-runtimes list, read now, still picks the rollback here — a
 * marker leaked from a parent shell or a copied CI env never makes a release ship the older
 * runtime.
 *
 * @param env Env reader.
 * @param options The pin, target, cache and list seams.
 * @returns The pin.
 * @throws {Error} When the marker names the rollback but the list does not pick it.
 */
export async function shippingToolchainPin(
  env: EnvGet = processEnv,
  options: ShippingToolchainOptions = {},
): Promise<DenoToolchainPin> {
  const pin = options.pin ?? loadDenoToolchainPin(env);
  const rollback = rollbackToolchainPin(pin);
  if (!rollback || env(TOOLCHAIN_ACTIVE_ENV) !== rollback.version) return pin;
  const unmarked: EnvGet = (name) => name === TOOLCHAIN_ACTIVE_ENV ? undefined : env(name);
  const selected = await selectToolchainPin(
    pin,
    unmarked,
    { ...(options.pin ? { pin } : {}), revocations: options.revocations ?? {} },
    options.target ?? denoToolchainTarget(),
    options.cacheRoot ?? denoToolchainCacheRoot(env),
  );
  if (selected.pin.version === rollback.version) return rollback;
  throw new Error(
    `denext: ${TOOLCHAIN_ACTIVE_ENV}=${rollback.version} names the toolchain pin's rollback, but ` +
      `the revoked-runtimes list does not revoke ${pin.version} here: refusing to ship ` +
      `${rollback.version}. Unset ${TOOLCHAIN_ACTIVE_ENV} and run the command again.`,
  );
}

/**
 * `<deno cache>/denext-deno`.
 *
 * @param env Env reader.
 * @returns The cache root.
 */
export function denoToolchainCacheRoot(env: EnvGet = processEnv): string {
  return join(denoCacheDir(env), CACHE_NAME);
}

/** The executable's file name on `os`. */
function exeName(os: string): string {
  return os === "windows" ? "deno.exe" : "deno";
}

/** The esbuild executable's file name on `os`. */
function esbuildExeName(os: string): string {
  return os === "windows" ? "esbuild.exe" : "esbuild";
}

/** One of the archive's TypeScript 7 directories beside `deno`: the checker or the language server. */
interface TsRole {
  /** The pin's (and the stamp's) field. */
  readonly key: "tsgo" | "tsgoLsp";
  /** The directory beside `deno`. */
  readonly dir: string;
  /** What a refusal names. */
  readonly what: string;
}

/** `typescript-check/`: the compiler `deno check` & co. run. */
const TS_CHECK: TsRole = {
  key: "tsgo",
  dir: "typescript-check",
  what: "native TypeScript compiler",
};
/** `typescript-lsp/`: the build `deno lsp`'s tsgo backend runs. */
const TS_LSP: TsRole = {
  key: "tsgoLsp",
  dir: "typescript-lsp",
  what: "TypeScript language server",
};

/** A native TypeScript build's file name (in its role's directory) on `os`. */
function tsgoExeName(os: string): string {
  return os === "windows" ? "tsc.exe" : "tsc";
}

/** The cached binary's directory for (version, target). */
function binaryDir(root: string, version: string, target: string): string {
  return join(root, version, target);
}

/** The pinned artifact for `target`, or why there is none (`denort`: the pin's denort zips). */
function pinnedArtifact(
  pin: DenoToolchainPin,
  target: string,
  denort = false,
): DenoToolchainArtifact {
  if (pin.version === null) {
    throw new DenoToolchainUnavailableError(
      "denext: denext's Deno toolchain is not available for this denext version " +
        "(no CLI archives are pinned).",
    );
  }
  const table = (denort ? pin.denort : pin.targets) ?? {};
  const artifact = table[target];
  if (artifact) return artifact;
  throw new DenoToolchainUnavailableError(
    `denext: denext's Deno toolchain ${pin.version} has no ${denort ? "denort" : "build"} for ` +
      `${target} (it has: ${Object.keys(table).join(", ") || "none"}).`,
  );
}

/** A stamped file: what it was when installed. */
interface StampedFile {
  size: number;
  sha256: string;
  mtimeMs: number | null;
}

/** The stamp's record of the archive's esbuild: installed (verified), or why it was refused. */
type StampedEsbuild = (StampedFile & { version: string }) | { refused: string };

/**
 * The stamp's record of one of the archive's TypeScript directories (`typescript-check/`,
 * `typescript-lsp/`): installed (verified), or why it was refused.
 */
type StampedTsgo = (StampedFile & { version: string; treeSha256: string }) | { refused: string };

/** The stamp's contents. */
interface ToolchainStamp {
  schema: 1;
  version: string;
  target: string;
  archive: { file: string; sha256: string };
  binary: StampedFile;
  /** Present exactly when the pin names an esbuild for this archive. */
  esbuild?: StampedEsbuild;
  /** Present exactly when the pin names a native TypeScript compiler for this archive. */
  tsgo?: StampedTsgo;
  /** Present exactly when the pin names a TypeScript language server for this archive. */
  tsgoLsp?: StampedTsgo;
}

/** The stamp's records of the archive's install steps beside the binary. */
type StampSteps = Pick<ToolchainStamp, "esbuild" | "tsgo" | "tsgoLsp">;

function readStamp(dir: string): Promise<ToolchainStamp | null> {
  return readJsonFile<ToolchainStamp>(join(dir, TOOLCHAIN_STAMP));
}

/** Whether the stamp records a binary from exactly this pin's artifact. */
function stampArchiveIs(s: ToolchainStamp, a: DenoToolchainArtifact): boolean {
  return s.archive?.file === a.file && s.archive.sha256 === a.sha256 &&
    typeof s.binary?.sha256 === "string" && typeof s.binary.size === "number" &&
    // A stamp written without the esbuild (or a tsgo) step (an older denext) re-installs to run it.
    stampHasStep(a.esbuild, s.esbuild) && stampHasStep(a.tsgo, s.tsgo) &&
    stampHasStep(a.tsgoLsp, s.tsgoLsp);
}

/** Whether the stamp records an install step the pin asks for (`pinned` absent: none needed). */
function stampHasStep(pinned: unknown, recorded: unknown): boolean {
  return pinned === undefined || (typeof recorded === "object" && recorded !== null);
}

/** Whether the stamp names exactly this pin's artifact for `target`. */
function stampMatches(
  s: ToolchainStamp | null,
  version: string,
  target: string,
  a: DenoToolchainArtifact,
): s is ToolchainStamp {
  return s?.schema === 1 && s.version === version && s.target === target && stampArchiveIs(s, a);
}

/** How {@linkcode cacheVerdict} judged a cached binary. */
type Verdict = "ok" | "rehashed" | "bad" | "missing";

/**
 * Judge the cached binary at `dir`: `ok` when the stamp matches and the binary has its recorded
 * size and mtime; `rehashed` when only its mtime moved but (with `rehash`) its SHA-256 still
 * matches the stamp; `bad` for anything else present; `missing` when there is nothing.
 */
async function cacheVerdict(
  dir: string,
  exe: string,
  version: string,
  target: string,
  artifact: DenoToolchainArtifact,
  rehash: boolean,
): Promise<Verdict> {
  const stamp = await readStamp(dir);
  const info = await Deno.lstat(join(dir, exe)).catch(() => null);
  if (!stamp && !info) return "missing";
  if (!stampMatches(stamp, version, target, artifact)) return "bad";
  return await binaryVerdict(join(dir, exe), info, stamp, rehash);
}

/** Judge the binary itself against a matching stamp (see {@linkcode cacheVerdict}). */
async function binaryVerdict(
  path: string,
  info: Deno.FileInfo | null,
  stamp: ToolchainStamp,
  rehash: boolean,
): Promise<Verdict> {
  return await fileVerdict(path, info, stamp.binary, rehash);
}

/** Judge a stamped file: its recorded size + mtime, else (with `rehash`) its SHA-256. */
async function fileVerdict(
  path: string,
  info: Deno.FileInfo | null,
  stamped: StampedFile,
  rehash: boolean,
): Promise<Verdict> {
  if (!info?.isFile || info.size !== stamped.size) return "bad";
  const mtime = info.mtime?.getTime() ?? null;
  if (mtime !== null && mtime === stamped.mtimeMs) return "ok";
  if (!rehash) return "bad";
  return await sha256File(path) === stamped.sha256 ? "rehashed" : "bad";
}

/** Whether this process was denied network access to `url`'s host (`--deny-net`, `--offline`). */
async function netDenied(url: string): Promise<boolean> {
  const host = new URL(url).host;
  const state = await Deno.permissions.query({ name: "net", host }).then((s) => s.state, () => "");
  return state === "denied";
}

/**
 * GET `artifact`, mapping a network failure / HTTP error to a download error (its `cause` says
 * whether a retry may help). A server that sends no response headers within the connect deadline
 * is given up on.
 */
async function openDownload(
  slot: DownloadNames,
  fetchImpl: typeof fetch,
  connectMs: number,
): Promise<ReadableStream<Uint8Array>> {
  const { artifact, what } = slot;
  const hint = slot.offlineHint ? ` ${slot.offlineHint}` : "";
  if (await netDenied(artifact.url)) {
    throw new DenoToolchainDownloadError(
      `denext: denext's ${what} (${artifact.file}) is not downloaded yet, and this process may ` +
        `not reach ${new URL(artifact.url).host} (offline).${hint}`,
    );
  }
  let res: Response;
  try {
    res = await fetchWithConnectDeadline(fetchImpl, artifact.url, artifact.headers, connectMs);
  } catch (err) {
    throw new DenoToolchainDownloadError(
      `denext: could not download denext's ${what} (${artifact.file}) from ` +
        `${artifact.url}: ${err instanceof Error ? err.message : err}. Are you offline?${hint}`,
      { cause: err },
    );
  }
  return await responseBody(res, artifact.url, (status) =>
    new DenoToolchainDownloadError(
      `denext: downloading denext's ${what} failed: ${status.message}`,
      { cause: status },
    ));
}

/** What a download's messages call it: the artifact, its name, and the way to fetch it ahead. */
export interface DownloadNames {
  readonly artifact: DenoToolchainArtifact;
  /** `Deno toolchain`, `denort`, `Gleam compiler`. */
  readonly what: string;
  /** Appended to an offline refusal (how to prefetch it). */
  readonly offlineHint?: string;
}

/**
 * Stream the download into the new file `dest`; its size and SHA-256. A stalled or broken
 * connection is retried on a new one (`withDownloadRetries`), the partial file deleted first.
 */
function download(
  slot: DownloadNames,
  dest: string,
  fetchImpl: typeof fetch,
  log?: (line: string) => void,
): Promise<{ size: number; sha256: string }> {
  const { artifact, what } = slot;
  const cap = artifact.size ?? MAX_DOWNLOAD;
  const hint = slot.offlineHint ? ` ${slot.offlineHint}` : "";
  return withDownloadRetries(
    `${what} ${artifact.file}`,
    async ({ fetch: fetchOnce, deadlines }) => {
      const body = await openDownload(slot, fetchOnce, deadlines.connectMs);
      // A progress line on a terminal (bytes and percent); nothing in a log or CI.
      const progress = downloadProgress(`${what} ${artifact.file}`, artifact.size);
      try {
        return await streamHashedTo(body, dest, cap, slot, progress, deadlines.idleMs);
      } catch (err) {
        await Deno.remove(dest).catch(() => {});
        throw err;
      } finally {
        progress.done();
      }
    },
    fetchImpl,
    (report) =>
      new DenoToolchainDownloadError(
        `denext: could not download denext's ${what} (${artifact.file}) from ` +
          `${artifact.url}${report}\n  Are you offline?${hint}`,
      ),
    { log },
  );
}

/** {@linkcode streamHashed} with the toolchain's refusals. */
function streamHashedTo(
  body: ReadableStream<Uint8Array>,
  dest: string,
  cap: number,
  { artifact, what }: DownloadNames,
  progress: DownloadProgress,
  idleMs: number,
): Promise<{ size: number; sha256: string }> {
  return streamHashed(
    body,
    dest,
    cap,
    {
      tooLarge: () =>
        new DenoToolchainDownloadError(
          `denext: refusing denext's ${what} ${artifact.file}: larger than its pinned ` +
            `${cap} bytes`,
        ),
      interrupted: (size, err) =>
        new DenoToolchainDownloadError(
          `denext: the ${what} download was interrupted (${artifact.file}, ${size} bytes): ` +
            `${err instanceof Error ? err.message : err}${
              err instanceof DownloadIdleError
                ? " (DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS raises the deadline)"
                : ""
            }`,
          { cause: err },
        ),
    },
    (bytes) => progress.update(bytes),
    idleMs,
  );
}

/** Check a finished download against the pin; throws (the caller deletes the file). */
function checkDownload(slot: DownloadNames, got: { size: number; sha256: string }) {
  const { artifact, what } = slot;
  if (artifact.size !== undefined && got.size !== artifact.size) {
    throw new DenoToolchainDownloadError(
      `denext: refusing denext's ${what} ${artifact.file}: got ${got.size} bytes, pinned ` +
        `${artifact.size} (truncated download)`,
    );
  }
  if (got.sha256 !== artifact.sha256) {
    throw new DenoToolchainHashError(
      `denext: REFUSING denext's ${what} ${artifact.file}: SHA-256 mismatch.\n` +
        `  pinned ${artifact.sha256}\n  got    ${got.sha256}\n` +
        "  The file was deleted unexecuted. Retry; if it persists, the download is being " +
        "tampered with.",
    );
  }
}

/**
 * Download `names.artifact` into the new file `dest` and verify it against its pin (size, then
 * SHA-256), deleting it unexecuted on any refusal. The artifact's `url` first, then each of its
 * `fallbacks` in order, every copy checked against the same pinned hash. When all fail, a SHA-256
 * refusal wins (it may be tampering); otherwise the first source's error, with the others' added.
 * The same checks as the toolchain's own install.
 *
 * @param names The artifact and how messages name it.
 * @param dest A new file (it must not exist).
 * @param fetchImpl The fetch to use.
 * @param log Where a fallback is announced (default `console.error`).
 */
export async function downloadPinned(
  names: DownloadNames,
  dest: string,
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = (l) => console.error(l),
): Promise<void> {
  const { artifact } = names;
  const sources: DenoToolchainSource[] = [
    { url: artifact.url, headers: artifact.headers },
    ...(artifact.fallbacks ?? []),
  ];
  const errors: unknown[] = [];
  for (const [i, source] of sources.entries()) {
    const one = { ...names, artifact: { ...artifact, url: source.url, headers: source.headers } };
    try {
      checkDownload(one, await download(one, dest, fetchImpl, log));
      return;
    } catch (err) {
      await Deno.remove(dest).catch(() => {});
      errors.push(err);
      if (i + 1 < sources.length) {
        log(
          `  denext: ${errorText(err).split("\n")[0]}; trying ${new URL(sources[i + 1].url).host}…`,
        );
      }
    }
  }
  throw combinedDownloadError(errors, sources);
}

/** An error's message. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The error to report when every source failed (see {@linkcode downloadPinned}). */
function combinedDownloadError(errors: unknown[], sources: DenoToolchainSource[]): unknown {
  const hash = errors.find((e) => e instanceof DenoToolchainHashError);
  if (hash) return hash;
  if (errors.length === 1) return errors[0];
  const rest = errors.slice(1).map((e, i) =>
    `\n  also tried ${sources[i + 1].url}: ${errorText(e)}`
  );
  return new DenoToolchainDownloadError(errorText(errors[0]) + rest.join(""));
}

/**
 * The verified binary out of a verified download: a zip's `deno[.exe]`, or the file itself — and
 * the directory the zip was extracted into (`null` for a bare binary).
 */
async function binaryFrom(
  artifact: DenoToolchainArtifact,
  downloaded: string,
  scratch: string,
  exe: string,
): Promise<{ binary: string; extracted: string | null }> {
  const format = artifact.format ?? "zip";
  if (format === "binary") return { binary: downloaded, extracted: null };
  const out = join(scratch, "x");
  const result = await extractArchive(downloaded, format, out);
  if (!result.files[exe]) {
    throw new Error(`denext: the archive ${artifact.file} has no top-level ${exe}`);
  }
  return { binary: join(out, exe), extracted: out };
}

/** Options for {@linkcode ensureDenoToolchain}. */
export interface EnsureDenoToolchainOptions {
  /** Defaults to the pin in force ({@linkcode loadDenoToolchainPin}). */
  readonly pin?: DenoToolchainPin;
  /** Defaults to the host's ({@linkcode denoToolchainTarget}). */
  readonly target?: string;
  /** The OS the binary runs on (its file name), default the host's. */
  readonly os?: string;
  /** Defaults to {@linkcode denoToolchainCacheRoot}. */
  readonly cacheRoot?: string;
  /** Progress output (default `console.error`). */
  readonly log?: (line: string) => void;
  /** Test seam. */
  readonly fetch?: typeof fetch;
  /** Test seam: the host OS and C library the Linux check sees ({@linkcode assertLinuxLibc}). */
  readonly host?: { readonly os?: string; readonly libc?: LinuxLibc };
}

/** A verified toolchain binary. */
export interface ResolvedDenoToolchain {
  /** The binary's absolute path. */
  readonly deno: string;
  readonly version: string;
  readonly target: string;
  /** Whether it was already cached (nothing was downloaded). */
  readonly cached: boolean;
}

/** Write the stamp for the binary at `binary` (atomically: temp file + rename). */
async function writeStamp(dir: string, stamp: ToolchainStamp): Promise<void> {
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}.json`);
  await Deno.writeTextFile(tmp, JSON.stringify(stamp, null, 2) + "\n");
  await renameRetrying(tmp, join(dir, TOOLCHAIN_STAMP));
}

/** What `path` is now, for a stamp. */
async function stampFile(path: string): Promise<StampedFile> {
  const info = await Deno.stat(path);
  return {
    size: info.size,
    sha256: await sha256File(path),
    mtimeMs: info.mtime?.getTime() ?? null,
  };
}

/**
 * The stamp for the binary at `path`, as installed (`steps`: the esbuild / tsgo steps' records).
 */
async function stampFor(
  path: string,
  version: string,
  target: string,
  artifact: DenoToolchainArtifact,
  steps: StampSteps = {},
): Promise<ToolchainStamp> {
  const { esbuild, tsgo, tsgoLsp } = steps;
  return {
    schema: 1,
    version,
    target,
    archive: { file: artifact.file, sha256: artifact.sha256 },
    binary: await stampFile(path),
    ...(esbuild ? { esbuild } : {}),
    ...(tsgo ? { tsgo } : {}),
    ...(tsgoLsp ? { tsgoLsp } : {}),
  };
}

/** A re-stamp of a binary that only moved in time keeps the esbuild and tsgo records it had. */
async function restamp(
  dir: string,
  exe: string,
  version: string,
  target: string,
  artifact: DenoToolchainArtifact,
): Promise<void> {
  const old = await readStamp(dir);
  await writeStamp(
    dir,
    await stampFor(join(dir, exe), version, target, artifact, {
      esbuild: old?.esbuild,
      tsgo: old?.tsgo,
      tsgoLsp: old?.tsgoLsp,
    }),
  );
}

/**
 * Install the archive's esbuild beside `deno` when the pin names one: only a file that hashes to
 * the pinned SHA-256 and is the version denext's esbuild API speaks; anything else is refused and
 * recorded, never installed. Returns the stamp's record (`undefined` when the pin names none).
 */
async function installEsbuild(
  artifact: DenoToolchainArtifact,
  extracted: string | null,
  dir: string,
  os: string,
): Promise<StampedEsbuild | undefined> {
  const exe = esbuildExeName(os);
  // Whatever an earlier install left goes first: a refused esbuild must not linger runnable.
  await Deno.remove(join(dir, exe)).catch(() => {});
  const pinned = artifact.esbuild;
  if (!pinned) return undefined;
  const why = await archiveEsbuildProblem(pinned, extracted, exe);
  if (why !== null) {
    return {
      refused: `the esbuild in denext's Deno toolchain (${artifact.file}) was refused: ${why}`,
    };
  }
  const path = join(extracted!, exe);
  if (os !== "windows") await Deno.chmod(path, 0o755);
  const license = join(extracted!, "esbuild.LICENSE");
  if ((await Deno.stat(license).catch(() => null))?.isFile) {
    await renameRetrying(license, join(dir, "esbuild.LICENSE"));
  }
  await renameRetrying(path, join(dir, exe));
  return { version: pinned.version, ...(await stampFile(join(dir, exe))) };
}

/**
 * The SHA-256 over every file of the compiler directory `dir` but `typescript.json`, as the fork's
 * release manifest records it (`tree_sha256`): `<name>\0<sha256>\n` per file, sorted by name.
 */
export async function tsgoTreeSha256(dir: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name !== "typescript.json") names.push(e.name);
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let lines = "";
  for (const name of names) lines += `${name}\0${await sha256File(join(dir, name))}\n`;
  return encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines)));
}

/**
 * Install one of the archive's TypeScript directories (`role`: `typescript-check/` or
 * `typescript-lsp/`) beside `deno` when the pin names it: only a build whose binary and whole
 * directory hash to the pinned SHA-256s; anything else is refused and recorded, never installed
 * (the toolchain then type-checks with its in-process TypeScript, see src/ts/engine.ts; `deno lsp`
 * fetches its own pinned language server). Returns the stamp's record (`undefined` when the pin
 * names none).
 */
async function installTsgo(
  role: TsRole,
  artifact: DenoToolchainArtifact,
  extracted: string | null,
  dir: string,
  os: string,
): Promise<StampedTsgo | undefined> {
  const installed = join(dir, role.dir);
  // Whatever an earlier install left goes first: a refused build must not linger runnable.
  await Deno.remove(installed, { recursive: true }).catch(() => {});
  const pinned = artifact[role.key];
  if (!pinned) return undefined;
  const exe = tsgoExeName(os);
  const why = await archiveTsgoProblem(role, pinned, extracted, exe);
  if (why !== null) {
    return {
      refused: `the ${role.what} in denext's Deno toolchain (${artifact.file}) ` +
        `was refused: ${why}`,
    };
  }
  const from = join(extracted!, role.dir);
  if (os !== "windows" && Deno.build.os !== "windows") await Deno.chmod(join(from, exe), 0o755);
  await renameRetrying(from, installed);
  return {
    version: pinned.version,
    treeSha256: pinned.treeSha256,
    ...(await stampFile(join(installed, exe))),
  };
}

/** Why the extracted archive's `role` directory can't be installed (`null`: it is the pinned one). */
async function archiveTsgoProblem(
  role: TsRole,
  pinned: DenoToolchainTsgo,
  extracted: string | null,
  exe: string,
): Promise<string | null> {
  if (extracted === null) return `a bare-binary toolchain pin carries no ${role.dir}/`;
  const dir = join(extracted, role.dir);
  const path = join(dir, exe);
  if (!(await Deno.stat(path).catch(() => null))?.isFile) {
    return `the archive has no ${role.dir}/${exe}`;
  }
  const got = await sha256File(path);
  if (got !== pinned.sha256) return `SHA-256 mismatch (pinned ${pinned.sha256}, got ${got})`;
  const tree = await tsgoTreeSha256(dir);
  return tree === pinned.treeSha256
    ? null
    : `its files' SHA-256 mismatch (pinned ${pinned.treeSha256}, got ${tree})`;
}

/** Why the extracted archive's esbuild can't be installed (`null`: it is the pinned one). */
async function archiveEsbuildProblem(
  pinned: DenoToolchainEsbuild,
  extracted: string | null,
  exe: string,
): Promise<string | null> {
  if (pinned.version !== ESBUILD_VERSION) {
    return `it is esbuild ${pinned.version}, and denext speaks ${ESBUILD_VERSION}`;
  }
  if (extracted === null) return "a bare-binary toolchain pin carries no esbuild";
  const path = join(extracted, exe);
  if (!(await Deno.stat(path).catch(() => null))?.isFile) {
    return `the archive has no top-level ${exe}`;
  }
  const got = await sha256File(path);
  return got === pinned.sha256 ? null : `SHA-256 mismatch (pinned ${pinned.sha256}, got ${got})`;
}

/** Download, verify and atomically install the binary into `dir` (the write lock is held). */
async function install(
  slot: CacheSlot,
  opts: EnsureDenoToolchainOptions,
): Promise<void> {
  const { dir, exe, version, target, artifact } = slot;
  // A Linux build of denext's Deno on a host that can't run it (musl, an older glibc): say so
  // before downloading it, rather than after, when it fails to exec.
  if (slot.minGlibc !== undefined && slot.os === "linux") {
    await assertLinuxLibc(`denext's ${slot.what} ${version}`, slot.minGlibc, opts.host);
  }
  await Deno.mkdir(dir, { recursive: true });
  await sweepLeftovers(dir);
  const scratch = await Deno.makeTempDir({ dir, prefix: ".tmp-" });
  try {
    const downloaded = join(scratch, artifact.file.replace(/[\\/]/g, "_"));
    const mb = artifact.size ? ` (${(artifact.size / 1024 / 1024).toFixed(1)} MB)` : "";
    (opts.log ?? ((l: string) => console.error(l)))(
      `  denext: downloading denext's ${slot.what} ${version} for ${target}${mb}…`,
    );
    await downloadPinned(slot, downloaded, opts.fetch ?? fetch, opts.log);
    const os = slot.os;
    const { binary, extracted } = await binaryFrom(artifact, downloaded, scratch, exe);
    if (os !== "windows" && Deno.build.os !== "windows") await Deno.chmod(binary, 0o755);
    // A stale stamp goes first: a crash between here and the new stamp leaves NO stamp, which
    // the next run treats as missing (a fresh download), never as a verified binary.
    await Deno.remove(join(dir, TOOLCHAIN_STAMP)).catch(() => {});
    const esbuild = await installEsbuild(artifact, extracted, dir, os);
    const tsgo = await installTsgo(TS_CHECK, artifact, extracted, dir, os);
    const tsgoLsp = await installTsgo(TS_LSP, artifact, extracted, dir, os);
    await renameRetrying(binary, join(dir, exe));
    await writeStamp(
      dir,
      await stampFor(join(dir, exe), version, target, artifact, { esbuild, tsgo, tsgoLsp }),
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

/** One verified binary in the cache: where it goes and the pinned archive it comes from. */
export interface CacheSlot extends DownloadNames {
  /** The cache root (the lock lives there). */
  readonly root: string;
  /** The binary's directory (its stamp beside it). */
  readonly dir: string;
  /** The binary's file name. */
  readonly exe: string;
  /** The OS the binary runs on. */
  readonly os: string;
  readonly version: string;
  readonly target: string;
  /**
   * The glibc a Linux binary needs ({@linkcode minGlibcFor}), checked against the host before a
   * download; absent for a binary with no such need (the static musl Gleam).
   */
  readonly minGlibc?: string;
}

/**
 * Make `slot`'s binary available and verified in the cache (see the module header): reuse it when
 * its stamp matches, else download, verify and install it under the cache lock. Resolves whether
 * it was already cached. The pinned Gleam compiler (gleam-toolchain.ts) is cached the same way.
 * Refuses a cache another user can write ({@linkcode assertTrustedCacheDirs}).
 *
 * @param slot The binary, its cache directory and its pinned archive.
 * @param options The download seams (`fetch`, `log`).
 * @returns Whether it was already cached.
 */
export function ensureCached(
  slot: CacheSlot,
  options: EnsureDenoToolchainOptions,
): Promise<boolean> {
  return lockTask(() => ensureCachedInTask(slot, options));
}

async function ensureCachedInTask(
  slot: CacheSlot,
  options: EnsureDenoToolchainOptions,
): Promise<boolean> {
  const { root, dir, exe, version, target, artifact } = slot;
  const descr = slot.what === "Deno toolchain" ? CACHE_DESCR : `${slot.what} cache`;
  await Deno.mkdir(root, { recursive: true });
  // Before the lock files are opened or a cached binary is trusted: nobody else may write here.
  await assertTrustedCacheDirs(cacheDirChain(dirname(root), dir));
  {
    using _shared = await acquireCacheLock(root, "shared", descr);
    if (await cacheVerdict(dir, exe, version, target, artifact, false) === "ok") return true;
  }
  const present = await cacheVerdict(dir, exe, version, target, artifact, false) !== "missing";
  using _write = await acquireCacheLock(root, present ? "mutate" : "download", descr);
  // Re-check once granted: the process this one waited on may have installed it.
  const verdict = await cacheVerdict(dir, exe, version, target, artifact, true);
  if (verdict === "ok") return true;
  if (verdict === "rehashed") {
    await restamp(dir, exe, version, target, artifact);
    return true;
  }
  if (verdict === "bad") {
    (options.log ?? ((l: string) => console.error(l)))(
      `  denext: the cached ${slot.what} at ${dir} failed verification; re-downloading.`,
    );
  }
  await install(slot, options);
  if (await cacheVerdict(dir, exe, version, target, artifact, false) !== "ok") {
    throw new Error(`denext: the ${slot.what} at ${dir} did not verify after install`);
  }
  return false;
}

/**
 * The cache state of `slot`'s binary, without downloading: `cached` (present, its stamp matches
 * the pin, and — with `verify` — it re-hashes to the stamp), `missing`, or `invalid` (re-downloaded
 * on next use).
 *
 * @param slot The binary.
 * @param verify Re-hash it even when its size and mtime match.
 * @returns The state.
 */
export async function cachedSlotState(
  slot: CacheSlot,
  verify = false,
): Promise<"cached" | "missing" | "invalid"> {
  const { dir, exe, version, target, artifact } = slot;
  const verdict = await cacheVerdict(dir, exe, version, target, artifact, true);
  if (verdict === "missing") return "missing";
  if (verdict === "bad") return "invalid";
  if (verify && await sha256File(join(dir, exe)) !== (await readStamp(dir))?.binary.sha256) {
    return "invalid";
  }
  return "cached";
}

/**
 * Make the pinned toolchain binary for this host available in the cache — verified — and return
 * its path. See the module header for the guarantees.
 *
 * @param options What to fetch and how.
 * @returns The binary.
 */
export async function ensureDenoToolchain(
  options: EnsureDenoToolchainOptions = {},
): Promise<ResolvedDenoToolchain> {
  const pin = options.pin ?? loadDenoToolchainPin();
  const target = options.target ?? denoToolchainTarget();
  const artifact = pinnedArtifact(pin, target);
  const version = pin.version!;
  const root = options.cacheRoot ?? denoToolchainCacheRoot();
  const dir = binaryDir(root, version, target);
  const os = options.os ?? Deno.build.os;
  const exe = exeName(os);
  const slot = {
    root,
    dir,
    exe,
    os,
    version,
    target,
    artifact,
    what: "Deno toolchain",
    minGlibc: minGlibcFor(pin),
  };
  const cached = await ensureCached(slot, options);
  return { deno: join(dir, exe), version, target, cached };
}

/** A verified `denort` ({@linkcode ensureDenort}). */
export interface ResolvedDenort {
  /** The `denort[.exe]` path, for `DENORT_BIN`. */
  readonly denort: string;
  readonly version: string;
  readonly target: string;
  /** Whether it was already cached (nothing was downloaded). */
  readonly cached: boolean;
}

/** `deno compile --target` triples → the pin's `<os>-<arch>` keys. */
const COMPILE_TARGET_KEYS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "aarch64-pc-windows-msvc": "windows-aarch64",
};

/**
 * The pin key (`<os>-<arch>`) of a `deno compile --target` triple (`x86_64-unknown-linux-gnu` →
 * `linux-x86_64`), or `undefined` for a triple denext's toolchain is not built for.
 *
 * @param triple The Rust target triple (`Deno.build.target` spells this machine's).
 * @returns The key, or `undefined`.
 */
export function denortTargetKey(triple: string): string | undefined {
  return COMPILE_TARGET_KEYS[triple];
}

/**
 * The Rust target triple of a pin key (`linux-x86_64` → `x86_64-unknown-linux-gnu`), the naming the
 * revoked-runtimes list uses; `undefined` for a key denext's toolchain is not built for.
 *
 * @param key The pin key (`<os>-<arch>`).
 * @returns The triple, or `undefined`.
 */
export function toolchainTargetTriple(key: string): string | undefined {
  return Object.keys(COMPILE_TARGET_KEYS).find((triple) => COMPILE_TARGET_KEYS[triple] === key);
}

/**
 * Make the pinned `denort` for `options.target` (an `<os>-<arch>` key, default this host's)
 * available in the cache — SHA-256-verified exactly like the toolchain binary, under
 * `<cache>/<version>/<target>-denort/` — and return its path. Throws
 * {@linkcode DenoToolchainUnavailableError} when the pin names no denort for the target (a pin
 * from before 2.9.7-denext.20), and the toolchain's download / hash errors otherwise.
 *
 * @param options What to fetch and how (`os` defaults to the target's).
 * @returns The verified `denort`.
 */
export async function ensureDenort(
  options: EnsureDenoToolchainOptions = {},
): Promise<ResolvedDenort> {
  const pin = options.pin ?? loadDenoToolchainPin();
  const target = options.target ?? denoToolchainTarget();
  const artifact = pinnedArtifact(pin, target, true);
  const version = pin.version!;
  const root = options.cacheRoot ?? denoToolchainCacheRoot();
  const dir = join(root, version, `${target}-denort`);
  const os = options.os ?? target.split("-")[0];
  const exe = os === "windows" ? "denort.exe" : "denort";
  const slot = { root, dir, exe, os, version, target, artifact, what: "denort" };
  const cached = await ensureCached(slot, options);
  return { denort: join(dir, exe), version, target, cached };
}

// ---------------------------------------------------------------------------------------------
// Choosing the Deno a command runs on.

/** What {@linkcode resolveDenoToolchain} chose. */
export type DenoToolchainChoice =
  | {
    readonly kind: "toolchain";
    /** The binary to run. */
    readonly deno: string;
    /** The marker value (`DENEXT_TOOLCHAIN_ACTIVE`): the version, or `path` for an override. */
    readonly version: string;
    /** Say this once before running (the unverified `DENEXT_DENO=<path>` override). */
    readonly warning?: string;
    /**
     * Set for a `DENEXT_DENO=<path>` binary whose `deno --version` carries no denext identity: it
     * is stock Deno (a deprecated path: 5.0 refuses it). Unset when it is denext's, or when its
     * version can't be read.
     */
    readonly stock?: true;
    /**
     * What the revoked-runtimes list said about the pinned toolchain, when it was checked
     * (src/build/runtime-revocations.ts): `runningRollback` when `deno` is the pin's `rollback`.
     */
    readonly revocation?: RuntimeRevocationStatus;
  }
  | {
    readonly kind: "stock";
    /** Why stock Deno runs. */
    readonly reason: string;
    /** Set for the explicit `DENEXT_DENO=stock` opt-out (a deprecated path: 5.0 refuses it). */
    readonly optedOut?: true;
    /** Say this once (a failure or a missing grant), or nothing (an opt-out, no pin yet). */
    readonly warning?: string;
    /**
     * Set when the toolchain is pinned but this process lacks the grants to start it: the
     * `denext:` message a verb that runs project code ends with instead of running on this Deno
     * (a verb that only hands the toolchain to its children keeps its Deno, silently).
     */
    readonly refusal?: string;
  };

/** Options for {@linkcode resolveDenoToolchain}. */
export interface ResolveDenoToolchainOptions extends EnsureDenoToolchainOptions {
  /** Env reader (default `Deno.env.get`). */
  readonly env?: EnvGet;
  /**
   * The grants this process lacks to install and run the toolchain (default: a query of
   * `run`, and `read` + `write` on the cache root; never prompts).
   */
  readonly missingGrants?: (cacheRoot: string) => Promise<string[]>;
  /** `<bin> --version`'s output for a `DENEXT_DENO=<path>` binary, or null (default: run it). */
  readonly versionOutput?: (bin: string) => Promise<string | null>;
  /**
   * How the revoked-runtimes list is consulted. Absent: the built-in pin is checked in `fetch` mode
   * (a pin given as `pin` or by `DENEXT_TOOLCHAIN_PIN_FILE` is not checked); given, it is checked
   * whatever the pin (tests).
   */
  readonly revocations?: ToolchainRevocationOptions;
}

/** {@linkcode ResolveDenoToolchainOptions.revocations}. */
export interface ToolchainRevocationOptions extends Omit<LoadRevocationsOptions, "env" | "mode"> {
  /** Default `fetch`; `cache-only` for `start` / `job` (no network at boot). */
  readonly mode?: RevocationMode;
  /**
   * The runtimes that must roll back together: `["cli"]` (default), or `["cli", "desktop"]` for
   * the desktop verbs, whose `deno desktop` CLI and libdenort must come from one release.
   */
  readonly components?: readonly RuntimeComponent[];
  /** The Deno Desktop runtime pin (default the built-in one). */
  readonly desktopPin?: Pick<DesktopRuntimePin, "version" | "targets" | "rollback">;
}

/** The `--allow-*` grants this process lacks for `cacheRoot` (queried, never prompted). */
async function queryMissingGrants(cacheRoot: string): Promise<string[]> {
  const wanted: [string, Deno.PermissionDescriptor][] = [
    ["--allow-run", { name: "run" }],
    ["--allow-read", { name: "read", path: cacheRoot }],
    ["--allow-write", { name: "write", path: cacheRoot }],
  ];
  const missing: string[] = [];
  for (const [flag, desc] of wanted) {
    const state = await Deno.permissions.query(desc).then((s) => s.state, () => "denied");
    if (state !== "granted") missing.push(flag);
  }
  return missing;
}

/** A pinned tool's status under a `<NAME>=<path>` override (`DENEXT_GLEAM`, `DENEXT_FASTLANE`). */
export interface PathOverrideStatus {
  readonly mode: "path";
  readonly state: "n/a";
  /** The override, resolved. */
  readonly path: string;
  /** Whether it names a file. */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
}

/**
 * The status line of a `<NAME>=<path>` override: the path resolved, and whether it is a file (it
 * is run unverified).
 *
 * @param raw The variable's value ({@linkcode toolchainEnvValue}).
 * @param envName The variable's name, for the report.
 * @returns The status fields.
 */
export async function pathOverrideStatus(
  raw: string,
  envName: string,
): Promise<PathOverrideStatus> {
  const path = resolve(raw);
  const exists = (await Deno.stat(path).catch(() => null))?.isFile === true;
  return {
    mode: "path",
    state: "n/a",
    path,
    ok: exists,
    detail: `${envName}=${path} (unverified)${exists ? "" : " — NOT FOUND"}`,
  };
}

/**
 * The `DENEXT_DENO` value as denext interprets it: trimmed, then without ONE pair of matching
 * surrounding quotes (`"…"` or `'…'`) — Windows cmd's `set DENEXT_DENO="C:\Program
 * Files\deno\deno.exe"` keeps the quotes in the value. Mismatched quotes are left as they are.
 *
 * @param env The environment to read (defaults to the process).
 * @param name The variable (default `DENEXT_DENO`; `DENEXT_GLEAM` reads the same way).
 * @returns The value, `""` when unset.
 */
export function toolchainEnvValue(env: EnvGet = processEnv, name = TOOLCHAIN_ENV): string {
  const raw = (env(name) ?? "").trim();
  const quote = raw[0];
  if (raw.length >= 2 && (quote === '"' || quote === "'") && raw.endsWith(quote)) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

/** The `DENEXT_DENO` mode: `pinned`, `stock`, or a path. */
function toolchainMode(env: EnvGet): { mode: "pinned" | "stock" } | { mode: "path"; path: string } {
  const raw = toolchainEnvValue(env);
  if (raw === "" || raw.toLowerCase() === "pinned") return { mode: "pinned" };
  if (raw.toLowerCase() === "stock") return { mode: "stock" };
  return { mode: "path", path: raw };
}

/**
 * `DENEXT_DENO=<path>`: that binary, unverified, when it exists. A relative path is resolved
 * against the directory denext started in, so a child run in another directory (`--cwd`, a
 * forwarded verb) still finds it.
 */
async function pathChoice(
  raw: string,
  versionOutput: (bin: string) => Promise<string | null>,
): Promise<DenoToolchainChoice> {
  const path = resolve(raw);
  if (!(await Deno.stat(path).catch(() => null))?.isFile) {
    throw new DenoToolchainRequiredError(
      `denext: ${TOOLCHAIN_ENV}=${path} is not a file.\n  Point it at a deno binary, set ` +
        `${TOOLCHAIN_ENV}=stock to run the deno that started denext, or unset it to run ` +
        "denext's own Deno toolchain.",
    );
  }
  const identity = parseDenoVersionOutput(await versionOutput(path) ?? "");
  return {
    kind: "toolchain",
    deno: path,
    version: "path",
    warning: `denext: using the Deno at ${path} (${TOOLCHAIN_ENV}); it is not downloaded, ` +
      "pinned or verified.",
    // Stock by the identity marker, not the version alone (src/build/deno-version.ts).
    ...(identity && !isDenextDenoVersion(identity) ? { stock: true as const } : {}),
  };
}

/**
 * Pick the Deno the current command should run on — denext's toolchain (downloaded and verified
 * on first use), or what the user chose explicitly: `DENEXT_DENO=<path>` (that binary) or
 * `DENEXT_DENO=stock` (the Deno that started the CLI). Stock Deno is also chosen, silently, when
 * this denext version pins no toolchain, and for a process run without the grants to install and
 * start it (a least-privilege `start`: it runs on the Deno that launched it and spawns none).
 * Anything else that keeps the toolchain from running — offline on first use, no build for this
 * host, a failed or mismatching download, an unreadable pin file, a `DENEXT_DENO=<path>` that is
 * not a file — throws {@linkcode DenoToolchainRequiredError} naming the fix: denext never falls
 * back to another Deno on its own.
 *
 * @param options Seams; all default to the process.
 * @returns The choice.
 * @throws {DenoToolchainRequiredError} When the toolchain can't be had.
 */
export async function resolveDenoToolchain(
  options: ResolveDenoToolchainOptions = {},
): Promise<DenoToolchainChoice> {
  const env = options.env ?? processEnv;
  const mode = toolchainMode(env);
  if (mode.mode === "stock") {
    return { kind: "stock", reason: `${TOOLCHAIN_ENV}=stock`, optedOut: true };
  }
  if (mode.mode === "path") {
    return await pathChoice(mode.path, options.versionOutput ?? denoVersionOutput);
  }
  let pin: DenoToolchainPin;
  try {
    pin = options.pin ?? loadDenoToolchainPin(env);
  } catch (err) {
    throw new DenoToolchainRequiredError(`${errText(err)}\n${TOOLCHAIN_FIX}`);
  }
  return await pinnedChoice(pin, env, options);
}

const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

/** A `stock` choice, with its warning when there is one. */
function stockChoice(reason: string, warning?: string): DenoToolchainChoice {
  return { kind: "stock", reason, ...(warning ? { warning } : {}) };
}

/** Why stock Deno must run for `pin` on `target`, before any download; `null` when nothing. */
async function pinnedObstacle(
  pin: DenoToolchainPin,
  target: string,
  cacheRoot: string,
  missingGrants: (cacheRoot: string) => Promise<string[]>,
): Promise<DenoToolchainChoice | null> {
  if (pin.version === null) return stockChoice("not available for this denext version");
  if (!pin.targets[target]) {
    throw new DenoToolchainRequiredError(
      `denext: denext's Deno toolchain ${pin.version} has no build for ${target} (it has: ` +
        `${Object.keys(pin.targets).join(", ") || "none"}).\n  Opt out explicitly: ` +
        `${TOOLCHAIN_ENV}=stock runs the deno that started denext (or the \`deno\` on PATH), ` +
        `${TOOLCHAIN_ENV}=<path> runs that deno binary.`,
    );
  }
  const missing = await missingGrants(cacheRoot);
  if (missing.length === 0) return null;
  // A process scoped down on purpose (the least-privilege `start` task `denext create` scaffolds)
  // can't start the toolchain. A verb that runs project code refuses with the ways out rather than
  // run on this Deno: there `Deno.SQL` (`postgresClient()`, the Prisma adapter) and the toolchain's
  // other changes would be missing in production while `dev` had them.
  return {
    kind: "stock",
    reason: `this process lacks ${missing.join(" ")} (for ${cacheRoot})`,
    refusal: grantsRefusal(pin.version, missing, cacheRoot),
  };
}

/** The refusal of {@linkcode pinnedObstacle}: what a project-code verb ends with, and the fixes. */
function grantsRefusal(version: string, missing: readonly string[], cacheRoot: string): string {
  return `denext: this process can't start denext's Deno toolchain ${version} (it lacks ` +
    `${missing.join(" ")} for ${cacheRoot}), and project code runs on the toolchain, not on ` +
    `Deno ${Deno.version.deno}.\n` +
    "  Run the command on the toolchain itself: `denext task start` (a task's `deno` is the " +
    "toolchain), the binary `denext toolchain path` prints, or the image / unit " +
    "`denext deploy prepare` writes.\n" +
    `  Or grant ${missing.join(" ")} so it re-runs itself on the toolchain.\n` +
    `  ${TOOLCHAIN_ENV}=stock runs it on this Deno instead (no Deno.SQL / postgresClient()).`;
}

/** The pinned toolchain (installed and verified), or the silent stock choice of {@linkcode pinnedObstacle}. */
async function pinnedChoice(
  pin: DenoToolchainPin,
  env: EnvGet,
  options: ResolveDenoToolchainOptions,
): Promise<DenoToolchainChoice> {
  const target = options.target ?? denoToolchainTarget();
  const cacheRoot = options.cacheRoot ?? denoToolchainCacheRoot(env);
  // The list is read (and, when stale, fetched within its budget) while the grants are queried.
  const [obstacle, selected] = await Promise.all([
    pinnedObstacle(pin, target, cacheRoot, options.missingGrants ?? queryMissingGrants),
    selectToolchainPin(pin, env, options, target, cacheRoot),
  ]);
  if (obstacle) return obstacle;
  try {
    const rt = await ensureDenoToolchain({ ...options, pin: selected.pin, target, cacheRoot });
    return {
      kind: "toolchain",
      deno: rt.deno,
      version: rt.version,
      ...(selected.warning ? { warning: selected.warning } : {}),
      ...(selected.revocation ? { revocation: selected.revocation } : {}),
    };
  } catch (err) {
    throw new DenoToolchainRequiredError(`${errText(err)}\n${TOOLCHAIN_FIX}`);
  }
}

/** The pin {@linkcode selectToolchainPin} chose, and what to say about it. */
export interface ToolchainSelection {
  /** The pin to install and run: the pin in force, or its `rollback`. */
  readonly pin: DenoToolchainPin;
  /** The one-line notice, when the pinned toolchain is revoked and it was not said yet. */
  readonly warning?: string;
  /** What the list said, when it was consulted. */
  readonly revocation?: RuntimeRevocationStatus;
}

/**
 * Whether the revoked-runtimes list is consulted for `options`: never for a pin file override
 * (fork development), nor for a pin a caller passed without asking for the check (tests).
 */
function revocationsApply(env: EnvGet, options: ResolveDenoToolchainOptions): boolean {
  if (env(TOOLCHAIN_PIN_FILE_ENV)) return false;
  return options.pin === undefined || options.revocations !== undefined;
}

/** The runtimes a command on `target` runs, as the list names them. */
function toolchainSubjects(
  pin: DenoToolchainPin,
  rollback: DenoToolchainPin | null,
  target: string,
  options: ToolchainRevocationOptions,
): RevocationSubject[] {
  const triple = toolchainTargetTriple(target);
  const usable = rollback?.targets[target] ? rollback.version : null;
  const subjects: RevocationSubject[] = [
    { component: "cli", version: pin.version!, rollback: usable, triple },
  ];
  if (!(options.components ?? ["cli"]).includes("desktop")) return subjects;
  // libdenort must match the `deno desktop` CLI: the desktop runtime rolls back only to the same
  // release as the toolchain.
  const desktop = options.desktopPin ?? DESKTOP_RUNTIME_PIN;
  const same = desktop.rollback?.version === usable && triple !== undefined &&
    desktop.rollback?.targets[triple] !== undefined;
  subjects.push({
    component: "desktop",
    version: desktop.version,
    rollback: same ? usable : null,
    triple,
  });
  return subjects;
}

/**
 * The toolchain to run for `pin` (see src/build/runtime-revocations.ts): the pin in force, or its
 * `rollback` when the revoked-runtimes list revokes it for this host and the rollback is not
 * revoked too. The toolchain marker (`DENEXT_TOOLCHAIN_ACTIVE`) decides nothing: it can leak from
 * a parent shell or a copied CI env, so the list is consulted whatever it says (the processes a
 * command starts stay quiet through `DENEXT_REVOCATION_NOTICED`). Never throws.
 *
 * @param pin The pin in force.
 * @param env Env reader.
 * @param options The resolver's options (`revocations` configures the check).
 * @param target The host's pin key.
 * @param cacheRoot The toolchain cache (where the list is cached).
 * @returns The pin to run, and what to say.
 */
export async function selectToolchainPin(
  pin: DenoToolchainPin,
  env: EnvGet,
  options: ResolveDenoToolchainOptions,
  target: string,
  cacheRoot: string,
): Promise<ToolchainSelection> {
  const rollback = rollbackToolchainPin(pin);
  if (pin.version === null || !revocationsApply(env, options)) return { pin };
  const r = options.revocations ?? {};
  const loaded = await loadRuntimeRevocations({ ...r, env, cacheRoot });
  const decision = decideRevocation(loaded.list, toolchainSubjects(pin, rollback, target, r));
  const revocation = revocationStatus(loaded, decision, pin.version, rollback?.version ?? null);
  if (!decision.hit) return loaded.configured ? { pin, revocation } : { pin };
  const chosen = decision.useRollback ? rollback! : pin;
  if (env(REVOCATION_NOTICED_ENV) === "1") return { pin: chosen, revocation };
  const warning = revocationNotice(
    decision.hit,
    decision.triple,
    decision.useRollback ? chosen.version : null,
  );
  return { pin: chosen, revocation, warning };
}

/**
 * The toolchain this machine would run for the pin in force — the pin, or its rollback when the
 * revoked-runtimes list revokes it here — as `toolchain status` / `install` / `path` and `doctor`
 * report it: the list read in `mode`, whatever toolchain marker this process inherited.
 *
 * @param mode How the list is read (`force` fetches now, within its 5 s budget).
 * @param env Env reader.
 * @returns The selection.
 */
export function toolchainSelection(
  mode: RevocationMode,
  env: EnvGet = processEnv,
): Promise<ToolchainSelection> {
  const unmarked: EnvGet = (name) => name === TOOLCHAIN_ACTIVE_ENV ? undefined : env(name);
  return selectToolchainPin(
    loadDenoToolchainPin(env),
    unmarked,
    { revocations: { mode } },
    denoToolchainTarget(),
    denoToolchainCacheRoot(env),
  );
}

// ---------------------------------------------------------------------------------------------
// `denext toolchain status` / `denext doctor`'s view.

/** The toolchain's state on this machine. */
export interface DenoToolchainStatus {
  readonly mode: "pinned" | "stock" | "path";
  /** The pinned version (`null` when none is pinned for this denext version). */
  readonly version: string | null;
  readonly target: string;
  /**
   * `cached` = present + verified; `missing` = downloads on first use; `invalid` = re-downloads;
   * `unpinned` = no toolchain for this denext version; `unsupported` = none for this host.
   */
  readonly state: "cached" | "missing" | "invalid" | "unpinned" | "unsupported" | "n/a";
  /** The binary (`null` when there is none to run). */
  readonly path: string | null;
  /** Whether this process runs on it. */
  readonly active: boolean;
  /** This process's `Deno.version.deno`. */
  readonly running: string;
  /** Whether nothing needs fixing (a missing cache is fine: it downloads). */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
  /** The toolchain's esbuild (what denext's esbuild API spawns when it is `ok`). */
  readonly esbuild: ToolchainEsbuildStatus;
  /** The toolchain's native TypeScript compiler (what its type checking runs when it is `ok`). */
  readonly tsgo: ToolchainTsgoStatus;
  /** The toolchain's TypeScript language server (what `deno lsp`'s tsgo backend runs when `ok`). */
  readonly tsgoLsp: ToolchainTsgoStatus;
}

/** Options for {@linkcode denoToolchainStatus}. */
export interface DenoToolchainStatusOptions {
  readonly env?: EnvGet;
  readonly pin?: DenoToolchainPin;
  readonly target?: string;
  readonly os?: string;
  readonly cacheRoot?: string;
  /** Re-hash a cached binary even when its size and mtime match. */
  readonly verify?: boolean;
  /**
   * This process's Deno (default {@linkcode currentDenoIdentity}: `Deno.version.deno` and its
   * `Deno.build.denext` marker).
   */
  readonly running?: DenoIdentity;
  /**
   * Whether this process is a compiled `denext` executable (default: `Deno.build.standalone`).
   * Its own embedded Deno never runs a command: every child it starts runs on the toolchain.
   */
  readonly standalone?: boolean;
}

const STATE_TEXT: Record<DenoToolchainStatus["state"], string> = {
  cached: "cached + verified",
  missing: "not cached yet (downloaded on the first command that runs project code)",
  invalid: "cache FAILED verification (re-downloaded on next use)",
  unpinned: "not available for this denext version (stock Deno runs)",
  unsupported: "no build for this host (commands refuse; DENEXT_DENO=stock opts out)",
  "n/a": "",
};

/** The cache state of the pinned binary, without downloading. */
async function cacheState(
  pin: DenoToolchainPin,
  target: string,
  root: string,
  os: string,
  verify: boolean,
): Promise<{ state: DenoToolchainStatus["state"]; path: string | null }> {
  if (pin.version === null) return { state: "unpinned", path: null };
  const artifact = pin.targets[target];
  if (!artifact) return { state: "unsupported", path: null };
  const dir = binaryDir(root, pin.version, target);
  const exe = exeName(os);
  const slot = {
    root,
    dir,
    exe,
    os,
    version: pin.version,
    target,
    artifact,
    what: "Deno toolchain",
  };
  return { state: await cachedSlotState(slot, verify), path: join(dir, exe) };
}

/** A compiled executable fetches the toolchain before any command but `toolchain` / `completions`. */
const MISSING_STANDALONE_TEXT = "not cached yet (downloaded on the first denext command)";

/**
 * What a compiled `denext` executable says about the Deno that runs: never its own embedded one
 * (which runs only the CLI itself) but the one it hands every child — the toolchain, a
 * `DENEXT_DENO=<path>` binary, or with `DENEXT_DENO=stock` the `deno` on PATH.
 */
function executableText(mode: "pinned" | "stock" | "path", embedded: string): string {
  const own = `this executable embeds deno ${embedded} for itself only`;
  if (mode === "stock") return `commands run on the \`deno\` on PATH (${own})`;
  return `denext runs every command on it (${own})`;
}

/** What status says about the Deno running: this process's, or a compiled executable's children's. */
function runningLine(
  standalone: boolean,
  mode: "pinned" | "stock" | "path",
  active: boolean,
  running: string,
): string {
  if (standalone) return executableText(mode, running);
  return active ? `running on it (deno ${running})` : `running on deno ${running}`;
}

/** The cache state's text; a compiled executable downloads a missing toolchain sooner. */
function stateLine(state: DenoToolchainStatus["state"], standalone: boolean): string {
  return standalone && state === "missing" ? MISSING_STANDALONE_TEXT : STATE_TEXT[state];
}

/**
 * Report denext's Deno toolchain on this machine: the pinned version, whether it is cached and
 * verified, whether this process runs on it, and why not. Never downloads.
 *
 * @param options Seams; all default to the process.
 * @returns The status.
 */
export async function denoToolchainStatus(
  options: DenoToolchainStatusOptions = {},
): Promise<DenoToolchainStatus> {
  const env = options.env ?? processEnv;
  const identity = options.running ?? currentDenoIdentity();
  const running = identity.deno;
  const target = options.target ?? denoToolchainTarget();
  const mode = toolchainMode(env);
  const pin = options.pin ?? loadDenoToolchainPin(env);
  // From the running Deno alone: denext's Deno (its `Deno.build.denext` marker, or a pre-marker
  // build's version) of the pin's version. An inherited marker, an older `-denext.N` build (a stale
  // `toolchain link`) or upstream Deno of the pinned number is not the pinned toolchain; a
  // `DENEXT_DENO=<path>` binary has no version to check, so there the marker its own launch set
  // ("path") counts.
  const active = mode.mode === "path"
    ? env(TOOLCHAIN_ACTIVE_ENV) === "path"
    : isPinnedDenextDeno(identity, pin.version);
  const standalone = options.standalone ??
    (Deno.build as { standalone?: boolean }).standalone === true;
  const runningText = runningLine(standalone, mode.mode, active, running);
  const esbuild = await toolchainEsbuild({ ...options, env, pin, target });
  const tsgo = await toolchainTsgo({ ...options, env, pin, target });
  const tsgoLsp = await toolchainTsgoLsp({ ...options, env, pin, target });
  const base = {
    version: pin.version,
    target,
    active,
    running,
    state: "n/a" as const,
    esbuild,
    tsgo,
    tsgoLsp,
  };
  if (mode.mode === "stock") {
    return {
      ...base,
      mode: "stock",
      path: null,
      ok: true,
      detail: `${TOOLCHAIN_ENV}=stock — stock Deno runs everything; ${runningText}`,
    };
  }
  if (mode.mode === "path") {
    const exists = (await Deno.stat(mode.path).catch(() => null))?.isFile === true;
    return {
      ...base,
      mode: "path",
      path: mode.path,
      ok: exists,
      detail: `${TOOLCHAIN_ENV}=${mode.path} (unverified)${exists ? "" : " — NOT FOUND"}; ` +
        runningText,
    };
  }
  const root = options.cacheRoot ?? denoToolchainCacheRoot(env);
  const { state, path } = await cacheState(
    pin,
    target,
    root,
    options.os ?? Deno.build.os,
    options.verify === true,
  );
  return {
    ...base,
    mode: "pinned",
    state,
    path,
    ok: state !== "invalid",
    detail: `${pin.version ? `toolchain ${pin.version} for ${target}` : "toolchain"}; ` +
      `${stateLine(state, standalone)}; ${runningText}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The toolchain's esbuild (what src/build/esbuild/binary.ts spawns before the npm fallback).

/** The toolchain's esbuild on this machine. */
export interface ToolchainEsbuildStatus {
  /**
   * `ok` = installed and verified (denext's esbuild API runs it); `missing` = the toolchain is not
   * cached; `refused` = it failed verification (the npm esbuild runs, with a warning); `none` =
   * this pin's toolchain ships no esbuild (before 2.9.7-denext.17: the npm esbuild runs); `n/a` =
   * `DENEXT_DENO=stock` or a path (the npm esbuild runs).
   */
  readonly state: "ok" | "missing" | "refused" | "none" | "n/a";
  /** The binary (`ok` only). */
  readonly path: string | null;
  /** The esbuild version the pin names (`null`: none). */
  readonly version: string | null;
  /** One line for a report. */
  readonly detail: string;
}

/**
 * Whether denext's Deno toolchain has a verified esbuild for this host — the second choice of
 * denext's esbuild API after `ESBUILD_BINARY_PATH`. Never downloads: the toolchain is installed by
 * the command that re-runs itself on it. A binary whose size or mtime moved since its stamp is
 * re-hashed against the pin.
 *
 * @param options Seams; all default to the process.
 * @returns The state, and the binary when it is `ok`.
 */
export async function toolchainEsbuild(
  options: DenoToolchainStatusOptions = {},
): Promise<ToolchainEsbuildStatus> {
  const q = await stepQuery(options);
  if ("mode" in q) {
    return esbuildState("n/a", null, `${TOOLCHAIN_ENV}=${q.mode}: the npm esbuild runs`);
  }
  const { pin, target, artifact, dir, stamp } = q;
  if (!artifact?.esbuild) {
    return esbuildState("none", null, "this toolchain ships no esbuild: the npm esbuild runs");
  }
  const pinned = artifact.esbuild;
  if (!stampMatches(stamp, pin.version!, target, artifact)) {
    return esbuildState("missing", pinned, `esbuild ${pinned.version} arrives with the toolchain`);
  }
  const rec = stamp.esbuild!;
  if ("refused" in rec) return esbuildState("refused", pinned, rec.refused);
  const path = join(dir, esbuildExeName(options.os ?? Deno.build.os));
  const why = await installedEsbuildProblem(path, rec, pinned, options.verify === true);
  return why === null
    ? esbuildState("ok", pinned, `esbuild ${pinned.version} (verified)`, path)
    : esbuildState(
      "refused",
      pinned,
      `the esbuild in denext's Deno toolchain (${path}) was refused: ${why}`,
    );
}

/** {@linkcode stepQuery}'s result. */
type StepQuery = { mode: "stock" | "<path>" } | {
  pin: DenoToolchainPin;
  target: string;
  artifact: DenoToolchainArtifact | undefined;
  dir: string;
  stamp: ToolchainStamp | null;
};

/**
 * What a status query of one of the archive's install steps (esbuild, tsgo) starts from: the
 * toolchain mode when it is not the pinned one (`stock` / `<path>`), else the pin, the host
 * target, its artifact, the cached binary's directory and its stamp.
 */
async function stepQuery(options: DenoToolchainStatusOptions): Promise<StepQuery> {
  const env = options.env ?? processEnv;
  const mode = toolchainMode(env).mode;
  if (mode !== "pinned") return { mode: mode === "stock" ? "stock" : "<path>" };
  // The pin of the toolchain this process runs: its rollback, when the command that started it
  // ran that one.
  const pin = options.pin ?? activeToolchainPin(env);
  const target = options.target ?? denoToolchainTarget();
  const artifact = pinnedTargetArtifact(pin, target);
  const root = options.cacheRoot ?? denoToolchainCacheRoot(env);
  const dir = binaryDir(root, pin.version ?? "", target);
  return { pin, target, artifact, dir, stamp: artifact ? await readStamp(dir) : null };
}

/** The pin's artifact for `target` (none when nothing is pinned). */
function pinnedTargetArtifact(
  pin: DenoToolchainPin,
  target: string,
): DenoToolchainArtifact | undefined {
  return pin.version === null ? undefined : pin.targets[target];
}

/** A {@linkcode ToolchainEsbuildStatus}. */
function esbuildState(
  state: ToolchainEsbuildStatus["state"],
  pinned: DenoToolchainEsbuild | null,
  detail: string,
  path: string | null = null,
): ToolchainEsbuildStatus {
  return { state, path, version: pinned?.version ?? null, detail };
}

/** Why the installed esbuild at `path` can't run (`null`: it verifies against stamp and pin). */
async function installedEsbuildProblem(
  path: string,
  rec: StampedFile & { version: string },
  pinned: DenoToolchainEsbuild,
  verify: boolean,
): Promise<string | null> {
  if (rec.version !== pinned.version || rec.version !== ESBUILD_VERSION) {
    return `it is esbuild ${rec.version}, and denext speaks ${ESBUILD_VERSION}`;
  }
  if (rec.sha256 !== pinned.sha256) return "its stamp does not match the pin";
  const verdict = await fileVerdict(path, await Deno.lstat(path).catch(() => null), rec, true);
  const changed = verdict === "bad" ||
    (verify && verdict === "ok" && await sha256File(path) !== pinned.sha256);
  return changed ? "it changed since it was installed" : null;
}

// ---------------------------------------------------------------------------------------------
// The toolchain's native TypeScript compiler (what its `deno check` & co. run by default).

/** The toolchain's native TypeScript compiler on this machine. */
export interface ToolchainTsgoStatus {
  /**
   * `ok` = installed and verified (the toolchain type-checks with it); `missing` = the toolchain
   * is not cached; `refused` = it failed verification (type checking falls back to the in-process
   * TypeScript, see src/ts/engine.ts); `none` = this pin's toolchain ships none (it
   * type-checks in-process); `n/a` = `DENEXT_DENO=stock` or a path.
   */
  readonly state: "ok" | "missing" | "refused" | "none" | "n/a";
  /** The compiler (`ok` only). */
  readonly path: string | null;
  /** The TypeScript version the pin names (`null`: none). */
  readonly version: string | null;
  /** One line for a report. */
  readonly detail: string;
}

/**
 * Whether denext's Deno toolchain has a verified native TypeScript compiler for this host. Never
 * downloads. With `verify`, the whole `typescript-check/` directory is re-hashed against the pin.
 *
 * @param options Seams; all default to the process.
 * @returns The state, and the compiler when it is `ok`.
 */
export function toolchainTsgo(
  options: DenoToolchainStatusOptions = {},
): Promise<ToolchainTsgoStatus> {
  return toolchainTsRole(options, TS_CHECK, {
    na: "that Deno's own type checker runs",
    none: "this toolchain type-checks with its in-process TypeScript",
    ok: (v) => `TypeScript ${v} (native, verified)`,
  });
}

/**
 * Whether denext's Deno toolchain has a verified TypeScript 7 language server (`typescript-lsp/`,
 * what `deno lsp` runs for `"deno.unstable": ["tsgo-lsp"]`) for this host. Never downloads. With
 * `verify`, the whole directory is re-hashed against the pin. Unlike the checker, a refused or
 * unpinned one costs nothing but a download: `deno lsp` then fetches its own pinned build and
 * verifies it against the npm integrity compiled into the runtime.
 *
 * @param options Seams; all default to the process.
 * @returns The state, and the server binary when it is `ok`.
 */
export function toolchainTsgoLsp(
  options: DenoToolchainStatusOptions = {},
): Promise<ToolchainTsgoStatus> {
  return toolchainTsRole(options, TS_LSP, {
    na: "that Deno's own language server runs",
    none: "this toolchain pins no TypeScript language server (`deno lsp` fetches its own)",
    ok: (v) => `TypeScript ${v} language server (native, verified)`,
  });
}

/** {@linkcode toolchainTsgo} / {@linkcode toolchainTsgoLsp} for `role`, with its report texts. */
async function toolchainTsRole(
  options: DenoToolchainStatusOptions,
  role: TsRole,
  text: { na: string; none: string; ok: (version: string) => string },
): Promise<ToolchainTsgoStatus> {
  const q = await stepQuery(options);
  if ("mode" in q) return tsgoState("n/a", null, `${TOOLCHAIN_ENV}=${q.mode}: ${text.na}`);
  const { pin, target, artifact, dir, stamp } = q;
  const pinned = artifact?.[role.key];
  if (!pinned) return tsgoState("none", null, text.none);
  if (!stampMatches(stamp, pin.version!, target, artifact!)) {
    return tsgoState("missing", pinned, `TypeScript ${pinned.version} arrives with the toolchain`);
  }
  const rec = stamp[role.key]!;
  if ("refused" in rec) return tsgoState("refused", pinned, rec.refused);
  const path = join(dir, role.dir, tsgoExeName(options.os ?? Deno.build.os));
  const why = await installedTsgoProblem(path, rec, pinned, options.verify === true);
  return why === null ? tsgoState("ok", pinned, text.ok(pinned.version), path) : tsgoState(
    "refused",
    pinned,
    `the ${role.what} in denext's Deno toolchain (${path}) was refused: ${why}`,
  );
}

/** A {@linkcode ToolchainTsgoStatus}. */
function tsgoState(
  state: ToolchainTsgoStatus["state"],
  pinned: DenoToolchainTsgo | null,
  detail: string,
  path: string | null = null,
): ToolchainTsgoStatus {
  return { state, path, version: pinned?.version ?? null, detail };
}

/** Why the installed compiler at `path` can't run (`null`: it verifies against stamp and pin). */
async function installedTsgoProblem(
  path: string,
  rec: StampedFile & { version: string; treeSha256: string },
  pinned: DenoToolchainTsgo,
  verify: boolean,
): Promise<string | null> {
  if (rec.version !== pinned.version) {
    return `it is TypeScript ${rec.version}, pinned ${pinned.version}`;
  }
  if (rec.sha256 !== pinned.sha256 || rec.treeSha256 !== pinned.treeSha256) {
    return "its stamp does not match the pin";
  }
  const verdict = await fileVerdict(path, await Deno.lstat(path).catch(() => null), rec, true);
  if (verdict === "bad") return "it changed since it was installed";
  if (verify && await tsgoTreeSha256(join(path, "..")) !== pinned.treeSha256) {
    return "its files changed since they were installed";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// `denext toolchain link | unlink`: an opt-in `deno` on PATH.

/** Options for {@linkcode linkDenoToolchain} / {@linkcode unlinkDenoToolchain}. */
export interface DenoToolchainLinkOptions {
  readonly env?: EnvGet;
  /** The host OS (default `Deno.build.os`): Windows gets a `.cmd` shim, others a symlink. */
  readonly os?: string;
  /** The toolchain cache root (what a link of ours points into). */
  readonly cacheRoot?: string;
}

/**
 * Where the link goes: the `bin/` of the install directory, `$DENEXT_INSTALL` (as the installers
 * read it) or `~/.denext` — so a custom-prefix install's `deno` lands beside its `denext`, in the
 * directory the installer put on PATH.
 */
function denoToolchainLinkDir(env: EnvGet = processEnv): string {
  const install = env("DENEXT_INSTALL");
  if (install) return join(install, "bin");
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) throw new Error("denext: neither HOME nor USERPROFILE is set");
  return join(home, ".denext", "bin");
}

/** The link's path for `os`. */
function linkPath(env: EnvGet, os: string): string {
  return join(denoToolchainLinkDir(env), os === "windows" ? "deno.cmd" : "deno");
}

/**
 * Whether `path` is `dir` or below it, compared up to a separator: `…/denext-deno-other/x` is
 * not inside `…/denext-deno`.
 */
function isUnder(dir: string, path: string): boolean {
  const base = dir.replace(/[\\/]+$/, "");
  if (path === base) return true;
  return path.startsWith(base) && (path[base.length] === "/" || path[base.length] === "\\");
}

/** Whether the file at `path` is a link this module created. */
async function isOurLink(path: string, os: string, cacheRoot: string): Promise<boolean> {
  if (os === "windows") {
    const text = await Deno.readTextFile(path).catch(() => null);
    return text !== null && text.includes(SHIM_MARK);
  }
  const target = await Deno.readLink(path).catch(() => null);
  return target !== null && isUnder(cacheRoot, target);
}

/**
 * The `.cmd` shim's line for `deno`: cmd expands `%…%` even inside quotes, so each `%` in the path
 * is doubled (a batch file reads `%%` as one `%`).
 */
function shimLine(deno: string): string {
  return `"${deno.replaceAll("%", "%%")}" %*`;
}

/** The PATH line the user adds once. */
function pathLine(dir: string, os: string): string {
  return os === "windows"
    ? `setx PATH "${dir};%PATH%"`
    : `export PATH="${dir}:$PATH"   # add to your shell profile`;
}

/**
 * Point `~/.denext/bin/deno` (Windows: `deno.cmd`; `$DENEXT_INSTALL/bin` when that is set) at
 * the toolchain binary `deno`. Replaces only a link it made itself; anything else at that path is
 * refused.
 *
 * @param deno The toolchain binary.
 * @param options Seams.
 * @returns The link and the PATH line to add.
 */
export async function linkDenoToolchain(
  deno: string,
  options: DenoToolchainLinkOptions = {},
): Promise<{ link: string; pathLine: string }> {
  const env = options.env ?? processEnv;
  const os = options.os ?? Deno.build.os;
  const root = options.cacheRoot ?? denoToolchainCacheRoot(env);
  const link = linkPath(env, os);
  const existing = await Deno.lstat(link).catch(() => null);
  if (existing && !await isOurLink(link, os, root)) {
    throw new Error(
      `denext: ${link} exists and was not created by \`denext toolchain link\`; ` +
        "remove it yourself first.",
    );
  }
  await Deno.mkdir(denoToolchainLinkDir(env), { recursive: true });
  if (existing) await Deno.remove(link);
  if (os === "windows") {
    await Deno.writeTextFile(link, `@echo off\r\n${SHIM_MARK}\r\n${shimLine(deno)}\r\n`);
  } else {
    await Deno.symlink(deno, link);
  }
  return { link, pathLine: pathLine(denoToolchainLinkDir(env), os) };
}

/** The binary a link {@linkcode linkDenoToolchain} made points at (`null`: none of ours). */
async function linkedBinary(link: string, os: string, cacheRoot: string): Promise<string | null> {
  if (!(await Deno.lstat(link).catch(() => null)) || !await isOurLink(link, os, cacheRoot)) {
    return null;
  }
  if (os !== "windows") return await Deno.readLink(link);
  const text = await Deno.readTextFile(link);
  return /^"([^"]+)" %\*/m.exec(text)?.[1]?.replaceAll("%%", "%") ?? null;
}

/**
 * Why the `deno` {@linkcode linkDenoToolchain} put on PATH is stale — it points at a toolchain
 * other than the pinned one (an older `-denext.N` after a denext upgrade) — or `null` when there
 * is no such link or it is current.
 *
 * @param options Seams, plus the pin (default: the one in force).
 * @returns The warning, or `null`.
 */
export async function staleToolchainLink(
  options: DenoToolchainLinkOptions & { readonly pin?: DenoToolchainPin } = {},
): Promise<string | null> {
  const env = options.env ?? processEnv;
  const os = options.os ?? Deno.build.os;
  const root = options.cacheRoot ?? denoToolchainCacheRoot(env);
  const pin = options.pin ?? loadDenoToolchainPin(env);
  const link = linkPath(env, os);
  const target = await linkedBinary(link, os, root);
  if (target === null || pin.version === null) return null;
  if (isUnder(join(root, pin.version), target)) return null;
  return `denext: ${link} points at ${target}, not the pinned toolchain ${pin.version}; ` +
    "run `denext toolchain link` again (or `denext toolchain unlink`).";
}

/**
 * Remove what {@linkcode linkDenoToolchain} created — and nothing else.
 *
 * @param options Seams.
 * @returns The removed link, or `null` when there was none.
 */
export async function unlinkDenoToolchain(
  options: DenoToolchainLinkOptions = {},
): Promise<string | null> {
  const env = options.env ?? processEnv;
  const os = options.os ?? Deno.build.os;
  const link = linkPath(env, os);
  if (!(await Deno.lstat(link).catch(() => null))) return null;
  if (!await isOurLink(link, os, options.cacheRoot ?? denoToolchainCacheRoot(env))) {
    throw new Error(`denext: ${link} was not created by \`denext toolchain link\`; left alone.`);
  }
  await Deno.remove(link);
  return link;
}
