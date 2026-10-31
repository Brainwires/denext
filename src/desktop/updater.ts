// A SIGNED self-updater for the `denext/desktop` (Deno Desktop) UI.
//
// The desktop app ships a static SPA export inside a code-signed `.app`/bundle. Modifying a
// file inside that bundle invalidates the signature, so this updater NEVER touches `out/`.
// Instead it maintains a VERIFIED UI OVERLAY in a writable app-support directory that the
// desktop runtime prefers over the bundled export (see `resolveDesktopUiDir`). Replacing the whole
// signed app (the binary included) is the separate full-app path re-exported at the end of this
// module (`app-updater.ts`).
//
// It mirrors the shapes and semantics of the mobile OTA state machine (`src/mobile/ota.ts`),
// but where the native plugin verifies the ECDSA signature on the phone, HERE we verify it in
// Deno/TS with `crypto.subtle` before trusting anything. The manifest, the pinned version
// algorithm and the v2 signature payload are the SAME as mobile: this module imports them
// UNCHANGED from `src/mobile/ota-manifest.ts`.
//
// SECURITY INVARIANTS (audited line by line):
//  1. VERIFY BEFORE SWAP, ALWAYS. Every trust check — manifest-shape, version recomputation,
//     ECDSA signature, monotonic sequence, per-file SHA-256 — runs and passes BEFORE any file
//     is promoted or any pointer is flipped. A failure leaves the active overlay untouched.
//  2. NEVER TRUST `manifest.version`. It is recomputed from the file list with the pinned
//     `otaManifestVersion` and the manifest is refused if the two differ (code `integrity`).
//  3. SIGNATURE REQUIRED. `publicKey` is embedded in the app binary; a manifest without a
//     signature, or one whose signature does not verify, is REFUSED (`unsigned` / `signature`).
//  4. MONOTONIC SEQUENCE. A manifest whose `sequence` is `<=` the highest already accepted (or
//     which has none after a sequenced one was accepted) is refused (`downgrade`). The bundled
//     export's own `sequence` (recorded at launch in `bundle.json`) is the floor before any
//     overlay was accepted, so an older signed UI cannot replace a newer bundled one. A version
//     that fails to boot has its sequence recorded so it is never retried in a loop.
//  5. NO PATH ESCAPE. Every manifest path is checked with `isOtaManifestPath` (no control
//     characters) and split into segments that reject `""`, `.`, `..` and backslashes; the
//     resolved path must stay inside the staging/version directory.
//  3b. THE APP. A manifest's `appId` is trusted only under a valid `appSignature` (payload v5);
//     with `appId` configured (`desktop.app.identifier`) a manifest naming another app, or none,
//     is refused (`app_mismatch`), so a feed for another app sharing the key cannot install here.
//  4b. EXPIRY. A manifest whose signed `expiresAt` has passed is refused (`expired`), as is one
//     without an expiry once the bundled export's own manifest carries one (an expiry-aware
//     app never takes an unexpiring release), so a feed that keeps serving an old release is
//     noticed instead of reported as "no update".
//  6. ATOMIC POINTER SWAP. The "current" pointer is flipped by writing `current.json.tmp` and
//     `Deno.rename`-ing it over `current.json` — a same-directory rename is atomic, so a crash
//     never leaves a half-written pointer. The previous version dir is kept for rollback.
//  7. NOTHING BUT THE MANIFEST. An overlay folder holds exactly its signed manifest's files and the
//     manifest itself: an extra file (a planted `_denext/desktop-preload.js`, a stray `.html` or
//     `.js`) or a symbolic link anywhere in it fails re-verification, so nothing the signature does
//     not cover is ever served or injected.
//  8. VERIFIED WHEN SERVED. The runtime serves overlay files through {@linkcode openDesktopUi}: each
//     file's bytes are checked against the manifest when they are read for a request (hashed the
//     first time, and again whenever the file's stat stamp — inode, size, mtime, ctime — moves), so
//     a file changed after launch is never served. A failed check takes the overlay out of service
//     (rolled back and reported as `rejected`) and the bundled export is served from then on.

import { dirname, join, resolve, SEPARATOR } from "@std/path";
import {
  isOtaManifest,
  isOtaManifestExpired,
  isOtaManifestPath,
  OTA_MANIFEST_PATH,
  OTA_PLATFORM_HEADER,
  otaAppMismatch,
  otaAppSignaturePayload,
  type OtaManifest,
  otaManifestVersion,
  otaPlatformMismatch,
  otaSignaturePayload,
  sha256Hex,
} from "../mobile/ota-manifest.ts";
import { parseOtaPublicKey } from "../build/ota-signing.ts";
import { env, osDataDir } from "./app-dirs.ts";
import { reserveRuntimeDir } from "./path-scope.ts";

/** The signed manifest format the feed serves, shared with mobile OTA (`denext/mobile`). */
export type { OtaManifest, OtaManifestFile } from "../mobile/ota-manifest.ts";

/** ECDSA P-256 / SHA-256 — the same primitive the manifest is signed with. */
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const VERIFY_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/** The default timeout for the manifest and each file download, in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The default `appId` when a config gives none: the app-support subdirectory name. */
const DEFAULT_APP_ID = "denext-desktop";

/**
 * The `code` on a {@linkcode DesktopUpdateError}:
 *
 * - `network`: the manifest or a file could not be fetched (HTTP error, timeout, transport, or
 *   invalid JSON);
 * - `invalid`: the manifest is malformed (fails {@linkcode isOtaManifest}), or a path is unsafe;
 * - `integrity`: the recomputed version does not match `manifest.version`, or a staged file's
 *   SHA-256 does not match its manifest entry;
 * - `unsigned`: the manifest carries no `signature` (a `publicKey` is always configured);
 * - `signature`: the `signature` does not verify against the configured `publicKey`;
 * - `downgrade`: `manifest.sequence` is `<=` the highest accepted or the bundled export's own
 *   (recorded by {@linkcode resolveDesktopUiDir}), or absent once there is such a floor;
 * - `platform_mismatch`: the manifest names another target (`denext export --platform`) than this
 *   app's OS (`macos`, `windows`, `linux`; {@linkcode DesktopUpdaterConfig.platform}), its
 *   `platform` disagrees with the export's stamp file, or that stamp (which the version covers,
 *   unlike the unsigned field) names another target, with or without the field;
 * - `app_mismatch`: {@linkcode DesktopUpdaterConfig.appId} is set (`runDesktop` sets it to
 *   `desktop.app.identifier`) and the manifest names another app, or none (re-sign it: `denext ota
 *   manifest --app-id <id> --sign`);
 * - `expired`: the manifest's signed `expiresAt` has passed, or it carries none while the bundled
 *   export's manifest does (re-sign it: `denext ota manifest --sign`);
 * - `not_staged`: {@linkcode applyDesktopUpdate} named a version that is not staged;
 * - `rejected`: the version was rolled back after failing to boot; refused until
 *   {@linkcode desktopUpdateReset}.
 */
export type DesktopUpdateErrorCode =
  | "network"
  | "invalid"
  | "integrity"
  | "unsigned"
  | "signature"
  | "downgrade"
  | "platform_mismatch"
  | "app_mismatch"
  | "expired"
  | "not_staged"
  | "rejected";

