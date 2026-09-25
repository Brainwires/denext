// A SIGNED self-updater for the `denext/desktop` (Deno Desktop) UI.
//
// The desktop app ships a static SPA export inside a code-signed `.app`/bundle. Modifying a
// file inside that bundle invalidates the signature, so this updater NEVER touches `out/`.
// Instead it maintains a VERIFIED UI OVERLAY in a writable app-support directory that the
// desktop runtime prefers over the bundled export (see `resolveDesktopUiDir`). Full-binary
// replacement is out of scope — only the UI assets are overlaid.
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
//     which has none after a sequenced one was accepted) is refused (`downgrade`). A version
//     that fails to boot has its sequence recorded so it is never retried in a loop.
//  5. NO PATH ESCAPE. Every manifest path is checked with `isOtaManifestPath` (no control
//     characters) and split into segments that reject `""`, `.`, `..` and backslashes; the
//     resolved path must stay inside the staging/version directory.
//  6. ATOMIC POINTER SWAP. The "current" pointer is flipped by writing `current.json.tmp` and
//     `Deno.rename`-ing it over `current.json` — a same-directory rename is atomic, so a crash
//     never leaves a half-written pointer. The previous version dir is kept for rollback.

import { dirname, join, resolve, SEPARATOR } from "@std/path";
import {
  isOtaManifest,
  isOtaManifestPath,
  OTA_MANIFEST_PATH,
  type OtaManifest,
  otaManifestVersion,
  otaSignaturePayload,
  sha256Hex,
} from "../mobile/ota-manifest.ts";
import { parseOtaPublicKey } from "../build/ota-signing.ts";

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
 * - `downgrade`: `manifest.sequence` is `<=` the highest accepted, or absent after a sequenced
 *   manifest was accepted;
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
   * The app identifier used to build the default {@linkcode DesktopUpdaterConfig.dataDir}.
   * Default `"denext-desktop"`. Ignored when `dataDir` is set.
   */
  readonly appId?: string;
  /** The manifest / file request timeout in ms. Default 30 000. */
  readonly timeoutMs?: number;
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

