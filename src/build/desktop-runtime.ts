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
//      `verify` re-hashes every file instead;
//   2. else streams the archive into a private temp dir under the version dir, refusing it the
//      moment it exceeds the pinned size, then checks size AND SHA-256 before anything else
//      touches it; nothing is extracted from an unverified archive;
//   3. extracts with `safe-extract.ts` (no traversal, no escaping links, no special files),
//      writes the marker (each file's size + SHA-256), and renames the whole tree into place
//      atomically. Two packagers racing each extract privately; the loser of the rename adopts
//      the winner's verified tree. A crashed run leaves only a temp dir, cleaned up a day later.
//
// The `deno` that runs `deno desktop` must be the runtime's exact Deno version (the CLI embeds a
// matching libdenort ABI). `DENEXT_DESKTOP_RUNTIME=stock` opts out (the stock runtime: no custom
// origin, deep links or single instance); `DENEXT_DESKTOP_RUNTIME_DIR=<dir>` uses a local runtime
// build unverified (runtime development).

import { acquireCacheLock } from "./project-locks.ts";
import { basename, dirname, fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import { extractArchive, type ExtractedFile } from "./safe-extract.ts";
import { readJson } from "./json-edit.ts";
import pinJson from "./desktop-runtime-pin.json" with { type: "json" };

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
}

/** The runtime denext pins (generated; see the header). */
export const DESKTOP_RUNTIME_PIN: DesktopRuntimePin = pinJson as DesktopRuntimePin;

/** `stock` → the stock runtime; unset / `pinned` → denext's. */
const RUNTIME_ENV = "DENEXT_DESKTOP_RUNTIME";
/** A local runtime build directory (runtime development), used unverified. */
const RUNTIME_DIR_ENV = "DENEXT_DESKTOP_RUNTIME_DIR";
/** `1` → re-hash every cached file before use. */
export const DESKTOP_RUNTIME_VERIFY_ENV = "DENEXT_DESKTOP_RUNTIME_VERIFY";
/** `1` → `gh attestation verify` a freshly downloaded archive. */
export const DESKTOP_RUNTIME_ATTEST_ENV = "DENEXT_DESKTOP_RUNTIME_ATTEST";

/** The marker a verified cache entry carries (at its root, beside the runtime lib). */
export const RUNTIME_MARKER = ".denext-runtime.json";

/** What the stock runtime lacks (named in every opt-out message). */
const STOCK_LACKS = "no stable app origin or persistent browser storage, deep links, " +
  "single instance, preload, full-app updates, native clipboard / notifications / context " +
  "menu, or window controls beyond size, position and title";

/** The way out of a runtime download that failed (every download error ends with it). */
const DOWNLOAD_HINT =
  `\n  Once it is cached, packaging needs no network. Or set ${RUNTIME_DIR_ENV}=<an unpacked ` +
  `runtime>, or ${RUNTIME_ENV}=stock to use the stock runtime (${STOCK_LACKS}).`;

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

/**
 * Deno's cache directory: `DENO_DIR`, else the platform default Deno itself uses
 * (`~/Library/Caches/deno`, `%LOCALAPPDATA%\deno`, `$XDG_CACHE_HOME/deno` or `~/.cache/deno`).
 *
 * @param env Env reader.
 * @param os The OS.
 * @returns The directory.
 */
export function denoCacheDir(env: EnvGet = processEnv, os: string = Deno.build.os): string {
  const explicit = env("DENO_DIR");
  if (explicit) return explicit;
  const home = env("HOME") ?? env("USERPROFILE") ?? ".";
  if (os === "darwin") return join(home, "Library", "Caches", "deno");
  if (os === "windows") return join(env("LOCALAPPDATA") ?? join(home, "AppData", "Local"), "deno");
  return join(env("XDG_CACHE_HOME") ?? join(home, ".cache"), "deno");
}

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
      `${target} (it has: ${Object.keys(pin.targets).join(", ")}).\n  Set ${RUNTIME_ENV}=stock ` +
      `to use the stock runtime (${STOCK_LACKS}).`,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const f = await Deno.open(path, { read: true });
  for await (const chunk of f.readable) hash.update(chunk);
  return hash.digest("hex");
}

