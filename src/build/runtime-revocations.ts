// The signed list of revoked denext runtime releases: a Deno toolchain (`cli`: the `deno` and
// `denort` archives) or a Deno Desktop runtime (`desktop`: libdenort and the laufey hosts) that
// maintainers pulled after release, for every target or only some. denext reads it before it
// runs a pinned runtime and, when the pin is revoked for this host, runs the previous release the
// pin names as its `rollback` instead (deno-toolchain.ts, desktop-runtime.ts) — or the pinned one
// with a warning when there is no safe fallback. The list can only disable a compiled-in pin and
// choose among the compiled-in pins: it never names a binary of its own, so JSR stays the only
// trust root and a leaked signing key can do no more than force that one step back.
//
// The document (`runtime-revocations.json`) is an envelope `{ "signed": "<JSON>", "signature":
// "<base64 r‖s>" }`: ECDSA P-256 / SHA-256 over `"denext-runtime-revocations-v1\n" + signed`, the
// shape of the full-app update manifest (app-update.ts). The signature is checked over the bytes
// before they are parsed, against the public keys compiled in (runtime-revocation-keys.ts). The
// signed payload carries `expiresAt` (a list at or after it is ignored) and a `sequence` that only
// grows (a list below the one this machine holds is ignored), so an old list can neither be
// replayed nor served forever; a list dated more than a day ahead of the clock is refused. The
// replay floor is the sequence of the cached list as SIGNED (re-verified under the keys in force):
// the unsigned bookkeeping file beside it records the key set it was written under and can lower
// the floor but never raise it, so no local write can turn the check off for good. Unknown fields
// are ignored; an unknown `schema` is ignored as a whole.
//
// Transport is untrusted (trust comes from the signature): denext.dev first, then a mirror on
// GitHub, within a budget (1.5 s; 5 s for `toolchain status` / `install` / `doctor`). The list is
// cached under the toolchain cache with a 12 h lifetime and re-verified on every read. Nothing
// here ever fails a command: a network, HTTP, size or signature problem means the cached list, or
// none. With no public key compiled in, the whole check is a no-op: no cache read, no fetch.

import { join } from "@std/path";
import { denoCacheDir } from "./deno-cache-dir.ts";
import { fromBase64, toBase64 } from "./ota-signing.ts";
import { encodeHex } from "@std/encoding/hex";
import { RUNTIME_REVOCATION_PUBLIC_KEYS } from "./runtime-revocation-keys.ts";

/** What the signature covers before the signed string. */
export const REVOCATION_SIGNATURE_DOMAIN = "denext-runtime-revocations-v1\n";
/** Where the list is fetched from, in order: denext.dev, then the fork's orphan branch. */
export const REVOCATION_URLS: readonly string[] = [
  "https://denext.dev/runtime/revocations.json",
  "https://raw.githubusercontent.com/Brainwires/deno/denext-revocations/runtime-revocations.json",
];
/** The largest list accepted (fetched or cached). */
export const REVOCATION_MAX_BYTES = 64 * 1024;
/** How long a fetched list is used before it is fetched again. */
const REVOCATION_TTL_MS = 12 * 3600_000;
/** How long after a failed fetch the next is tried (offline machines do not pay every run). */
const FAILED_RETRY_MS = 3600_000;
/** The time a command may spend fetching the list. */
export const REVOCATION_FETCH_BUDGET_MS = 1500;
/** The time `toolchain status` / `install` and `doctor` may spend fetching it. */
const REVOCATION_FORCE_BUDGET_MS = 5000;
/** How long a signed list stays valid when no expiry is given. */
const REVOCATION_DEFAULT_EXPIRY_DAYS = 60;

/** How far ahead of the clock a list's `issuedAt` / `sequence` may be (a skewed signer). */
export const REVOCATION_MAX_FUTURE_MS = 24 * 3600_000;

/** `0` turns the check off. */
export const REVOCATION_CHECK_ENV = "DENEXT_REVOCATION_CHECK";
/**
 * Test-only: a JSON file holding the public keys (base64 SPKI) to verify with, instead of the
 * compiled-in ones. Honoured only after {@linkcode honourRevocationKeysFileForTests} (nothing in
 * denext calls it, so the variable alone does nothing), and while it is set nothing is written to
 * the cache.
 */
export const REVOCATION_KEYS_FILE_ENV = "DENEXT_REVOCATION_KEYS_FILE";
/** Set on the processes a command starts once it said a revocation, so they don't repeat it. */
export const REVOCATION_NOTICED_ENV = "DENEXT_REVOCATION_NOTICED";
/** `=<version>`: ship that revoked runtime anyway (`build --compile`, `desktop build | package`). */
export const ALLOW_REVOKED_RUNTIME_ENV = "DENEXT_ALLOW_REVOKED_RUNTIME";

