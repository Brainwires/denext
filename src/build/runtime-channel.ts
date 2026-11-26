// The runtime channel: how a denext runtime release (a Deno toolchain plus its Deno Desktop
// runtime, `denext-runtime-v<version>` on Brainwires/deno) reaches machines without a denext
// release. Two documents, both served from https://denext.dev/runtime/ and mirrored on the orphan
// branch `denext-runtime-channel` of Brainwires/deno:
//
// - `channel.json`, the signed index: the envelope of the revoked-runtimes list
//   (signed-envelope.ts; ECDSA P-256 / SHA-256 over `"denext-runtime-channel-v1\n" + signed`,
//   checked over the bytes before parsing), with `signatures[]` so one index can carry the active
//   and the backup key's signature during a rotation. The payload carries `issuedAt`, `expiresAt`
//   (45 days), a `sequence` that only grows (a compiled-in floor, raised at each denext release,
//   refuses older indexes) and `releases[]`: one entry per published runtime, naming its release
//   document by SHA-256 and size.
// - `releases/<version>.json`, the release document: exactly the two pins a denext release
//   compiles in (`{ toolchain, desktop }`, without `rollback`). Unsigned: it is trusted only
//   through the `doc.sha256` the verified index (or a project's lock) names.
//
// The keys are their own pair (runtime-channel-keys.ts), never the revoked-runtimes list's, and
// that list can withdraw one (`revokedChannelKeys`): an index that only a withdrawn key signs is
// refused. Whatever a valid signature says, a release document may only point at this release's
// GitHub download URLs or https://denext.dev/runtime/, and its version must be a denext runtime
// version: the client enforces it, not policy.
//
// Fail closed: no key, a bad or withdrawn signature, an expired index, one below the sequence
// floor, one dated more than a day ahead, an unknown schema or a document whose hash differs all
// mean the channel is absent. Nothing here selects what runs (that is the resolver's job, and it
// never asks the network at command time) and nothing here ever fails a command: the loader
// reports what it found.

import { join } from "@std/path";
import { compareDenoVersions } from "./deno-version.ts";
import type { DenoToolchainArtifact, DenoToolchainPin } from "./deno-toolchain.ts";
import type { DesktopRuntimeArtifact, DesktopRuntimePin } from "./desktop-runtime.ts";
import {
  checkPayloadHeader,
  type EnvGet,
  fetchDue,
  fetchTextCapped,
  freshHeader,
  isTimestamp,
  keySetId,
  netGrantedByQuery,
  parseEnvelope,
  processEnv,
  readCacheState,
  readKeysFile,
  resignDue,
  sha256Hex,
  type SignedCacheState,
  type SignedEnvelope,
  type SignedFetchMode,
  signWithKeys,
  spkiSha256,
  toolchainCacheRoot,
  verifyingKey,
  writeQuietly,
} from "./signed-envelope.ts";
import {
  type LoadedRevocations,
  type LoadRevocationsOptions,
  loadRuntimeRevocations,
} from "./runtime-revocations.ts";
import {
  RUNTIME_CHANNEL_MIN_SEQUENCE,
  RUNTIME_CHANNEL_PUBLIC_KEYS,
} from "./runtime-channel-keys.ts";

/** What the signature covers before the signed string. */
export const CHANNEL_SIGNATURE_DOMAIN = "denext-runtime-channel-v1\n";
/** The repository whose releases the channel lists (and whose orphan branch mirrors it). */
export const CHANNEL_REPOSITORY = "Brainwires/deno";
/** The mirror's orphan branch. */
export const CHANNEL_MIRROR_BRANCH = "denext-runtime-channel";
/**
 * Where the channel is served from, each a base the index (`channel.json`) and the release
 * documents (`releases/<version>.json`) sit under: denext.dev first, then the mirror.
 */
export const CHANNEL_BASES: readonly string[] = [
  "https://denext.dev/runtime/",
  `https://raw.githubusercontent.com/${CHANNEL_REPOSITORY}/${CHANNEL_MIRROR_BRANCH}/`,
];
/** The index's file name under a base. */
export const CHANNEL_FILE = "channel.json";
/** The largest index accepted (fetched or cached). */
export const CHANNEL_MAX_BYTES = 256 * 1024;
/** The largest release document accepted. */
export const RELEASE_DOCUMENT_MAX_BYTES = 1024 * 1024;
/** How long a signed index stays valid. */
const CHANNEL_DEFAULT_EXPIRY_DAYS = 45;
/** An index with fewer days than this before it expires is re-signed (`runtime:channel resign --if-due`). */
export const CHANNEL_RESIGN_DAYS = 15;
/** How far ahead of the clock an index's `issuedAt` / `sequence` may be (a skewed signer). */
const CHANNEL_MAX_FUTURE_MS = 24 * 3600_000;
/** `0` turns the channel off (nothing read, fetched or trusted). */
const CHANNEL_CHECK_ENV = "DENEXT_RUNTIME_CHANNEL";
/**
 * Test-only: a JSON file holding the public keys (base64 SPKI) to verify with, instead of the
 * compiled-in ones. Honoured only after {@linkcode honourChannelKeysFileForTests} (nothing in
 * denext calls it), and while it is set nothing is written to the cache.
 */
export const CHANNEL_KEYS_FILE_ENV = "DENEXT_RUNTIME_CHANNEL_KEYS_FILE";
/** The versions the channel may list: denext's runtime line (`3.0.0-denext.N`). */
const CHANNEL_RELEASE_VERSION: RegExp = /^3\.0\.0-denext\.[1-9]\d*$/;

/**
 * Whether `version` is a version the channel may list (`3.0.0-denext.N`).
 *
 * @param version The version.
 * @returns Whether it is one.
 */
