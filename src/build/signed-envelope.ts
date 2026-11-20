// The signed-document envelope denext's maintainer-signed files share: the revoked-runtimes list
// (runtime-revocations.ts) and the runtime channel index (runtime-channel.ts). A document is
// `{ "signed": "<JSON>", "signature": "<base64 r‖s>" }` or, during a key rotation,
// `{ "signed": "<JSON>", "signatures": ["<base64 r‖s>", …] }`: ECDSA P-256 / SHA-256 over
// `<domain> + signed`, where each document kind has its own domain line, so a signature over one
// kind never verifies as another. The signature is checked over the exact bytes before the payload
// is parsed; any one signature verifying under any one trusted key accepts the document.
//
// The pieces here are deliberately small and pure: size and shape of the envelope, signing and
// verifying, the id of a key set and of one key, a capped fetch and a quiet atomic write. What a
// payload means, how it is cached and which sequence floor applies stay with each document kind.

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { fromBase64, toBase64 } from "./ota-signing.ts";
import { denoCacheDir } from "./deno-cache-dir.ts";

/** A parsed envelope: the signed string and one or more base64 raw r‖s signatures. */
export interface SignedEnvelope {
  readonly signed: string;
  /** Every signature it carries (at least one). */
  readonly signatures: readonly string[];
}

/** Why an envelope was refused before its signature was checked. */
export type EnvelopeProblem = "size" | "format";

const encoder = new TextEncoder();
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * The envelope inside `text`, checked for size and shape only: a `signed` string and either a
 * `signature` string or a non-empty `signatures` list of strings.
 *
 * @param text The document.
 * @param maxBytes The largest document accepted.
 * @returns The envelope, or why it was refused.
 */
export function parseEnvelope(text: string, maxBytes: number): SignedEnvelope | EnvelopeProblem {
  if (encoder.encode(text).byteLength > maxBytes) return "size";
  let e: Record<string, unknown> | null;
  try {
    e = JSON.parse(text);
  } catch {
    return "format";
  }
  if (typeof e?.signed !== "string") return "format";
  const signatures = typeof e.signature === "string"
    ? [e.signature]
    : Array.isArray(e.signatures) && e.signatures.length > 0 &&
        e.signatures.every((s) => typeof s === "string")
    ? e.signatures as string[]
    : null;
  return signatures === null ? "format" : { signed: e.signed, signatures };
}

/** The bytes a signature covers. */
function signedBytes(domain: string, signed: string): BufferSource {
  return encoder.encode(domain + signed) as BufferSource;
}

/**
 * The trusted key (base64 SPKI) that verifies one of `envelope`'s signatures, or `null`.
 *
 * @param envelope The envelope.
 * @param domain The document kind's domain line.
 * @param keys The trusted public keys (base64 SPKI, ECDSA P-256).
 * @returns The first key that verifies a signature.
 */
export async function verifyingKey(
  envelope: SignedEnvelope,
  domain: string,
  keys: readonly string[],
): Promise<string | null> {
  for (const key of keys) {
    let pub: CryptoKey;
    try {
      pub = await crypto.subtle.importKey(
        "spki",
        fromBase64(key) as BufferSource,
        ECDSA,
        false,
        ["verify"],
      );
    } catch {
      continue; // A malformed key verifies nothing.
    }
    for (const signature of envelope.signatures) {
      try {
        const sig = fromBase64(signature) as BufferSource;
        if (await crypto.subtle.verify(SIGN, pub, sig, signedBytes(domain, envelope.signed))) {
          return key;
        }
      } catch {
        // A malformed signature verifies nothing.
      }
    }
  }
  return null;
}

/**
 * Sign `signed` under `domain` with each of `keys`.
 *
 * @param signed The payload string, exactly as it will be served.
 * @param domain The document kind's domain line.
 * @param keys One or more ECDSA P-256 private keys.
 * @returns The base64 raw r‖s signatures, in key order.
 */
export async function signWithKeys(
  signed: string,
  domain: string,
  keys: readonly CryptoKey[],
): Promise<string[]> {
  if (keys.length === 0) throw new Error("no signing key given");
  const out: string[] = [];
  for (const key of keys) {
    const sig = await crypto.subtle.sign(SIGN, key, signedBytes(domain, signed));
    out.push(toBase64(new Uint8Array(sig)));
  }
  return out;
}