/** The cached envelope, beside the toolchain versions. */
const CACHE_FILE = "revocations.json";
/** The highest sequence accepted and when the list was last fetched. */
const STATE_FILE = "revocations.state.json";
const DAY_MS = 24 * 3600_000;

/** A runtime component a revocation names. */
export type RuntimeComponent = "cli" | "desktop";

/** One revoked release. */
export interface RuntimeRevocation {
  /** `cli`: the Deno toolchain's `deno` and `denort`; `desktop`: the Deno Desktop runtime. */
  readonly component: RuntimeComponent;
  /** The runtime version (`3.0.0-denext.3`). */
  readonly version: string;
  /** The Rust target triples it is revoked for; absent: every target. */
  readonly targets?: readonly string[];
  /** Why, in one line. */
  readonly reason: string;
  /** An https link with the details. */
  readonly advisory?: string;
  /** What fixes it (`denext 4.10.3`). */
  readonly fixedIn?: string;
}

/** The signed payload. */
export interface RuntimeRevocationList {
  readonly schema: 1;
  /** RFC 3339. */
  readonly issuedAt: string;
  /** RFC 3339; a list at or after it is ignored. */
  readonly expiresAt: string;
  /** The Unix time in seconds at signing; only ever grows. */
  readonly sequence: number;
  readonly revoked: readonly RuntimeRevocation[];
}

/** The served document. */
export interface RevocationEnvelope {
  readonly signed: string;
  /** Base64 raw r‖s. */
  readonly signature: string;
}

/** Why a list was refused. */
export type RevocationProblem =
  | "size"
  | "format"
  | "signature"
  | "invalid"
  | "expired"
  | "replayed"
  | "future";

/** A refused list ({@linkcode verifyRevocationDocument}). */
export class RevocationListError extends Error {
  override name = "RevocationListError";
  /**
   * @param code Why.
   * @param message What to say.
   * @param list The payload, when it verified but is expired or replayed.
   */
  constructor(
    readonly code: RevocationProblem,
    message: string,
    readonly list?: RuntimeRevocationList,
  ) {
    super(message);
  }
}

/** Env reader. */
type EnvGet = (name: string) => string | undefined;
const processEnv: EnvGet = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const encoder = new TextEncoder();
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** The bytes a signature covers. */
function signedBytes(signed: string): Uint8Array {
  return encoder.encode(REVOCATION_SIGNATURE_DOMAIN + signed);
}

/** Whether `signature` over `signed` verifies with any of `keys` (base64 SPKI). */
async function verifiesWithAny(
  signed: string,
  signature: string,
  keys: readonly string[],
): Promise<boolean> {
  for (const key of keys) {
    try {
      const pub = await crypto.subtle.importKey(
        "spki",
        fromBase64(key) as BufferSource,
        ECDSA,
        false,
        ["verify"],
      );
      const sig = fromBase64(signature) as BufferSource;
      if (await crypto.subtle.verify(SIGN, pub, sig, signedBytes(signed) as BufferSource)) {
        return true;
      }
    } catch {
      // A malformed key or signature verifies nothing.
    }
  }
  return false;
}

const invalid = (why: string) => new RevocationListError("invalid", `the list is invalid: ${why}`);

/** Whether `v` is an RFC 3339 timestamp `Date.parse` reads. */
function isTime(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v));
}

/** `v` when it is absent or a string matching `ok`, else a refusal naming `field`. */
function optionalString(v: unknown, field: string, ok: (s: string) => boolean): void {
  if (v !== undefined && (typeof v !== "string" || !ok(v))) throw invalid(`bad ${field}`);
}

/** Refuse `targets` unless it is absent or a list of non-empty strings. */
function checkTargets(targets: unknown, version: string): void {
  if (targets === undefined) return;
  const ok = Array.isArray(targets) && targets.every((t) => typeof t === "string" && t !== "");
  if (!ok) throw invalid(`${version}: targets must be a list of target triples`);
}

/** Refuse an entry without a version or a reason. */
function checkRequired(e: Record<string, unknown>): void {
  if (typeof e.version !== "string" || e.version === "") throw invalid("an entry has no version");
  if (typeof e.reason !== "string") throw invalid(`${e.version} has no reason`);
}

/** The fields an entry may leave out, as given. */
function optionalFields(e: Record<string, unknown>): Partial<RuntimeRevocation> {
  optionalString(e.advisory, "advisory", (s) => s.startsWith("https://"));
  optionalString(e.fixedIn, "fixedIn", (s) => s !== "");
  const out: { targets?: string[]; advisory?: string; fixedIn?: string } = {};
  if (e.targets !== undefined) out.targets = e.targets as string[];
  if (e.advisory !== undefined) out.advisory = e.advisory as string;
  if (e.fixedIn !== undefined) out.fixedIn = e.fixedIn as string;
  return out;
}