/** A refusal from the updater, carrying a machine-readable {@linkcode DesktopUpdateErrorCode}. */
export class DesktopUpdateError extends Error {
  /** Always `"DesktopUpdateError"`. */
  override readonly name = "DesktopUpdateError";
  /**
   * Create a refusal.
   *
   * @param code The machine-readable reason, one of {@linkcode DesktopUpdateErrorCode}.
   * @param message A human-readable description.
   */
  constructor(readonly code: DesktopUpdateErrorCode, message: string) {
    super(message);
  }
}

/** Configuration for the desktop UI self-updater. */
export interface DesktopUpdaterConfig {
  /**
   * The web root the signed UI export is served from, e.g. `"https://updates.example.com/ui"`.
   * The manifest is fetched from `${feedUrl}/_denext/ota.json` and each file from
   * `${feedUrl}/<path>`. A trailing slash is ignored.
   */
  readonly feedUrl: string;
  /**
   * The release public key embedded in the app binary: base64 SPKI or a `-----BEGIN PUBLIC
   * KEY-----` PEM (an ECDSA P-256 key). Every manifest MUST carry a `signature` that verifies
   * against it, or it is refused.
   */
  readonly publicKey: string;
  /**
   * Where the verified overlay is kept. Default: an OS app-support path derived from
   * {@linkcode DesktopUpdaterConfig.appId} — macOS `~/Library/Application Support/<appId>/
   * ui-updates`, Linux `$XDG_DATA_HOME|~/.local/share/<appId>/ui-updates`, Windows
   * `%APPDATA%\<appId>\ui-updates`.
   */
  readonly dataDir?: string;
  /**
   * The app identifier (`desktop.app.identifier`, which `runDesktop` passes): it names the default
   * {@linkcode DesktopUpdaterConfig.dataDir} (default `"denext-desktop"` when unset), and when set
   * a manifest must name this app in its signed `appId` (`denext ota manifest --app-id`; a signed
   * desktop `spa.ota` export stamps it), or it is refused (code `app_mismatch`).
   */
  readonly appId?: string;
  /** The manifest / file request timeout in ms. Default 30 000. */
  readonly timeoutMs?: number;
  /**
   * This app's target, which a manifest naming another one is refused against (code
   * `platform_mismatch`) and which is sent as the `x-denext-ota-platform` header (a
   * `createOtaHandler({ platforms })` feed serves each target its own export). Default: the OS
   * the app runs on (`macos`, `windows`, `linux`).
   */
  readonly platform?: "macos" | "windows" | "linux";
}

/** The atomic "current" pointer (`current.json`) naming the active overlay version. */
interface Pointer {
  /** The active overlay version. */
  readonly version: string;
  /** Its `sequence`, or `null` when the manifest carried none. */
  readonly sequence: number | null;
  /** `true` while on its trial launch (not yet confirmed by {@linkcode desktopBooted}). */
  readonly pending: boolean;
  /** Where to roll back to if the trial fails; `version: null` means the bundled export. */
  readonly previous: { readonly version: string | null; readonly sequence: number | null } | null;
}

/** Cross-cutting state (`state.json`): the highest accepted sequence and the rejected version. */
interface UpdaterState {
  /** The highest `sequence` ever accepted; a lower (or absent) one is refused (`downgrade`). */
  readonly highestSequence: number | null;
  /** The last version rolled back after a failed boot; refused until {@linkcode desktopUpdateReset}. */
  readonly rejected: string | null;
}

/** The marker (`booting.json`) written when a pending version is first served, for the watchdog. */
interface BootMarker {
  readonly version: string;
}

/** The result of {@linkcode checkForDesktopUpdate}. */
export interface DesktopUpdateCheck {
  /** Whether a newer, fully-verified update is available. */
  readonly available: boolean;
  /** The offered version (present when `available`). */
  readonly version?: string;
  /** The verified manifest (present when `available`). */
  readonly manifest?: OtaManifest;
  /** The manifest's `required` flag (present when `available`). */
  readonly required?: boolean;
  /** The manifest's release notes, if any (present when `available`). */
  readonly notes?: string;
}

/** The result of {@linkcode prepareDesktopUpdate}. */
export interface DesktopUpdatePrepared {
  /** The staged version, to pass to {@linkcode applyDesktopUpdate}. */
  readonly version: string;
  /** Whether the app should not let the user decline this update. */
  readonly required: boolean;
  /** The release notes, or `null`. */
  readonly notes: string | null;
}

/** A snapshot of the overlay state, mirroring `OtaStatus` on mobile. */
export interface DesktopUpdateStatus {
  /** The confirmed active version, or `null` while the bundled export runs. */
  readonly current: string | null;
  /** A version on its trial launch (not yet confirmed), or `null`. */
  readonly pending: string | null;
  /** A version prepared and waiting for {@linkcode applyDesktopUpdate}, or `null`. */
  readonly staged: string | null;
  /** The last version rolled back after a failed boot, or `null`. */
  readonly rejected: string | null;
  /** The highest `sequence` accepted so far, or `null`. */
  readonly highestSequence: number | null;
}

// ---------------------------------------------------------------------------------------------
// Paths and small helpers.

/** A thrown value's message. */
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The default OS app-support data dir for `appId`: the shared per-OS data root ({@link osDataDir})
 * plus `ui-updates`. Unchanged from when the per-OS logic lived here (byte-identical) — it now
 * delegates so the app-support layout has one source; `tests/desktop-app-dirs.test.ts` pins the
 * resolved directory for each OS.
 */
function defaultDataDir(appId: string): string {
  return join(osDataDir(appId), "ui-updates");
}

/** The resolved data dir for `config`. */
function dataDirOf(config: DesktopUpdaterConfig): string {
  return config.dataDir ?? defaultDataDir(config.appId ?? DEFAULT_APP_ID);
}

const CURRENT_FILE = "current.json";
const STATE_FILE = "state.json";
const BOOTING_FILE = "booting.json";
const VERSIONS_DIR = "versions";
const STAGING_PREFIX = "staging-";
const BUNDLE_FILE = "bundle.json";

const pointerPath = (dir: string) => join(dir, CURRENT_FILE);
const statePath = (dir: string) => join(dir, STATE_FILE);
const bootingPath = (dir: string) => join(dir, BOOTING_FILE);
const bundlePath = (dir: string) => join(dir, BUNDLE_FILE);
const versionDir = (dir: string, version: string) => join(dir, VERSIONS_DIR, version);
const stagingDir = (dir: string, version: string) => join(dir, `${STAGING_PREFIX}${version}`);

/** Write `value` as JSON atomically: to `<path>.tmp`, then `Deno.rename` over `<path>`. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(value));
  await Deno.rename(tmp, path); // atomic same-directory swap
}

/** Parse a JSON file with a shape guard; undefined when missing, unreadable or malformed. */
async function readJson<T>(path: string, guard: (v: unknown) => v is T): Promise<T | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    return guard(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPointer(v: unknown): v is Pointer {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const prevOk = p.previous === null ||
    (typeof p.previous === "object" && p.previous !== null);
  return typeof p.version === "string" && typeof p.pending === "boolean" &&
    (p.sequence === null || typeof p.sequence === "number") && prevOk;
}

function isState(v: unknown): v is UpdaterState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (s.highestSequence === null || typeof s.highestSequence === "number") &&
    (s.rejected === null || typeof s.rejected === "string");
}

function isBootMarker(v: unknown): v is BootMarker {
  return typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).version === "string";
}

const readPointer = (dir: string) => readJson(pointerPath(dir), isPointer);
const readBooting = (dir: string) => readJson(bootingPath(dir), isBootMarker);

