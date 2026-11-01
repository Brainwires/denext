// denext's pinned Deno Desktop runtime: the prebuilt `libdenort` + laufey backend hosts from the
// Brainwires/deno fork's releases (custom app origin, per-app storage, deep links, single
// instance), handed to the user's STOCK `deno desktop` CLI through two env vars it already reads:
//
//   DENORT_DESKTOP_BIN=<cache>/<runtime lib>   (libdenort.dylib | libdenort.so | denort.dll)
//   LAUFEY_DEV_DIR=<cache>/laufey
//
// The archive for (target, backend) is pinned in `desktop-runtime-pin.json` (url, size, SHA-256;
// regenerate with `deno task desktop:pin-runtime <tag>`). {@linkcode ensureDesktopRuntime}:
//
//   1. reuses `<DENO_DIR>/denext-desktop-runtime/<version>/<target>-<backend>/` when its marker
//      matches the pin and every recorded file is present at its recorded size (no network);
//      `verify` re-hashes every file instead, and so does the first use after
//      {@linkcode REHASH_INTERVAL_MS} since the last full check (`.denext-verified-at`), so a
//      same-size change by another local process is caught within a week even without it;
//   2. else streams the archive into a private temp dir under the version dir, refusing it the
//      moment it exceeds the pinned size, then checks size AND SHA-256 before anything else
//      touches it; nothing is extracted from an unverified archive;
//   3. extracts with `safe-extract.ts` (no traversal, no escaping links, no special files),
//      writes the marker (each file's size + SHA-256), and renames the whole tree into place
//      atomically. Two packagers racing each extract privately; the loser of the rename adopts
//      the winner's verified tree. A crashed run leaves only a temp dir, cleaned up a day later.
//
// The `deno` that runs `deno desktop` must be the runtime's exact Deno version (the CLI embeds a
// matching libdenort ABI). `DENEXT_DESKTOP_RUNTIME=stock` opts out on a stock Deno CLI only (denext's
// Deno refuses to build on an upstream runtime; the stock runtime: no custom
// origin, deep links or single instance); `DENEXT_DESKTOP_RUNTIME_DIR=<dir>` uses a local runtime
// build unverified (runtime development).

import { denoCacheDir } from "./deno-cache-dir.ts";
import { acquireCacheLock } from "./project-locks.ts";
import { lockTask } from "./file-lock.ts";
import { basename, dirname, fromFileUrl, join } from "@std/path";
import { extractArchive, type ExtractedFile } from "./safe-extract.ts";
import {
  assertTrustedCacheDirs,
  cacheDirChain,
  DownloadIdleError,
  downloadProgress,
  fetchWithConnectDeadline,
  readJsonFile,
  responseBody,
  sha256File,
  streamHashed,
  sweepLeftovers,
  withDownloadRetries,
} from "./verified-download.ts";
import { readJson } from "./json-edit.ts";
import { runToExit } from "./exited-output.ts";
import {
  currentDenoIdentity,
  type DenoIdentity,
  denoReleaseVersion,
  isDenextDenoVersion,
  needsNoLegacyAbortFlag,
  parseDenoVersionOutput,
} from "./deno-version.ts";
import { denoSupportsNetSplit, NET_SPLIT_RELEASE, supportsNetSplit } from "./net-permissions.ts";
import pinJson from "./desktop-runtime-pin.json" with { type: "json" };
import toolchainPinJson from "./deno-toolchain-pin.json" with { type: "json" };
import { assertLinuxLibc, type LinuxLibc, minGlibcFor } from "./linux-libc.ts";
import { warnStockDeprecation } from "./stock-deprecation.ts";
import {
  decideRevocation,
  findRevocation,
  type LoadRevocationsOptions,
  loadRuntimeRevocations,
  REVOCATION_NOTICED_ENV,
  revocationNotice,
  revokedShipRefusal,
  type RuntimeRevocation,
  type RuntimeRevocationList,
} from "./runtime-revocations.ts";

/** The toolchain marker a command sets on the processes it starts (deno-toolchain.ts). */
const TOOLCHAIN_ACTIVE_ENV = "DENEXT_TOOLCHAIN_ACTIVE";

/** A runtime backend (`deno desktop --backend`). */
export type DesktopRuntimeBackend = "webview" | "cef";

/** One pinned runtime archive. */
export interface DesktopRuntimeArtifact {
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly format: "tar.gz" | "zip";
}

/** The pinned runtime release (`desktop-runtime-pin.json`). */
export interface DesktopRuntimePin {
  readonly schema: 1;
  /** The runtime version, e.g. `2.9.7-denext.1`. */
  readonly version: string;
  readonly tag: string;
  readonly repository: string;
  /** The exact Deno version the runtime is built from (and the CLI must be). */
  readonly deno: string;
  readonly denoSha: string;
  readonly laufeySha: string;
  readonly laufeyApiVersion: number | null;
  readonly targets: Readonly<
    Record<
      string,
      & { readonly runtimeLib: string }
      & Partial<Record<DesktopRuntimeBackend, DesktopRuntimeArtifact>>
    >
  >;
  /**
   * The previous pin, used instead of this one when the signed revoked-runtimes list revokes this
   * one for the target (src/build/runtime-revocations.ts), always together with the Deno toolchain
   * pin's `rollback` of the same release. Never nests another `rollback`.
   */
  readonly rollback?: DesktopRuntimeRollback;
}

/** A desktop runtime pin's `rollback`: the previous pinned release, as the pin named it. */
export type DesktopRuntimeRollback = Omit<DesktopRuntimePin, "schema" | "rollback">;

/**
 * The pin's `rollback` as a pin of its own, or `null` when it names none.
 *
 * @param pin The pin.
 * @returns The previous release's pin.
 */
export function rollbackDesktopPin(pin: DesktopRuntimePin): DesktopRuntimePin | null {
  return pin.rollback ? { schema: 1, ...pin.rollback } : null;
}

/** The runtime denext pins (generated; see the header). */
export const DESKTOP_RUNTIME_PIN: DesktopRuntimePin = pinJson as DesktopRuntimePin;

/** `stock` → the stock runtime; unset / `pinned` → denext's. */
const RUNTIME_ENV = "DENEXT_DESKTOP_RUNTIME";
/** A local runtime build directory (runtime development), used unverified. */
const RUNTIME_DIR_ENV = "DENEXT_DESKTOP_RUNTIME_DIR";
/** `1` → re-hash every cached file before use. */
export const DESKTOP_RUNTIME_VERIFY_ENV = "DENEXT_DESKTOP_RUNTIME_VERIFY";
/**
 * `1` → `gh attestation verify` every freshly downloaded archive (a missing or signed-out `gh`
 * fails); `0` → never; unset → whenever `gh` is signed in ({@linkcode desktopRuntimeAttestMode}).
 */
export const DESKTOP_RUNTIME_ATTEST_ENV = "DENEXT_DESKTOP_RUNTIME_ATTEST";

/**
 * Whether a fresh runtime download is checked for its build provenance: `true` (required),
 * `false` (off), or `"auto"` — checked when the GitHub CLI is signed in, and said so when it is
 * not (the SHA-256 pin is enforced either way).
 */
export type DesktopRuntimeAttestMode = boolean | "auto";

/**
 * The provenance mode {@linkcode DESKTOP_RUNTIME_ATTEST_ENV} selects: `1` / `true` required,
 * `0` / `false` off, anything else (unset included) `"auto"`.
 *
 * @param value The variable's value.
 * @returns The mode.
 */
export function desktopRuntimeAttestMode(value: string | undefined): DesktopRuntimeAttestMode {
  const v = value?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return "auto";
}

/** The marker a verified cache entry carries (at its root, beside the runtime lib). */
export const RUNTIME_MARKER = ".denext-runtime.json";

/** When a cached runtime last re-hashed clean (epoch ms), beside its marker. */
export const RUNTIME_VERIFIED_AT = ".denext-verified-at";

/** How long a cached runtime is trusted on its file sizes alone before it is re-hashed. */
const REHASH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the cached runtime at `dir` is due a full re-hash: it has never had one recorded, the
 * record is unreadable, or the last one is {@linkcode REHASH_INTERVAL_MS} old (or from the future).
 *
 * @param dir The cache directory.
 * @param now The clock (test seam).
 * @returns Whether to re-hash every file this time.
 */
export async function runtimeRehashDue(dir: string, now: number = Date.now()): Promise<boolean> {
  const text = await Deno.readTextFile(join(dir, RUNTIME_VERIFIED_AT)).catch(() => null);
  const at = text === null ? NaN : Number(text.trim());
  return !Number.isFinite(at) || at > now || now - at >= REHASH_INTERVAL_MS;
}