/** One entry, checked; `null` for a component this denext does not know (forward compatible). */
function checkEntry(raw: unknown): RuntimeRevocation | null {
  if (typeof raw !== "object" || raw === null) throw invalid("an entry is not an object");
  const e = raw as Record<string, unknown>;
  if (e.component !== "cli" && e.component !== "desktop") return null;
  checkRequired(e);
  checkTargets(e.targets, e.version as string);
  return {
    component: e.component,
    version: e.version as string,
    reason: e.reason as string,
    ...optionalFields(e),
  };
}

/**
 * Check a schema-1 payload's fields and keep what this denext reads (unknown fields and entries
 * of unknown components dropped).
 *
 * @param raw The parsed payload.
 * @returns The list.
 * @throws {RevocationListError} When a known field is malformed.
 */
export function checkRevocationList(raw: unknown): RuntimeRevocationList {
  const p = raw as Record<string, unknown>;
  if (p?.schema !== 1) throw invalid("schema must be 1");
  if (!isTime(p.issuedAt) || !isTime(p.expiresAt)) throw invalid("bad issuedAt / expiresAt");
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 0) {
    throw invalid("sequence must be a non-negative integer");
  }
  if (!Array.isArray(p.revoked)) throw invalid("revoked must be a list");
  const revoked = p.revoked.map(checkEntry).filter((e): e is RuntimeRevocation => e !== null);
  return {
    schema: 1,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    sequence: p.sequence as number,
    revoked,
  };
}

/** The envelope inside `text`, checked for shape and size only. */
function envelopeOf(text: string): RevocationEnvelope {
  if (encoder.encode(text).byteLength > REVOCATION_MAX_BYTES) {
    throw new RevocationListError("size", `the list is larger than ${REVOCATION_MAX_BYTES} bytes`);
  }
  let e: Partial<RevocationEnvelope> | null;
  try {
    e = JSON.parse(text);
  } catch {
    e = null;
  }
  if (typeof e?.signed !== "string" || typeof e.signature !== "string") {
    throw new RevocationListError("format", "not a { signed, signature } envelope");
  }
  return e as RevocationEnvelope;
}

/** Options for {@linkcode verifyRevocationDocument}. */
export interface VerifyRevocationOptions {
  /** The clock, epoch ms (default now). */
  readonly now?: number;
  /** The highest sequence accepted before: a lower one is refused (`replayed`). */
  readonly minSequence?: number;
}

/**
 * Verify a served document against `keys` — its size, its signature over the exact bytes, then
 * its fields, expiry and sequence — and return the list. A payload of an unknown `schema` is
 * ignored as a whole: `null`.
 *
 * @param text The document.
 * @param keys The public keys (base64 SPKI); a signature from any one verifies.
 * @param options The clock and the sequence floor.
 * @returns The list, or `null` for an unknown schema.
 * @throws {RevocationListError} When it is refused (see its `code`).
 */
export async function verifyRevocationDocument(
  text: string,
  keys: readonly string[],
  options: VerifyRevocationOptions = {},
): Promise<RuntimeRevocationList | null> {
  const e = envelopeOf(text);
  if (!await verifiesWithAny(e.signed, e.signature, keys)) {
    throw new RevocationListError("signature", "the signature does not verify");
  }
  let payload: { schema?: unknown };
  try {
    payload = JSON.parse(e.signed);
  } catch {
    throw invalid("the signed payload is not JSON");
  }
  if (payload?.schema !== 1) return null;
  const list = checkRevocationList(payload);
  const now = options.now ?? Date.now();
  if (
    list.sequence * 1000 > now + REVOCATION_MAX_FUTURE_MS ||
    Date.parse(list.issuedAt) > now + REVOCATION_MAX_FUTURE_MS
  ) {
    throw new RevocationListError(
      "future",
      `the list is dated ahead of this clock (issued ${list.issuedAt}, sequence ${list.sequence})`,
    );
  }
  if (now >= Date.parse(list.expiresAt)) {
    throw new RevocationListError("expired", `the list expired at ${list.expiresAt}`, list);
  }
  if (list.sequence < (options.minSequence ?? 0)) {
    throw new RevocationListError(
      "replayed",
      `the list's sequence ${list.sequence} is below the ${options.minSequence} already seen`,
      list,
    );
  }
  return list;
}

/**
 * Sign `list` into the served envelope (`scripts/runtime-revocations.ts`).
 *
 * @param list The payload (checked first).
 * @param key The ECDSA P-256 private key.
 * @returns The envelope, ready to `JSON.stringify` and publish.
 */