async function readState(dir: string): Promise<UpdaterState> {
  return (await readJson(statePath(dir), isState)) ?? { highestSequence: null, rejected: null };
}

async function removeFile(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {});
}

async function removeDir(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// The served overlay: re-verified at launch, and every file verified again when it is served.

/** A file's expected bytes: its manifest entry (or, for the manifest itself, what launch read). */
interface ExpectedFile {
  readonly sha256: string;
  readonly size: number;
}

/**
 * A file's stat stamp: what changes whenever its bytes can have changed. `ctime` is set by the
 * kernel on every write, rename and `utimes` (no user call sets it back), and `ino` changes when the
 * file is replaced. `null` when the platform lacks either (the file is then hashed every time).
 */
function statStamp(info: Deno.FileInfo): string | null {
  if (info.ino === null || info.ctime === null) return null;
  return `${info.dev}:${info.ino}:${info.size}:${
    info.mtime?.getTime() ?? ""
  }:${info.ctime.getTime()}`;
}

/**
 * How old a file's `ctime` must be (ms) before its stamp may stand in for a hash: a write landing in
 * the same clock tick as the verifying read could otherwise leave the stamp unchanged (git's "racy
 * clean" rule). A younger file is hashed on every read until it ages.
 */
const STAMP_SETTLE_MS = 2_000;

/** One read of a file: its bytes and, when the file held still during the read, its stamp. */
type StampedRead =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly stamp: string | null }
  | { readonly ok: false; readonly tampered: boolean; readonly reason: string };

/**
 * Read `path` whole, with the stat stamp of the open handle before and after the read. A file that
 * is gone, or is not a regular file, is `tampered`; any other error (a permission, an I/O error) is
 * not, so it is refused for now without taking the overlay out of service.
 */
async function readStamped(path: string, rel: string): Promise<StampedRead> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (err) {
    return err instanceof Deno.errors.NotFound
      ? { ok: false, tampered: true, reason: `${rel} is missing` }
      : { ok: false, tampered: false, reason: `${rel} cannot be read: ${msg(err)}` };
  }
  try {
    const before = await file.stat();
    if (!before.isFile) return { ok: false, tampered: true, reason: `${rel} is not a file` };
    const bytes = await readUpTo(file, before.size);
    const after = await file.stat();
    return { ok: true, bytes, stamp: heldStamp(before, after, bytes.length) };
  } catch (err) {
    return { ok: false, tampered: false, reason: `${rel} cannot be read: ${msg(err)}` };
  } finally {
    file.close();
  }
}

/** Up to `size` bytes of `file`, from where it stands (fewer when it ends first). */
async function readUpTo(file: Deno.FsFile, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let read = 0;
  while (read < size) {
    const n = await file.read(bytes.subarray(read));
    if (n === null) break;
    read += n;
  }
  return bytes.subarray(0, read);
}

/**
 * The stamp a read may be remembered by: the file's, when it held still through the read (the
 * same stamp before and after, every byte read) and has settled ({@link STAMP_SETTLE_MS}); else
 * `null`.
 */
function heldStamp(before: Deno.FileInfo, after: Deno.FileInfo, read: number): string | null {
  const stamp = statStamp(before);
  if (stamp === null || read !== before.size || stamp !== statStamp(after)) return null;
  return Date.now() - before.ctime!.getTime() >= STAMP_SETTLE_MS ? stamp : null;
}

/** Whether `read` holds `expected`'s bytes: by its stamp when that is the one verified, else hashed. */
async function holdsExpected(
  read: { bytes: Uint8Array; stamp: string | null },
  expected: ExpectedFile,
  verifiedStamp: string | undefined,
): Promise<boolean> {
  if (read.stamp !== null && read.stamp === verifiedStamp) return true;
  return read.bytes.length === expected.size && await sha256Hex(read.bytes) === expected.sha256;
}

/**
 * The first entry under `root` that the signed manifest does not cover — a symbolic link anywhere,
 * a file it does not list (`allowed`), or anything but a file or a directory — or `null`.
 */
async function strayEntry(
  root: string,
  allowed: ReadonlySet<string>,
  prefix = "",
): Promise<string | null> {
  for await (const entry of Deno.readDir(prefix ? join(root, ...prefix.split("/")) : root)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymlink) return `${rel} is a symbolic link`;
    if (entry.isDirectory) {
      const inner = await strayEntry(root, allowed, rel);
      if (inner) return inner;
    } else if (!entry.isFile || !allowed.has(rel)) {
      return `${rel} is not in the signed manifest`;
    }
  }
  return null;
}

/** What reading one file of the served overlay gives ({@linkcode DesktopUiOverlay.read}). */
export type DesktopUiRead =
  /** The file's bytes, which match the signed manifest. */
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  /** Not a file of this UI (or it cannot be read right now): answer as for a missing file. */
  | { readonly status: "missing" }
  /** The overlay is out of service (it was changed after it was verified): serve the bundled export. */
  | { readonly status: "withdrawn" };

/** The verified UI overlay a launch serves (see {@linkcode openDesktopUi}). */
export interface DesktopUiOverlay {
  /** The overlay's version (its manifest version). */
  readonly version: string;
  /** The overlay's directory, `<dataDir>/versions/<version>`. */
  readonly dir: string;
  /**
   * Whether the overlay was taken out of service during this session: a file failed its check when
   * it was served. Everything is then served from the bundled export.
   */
  readonly withdrawn: boolean;
  /**
   * Read one file of the overlay for serving, verified against the signed manifest: hashed the
   * first time, and again whenever its stat stamp changes. A file the manifest does not list, or
   * one whose bytes no longer match, takes the overlay out of service (`withdrawn`): it is rolled
   * back like a version that failed to boot (`rejected` in {@linkcode desktopUpdateStatus}) and the
   * bundled export is served from then on.
   *
   * @param path The file's path inside the UI, `/`-separated and without a leading slash
   *   (`index.html`, `_denext/client/app.js`).
   * @returns The verified bytes, `missing`, or `withdrawn`.
   */
  read(path: string): Promise<DesktopUiRead>;
}

/** The UI a launch serves: the verified overlay, or the bundled export alone. */
export interface DesktopUi {
  /** The bundled export (the app's own UI). */
  readonly bundledDir: string;
  /** The active overlay, verified at launch, or `null` to serve the bundled export. */
  readonly overlay: DesktopUiOverlay | null;
}

/** Report an overlay taken out of service (the runtime's log; `rejected` in the status). */
function reportWithdrawn(version: string, reason: string): void {
  console.error(
    `desktop: the UI update ${version.slice(0, 12)}… no longer matches its signed manifest ` +
      `(${reason}); it was rolled back and is refused until desktopUpdateReset.`,
  );
}

/** The overlay {@linkcode openDesktopUi} hands the runtime: the files verified at launch. */
class VerifiedOverlay implements DesktopUiOverlay {
  #withdrawal: Promise<void> | undefined;
  readonly #stamps = new Map<string, string>();

  constructor(
    readonly version: string,
    readonly dir: string,
    private readonly dataDir: string,
    private readonly files: ReadonlyMap<string, ExpectedFile>,
  ) {}

  get withdrawn(): boolean {
    return this.#withdrawal !== undefined;
  }

  /** Record `path`'s stamp once its bytes matched (a `null` stamp is never trusted). */
  remember(path: string, stamp: string | null): void {
    if (stamp === null) this.#stamps.delete(path);
    else this.#stamps.set(path, stamp);
  }

