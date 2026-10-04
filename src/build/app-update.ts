// Publishing FULL-APP updates for a Deno Desktop app (`denext desktop publish-update`): pack the
// packaged artifact (a macOS `.app`, a Windows / Linux app directory, or a Linux `.AppImage`) into
// a `.tar.gz`, and write the signed manifest the pinned runtime's `Deno.desktop.updater` checks.
//
// The manifest is an envelope `{ "signed": "<JSON>", "signature": "<base64>" }`; the signature is
// ECDSA P-256 / SHA-256 (WebCrypto's raw r‖s) over `"denext-app-update-v1\n" + signed`, made with
// the SAME key pair as over-the-air UI updates (`denext ota keygen`, `DENEXT_OTA_SIGNING_KEY`), so
// an app has one signing key. The domain prefix keeps a signature over one protocol from ever
// verifying as the other. The runtime verifies the signed string byte for byte and only then
// parses it (no JSON canonicalization to disagree on). There is no unsigned output: publishing
// without a key is an error.
//
// Every manifest carries two signed freshness fields the runtime requires (a manifest without
// either is `invalid_manifest`): `expiresAt` (RFC 3339; refused at or after it, `expired`), so an
// old manifest an attacker keeps serving stops working, and `sequence` (an integer that only
// grows; lower than the highest an install accepted is `replayed`), so a replayed older manifest
// can't hide a newer release. `publish-update` defaults them to 30 days from now and the Unix time
// in seconds at signing (never below the existing manifest's); `--resign` re-signs the existing
// manifest with fresh values, which a publisher runs on a schedule shorter than the expiry.
//
// The archive holds exactly one top-level entry (the artifact, under its own name) with POSIX
// modes and symlinks preserved (a macOS framework's `Versions/Current`), which is what the
// runtime's safe extractor accepts. Extended attributes are not carried: an app whose code
// signature lives in xattrs (a script as the bundle executable) cannot be shipped this way.

import { createHash } from "node:crypto";
import { basename, join } from "@std/path";
import { fromBase64, otaPublicKeyOf, parseOtaPublicKey, toBase64 } from "./ota-signing.ts";
import { checkArtifactVersion } from "./app-update-version.ts";

/** What the signature covers before the signed string (the runtime's `SIGNATURE_DOMAIN`). */
const APP_UPDATE_SIGNATURE_DOMAIN = "denext-app-update-v1\n";
/** The manifest payload schema the runtime reads. */
const APP_UPDATE_SCHEMA = 1;
/** The manifest file name `publish-update` writes. */
export const APP_UPDATE_MANIFEST_FILE = "app-update.json";
/** How long a manifest stays valid when no expiry is given: re-sign it before then. */
export const APP_UPDATE_DEFAULT_EXPIRY_DAYS = 30;
/** The largest `sequence` the runtime accepts (`Number.MAX_SAFE_INTEGER`). */
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One platform's archive in the manifest. */
export interface AppUpdatePlatformEntry {
  /** Where the runtime downloads the archive (https). */
  readonly url: string;
  /** Lowercase hex SHA-256 of the archive. */
  readonly sha256: string;
  /** The archive's size in bytes. */
  readonly size: number;
  /** Always `"bundle"`: a whole signed app (no deltas). */
  readonly kind: "bundle";
}

/** The signed manifest payload. */
export interface AppUpdatePayload {
  readonly schema: 1;
  /** The app identifier (`desktop.app.identifier`). */
  readonly app: string;
  /** The offered semver. */
  readonly version: string;
  /** Versions below this are told the update is required (never a downgrade). */
  readonly minVersion?: string;
  /** `<rust target>-<backend>` (e.g. `aarch64-apple-darwin-webview`) → its archive. */
  readonly platforms: Readonly<Record<string, AppUpdatePlatformEntry>>;
  readonly releaseNotes?: string;
  /** ISO 8601. */
  readonly publishedAt: string;
  /** RFC 3339: installed apps refuse the manifest from this time on (`expired`). Re-sign before. */
  readonly expiresAt: string;
  /**
   * A release counter that only grows (default: the Unix time in seconds at signing): an install
   * remembers the highest it accepted and refuses a lower one (`replayed`).
   */
  readonly sequence: number;
}