export async function signRevocationList(
  list: RuntimeRevocationList,
  key: CryptoKey,
): Promise<RevocationEnvelope> {
  checkRevocationList(list);
  const signed = JSON.stringify(list);
  const sig = await crypto.subtle.sign(SIGN, key, signedBytes(signed) as BufferSource);
  return { signed, signature: toBase64(new Uint8Array(sig)) };
}

/**
 * A list of `revoked` signed now: `issuedAt` now, `expiresAt` {@linkcode
 * REVOCATION_DEFAULT_EXPIRY_DAYS} days on, and `sequence` the Unix time in seconds — above
 * `previous`'s, whatever the clock says.
 *
 * @param revoked The entries.
 * @param now The signing time.
 * @param previous The list this one replaces, if any.
 * @returns The payload to sign.
 */
export function freshRevocationList(
  revoked: readonly RuntimeRevocation[],
  now: Date,
  previous?: { readonly sequence: number },
): RuntimeRevocationList {
  const sequence = Math.max(Math.floor(now.getTime() / 1000), (previous?.sequence ?? -1) + 1);
  return {
    schema: 1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REVOCATION_DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString(),
    sequence,
    revoked,
  };
}

/**
 * Whether a published list is due a re-sign: fewer than `days` days (30) remain before it
 * expires (or it already has). `deno task release` re-signs it then.
 *
 * @param list The published list.
 * @param now The clock, epoch ms.
 * @param days The margin.
 * @returns Whether to re-sign.
 */
export function revocationResignDue(
  list: Pick<RuntimeRevocationList, "expiresAt">,
  now: number = Date.now(),
  days = 30,
): boolean {
  const expires = Date.parse(list.expiresAt);
  return Number.isNaN(expires) || expires - now < days * DAY_MS;
}

/** Whether this process honours {@linkcode REVOCATION_KEYS_FILE_ENV} (tests only). */
let keysFileHonoured = false;

/**
 * Test-only: let {@linkcode REVOCATION_KEYS_FILE_ENV} replace the compiled-in keys in this
 * process. Nothing in denext calls it — a test module does — so the environment alone can never
 * swap the keys a list is verified with.
 *
 * @param on Whether to honour it (default `true`).
 */
export function honourRevocationKeysFileForTests(on = true): void {
  keysFileHonoured = on;
}

/**
 * The public keys lists are verified with: the compiled-in ones, or (tests, after
 * {@linkcode honourRevocationKeysFileForTests}) the JSON array of base64 SPKI keys in the file
 * {@linkcode REVOCATION_KEYS_FILE_ENV} names. Empty: no key is configured, and the check does
 * nothing.
 *
 * @param env Env reader.
 * @returns The keys.
 */
export function revocationKeys(env: EnvGet = processEnv): string[] {
  const file = keysFileHonoured ? env(REVOCATION_KEYS_FILE_ENV) : undefined;
  if (!file) return RUNTIME_REVOCATION_PUBLIC_KEYS.filter((k) => k !== "");
  try {
    const keys: unknown = JSON.parse(Deno.readTextFileSync(file));
    return Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k !== "") : [];
  } catch {
    return [];
  }
}

/**
 * Where the list is cached: the toolchain cache (`<DENO_DIR>/denext-deno`).
 *
 * @param env Env reader.
 * @returns The directory.
 */
export function revocationCacheRoot(env: EnvGet = processEnv): string {
  return join(denoCacheDir(env), "denext-deno");
}

/**
 * The id of a key set: the SHA-256 of its keys, sorted, one per line. The bookkeeping file records
 * it, and a file written under another key set (a test's keys, a rotated key) is ignored.
 *
 * @param keys The public keys.
 * @returns The hex digest.
 */
export async function revocationKeySetId(keys: readonly string[]): Promise<string> {
  const text = [...keys].sort().join("\n");
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** The cache's bookkeeping (unsigned: it can lower the replay floor, never raise it). */
interface RevocationState {
  readonly schema: 1;
  /** The key set it was written under ({@linkcode revocationKeySetId}). */
  readonly keys: string;
  /** The sequence of the list accepted last. */
  readonly sequence: number;
  /** When the list was last fetched (epoch ms). */
  readonly fetchedAt: number;
  /** When a fetch last failed (epoch ms). */
  readonly failedAt?: number;
}

/** The bookkeeping, when it was written under the key set `keys` (else `null`). */
async function readState(root: string, keys: string): Promise<RevocationState | null> {
  try {
    const s = JSON.parse(await Deno.readTextFile(join(root, STATE_FILE)));
    return s?.schema === 1 && s.keys === keys && Number.isSafeInteger(s.sequence) &&
        Number.isFinite(s.fetchedAt)
      ? s
      : null;
  } catch {
    return null;
  }
}

/** Write `text` to `root/name` atomically; best effort (a read-only cache only fetches sooner). */
async function writeQuietly(root: string, name: string, text: string): Promise<void> {
  const tmp = join(root, `.tmp-${crypto.randomUUID()}-${name}`);
  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, join(root, name));
  } catch {
    await Deno.remove(tmp).catch(() => {});
  }
}