  /** Read `path` and check it against `expected`: its verified bytes, or why it fails. */
  async check(path: string, expected: ExpectedFile): Promise<StampedRead> {
    const target = safeJoin(this.dir, path);
    if (!target) return { ok: false, tampered: true, reason: `unsafe path ${path}` };
    const read = await readStamped(target, path);
    if (!read.ok) return read;
    if (!(await holdsExpected(read, expected, this.#stamps.get(path)))) {
      this.#stamps.delete(path);
      return { ok: false, tampered: true, reason: `${path} does not match the signed manifest` };
    }
    this.remember(path, read.stamp);
    return read;
  }

  async read(path: string): Promise<DesktopUiRead> {
    if (this.#withdrawal) return { status: "withdrawn" };
    if (safeSegments(path) === null) return { status: "missing" };
    const expected = this.files.get(path);
    if (!expected) {
      // Only a file counts as planted: a directory of the UI is not, and is not served anyway.
      const target = safeJoin(this.dir, path)!;
      const info = await Deno.lstat(target).catch(() => null);
      if (info === null || info.isDirectory) return { status: "missing" };
      return await this.withdraw(`${path} is not in the signed manifest`);
    }
    const result = await this.check(path, expected);
    if (result.ok) return { status: "ok", bytes: result.bytes };
    return result.tampered ? await this.withdraw(result.reason) : { status: "missing" };
  }

  /** Take the overlay out of service: roll it back (once) and serve the bundle from now on. */
  async withdraw(reason: string): Promise<DesktopUiRead> {
    this.#withdrawal ??= (async () => {
      reportWithdrawn(this.version, reason);
      const pointer = await readPointer(this.dataDir);
      if (pointer?.version === this.version) await rollback(this.dataDir, pointer);
    })().catch(() => {});
    await this.#withdrawal;
    return { status: "withdrawn" };
  }
}

/** The outcome of re-verifying an overlay at launch. */
type LaunchCheck =
  | { readonly ok: true; readonly overlay: VerifiedOverlay }
  | { readonly ok: false; readonly tampered: boolean; readonly reason: string };

/**
 * The files of an overlay's stored manifest (`bytes`), once it parses, names `version`, verifies
 * (integrity + signature, re-checked every launch) and lists only safe paths including the
 * `index.html` shell; else why not.
 */
async function storedManifestFiles(
  bytes: Uint8Array,
  version: string,
  publicKey: string,
): Promise<Map<string, ExpectedFile> | string> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "its manifest is not JSON";
  }
  if (!isOtaManifest(manifest) || manifest.version !== version) {
    return "its manifest is not this version's";
  }
  try {
    await assertVerified(manifest, publicKey);
  } catch (err) {
    return msg(err);
  }
  if (manifest.files.some((f) => safeSegments(f.path) === null || f.path === OTA_MANIFEST_PATH)) {
    return "its manifest names an unsafe path";
  }
  // The runtime serves index.html as the shell; require it to be a file the manifest signs.
  if (!manifest.files.some((f) => f.path === "index.html")) {
    return "its manifest lists no index.html";
  }
  return new Map(manifest.files.map((f) => [f.path, { sha256: f.sha256, size: f.size }]));
}

/**
 * RE-VERIFY an active overlay at LAUNCH. The applied overlay keeps its signed manifest at
 * `versions/<version>/<OTA_MANIFEST_PATH>`, so this recomputes the signature + integrity and every
 * file's SHA-256 FROM DISK — invariant 1 again, on EVERY boot, not only at apply — and refuses a
 * folder holding anything else (invariant 7). So an overlay tampered with after it was applied —
 * a page or a bug that wrote into the overlay directory despite the reserved-path guard, or another
 * program running as the user — is NEVER served: it cannot persist an injected script across
 * relaunches or outlive a signed update. The cost is one hash per overlay file at startup (a UI
 * export is small). `tampered: false` is a read error (a permission, I/O): refused for this launch
 * without rolling anything back.
 */
async function verifyOverlay(
  dir: string,
  version: string,
  publicKey: string,
): Promise<LaunchCheck> {
  const vdir = versionDir(dir, version);
  const tampered = (reason: string): LaunchCheck => ({ ok: false, tampered: true, reason });
  const root = await Deno.lstat(vdir).catch(() => null);
  if (root === null || root.isSymlink || !root.isDirectory) {
    return tampered("the overlay is missing");
  }
  const stored = await readStamped(join(vdir, ...OTA_MANIFEST_PATH.split("/")), OTA_MANIFEST_PATH);
  if (!stored.ok) return stored;
  const checked = await storedManifestFiles(stored.bytes, version, publicKey);
  if (typeof checked === "string") return tampered(checked);
  const files = checked;
  const stray = await strayEntry(vdir, new Set([...files.keys(), OTA_MANIFEST_PATH])).catch((
    err,
  ) => `the overlay cannot be listed: ${msg(err)}`);
  if (stray) return tampered(stray);
  const overlay = new VerifiedOverlay(
    version,
    vdir,
    dir,
    new Map([
      ...files,
      [OTA_MANIFEST_PATH, {
        sha256: await sha256Hex(stored.bytes),
        size: stored.bytes.length,
      }],
    ]),
  );
  overlay.remember(OTA_MANIFEST_PATH, stored.stamp);
  for (const [path, expected] of files) {
    const result = await overlay.check(path, expected);
    if (!result.ok) return result;
  }
  return { ok: true, overlay };
}

/**
 * Serve `pointer`'s overlay, re-verified: an overlay that fails re-verification is rolled back
 * (refused as `rejected`, its folder deleted) and the version it rolls back to is checked the same
 * way, down to the bundled export (`null`). A read error refuses it for this launch only.
 */