/**
 * The id of a key set: the SHA-256 of its keys, sorted, one per line. A cache's bookkeeping
 * records it, and bookkeeping written under another key set (a test's keys, a rotated key) is
 * ignored.
 *
 * @param keys The public keys.
 * @returns The hex digest.
 */
export async function keySetId(keys: readonly string[]): Promise<string> {
  const text = [...keys].sort().join("\n");
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/**
 * The id of one public key as a revocation names it: the SHA-256 of its SPKI bytes, hex.
 *
 * @param key The public key (base64 SPKI).
 * @returns The hex digest, or `null` when `key` is not base64.
 */
export async function spkiSha256(key: string): Promise<string | null> {
  let der: Uint8Array;
  try {
    der = fromBase64(key);
  } catch {
    return null;
  }
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", der as BufferSource)));
}

/** Whether `v` is an RFC 3339 timestamp `Date.parse` reads. */
export function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && !Number.isNaN(Date.parse(v));
}

/**
 * The body of a GET of `url` as text, refused once it passes `maxBytes`, until `signal` aborts.
 *
 * @param url The URL.
 * @param signal Aborts the request.
 * @param fetchImpl The fetch to use.
 * @param maxBytes The largest body accepted.
 * @returns The body.
 * @throws {Error} On an HTTP error, a missing body or an oversized one.
 */
export async function fetchTextCapped(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<string> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("too large");
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

/**
 * Write `text` to `root/name` atomically (a temp file renamed over it); best effort: a read-only
 * cache only means the next run fetches sooner.
 *
 * @param root The directory (created when missing).
 * @param name The file name, which may hold `/`-separated subdirectories.
 * @param text The content.
 */
export async function writeQuietly(root: string, name: string, text: string): Promise<void> {
  const path = join(root, name);
  const dir = join(path, "..");
  const tmp = join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, path);
  } catch {
    await Deno.remove(tmp).catch(() => {});
  }
}

/**
 * The SHA-256 of `text`'s UTF-8 bytes, hex.
 *
 * @param text The text.
 * @returns The digest.
 */
export async function sha256Hex(text: string): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text) as BufferSource)),
  );
}

// ---------------------------------------------------------------------------------------------
// What every signed payload and its cache share.

/** Env reader. */
export type EnvGet = (name: string) => string | undefined;

/** The process's environment (an env read that is not allowed reads as unset). */
export const processEnv: EnvGet = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

/** The header fields every signed payload carries. */
export interface SignedPayloadHeader {
  /** RFC 3339. */
  readonly issuedAt: string;
  /** RFC 3339; the payload is ignored at or after it. */
  readonly expiresAt: string;
  /** The Unix time in seconds at signing; only ever grows. */
  readonly sequence: number;
}

/**
 * The header of a parsed schema-1 payload, checked: `schema` 1, RFC 3339 `issuedAt` and
 * `expiresAt`, a non-negative integer `sequence`.
 *
 * @param raw The parsed payload.
 * @param invalid Makes the refusal for a reason.
 * @returns The header.
 * @throws {Error} What `invalid` makes, for the first malformed field.
 */
export function checkPayloadHeader(
  raw: unknown,
  invalid: (why: string) => Error,
): SignedPayloadHeader {
  const p = raw as Record<string, unknown> | null;
  if (p?.schema !== 1) throw invalid("schema must be 1");
  if (!isTimestamp(p.issuedAt) || !isTimestamp(p.expiresAt)) {
    throw invalid("bad issuedAt / expiresAt");
  }
  if (!Number.isSafeInteger(p.sequence) || (p.sequence as number) < 0) {
    throw invalid("sequence must be a non-negative integer");
  }
  return { issuedAt: p.issuedAt, expiresAt: p.expiresAt, sequence: p.sequence as number };
}

const DAY_MS = 24 * 3600_000;

/**
 * The header of a payload signed at `now`: `issuedAt` now, `expiresAt` `days` on, and `sequence`
 * the Unix time in seconds — above `previous`'s, whatever the clock says.
 *
 * @param now The signing time.
 * @param days How long it stays valid.
 * @param previous The payload it replaces, if any.
 * @returns The header.
 */