/** Read an env var (trying the lowercase spelling too), or undefined without permission. */
function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? Deno.env.get(name.toLowerCase()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The user's home directory (best effort). */
function homeDir(): string {
  return env("HOME") ?? env("USERPROFILE") ?? ".";
}

/** The default OS app-support data dir for `appId`. */
// fallow-ignore-next-line complexity -- per-OS path helper; branches not unit-tested, CRAP is coverage-estimated
function defaultDataDir(appId: string): string {
  const os = Deno.build.os;
  if (os === "darwin") {
    return join(homeDir(), "Library", "Application Support", appId, "ui-updates");
  }
  if (os === "windows") {
    const appData = env("APPDATA") ?? join(homeDir(), "AppData", "Roaming");
    return join(appData, appId, "ui-updates");
  }
  const xdg = env("XDG_DATA_HOME");
  const base = xdg && xdg.trim() ? xdg : join(homeDir(), ".local", "share");
  return join(base, appId, "ui-updates");
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

const pointerPath = (dir: string) => join(dir, CURRENT_FILE);
const statePath = (dir: string) => join(dir, STATE_FILE);
const bootingPath = (dir: string) => join(dir, BOOTING_FILE);
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

/** Whether `versions/<version>/index.html` exists (a "good" overlay dir). */
async function versionDirIfGood(dir: string, version: string): Promise<string | null> {
  const vdir = versionDir(dir, version);
  try {
    await Deno.stat(join(vdir, "index.html"));
    return vdir;
  } catch {
    return null;
  }
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
  let ok = false;
  try {
    // Standard base64 → raw 64-byte r‖s, over `otaSignaturePayload` (v2 with a sequence, else v1).
    const raw = base64ToBytes(manifest.signature);
    const payload = await otaSignaturePayload(manifest);
    ok = await crypto.subtle.verify(
      VERIFY_ALGORITHM,
      key,
      raw as BufferSource,
      payload as BufferSource,
    );
  } catch {
    ok = false; // malformed base64, bad r‖s length, or a bad payload (e.g. absurd sequence)
  }
  if (!ok) throw new DesktopUpdateError("signature", "the manifest signature does not verify");
}

// ---------------------------------------------------------------------------------------------
// Proxy-tolerant fetch (#4812: TLS-inspecting proxies stalled Electron's updater).

/** The proxy URL to use for `target`, honouring `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. */
function proxyUrlFor(target: URL): string | undefined {
  const noProxy = env("NO_PROXY");
  if (noProxy) {
    const host = target.hostname;
    for (const raw of noProxy.split(",")) {
      const entry = raw.trim().replace(/^\./, "");
      if (!entry) continue;
      if (entry === "*" || host === entry || host.endsWith(`.${entry}`)) return undefined;
    }
  }
  const proxy = env(target.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY");
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

/** Fetch and validate `${feedUrl}/_denext/ota.json`. */
async function fetchManifest(config: DesktopUpdaterConfig): Promise<OtaManifest> {
  const base = config.feedUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = await fetchWith(`${base}/${OTA_MANIFEST_PATH}`, {}, timeoutMs, async (r) => {
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
  return fetchWith(url, {}, timeoutMs, async (r) => new Uint8Array(await r.arrayBuffer()));
}

// ---------------------------------------------------------------------------------------------
// The downgrade gate (invariant 4).

/**
 * Refuse a manifest whose `sequence` is not strictly greater than the highest accepted (or which
 * has none after a sequenced manifest was accepted). Called after the version-equality check, so
 * re-offering the running version is reported as "not available", not as a downgrade.
 */
function assertNotDowngrade(manifest: OtaManifest, state: UpdaterState): void {
  const highest = state.highestSequence;
  if (highest === null) return; // nothing accepted yet: any sequence (or none) is allowed
  if (manifest.sequence === undefined || manifest.sequence <= highest) {
    throw new DesktopUpdateError(
      "downgrade",
      `sequence ${manifest.sequence ?? "(none)"} is not newer than the accepted ${highest}`,
    );
  }
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
  const dir = dataDirOf(config);
  const manifest = await fetchManifest(config);
  await assertVerified(manifest, config.publicKey); // integrity + signature, verify-before-trust

  const pointer = await readPointer(dir);
  if (pointer && pointer.version === manifest.version) return { available: false };

  assertNotDowngrade(manifest, await readState(dir));
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
  const dir = dataDirOf(config);
  const manifest = await fetchManifest(config);
  await assertVerified(manifest, config.publicKey); // re-verify: integrity + signature
  assertNotDowngrade(manifest, await readState(dir));

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
 * Re-verifies the staged manifest (version + signature) and re-hashes every staged file BEFORE
 * the swap. The previous version dir is kept for rollback, the accepted `sequence` is recorded,
 * and the new version starts PENDING — {@linkcode desktopBooted} must confirm it or the next
 * {@linkcode resolveDesktopUiDir} rolls it back.
 *
 * @throws {@linkcode DesktopUpdateError} `not_staged` (no such staging), `rejected` (rolled back
 *   before), or `integrity`/`signature`/`invalid` if the staged content no longer verifies.
 */
export async function applyDesktopUpdate(
  version: string,
  config: DesktopUpdaterConfig,
): Promise<void> {
  const dir = dataDirOf(config);
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

/** Roll `pointer` back and serve the resulting good overlay (or the bundle). */
async function rollbackAndServe(
  dir: string,
  pointer: Pointer,
  bundledOut: string,
): Promise<string> {
  await rollback(dir, pointer);
  const rolled = await readPointer(dir);
  return rolled ? (await versionDirIfGood(dir, rolled.version)) ?? bundledOut : bundledOut;
}

/**
 * The directory the desktop runtime should serve: the active verified overlay, or `bundledOut`.
 *
 * This is also the BOOT WATCHDOG. If the pointer is PENDING and a boot marker for the same
 * version already exists, the previous launch applied that version and never confirmed it (it
 * failed to boot), so it is ROLLED BACK — its sequence refused so it is not retried in a loop —
 * and the previous good version (or the bundle) is served. A pending version on its FIRST launch
 * is served with a fresh marker armed; {@linkcode desktopBooted} clears it. A confirmed pointer
 * whose files exist is served directly; anything missing falls back to `bundledOut`.
 */
export async function resolveDesktopUiDir(
  bundledOut: string,
  config: DesktopUpdaterConfig,
): Promise<string> {
  const dir = dataDirOf(config);
  const pointer = await readPointer(dir);
  if (!pointer) return bundledOut;

  // Confirmed pointer: no trial in progress — serve its overlay (or the bundle if it's gone).
  if (!pointer.pending) {
    await removeFile(bootingPath(dir));
    return (await versionDirIfGood(dir, pointer.version)) ?? bundledOut;
  }

  // A marker for this pending version means a previous launch already tried it and never
  // confirmed → it failed to boot. Roll back.
  const marker = await readBooting(dir);
  if (marker && marker.version === pointer.version) {
    return await rollbackAndServe(dir, pointer, bundledOut);
  }

  // First trial launch: arm the watchdog marker and serve the pending overlay (roll back if its
  // dir vanished).
  const served = await versionDirIfGood(dir, pointer.version);
  if (!served) return await rollbackAndServe(dir, pointer, bundledOut);
  await writeJsonAtomic(bootingPath(dir), { version: pointer.version } satisfies BootMarker);
  return served;
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
  await removeDir(join(dir, VERSIONS_DIR));
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