async function openOverlay(
  dir: string,
  pointer: Pointer | undefined,
  publicKey: string,
): Promise<VerifiedOverlay | null> {
  // Each rollback moves the pointer back (to the previous version, then to none): two at most.
  let current = pointer;
  for (let step = 0; current && step < 3; step++, current = await readPointer(dir)) {
    const checked = await verifyOverlay(dir, current.version, publicKey);
    if (checked.ok) return checked.overlay;
    if (!checked.tampered) return null;
    reportWithdrawn(current.version, checked.reason);
    await rollback(dir, current);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Path safety. `safeSegments` is deliberately a small self-contained copy of the one in
// `server/ota-handler.ts` (18 identical lines): the updater is a security-critical module and
// stays free of a src/desktop → src/server dependency for a trivial path-safety primitive; the
// canonical home for a shared version would be `mobile/ota-manifest.ts`, which is owned elsewhere.

/** Path segments that stay inside a directory: non-empty, no `.`/`..`, no control chars/backslash. */
// fallow-ignore-next-line code-duplication -- intentional self-contained mirror (see note above)
function safeSegments(path: string): string[] | null {
  if (!isOtaManifestPath(path) || path.includes("\\")) return null;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? segments : null;
}

/** The absolute destination for `relPath` under `root`, or null if it is unsafe or escapes. */
function safeJoin(root: string, relPath: string): string | null {
  const segments = safeSegments(relPath);
  if (!segments) return null;
  const rootAbs = resolve(root);
  const dest = resolve(root, ...segments);
  // Defence in depth: with no `..` segments this always holds, but reject any escape.
  if (dest !== rootAbs && !dest.startsWith(rootAbs + SEPARATOR)) return null;
  return dest;
}

// ---------------------------------------------------------------------------------------------
// Signature verification (in TS — the native plugin's job on mobile).

/** One imported verify key per distinct configured public key. */
const verifyKeys = new Map<string, Promise<CryptoKey>>();

/** The bytes of standard (padded) base64 `text`; throws on anything else. */
function base64ToBytes(text: string): Uint8Array {
  const clean = text.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw new Error("not base64");
  }
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
}

/**
 * Import the configured public key for verification. `parseOtaPublicKey` normalises base64 SPKI
 * or a PEM block to one-line base64 SPKI (decoding PEM→DER) and asserts it is a P-256 key; the
 * DER is then imported with `crypto.subtle.importKey("spki", …, ECDSA P-256, ["verify"])`.
 */
function importVerifyKey(publicKey: string): Promise<CryptoKey> {
  let cached = verifyKeys.get(publicKey);
  if (!cached) {
    cached = (async () => {
      const spkiBase64 = await parseOtaPublicKey(publicKey); // PEM→DER + P-256 check
      const der = base64ToBytes(spkiBase64);
      return await crypto.subtle.importKey("spki", der as BufferSource, KEY_ALGORITHM, false, [
        "verify",
      ]);
    })();
    verifyKeys.set(publicKey, cached);
  }
  return cached;
}

/**
 * Recompute the version, then verify the ECDSA signature. Throws a {@linkcode DesktopUpdateError}
 * with the precise code on any failure. This is the trust gate every path runs before it acts.
 */
async function assertVerified(manifest: OtaManifest, publicKey: string): Promise<void> {
  // Invariant 2: never trust `manifest.version` — recompute it from the file list.
  if (await otaManifestVersion(manifest.files) !== manifest.version) {
    throw new DesktopUpdateError("integrity", "the manifest version does not match its files");
  }
  // Invariant 3: a signature is mandatory (a publicKey is always configured).
  if (typeof manifest.signature !== "string") {
    throw new DesktopUpdateError("unsigned", "the manifest carries no signature");
  }
  let key: CryptoKey;
  try {
    key = await importVerifyKey(publicKey);
  } catch (err) {
    throw new DesktopUpdateError("signature", `the public key is invalid: ${msg(err)}`);
  }
  // `otaSignaturePayload`: v1–v4, whatever the manifest says about its app.
  if (!await verifies(key, manifest.signature, () => otaSignaturePayload(manifest))) {
    throw new DesktopUpdateError("signature", "the manifest signature does not verify");
  }
  // Invariant 3b: an `appId` counts only under its own signature (payload v5).
  if (
    manifest.appId !== undefined &&
    !await verifies(key, manifest.appSignature, () => otaAppSignaturePayload(manifest))
  ) {
    throw new DesktopUpdateError("signature", "the manifest's appSignature is missing or invalid");
  }
}

/**
 * Whether `signature` (standard base64 of the raw 64-byte r‖s) is `key`'s signature over the
 * payload `payload()` builds; false for a missing or malformed signature, or a payload that does
 * not build (e.g. an absurd sequence).
 */
async function verifies(
  key: CryptoKey,
  signature: string | undefined,
  payload: () => Promise<Uint8Array>,
): Promise<boolean> {
  if (typeof signature !== "string") return false;
  try {
    return await crypto.subtle.verify(
      VERIFY_ALGORITHM,
      key,
      base64ToBytes(signature) as BufferSource,
      await payload() as BufferSource,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Proxy-tolerant fetch (#4812: TLS-inspecting proxies stalled Electron's updater).

/** A proxy variable in its upper- or lower-case spelling (the `curl` convention; only proxies want both). */
function proxyEnv(name: string): string | undefined {
  return env(name) ?? env(name.toLowerCase());
}

/** The proxy URL to use for `target`, honouring `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. */
function proxyUrlFor(target: URL): string | undefined {
  const noProxy = proxyEnv("NO_PROXY");
  if (noProxy) {
    const host = target.hostname;
    for (const raw of noProxy.split(",")) {
      const entry = raw.trim().replace(/^\./, "");
      if (!entry) continue;
      if (entry === "*" || host === entry || host.endsWith(`.${entry}`)) return undefined;
    }
  }
  const proxy = proxyEnv(target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY");
  return proxy && proxy.trim() ? proxy.trim() : undefined;
}

/**
 * Fetch `url` with the configured headers, a timeout, and — behind a TLS-inspecting proxy — a
 * `Deno.createHttpClient({ proxy })`. The body is fully consumed by `consume` before the client
 * is closed (closing it mid-stream would break the read). A clear {@linkcode DesktopUpdateError}
 * (`network`) is thrown rather than hanging forever.
 */
async function fetchWith<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const proxy = proxyUrlFor(new URL(url));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let client: Deno.HttpClient | undefined;
  try {
    if (proxy && typeof Deno.createHttpClient === "function") {
      client = Deno.createHttpClient({ proxy: { url: proxy } });
    }
    const init: RequestInit = { headers, cache: "no-store", signal: controller.signal };
    if (client) (init as { client?: unknown }).client = client;
    const response = await fetch(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new DesktopUpdateError("network", `HTTP ${response.status} for ${url}`);
    }
    return await consume(response);
  } catch (err) {
    if (err instanceof DesktopUpdateError) throw err;
    throw new DesktopUpdateError(
      "network",
      controller.signal.aborted
        ? `request timed out after ${timeoutMs} ms`
        : `request failed: ${msg(err)}`,
    );
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}

/** This app's target: `config.platform`, else the OS it runs on. */
function desktopTarget(config: DesktopUpdaterConfig): string {
  if (config.platform) return config.platform;
  return Deno.build.os === "darwin" ? "macos" : Deno.build.os === "windows" ? "windows" : "linux";
}

/** The headers of every feed request: the app's target, for a per-target feed. */
function feedHeaders(config: DesktopUpdaterConfig): Record<string, string> {
  return { [OTA_PLATFORM_HEADER]: desktopTarget(config) };
}

/** Refuse a manifest built for another target (`platform_mismatch`). */
async function assertPlatform(manifest: OtaManifest, config: DesktopUpdaterConfig): Promise<void> {
  const mismatch = await otaPlatformMismatch(manifest, desktopTarget(config));
  if (mismatch !== null) throw new DesktopUpdateError("platform_mismatch", mismatch);
}

/**
 * Refuse a manifest for another app, or (with {@linkcode DesktopUpdaterConfig.appId} set) one that
 * names none (`app_mismatch`). Its `appId` is already verified ({@linkcode assertVerified}).
 */
function assertApp(manifest: OtaManifest, config: DesktopUpdaterConfig): void {
  const mismatch = otaAppMismatch(manifest, config.appId, true);
  if (mismatch !== null) throw new DesktopUpdateError("app_mismatch", mismatch);
}

/** Fetch and validate `${feedUrl}/_denext/ota.json`. */
async function fetchManifest(config: DesktopUpdaterConfig): Promise<OtaManifest> {
  const base = config.feedUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${base}/${OTA_MANIFEST_PATH}`;
  const body = await fetchWith(url, feedHeaders(config), timeoutMs, async (r) => {
    try {
      return await r.json() as unknown;
    } catch {
      throw new DesktopUpdateError("network", "the manifest is not valid JSON");
    }
  });
  if (!isOtaManifest(body)) throw new DesktopUpdateError("invalid", "the manifest is malformed");
  return body;
}

/** Fetch the raw bytes of `${feedUrl}/<relPath>`. */
function fetchFile(
  config: DesktopUpdaterConfig,
  relPath: string,
): Promise<Uint8Array> {
  const base = config.feedUrl.replace(/\/+$/, "");
  const segments = safeSegments(relPath) ?? [relPath];
  const url = `${base}/${segments.map(encodeURIComponent).join("/")}`;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return fetchWith(
    url,
    feedHeaders(config),
    timeoutMs,
    async (r) => new Uint8Array(await r.arrayBuffer()),
  );
}

// ---------------------------------------------------------------------------------------------
// The downgrade gate (invariant 4).

/**
 * Refuse a manifest whose `sequence` is not strictly greater than the highest accepted (or which
 * has none after a sequenced manifest was accepted). Called after the version-equality check, so
 * re-offering the running version is reported as "not available", not as a downgrade.
 */
/**
 * The highest accepted sequence, raised to the bundled export's own: an overlay older than the UI
 * the app ships with is a downgrade even before any overlay was accepted. `null`: no floor yet.
 */
function downgradeFloor(state: UpdaterState, bundle: BundleRecord | undefined): number | null {
  const known = [state.highestSequence, bundle?.sequence ?? null].filter((n) => n !== null);
  return known.length === 0 ? null : Math.max(...known);
}

/**
 * Refuse a manifest whose `expiresAt` has passed, or which has none while the bundled export's
 * manifest carries one (invariant 4b).
 */
function assertFresh(manifest: OtaManifest, bundle: BundleRecord | undefined): void {
  if (isOtaManifestExpired(manifest)) {
    const at = new Date(manifest.expiresAt! * 1000).toISOString();
    throw new DesktopUpdateError("expired", `the manifest expired at ${at}`);
  }
  if (manifest.expiresAt === undefined && bundle?.expiring === true) {
    throw new DesktopUpdateError(
      "expired",
      "the manifest carries no expiry, but the bundled export's does",
    );
  }
}

function assertNotDowngrade(
  manifest: OtaManifest,
  state: UpdaterState,
  bundle: BundleRecord | undefined,
): void {
  const highest = downgradeFloor(state, bundle);
  if (highest === null) return; // nothing accepted yet: any sequence (or none) is allowed
  if (manifest.sequence === undefined || manifest.sequence <= highest) {
    throw new DesktopUpdateError(
      "downgrade",
      `sequence ${manifest.sequence ?? "(none)"} is not newer than the accepted ${highest}`,
    );
  }
}

/**
 * Fetch the feed's manifest and run the trust gate every path shares: integrity and signature
 * (invariants 2–3), the target, the app (3b), and freshness (invariant 4b). With the data dir and the bundle
 * record it read.
 */
async function fetchTrustedManifest(config: DesktopUpdaterConfig): Promise<{
  dir: string;
  manifest: OtaManifest;
  bundle: BundleRecord | undefined;
}> {
  const dir = dataDirOf(config);
  const manifest = await fetchManifest(config);
  await assertVerified(manifest, config.publicKey);
  await assertPlatform(manifest, config);
  assertApp(manifest, config);
  const bundle = await readBundleRecord(dir);
  assertFresh(manifest, bundle);
  return { dir, manifest, bundle };
}

// ---------------------------------------------------------------------------------------------
// Public API.

/**
 * Check the feed for a newer, fully-verified UI. Fetches `${feedUrl}/_denext/ota.json`,
 * validates its shape, RECOMPUTES the version and refuses a mismatch, VERIFIES the ECDSA
 * signature, and refuses a non-monotonic `sequence` — all BEFORE reporting anything as available.
 * A version equal to the active overlay resolves `{ available: false }`.
 *
 * @throws {@linkcode DesktopUpdateError} on any network, shape, integrity, signature or
 *   downgrade failure.
 */
export async function checkForDesktopUpdate(
  config: DesktopUpdaterConfig,
): Promise<DesktopUpdateCheck> {
  // Integrity + signature (verify-before-trust), the target, the app and freshness: before "not
  // available", so a stale feed is an error.
  const { dir, manifest, bundle } = await fetchTrustedManifest(config);

  const pointer = await readPointer(dir);
  if (pointer && pointer.version === manifest.version) return { available: false };
  // The bundled export itself, with no overlay active: nothing newer.
  if (!pointer && bundle?.bundle === `ota:${manifest.version}`) return { available: false };

  assertNotDowngrade(manifest, await readState(dir), bundle);
  return {
    available: true,
    version: manifest.version,
    manifest,
    required: manifest.required === true,
    ...(typeof manifest.notes === "string" ? { notes: manifest.notes } : {}),
  };
}

/** The active overlay's path→sha256 map (for reuse), from its own `_denext/ota.json`. */
async function currentOverlayHashes(dir: string): Promise<Map<string, string>> {
  const pointer = await readPointer(dir);
  if (!pointer) return new Map();
  const manifest = await readJson(
    join(versionDir(dir, pointer.version), OTA_MANIFEST_PATH),
    isOtaManifest,
  );
  const map = new Map<string, string>();
  for (const f of manifest?.files ?? []) map.set(f.path, f.sha256);
  return map;
}

/**
 * Download and verify a newer UI into a STAGING directory WITHOUT switching to it. Files whose
 * SHA-256 already matches the active overlay are copied (reused) instead of re-downloaded; every
 * staged file is then re-hashed and refused if it does not match its manifest entry. The manifest
 * version and signature are re-verified. Any failure discards the staging dir — nothing is ever
 * partially applied. Switch with {@linkcode applyDesktopUpdate}.
 *
 * @throws {@linkcode DesktopUpdateError} on any network, shape, integrity, signature, downgrade
 *   or path-safety failure.
 */
export async function prepareDesktopUpdate(
  config: DesktopUpdaterConfig,
): Promise<DesktopUpdatePrepared> {
  const { dir, manifest, bundle } = await fetchTrustedManifest(config); // re-verify
  assertNotDowngrade(manifest, await readState(dir), bundle);

  const staging = stagingDir(dir, manifest.version);
  await removeDir(staging); // start clean; a stale partial staging must not survive
  try {
    const reuse = await currentOverlayHashes(dir);
    for (const file of manifest.files) {
      const dest = safeJoin(staging, file.path);
      if (!dest) {
        throw new DesktopUpdateError(
          "invalid",
          `unsafe manifest path: ${JSON.stringify(file.path)}`,
        );
      }
      await Deno.mkdir(dirname(dest), { recursive: true });
      // Reuse an unchanged file from the active overlay, else download it.
      let bytes: Uint8Array;
      const reusableSrc = reuse.get(file.path) === file.sha256
        ? safeJoin(versionDir(dir, (await readPointer(dir))!.version), file.path)
        : null;
      if (reusableSrc) {
        try {
          bytes = await Deno.readFile(reusableSrc);
        } catch {
          bytes = await fetchFile(config, file.path);
        }
      } else {
        bytes = await fetchFile(config, file.path);
      }
      // Invariant 1: verify EVERY staged file against its manifest entry before it counts.
      if (await sha256Hex(bytes) !== file.sha256) {
        throw new DesktopUpdateError("integrity", `SHA-256 mismatch for ${file.path}`);
      }
      await Deno.writeFile(dest, bytes as Uint8Array<ArrayBuffer>);
    }
    // Persist the verified manifest next to the files so apply/serve can read the version.
    const manifestDest = safeJoin(staging, OTA_MANIFEST_PATH)!;
    await Deno.mkdir(dirname(manifestDest), { recursive: true });
    await Deno.writeTextFile(manifestDest, JSON.stringify(manifest));
  } catch (err) {
    await removeDir(staging); // discard staging on ANY failure — never a partial apply
    throw err;
  }
  return {
    version: manifest.version,
    required: manifest.required === true,
    notes: typeof manifest.notes === "string" ? manifest.notes : null,
  };
}

/**
 * Promote the staged `version` to the active overlay and flip the "current" pointer atomically.
 * Re-verifies the staged manifest (version + signature, the downgrade floor and the expiry) and
 * re-hashes every staged file BEFORE the swap. The previous version dir is kept for rollback, the
 * accepted `sequence` is recorded, every other staging folder is deleted, and the new version
 * starts PENDING — {@linkcode desktopBooted} must confirm it or the next
 * {@linkcode resolveDesktopUiDir} rolls it back.
 *
 * @throws {@linkcode DesktopUpdateError} `not_staged` (no such staging), `rejected` (rolled back
 *   before), `downgrade` (not newer than the highest accepted sequence or the bundled export's),
 *   `expired`, or `integrity`/`signature`/`invalid` if the staged content no longer verifies.
 */
export async function applyDesktopUpdate(
  version: string,
  config: DesktopUpdaterConfig,
): Promise<void> {
  const dir = dataDirOf(config);
  // A version is a manifest version (64 hex digits): anything else (a page-supplied `../x`) never
  // names a staging dir, so it is never joined into a path.
  if (!/^[0-9a-f]{64}$/.test(version)) {
    throw new DesktopUpdateError("not_staged", `version ${JSON.stringify(version)} is not staged`);
  }
  const staging = stagingDir(dir, version);
  const state = await readState(dir);
  if (state.rejected === version) {
    throw new DesktopUpdateError("rejected", `version ${version} was rolled back; reset to retry`);
  }

  const manifest = await readJson(join(staging, OTA_MANIFEST_PATH), isOtaManifest);
  if (!manifest || manifest.version !== version) {
    throw new DesktopUpdateError("not_staged", `version ${version} is not staged`);
  }
  // Invariant 1: verify-before-swap, again — signature and every file hash, from disk.
  await assertVerified(manifest, config.publicKey);
  // Invariants 4 and 4b, again: a staged version is applied only while it is still newer than
  // everything accepted (and the bundled export) and unexpired, so a call to apply cannot bring
  // back an older UI left in a staging folder.
  const bundle = await readBundleRecord(dir);
  assertFresh(manifest, bundle);
  assertNotDowngrade(manifest, state, bundle);
  for (const file of manifest.files) {
    const src = safeJoin(staging, file.path);
    if (!src) {
      throw new DesktopUpdateError("invalid", `unsafe staged path: ${JSON.stringify(file.path)}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(src);
    } catch {
      throw new DesktopUpdateError("integrity", `staged file missing: ${file.path}`);
    }
    if (await sha256Hex(bytes) !== file.sha256) {
      throw new DesktopUpdateError("integrity", `staged SHA-256 mismatch for ${file.path}`);
    }
  }

  // Promote: rename the staging dir into place (atomic on the same filesystem).
  const target = versionDir(dir, version);
  await Deno.mkdir(dirname(target), { recursive: true });
  await removeDir(target); // replace any older copy of this version
  await Deno.rename(staging, target);

  // Record the accepted sequence (monotonic gate) BEFORE flipping the pointer.
  const accepted = manifest.sequence;
  await writeJsonAtomic(
    statePath(dir),
    {
      highestSequence: accepted === undefined
        ? state.highestSequence
        : Math.max(state.highestSequence ?? accepted, accepted),
      rejected: state.rejected,
    } satisfies UpdaterState,
  );

  // Invariant 6: atomic pointer swap. The old active version becomes the rollback target.
  const old = await readPointer(dir);
  const previous = old
    ? { version: old.version, sequence: old.sequence }
    : { version: null, sequence: null };
  await writeJsonAtomic(
    pointerPath(dir),
    {
      version,
      sequence: accepted ?? null,
      pending: true,
      previous,
    } satisfies Pointer,
  );
  // Every other staged version is older than this one now: none may be applied later.
  await removeStagingDirs(dir);
}

/**
 * Roll a failed trial back: mark it rejected, ensure its sequence stays refused, drop its dir,
 * and flip the pointer to the previous good version (or the bundled export). Atomic pointer swap.
 */
async function rollback(dir: string, pointer: Pointer): Promise<void> {
  const state = await readState(dir);
  await writeJsonAtomic(
    statePath(dir),
    {
      // The bad sequence was recorded at apply; keep it (or raise to it) so it is never retried.
      highestSequence: pointer.sequence === null
        ? state.highestSequence
        : Math.max(state.highestSequence ?? pointer.sequence, pointer.sequence),
      rejected: pointer.version,
    } satisfies UpdaterState,
  );
  await removeFile(bootingPath(dir));
  await removeDir(versionDir(dir, pointer.version));
  if (pointer.previous && pointer.previous.version) {
    await writeJsonAtomic(
      pointerPath(dir),
      {
        version: pointer.previous.version,
        sequence: pointer.previous.sequence,
        pending: false,
        previous: null,
      } satisfies Pointer,
    );
  } else {
    await removeFile(pointerPath(dir)); // back to the bundled export
  }
}

/** The record (`bundle.json`) of the bundled export the overlay state belongs to. */
interface BundleRecord {
  readonly bundle: string;
  /** The bundled export's signed-manifest `sequence`: the downgrade floor before any overlay. */
  readonly sequence?: number;
  /** Whether the bundled export's manifest carries an `expiresAt`: overlays then must too. */
  readonly expiring?: true;
}

function isBundleRecord(v: unknown): v is BundleRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.bundle === "string" &&
    (r.sequence === undefined ||
      (Number.isSafeInteger(r.sequence) && (r.sequence as number) >= 0)) &&
    (r.expiring === undefined || r.expiring === true);
}

const readBundleRecord = (dir: string) => readJson(bundlePath(dir), isBundleRecord);

/**
 * The identity of the bundled export: its stamped `_denext/ota.json` version (which hashes every
 * file), else the SHA-256 of its `index.html`, else `null` (nothing to identify it by).
 */
async function bundleIdentity(bundledOut: string): Promise<BundleRecord | null> {
  const manifest = await readJson(join(bundledOut, OTA_MANIFEST_PATH), isOtaManifest);
  if (manifest) {
    // The bundle ships inside the signed app, so its manifest's sequence is trusted as the floor.
    const { sequence, expiresAt } = manifest;
    return {
      bundle: `ota:${manifest.version}`,
      ...(sequence !== undefined ? { sequence } : {}),
      ...(expiresAt !== undefined ? { expiring: true as const } : {}),
    };
  }
  try {
    return {
      bundle: `index:${await sha256Hex(await Deno.readFile(join(bundledOut, "index.html")))}`,
    };
  } catch {
    return null;
  }
}

/**
 * Drop every overlay (and staged one) when the app's bundled export is not the one they were
 * installed over: a newer app was installed (a full-app update, an installer), and an overlay built
 * for the old app must never be served over it. The accepted sequence and the rejected version are
 * kept, so the swap cannot be used to replay an older overlay. Records the current bundle.
 */
async function forgetOverlaysOfAnotherBundle(dir: string, bundledOut: string): Promise<void> {
  const identity = await bundleIdentity(bundledOut);
  if (identity === null) return;
  const recorded = await readBundleRecord(dir);
  if (
    recorded?.bundle === identity.bundle && recorded.sequence === identity.sequence &&
    recorded.expiring === identity.expiring
  ) return;
  if (recorded && recorded.bundle !== identity.bundle) {
    await removeFile(pointerPath(dir));
    await removeFile(bootingPath(dir));
    await removeDir(join(dir, VERSIONS_DIR));
    await removeStagingDirs(dir);
  }
  await writeJsonAtomic(bundlePath(dir), identity satisfies BundleRecord);
}

/** Remove every staging dir (a no-op without a data dir). */
async function removeStagingDirs(dir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && entry.name.startsWith(STAGING_PREFIX)) {
        await removeDir(join(dir, entry.name));
      }
    }
  } catch {
    // No data dir yet.
  }
}

