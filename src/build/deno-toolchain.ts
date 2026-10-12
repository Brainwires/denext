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
//      lock, so two first runs download once and the second adopts the first's binary.
//
// `DENEXT_DENO=stock` opts out; `DENEXT_DENO=<path>` uses that binary unverified (a warning).
// `DENEXT_TOOLCHAIN_PIN_FILE=<json>` replaces the built-in pin (tests and fork development).

import { join } from "@std/path";
import { acquireCacheLock } from "./project-locks.ts";
import { denoCacheDir, renameRetrying } from "./desktop-runtime.ts";
import { extractArchive } from "./safe-extract.ts";
import { readJsonFile, sha256File, streamHashed, sweepLeftovers } from "./verified-download.ts";
import pinJson from "./deno-toolchain-pin.json" with { type: "json" };

/** One pinned toolchain download for a host target. */
export interface DenoToolchainArtifact {
  /** The release asset's file name. */
  readonly file: string;
  readonly url: string;
  /** Lowercase hex SHA-256 of the downloaded file. */
  readonly sha256: string;
  /** Its exact size in bytes (enforced while streaming when given). */
  readonly size?: number;
  /** `zip` (a release archive holding `deno[.exe]`, the default) or a bare `binary`. */
  readonly format?: "zip" | "binary";
}

/** The pinned toolchain release (`deno-toolchain-pin.json`). */
export interface DenoToolchainPin {
  readonly schema: 1;
  /**
   * The toolchain version (`2.9.7-denext.15`), or `null` while no CLI archives are pinned for
   * this denext version — the toolchain then reports itself not available and stock Deno runs.
   */
  readonly version: string | null;
  readonly repository?: string;
  /** The Deno release the fork is built from. */
  readonly deno?: string;
  /** Per host target (`darwin-aarch64`, `linux-x86_64`, `windows-x86_64`, …). */
  readonly targets: Readonly<Record<string, DenoToolchainArtifact>>;
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
const OPT_OUT = `Set ${TOOLCHAIN_ENV}=stock to stay on stock Deno.`;
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
 * Whether a `Deno.version.deno` is denext's toolchain (`2.9.7-denext.15`).
 *
 * @param version The version string.
 * @returns Whether it carries the fork's suffix.
 */
export function isToolchainDenoVersion(version: string): boolean {
  return /-denext\.\d+/.test(version);
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

/** The cached binary's directory for (version, target). */
function binaryDir(root: string, version: string, target: string): string {
  return join(root, version, target);
}

/** The pinned artifact for `target`, or why there is none. */
function pinnedArtifact(pin: DenoToolchainPin, target: string): DenoToolchainArtifact {
  if (pin.version === null) {
    throw new DenoToolchainUnavailableError(
      "denext: denext's Deno toolchain is not available for this denext version " +
        "(no CLI archives are pinned yet); stock Deno is used.",
    );
  }
  const artifact = pin.targets[target];
  if (artifact) return artifact;
  throw new DenoToolchainUnavailableError(
    `denext: denext's Deno toolchain ${pin.version} has no build for ${target} (it has: ` +
      `${Object.keys(pin.targets).join(", ") || "none"}).`,
  );
}

/** The stamp's contents. */
interface ToolchainStamp {
  schema: 1;
  version: string;
  target: string;
  archive: { file: string; sha256: string };
  binary: { size: number; sha256: string; mtimeMs: number | null };
}

function readStamp(dir: string): Promise<ToolchainStamp | null> {
  return readJsonFile<ToolchainStamp>(join(dir, TOOLCHAIN_STAMP));
}

/** Whether the stamp records a binary from exactly this pin's artifact. */
function stampArchiveIs(s: ToolchainStamp, a: DenoToolchainArtifact): boolean {
  return s.archive?.file === a.file && s.archive.sha256 === a.sha256 &&
    typeof s.binary?.sha256 === "string" && typeof s.binary.size === "number";
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
  if (!info?.isFile || info.size !== stamp.binary.size) return "bad";
  const mtime = info.mtime?.getTime() ?? null;
  if (mtime !== null && mtime === stamp.binary.mtimeMs) return "ok";
  if (!rehash) return "bad";
  return await sha256File(path) === stamp.binary.sha256 ? "rehashed" : "bad";
}

/** GET `artifact`, mapping a network failure / HTTP error to a download error. */
async function openDownload(
  artifact: DenoToolchainArtifact,
  fetchImpl: typeof fetch,
): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetchImpl(artifact.url, { redirect: "follow" });
  } catch (err) {
    throw new DenoToolchainDownloadError(
      `denext: could not download denext's Deno toolchain (${artifact.file}) from ` +
        `${artifact.url}: ${err instanceof Error ? err.message : err}. Are you offline?`,
    );
  }
  if (res.ok && res.body) return res.body;
  await res.body?.cancel();
  throw new DenoToolchainDownloadError(
    `denext: downloading denext's Deno toolchain failed: GET ${artifact.url} → ` +
      `${res.status} ${res.statusText}`,
  );
}