export function isChannelReleaseVersion(version: string): boolean {
  return CHANNEL_RELEASE_VERSION.test(version);
}

/** How long a fetched index is used before it is fetched again (the revocation list's cadence). */
const CHANNEL_TTL_MS = 12 * 3600_000;
/** How long after a failed fetch the next is tried. */
const FAILED_RETRY_MS = 3600_000;
/** The time a fetch may take (an explicit `runtime upgrade` / `list` waits longer). */
const FETCH_BUDGET_MS = 1500;
const FORCE_BUDGET_MS = 10_000;
const CACHE_FILE = "channel.json";
const STATE_FILE = "channel.state.json";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** One published runtime release, as the index lists it. */
export interface RuntimeChannelRelease {
  /** The runtime version (`3.0.0-denext.31`). */
  readonly version: string;
  /** Its release tag (`denext-runtime-v<version>`). */
  readonly tag: string;
  /** The stock Deno it is built from. */
  readonly deno: string;
  /** When the GitHub release was published (RFC 3339): the dependency-age hold reads it. */
  readonly releasedAt: string;
  /** The oldest denext proven to run on it. */
  readonly minDenext: string;
  /** The newest denext that still runs on it, only when a later one drops it. */
  readonly maxDenext?: string;
  /** The esbuild its CLI archives carry. */
  readonly esbuild: string;
  /** The laufey API level of its Deno Desktop runtime (`null`: not recorded). */
  readonly laufeyApi: number | null;
  /** The newest glibc its Linux builds need (`null`: not recorded). */
  readonly minGlibc: string | null;
  /** Set when the release fixes a security problem. */
  readonly security?: true;
  /** Set when it was withdrawn as broken (not dangerous: that is a revocation). */
  readonly yanked?: { readonly reason: string };
  /** The release document's SHA-256 (hex) and size in bytes. */
  readonly doc: { readonly sha256: string; readonly size: number };
}

/** The signed payload. */
export interface RuntimeChannel {
  readonly schema: 1;
  /** RFC 3339. */
  readonly issuedAt: string;
  /** RFC 3339; an index at or after it is ignored. */
  readonly expiresAt: string;
  /** The Unix time in seconds at signing; only ever grows. */
  readonly sequence: number;
  /** Newest first. */
  readonly releases: readonly RuntimeChannelRelease[];
}

/** The served index. */
export interface RuntimeChannelEnvelope {
  readonly signed: string;
  /** Base64 raw r‖s, one per signing key. */
  readonly signatures: readonly string[];
}

/** A release document: the two pins of one runtime release, without `rollback`. */
export interface RuntimeReleaseDocument {
  readonly toolchain: DenoToolchainPin;
  readonly desktop: DesktopRuntimePin;
}

/** Why an index or a release document was refused. */
export type RuntimeChannelProblem =
  | "size"
  | "format"
  | "signature"
  | "revoked-key"
  | "invalid"
  | "expired"
  | "replayed"
  | "future"
  | "document";

/** A refused index or release document. */
export class RuntimeChannelError extends Error {
  override name = "RuntimeChannelError";
  /**
   * @param code Why.
   * @param message What to say.
   * @param channel The payload, when it verified but is expired or replayed.
   */
  constructor(
    readonly code: RuntimeChannelProblem,
    message: string,
    readonly channel?: RuntimeChannel,
  ) {
    super(message);
  }
}

const invalid = (why: string) =>
  new RuntimeChannelError("invalid", `the runtime channel index is invalid: ${why}`);
const badDocument = (why: string) =>
  new RuntimeChannelError("document", `the release document is refused: ${why}`);

// ---------------------------------------------------------------------------------------------
// The index's fields.

/** A required string field matching `re`. */
function str(e: Record<string, unknown>, field: string, re: RegExp, who: string): string {
  const v = e[field];
  if (typeof v !== "string" || !re.test(v)) throw invalid(`${who}: bad ${field}`);
  return v;
}

/** `maxDenext`, when given. */
function maxDenextField(e: Record<string, unknown>, who: string): { maxDenext?: string } {
  return e.maxDenext === undefined ? {} : { maxDenext: str(e, "maxDenext", SEMVER, who) };
}

/** `security`, when given: only `true`. */
function securityField(v: unknown, who: string): { security?: true } {
  if (v === undefined) return {};
  if (v !== true) throw invalid(`${who}: security must be true`);
  return { security: true };
}

/** `yanked`, when given: a non-empty reason. */
function yankedField(v: unknown, who: string): { yanked?: { reason: string } } {
  if (v === undefined) return {};
  const reason = (v as { reason?: unknown } | null)?.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw invalid(`${who}: yanked needs a reason`);
  }
  return { yanked: { reason } };
}

/** The optional fields of an entry, checked. */
function optionalReleaseFields(
  e: Record<string, unknown>,
  who: string,
): Pick<RuntimeChannelRelease, "maxDenext" | "security" | "yanked"> {
  return {
    ...maxDenextField(e, who),
    ...securityField(e.security, who),
    ...yankedField(e.yanked, who),
  };
}

/** The `doc` field: a SHA-256 and a size within {@linkcode RELEASE_DOCUMENT_MAX_BYTES}. */
function checkDocRef(raw: unknown, who: string): RuntimeChannelRelease["doc"] {
  const d = raw as { sha256?: unknown; size?: unknown } | null;
  const size = d?.size;
  if (
    typeof d?.sha256 !== "string" || !SHA256.test(d.sha256) || !Number.isSafeInteger(size) ||
    (size as number) <= 0 || (size as number) > RELEASE_DOCUMENT_MAX_BYTES
  ) throw invalid(`${who}: bad doc (sha256 + size)`);
  return { sha256: d.sha256, size: size as number };
}