/**
 * The UI the desktop runtime should serve this launch: the active overlay, re-verified, or only
 * the bundled export (`overlay: null`). Serve the overlay's files through
 * {@linkcode DesktopUiOverlay.read}, which checks each one against the signed manifest when it is
 * served, never straight from its folder; `runDesktop({ updater })` does.
 *
 * This is also the BOOT WATCHDOG. If the pointer is PENDING and a boot marker for the same
 * version already exists, the previous launch applied that version and never confirmed it (it
 * failed to boot), so it is ROLLED BACK — its sequence refused so it is not retried in a loop —
 * and the previous good version (or the bundle) is served. A pending version on its FIRST launch
 * is served with a fresh marker armed; {@linkcode desktopBooted} clears it. An overlay that fails
 * re-verification (a file changed, missing or added, a symbolic link, a manifest that no longer
 * verifies) is rolled back the same way and reported as `rejected`; one that cannot be read right
 * now (a permission or I/O error) is skipped for this launch only.
 *
 * An overlay is tied to the bundled export it was installed over (`bundle.json`: the export's
 * stamped version, else its `index.html` hash). When the app itself was replaced — a full-app
 * update or a reinstall brings a different bundle — every overlay is dropped and the new bundle is
 * served, so a UI built for the old app never runs on the new one.
 *
 * @param bundledOut The bundled export (the app's own UI).
 * @param config The updater config.
 * @returns The verified overlay, or the bundled export alone.
 */