/** How the check reaches the list. */
export type RevocationMode =
  /** No check. */
  | "off"
  /** The cached list only, never the network (`start`, `job`, a command's own children). */
  | "cache-only"
  /** Fetch when the cached list is older than its lifetime, within {@linkcode REVOCATION_FETCH_BUDGET_MS}. */
  | "fetch"
  /** Fetch now, within {@linkcode REVOCATION_FORCE_BUDGET_MS} (`toolchain status`, `install`, `doctor`). */
  | "force";

/** Options for {@linkcode loadRuntimeRevocations}. */
export interface LoadRevocationsOptions {
  /** Default `fetch`. */
  readonly mode?: RevocationMode;
  /** Env reader (default the process's). */
  readonly env?: EnvGet;
  /** Default {@linkcode revocationCacheRoot}. */
  readonly cacheRoot?: string;
  /** Default {@linkcode revocationKeys}. */
  readonly keys?: readonly string[];
  /** Default {@linkcode REVOCATION_URLS}. */
  readonly urls?: readonly string[];
  /** The fetch budget in ms (default by mode). */
  readonly budgetMs?: number;
  /** The clock, epoch ms. */
  readonly now?: () => number;
  /** Test seam. */
  readonly fetch?: typeof fetch;
  /** Whether this process may reach `url` without a prompt (default: a permission query). */
  readonly netGranted?: (url: string) => Promise<boolean>;
}

/** What {@linkcode loadRuntimeRevocations} found. */
export interface LoadedRevocations {
  /** Whether a key is configured and the check is on. */
  readonly configured: boolean;
  /** The list in force (verified, current), or `null`. */
  readonly list: RuntimeRevocationList | null;
  /** Where it came from. */
  readonly source: "none" | "cache" | "network";
  /** A verified list that was ignored because it expired (what `doctor` warns about). */
  readonly expired: RuntimeRevocationList | null;
}

const NOT_CONFIGURED: LoadedRevocations = {
  configured: false,
  list: null,
  source: "none",
  expired: null,
};

/** Whether the process may reach `url`'s host without being asked (never prompts). */
async function netGrantedByQuery(url: string): Promise<boolean> {
  try {
    const host = new URL(url).host;
    return (await Deno.permissions.query({ name: "net", host })).state === "granted";
  } catch {
    return false;
  }
}

/** The body of a GET of `url`, capped at {@linkcode REVOCATION_MAX_BYTES}, within `ms`. */
async function fetchCapped(url: string, ms: number, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > REVOCATION_MAX_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** What one source gave: a list, an expired list, or nothing. */
interface Fetched {
  readonly text: string;
  readonly list: RuntimeRevocationList;
}

/**
 * The first source in `urls` that serves a list verifying with `keys`, tried in order within
 * `budgetMs` overall (each gets what is left); `null` when none does. Records an expired list it
 * met in `expired`.
 */
async function fetchVerified(
  urls: readonly string[],
  keys: readonly string[],
  o: { budgetMs: number; now: number; minSequence: number; fetch: typeof fetch },
  netGranted: (url: string) => Promise<boolean>,
  expired: { list: RuntimeRevocationList | null },
): Promise<Fetched | null> {
  const deadline = performance.now() + o.budgetMs;
  for (const url of urls) {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) break;
    if (!await netGranted(url)) continue;
    try {
      const text = await fetchCapped(url, left, o.fetch);
      const list = await verifyRevocationDocument(text, keys, o);
      if (list) return { text, list };
    } catch (err) {
      if (err instanceof RevocationListError && err.code === "expired") expired.list = err.list!;
    }
  }
  return null;
}

/** The cached list, re-verified; `expired` gets a verified list that has expired. */
async function readCached(
  root: string,
  keys: readonly string[],
  o: { now: number; minSequence: number },
  expired: { list: RuntimeRevocationList | null },
): Promise<RuntimeRevocationList | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(root, CACHE_FILE));
  } catch {
    return null;
  }
  try {
    return await verifyRevocationDocument(text, keys, o);
  } catch (err) {
    if (err instanceof RevocationListError && err.code === "expired") expired.list = err.list!;
    return null;
  }
}

/** Whether `mode` fetches now, given the cache's bookkeeping. */
function fetchDue(mode: RevocationMode, state: RevocationState | null, now: number): boolean {
  if (mode === "force") return true;
  if (mode !== "fetch") return false;
  if (state === null) return true;
  const age = now - state.fetchedAt;
  if (age >= 0 && age < REVOCATION_TTL_MS) return false;
  const sinceFailure = now - (state.failedAt ?? -Infinity);
  return !(sinceFailure >= 0 && sinceFailure < FAILED_RETRY_MS);
}