/** `laufeyApi`: `null` or a non-negative integer. */
function checkLaufeyApi(v: unknown, who: string): number | null {
  if (v === null || (Number.isSafeInteger(v) && (v as number) >= 0)) return v as number | null;
  throw invalid(`${who}: laufeyApi must be a non-negative integer or null`);
}

/** `minGlibc`: `null` or `<major>.<minor>`. */
function checkGlibc(v: unknown, who: string): string | null {
  if (v === null || (typeof v === "string" && /^\d+\.\d+$/.test(v))) return v as string | null;
  throw invalid(`${who}: minGlibc must be <major>.<minor> or null`);
}

/**
 * One index entry, checked, keeping only the fields this denext reads.
 *
 * @param raw The parsed entry.
 * @returns The entry.
 * @throws {RuntimeChannelError} When a field is missing or malformed (`invalid`).
 */
export function checkChannelRelease(raw: unknown): RuntimeChannelRelease {
  if (typeof raw !== "object" || raw === null) throw invalid("an entry is not an object");
  const e = raw as Record<string, unknown>;
  const version = str(e, "version", CHANNEL_RELEASE_VERSION, "an entry");
  if (e.tag !== `denext-runtime-v${version}`) {
    throw invalid(`${version}: tag must be denext-runtime-v${version}`);
  }
  if (!isTimestamp(e.releasedAt)) throw invalid(`${version}: bad releasedAt`);
  return {
    version,
    tag: e.tag as string,
    deno: str(e, "deno", PLAIN_VERSION, version),
    releasedAt: e.releasedAt,
    minDenext: str(e, "minDenext", SEMVER, version),
    ...optionalReleaseFields(e, version),
    esbuild: str(e, "esbuild", PLAIN_VERSION, version),
    laufeyApi: checkLaufeyApi(e.laufeyApi, version),
    minGlibc: checkGlibc(e.minGlibc, version),
    doc: checkDocRef(e.doc, version),
  };
}

/**
 * Check a schema-1 payload and keep what this denext reads (unknown fields dropped). Entries are
 * returned newest first; two entries for one version are refused.
 *
 * @param raw The parsed payload.
 * @returns The index.
 * @throws {RuntimeChannelError} When a known field is malformed (`invalid`).
 */
export function checkRuntimeChannel(raw: unknown): RuntimeChannel {
  const header = checkPayloadHeader(raw, invalid);
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.releases)) throw invalid("releases must be a list");
  const releases = p.releases.map(checkChannelRelease);
  const seen = new Set<string>();
  for (const r of releases) {
    if (seen.has(r.version)) throw invalid(`${r.version} is listed twice`);
    seen.add(r.version);
  }
  return {
    schema: 1,
    ...header,
    releases: releases.sort((a, b) => compareDenoVersions(b.version, a.version)),
  };
}

// ---------------------------------------------------------------------------------------------
// Verifying and signing the index.

/** Options for {@linkcode verifyRuntimeChannel}. */
export interface VerifyChannelOptions {
  /** The clock, epoch ms (default now). */
  readonly now?: number;
  /** The lowest sequence accepted: a lower one is refused (`replayed`). */
  readonly minSequence?: number;
  /** Withdrawn channel keys, each the SHA-256 of its SPKI bytes (hex). */
  readonly revokedKeys?: readonly string[];
}

/**
 * The trusted keys minus the withdrawn ones (`revoked`: SPKI SHA-256 hex digests).
 *
 * @param keys The trusted keys (base64 SPKI).
 * @param revoked The withdrawn keys' digests.
 * @returns The keys still in force, and the withdrawn ones.
 */
export async function partitionChannelKeys(
  keys: readonly string[],
  revoked: readonly string[] = [],
): Promise<{ live: string[]; withdrawn: string[] }> {
  const gone = new Set(revoked.map((k) => k.toLowerCase()));
  const live: string[] = [];
  const withdrawn: string[] = [];
  for (const key of keys) {
    const id = await spkiSha256(key);
    (id !== null && gone.has(id) ? withdrawn : live).push(key);
  }
  return { live, withdrawn };
}

/** The envelope inside `text`, or a refusal. */
function channelEnvelope(text: string): SignedEnvelope {
  const e = parseEnvelope(text, CHANNEL_MAX_BYTES);
  if (e === "size") {
    throw new RuntimeChannelError("size", `the index is larger than ${CHANNEL_MAX_BYTES} bytes`);
  }
  if (e === "format") {
    throw new RuntimeChannelError("format", "not a { signed, signatures } envelope");
  }
  return e;
}

/** Refuse an index dated ahead of `now`, expired at `now`, or below `minSequence`. */
function checkFreshness(channel: RuntimeChannel, now: number, minSequence: number): void {
  if (
    channel.sequence * 1000 > now + CHANNEL_MAX_FUTURE_MS ||
    Date.parse(channel.issuedAt) > now + CHANNEL_MAX_FUTURE_MS
  ) {
    throw new RuntimeChannelError(
      "future",
      `the index is dated ahead of this clock (issued ${channel.issuedAt}, sequence ${channel.sequence})`,
    );
  }
  if (now >= Date.parse(channel.expiresAt)) {
    throw new RuntimeChannelError("expired", `the index expired at ${channel.expiresAt}`, channel);
  }
  if (channel.sequence < minSequence) {
    throw new RuntimeChannelError(
      "replayed",
      `the index's sequence ${channel.sequence} is below the ${minSequence} already seen`,
      channel,
    );
  }
}