export async function openDesktopUi(
  bundledOut: string,
  config: DesktopUpdaterConfig,
): Promise<DesktopUi> {
  const dir = dataDirOf(config);
  // The page's capabilities (fs, shell, window) never reach the overlay folder, wherever it is.
  reserveRuntimeDir(resolve(dir));
  // An overlay belongs to the app it was installed over: a newer app's bundle drops it.
  await forgetOverlaysOfAnotherBundle(dir, bundledOut);
  const ui = (overlay: VerifiedOverlay | null): DesktopUi => ({ bundledDir: bundledOut, overlay });
  const pointer = await readPointer(dir);
  if (!pointer) return ui(null);

  // Confirmed pointer: no trial in progress — serve its overlay (re-verified) or the bundle.
  if (!pointer.pending) {
    await removeFile(bootingPath(dir));
    return ui(await openOverlay(dir, pointer, config.publicKey));
  }

  // A marker for this pending version means a previous launch already tried it and never
  // confirmed → it failed to boot. Roll back.
  const marker = await readBooting(dir);
  if (marker && marker.version === pointer.version) {
    await rollback(dir, pointer);
    return ui(await openOverlay(dir, await readPointer(dir), config.publicKey));
  }

  // First trial launch: serve the pending overlay (re-verified; rolled back if it fails) and arm
  // the watchdog marker for it.
  const served = await openOverlay(dir, pointer, config.publicKey);
  if (served?.version === pointer.version) {
    await writeJsonAtomic(bootingPath(dir), { version: pointer.version } satisfies BootMarker);
  }
  return ui(served);
}