/** Record a clean full re-hash of `dir` (best effort: a failure only means re-hashing sooner). */
async function recordRehash(dir: string, now: number = Date.now()): Promise<void> {
  const tmp = join(dir, `${RUNTIME_VERIFIED_AT}.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, `${now}\n`);
    await Deno.rename(tmp, join(dir, RUNTIME_VERIFIED_AT));
  } catch {
    await Deno.remove(tmp).catch(() => {});
  }
}

/** What the stock runtime lacks (named in every opt-out message). */
const STOCK_LACKS = "no stable app origin or persistent browser storage, deep links, " +
  "single instance, preload, full-app updates, native clipboard / notifications / context " +
  "menu, or window controls beyond size, position and title";

/**
 * The stock opt-out as a fallback message offers it: it needs a stock Deno CLI, since an upstream
 * runtime can't read what denext's Deno compiles ({@linkcode stockRuntimeOnDenextDenoMessage}).
 */
const STOCK_WAY_OUT = `on a stock Deno CLI (DENEXT_DENO=stock), set ${RUNTIME_ENV}=stock to use ` +
  `the stock runtime (${STOCK_LACKS})`;

/** The way out of a runtime download that failed (every download error ends with it). */
const DOWNLOAD_HINT =
  `\n  Once it is cached, packaging needs no network. Or set ${RUNTIME_DIR_ENV}=<an unpacked ` +
  `runtime>, or, ${STOCK_WAY_OUT}.`;

/** The marker's contents. */
interface RuntimeMarker {
  schema: 1;
  version: string;
  target: string;
  backend: DesktopRuntimeBackend;
  archive: { file: string; sha256: string; size: number };
  attested: boolean;
  files: Record<string, ExtractedFile>;
  symlinks: Record<string, string>;
}

/** A cached, verified runtime ready for `deno desktop`. */
export interface ResolvedDesktopRuntime {
  /** The cache directory of this (target, backend). */
  readonly dir: string;
  /** `DENORT_DESKTOP_BIN`. */
  readonly runtimeLib: string;
  /** `LAUFEY_DEV_DIR`. */
  readonly laufeyDir: string;
  /** Whether it was already cached (no download happened). */
  readonly cached: boolean;
}

/** Env reader. */
type EnvGet = (k: string) => string | undefined;
const processEnv: EnvGet = (k) => Deno.env.get(k);

/** The Rust target triple for an OS + arch (`Deno.build`). */
export function desktopRuntimeTarget(
  os: string = Deno.build.os,
  arch: string = Deno.build.arch,
): string {
  const vendor = { darwin: "apple-darwin", linux: "unknown-linux-gnu", windows: "pc-windows-msvc" }[
    os
  ];
  if (!vendor) throw new Error(`denext: no Deno Desktop runtime for ${os}/${arch}`);
  return `${arch}-${vendor}`;
}

export { denoCacheDir };

/** `<deno cache>/denext-desktop-runtime`. */
function cacheRootFor(env: EnvGet = processEnv): string {
  return join(denoCacheDir(env), "denext-desktop-runtime");
}

/** The cache directory for one (pin, target, backend). */
export function desktopRuntimeDir(
  root: string,
  pin: DesktopRuntimePin,
  target: string,
  backend: DesktopRuntimeBackend,
): string {
  return join(root, pin.version, `${target}-${backend}`);
}

/** Raised when the runtime can't be fetched (offline, HTTP error); the message says what to do. */
export class DesktopRuntimeDownloadError extends Error {
  override name = "DesktopRuntimeDownloadError";
}

/** The pinned archive for (target, backend), or a clear error. */
function pinnedArtifact(
  pin: DesktopRuntimePin,
  target: string,
  backend: DesktopRuntimeBackend,
): DesktopRuntimeArtifact {
  const a = pin.targets[target]?.[backend];
  if (a) return a;
  throw new Error(
    `denext: the pinned Deno Desktop runtime ${pin.version} has no ${backend} build for ` +
      `${target} (it has: ${Object.keys(pin.targets).join(", ")}).\n  Or, ${STOCK_WAY_OUT}.`,
  );
}

function readMarker(dir: string): Promise<RuntimeMarker | null> {
  return readJsonFile<RuntimeMarker>(join(dir, RUNTIME_MARKER));
}

/** Whether the marker names exactly this pin's archive and records at least one file. */
function markerMatches(m: RuntimeMarker | null, pin: DesktopRuntimePin, a: DesktopRuntimeArtifact) {
  return m !== null && m.schema === 1 && m.version === pin.version &&
    m.archive?.file === a.file && m.archive.sha256 === a.sha256 && m.archive.size === a.size &&
    typeof m.files === "object" && Object.keys(m.files).length > 0;
}

/** Whether every recorded file is present at its size (and, with `full`, its SHA-256). */
async function filesIntact(dir: string, m: RuntimeMarker, full: boolean): Promise<boolean> {
  for (const [rel, want] of Object.entries(m.files)) {
    const path = join(dir, ...rel.split("/"));
    const info = await Deno.lstat(path).catch(() => null);
    if (!info?.isFile || info.size !== want.size) return false;
    if (full && await sha256File(path) !== want.sha256) return false;
  }
  for (const [rel, target] of Object.entries(m.symlinks ?? {})) {
    if (await recordedLinkTarget(join(dir, ...rel.split("/"))) !== target) return false;
  }
  return true;
}

/**
 * The target of the symlink at `path` in the marker's `/`-separated form, or `null`. A Windows
 * link is created with the native separator (`createLink` in safe-extract), so `readLink` answers
 * `Versions\A\…` there for the archive's `Versions/A/…`.
 */
async function recordedLinkTarget(path: string): Promise<string | null> {
  const target = await Deno.readLink(path).catch(() => null);
  return target !== null && Deno.build.os === "windows" ? target.replaceAll("\\", "/") : target;
}

/**
 * Whether `dir` holds a verified copy of `artifact`: its marker names the same archive (file,
 * size, SHA-256) and every recorded file is present at its recorded size (or, with `full`, has its
 * recorded SHA-256), every recorded symlink is still a symlink to its recorded target.
 *
 * @param dir The cache directory.
 * @param pin The pin.
 * @param artifact The pinned archive.
 * @param full Re-hash every file.
 * @returns The marker when valid, else `null`.
 */
export async function verifiedRuntime(
  dir: string,
  pin: DesktopRuntimePin,
  artifact: DesktopRuntimeArtifact,
  full = false,
): Promise<RuntimeMarker | null> {
  const m = await readMarker(dir);
  if (!markerMatches(m, pin, artifact)) return null;
  return await filesIntact(dir, m!, full) ? m : null;
}

const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

/** GET the archive, mapping a network failure / HTTP error to a {@linkcode DesktopRuntimeDownloadError}. */
async function openDownload(
  artifact: DesktopRuntimeArtifact,
  fetchImpl: typeof fetch,
  connectMs: number,
): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    // No response headers within the connect deadline: given up on, never a hung build.
    res = await fetchWithConnectDeadline(fetchImpl, artifact.url, undefined, connectMs);
  } catch (err) {
    throw new DesktopRuntimeDownloadError(
      `denext: could not download the Deno Desktop runtime (${artifact.file}) from ` +
        `${artifact.url}: ${errText(err)}.\n  Are you offline?${DOWNLOAD_HINT}`,
      { cause: err },
    );
  }
  return await responseBody(res, artifact.url, (status) =>
    new DesktopRuntimeDownloadError(
      `denext: downloading the Deno Desktop runtime failed: ${status.message}${DOWNLOAD_HINT}`,
      { cause: status },
    ));
}

/**
 * Stream `body` into the new file `dest`, hashing it and refusing it as soon as it outgrows
 * `maxSize`. Returns the byte count and SHA-256.
 */
function streamToFile(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxSize: number,
  what: string,
  idleMs: number,
): Promise<{ size: number; sha256: string }> {
  // A progress line on a terminal (bytes and percent); nothing in a log or CI.
  const progress = downloadProgress(`Deno Desktop runtime ${what}`, maxSize);
  return streamHashed(
    body,
    dest,
    maxSize,
    {
      tooLarge: () =>
        new Error(
          `denext: refusing the Deno Desktop runtime ${what}: the download is larger than its ` +
            `pinned ${maxSize} bytes${DOWNLOAD_HINT}`,
        ),
      interrupted: (size, err) =>
        new DesktopRuntimeDownloadError(
          `denext: the Deno Desktop runtime download was interrupted (${what}, ${size} of ` +
            `${maxSize} bytes): ${errText(err)}${
              err instanceof DownloadIdleError
                ? " (DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS raises the deadline)"
                : ""
            }${DOWNLOAD_HINT}`,
          { cause: err },
        ),
    },
    (bytes) => progress.update(bytes),
    idleMs,
  ).finally(() => progress.done());
}

/**
 * Download `artifact` to `dest`, refusing anything but exactly its pinned size and SHA-256. A
 * stalled or broken connection is retried on a new one, the partial file deleted first.
 */
async function downloadVerified(
  artifact: DesktopRuntimeArtifact,
  dest: string,
  fetchImpl: typeof fetch,
  log?: (line: string) => void,
): Promise<void> {
  const got = await withDownloadRetries(
    `the Deno Desktop runtime ${artifact.file}`,
    async ({ fetch: fetchOnce, deadlines }) => {
      try {
        const body = await openDownload(artifact, fetchOnce, deadlines.connectMs);
        return await streamToFile(body, dest, artifact.size, artifact.file, deadlines.idleMs);
      } catch (err) {
        await Deno.remove(dest).catch(() => {});
        throw err;
      }
    },
    fetchImpl,
    (report) =>
      new DesktopRuntimeDownloadError(
        `denext: could not download the Deno Desktop runtime (${artifact.file}) from ` +
          `${artifact.url}${report}\n  Are you offline?${DOWNLOAD_HINT}`,
      ),
    { log },
  );
  if (got.size !== artifact.size) {
    throw new DesktopRuntimeDownloadError(
      `denext: refusing the Deno Desktop runtime ${artifact.file}: got ${got.size} bytes, pinned ` +
        `${artifact.size} (truncated download)${DOWNLOAD_HINT}`,
    );
  }
  if (got.sha256 !== artifact.sha256) {
    throw new Error(
      `denext: refusing the Deno Desktop runtime ${artifact.file}: SHA-256 mismatch.\n` +
        `  pinned ${artifact.sha256}\n  got    ${got.sha256}\n` +
        "  Nothing was extracted. Retry; if it persists, the download is being tampered with." +
        DOWNLOAD_HINT,
    );
  }
}

/** Run a program to completion with inherited output; resolves its exit code. */
export type RuntimeCommandRunner = (cmd: string, args: string[]) => Promise<number>;

const defaultRunner: RuntimeCommandRunner = async (cmd, args) =>
  (await new Deno.Command(cmd, { args, stdout: "inherit", stderr: "inherit" }).output()).code;

/**
 * The workflow (in the runtime's repository) that builds and attests every pinned runtime
 * release. An attestation from any other workflow — another workflow of the same repository, a
 * fork's — is not this runtime's provenance.
 */
const DESKTOP_RUNTIME_SIGNER_WORKFLOW = ".github/workflows/denext_runtime.yml";

/**
 * The `gh attestation verify` arguments for a runtime archive: the repository, AND the exact
 * workflow that must have signed it, AND the release tag it must have been built from — so only
 * the pinned release's own build passes, not any artifact some workflow of the repository attested.
 *
 * @param archive The archive path.
 * @param repository The pin's repository (`https://github.com/<owner>/<repo>` or `<owner>/<repo>`).
 * @param tag The pinned release tag.
 * @returns The argv after `gh`.
 */
export function runtimeAttestationArgs(archive: string, repository: string, tag: string): string[] {
  const repo = repository.replace(/^https:\/\/github\.com\//, "");
  return [
    "attestation",
    "verify",
    archive,
    "-R",
    repo,
    "--signer-workflow",
    `${repo}/${DESKTOP_RUNTIME_SIGNER_WORKFLOW}`,
    "--source-ref",
    `refs/tags/${tag}`,
    "--deny-self-hosted-runners",
  ];
}

/**
 * Whether the GitHub CLI is installed and signed in to github.com (`gh auth status`, output
 * captured): what an `"auto"` provenance check needs. A missing `gh` is `false`.
 *
 * @param run Runs `gh` (default: captured, quiet).
 * @returns Whether `gh attestation verify` can run.
 */
export async function ghSignedIn(run: CaptureRunner = capture): Promise<boolean> {
  try {
    return (await run("gh", ["auth", "status", "--hostname", "github.com"])).code === 0;
  } catch {
    return false;
  }
}

/**
 * Whether this fresh download is attested: always under `true`, never under `false`, and under
 * `"auto"` when `gh` is signed in — else one line says the provenance was not checked.
 */
async function shouldAttest(plan: InstallPlan): Promise<boolean> {
  const mode = plan.opts.attest ?? false;
  if (mode !== "auto") return mode;
  if (await ghSignedIn(plan.opts.capture ?? capture)) return true;
  plan.log(
    "  denext: the runtime's build provenance was not checked (the GitHub CLI is not installed or " +
      "not signed in; the SHA-256 pin was). `gh auth login` checks it on the next download; " +
      `${DESKTOP_RUNTIME_ATTEST_ENV}=0 silences this.`,
  );
  return false;
}

/** `gh attestation verify` the archive (the provenance check), pinned to the release's build. */
async function attest(
  archive: string,
  pin: { readonly repository: string; readonly tag: string },
  run: RuntimeCommandRunner,
): Promise<void> {
  let code: number;
  try {
    code = await run("gh", runtimeAttestationArgs(archive, pin.repository, pin.tag));
  } catch {
    throw new Error(
      `denext: ${DESKTOP_RUNTIME_ATTEST_ENV}=1 needs the GitHub CLI (gh) to verify the runtime's ` +
        "build provenance; install gh or drop the flag (the SHA-256 pin is still enforced).",
    );
  }
  if (code !== 0) {
    throw new Error(`denext: provenance check failed for ${archive} (gh attestation verify)`);
  }
}

/** Run a program to completion, capturing stdout + stderr as text. */
export type CaptureRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; text: string }>;

const capture: CaptureRunner = async (cmd, args) => {
  const out = await runToExit(cmd, { args });
  const d = new TextDecoder();
  return { code: out.code, text: d.decode(out.stdout) + d.decode(out.stderr) };
};

/** Mach-O / fat-binary magics (big-endian read of the first 4 bytes). */
const MACHO_MAGICS = new Set([
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
]);

/** Whether `path` starts with a Mach-O / fat magic. */
async function isMachO(path: string): Promise<boolean> {
  const f = await Deno.open(path, { read: true }).catch(() => null);
  if (!f) return false;
  try {
    const b = new Uint8Array(4);
    return await f.read(b) === 4 && MACHO_MAGICS.has(new DataView(b.buffer).getUint32(0, false));
  } finally {
    f.close();
  }
}

/** The laufey `.app` bundles in an extracted macOS runtime. */
const LAUFEY_APPS = [
  "laufey/webview/build/laufey_webview.app",
  "laufey/cef/build/Release/laufey.app",
];

/** Whether codesign reports `path` as carrying no signature at all. */
async function unsigned(path: string, run: CaptureRunner): Promise<boolean> {
  return (await run("codesign", ["-dv", path])).text.includes("not signed at all");
}

/** Ad-hoc sign `path` when it carries no signature; whether it signed. */
async function adHocSignIfUnsigned(path: string, run: CaptureRunner): Promise<boolean> {
  if (!await unsigned(path, run)) return false;
  const signed = await run("codesign", ["--force", "--sign", "-", path]);
  if (signed.code !== 0) throw new Error(`denext: codesign failed for ${path}: ${signed.text}`);
  return true;
}

/** The Mach-O regular files under `dir` (symlinks skipped), sorted. */
async function machOFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const path = join(dir, e.name);
    if (e.isDirectory) out.push(...await machOFilesUnder(path));
    else if (e.isFile && await isMachO(path)) out.push(path);
  }
  return out.sort();
}