export function freshHeader(
  now: Date,
  days: number,
  previous?: { readonly sequence: number },
): SignedPayloadHeader {
  return {
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
    sequence: Math.max(Math.floor(now.getTime() / 1000), (previous?.sequence ?? -1) + 1),
  };
}

/**
 * Whether a payload expiring at `expiresAt` is due a re-sign: fewer than `days` days remain (or
 * it already expired, or the date does not parse).
 *
 * @param expiresAt RFC 3339.
 * @param now The clock, epoch ms.
 * @param days The margin.
 * @returns Whether to re-sign.
 */
export function resignDue(expiresAt: string, now: number, days: number): boolean {
  const expires = Date.parse(expiresAt);
  return Number.isNaN(expires) || expires - now < days * DAY_MS;
}

/**
 * The public keys a test's keys file lists (a JSON array of base64 SPKI strings); empty when it
 * can't be read or holds anything else.
 *
 * @param file The file.
 * @returns The non-empty strings it lists.
 */
export function readKeysFile(file: string): string[] {
  try {
    const keys: unknown = JSON.parse(Deno.readTextFileSync(file));
    return Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k !== "") : [];
  } catch {
    return [];
  }
}

/** A signed document cache's bookkeeping (unsigned: it can lower a replay floor, never raise it). */
export interface SignedCacheState {
  readonly schema: 1;
  /** The key set it was written under ({@linkcode keySetId}). */
  readonly keys: string;
  /** The sequence of the document accepted last. */
  readonly sequence: number;
  /** When the document was last fetched (epoch ms). */
  readonly fetchedAt: number;
  /** When a fetch last failed (epoch ms). */
  readonly failedAt?: number;
}

/**
 * The bookkeeping in `root/file`, when it was written under the key set `keys` (else `null`).
 *
 * @param root The cache directory.
 * @param file The bookkeeping file's name.
 * @param keys The key set's id.
 * @returns The bookkeeping.
 */
export async function readCacheState(
  root: string,
  file: string,
  keys: string,
): Promise<SignedCacheState | null> {
  try {
    const s = JSON.parse(await Deno.readTextFile(join(root, file)));
    return s?.schema === 1 && s.keys === keys && Number.isSafeInteger(s.sequence) &&
        Number.isFinite(s.fetchedAt)
      ? s
      : null;
  } catch {
    return null;
  }
}

/** How a loader reaches a signed document. */
export type SignedFetchMode = "off" | "cache-only" | "fetch" | "force";

/**
 * Whether `mode` fetches now, given the bookkeeping: `force` always, `fetch` once the cached copy
 * is `ttlMs` old unless a fetch failed less than `retryMs` ago, the others never.
 *
 * @param mode The mode.
 * @param state The bookkeeping (`null`: none).
 * @param now The clock, epoch ms.
 * @param ttlMs How long a fetched copy is used.
 * @param retryMs How long after a failure the next fetch waits.
 * @returns Whether to fetch.
 */
export function fetchDue(
  mode: SignedFetchMode,
  state: SignedCacheState | null,
  now: number,
  ttlMs: number,
  retryMs: number,
): boolean {
  if (mode === "force") return true;
  if (mode !== "fetch") return false;
  if (state === null) return true;
  const age = now - state.fetchedAt;
  if (age >= 0 && age < ttlMs) return false;
  const sinceFailure = now - (state.failedAt ?? -Infinity);
  return !(sinceFailure >= 0 && sinceFailure < retryMs);
}

/**
 * Whether the process may reach `url`'s host without being asked (never prompts).
 *
 * @param url The URL.
 * @returns Whether `net` is granted for its host.
 */
export async function netGrantedByQuery(url: string): Promise<boolean> {
  try {
    const host = new URL(url).host;
    return (await Deno.permissions.query({ name: "net", host })).state === "granted";
  } catch {
    return false;
  }
}

/**
 * The toolchain cache, where the signed documents are cached (`<DENO_DIR>/denext-deno`).
 *
 * @param env Env reader.
 * @returns The directory.
 */
export function toolchainCacheRoot(env: EnvGet = processEnv): string {
  return join(denoCacheDir(env), "denext-deno");
}