/** Whether the check runs at all: a key is configured and {@linkcode REVOCATION_CHECK_ENV} is not `0`. */
function checkKeys(mode: RevocationMode, env: EnvGet, keys?: readonly string[]): string[] | null {
  if (mode === "off" || env(REVOCATION_CHECK_ENV)?.trim() === "0") return null;
  const found = [...(keys ?? revocationKeys(env))];
  return found.length > 0 ? found : null;
}

/**
 * The revoked-runtimes list in force on this machine: the cached copy (re-verified), refreshed
 * from the network when `mode` says so and the cache is stale. Never throws and never waits past
 * the budget; with no key configured, or {@linkcode REVOCATION_CHECK_ENV}`=0`, it reads and
 * fetches nothing.
 *
 * @param options The mode and seams.
 * @returns The list, where it came from, and an expired list it had to ignore.
 */
export async function loadRuntimeRevocations(
  options: LoadRevocationsOptions = {},
): Promise<LoadedRevocations> {
  const env = options.env ?? processEnv;
  const mode = options.mode ?? "fetch";
  const keys = checkKeys(mode, env, options.keys);
  const root = keys === null ? null : cacheRootOf(options, env);
  if (keys === null || root === null) return NOT_CONFIGURED;
  const now = (options.now ?? Date.now)();
  const held = await readHeld(root, keys, now);
  if (!fetchDue(mode, held.state, now)) return result(held.cached, "cache", held.expired.list);
  const budgetMs = options.budgetMs ??
    (mode === "force" ? REVOCATION_FORCE_BUDGET_MS : REVOCATION_FETCH_BUDGET_MS);
  const fetched = await fetchVerified(
    options.urls ?? REVOCATION_URLS,
    keys,
    { budgetMs, now, minSequence: held.minSequence, fetch: options.fetch ?? fetch },
    options.netGranted ?? netGrantedByQuery,
    held.expired,
  );
  // A run on test keys (DENEXT_REVOCATION_KEYS_FILE) never writes what a later run reads.
  if (!env(REVOCATION_KEYS_FILE_ENV)) await record(root, held, now, fetched);
  return fetched === null
    ? result(held.cached, "cache", held.expired.list)
    : result(fetched.list, "network", null);
}

/** The cache directory, or `null` when there is none to be had (nothing to read or remember). */
function cacheRootOf(options: LoadRevocationsOptions, env: EnvGet): string | null {
  try {
    return options.cacheRoot ?? revocationCacheRoot(env);
  } catch {
    return null;
  }
}

/** What this machine holds: the bookkeeping, the cached list and the replay floor they give. */
interface HeldRevocations {
  readonly keySet: string;
  readonly state: RevocationState | null;
  readonly cached: RuntimeRevocationList | null;
  /** A verified list ignored because it expired (filled further by the fetch). */
  readonly expired: { list: RuntimeRevocationList | null };
  readonly minSequence: number;
}

/** The cached list (re-verified under `keys`) and the bookkeeping written under the same keys. */
async function readHeld(root: string, keys: readonly string[], now: number) {
  const keySet = await revocationKeySetId(keys);
  const state = await readState(root, keySet);
  const expired = { list: null as RuntimeRevocationList | null };
  const cached = await readCached(root, keys, { now, minSequence: 0 }, expired);
  const minSequence = replayFloor(cached ?? expired.list, state);
  return { keySet, state, cached, expired, minSequence } satisfies HeldRevocations;
}

/** Remember a fetch: the list and its bookkeeping, or (`null`) when it failed. */
async function record(
  root: string,
  held: HeldRevocations,
  now: number,
  fetched: Fetched | null,
): Promise<void> {
  const base = { schema: 1 as const, keys: held.keySet };
  if (fetched === null) {
    const failed: RevocationState = {
      ...base,
      sequence: held.minSequence,
      fetchedAt: held.state?.fetchedAt ?? 0,
      failedAt: now,
    };
    await writeQuietly(root, STATE_FILE, JSON.stringify(failed) + "\n");
    return;
  }
  await writeQuietly(root, CACHE_FILE, fetched.text);
  const next: RevocationState = { ...base, sequence: fetched.list.sequence, fetchedAt: now };
  await writeQuietly(root, STATE_FILE, JSON.stringify(next) + "\n");
}

/**
 * The replay floor: the sequence of the list this machine holds (`held`, verified under the keys
 * in force, expired or not), lowered by the bookkeeping's when that is lower — the unsigned file
 * can never raise it, so a forged `sequence` cannot make every genuine list a replay. No list
 * held: 0.
 */