/** The served manifest: the signed payload string and its signature. */
export interface AppUpdateEnvelope {
  readonly signed: string;
  readonly signature: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const TRIPLES = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]);

/** Whether `v` is a strict semver (the runtime's rule: no `v` prefix, no leading zeros). */
export function isAppUpdateVersion(v: string): boolean {
  return v.length <= 128 && SEMVER.test(v);
}

/**
 * Whether `key` is a platform key the runtime can ask for: `<target>-<webview|cef>`, with a
 * trailing `-appimage` for a Linux AppImage.
 */
export function isAppUpdatePlatform(key: string): boolean {
  const m = /^(.+)-(webview|cef)(-appimage)?$/.exec(key);
  return m !== null && TRIPLES.has(m[1]) && (m[3] === undefined || m[1].includes("linux"));
}

/** The webview backend an artifact ships: `cef` when the Chromium Embedded Framework is in it. */
async function detectArtifactBackend(artifact: string): Promise<"webview" | "cef"> {
  const probes = [
    join(artifact, "Contents", "Frameworks", "Chromium Embedded Framework.framework"),
    join(artifact, "libcef.dll"),
    join(artifact, "libcef.so"),
  ];
  for (const p of probes) {
    if (await Deno.lstat(p).then(() => true, () => false)) return "cef";
  }
  return "webview";
}

/**
 * The platform key for `artifact` built for `target` (a Rust triple; default this host's).
 *
 * @param artifact The packaged `.app` / app directory / `.AppImage`.
 * @param target The Rust target triple the artifact was built for.
 * @param backend Override the detected backend.
 * @returns The key, e.g. `x86_64-apple-darwin-webview`.
 */
export async function appUpdatePlatformKey(
  artifact: string,
  target: string = Deno.build.target,
  backend?: "webview" | "cef",
): Promise<string> {
  const appimage = artifact.toLowerCase().endsWith(".appimage") ? "-appimage" : "";
  const key = `${target}-${backend ?? await detectArtifactBackend(artifact)}${appimage}`;
  if (!isAppUpdatePlatform(key)) throw new Error(`unsupported platform ${key}`);
  return key;
}

// ---------------------------------------------------------------------------------------------
// The archive.

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** A pax record `"<len> <key>=<value>\n"`, whose length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = encoder.encode(body).length + 1;
  while (String(len).length + encoder.encode(body).length !== len) len++;
  return `${len}${body}`;
}