/**
 * Verify a served index against `keys` — its size, a signature over the exact bytes from a key
 * that is not withdrawn, then its fields, date, expiry and sequence — and return it. A payload of
 * an unknown `schema` is ignored as a whole: `null`.
 *
 * @param text The document.
 * @param keys The trusted public keys (base64 SPKI); a signature from any one that is not
 *   withdrawn verifies.
 * @param options The clock, the sequence floor and the withdrawn keys.
 * @returns The index, or `null` for an unknown schema.
 * @throws {RuntimeChannelError} When it is refused (see its `code`).
 */
export async function verifyRuntimeChannel(
  text: string,
  keys: readonly string[],
  options: VerifyChannelOptions = {},
): Promise<RuntimeChannel | null> {
  const e = channelEnvelope(text);
  const { live, withdrawn } = await partitionChannelKeys(keys, options.revokedKeys);
  if (await verifyingKey(e, CHANNEL_SIGNATURE_DOMAIN, live) === null) {
    if (await verifyingKey(e, CHANNEL_SIGNATURE_DOMAIN, withdrawn) !== null) {
      throw new RuntimeChannelError(
        "revoked-key",
        "the index is signed only by a channel key the revoked-runtimes list withdrew",
      );
    }
    throw new RuntimeChannelError("signature", "the signature does not verify");
  }
  let payload: { schema?: unknown };
  try {
    payload = JSON.parse(e.signed);
  } catch {
    throw invalid("the signed payload is not JSON");
  }
  if (payload?.schema !== 1) return null;
  const channel = checkRuntimeChannel(payload);
  checkFreshness(channel, options.now ?? Date.now(), options.minSequence ?? 0);
  return channel;
}

/**
 * Sign `channel` into the served envelope (`scripts/runtime-channel.ts`), once per key.
 *
 * @param channel The payload (checked first).
 * @param keys The ECDSA P-256 private keys: the active one, and the backup during a rotation.
 * @returns The envelope, ready to `JSON.stringify` and publish.
 */
export async function signRuntimeChannel(
  channel: RuntimeChannel,
  keys: readonly CryptoKey[],
): Promise<RuntimeChannelEnvelope> {
  checkRuntimeChannel(channel);
  const signed = JSON.stringify(channel);
  return { signed, signatures: await signWithKeys(signed, CHANNEL_SIGNATURE_DOMAIN, keys) };
}

/**
 * An index of `releases` signed now: `issuedAt` now, `expiresAt` {@linkcode
 * CHANNEL_DEFAULT_EXPIRY_DAYS} days on, `sequence` the Unix time in seconds — above `previous`'s,
 * whatever the clock says — and the entries newest first.
 *
 * @param releases The entries.
 * @param now The signing time.
 * @param previous The index this one replaces, if any.
 * @returns The payload to sign.
 */
export function freshRuntimeChannel(
  releases: readonly RuntimeChannelRelease[],
  now: Date,
  previous?: { readonly sequence: number },
): RuntimeChannel {
  return {
    schema: 1,
    ...freshHeader(now, CHANNEL_DEFAULT_EXPIRY_DAYS, previous),
    releases: [...releases].sort((a, b) => compareDenoVersions(b.version, a.version)),
  };
}

/**
 * Whether a published index is due a re-sign: fewer than `days` days remain before it expires
 * (or it already has).
 *
 * @param channel The published index.
 * @param now The clock, epoch ms.
 * @param days The margin (default {@linkcode CHANNEL_RESIGN_DAYS}).
 * @returns Whether to re-sign.
 */
export function channelResignDue(
  channel: Pick<RuntimeChannel, "expiresAt">,
  now: number = Date.now(),
  days: number = CHANNEL_RESIGN_DAYS,
): boolean {
  return resignDue(channel.expiresAt, now, days);
}

// ---------------------------------------------------------------------------------------------
// Release documents.

/**
 * Whether a release document may point a download at `url` for release `tag`: only this release's
 * GitHub download URLs (`https://github.com/Brainwires/deno/releases/download/<tag>/<file>`) or a
 * file under `https://denext.dev/runtime/`. No credentials, port, query, fragment, escaped
 * characters or `..` segments.
 *
 * @param url The artifact URL.
 * @param tag The release tag.
 * @returns Whether it is allowed.
 */
export function allowedArtifactUrl(url: string, tag: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (
    u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" ||
    u.search !== "" || u.hash !== "" || url.includes("%") || url.includes("\\")
  ) return false;
  const segments = u.pathname.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  if (u.hostname === "github.com") {
    const want = [...CHANNEL_REPOSITORY.split("/"), "releases", "download", tag];
    return segments.length === want.length + 1 && want.every((s, i) => segments[i] === s);
  }
  return u.hostname === "denext.dev" && segments.length >= 2 && segments[0] === "runtime";
}

/** An archive's sources (its URL, then its fallbacks), checked: allowed URLs, no headers. */
function checkSources(t: DenoToolchainArtifact, tag: string, where: string): void {
  const sources = [t, ...(t.fallbacks ?? [])];
  const bad = sources.find((f) => typeof f.url !== "string" || !allowedArtifactUrl(f.url, tag));
  if (bad) throw badDocument(`${where}: ${bad.url} is not an allowed download URL`);
  if (sources.some((f) => f.headers !== undefined)) {
    throw badDocument(`${where}: request headers are not allowed`);
  }
}

/** One archive the document pins, checked: an allowed URL (and fallbacks), a SHA-256, a size. */
function checkArtifact(
  a: DenoToolchainArtifact | DesktopRuntimeArtifact,
  tag: string,
  where: string,
): void {
  checkSources(a as DenoToolchainArtifact, tag, where);
  if (typeof a.sha256 !== "string" || !SHA256.test(a.sha256)) {
    throw badDocument(`${where}: bad sha256`);
  }
  if (!Number.isSafeInteger(a.size) || (a.size as number) <= 0) {
    throw badDocument(`${where}: bad size`);
  }
}