/**
 * The directory of the UI {@linkcode openDesktopUi} resolves: the active overlay's, re-verified at
 * launch, or `bundledOut`. A server that serves it must check each file as it serves it (an
 * overlay file can change after launch): prefer {@linkcode openDesktopUi} and
 * {@linkcode DesktopUiOverlay.read}.
 *
 * @param bundledOut The bundled export (the app's own UI).
 * @param config The updater config.
 * @returns The directory to serve.
 */
export async function resolveDesktopUiDir(
  bundledOut: string,
  config: DesktopUpdaterConfig,
): Promise<string> {
  return (await openDesktopUi(bundledOut, config)).overlay?.dir ?? bundledOut;
}

/**
 * Confirm that the active overlay booted. Call it once the app has served and rendered (the
 * desktop runtime calls it behind a short delay after `Deno.serve` is up). It flips a PENDING
 * pointer to confirmed and clears the watchdog marker, so a crash BEFORE this call leaves the
 * version pending and the next {@linkcode resolveDesktopUiDir} rolls it back. Best effort: it
 * never throws.
 */
export async function desktopBooted(config: DesktopUpdaterConfig): Promise<void> {
  try {
    const dir = dataDirOf(config);
    const pointer = await readPointer(dir);
    if (pointer?.pending) {
      // Write the confirmed pointer FIRST, then drop the marker: a crash between the two leaves
      // a confirmed pointer with a stale marker, which the next resolve simply removes.
      await writeJsonAtomic(
        pointerPath(dir),
        {
          ...pointer,
          pending: false,
          previous: null,
        } satisfies Pointer,
      );
    }
    await removeFile(bootingPath(dir));
  } catch {
    // A failed confirmation must never break the app that just booted; the watchdog decides.
  }
}

/** A snapshot of the overlay state (mirrors `otaStatus`). */
export async function desktopUpdateStatus(
  config: DesktopUpdaterConfig,
): Promise<DesktopUpdateStatus> {
  const dir = dataDirOf(config);
  const pointer = await readPointer(dir);
  const state = await readState(dir);
  let staged: string | null = null;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && entry.name.startsWith(STAGING_PREFIX)) {
        staged = entry.name.slice(STAGING_PREFIX.length);
        break;
      }
    }
  } catch {
    // No data dir yet.
  }
  const pending = pointer?.pending ? pointer.version : null;
  const current = pointer
    ? (pointer.pending ? pointer.previous?.version ?? null : pointer.version)
    : null;
  return {
    current,
    pending,
    staged,
    rejected: state.rejected,
    highestSequence: state.highestSequence,
  };
}

/**
 * Return to the bundled export: delete every overlay version, every staging dir, and all state
 * (pointer, sequence, rejected, marker). A no-op when nothing is installed.
 */
export async function desktopUpdateReset(config: DesktopUpdaterConfig): Promise<void> {
  const dir = dataDirOf(config);
  await removeFile(pointerPath(dir));
  await removeFile(statePath(dir));
  await removeFile(bootingPath(dir));
  await removeFile(bundlePath(dir));
  await removeDir(join(dir, VERSIONS_DIR));
  await removeStagingDirs(dir);
}

// ---------------------------------------------------------------------------------------------
// FULL-APP updates: the whole signed bundle replaced by a newer signed build (the runtime's
// `Deno.desktop.updater`), next to the UI overlay above. See `app-updater.ts`.

export {
  AppUpdateError,
  appUpdateStatus,
  checkForAppUpdate,
  confirmAppUpdate,
  downloadAppUpdate,
  installAppUpdateAndRelaunch,
} from "./app-updater.ts";
export type {
  AppUpdateCheck,
  AppUpdateErrorCode,
  AppUpdateProgress,
  AppUpdaterConfig,
  AppUpdateStaged,
  AppUpdateStatus,
} from "./app-updater.ts";