/** Stream the download into the new file `dest`; its size and SHA-256. */
async function download(
  artifact: DenoToolchainArtifact,
  dest: string,
  fetchImpl: typeof fetch,
): Promise<{ size: number; sha256: string }> {
  const body = await openDownload(artifact, fetchImpl);
  const cap = artifact.size ?? MAX_DOWNLOAD;
  return await streamHashed(body, dest, cap, {
    tooLarge: () =>
      new DenoToolchainDownloadError(
        `denext: refusing denext's Deno toolchain ${artifact.file}: larger than its pinned ` +
          `${cap} bytes`,
      ),
    interrupted: (size, err) =>
      new DenoToolchainDownloadError(
        `denext: the Deno toolchain download was interrupted (${artifact.file}, ${size} bytes): ` +
          `${err instanceof Error ? err.message : err}`,
      ),
  });
}

/** Check a finished download against the pin; throws (the caller deletes the file). */
function checkDownload(artifact: DenoToolchainArtifact, got: { size: number; sha256: string }) {
  if (artifact.size !== undefined && got.size !== artifact.size) {
    throw new DenoToolchainDownloadError(
      `denext: refusing denext's Deno toolchain ${artifact.file}: got ${got.size} bytes, pinned ` +
        `${artifact.size} (truncated download)`,
    );
  }
  if (got.sha256 !== artifact.sha256) {
    throw new DenoToolchainHashError(
      `denext: REFUSING denext's Deno toolchain ${artifact.file}: SHA-256 mismatch.\n` +
        `  pinned ${artifact.sha256}\n  got    ${got.sha256}\n` +
        "  The file was deleted unexecuted. Retry; if it persists, the download is being " +
        "tampered with.",
    );
  }
}