/** The `Contents/Frameworks` directories whose name ends in `suffix`, sorted. */
async function nestedBundles(app: string, suffix: string): Promise<string[]> {
  const dir = join(app, "Contents", "Frameworks");
  if (!(await Deno.stat(dir).catch(() => null))?.isDirectory) return [];
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory && e.name.endsWith(suffix)) out.push(join(dir, e.name));
  }
  return out.sort();
}

/**
 * Ad-hoc sign, inside-out, the nested code of an `.app` that ships with no signature at all (the
 * x86_64 CEF archive: Apple's linker signs arm64 Mach-Os ad hoc, x86_64 ones are left unsigned).
 * codesign refuses to sign a bundle whose nested code is unsigned, so each framework's libraries
 * go first, then the framework, then each helper app; {@linkcode harmonizeApp} signs the main
 * executable after this. Code that already carries a signature is left alone. Returns whether it
 * signed anything.
 */
async function signUnsignedNested(app: string, run: CaptureRunner): Promise<boolean> {
  let changed = false;
  for (const framework of await nestedBundles(app, ".framework")) {
    // The framework's own binary is signed through the framework; its top-level link and
    // `Versions/Current` are symlinks, which the walk skips.
    const binary = basename(framework, ".framework");
    for (const lib of await machOFilesUnder(framework)) {
      if (basename(lib) === binary) continue;
      changed = await adHocSignIfUnsigned(lib, run) || changed;
    }
    changed = await adHocSignIfUnsigned(framework, run) || changed;
  }
  for (const helper of await nestedBundles(app, ".app")) {
    changed = await adHocSignIfUnsigned(helper, run) || changed;
  }
  return changed;
}

/** Re-sign the Mach-Os in one `.app`'s `Contents/MacOS` whose identifier isn't the bundle id. */
async function harmonizeApp(app: string, run: CaptureRunner): Promise<boolean> {
  const plist = join(app, "Contents", "Info.plist");
  const read = await run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
  const id = read.text.trim();
  if (read.code !== 0 || !id) return false;
  let changed = false;
  const macos = join(app, "Contents", "MacOS");
  for await (const e of Deno.readDir(macos)) {
    const path = join(macos, e.name);
    if (!e.isFile || !await isMachO(path)) continue;
    const shown = await run("codesign", ["-dv", path]);
    if (shown.text.split("\n").some((l) => l.trim() === `Identifier=${id}`)) continue;
    const signed = await run("codesign", ["--force", "--identifier", id, "--sign", "-", path]);
    if (signed.code !== 0) throw new Error(`denext: codesign failed for ${path}: ${signed.text}`);
    changed = true;
  }
  return changed;
}

/**
 * Do, once at install time, the ad-hoc re-sign the stock `deno desktop` applies to a
 * `LAUFEY_DEV_DIR` laufey `.app` on EVERY build (`harmonize_laufey_app_identifiers`: each Mach-O
 * in `Contents/MacOS` gets the bundle's `CFBundleIdentifier` as its signing identifier). The CLI
 * skips binaries that already match, so after this it never rewrites the verified cache, and two
 * packagers never re-sign the same file at once. An app shipped with no signature at all (the
 * x86_64 CEF build) first gets its nested code signed ad hoc. Returns the app dirs it changed.
 */
async function harmonizeLaufeyApps(root: string, run: CaptureRunner): Promise<string[]> {
  const changed: string[] = [];
  for (const rel of LAUFEY_APPS) {
    const app = join(root, ...rel.split("/"));
    if (!(await Deno.stat(app).catch(() => null))?.isDirectory) continue;
    // Nested code first: codesign refuses a main executable whose bundle holds unsigned code.
    const nested = await signUnsignedNested(app, run);
    if (await harmonizeApp(app, run) || nested) changed.push(rel);
  }
  return changed;
}

/** Hash every regular file under `root/rel` into `files` (replacing entries; after a re-sign). */
async function rehashTree(root: string, rel: string, files: Record<string, ExtractedFile>) {
  for (const key of Object.keys(files)) {
    if (key.startsWith(`${rel}/`)) delete files[key];
  }
  const walk = async (dirRel: string): Promise<void> => {
    for await (const e of Deno.readDir(join(root, ...dirRel.split("/")))) {
      const childRel = `${dirRel}/${e.name}`;
      const path = join(root, ...childRel.split("/"));
      if (e.isDirectory) await walk(childRel);
      else if (e.isFile) {
        files[childRel] = { size: (await Deno.stat(path)).size, sha256: await sha256File(path) };
      }
    }
  };
  await walk(rel);
}

/** What the cache lock's Blocking line names. */
const RUNTIME_CACHE_DESCR = "desktop runtime cache";