/** The toolchain pin's archives (CLI, then denort), each with where it sits. */
function toolchainArtifacts(pin: DenoToolchainPin): [string, DenoToolchainArtifact][] {
  return [
    ...Object.entries(pin.targets ?? {}).map(([k, a]) =>
      [`toolchain ${k}`, a] as [string, DenoToolchainArtifact]
    ),
    ...Object.entries(pin.denort ?? {}).map(([k, a]) =>
      [`denort ${k}`, a] as [string, DenoToolchainArtifact]
    ),
  ];
}

/** The desktop pin's archives, each with where it sits. */
function desktopArtifacts(pin: DesktopRuntimePin): [string, DesktopRuntimeArtifact][] {
  return Object.entries(pin.targets ?? {}).flatMap(([k, t]) =>
    (["webview", "cef"] as const).flatMap((b) =>
      t[b] ? [[`desktop ${k} ${b}`, t[b]!] as [string, DesktopRuntimeArtifact]] : []
    )
  );
}

/** Refuse a pin that is not schema 1 of `entry`'s release, or that nests a `rollback`. */
function checkPinIdentity(
  pin: { schema?: unknown; version?: unknown; tag?: unknown; deno?: unknown; rollback?: unknown },
  name: string,
  entry: RuntimeChannelRelease,
): void {
  if (pin?.schema !== 1) throw badDocument(`the ${name} pin is not schema 1`);
  if (pin.version !== entry.version || pin.tag !== entry.tag) {
    throw badDocument(
      `the ${name} pin is ${pin.version} (${pin.tag}), the index says ${entry.version}`,
    );
  }
  if (pin.deno !== entry.deno) {
    throw badDocument(`the ${name} pin's deno ${pin.deno} != ${entry.deno}`);
  }
  if (pin.rollback !== undefined) throw badDocument(`the ${name} pin carries a rollback`);
}

/** Refuse a toolchain pin whose esbuild / glibc disagree with `entry`, or that pins nothing. */
function checkToolchainFacts(pin: DenoToolchainPin, entry: RuntimeChannelRelease): void {
  const targets = Object.entries(pin.targets ?? {});
  if (targets.length === 0) throw badDocument("the toolchain pin names no target");
  for (const [k, a] of targets) {
    if (a.esbuild?.version !== entry.esbuild) {
      throw badDocument(`toolchain ${k}: esbuild ${a.esbuild?.version} != ${entry.esbuild}`);
    }
  }
  const glibc = (pin as { minGlibc?: string }).minGlibc ?? null;
  if (glibc !== entry.minGlibc) throw badDocument(`minGlibc ${glibc} != ${entry.minGlibc}`);
}

/**
 * Check a parsed release document against the index entry that names it: both pins are schema 1
 * of that release (version, tag, Deno), carry no `rollback`, agree with the entry's esbuild,
 * laufey API and glibc, and every archive (fallbacks included) downloads only from an allowed URL
 * ({@linkcode allowedArtifactUrl}) with a SHA-256 and a size.
 *
 * @param raw The parsed document.
 * @param entry The index entry.
 * @returns The document.
 * @throws {RuntimeChannelError} When it is refused (`document`).
 */
export function checkReleaseDocument(
  raw: unknown,
  entry: RuntimeChannelRelease,
): RuntimeReleaseDocument {
  const doc = raw as Partial<RuntimeReleaseDocument> | null;
  if (
    typeof doc?.toolchain !== "object" || typeof doc?.desktop !== "object" || !doc.toolchain ||
    !doc.desktop
  ) {
    throw badDocument("expected { toolchain, desktop }");
  }
  checkPinIdentity(doc.toolchain, "toolchain", entry);
  checkPinIdentity(doc.desktop, "desktop", entry);
  checkToolchainFacts(doc.toolchain, entry);
  if (doc.desktop.laufeyApiVersion !== entry.laufeyApi) {
    throw badDocument(`laufey API ${doc.desktop.laufeyApiVersion} != ${entry.laufeyApi}`);
  }
  for (const [where, a] of toolchainArtifacts(doc.toolchain)) checkArtifact(a, entry.tag, where);
  for (const [where, a] of desktopArtifacts(doc.desktop)) checkArtifact(a, entry.tag, where);
  return doc as RuntimeReleaseDocument;
}

/**
 * Verify a fetched release document: its bytes must be exactly the size and SHA-256 the entry
 * names (checked before parsing), then {@linkcode checkReleaseDocument}.
 *
 * @param text The document.
 * @param entry The index entry (or a lock's record of it).
 * @returns The document.
 * @throws {RuntimeChannelError} When it is refused (`document`).
 */