function replayFloor(held: RuntimeRevocationList | null, state: RevocationState | null): number {
  if (held === null) return 0;
  return Math.min(held.sequence, state?.sequence ?? held.sequence);
}

/** A configured {@linkcode LoadedRevocations}. */
function result(
  list: RuntimeRevocationList | null,
  source: "cache" | "network",
  expired: RuntimeRevocationList | null,
): LoadedRevocations {
  return { configured: true, list, source: list ? source : "none", expired: list ? null : expired };
}

// ---------------------------------------------------------------------------------------------
// Deciding what runs.

/**
 * The entry that revokes `component` `version` for `triple`, or `null`. An entry with `targets`
 * covers only those; one without covers every target.
 *
 * @param list The list.
 * @param component The component.
 * @param version The runtime version.
 * @param triple The Rust target triple (`undefined`: unknown, matched only by an all-target entry).
 * @returns The entry.
 */
export function findRevocation(
  list: RuntimeRevocationList | null,
  component: RuntimeComponent,
  version: string,
  triple: string | undefined,
): RuntimeRevocation | null {
  return list?.revoked.find((e) =>
    e.component === component && e.version === version &&
    (e.targets === undefined || (triple !== undefined && e.targets.includes(triple)))
  ) ?? null;
}

/** One pinned runtime a command would run, and the rollback its pin names. */
export interface RevocationSubject {
  readonly component: RuntimeComponent;
  readonly version: string;
  /** The pin's `rollback` version, or `null` when it names none. */
  readonly rollback: string | null;
  /** The Rust target triple it runs on. */
  readonly triple: string | undefined;
}

/** What {@linkcode decideRevocation} decided. */
export interface RevocationDecision {
  /** The first entry revoking a subject, or `null` (nothing to do). */
  readonly hit: RuntimeRevocation | null;
  /** The triple the hit applies to. */
  readonly triple?: string;
  /** Whether every subject rolls back: each names a rollback, and none of those is revoked. */
  readonly useRollback: boolean;
}

/**
 * Decide whether `subjects` — runtimes that must move together (the `deno desktop` CLI and its
 * libdenort) — run as pinned or as their rollbacks: when any is revoked, all roll back if every
 * one names a rollback that is not revoked itself; otherwise they run as pinned (a warning).
 *
 * @param list The list in force (`null`: none).
 * @param subjects The runtimes.
 * @returns The decision.
 */
export function decideRevocation(
  list: RuntimeRevocationList | null,
  subjects: readonly RevocationSubject[],
): RevocationDecision {
  for (const s of subjects) {
    const hit = findRevocation(list, s.component, s.version, s.triple);
    if (!hit) continue;
    const useRollback = subjects.every((r) =>
      r.rollback !== null && findRevocation(list, r.component, r.rollback, r.triple) === null
    );
    return { hit, ...(s.triple ? { triple: s.triple } : {}), useRollback };
  }
  return { hit: null, useRollback: false };
}

/** A component's name in a message. */
function componentName(component: RuntimeComponent): string {
  return component === "cli" ? "Deno toolchain" : "Deno Desktop runtime";
}

/** The reason and advisory, for a message. */
function why(hit: RuntimeRevocation): string {
  return [hit.reason, hit.advisory].filter((s) => s).join("; ");
}

/**
 * The one stderr line about a revoked runtime: what runs instead, or that it still runs.
 *
 * @param hit The entry.
 * @param triple The target it applies to.
 * @param rollback The version that runs instead, or `null` (the revoked one runs).
 * @returns The line.
 */
export function revocationNotice(
  hit: RuntimeRevocation,
  triple: string | undefined,
  rollback: string | null,
): string {
  const head = `denext: ${componentName(hit.component)} ${hit.version} is revoked for ` +
    `${triple ?? "this host"} (${why(hit)}).`;
  const fixed = hit.fixedIn ? ` Fixed in ${hit.fixedIn}: run \`denext upgrade\`.` : "";
  return rollback !== null
    ? `${head} Running ${rollback} instead.${fixed}`
    : `${head} Still running it; no safe fallback is pinned. \`denext upgrade\`, or ` +
      `DENEXT_DENO=<path>.${fixed}`;
}

/**
 * Why a command that ships a runtime to others (`build --compile`, `desktop build | package`)
 * refuses the revoked `hit`, or `null` when {@linkcode ALLOW_REVOKED_RUNTIME_ENV} names its
 * version.
 *
 * @param hit The entry.
 * @param triple The target being built.
 * @param action What the command does (`compile onto`, `package on`).
 * @param env Env reader.
 * @returns The refusal, or `null`.
 */