/** Options for {@linkcode ensureDesktopRuntime}. */
export interface EnsureDesktopRuntimeOptions {
  readonly target: string;
  readonly backend: DesktopRuntimeBackend;
  /** Defaults to {@linkcode DESKTOP_RUNTIME_PIN}. */
  readonly pin?: DesktopRuntimePin;
  /** Defaults to `<Deno cache>/denext-desktop-runtime`. */
  readonly cacheRoot?: string;
  /** Re-hash every cached file instead of the cheap size check. */
  readonly verify?: boolean;
  /**
   * `gh attestation verify` a downloaded archive: `true` requires it (a cached one not attested is
   * re-fetched), `"auto"` runs it when `gh` is signed in (a cached tree is kept as it is), `false`
   * (the default) never.
   */
  readonly attest?: DesktopRuntimeAttestMode;
  /** Progress output (default `console.error`). */
  readonly log?: (line: string) => void;
  /** Test seams. */
  readonly fetch?: typeof fetch;
  readonly run?: RuntimeCommandRunner;
  /** Runs `plutil` / `codesign` for the macOS re-sign (test seam). */
  readonly capture?: CaptureRunner;
  /** Whether to apply the macOS laufey re-sign (default: a macOS host and a darwin target). */
  readonly harmonize?: boolean;
  /** Test seam: the host OS and C library the Linux check sees ({@linkcode assertLinuxLibc}). */
  readonly host?: { readonly os?: string; readonly libc?: LinuxLibc };
  /** The clock, in epoch ms, for the re-hash schedule (test seam). */
  readonly now?: () => number;
}

/** Everything one install needs, resolved from {@linkcode EnsureDesktopRuntimeOptions}. */
interface InstallPlan {
  readonly opts: EnsureDesktopRuntimeOptions;
  readonly pin: DesktopRuntimePin;
  readonly artifact: DesktopRuntimeArtifact;
  readonly runtimeLib: string;
  readonly dir: string;
  readonly log: (line: string) => void;
  /** Whether a tree at `dir` is usable as-is (also decides adopting a racing packager's tree). */
  readonly acceptable: () => Promise<boolean>;
}

/** Extract the verified archive into `staged`, check its layout, re-sign on macOS, and mark it. */
async function stageRuntime(
  plan: InstallPlan,
  archive: string,
  staged: string,
  attested: boolean,
): Promise<void> {
  const { artifact, runtimeLib, pin, opts } = plan;
  const result = await extractArchive(archive, artifact.format, staged);
  await Deno.remove(archive);
  if (!result.files[runtimeLib]) {
    throw new Error(`denext: the runtime archive ${artifact.file} has no ${runtimeLib}`);
  }
  if (!Object.keys(result.files).some((f) => f.startsWith("laufey/"))) {
    throw new Error(`denext: the runtime archive ${artifact.file} has no laufey/ directory`);
  }
  const files = { ...result.files };
  const harmonize = opts.harmonize ??
    (Deno.build.os === "darwin" && opts.target.endsWith("-apple-darwin"));
  if (harmonize) {
    for (const rel of await harmonizeLaufeyApps(staged, opts.capture ?? capture)) {
      await rehashTree(staged, rel, files);
    }
  }
  const marker: RuntimeMarker = {
    schema: 1,
    version: pin.version,
    target: opts.target,
    backend: opts.backend,
    archive: { file: artifact.file, sha256: artifact.sha256, size: artifact.size },
    attested,
    files,
    symlinks: result.symlinks,
  };
  await Deno.writeTextFile(join(staged, RUNTIME_MARKER), JSON.stringify(marker, null, 2) + "\n");
}