function header(
  name: string,
  type: "0" | "2" | "5" | "x",
  size: number,
  mode: number,
  mtime: number,
  linkname = "",
): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (text: string, at: number, width: number) =>
    h.set(encoder.encode(text).subarray(0, width), at);
  put(name, 0, 100);
  put(octal(mode & 0o7777, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** Header blocks for one entry: a pax header first when a name or link does not fit ustar. */
function entryHeaders(
  name: string,
  type: "0" | "2" | "5",
  size: number,
  mode: number,
  mtime: number,
  linkname = "",
): Uint8Array[] {
  const records = (encoder.encode(name).length > 100 ? paxRecord("path", name) : "") +
    (encoder.encode(linkname).length > 100 ? paxRecord("linkpath", linkname) : "");
  const out: Uint8Array[] = [];
  if (records) {
    const data = encoder.encode(records);
    out.push(header("././@PaxHeader", "x", data.length, 0o644, mtime));
    out.push(data, new Uint8Array((BLOCK - data.length % BLOCK) % BLOCK));
  }
  out.push(header(name, type, size, mode, mtime, linkname));
  return out;
}

function modeOf(info: Deno.FileInfo, path: string): number {
  if (info.mode !== null) return info.mode & 0o777;
  if (info.isDirectory) return 0o755;
  return /\.(exe|dll)$/i.test(path) ? 0o755 : 0o644;
}

/** Every entry under `root` (relative, `/`-separated), parents before children, sorted. */
async function walk(root: string, rel = ""): Promise<{ rel: string; info: Deno.FileInfo }[]> {
  const out: { rel: string; info: Deno.FileInfo }[] = [];
  const names: string[] = [];
  for await (const e of Deno.readDir(rel ? join(root, ...rel.split("/")) : root)) {
    names.push(e.name);
  }
  names.sort();
  for (const name of names) {
    const childRel = rel ? `${rel}/${name}` : name;
    const info = await Deno.lstat(join(root, ...childRel.split("/")));
    out.push({ rel: childRel, info });
    if (info.isDirectory) out.push(...await walk(root, childRel));
  }
  return out;
}

/** A regular file's contents, then the padding to the next block. */
async function* fileBlocks(path: string, size: number): AsyncGenerator<Uint8Array> {
  const file = await Deno.open(path);
  let written = 0;
  try {
    for await (const chunk of file.readable) {
      written += chunk.length;
      yield chunk;
    }
  } finally {
    try {
      file.close();
    } catch { /* closed by the stream */ }
  }
  if (written !== size) throw new Error(`${path} changed while it was archived`);
  yield new Uint8Array((BLOCK - size % BLOCK) % BLOCK);
}

/** The blocks of one entry (`name` in the archive, `path` on disk). */
async function* entryBlocks(
  name: string,
  path: string,
  info: Deno.FileInfo,
): AsyncGenerator<Uint8Array> {
  const mtime = (info.mtime?.getTime() ?? 0) / 1000;
  if (info.isDirectory) {
    yield* entryHeaders(`${name}/`, "5", 0, modeOf(info, path), mtime);
    return;
  }
  if (info.isSymlink) {
    if (Deno.build.os === "windows") throw new Error(`symlink ${path}: not supported on Windows`);
    yield* entryHeaders(name, "2", 0, 0o777, mtime, await Deno.readLink(path));
    return;
  }
  if (!info.isFile) throw new Error(`${path}: not a file, directory or symlink`);
  yield* entryHeaders(name, "0", info.size, modeOf(info, path), mtime);
  yield* fileBlocks(path, info.size);
}

async function* tarStream(artifact: string): AsyncGenerator<Uint8Array> {
  const top = basename(artifact);
  const info = await Deno.lstat(artifact);
  if (info.isSymlink) throw new Error(`${artifact} is a symlink; pass the real app`);
  yield* entryBlocks(top, artifact, info);
  if (info.isDirectory) {
    for (const { rel, info: i } of await walk(artifact)) {
      yield* entryBlocks(`${top}/${rel}`, join(artifact, ...rel.split("/")), i);
    }
  }
  yield new Uint8Array(BLOCK * 2);
}

/**
 * Pack `artifact` (a directory or a single file) into a `.tar.gz` at `outFile`, as one top-level
 * entry named after it.
 *
 * @param artifact The packaged app.
 * @param outFile The archive to write (replaced if it exists).
 * @returns The archive's SHA-256 (lowercase hex) and size in bytes.
 */
export async function writeAppUpdateArchive(
  artifact: string,
  outFile: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const out = await Deno.open(outFile, { write: true, create: true, truncate: true });
  try {
    const gz = ReadableStream.from(tarStream(artifact)).pipeThrough(
      new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
    const writer = out.writable.getWriter();
    for await (const chunk of gz) {
      hash.update(chunk);
      size += chunk.length;
      await writer.write(chunk);
    }
    await writer.close();
  } catch (err) {
    try {
      out.close();
    } catch { /* closed */ }
    await Deno.remove(outFile).catch(() => {});
    throw err;
  }
  return { sha256: hash.digest("hex"), size };
}

// ---------------------------------------------------------------------------------------------
// The manifest.

/**
 * Parse an RFC 3339 timestamp the way the runtime does (`YYYY-MM-DDTHH:MM:SS[.fraction]`, then `Z`
 * or `±HH:MM`; 20 to 64 characters; a real calendar date) into Unix milliseconds, the fraction
 * dropped. `null` for anything else.
 *
 * @param text The timestamp.
 * @returns Unix milliseconds, or `null`.
 */
export function parseRfc3339(text: string): number | null {
  if (text.length < 20 || text.length > 64) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/
    .exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days || hour > 23 || minute > 59 || second > 60) {
    return null;
  }
  let offset = 0;
  if (m[7] !== "Z") {
    const [oh, om] = m[7].slice(1).split(":").map(Number);
    if (oh > 23 || om > 59) return null;
    offset = (m[7][0] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset;
}

/**
 * Check a payload the way the runtime does (shape, semver, platform keys, https URLs, hashes), so
 * a bad manifest is refused when it is published rather than by every installed app.
 *
 * @throws Error naming the first problem.
 */
export function validateAppUpdatePayload(p: AppUpdatePayload): void {
  if (p.schema !== APP_UPDATE_SCHEMA) throw new Error(`schema must be ${APP_UPDATE_SCHEMA}`);
  if (!p.app) throw new Error("app (the identifier) is required");
  if (!isAppUpdateVersion(p.version)) throw new Error(`version ${p.version} is not a semver`);
  if (p.minVersion !== undefined && !isAppUpdateVersion(p.minVersion)) {
    throw new Error(`minVersion ${p.minVersion} is not a semver`);
  }
  if (!p.publishedAt || p.publishedAt.length > 64) throw new Error("publishedAt is required");
  if (typeof p.expiresAt !== "string" || parseRfc3339(p.expiresAt) === null) {
    throw new Error(`expiresAt ${p.expiresAt} is not an RFC 3339 timestamp`);
  }
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 0) {
    throw new Error(`sequence must be an integer 0..${MAX_SEQUENCE}`);
  }
  const keys = Object.keys(p.platforms);
  if (keys.length === 0) throw new Error("no platforms");
  for (const key of keys) validatePlatformEntry(key, p.platforms[key]);
}

/** One `platforms` entry, checked as the runtime checks it. */
function validatePlatformEntry(key: string, e: AppUpdatePlatformEntry): void {
  const problem = !isAppUpdatePlatform(key)
    ? "unsupported platform key"
    : e.kind !== "bundle"
    ? 'kind must be "bundle"'
    : !/^[0-9a-f]{64}$/.test(e.sha256)
    ? "sha256 must be lowercase hex"
    : !Number.isSafeInteger(e.size) || e.size <= 0
    ? "bad size"
    : archiveUrlProblem(e.url);
  if (problem) throw new Error(`${key}: ${problem}`);
}

/** Why `raw` cannot be an archive URL (https, no credentials), or `undefined`. */
function archiveUrlProblem(raw: string): string | undefined {
  const url = new URL(raw);
  if (url.protocol !== "https:") return "the archive url must be https";
  if (url.username || url.password) return "no credentials in the url";
  return undefined;
}

/** The bytes the signature covers. */
function signedBytes(signed: string): Uint8Array {
  return encoder.encode(APP_UPDATE_SIGNATURE_DOMAIN + signed);
}

/**
 * Sign `payload` into the served envelope.
 *
 * @param payload The manifest payload (validated first).
 * @param key The ECDSA P-256 signing key (`loadOtaSigningKey`).
 * @returns The envelope, ready to `JSON.stringify` and serve.
 */
export async function signAppUpdatePayload(
  payload: AppUpdatePayload,
  key: CryptoKey,
): Promise<AppUpdateEnvelope> {
  validateAppUpdatePayload(payload);
  const signed = JSON.stringify(payload);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signedBytes(signed) as BufferSource,
  );
  return { signed, signature: toBase64(new Uint8Array(sig)) };
}

/**
 * Verify an envelope against `publicKey` (base64 SPKI or PEM) the way the runtime does, and return
 * its payload. For `publish-update`'s self-check and tests; the runtime does its own.
 *
 * @throws Error when the envelope is malformed or the signature does not verify.
 */
export async function verifyAppUpdateEnvelope(
  envelope: unknown,
  publicKey: string,
): Promise<AppUpdatePayload> {
  const e = envelope as Partial<AppUpdateEnvelope> | null;
  if (
    typeof e !== "object" || e === null || typeof e.signed !== "string" ||
    typeof e.signature !== "string" || Object.keys(e).length !== 2
  ) {
    throw new Error("not a { signed, signature } envelope");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64(await parseOtaPublicKey(publicKey)) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64(e.signature) as BufferSource,
      signedBytes(e.signed) as BufferSource,
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("the signature does not verify");
  return JSON.parse(e.signed) as AppUpdatePayload;
}

/** When a manifest expires and which `sequence` it carries (see {@linkcode resolveFreshness}). */
export interface AppUpdateFreshnessOptions {
  /** An explicit expiry (RFC 3339). Exclusive with {@link expiresInDays}. */
  readonly expiresAt?: string;
  /** Days from now until it expires (default {@linkcode APP_UPDATE_DEFAULT_EXPIRY_DAYS}). */
  readonly expiresInDays?: number;
  /**
   * An explicit sequence (default: the Unix time in seconds, raised to the existing manifest's).
   * Refused when it is below the existing manifest's: installs that saw that one would refuse it.
   */
  readonly sequence?: number;
  /** The signing time (default: now; tests pin it). */
  readonly now?: Date;
}

/** What {@linkcode publishAppUpdate} needs. */
export interface PublishAppUpdateOptions extends AppUpdateFreshnessOptions {
  /** The packaged `.app` / app directory / `.AppImage`. */
  readonly artifact: string;
  /** `desktop.app.identifier`. */
  readonly app: string;
  /**
   * The version being published: the artifact's deno.json `version` at packaging. The version
   * compiled into the artifact must be this one (`version_mismatch` otherwise).
   */
  readonly version: string;
  /** The https URL the archives are served under (the archive name is appended). */
  readonly urlBase: string;
  /** Where the archive and `app-update.json` go. */
  readonly outDir: string;
  /** The signing key. */
  readonly key: CryptoKey;
  /** The platform key; default derived from the artifact and this host. */
  readonly platform?: string;
  readonly minVersion?: string;
  readonly releaseNotes?: string;
  /** Override the timestamp (tests). */
  readonly publishedAt?: string;
}

/** What {@linkcode publishAppUpdate} wrote. */
export interface PublishAppUpdateResult {
  readonly archive: string;
  readonly manifest: string;
  readonly platform: string;
  readonly sha256: string;
  readonly size: number;
  /** The platforms the manifest now lists. */
  readonly platforms: string[];
  /** When the manifest expires (RFC 3339): re-sign it before then. */
  readonly expiresAt: string;
  /** The manifest's sequence. */
  readonly sequence: number;
}

/** An existing `app-update.json`, parsed but not verified. */
interface ExistingManifest {
  readonly envelope: Partial<AppUpdateEnvelope>;
  readonly payload: AppUpdatePayload;
}

/** The manifest at `path`, parsed but not verified; `null` when there is none. */
async function readManifestFile(path: string): Promise<ExistingManifest | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  try {
    const envelope = JSON.parse(text) as Partial<AppUpdateEnvelope>;
    return { envelope, payload: JSON.parse(String(envelope.signed)) as AppUpdatePayload };
  } catch {
    throw new Error(`${path} is not an app-update manifest`);
  }
}

/** The public half of `key` (base64 SPKI); throws when the key is not extractable. */
async function publicKeyOf(key: CryptoKey, path: string): Promise<string> {
  try {
    return await otaPublicKeyOf(key);
  } catch {
    throw new Error(
      `cannot verify the existing ${path}: the signing key is not extractable ` +
        "(import it with importOtaSigningKey / loadOtaSigningKey)",
    );
  }
}

/** `existing` verified against the public half of `key`, or the reason it does not verify. */
async function verifyExisting(
  existing: ExistingManifest,
  key: CryptoKey,
  path: string,
  action: "merge into" | "re-sign" = "merge into",
): Promise<AppUpdatePayload> {
  const publicKey = await publicKeyOf(key, path);
  try {
    return await verifyAppUpdateEnvelope(existing.envelope, publicKey);
  } catch (err) {
    throw new Error(
      `refusing to ${action} ${path}: ${err instanceof Error ? err.message : err} with this ` +
        "signing key (unsigned, tampered with, or signed with another key). Re-publish every " +
        "platform of this release into an empty directory, or remove the file.",
    );
  }
}

/**
 * What the manifest already at `path` contributes: the payload of the SAME release (app +
 * version), so its other platforms carry over, and the sequence floor a new signature must not go
 * below. Both are taken only from a manifest that verifies against the public half of `key`:
 * re-signing an entry nobody verified would put this key's signature on whatever a writable output
 * directory (a CI cache, a shared bucket) was made to hold. A same-release manifest that does not
 * verify is an error; another release's is replaced, its sequence counted only when it verifies.
 */
async function readExistingRelease(
  path: string,
  key: CryptoKey,
  app: string,
  version: string,
): Promise<{ same: AppUpdatePayload | null; floor: number | null }> {
  const existing = await readManifestFile(path);
  if (existing === null) return { same: null, floor: null };
  if (existing.payload?.app === app && existing.payload.version === version) {
    const same = await verifyExisting(existing, key, path);
    return { same, floor: sequenceOf(same) };
  }
  // Another release: replaced. Its sequence still bounds ours when it is genuinely ours.
  const verified = await verifyExisting(existing, key, path).catch(() => null);
  const floor = sequenceOf(verified);
  return { same: null, floor: floor === null ? null : Math.min(floor + 1, MAX_SEQUENCE) };
}

/** A verified payload's sequence, when it has a valid one. */
function sequenceOf(p: AppUpdatePayload | null): number | null {
  return p && Number.isSafeInteger(p.sequence) && p.sequence >= 0 ? p.sequence : null;
}

/**
 * The `expiresAt` and `sequence` to sign: an explicit expiry, else `expiresInDays` (default
 * {@linkcode APP_UPDATE_DEFAULT_EXPIRY_DAYS}) from `now`; an explicit sequence, else the Unix time
 * in seconds — at least `floor` (the existing manifest's) either way, an explicit one below it
 * being an error.
 *
 * @param o The options.
 * @param floor The lowest sequence installs may still accept, or `null`.
 * @returns The values.
 * @throws Error on an expiry that is not RFC 3339 or not in the future, or a sequence out of range.
 */
export function resolveFreshness(
  o: AppUpdateFreshnessOptions,
  floor: number | null,
): { expiresAt: string; sequence: number } {
  const now = (o.now ?? new Date()).getTime();
  return { expiresAt: resolveExpiry(o, now), sequence: resolveSequence(o.sequence, floor, now) };
}

/** The `expiresAt` to sign: the explicit one (RFC 3339, in the future), else `now` + days. */
function resolveExpiry(o: AppUpdateFreshnessOptions, now: number): string {
  if (o.expiresAt !== undefined && o.expiresInDays !== undefined) {
    throw new Error("pass either an expiry time or a number of days, not both");
  }
  if (o.expiresAt !== undefined) {
    const at = parseRfc3339(o.expiresAt);
    if (at === null) throw new Error(`expiresAt ${o.expiresAt} is not an RFC 3339 timestamp`);
    if (at <= now) throw new Error(`expiresAt ${o.expiresAt} is not in the future`);
    return o.expiresAt;
  }
  const days = o.expiresInDays ?? APP_UPDATE_DEFAULT_EXPIRY_DAYS;
  if (!(Number.isFinite(days) && days > 0 && days <= 3650)) {
    throw new Error(`the expiry must be 0 < days <= 3650 (got ${days})`);
  }
  return new Date(now + Math.round(days * DAY_MS)).toISOString();
}

/** The `sequence` to sign: the explicit one (never below `floor`), else the Unix seconds. */
function resolveSequence(explicit: number | undefined, floor: number | null, now: number): number {
  if (explicit === undefined) return Math.max(Math.floor(now / 1000), floor ?? 0);
  if (!Number.isSafeInteger(explicit) || explicit < 0) {
    throw new Error(`sequence must be an integer 0..${MAX_SEQUENCE}`);
  }
  if (floor !== null && explicit < floor) {
    throw new Error(
      `sequence ${explicit} is below ${floor} (the existing manifest's): installs that ` +
        "accepted that one would refuse it as replayed",
    );
  }
  return explicit;
}

/** Sign `payload` and write it to `manifest` (atomically: a temp file, then a rename). */
async function writeManifest(manifest: string, payload: AppUpdatePayload, key: CryptoKey) {
  const envelope = await signAppUpdatePayload(payload, key);
  const tmp = `${manifest}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(envelope, null, 2) + "\n");
  await Deno.rename(tmp, manifest);
}

/**
 * Pack `artifact`, then write (or extend) the signed `app-update.json` in `outDir`: an existing
 * manifest for the same app and version keeps its other platforms, so running this once per
 * platform build yields one manifest for all of them; a manifest for another version is replaced.
 * The artifact must carry `version` (the version compiled into it), else nothing is written.
 *
 * @param o The options.
 * @returns What was written.
 */
export async function publishAppUpdate(
  o: PublishAppUpdateOptions,
): Promise<PublishAppUpdateResult> {
  if (!isAppUpdateVersion(o.version)) throw new Error(`version ${o.version} is not a semver`);
  const base = new URL(o.urlBase.endsWith("/") ? o.urlBase : `${o.urlBase}/`);
  if (base.protocol !== "https:") throw new Error("--url-base must be https");
  const platform = o.platform ?? await appUpdatePlatformKey(o.artifact);
  if (!isAppUpdatePlatform(platform)) throw new Error(`unsupported platform key ${platform}`);
  await checkArtifactVersion(o.artifact, platform, o.version);
  const manifest = join(o.outDir, APP_UPDATE_MANIFEST_FILE);
  // Another platform of the SAME release keeps its entry (and its notes / minVersion unless
  // given) — only once that manifest verifies against this signing key. Read before packing, so a
  // refusal leaves nothing behind.
  const { same, floor } = await readExistingRelease(manifest, o.key, o.app, o.version);
  const fresh = resolveFreshness(o, floor);
  const safeApp = o.app.replace(/[^A-Za-z0-9._-]/g, "_");
  const archiveName = `${safeApp}-${o.version}-${platform}.tar.gz`;
  await Deno.mkdir(o.outDir, { recursive: true });
  const archive = join(o.outDir, archiveName);
  const { sha256, size } = await writeAppUpdateArchive(o.artifact, archive);
  const minVersion = o.minVersion ?? same?.minVersion;
  const releaseNotes = o.releaseNotes ?? same?.releaseNotes;
  const payload: AppUpdatePayload = {
    schema: 1,
    app: o.app,
    version: o.version,
    ...(minVersion !== undefined ? { minVersion } : {}),
    platforms: {
      ...same?.platforms,
      [platform]: { url: new URL(archiveName, base).href, sha256, size, kind: "bundle" },
    },
    ...(releaseNotes !== undefined ? { releaseNotes } : {}),
    publishedAt: o.publishedAt ?? (o.now ?? new Date()).toISOString(),
    ...fresh,
  };
  await writeManifest(manifest, payload, o.key);
  return {
    archive,
    manifest,
    platform,
    sha256,
    size,
    platforms: Object.keys(payload.platforms).sort(),
    ...fresh,
  };
}

/** What {@linkcode resignAppUpdate} needs. */
export interface ResignAppUpdateOptions extends AppUpdateFreshnessOptions {
  /** The `app-update.json` to re-sign in place. */
  readonly manifest: string;
  /** The signing key it was signed with. */
  readonly key: CryptoKey;
}

/**
 * Re-sign an existing manifest with a fresh `expiresAt` and a `sequence` at least its own — what
 * a publisher runs on a schedule shorter than the expiry, so installed apps keep accepting the
 * current release (an expired manifest is refused, `expired`). Nothing else changes, and the
 * manifest must verify against `key` first.
 *
 * @param o The options.
 * @returns The new expiry, sequence and the release it covers.
 * @throws Error when there is no manifest, or it does not verify against `key`.
 */
export async function resignAppUpdate(
  o: ResignAppUpdateOptions,
): Promise<{ app: string; version: string; expiresAt: string; sequence: number }> {
  const existing = await readManifestFile(o.manifest);
  if (existing === null) throw new Error(`no manifest at ${o.manifest} to re-sign`);
  const current = await verifyExisting(existing, o.key, o.manifest, "re-sign");
  const fresh = resolveFreshness(o, sequenceOf(current));
  await writeManifest(o.manifest, { ...current, ...fresh }, o.key);
  return { app: current.app, version: current.version, ...fresh };
}

/** The outcome of one external command (for {@linkcode macNotarizationWarning}). */
export interface NotarizationCommandResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `cmd args…`; rejects when the command cannot be started (tests pass a stub). */
export type NotarizationCommandRunner = (
  cmd: string,
  args: string[],
) => Promise<NotarizationCommandResult>;

const runCommand: NotarizationCommandRunner = async (cmd, args) => {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder();
  return { success: out.success, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
};

const NOTARIZE_FIX = "package it with a Developer ID identity and DENEXT_NOTARY_PROFILE set";

/**
 * Whether a macOS update archive would pass the runtime's Gatekeeper check. Before it installs a
 * full-app update the runtime requires `spctl --assess --type execute` to accept the staged
 * `.app`, so a Developer ID build that is not notarized (or an Apple Development build) is
 * refused on every installed app (`os_signature`) even when the Team ID matches. This runs the
 * same assessment (`spctl -a -vv -t exec`) on the artifact being published.
 *
 * @param artifact The packaged artifact; anything but a `.app` is not checked.
 * @param run The command runner (default: `Deno.Command`).
 * @returns A warning to print, or `null` when Gatekeeper accepts the app as notarized (or it is
 *   not a macOS `.app`).
 */
export async function macNotarizationWarning(
  artifact: string,
  run: NotarizationCommandRunner = runCommand,
): Promise<string | null> {
  if (!/\.app\/?$/i.test(artifact)) return null;
  let r: NotarizationCommandResult;
  try {
    r = await run("spctl", ["-a", "-vv", "-t", "exec", artifact]);
  } catch {
    return `could not check that ${artifact} is notarized (spctl is unavailable on this host). ` +
      `Installed apps refuse a macOS update Gatekeeper rejects: ${NOTARIZE_FIX}.`;
  }
  // spctl prints its verdict and `source=` to stderr.
  const output = `${r.stderr}\n${r.stdout}`;
  const source = /^\s*source=(.*)$/m.exec(output)?.[1]?.trim();
  if (r.success && (source === undefined || /notarized/i.test(source))) return null;
  const why = source ? ` (source=${source})` : r.success ? "" : ` (${output.trim() || "rejected"})`;
  return `${artifact} is not a notarized Developer ID app${why}: installed apps refuse it ` +
    `(os_signature: Gatekeeper rejects the staged app). ${NOTARIZE_FIX}, then publish again.`;
}
