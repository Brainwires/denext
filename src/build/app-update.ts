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
// The archive holds exactly one top-level entry (the artifact, under its own name) with POSIX
// modes and symlinks preserved (a macOS framework's `Versions/Current`), which is what the
// runtime's safe extractor accepts. Extended attributes are not carried: an app whose code
// signature lives in xattrs (a script as the bundle executable) cannot be shipped this way.

import { createHash } from "node:crypto";
import { basename, join } from "@std/path";
import { fromBase64, parseOtaPublicKey, toBase64 } from "./ota-signing.ts";

/** What the signature covers before the signed string (the runtime's `SIGNATURE_DOMAIN`). */
const APP_UPDATE_SIGNATURE_DOMAIN = "denext-app-update-v1\n";
/** The manifest payload schema the runtime reads. */
const APP_UPDATE_SCHEMA = 1;
/** The manifest file name `publish-update` writes. */
export const APP_UPDATE_MANIFEST_FILE = "app-update.json";

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

/** What {@linkcode publishAppUpdate} needs. */
export interface PublishAppUpdateOptions {
  /** The packaged `.app` / app directory / `.AppImage`. */
  readonly artifact: string;
  /** `desktop.app.identifier`. */
  readonly app: string;
  /** The version being published (the artifact's deno.json `version`). */
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
}

/** The payload of an existing manifest at `path` (unverified: the publisher's own file). */
async function readExistingPayload(path: string): Promise<AppUpdatePayload | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const env = JSON.parse(text) as Partial<AppUpdateEnvelope>;
  if (typeof env.signed !== "string") throw new Error(`${path} is not an app-update manifest`);
  return JSON.parse(env.signed) as AppUpdatePayload;
}

/**
 * Pack `artifact`, then write (or extend) the signed `app-update.json` in `outDir`: an existing
 * manifest for the same app and version keeps its other platforms, so running this once per
 * platform build yields one manifest for all of them; a manifest for another version is replaced.
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
  const safeApp = o.app.replace(/[^A-Za-z0-9._-]/g, "_");
  const archiveName = `${safeApp}-${o.version}-${platform}.tar.gz`;
  await Deno.mkdir(o.outDir, { recursive: true });
  const archive = join(o.outDir, archiveName);
  const { sha256, size } = await writeAppUpdateArchive(o.artifact, archive);
  const manifest = join(o.outDir, APP_UPDATE_MANIFEST_FILE);
  const existing = await readExistingPayload(manifest);
  // Another platform of the SAME release keeps its entry (and its notes / minVersion unless given).
  const same = existing?.app === o.app && existing.version === o.version ? existing : null;
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
    publishedAt: o.publishedAt ?? new Date().toISOString(),
  };
  const envelope = await signAppUpdatePayload(payload, o.key);
  const tmp = `${manifest}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(envelope, null, 2) + "\n");
  await Deno.rename(tmp, manifest);
  return {
    archive,
    manifest,
    platform,
    sha256,
    size,
    platforms: Object.keys(payload.platforms).sort(),
  };
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