export async function verifyReleaseDocument(
  text: string,
  entry: RuntimeChannelRelease,
): Promise<RuntimeReleaseDocument> {
  const size = new TextEncoder().encode(text).byteLength;
  if (size !== entry.doc.size) throw badDocument(`${size} bytes, the index says ${entry.doc.size}`);
  const sha = await sha256Hex(text);
  if (sha !== entry.doc.sha256) throw badDocument(`sha256 ${sha} != ${entry.doc.sha256}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badDocument("not JSON");
  }
  return checkReleaseDocument(raw, entry);
}

/**
 * A release document's served text: two-space indented JSON with one trailing newline, so the
 * same pins always hash the same.
 *
 * @param doc The document.
 * @returns The text.
 */
export function releaseDocumentText(doc: RuntimeReleaseDocument): string {
  return JSON.stringify({ toolchain: doc.toolchain, desktop: doc.desktop }, null, 2) + "\n";
}

/** What an index entry records beyond what the document itself says. */
export interface ReleaseEntryMeta {
  /** When the GitHub release was published (RFC 3339). */
  readonly releasedAt: string;
  /** The oldest denext proven to run on it. */
  readonly minDenext: string;
  readonly maxDenext?: string;
  readonly security?: boolean;
}

/**
 * The index entry for `doc`, and the document's text it hashes: the version, tag, Deno, esbuild,
 * laufey API and glibc come from the pins, the rest from `meta`; the result is checked as a
 * verifier would check it.
 *
 * @param doc The release document.
 * @param meta The release date and the compatibility range.
 * @returns The entry and the text to publish as `releases/<version>.json`.
 * @throws {RuntimeChannelError} When the document or the entry would be refused.
 */
export async function releaseEntryFor(
  doc: RuntimeReleaseDocument,
  meta: ReleaseEntryMeta,
): Promise<{ entry: RuntimeChannelRelease; text: string }> {
  const text = releaseDocumentText(doc);
  const first = Object.values(doc.toolchain.targets ?? {})[0];
  const entry = checkChannelRelease({
    version: doc.toolchain.version,
    tag: doc.toolchain.tag,
    deno: doc.toolchain.deno,
    releasedAt: meta.releasedAt,
    minDenext: meta.minDenext,
    ...(meta.maxDenext ? { maxDenext: meta.maxDenext } : {}),
    esbuild: first?.esbuild?.version,
    laufeyApi: doc.desktop.laufeyApiVersion,
    minGlibc: (doc.toolchain as { minGlibc?: string }).minGlibc ?? null,
    ...(meta.security ? { security: true } : {}),
    doc: { sha256: await sha256Hex(text), size: new TextEncoder().encode(text).byteLength },
  });
  checkReleaseDocument(JSON.parse(text), entry);
  return { entry, text };
}

/**
 * Where a release document is served under each base, in order.
 *
 * @param version The runtime version.
 * @param bases The bases (default {@linkcode CHANNEL_BASES}).
 * @returns The URLs.
 */
export function releaseDocumentUrls(
  version: string,
  bases: readonly string[] = CHANNEL_BASES,
): string[] {
  return bases.map((b) => new URL(`releases/${version}.json`, b).href);
}

// ---------------------------------------------------------------------------------------------
// Keys, cache and loading.

let keysFileHonoured = false;

/**
 * Test-only: let {@linkcode CHANNEL_KEYS_FILE_ENV} replace the compiled-in keys in this process.
 * Nothing in denext calls it, so the environment alone can never swap the keys.
 *
 * @param on Whether to honour it (default `true`).
 */
export function honourChannelKeysFileForTests(on = true): void {
  keysFileHonoured = on;
}

/**
 * The public keys indexes are verified with: the compiled-in ones, or (tests, after
 * {@linkcode honourChannelKeysFileForTests}) the JSON array in {@linkcode CHANNEL_KEYS_FILE_ENV}'s
 * file. Empty: no key is configured, and the channel is absent.
 *
 * @param env Env reader.
 * @returns The keys.
 */
export function channelKeys(env: EnvGet = processEnv): string[] {
  const file = keysFileHonoured ? env(CHANNEL_KEYS_FILE_ENV) : undefined;
  if (!file) return RUNTIME_CHANNEL_PUBLIC_KEYS.filter((k) => k !== "");
  return readKeysFile(file);
}

/** How the loader reaches the index. */
export type ChannelMode = SignedFetchMode;

/** Options for {@linkcode loadRuntimeChannel}. */
export interface LoadChannelOptions {
  /** Default `fetch`: the network only when the cached index is older than 12 hours. */
  readonly mode?: ChannelMode;
  readonly env?: EnvGet;
  /** Default `<DENO_DIR>/denext-deno`. */
  readonly cacheRoot?: string;
  /** Default {@linkcode channelKeys}. */
  readonly keys?: readonly string[];
  /**
   * Withdrawn channel keys (SPKI SHA-256 hex), in place of the revoked-runtimes list's: with
   * this set the list is not loaded at all (tests, a caller that already holds the list).
   */
  readonly revokedKeys?: readonly string[];
  /**
   * How the revoked-runtimes list is loaded for its withdrawn channel keys (default
   * {@linkcode loadRuntimeRevocations}): in this load's `mode`, with its `env`, `cacheRoot`,
   * clock, `fetch` and `netGranted`, and these options over them.
   */
  readonly revocations?:
    & Partial<LoadRevocationsOptions>
    & { readonly load?: (options: LoadRevocationsOptions) => Promise<LoadedRevocations> };
  /** Default {@linkcode CHANNEL_BASES}. */
  readonly bases?: readonly string[];
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** Default {@linkcode RUNTIME_CHANNEL_MIN_SEQUENCE}. */
  readonly minSequence?: number;
  /** Whether the process may reach `url` without a prompt (default: a permission query). */
  readonly netGranted?: (url: string) => Promise<boolean>;
}

/**
 * Why the channel is absent, for a message. `no-revocations`: a load that may reach the network
 * could not get a current revoked-runtimes list, so it cannot tell whether a channel key was
 * withdrawn and takes no index.
 */
export type ChannelAbsence =
  | "off"
  | "no-key"
  | "revoked-key"
  | "no-revocations"
  | "unavailable"
  | "expired";

/** What {@linkcode loadRuntimeChannel} found. */
export interface LoadedChannel {
  /** The index in force (verified, current), or `null`: the channel is absent. */
  readonly channel: RuntimeChannel | null;
  readonly source: "none" | "cache" | "network";
  /** Why there is no index (`null` while there is one). */
  readonly absent: ChannelAbsence | null;
  /** A verified index ignored because it expired. */
  readonly expired: RuntimeChannel | null;
}

/** What verifying met besides a good index: an expired one, a withdrawn key. */
interface Seen {
  expired: RuntimeChannel | null;
  revokedKey: boolean;
}

/** The withdrawn channel keys, and whether they come from a list in force. */
interface WithdrawnKeys {
  readonly revoked: readonly string[];
  /**
   * Whether the keys are known: given by the caller, read from a current revoked-runtimes list,
   * or the revocation check is off (no key configured, or turned off by its switch).
   */
  readonly current: boolean;
}

/**
 * The withdrawn channel keys the revoked-runtimes list names. The list is loaded the way the
 * channel is (`mode`, and the same cache directory): a load that may fetch an index fetches the
 * list first when its cached copy is missing or stale, so a machine with no cached list (a fresh
 * install) learns of a withdrawn key before it trusts an index signed with it.
 */
async function withdrawnChannelKeys(
  options: LoadChannelOptions,
  env: EnvGet,
  mode: ChannelMode,
): Promise<WithdrawnKeys> {
  if (options.revokedKeys) return { revoked: options.revokedKeys, current: true };
  const { load = loadRuntimeRevocations, ...over } = options.revocations ?? {};
  const loaded = await load({
    mode,
    env,
    ...(options.cacheRoot !== undefined ? { cacheRoot: options.cacheRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.netGranted ? { netGranted: options.netGranted } : {}),
    ...over,
  });
  return {
    revoked: loaded.list?.revokedChannelKeys ?? [],
    current: !loaded.configured || loaded.list !== null,
  };
}

/** Verify `text`, recording an expired index and a withdrawn key in `seen`. */
async function tryVerify(
  text: string,
  keys: readonly string[],
  o: VerifyChannelOptions,
  seen: Seen,
): Promise<RuntimeChannel | null> {
  try {
    return await verifyRuntimeChannel(text, keys, o);
  } catch (err) {
    if (err instanceof RuntimeChannelError) {
      if (err.code === "expired") seen.expired = err.channel!;
      if (err.code === "revoked-key") seen.revokedKey = true;
    }
    return null;
  }
}

/** One fetched, verified index. */
interface Fetched {
  readonly text: string;
  readonly channel: RuntimeChannel;
}

/** How a fetch round runs. */
interface FetchRound {
  readonly bases: readonly string[];
  readonly keys: readonly string[];
  readonly verify: VerifyChannelOptions;
  readonly budgetMs: number;
  readonly fetch: typeof fetch;
  readonly netGranted: (url: string) => Promise<boolean>;
}

/** The index one base serves, verified; `null` for none. */
async function fetchOne(base: string, r: FetchRound, signal: AbortSignal, seen: Seen) {
  const url = new URL(CHANNEL_FILE, base).href;
  if (!await r.netGranted(url)) return null;
  const text = await fetchTextCapped(url, signal, r.fetch, CHANNEL_MAX_BYTES).catch(() => null);
  if (text === null) return null;
  const channel = await tryVerify(text, r.keys, r.verify, seen);
  return channel ? { text, channel } : null;
}

/** The highest-sequence index any base serves that verifies (all asked at once), or `null`. */
async function fetchBest(r: FetchRound, seen: Seen): Promise<Fetched | null> {
  const signal = AbortSignal.timeout(r.budgetMs);
  const found = await Promise.all(r.bases.map((b) => fetchOne(b, r, signal, seen)));
  let best: Fetched | null = null;
  for (const f of found) if (f && (!best || f.channel.sequence > best.channel.sequence)) best = f;
  return best;
}

const absentAs = (
  absent: ChannelAbsence,
  expired: RuntimeChannel | null = null,
): LoadedChannel => ({
  channel: null,
  source: "none",
  absent: expired ? "expired" : absent,
  expired,
});

/** The result for `channel`, or why there is none. */
function found(
  channel: RuntimeChannel | null,
  source: "cache" | "network",
  seen: Seen,
): LoadedChannel {
  if (channel) return { channel, source, absent: null, expired: null };
  return absentAs(seen.revokedKey ? "revoked-key" : "unavailable", seen.expired);
}

/**
 * The keys in force, or why there are none. In a mode that may reach the network (`fetch`,
 * `force`) the withdrawn keys must be known ({@linkcode WithdrawnKeys.current}): without a
 * current revoked-runtimes list the channel is absent (`no-revocations`) rather than trusted on
 * keys that may have been withdrawn. `cache-only` keeps what the machine already verified.
 */
async function liveKeys(
  options: LoadChannelOptions,
  env: EnvGet,
  mode: ChannelMode,
): Promise<{ keys: string[]; revoked: readonly string[] } | ChannelAbsence> {
  if (mode === "off" || env(CHANNEL_CHECK_ENV)?.trim() === "0") return "off";
  const keys = [...(options.keys ?? channelKeys(env))];
  if (keys.length === 0) return "no-key";
  const { revoked, current } = await withdrawnChannelKeys(options, env, mode);
  if (!current && mode !== "cache-only") return "no-revocations";
  const { live } = await partitionChannelKeys(keys, revoked);
  return live.length === 0 ? "revoked-key" : { keys, revoked };
}

/** What this machine holds: its bookkeeping, the cached index and the replay floor they give. */
interface Held {
  readonly keySet: string;
  readonly state: SignedCacheState | null;
  readonly cached: RuntimeChannel | null;
  readonly floor: number;
}

/**
 * The cached index (re-verified under `keys`, at or above the compiled-in floor) and the replay
 * floor: the held index's sequence, lowered (never raised) by the unsigned bookkeeping's.
 */
async function readHeld(
  root: string,
  keys: readonly string[],
  verify: VerifyChannelOptions,
  seen: Seen,
): Promise<Held> {
  const keySet = await keySetId(keys);
  const state = await readCacheState(root, STATE_FILE, keySet);
  const text = await Deno.readTextFile(join(root, CACHE_FILE)).catch(() => null);
  const cached = text === null ? null : await tryVerify(text, keys, verify, seen);
  const held = cached ?? seen.expired;
  const own = held ? Math.min(held.sequence, state?.sequence ?? held.sequence) : 0;
  return { keySet, state, cached, floor: Math.max(verify.minSequence ?? 0, own) };
}

/** Remember a fetch round: the index and its bookkeeping, or (`null`) that it failed. */
async function record(root: string, held: Held, now: number, fetched: Fetched | null) {
  const base = { schema: 1 as const, keys: held.keySet };
  if (fetched) await writeQuietly(root, CACHE_FILE, fetched.text);
  const next: SignedCacheState = fetched
    ? { ...base, sequence: fetched.channel.sequence, fetchedAt: now }
    : { ...base, sequence: held.floor, fetchedAt: held.state?.fetchedAt ?? 0, failedAt: now };
  await writeQuietly(root, STATE_FILE, JSON.stringify(next) + "\n");
}

/** The cache directory, or `null` when there is none to be had. */
function cacheRootOf(options: LoadChannelOptions, env: EnvGet): string | null {
  try {
    return options.cacheRoot ?? toolchainCacheRoot(env);
  } catch {
    return null;
  }
}

/**
 * The runtime channel index in force on this machine: the cached copy (re-verified on every
 * read), refreshed from every base at once when `mode` says so and the cache is stale. The replay
 * floor is the higher of the compiled-in sequence and the cached index's (lowered, never raised,
 * by the unsigned bookkeeping). Never throws and never waits past the budget.
 *
 * @param options The mode and seams.
 * @returns The index, where it came from, or why the channel is absent.
 */
export async function loadRuntimeChannel(options: LoadChannelOptions = {}): Promise<LoadedChannel> {
  const env = options.env ?? processEnv;
  const mode = options.mode ?? "fetch";
  const k = await liveKeys(options, env, mode);
  if (typeof k === "string") return absentAs(k);
  const root = cacheRootOf(options, env);
  if (root === null) return absentAs("unavailable");
  const now = (options.now ?? Date.now)();
  const seen: Seen = { expired: null, revokedKey: false };
  const verify = {
    now,
    minSequence: options.minSequence ?? RUNTIME_CHANNEL_MIN_SEQUENCE,
    revokedKeys: k.revoked,
  };
  const held = await readHeld(root, k.keys, verify, seen);
  if (!fetchDue(mode, held.state, now, CHANNEL_TTL_MS, FAILED_RETRY_MS)) {
    return found(held.cached, "cache", seen);
  }
  const fetched = await fetchBest({
    bases: options.bases ?? CHANNEL_BASES,
    keys: k.keys,
    verify: { ...verify, minSequence: held.floor },
    budgetMs: options.budgetMs ?? (mode === "force" ? FORCE_BUDGET_MS : FETCH_BUDGET_MS),
    fetch: options.fetch ?? fetch,
    netGranted: options.netGranted ?? netGrantedByQuery,
  }, seen);
  // A run on test keys never writes what a later run reads.
  if (!env(CHANNEL_KEYS_FILE_ENV)) await record(root, held, now, fetched);
  return fetched ? found(fetched.channel, "network", seen) : found(held.cached, "cache", seen);
}

/** Options for {@linkcode loadReleaseDocument}. */
export interface LoadReleaseDocumentOptions {
  readonly env?: EnvGet;
  readonly cacheRoot?: string;
  readonly bases?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly budgetMs?: number;
  /** Read the cache only, never the network. */
  readonly offline?: boolean;
}

/**
 * The release document `entry` names: the cached copy when it still hashes to the entry, else the
 * first base that serves one that does (cached for next time). Every copy is verified
 * ({@linkcode verifyReleaseDocument}); a document whose hash differs is never used.
 *
 * @param entry The index entry (or a lock's record of it).
 * @param options The seams.
 * @returns The document.
 * @throws {RuntimeChannelError} When no copy verifies (`document`).
 */
export async function loadReleaseDocument(
  entry: RuntimeChannelRelease,
  options: LoadReleaseDocumentOptions = {},
): Promise<RuntimeReleaseDocument> {
  const env = options.env ?? processEnv;
  const root = options.cacheRoot ?? toolchainCacheRoot(env);
  const name = join("releases", `${entry.version}.json`);
  const cached = await Deno.readTextFile(join(root, name)).catch(() => null);
  if (cached !== null) {
    const doc = await verifyReleaseDocument(cached, entry).catch(() => null);
    if (doc) return doc;
  }
  if (options.offline) throw badDocument(`${entry.version} is not cached (offline)`);
  const signal = AbortSignal.timeout(options.budgetMs ?? FORCE_BUDGET_MS);
  const problems: string[] = [];
  for (const url of releaseDocumentUrls(entry.version, options.bases)) {
    try {
      const text = await fetchTextCapped(
        url,
        signal,
        options.fetch ?? fetch,
        RELEASE_DOCUMENT_MAX_BYTES,
      );
      const doc = await verifyReleaseDocument(text, entry);
      await writeQuietly(root, name, text);
      return doc;
    } catch (err) {
      problems.push(`${url}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw badDocument(`no copy of ${entry.version} verifies (${problems.join("; ")})`);
}