export function revokedShipRefusal(
  hit: RuntimeRevocation,
  triple: string | undefined,
  action: string,
  env: EnvGet = processEnv,
): string | null {
  if (env(ALLOW_REVOKED_RUNTIME_ENV)?.trim() === hit.version) return null;
  return `denext: refusing to ${action} the ${componentName(hit.component)} ${hit.version}: ` +
    `it is revoked for ${triple ?? "this target"} (${why(hit)}).\n` +
    "  Run `denext upgrade` for a fixed runtime, or set " +
    `${ALLOW_REVOKED_RUNTIME_ENV}=${hit.version} to ship it anyway.`;
}

/**
 * Refuse a command that ships `component` `version` for `triple` to others while the
 * revoked-runtimes list revokes it there ({@linkcode revokedShipRefusal}); resolves when it is not
 * revoked, the list can't be had, no key is configured, or {@linkcode ALLOW_REVOKED_RUNTIME_ENV}
 * names the version.
 *
 * @param component The runtime.
 * @param version Its version.
 * @param triple The target being built.
 * @param action What the command does (`compile onto`).
 * @param options How the list is read (default: `fetch` mode, the process env).
 * @throws {Error} The refusal.
 */
export async function assertRuntimeShippable(
  component: RuntimeComponent,
  version: string,
  triple: string | undefined,
  action: string,
  options: LoadRevocationsOptions = {},
): Promise<void> {
  const loaded = await loadRuntimeRevocations(options);
  const hit = findRevocation(loaded.list, component, version, triple);
  const refusal = hit ? revokedShipRefusal(hit, triple, action, options.env) : null;
  if (refusal) throw new Error(refusal);
}

/** A runtime's revocation state, for `toolchain status --json` and `doctor`. */
export interface RuntimeRevocationStatus {
  /** Whether a key is configured and the check is on (else every other field is empty). */
  readonly configured: boolean;
  /** The pinned version. */
  readonly pinned: string | null;
  /** Whether the pinned runtime is revoked for this host. */
  readonly revoked: boolean;
  readonly reason: string | null;
  readonly advisory: string | null;
  readonly fixedIn: string | null;
  /** Whether the rollback runs instead. */
  readonly runningRollback: boolean;
  /** The version that runs (the pinned one, or its rollback). */
  readonly running: string | null;
  /** The list in force: its sequence and expiry (`null`: none). */
  readonly listSequence: number | null;
  readonly listExpiresAt: string | null;
  /** The expiry of a list that was ignored because it expired (`null`: none). */
  readonly expiredAt: string | null;
}

/**
 * The status record of a decision over `loaded`.
 *
 * @param loaded What {@linkcode loadRuntimeRevocations} found.
 * @param decision What {@linkcode decideRevocation} decided.
 * @param pinned The pinned version.
 * @param rollback The rollback version, or `null`.
 * @returns The record.
 */
export function revocationStatus(
  loaded: LoadedRevocations,
  decision: RevocationDecision,
  pinned: string | null,
  rollback: string | null,
): RuntimeRevocationStatus {
  const hit = decision.hit;
  return {
    configured: loaded.configured,
    pinned,
    revoked: hit !== null,
    reason: hit?.reason ?? null,
    advisory: hit?.advisory ?? null,
    fixedIn: hit?.fixedIn ?? null,
    runningRollback: decision.useRollback,
    running: decision.useRollback ? rollback : pinned,
    listSequence: loaded.list?.sequence ?? null,
    listExpiresAt: loaded.list?.expiresAt ?? null,
    expiredAt: loaded.expired?.expiresAt ?? null,
  };
}

/**
 * One line for a report (`toolchain status`, `doctor`): the list's sequence and expiry, and what
 * it says about the pinned runtime; `ok` is false when the pin is revoked or the list expired.
 *
 * @param s The status.
 * @param what The runtime's name (default `toolchain <pinned>`).
 * @returns The line, and whether nothing needs attention.
 */
export function revocationStatusLine(
  s: RuntimeRevocationStatus,
  what = `toolchain ${s.pinned}`,
): { ok: boolean; detail: string } {
  if (!s.configured) {
    return { ok: true, detail: "no revocation key configured in this denext (check off)" };
  }
  const list = s.listSequence === null
    ? s.expiredAt
      ? `the list EXPIRED at ${s.expiredAt} (ignored; a maintainer re-signs it)`
      : "no list (offline, or none published yet)"
    : `list #${s.listSequence}, expires ${s.listExpiresAt}`;
  if (!s.revoked) return { ok: s.expiredAt === null, detail: `${list}; ${what} not revoked` };
  const run = s.runningRollback
    ? `running ${s.running} instead`
    : "still running it (no safe fallback pinned)";
  return { ok: false, detail: `${list}; ${what} REVOKED (${s.reason}); ${run}` };
}