async function readMarker(dir: string): Promise<RuntimeMarker | null> {
  try {
    return JSON.parse(await Deno.readTextFile(join(dir, RUNTIME_MARKER))) as RuntimeMarker;
  } catch {
    return null;
  }
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
    if (await Deno.readLink(join(dir, ...rel.split("/"))).catch(() => null) !== target) {
      return false;
    }
  }
  return true;
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
): Promise<ReadableStream<Uint8Array>> {
  let res: Response;
  try {
    res = await fetchImpl(artifact.url, { redirect: "follow" });
  } catch (err) {
    throw new DesktopRuntimeDownloadError(
      `denext: could not download the Deno Desktop runtime (${artifact.file}) from ` +
        `${artifact.url}: ${errText(err)}.\n  Are you offline?${DOWNLOAD_HINT}`,
    );
  }
  if (res.ok && res.body) return res.body;
  await res.body?.cancel();
  throw new DesktopRuntimeDownloadError(
    `denext: downloading the Deno Desktop runtime failed: GET ${artifact.url} → ` +
      `${res.status} ${res.statusText}${DOWNLOAD_HINT}`,
  );
}

/** Raised (and never wrapped) when a download is refused for its size or hash. */
class RefusedDownload extends Error {}

/**
 * Stream `body` into the new file `dest`, hashing it and refusing it as soon as it outgrows
 * `maxSize`. Returns the byte count and SHA-256.
 */
async function streamToFile(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxSize: number,
  what: string,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const file = await Deno.open(dest, { write: true, createNew: true });
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxSize) {
        throw new RefusedDownload(
          `denext: refusing the Deno Desktop runtime ${what}: the download is larger than its ` +
            `pinned ${maxSize} bytes${DOWNLOAD_HINT}`,
        );
      }
      hash.update(chunk);
      for (let off = 0; off < chunk.byteLength;) off += await file.write(chunk.subarray(off));
    }
  } catch (err) {
    if (err instanceof RefusedDownload) throw err;
    throw new DesktopRuntimeDownloadError(
      `denext: the Deno Desktop runtime download was interrupted (${what}, ${size} of ` +
        `${maxSize} bytes): ${errText(err)}${DOWNLOAD_HINT}`,
    );
  } finally {
    file.close();
  }
  return { size, sha256: hash.digest("hex") };
}