/** Download, verify, stage and atomically install the runtime at `plan.dir`. */
async function installRuntime(plan: InstallPlan): Promise<void> {
  const { artifact, pin, opts, dir } = plan;
  // A Linux runtime on a host that can't run it (musl, an older glibc): say so before the
  // download. A cross-target runtime (packaging Linux from a Mac) is not checked.
  if (opts.target.includes("-linux-")) {
    await assertLinuxLibc(
      `the Deno Desktop runtime ${pin.version}`,
      minGlibcFor(pin),
      opts.host,
    );
  }
  const versionDir = dirname(dir);
  await Deno.mkdir(versionDir, { recursive: true });
  await sweepLeftovers(versionDir);
  const tmp = await Deno.makeTempDir({ dir: versionDir, prefix: ".tmp-" });
  try {
    const archive = join(tmp, artifact.file);
    plan.log(
      `  denext: downloading the Deno Desktop runtime ${pin.version} (${opts.target}, ` +
        `${opts.backend}, ${(artifact.size / 1024 / 1024).toFixed(1)} MB)…`,
    );
    await downloadVerified(artifact, archive, opts.fetch ?? fetch, plan.log);
    const attested = await shouldAttest(plan);
    if (attested) await attest(archive, pin, opts.run ?? defaultRunner);
    const staged = join(tmp, "runtime");
    await stageRuntime(plan, archive, staged, attested);
    await installAtomically(staged, dir, versionDir, plan.acceptable);
    if (!await verifiedRuntime(dir, pin, artifact)) {
      throw new Error(`denext: the Deno Desktop runtime at ${dir} did not verify after install`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/**
 * Make the pinned runtime for (target, backend) available in the cache — verified — and return
 * its paths. See the module header for the guarantees.
 *
 * @param options What to fetch and how.
 * @returns The runtime's paths.
 */
export function ensureDesktopRuntime(
  options: EnsureDesktopRuntimeOptions,
): Promise<ResolvedDesktopRuntime> {
  return lockTask(() => ensureDesktopRuntimeInTask(options));
}

async function ensureDesktopRuntimeInTask(
  options: EnsureDesktopRuntimeOptions,
): Promise<ResolvedDesktopRuntime> {
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const artifact = pinnedArtifact(pin, options.target, options.backend);
  const cacheRoot = options.cacheRoot ?? cacheRootFor();
  const dir = desktopRuntimeDir(cacheRoot, pin, options.target, options.backend);
  // Re-hashed under `verify`, and on the schedule (REHASH_INTERVAL_MS) without it.
  const full = options.verify === true || await runtimeRehashDue(dir, options.now?.());
  const plan: InstallPlan = {
    opts: options,
    pin,
    artifact,
    runtimeLib: pin.targets[options.target].runtimeLib,
    dir,
    log: options.log ?? ((l: string) => console.error(l)),
    // Verified (re-hashed when `full`) and, when provenance is asked for, attested.
    acceptable: async () => {
      const m = await verifiedRuntime(dir, pin, artifact, full);
      return m !== null && (options.attest !== true || m.attested);
    },
  };
  const resolved = async (cached: boolean) => {
    // A clean full check (or a fresh install, hashed as it was staged) restarts the schedule.
    if (full || !cached) await recordRehash(dir, options.now?.());
    return { dir, runtimeLib: join(dir, plan.runtimeLib), laufeyDir: join(dir, "laufey"), cached };
  };
  // Cargo's cache locks: reading a cached tree is Shared; adding a missing one is
  // DownloadExclusive (readers of other versions carry on); replacing an existing (bad) tree is
  // MutateExclusive. Each re-checks after it is granted — the process it waited on may have
  // installed exactly this runtime.
  // Before the lock files are opened or a cached tree is trusted: nobody else may write here.
  await Deno.mkdir(cacheRoot, { recursive: true });
  await assertTrustedCacheDirs(cacheDirChain(dirname(cacheRoot), dir));
  {
    using _shared = await acquireCacheLock(cacheRoot, "shared", RUNTIME_CACHE_DESCR);
    if (await plan.acceptable()) return resolved(true);
  }
  const replacing = (await Deno.lstat(dir).catch(() => null)) !== null;
  using _write = await acquireCacheLock(
    cacheRoot,
    replacing ? "mutate" : "download",
    RUNTIME_CACHE_DESCR,
  );
  if (await plan.acceptable()) return resolved(true);
  if (await readMarker(dir)) {
    plan.log(
      `  denext: the cached Deno Desktop runtime at ${dir} failed verification` +
        `${options.attest === true ? " (or has no provenance check)" : ""}; re-downloading.`,
    );
  }
  await installRuntime(plan);
  return resolved(false);
}

/** Options for {@linkcode renameRetrying} (test seams). */
export interface RenameRetryOptions {
  /** The host OS (default `Deno.build.os`); only Windows retries. */
  readonly os?: string;
  /** The waits between attempts, in ms (default 50 → 1600, doubling: ~3 s in all). */
  readonly delays?: readonly number[];
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const RENAME_DELAYS = [50, 100, 200, 400, 800, 1600];

/**
 * `Deno.rename(from, to)`, retried with backoff on Windows while it fails with `PermissionDenied`
 * (os error 5) and `to` does not exist: an antivirus scanner (Defender) holds a freshly written
 * file open for a moment after it is closed, which makes moving its directory fail. Anything
 * else — another OS, another error, or a `to` that now exists (a racing install) — is thrown at
 * once.
 *
 * @param from The path to move.
 * @param to Its new path.
 * @param options Test seams.
 */
export async function renameRetrying(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const rename = options.rename ?? Deno.rename;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = (options.os ?? Deno.build.os) === "windows" ? options.delays ?? RENAME_DELAYS : [];
  for (let attempt = 0;; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const retry = attempt < delays.length && err instanceof Deno.errors.PermissionDenied &&
        !(await Deno.lstat(to).catch(() => null));
      if (!retry) throw err;
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Rename `staged` to `dir`. Something already at `dir` is either a concurrent packager's finished
 * tree (kept when `isValid` says so) or a bad one (moved aside, then replaced). The caller
 * re-verifies `dir` afterwards either way.
 */
async function installAtomically(
  staged: string,
  dir: string,
  versionDir: string,
  isValid: () => Promise<boolean>,
): Promise<void> {
  try {
    await renameRetrying(staged, dir);
    return;
  } catch (err) {
    if (!(await Deno.lstat(dir).catch(() => null))) throw err;
  }
  if (await isValid()) return; // a racing packager won; use its verified tree
  const aside = join(versionDir, `.stale-${crypto.randomUUID()}`);
  await renameRetrying(dir, aside);
  try {
    await renameRetrying(staged, dir);
  } catch (err) {
    if (!(await Deno.lstat(dir).catch(() => null))) throw err; // else: lost a second race
  } finally {
    await Deno.remove(aside, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Resolving the env for one `deno desktop` invocation.

/**
 * What `deno --version` of `deno` says: its version (e.g. `2.9.7`) and, on denext's Deno from
 * 3.0.0-rc.3, its `denext <version> (Brainwires)` identity line (src/build/deno-version.ts).
 */
async function denoCliVersion(deno: string): Promise<DenoIdentity> {
  let out;
  try {
    out = await capture(deno, ["--version"]);
  } catch (err) {
    throw new Error(`denext: could not run \`${deno} --version\`: ${errText(err)}`);
  }
  const identity = parseDenoVersionOutput(out.text);
  if (!identity) {
    throw new Error(`denext: could not read the Deno version from \`${deno} --version\``);
  }
  return identity;
}

/** A `denoVersion` seam's answer as an identity: a bare version is a Deno with no marker line. */
function asIdentity(found: string | DenoIdentity): DenoIdentity {
  return typeof found === "string" ? { deno: found } : found;
}

/** The message for a `deno` that doesn't match the runtime's Deno version. */
export function denoVersionMismatchMessage(
  found: string,
  pin: DesktopRuntimePin,
  deno = "deno",
): string {
  return `denext: the Deno Desktop runtime ${pin.version} is built for Deno ${pin.deno} exactly ` +
    `(stock, or denext's Deno toolchain built from it), but \`${deno}\` is Deno ${found}.\n` +
    `  Install it with:  deno upgrade --version ${pin.deno}\n` +
    `  Or point DENO_BIN at a Deno ${pin.deno} binary, or at denext's Deno toolchain ` +
    `(\`denext toolchain path\`; desktop run / dev build with it).\n` +
    `  Or, ${STOCK_WAY_OUT}.`;
}

/**
 * The refusal of `DENEXT_DESKTOP_RUNTIME=stock` on denext's Deno, whose `deno desktop` builds only
 * on denext's runtime: an upstream runtime exits at startup, unable to read what it compiles.
 *
 * @param found The Deno's identity.
 * @param deno The binary that was asked.
 * @returns The message.
 */
function stockRuntimeOnDenextDenoMessage(found: DenoIdentity, deno: string): string {
  return `denext: ${RUNTIME_ENV}=stock needs a stock Deno CLI, but \`${deno}\` is denext's Deno ` +
    `(${found.denext || found.deno}), which builds only on denext's runtime.\n` +
    `  Unset ${RUNTIME_ENV} to use denext's pinned runtime (it downloads on first use), or set ` +
    "DENEXT_DENO=stock with a stock `deno` on PATH (or DENO_BIN at one).";
}

/**
 * What `deno` is, for the stock opt-out's check (`null` when it can't be asked: the build then
 * says so itself, as it always has).
 */
function stockOptOutIdentity(
  options: Pick<DesktopRuntimeEnvOptions, "deno" | "denoVersion">,
): Promise<DenoIdentity | null> {
  return (options.denoVersion ?? denoCliVersion)(options.deno ?? "deno")
    .then(asIdentity, () => null);
}

/**
 * Refuse `DENEXT_DESKTOP_RUNTIME=stock` when `deno` is denext's Deno, before anything is built.
 * Does nothing under any other runtime mode, or on a stock Deno CLI.
 *
 * @param options The `deno` that will run `deno desktop`, plus the env and version seams.
 */
export async function assertStockRuntimeUsable(
  options: Pick<DesktopRuntimeEnvOptions, "deno" | "denoVersion" | "env">,
): Promise<void> {
  if (runtimeMode(options.env ?? processEnv) !== "stock") return;
  const found = await stockOptOutIdentity(options);
  if (found && isDenextDenoVersion(found)) {
    throw new Error(stockRuntimeOnDenextDenoMessage(found, options.deno ?? "deno"));
  }
}

/** Options for {@linkcode resolveDesktopRuntimeEnv}. */
export interface DesktopRuntimeEnvOptions {
  /** The project directory (its deno.json `desktop.backend` picks the backend). */
  readonly projectDir: string;
  /** Rust target triple; default the host's. */
  readonly target?: string;
  /** Overrides deno.json `desktop.backend`. */
  readonly backend?: DesktopRuntimeBackend;
  /** The `deno` that will run `deno desktop` (default `deno`). */
  readonly deno?: string;
  /** Env reader (default `Deno.env.get`). */
  readonly env?: EnvGet;
  /** Seams for tests. */
  readonly pin?: DesktopRuntimePin;
  readonly cacheRoot?: string;
  readonly fetch?: typeof fetch;
  readonly run?: RuntimeCommandRunner;
  /** Runs `gh auth status` for the default provenance check (and the macOS re-sign's tools). */
  readonly capture?: CaptureRunner;
  /** What `deno --version` says (a bare version: one with no `denext … (Brainwires)` line). */
  readonly denoVersion?: (deno: string) => Promise<string | DenoIdentity>;
  readonly log?: (line: string) => void;
  readonly hostOs?: string;
  /**
   * What a `deno` that is not the runtime's exact Deno version does: `fail` (the default, for
   * packaging) or `stock` — build with the stock runtime and warn (`desktop run` / `dev`, where an
   * unpackaged window beats a refusal).
   */
  readonly onDenoMismatch?: "fail" | "stock";
  /**
   * Whether this build ships the runtime to others (`desktop build` / `package`, the default): a
   * runtime the revoked-runtimes list revokes for the target is then refused unless
   * `DENEXT_ALLOW_REVOKED_RUNTIME` names it. `false` (`desktop run` / `dev`) warns instead.
   */
  readonly ship?: boolean;
  /**
   * How the revoked-runtimes list is consulted (test seams). Absent: the built-in pin is checked;
   * a `pin` given without it is not.
   */
  readonly revocations?: Omit<LoadRevocationsOptions, "env">;
  /**
   * The Deno toolchain pin the `deno desktop` CLI comes from, as far as rolling back goes
   * (default `deno-toolchain-pin.json`; tests pass a fixture's).
   */
  readonly toolchainPin?: ToolchainPinVersions;
}

/** The versions of a Deno toolchain pin and its rollback (all a desktop rollback needs of it). */
export interface ToolchainPinVersions {
  readonly version: string | null;
  readonly rollback?: { readonly version: string };
}

/** The env for `deno desktop`, plus which runtime it selects. */
export interface DesktopRuntimeEnv {
  readonly mode: "pinned" | "stock" | "local";
  /** `DENORT_DESKTOP_BIN` + `LAUFEY_DEV_DIR` (empty for `stock`). */
  readonly env: Record<string, string>;
}

/** The deno.json(c) `desktop.backend` value of `projectDir` (`undefined` when unset or unreadable). */
async function configuredBackend(projectDir: string): Promise<unknown> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await Deno.readTextFile(join(projectDir, name)).catch(() => null);
    if (text === null) continue;
    try {
      return (readJson(text) as { desktop?: { backend?: unknown } })?.desktop?.backend;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The deno.json `desktop.backend` of `projectDir` (default `webview`). */
export async function projectDesktopBackend(projectDir: string): Promise<DesktopRuntimeBackend> {
  const backend = (await configuredBackend(projectDir)) ?? "webview";
  if (backend === "webview" || backend === "cef") return backend;
  throw new Error(
    `denext: deno.json desktop.backend is ${JSON.stringify(backend)}; the denext Deno Desktop ` +
      `runtime ships "webview" and "cef". On a stock Deno CLI (DENEXT_DENO=stock), set ` +
      `${RUNTIME_ENV}=stock for another backend.`,
  );
}

const isWindowsTarget = (t: string) => t.includes("-windows-");

/** The runtime library file name for `target`. */
function runtimeLibFor(pin: DesktopRuntimePin, target: string): string {
  const pinned = pin.targets[target]?.runtimeLib;
  if (pinned) return pinned;
  if (target.includes("darwin")) return "libdenort.dylib";
  return isWindowsTarget(target) ? "denort.dll" : "libdenort.so";
}

/** The `DENEXT_DESKTOP_RUNTIME` mode (throws on an unknown value). */
function runtimeMode(env: EnvGet): "stock" | "pinned" {
  const mode = (env(RUNTIME_ENV) ?? "").trim().toLowerCase();
  if (mode === "stock") return "stock";
  if (mode === "" || mode === "pinned") return "pinned";
  throw new Error(`denext: ${RUNTIME_ENV} must be "stock" or "pinned" (got "${mode}")`);
}

/** `DENEXT_DESKTOP_RUNTIME_DIR`: a local runtime build, checked for its layout only. */
async function localRuntimeEnv(localDir: string, lib: string, target: string) {
  const runtimeLib = join(localDir, lib);
  const laufeyDir = join(localDir, "laufey");
  if (!(await Deno.stat(runtimeLib).catch(() => null))?.isFile) {
    throw new Error(`denext: ${RUNTIME_DIR_ENV}=${localDir} has no ${lib} for ${target}`);
  }
  if (!(await Deno.stat(laufeyDir).catch(() => null))?.isDirectory) {
    throw new Error(`denext: ${RUNTIME_DIR_ENV}=${localDir} has no laufey/ directory`);
  }
  return { DENORT_DESKTOP_BIN: runtimeLib, LAUFEY_DEV_DIR: laufeyDir };
}

/** Where a backend's binary sits under `laufey/` in a Linux / Windows archive, and its base name. */
const BACKEND_BINARY: Readonly<Record<DesktopRuntimeBackend, { dir: string; name: string }>> = {
  webview: { dir: "webview/build", name: "laufey_webview" },
  cef: { dir: "cef/build/Release", name: "laufey" },
};

/** The file the cross-host backend directory records what it mirrors in. */
const CROSS_HOST_STAMP = ".denext-cross-host.json";

/** The backend binary a cross-host build must offer under the host's executable name. */
export interface CrossHostRename {
  /** The backend's binary directory, relative to `laufey/`. */
  readonly dir: string;
  /** The binary's name in the target's archive. */
  readonly from: string;
  /** The name the host's `deno desktop` looks for. */
  readonly to: string;
}

/**
 * Deno 2.9.7's `deno desktop` looks a `LAUFEY_DEV_DIR` backend binary up with the HOST's executable
 * suffix (`laufey_webview.exe` on Windows, `laufey_webview` elsewhere), so a Windows target's
 * binary is not found from macOS / Linux, nor a Linux one from Windows. It then copies the
 * binary's whole directory into the app and renames the binary to the app's launcher, so the name
 * it was found under never reaches the package. Returns the rename that bridges the two, or
 * `null` when the names already agree (a macOS target is found as a `.app` bundle, whatever the
 * host).
 *
 * @param hostOs The host OS (`Deno.build.os`).
 * @param target The Rust target triple.
 * @param backend The backend.
 * @returns The rename, or `null`.
 */
export function crossHostBackendRename(
  hostOs: string,
  target: string,
  backend: DesktopRuntimeBackend,
): CrossHostRename | null {
  if (target.includes("-apple-darwin")) return null;
  const { dir, name } = BACKEND_BINARY[backend];
  const from = name + (isWindowsTarget(target) ? ".exe" : "");
  const to = name + (hostOs === "windows" ? ".exe" : "");
  return from === to ? null : { dir, from, to };
}

/** The stamp of a cross-host backend directory: the archive it mirrors, and each file's size. */
interface CrossHostStamp {
  sha256: string;
  files: Record<string, number>;
}

/** What {@linkcode crossHostIntact} checks a mirror against. */
interface CrossHostSource {
  /** The runtime archive's SHA-256 the mirror must have been made from. */
  readonly sha256: string;
  /** The verified runtime the mirror copies (read by a full check). */
  readonly runtimeDir: string;
  /** The binary's rename (a full check compares the mirror's binary with the original). */
  readonly rename: CrossHostRename;
  /** Re-hash every mirrored file against its original in the verified runtime. */
  readonly full: boolean;
}

/** The runtime-relative path a mirrored file was copied from (the binary under its own name). */
function crossHostSourceRel(rel: string, rename: CrossHostRename): string {
  return rel === `laufey/${rename.dir}/${rename.to}` ? `laufey/${rename.dir}/${rename.from}` : rel;
}

/**
 * Whether `shim` holds a complete mirror of the runtime archive: every recorded file present at its
 * size, and, with `full`, the same bytes as its original in the verified runtime (a copy, unlike a
 * hard link, would otherwise keep a change the runtime's own re-hash never sees).
 */
async function crossHostIntact(shim: string, source: CrossHostSource): Promise<boolean> {
  const stamp = await readJsonFile<CrossHostStamp>(join(shim, CROSS_HOST_STAMP));
  if (stamp?.sha256 !== source.sha256 || Object.keys(stamp.files ?? {}).length === 0) return false;
  for (const [rel, size] of Object.entries(stamp.files)) {
    if (!await crossHostFileIntact(shim, rel, size, source)) return false;
  }
  return true;
}

/** Whether one mirrored file is present at `size` (and, with `full`, holds its original's bytes). */
async function crossHostFileIntact(
  shim: string,
  rel: string,
  size: number,
  source: CrossHostSource,
): Promise<boolean> {
  const path = join(shim, ...rel.split("/"));
  const info = await Deno.lstat(path).catch(() => null);
  if (!info?.isFile || info.size !== size) return false;
  if (!source.full) return true;
  const original = join(source.runtimeDir, ...crossHostSourceRel(rel, source.rename).split("/"));
  const want = await sha256File(original).catch(() => null);
  return want !== null && await sha256File(path) === want;
}

/** Hard-link (else copy) `src` to `dest`. */
async function linkOrCopy(src: string, dest: string): Promise<void> {
  try {
    await Deno.link(src, dest);
  } catch {
    await Deno.copyFile(src, dest);
  }
}

/**
 * Re-create the symlink `src` at `dest` (Windows needs to be told a file from a directory link);
 * where the OS won't create it (Windows without the symlink privilege), a link to a file becomes a
 * hard link or copy of that file — `deno desktop` copies the file it points at either way.
 */
async function mirrorLink(
  src: string,
  dest: string,
  destRel: string,
  files: Record<string, number>,
): Promise<void> {
  const info = await Deno.stat(src).catch(() => null);
  try {
    await Deno.symlink(await Deno.readLink(src), dest, {
      type: info?.isDirectory ? "dir" : "file",
    });
  } catch (err) {
    if (!info?.isFile) throw err;
    await linkOrCopy(await Deno.realPath(src), dest);
    files[destRel] = (await Deno.lstat(dest)).size;
  }
}

/**
 * Mirror the backend directory `laufey/<rename.dir>` of the runtime at `runtimeDir` into `staged`
 * (hard links where the filesystem allows), with the binary renamed. Returns the stamp's file map.
 */
async function mirrorBackendDir(
  runtimeDir: string,
  staged: string,
  rename: CrossHostRename,
): Promise<Record<string, number>> {
  const binary = join(runtimeDir, "laufey", ...rename.dir.split("/"), rename.from);
  if (!(await Deno.lstat(binary).catch(() => null))?.isFile) {
    throw new Error(`denext: the Deno Desktop runtime at ${runtimeDir} has no ${rename.from}`);
  }
  const files: Record<string, number> = {};
  const walk = async (rel: string, top: boolean): Promise<void> => {
    const srcDir = join(runtimeDir, ...rel.split("/"));
    await Deno.mkdir(join(staged, ...rel.split("/")), { recursive: true });
    for await (const e of Deno.readDir(srcDir)) {
      const name = top && e.name === rename.from ? rename.to : e.name;
      const src = join(srcDir, e.name);
      const destRel = `${rel}/${name}`;
      const dest = join(staged, ...destRel.split("/"));
      if (e.isDirectory) await walk(`${rel}/${e.name}`, false);
      else if (e.isSymlink) await mirrorLink(src, dest, destRel, files);
      else if (e.isFile) {
        await linkOrCopy(src, dest);
        files[destRel] = (await Deno.lstat(dest)).size;
      }
    }
  };
  await walk(`laufey/${rename.dir}`, true);
  return files;
}

/**
 * The `LAUFEY_DEV_DIR` for a cross-host build: a sibling of the verified runtime
 * (`<target>-<backend>.cross-host/laufey`) holding only the backend's directory, hard-linked from
 * the verified tree, with the binary under the host's executable name (see
 * {@linkcode crossHostBackendRename}). Built once per runtime archive and reused; installed with
 * the same atomic rename as the runtime itself.
 */
function crossHostLaufeyDir(
  rt: ResolvedDesktopRuntime,
  rename: CrossHostRename,
  log: (line: string) => void,
  full: boolean,
): Promise<string> {
  return lockTask(() => crossHostLaufeyDirInTask(rt, rename, log, full));
}

async function crossHostLaufeyDirInTask(
  rt: ResolvedDesktopRuntime,
  rename: CrossHostRename,
  log: (line: string) => void,
  full: boolean,
): Promise<string> {
  const marker = await readMarker(rt.dir);
  if (!marker) throw new Error(`denext: the Deno Desktop runtime at ${rt.dir} has no marker`);
  const versionDir = dirname(rt.dir);
  const shim = join(versionDir, `${basename(rt.dir)}.cross-host`);
  const source = { sha256: marker.archive.sha256, runtimeDir: rt.dir, rename, full };
  const valid = () => crossHostIntact(shim, source);
  using _lock = await acquireCacheLock(dirname(versionDir), "download", RUNTIME_CACHE_DESCR);
  if (await valid()) return join(shim, "laufey");
  log(
    `  denext: cross-building — offering the ${rename.from} backend as ${rename.to}, the name ` +
      "this host's `deno desktop` looks for (hard links into the verified runtime).",
  );
  const tmp = await Deno.makeTempDir({ dir: versionDir, prefix: ".tmp-" });
  try {
    const staged = join(tmp, "cross-host");
    const files = await mirrorBackendDir(rt.dir, staged, rename);
    const stamp: CrossHostStamp = { sha256: marker.archive.sha256, files };
    await Deno.writeTextFile(join(staged, CROSS_HOST_STAMP), JSON.stringify(stamp) + "\n");
    await installAtomically(staged, shim, versionDir, valid);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
  if (!await valid()) throw new Error(`denext: the cross-host backend at ${shim} did not verify`);
  return join(shim, "laufey");
}

/** The deprecation notice's seams: the caller's env seam when it has one, and its log. */
function deprecationDeps(env: EnvGet | undefined, log: (l: string) => void) {
  return env ? { env, warn: log } : { warn: log };
}

/** The stock fallback of `desktop run` / `dev` for a `deno` of another version (a warning). */
function stockForMismatch(
  found: string,
  pin: DesktopRuntimePin,
  deno: string,
  log: (l: string) => void,
) {
  log(
    `  ⚠ ${denoVersionMismatchMessage(found, pin, deno).replace(/^denext: /, "")}\n` +
      "  Building this window with the STOCK runtime instead (packaging still requires " +
      `Deno ${pin.deno}).`,
  );
  return { mode: "stock" as const, env: {} };
}

/**
 * The runtime pin a `deno desktop` build uses: the pin in force, or its `rollback` when the Deno
 * toolchain this process runs on is the toolchain pin's rollback (the command that started it
 * rolled both back: libdenort must match the CLI) AND the revoked-runtimes list, read here, still
 * moves both back for `target` — the toolchain marker alone (it can leak from a parent shell)
 * never makes a package ship the older runtime. Otherwise a pin the list revokes for `target` is
 * refused when the build ships it ({@linkcode revokedShipRefusal}), or used with one warning
 * (`desktop run` / `dev`).
 */
async function selectDesktopPin(
  options: DesktopRuntimeEnvOptions,
  env: EnvGet,
  target: string,
  log: (line: string) => void,
): Promise<DesktopRuntimePin> {
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const rollback = rollbackDesktopPin(pin);
  const marked = rollback?.version !== undefined && env(TOOLCHAIN_ACTIVE_ENV) === rollback.version;
  if (!marked && !checksPin(options)) return pin;
  const { list } = await loadRuntimeRevocations({ ...options.revocations, env });
  if (marked && rollsBackTogether(list, pin, target, options.toolchainPin)) return rollback!;
  const hit = findRevocation(list, "desktop", pin.version, target);
  const ship = options.ship !== false;
  if (hit) revokedDesktopPin(hit, { list, rollback, ship, target, env, log });
  return pin;
}

/** Whether the list is consulted for the pin: the built-in one, or a given one with `revocations`. */
function checksPin(options: DesktopRuntimeEnvOptions): boolean {
  return options.pin === undefined || options.revocations !== undefined;
}

/**
 * Whether `list` moves the Deno toolchain and the Deno Desktop runtime back together for `target`
 * (src/build/runtime-revocations.ts `decideRevocation`): one of them is revoked there, and both
 * pins name the same rollback release, which is not revoked itself.
 */
function rollsBackTogether(
  list: RuntimeRevocationList | null,
  pin: DesktopRuntimePin,
  target: string,
  toolchain: ToolchainPinVersions = toolchainPinJson,
): boolean {
  const rollback = pin.rollback?.version ?? null;
  if (toolchain.version === null || toolchain.rollback?.version !== rollback) return false;
  const decision = decideRevocation(list, [
    { component: "cli", version: toolchain.version, rollback, triple: target },
    { component: "desktop", version: pin.version, rollback, triple: target },
  ]);
  return decision.hit !== null && decision.useRollback;
}

/**
 * What a revoked desktop runtime pin means for this build: one warning (`desktop run` / `dev`),
 * or a refusal to package on it unless `DENEXT_ALLOW_REVOKED_RUNTIME` names it — pointing at the
 * pin's rollback when that one is not revoked too.
 */
function revokedDesktopPin(
  hit: RuntimeRevocation,
  o: {
    list: RuntimeRevocationList | null;
    rollback: DesktopRuntimePin | null;
    ship: boolean;
    target: string;
    env: EnvGet;
    log: (line: string) => void;
  },
): void {
  const { target } = o;
  if (!o.ship) {
    if (o.env(REVOCATION_NOTICED_ENV) !== "1") o.log(revocationNotice(hit, target, null));
    return;
  }
  const refusal = revokedShipRefusal(hit, target, "package on", o.env);
  if (refusal === null) return;
  const usable = o.rollback !== null &&
    findRevocation(o.list, "desktop", o.rollback.version, target) === null;
  throw new Error(refusal + (usable ? fallbackHint(o.rollback!.version) : ""));
}

/** Where a packaging refusal points when the pin's rollback could build instead. */
function fallbackHint(version: string): string {
  return "\n  `denext desktop build` / `denext desktop package` build on the pinned fallback " +
    `${version} instead.`;
}

/**
 * A `deno` of another release than the runtime's: a refusal, or under `onDenoMismatch: "stock"` on
 * a stock Deno the stock runtime with a warning (denext's Deno can't build on it).
 */
function mismatchedDenoEnv(
  found: DenoIdentity,
  pin: DesktopRuntimePin,
  deno: string,
  options: DesktopRuntimeEnvOptions,
  log: (l: string) => void,
): DesktopRuntimeEnv {
  if (options.onDenoMismatch !== "stock" || isDenextDenoVersion(found)) {
    throw new Error(denoVersionMismatchMessage(found.deno, pin, deno));
  }
  const stock = stockForMismatch(found.deno, pin, deno, log);
  warnStockDeprecation("desktop-mismatch", deprecationDeps(options.env, log));
  return stock;
}

/** The `DENEXT_DESKTOP_RUNTIME=stock` opt-out: a refusal on denext's Deno, else no env + warnings. */
async function stockRuntimeEnv(
  options: DesktopRuntimeEnvOptions,
  env: EnvGet,
  log: (l: string) => void,
): Promise<DesktopRuntimeEnv> {
  await assertStockRuntimeUsable({ ...options, env });
  log(
    `  denext: ${RUNTIME_ENV}=stock — building with the STOCK Deno Desktop runtime (${STOCK_LACKS}).`,
  );
  warnStockDeprecation("desktop-env", deprecationDeps(options.env, log));
  return { mode: "stock", env: {} };
}

/**
 * Resolve the env one `deno desktop` invocation needs to run on denext's pinned runtime (and
 * download / verify it on first use). Honors `DENEXT_DESKTOP_RUNTIME=stock` (no env, a warning; on
 * denext's Deno a refusal),
 * `DENEXT_DESKTOP_RUNTIME_DIR` (a local build, unverified, a warning),
 * `DENEXT_DESKTOP_RUNTIME_VERIFY=1` and `DENEXT_DESKTOP_RUNTIME_ATTEST` (unset: a fresh download
 * is attested when `gh` is signed in). Fails when `deno` is
 * not the runtime's exact Deno version (or, with `onDenoMismatch: "stock"` on a stock Deno, warns
 * and selects the stock runtime). A target whose backend binary the host's `deno desktop` would look up under
 * another executable suffix (Windows from macOS / Linux, Linux from Windows) gets a cross-host
 * `LAUFEY_DEV_DIR` (see {@linkcode crossHostBackendRename}).
 *
 * @param options The project and target.
 * @returns The env to add to the `deno desktop` child.
 */
export async function resolveDesktopRuntimeEnv(
  options: DesktopRuntimeEnvOptions,
): Promise<DesktopRuntimeEnv> {
  const env = options.env ?? processEnv;
  const log = options.log ?? ((l: string) => console.error(l));
  const target = options.target ?? desktopRuntimeTarget();
  if (runtimeMode(env) === "stock") return await stockRuntimeEnv(options, env, log);
  const localDir = env(RUNTIME_DIR_ENV);
  if (localDir) {
    const lib = runtimeLibFor(options.pin ?? DESKTOP_RUNTIME_PIN, target);
    const local = await localRuntimeEnv(localDir, lib, target);
    log(
      `  denext: using the LOCAL Deno Desktop runtime at ${localDir} (${RUNTIME_DIR_ENV}); it is ` +
        "not downloaded, pinned or verified.",
    );
    return { mode: "local", env: local };
  }
  const pin = await selectDesktopPin(options, env, target, log);
  const deno = options.deno ?? "deno";
  const found = asIdentity(await (options.denoVersion ?? denoCliVersion)(deno));
  if (denoReleaseVersion(found) !== pin.deno) {
    return mismatchedDenoEnv(found, pin, deno, options, log);
  }
  const backend = options.backend ?? await projectDesktopBackend(options.projectDir);
  const rt = await ensureDesktopRuntime({
    target,
    backend,
    pin,
    cacheRoot: options.cacheRoot,
    verify: env(DESKTOP_RUNTIME_VERIFY_ENV) === "1",
    attest: desktopRuntimeAttestMode(env(DESKTOP_RUNTIME_ATTEST_ENV)),
    fetch: options.fetch,
    run: options.run,
    ...(options.capture ? { capture: options.capture } : {}),
    log,
  });
  const rename = crossHostBackendRename(options.hostOs ?? Deno.build.os, target, backend);
  const verify = env(DESKTOP_RUNTIME_VERIFY_ENV) === "1";
  const laufeyDir = rename ? await crossHostLaufeyDir(rt, rename, log, verify) : rt.laufeyDir;
  return { mode: "pinned", env: { DENORT_DESKTOP_BIN: rt.runtimeLib, LAUFEY_DEV_DIR: laufeyDir } };
}

/**
 * The `deno desktop` flags a build on denext's pinned Deno Desktop runtime (or a local runtime
 * build) gets, given the env {@linkcode resolveDesktopRuntimeEnv} resolved for it. A runtime before
 * `3.0.0-rc.5` gets `--unstable-no-legacy-abort`, which it keeps from the compiled app's metadata
 * (from 2.9.7-denext.21), so the app's server aborts `request.signal` only when a response is not
 * delivered and prints no `Deno.serve` legacy-behavior notice on its first request, as under
 * `denext start` and a `build --compile` binary. From `3.0.0-rc.5` that is the runtime's default,
 * so it gets none. The stock runtime (an empty env) gets none either: it ignores the setting. A
 * flag already in `denoFlags` (`desktop.denoFlags`) is not repeated.
 *
 * @param runtimeEnv The `deno desktop` child's runtime env (`DENORT_DESKTOP_BIN` set: not stock).
 * @param denoFlags The flags the command already passes (`desktop.denoFlags`).
 * @param pin The runtime pin (its `version` decides whether the flag is still needed).
 * @returns The flags, to splice in before the entry.
 */
export function desktopRuntimeDenoFlags(
  runtimeEnv: Readonly<Record<string, string>>,
  denoFlags: readonly string[] = [],
  pin: { readonly version: string } = DESKTOP_RUNTIME_PIN,
): string[] {
  if (!runtimeEnv.DENORT_DESKTOP_BIN || !needsNoLegacyAbortFlag(pin.version)) return [];
  return ["--unstable-no-legacy-abort"].filter((flag) => !denoFlags.includes(flag));
}

/**
 * Whether a `deno desktop` build from this process bakes the network grant split by direction
 * (`--allow-net-connect` + `--allow-net-listen`, see `src/build/net-permissions.ts`): it builds on
 * denext's pinned Deno Desktop runtime (not `DENEXT_DESKTOP_RUNTIME=stock`, not a local
 * `DENEXT_DESKTOP_RUNTIME_DIR` build of unknown version) whose version has the split, and the Deno
 * running the build (`denoVersion`) parses the flags. `desktop run` / `dev` re-ran on the Deno they
 * build with, so theirs is this process's own; a packaging script spawns the `deno` on `PATH`,
 * which may be another one ({@linkcode desktopNetSplitFor}).
 *
 * @param env Reads an environment variable.
 * @param deno The building Deno (default: this process's; denext's Deno by its identity marker,
 *   so upstream Deno of the same version never gets the flags).
 * @param pin The runtime pin.
 * @returns Whether to bake the split flags.
 */
export function desktopNetSplit(
  env: EnvGet = processEnv,
  deno: DenoIdentity = currentDenoIdentity(),
  pin: Pick<DesktopRuntimePin, "version"> = DESKTOP_RUNTIME_PIN,
): boolean {
  const mode = (env(RUNTIME_ENV) ?? "").trim().toLowerCase();
  if (mode === "stock" || env(RUNTIME_DIR_ENV)) return false;
  return supportsNetSplit(pin.version) && denoSupportsNetSplit(deno);
}

/**
 * {@linkcode desktopNetSplit} for the `deno` a packaging script spawns (`deno` on `PATH`, which
 * under a plain `deno task` or a CI's own Deno need not be the Deno running the script): its
 * version is read from `deno --version`. Not run under `DENEXT_DESKTOP_RUNTIME=stock` or a local
 * runtime build; a `deno` that can't be run reads as no split.
 *
 * @param deno The `deno` the build runs.
 * @param env Reads an environment variable.
 * @param version Reads a Deno's version (a test seam).
 * @returns Whether to bake the split flags.
 */
export async function desktopNetSplitFor(
  deno: string = "deno",
  env: EnvGet = processEnv,
  version: (deno: string) => Promise<string | DenoIdentity> = denoCliVersion,
): Promise<boolean> {
  // The env and the pin first (with a Deno that has the split), so a stock runtime spawns nothing.
  const split = { deno: NET_SPLIT_RELEASE, denext: NET_SPLIT_RELEASE };
  if (!desktopNetSplit(env, split)) return false;
  return desktopNetSplit(env, asIdentity(await version(deno).catch(() => "")));
}

/**
 * The env a scaffolded `scripts/package-*.ts` adds to its `deno desktop` command so it builds on
 * denext's pinned Deno Desktop runtime: `DENORT_DESKTOP_BIN` + `LAUFEY_DEV_DIR` for `target`
 * (default: the host), downloaded and verified on first use. Empty under
 * `DENEXT_DESKTOP_RUNTIME=stock`. The project is the script's parent directory.
 *
 * @param entryUrl The packaging script's `import.meta.url`.
 * @param target The Rust target triple passed to `deno desktop --target` (default: the host's).
 * @returns The env vars to set on the `deno desktop` child.
 */
export async function desktopRuntimeEnv(
  entryUrl: string,
  target?: string,
): Promise<Record<string, string>> {
  const projectDir = fromFileUrl(new URL("..", entryUrl));
  return (await resolveDesktopRuntimeEnv({ projectDir, target })).env;
}

// ---------------------------------------------------------------------------------------------
// `denext doctor`'s view.

/** The pinned runtime's state on this machine (for `denext doctor`). */
export interface DesktopRuntimeStatus {
  readonly mode: "pinned" | "stock" | "local";
  readonly version: string;
  readonly target: string;
  readonly backend: DesktopRuntimeBackend | null;
  /** `cached` = present + verified; `missing` = downloads on first use; `invalid` = re-downloads. */
  readonly cache: "cached" | "missing" | "invalid" | "unpinned" | "n/a";
  /**
   * The `deno` that runs `deno desktop`: its version, the version it needs, and its identity
   * marker (`denext`, the `denext <version> (Brainwires)` line) when it is denext's Deno toolchain.
   */
  readonly deno: {
    readonly found: string | null;
    readonly required: string;
    readonly denext?: string;
  };
  /** Whether nothing needs fixing (a missing cache is fine: it downloads). */
  readonly ok: boolean;
  /** One line for a report. */
  readonly detail: string;
}

type CacheState = DesktopRuntimeStatus["cache"];

const CACHE_TEXT: Record<CacheState, string> = {
  cached: "cached + verified",
  missing: "not cached yet (downloaded on the first desktop run/package)",
  invalid: "cache FAILED verification (re-downloaded on next use)",
  unpinned: `no pinned build for this host (on a stock Deno CLI, ${RUNTIME_ENV}=stock)`,
  "n/a": "",
};

/**
 * The `deno` half of {@linkcode desktopRuntimeStatus}: whether the `deno` found (`null`: none) is
 * the runtime's Deno release — stock, or denext's toolchain told by its identity marker — and its
 * report text.
 */
function denoStatus(
  identity: DenoIdentity | null,
  pin: DesktopRuntimePin,
): { ok: boolean; text: string; status: DesktopRuntimeStatus["deno"] } {
  const wrong = (found: string) =>
    `deno ${found} ✗ — needs ${pin.deno}: deno upgrade --version ${pin.deno}`;
  if (identity === null) {
    return { ok: false, text: wrong("not found"), status: { found: null, required: pin.deno } };
  }
  const status = { found: identity.deno, required: pin.deno, ...markerOf(identity) };
  if (denoReleaseVersion(identity) !== pin.deno) {
    return { ok: false, text: wrong(identity.deno), status };
  }
  const whose = identity.denext === undefined ? "" : " (denext's Deno)";
  return { ok: true, text: `deno ${identity.deno}${whose} ✓`, status };
}

/** An identity's marker as a status field (`{}` when it has none). */
function markerOf(identity: DenoIdentity): { denext?: string } {
  return identity.denext === undefined ? {} : { denext: identity.denext };
}

/** The status under an override (`stock` / a local dir), or `null` for the pinned runtime. */
async function overrideStatus(
  options: DesktopRuntimeEnvOptions,
  env: EnvGet,
  base: Pick<DesktopRuntimeStatus, "version" | "target" | "deno">,
): Promise<DesktopRuntimeStatus | null> {
  const common = { ...base, backend: null, cache: "n/a" as const, ok: true };
  if ((env(RUNTIME_ENV) ?? "").trim().toLowerCase() === "stock") {
    const found = await stockOptOutIdentity(options);
    const refused = found !== null && isDenextDenoVersion(found);
    return {
      ...common,
      ...(found ? { deno: { ...base.deno, found: found.deno, ...markerOf(found) } } : {}),
      mode: "stock",
      ok: !refused,
      detail: refused
        ? stockRuntimeOnDenextDenoMessage(found, options.deno ?? "deno").replace(/^denext: /, "")
        : `${RUNTIME_ENV}=stock — the stock runtime (${STOCK_LACKS})`,
    };
  }
  const local = env(RUNTIME_DIR_ENV);
  if (!local) return null;
  return {
    ...common,
    mode: "local",
    detail: `local runtime build at ${local} (${RUNTIME_DIR_ENV}; unverified)`,
  };
}

/** The cache state of (target, backend), without downloading. */
async function cacheState(
  options: DesktopRuntimeEnvOptions & { readonly verify?: boolean },
  pin: DesktopRuntimePin,
  target: string,
  backend: DesktopRuntimeBackend,
): Promise<CacheState> {
  const artifact = pin.targets[target]?.[backend];
  if (!artifact) return "unpinned";
  const root = options.cacheRoot ?? cacheRootFor(options.env ?? processEnv);
  const dir = desktopRuntimeDir(root, pin, target, backend);
  if (await verifiedRuntime(dir, pin, artifact, options.verify === true)) return "cached";
  return (await readMarker(dir)) ? "invalid" : "missing";
}

/**
 * Report the pinned runtime for this host: its version, whether it is cached and verified (the
 * cheap check, or a full re-hash with `verify`), and whether the `deno` that runs `deno desktop`
 * is the runtime's exact Deno version. Never downloads.
 *
 * @param options The project, plus the same seams as {@linkcode resolveDesktopRuntimeEnv}.
 * @returns The status.
 */
export async function desktopRuntimeStatus(
  options: DesktopRuntimeEnvOptions & { readonly verify?: boolean },
): Promise<DesktopRuntimeStatus> {
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const target = options.target ?? desktopRuntimeTarget();
  const base = { version: pin.version, target, deno: { found: null, required: pin.deno } };
  const override = await overrideStatus(options, options.env ?? processEnv, base);
  if (override) return override;
  const deno = denoStatus(
    await (options.denoVersion ?? denoCliVersion)(options.deno ?? "deno")
      .then(asIdentity, () => null),
    pin,
  );
  let backend: DesktopRuntimeBackend | null = null;
  let cache: CacheState = "unpinned";
  let problem: string | null = null;
  try {
    backend = options.backend ?? await projectDesktopBackend(options.projectDir);
    cache = await cacheState(options, pin, target, backend);
  } catch (err) {
    problem = errText(err);
  }
  const parts = [
    `runtime ${pin.version} for ${target}/${backend ?? "?"}`,
    CACHE_TEXT[cache],
    deno.text,
  ];
  return {
    ...base,
    deno: deno.status,
    mode: "pinned",
    backend,
    cache,
    ok: deno.ok && problem === null && (cache === "cached" || cache === "missing"),
    detail: [...parts, ...(problem ? [problem] : [])].join("; "),
  };
}