/** The verified binary out of a verified download: a zip's `deno[.exe]`, or the file itself. */
async function binaryFrom(
  artifact: DenoToolchainArtifact,
  downloaded: string,
  scratch: string,
  exe: string,
): Promise<string> {
  if ((artifact.format ?? "zip") === "binary") return downloaded;
  const out = join(scratch, "x");
  const result = await extractArchive(downloaded, "zip", out);
  if (!result.files[exe]) {
    throw new Error(`denext: the toolchain archive ${artifact.file} has no top-level ${exe}`);
  }
  return join(out, exe);
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

/** The stamp for the binary at `path`, as installed. */
async function stampFor(
  path: string,
  version: string,
  target: string,
  artifact: DenoToolchainArtifact,
): Promise<ToolchainStamp> {
  const info = await Deno.stat(path);
  return {
    schema: 1,
    version,
    target,
    archive: { file: artifact.file, sha256: artifact.sha256 },
    binary: {
      size: info.size,
      sha256: await sha256File(path),
      mtimeMs: info.mtime?.getTime() ?? null,
    },
  };
}

/** Download, verify and atomically install the binary into `dir` (the write lock is held). */
async function install(
  dir: string,
  exe: string,
  version: string,
  target: string,
  artifact: DenoToolchainArtifact,
  opts: EnsureDenoToolchainOptions,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await sweepLeftovers(dir);
  const scratch = await Deno.makeTempDir({ dir, prefix: ".tmp-" });
  try {
    const downloaded = join(scratch, artifact.file.replace(/[\\/]/g, "_"));
    const mb = artifact.size ? ` (${(artifact.size / 1024 / 1024).toFixed(1)} MB)` : "";
    (opts.log ?? ((l: string) => console.error(l)))(
      `  denext: downloading denext's Deno toolchain ${version} for ${target}${mb}…`,
    );
    try {
      checkDownload(artifact, await download(artifact, downloaded, opts.fetch ?? fetch));
    } catch (err) {
      await Deno.remove(downloaded).catch(() => {});
      throw err;
    }
    const binary = await binaryFrom(artifact, downloaded, scratch, exe);
    if ((opts.os ?? Deno.build.os) !== "windows") await Deno.chmod(binary, 0o755);
    // A stale stamp goes first: a crash between here and the new stamp leaves NO stamp, which
    // the next run treats as missing (a fresh download), never as a verified binary.
    await Deno.remove(join(dir, TOOLCHAIN_STAMP)).catch(() => {});
    await renameRetrying(binary, join(dir, exe));
    await writeStamp(dir, await stampFor(join(dir, exe), version, target, artifact));
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
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
  const exe = exeName(options.os ?? Deno.build.os);
  const resolved = (cached: boolean) => ({ deno: join(dir, exe), version, target, cached });
  await Deno.mkdir(root, { recursive: true });
  {
    using _shared = await acquireCacheLock(root, "shared", CACHE_DESCR);
    if (await cacheVerdict(dir, exe, version, target, artifact, false) === "ok") {
      return resolved(true);
    }
  }
  const present = await cacheVerdict(dir, exe, version, target, artifact, false) !== "missing";
  using _write = await acquireCacheLock(root, present ? "mutate" : "download", CACHE_DESCR);
  // Re-check once granted: the process this one waited on may have installed it.
  const verdict = await cacheVerdict(dir, exe, version, target, artifact, true);
  if (verdict === "ok") return resolved(true);
  if (verdict === "rehashed") {
    await writeStamp(dir, await stampFor(join(dir, exe), version, target, artifact));
    return resolved(true);
  }
  if (verdict === "bad") {
    (options.log ?? ((l: string) => console.error(l)))(
      `  denext: the cached Deno toolchain at ${dir} failed verification; re-downloading.`,
    );
  }
  await install(dir, exe, version, target, artifact, options);
  if (await cacheVerdict(dir, exe, version, target, artifact, false) !== "ok") {
    throw new Error(`denext: the Deno toolchain at ${dir} did not verify after install`);
  }
  return resolved(false);
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
  }
  | {
    readonly kind: "stock";
    /** Why stock Deno runs. */
    readonly reason: string;
    /** Say this once (a failure or a missing grant), or nothing (an opt-out, no pin yet). */
    readonly warning?: string;
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

/** The `DENEXT_DENO` mode: `pinned`, `stock`, or a path. */
function toolchainMode(env: EnvGet): { mode: "pinned" | "stock" } | { mode: "path"; path: string } {
  const raw = (env(TOOLCHAIN_ENV) ?? "").trim();
  if (raw === "" || raw.toLowerCase() === "pinned") return { mode: "pinned" };
  if (raw.toLowerCase() === "stock") return { mode: "stock" };
  return { mode: "path", path: raw };
}

/** `DENEXT_DENO=<path>`: that binary, unverified, when it exists. */
async function pathChoice(path: string): Promise<DenoToolchainChoice> {
  if (!(await Deno.stat(path).catch(() => null))?.isFile) {
    return {
      kind: "stock",
      reason: `${TOOLCHAIN_ENV}=${path} does not exist`,
      warning: `denext: ${TOOLCHAIN_ENV}=${path} is not a file; running on stock Deno.`,
    };
  }
  return {
    kind: "toolchain",
    deno: path,
    version: "path",
    warning: `denext: using the Deno at ${path} (${TOOLCHAIN_ENV}); it is not downloaded, ` +
      "pinned or verified.",
  };
}

/**
 * Pick the Deno the current command should run on — denext's toolchain (downloaded and verified
 * on first use), a `DENEXT_DENO=<path>` binary, or stock Deno — and never fail: every reason to
 * stay on stock Deno comes back as a `stock` choice, with a warning to print unless it is an
 * opt-out or the toolchain simply isn't pinned for this denext version yet.
 *
 * @param options Seams; all default to the process.
 * @returns The choice.
 */
export async function resolveDenoToolchain(
  options: ResolveDenoToolchainOptions = {},
): Promise<DenoToolchainChoice> {
  const env = options.env ?? processEnv;
  const mode = toolchainMode(env);
  if (mode.mode === "stock") return { kind: "stock", reason: `${TOOLCHAIN_ENV}=stock` };
  if (mode.mode === "path") return await pathChoice(mode.path);
  let pin: DenoToolchainPin;
  try {
    pin = options.pin ?? loadDenoToolchainPin(env);
  } catch (err) {
    const text = errText(err);
    return stockChoice(text, `${text}\n  Running on stock Deno.`);
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
    return stockChoice(
      `no build for ${target}`,
      `denext: denext's Deno toolchain ${pin.version} has no build for ${target}; running on ` +
        `stock Deno ${Deno.version.deno}. ${OPT_OUT}`,
    );
  }
  const missing = await missingGrants(cacheRoot);
  if (missing.length === 0) return null;
  return stockChoice(
    `this process lacks ${missing.join(" ")}`,
    `denext: not switching to denext's Deno toolchain ${pin.version}: this process lacks ` +
      `${missing.join(" ")} (for ${cacheRoot}); running on stock Deno ${Deno.version.deno}. ` +
      `Grant them, or ${OPT_OUT.replace(/^Set/, "set")}`,
  );
}

/** The pinned toolchain (installed and verified), or why stock Deno runs instead. */
async function pinnedChoice(
  pin: DenoToolchainPin,
  env: EnvGet,
  options: ResolveDenoToolchainOptions,
): Promise<DenoToolchainChoice> {
  const target = options.target ?? denoToolchainTarget();
  const cacheRoot = options.cacheRoot ?? denoToolchainCacheRoot(env);
  const obstacle = await pinnedObstacle(
    pin,
    target,
    cacheRoot,
    options.missingGrants ?? queryMissingGrants,
  );
  if (obstacle) return obstacle;
  try {
    const rt = await ensureDenoToolchain({ ...options, pin, target, cacheRoot });
    return { kind: "toolchain", deno: rt.deno, version: rt.version };
  } catch (err) {
    const text = errText(err);
    const loud = err instanceof DenoToolchainHashError ? "\n  ⚠ " : "\n  ";
    return stockChoice(
      text,
      `${text}${loud}Running on stock Deno ${Deno.version.deno}. ${OPT_OUT}`,
    );
  }
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
  /** This process's Deno version (default `Deno.version.deno`). */
  readonly running?: string;
}

const STATE_TEXT: Record<DenoToolchainStatus["state"], string> = {
  cached: "cached + verified",
  missing: "not cached yet (downloaded on the first command that runs project code)",
  invalid: "cache FAILED verification (re-downloaded on next use)",
  unpinned: "not available for this denext version (stock Deno runs)",
  unsupported: "no build for this host (stock Deno runs)",
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
  const path = join(dir, exe);
  const verdict = await cacheVerdict(dir, exe, pin.version, target, artifact, true);
  if (verdict === "missing") return { state: "missing", path };
  if (verdict === "bad") return { state: "invalid", path };
  if (verify && await sha256File(path) !== (await readStamp(dir))?.binary.sha256) {
    return { state: "invalid", path };
  }
  return { state: "cached", path };
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
  const running = options.running ?? Deno.version.deno;
  const target = options.target ?? denoToolchainTarget();
  const active = !!env(TOOLCHAIN_ACTIVE_ENV) || isToolchainDenoVersion(running);
  const runningText = active ? `running on it (deno ${running})` : `running on deno ${running}`;
  const mode = toolchainMode(env);
  const pin = options.pin ?? loadDenoToolchainPin(env);
  const base = { version: pin.version, target, active, running, state: "n/a" as const };
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
      `${STATE_TEXT[state]}; ${runningText}`,
  };
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

/** Where the link goes: `~/.denext/bin`. */
function denoToolchainLinkDir(env: EnvGet = processEnv): string {
  const home = env("HOME") ?? env("USERPROFILE");
  if (!home) throw new Error("denext: neither HOME nor USERPROFILE is set");
  return join(home, ".denext", "bin");
}

/** The link's path for `os`. */
function linkPath(env: EnvGet, os: string): string {
  return join(denoToolchainLinkDir(env), os === "windows" ? "deno.cmd" : "deno");
}

/** Whether the file at `path` is a link this module created. */
async function isOurLink(path: string, os: string, cacheRoot: string): Promise<boolean> {
  if (os === "windows") {
    const text = await Deno.readTextFile(path).catch(() => null);
    return text !== null && text.includes(SHIM_MARK);
  }
  const target = await Deno.readLink(path).catch(() => null);
  return target !== null && target.startsWith(cacheRoot);
}

/** The PATH line the user adds once. */
function pathLine(dir: string, os: string): string {
  return os === "windows"
    ? `setx PATH "${dir};%PATH%"`
    : `export PATH="${dir}:$PATH"   # add to your shell profile`;
}

/**
 * Point `~/.denext/bin/deno` (Windows: `deno.cmd`) at the toolchain binary `deno`. Replaces only
 * a link it made itself; anything else at that path is refused.
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
    await Deno.writeTextFile(link, `@echo off\r\n${SHIM_MARK}\r\n"${deno}" %*\r\n`);
  } else {
    await Deno.symlink(deno, link);
  }
  return { link, pathLine: pathLine(denoToolchainLinkDir(env), os) };
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