/** Download `artifact` to `dest`, refusing anything but exactly its pinned size and SHA-256. */
async function downloadVerified(
  artifact: DesktopRuntimeArtifact,
  dest: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = await openDownload(artifact, fetchImpl);
  const got = await streamToFile(body, dest, artifact.size, artifact.file);
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

/** `gh attestation verify` the archive (opt-in provenance check), pinned to the release's build. */
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
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
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
 * packagers never re-sign the same file at once. Returns the app dirs it changed.
 */
async function harmonizeLaufeyApps(root: string, run: CaptureRunner): Promise<string[]> {
  const changed: string[] = [];
  for (const rel of LAUFEY_APPS) {
    const app = join(root, ...rel.split("/"));
    if (!(await Deno.stat(app).catch(() => null))?.isDirectory) continue;
    if (await harmonizeApp(app, run)) changed.push(rel);
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

/** Remove `.tmp-*` / `.stale-*` leftovers older than a day (crashed or raced runs). */
async function sweepLeftovers(versionDir: string): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;
  for await (const e of Deno.readDir(versionDir)) {
    if (!e.isDirectory || !/^\.(tmp|stale)-/.test(e.name)) continue;
    const path = join(versionDir, e.name);
    const mtime = (await Deno.stat(path).catch(() => null))?.mtime?.getTime();
    if (mtime !== undefined && mtime < cutoff) {
      await Deno.remove(path, { recursive: true }).catch(() => {});
    }
  }
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
  /** `gh attestation verify` a downloaded archive (a cached one not attested is re-fetched). */
  readonly attest?: boolean;
  /** Progress output (default `console.error`). */
  readonly log?: (line: string) => void;
  /** Test seams. */
  readonly fetch?: typeof fetch;
  readonly run?: RuntimeCommandRunner;
  /** Runs `plutil` / `codesign` for the macOS re-sign (test seam). */
  readonly capture?: CaptureRunner;
  /** Whether to apply the macOS laufey re-sign (default: a macOS host and a darwin target). */
  readonly harmonize?: boolean;
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
async function stageRuntime(plan: InstallPlan, archive: string, staged: string): Promise<void> {
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
    attested: opts.attest === true,
    files,
    symlinks: result.symlinks,
  };
  await Deno.writeTextFile(join(staged, RUNTIME_MARKER), JSON.stringify(marker, null, 2) + "\n");
}

/** Download, verify, stage and atomically install the runtime at `plan.dir`. */
async function installRuntime(plan: InstallPlan): Promise<void> {
  const { artifact, pin, opts, dir } = plan;
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
    await downloadVerified(artifact, archive, opts.fetch ?? fetch);
    if (opts.attest) await attest(archive, pin, opts.run ?? defaultRunner);
    const staged = join(tmp, "runtime");
    await stageRuntime(plan, archive, staged);
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
export async function ensureDesktopRuntime(
  options: EnsureDesktopRuntimeOptions,
): Promise<ResolvedDesktopRuntime> {
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const artifact = pinnedArtifact(pin, options.target, options.backend);
  const cacheRoot = options.cacheRoot ?? cacheRootFor();
  const dir = desktopRuntimeDir(cacheRoot, pin, options.target, options.backend);
  const plan: InstallPlan = {
    opts: options,
    pin,
    artifact,
    runtimeLib: pin.targets[options.target].runtimeLib,
    dir,
    log: options.log ?? ((l: string) => console.error(l)),
    // Verified (re-hashed under `verify`) and, when provenance is asked for, attested.
    acceptable: async () => {
      const m = await verifiedRuntime(dir, pin, artifact, options.verify === true);
      return m !== null && (!options.attest || m.attested);
    },
  };
  const resolved = (cached: boolean) => ({
    dir,
    runtimeLib: join(dir, plan.runtimeLib),
    laufeyDir: join(dir, "laufey"),
    cached,
  });
  // Cargo's cache locks: reading a cached tree is Shared; adding a missing one is
  // DownloadExclusive (readers of other versions carry on); replacing an existing (bad) tree is
  // MutateExclusive. Each re-checks after it is granted — the process it waited on may have
  // installed exactly this runtime.
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
        `${options.attest ? " (or has no provenance check)" : ""}; re-downloading.`,
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

/** The `deno --version` of `deno` (e.g. `2.9.7`). */
async function denoCliVersion(deno: string): Promise<string> {
  let out;
  try {
    out = await capture(deno, ["--version"]);
  } catch (err) {
    throw new Error(`denext: could not run \`${deno} --version\`: ${errText(err)}`);
  }
  const m = /^deno (\d+\.\d+\.\d+\S*)/m.exec(out.text);
  if (!m) throw new Error(`denext: could not read the Deno version from \`${deno} --version\``);
  return m[1];
}

/** The message for a `deno` that doesn't match the runtime's Deno version. */
export function denoVersionMismatchMessage(
  found: string,
  pin: DesktopRuntimePin,
  deno = "deno",
): string {
  return `denext: the Deno Desktop runtime ${pin.version} is built for Deno ${pin.deno} exactly, ` +
    `but \`${deno}\` is Deno ${found}.\n` +
    `  Install it with:  deno upgrade --version ${pin.deno}\n` +
    `  Or point DENO_BIN at a Deno ${pin.deno} binary (desktop run / dev build with it).\n` +
    `  Or set ${RUNTIME_ENV}=stock to use the stock runtime (${STOCK_LACKS}).`;
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
  readonly denoVersion?: (deno: string) => Promise<string>;
  readonly log?: (line: string) => void;
  readonly hostOs?: string;
  /**
   * What a `deno` that is not the runtime's exact Deno version does: `fail` (the default, for
   * packaging) or `stock` — build with the stock runtime and warn (`desktop run` / `dev`, where an
   * unpackaged window beats a refusal).
   */
  readonly onDenoMismatch?: "fail" | "stock";
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
      `runtime ships "webview" and "cef". Set ${RUNTIME_ENV}=stock for another backend.`,
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

/** Whether `shim` holds a complete mirror of the runtime archive `sha256`. */
async function crossHostIntact(shim: string, sha256: string): Promise<boolean> {
  let stamp: CrossHostStamp;
  try {
    stamp = JSON.parse(await Deno.readTextFile(join(shim, CROSS_HOST_STAMP)));
  } catch {
    return false;
  }
  if (stamp.sha256 !== sha256 || Object.keys(stamp.files ?? {}).length === 0) return false;
  for (const [rel, size] of Object.entries(stamp.files)) {
    const info = await Deno.lstat(join(shim, ...rel.split("/"))).catch(() => null);
    if (!info?.isFile || info.size !== size) return false;
  }
  return true;
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
      else if (e.isSymlink) await Deno.symlink(await Deno.readLink(src), dest);
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
async function crossHostLaufeyDir(
  rt: ResolvedDesktopRuntime,
  rename: CrossHostRename,
  log: (line: string) => void,
): Promise<string> {
  const marker = await readMarker(rt.dir);
  if (!marker) throw new Error(`denext: the Deno Desktop runtime at ${rt.dir} has no marker`);
  const versionDir = dirname(rt.dir);
  const shim = join(versionDir, `${basename(rt.dir)}.cross-host`);
  const valid = () => crossHostIntact(shim, marker.archive.sha256);
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
 * Resolve the env one `deno desktop` invocation needs to run on denext's pinned runtime (and
 * download / verify it on first use). Honors `DENEXT_DESKTOP_RUNTIME=stock` (no env, a warning),
 * `DENEXT_DESKTOP_RUNTIME_DIR` (a local build, unverified, a warning),
 * `DENEXT_DESKTOP_RUNTIME_VERIFY=1` and `DENEXT_DESKTOP_RUNTIME_ATTEST=1`. Fails when `deno` is
 * not the runtime's exact Deno version (or, with `onDenoMismatch: "stock"`, warns and selects the
 * stock runtime). A target whose backend binary the host's `deno desktop` would look up under
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
  const pin = options.pin ?? DESKTOP_RUNTIME_PIN;
  const target = options.target ?? desktopRuntimeTarget();
  if (runtimeMode(env) === "stock") {
    log(
      `  denext: ${RUNTIME_ENV}=stock — building with the STOCK Deno Desktop runtime (${STOCK_LACKS}).`,
    );
    return { mode: "stock", env: {} };
  }
  const localDir = env(RUNTIME_DIR_ENV);
  if (localDir) {
    const local = await localRuntimeEnv(localDir, runtimeLibFor(pin, target), target);
    log(
      `  denext: using the LOCAL Deno Desktop runtime at ${localDir} (${RUNTIME_DIR_ENV}); it is ` +
        "not downloaded, pinned or verified.",
    );
    return { mode: "local", env: local };
  }
  const deno = options.deno ?? "deno";
  const found = await (options.denoVersion ?? denoCliVersion)(deno);
  if (found !== pin.deno) {
    if (options.onDenoMismatch === "stock") return stockForMismatch(found, pin, deno, log);
    throw new Error(denoVersionMismatchMessage(found, pin, deno));
  }
  const backend = options.backend ?? await projectDesktopBackend(options.projectDir);
  const rt = await ensureDesktopRuntime({
    target,
    backend,
    pin,
    cacheRoot: options.cacheRoot,
    verify: env(DESKTOP_RUNTIME_VERIFY_ENV) === "1",
    attest: env(DESKTOP_RUNTIME_ATTEST_ENV) === "1",
    fetch: options.fetch,
    run: options.run,
    log,
  });
  const rename = crossHostBackendRename(options.hostOs ?? Deno.build.os, target, backend);
  const laufeyDir = rename ? await crossHostLaufeyDir(rt, rename, log) : rt.laufeyDir;
  return { mode: "pinned", env: { DENORT_DESKTOP_BIN: rt.runtimeLib, LAUFEY_DEV_DIR: laufeyDir } };
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
  readonly deno: { readonly found: string | null; readonly required: string };
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
  unpinned: `no pinned build for this host (set ${RUNTIME_ENV}=stock)`,
  "n/a": "",
};

/** The status under an override (`stock` / a local dir), or `null` for the pinned runtime. */
function overrideStatus(
  env: EnvGet,
  base: Pick<DesktopRuntimeStatus, "version" | "target" | "deno">,
): DesktopRuntimeStatus | null {
  const common = { ...base, backend: null, cache: "n/a" as const, ok: true };
  if ((env(RUNTIME_ENV) ?? "").trim().toLowerCase() === "stock") {
    return {
      ...common,
      mode: "stock",
      detail: `${RUNTIME_ENV}=stock — the stock runtime (${STOCK_LACKS})`,
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
  const override = overrideStatus(options.env ?? processEnv, base);
  if (override) return override;
  const found = await (options.denoVersion ?? denoCliVersion)(options.deno ?? "deno")
    .catch(() => null);
  let backend: DesktopRuntimeBackend | null = null;
  let cache: CacheState = "unpinned";
  let problem: string | null = null;
  try {
    backend = options.backend ?? await projectDesktopBackend(options.projectDir);
    cache = await cacheState(options, pin, target, backend);
  } catch (err) {
    problem = errText(err);
  }
  const denoOk = found === pin.deno;
  const denoText = denoOk
    ? `deno ${found} ✓`
    : `deno ${found ?? "not found"} ✗ — needs ${pin.deno}: deno upgrade --version ${pin.deno}`;
  const parts = [
    `runtime ${pin.version} for ${target}/${backend ?? "?"}`,
    CACHE_TEXT[cache],
    denoText,
  ];
  return {
    ...base,
    deno: { found, required: pin.deno },
    mode: "pinned",
    backend,
    cache,
    ok: denoOk && problem === null && (cache === "cached" || cache === "missing"),
    detail: [...parts, ...(problem ? [problem] : [])].join("; "),
  };
}
