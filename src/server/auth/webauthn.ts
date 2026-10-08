/**
 * Relying-party verification for **WebAuthn** (W3C Web Authentication Level 3): the
 * registration ceremony (§7.1) and the authentication ceremony (§7.2), over web-standard
 * crypto alone — `crypto.subtle` for SHA-256, ECDSA P-256, RSASSA-PKCS1-v1_5 and Ed25519 — and
 * denext's own CBOR decoder ({@link ./cbor.ts}). No npm.
 *
 * What it checks, step by step (section numbers are L3's):
 * - the client data (§5.8.1): `type`, the challenge, the origin against an allow-list, and
 *   `crossOrigin` (refused unless allowed — a credential used inside a cross-origin iframe);
 * - the authenticator data (§6.1): the RP ID hash, User Present, User Verified when required,
 *   the backup flags' consistency (BS without BE is malformed), and the attested credential
 *   data's exact length (§6.5.1);
 * - the credential public key (COSE, RFC 9052/9053): ES256 (`-7`, P-256), RS256 (`-257`) and
 *   EdDSA (`-8`, Ed25519) — and nothing else;
 * - the attestation statement (§8): `none` (§8.7) and `packed` (§8.2) — self attestation, or
 *   an `x5c` leaf whose signature and §8.2.1 certificate requirements are checked (denext
 *   does not evaluate the chain to a trust anchor; see {@linkcode RegistrationResult});
 * - the assertion signature over `authenticatorData ‖ SHA-256(clientDataJSON)` (§7.2 step 20),
 *   the backup-eligibility flag against the stored record, and the signature counter (§6.1.1):
 *   a counter that doesn't increase is a possible cloned authenticator and is refused.
 *
 * The functions are pure: challenge storage (single use) and the credential records live in
 * the adapter, one layer up ({@link ./passkeys.ts}).
 *
 * @module
 */

import { timingSafeEqual } from "node:crypto";
import { decodeCbor, decodeCborPrefix } from "./cbor.ts";
import { base64UrlDecode, base64UrlEncode } from "./oauth.ts";

/** A COSE algorithm this relying party verifies: ES256, RS256 or EdDSA (Ed25519). */
export type PasskeyAlgorithm = -7 | -257 | -8;

/** The supported algorithms, in the preference order offered to the client. */
export const PASSKEY_ALGORITHMS: readonly PasskeyAlgorithm[] = [-8, -7, -257];

/** Why a ceremony was refused — stable codes for logs and `signInFailed`. */
export type WebAuthnErrorCode =
  | "malformed"
  | "type"
  | "challenge"
  | "origin"
  | "cross_origin"
  | "rp_id"
  | "user_presence"
  | "user_verification"
  | "backup_state"
  | "algorithm"
  | "attestation"
  | "signature"
  | "counter";

/** A refused ceremony. `code` says which check failed; the message never echoes input. */
export class WebAuthnError extends Error {
  override name = "WebAuthnError";
  /**
   * @param code The check that failed.
   * @param message A human-readable reason.
   */
  constructor(readonly code: WebAuthnErrorCode, message: string) {
    super(message);
  }
}

/** Throw a {@link WebAuthnError} unless `condition` holds. */
function check(condition: unknown, code: WebAuthnErrorCode, message: string): asserts condition {
  if (!condition) throw new WebAuthnError(code, message);
}

const encoder = new TextEncoder();

/** SHA-256 of `bytes`. */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Constant-time equality of two byte strings (the length is not secret). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Concatenate byte strings (small, fixed inputs: authenticator data and a hash). */
function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

// ---- client data (§5.8.1) ------------------------------------------------------

/** The parsed `CollectedClientData`. */
export interface ClientData {
  /** `"webauthn.create"` or `"webauthn.get"`. */
  type: string;
  /** The base64url challenge the client signed over. */
  challenge: string;
  /** The origin of the page that called the API. */
  origin: string;
  /** Whether the call came from a cross-origin iframe. */
  crossOrigin: boolean;
  /** The top-level origin, for a cross-origin call. */
  topOrigin?: string;
}

/**
 * Parse `clientDataJSON` (UTF-8 JSON, §5.8.1) — the shape only; {@linkcode checkClientData}
 * judges it.
 *
 * @param bytes The raw `clientDataJSON`.
 * @returns The fields a relying party checks.
 * @throws {WebAuthnError} `malformed` for anything but a JSON object with string `type`,
 * `challenge` and `origin`.
 */
export function parseClientData(bytes: Uint8Array): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WebAuthnError("malformed", "clientDataJSON is not UTF-8 JSON");
  }
  const c = parsed as Record<string, unknown> | null;
  check(c && typeof c === "object" && !Array.isArray(c), "malformed", "clientDataJSON");
  check(
    typeof c.type === "string" && typeof c.challenge === "string" && typeof c.origin === "string",
    "malformed",
    "clientDataJSON lacks type / challenge / origin",
  );
  return {
    type: c.type,
    challenge: c.challenge,
    origin: c.origin,
    crossOrigin: c.crossOrigin === true,
    topOrigin: typeof c.topOrigin === "string" ? c.topOrigin : undefined,
  };
}

/** What a ceremony's client data must say. */
export interface ClientDataExpectations {
  /** `"webauthn.create"` (§7.1 step 7) or `"webauthn.get"` (§7.2 step 11). */
  type: "webauthn.create" | "webauthn.get";
  /** The base64url challenge this ceremony issued (§7.1 step 8 / §7.2 step 12). */
  challenge: string;
  /** The origins the relying party accepts (§7.1 step 9 / §7.2 step 13), matched exactly. */
  origins: readonly string[];
  /**
   * Accept a call from a cross-origin iframe (`crossOrigin: true`) whose `topOrigin` is one of
   * these (§7.1 step 10 / §7.2 step 14). Default: none — such a call is refused.
   */
  topOrigins?: readonly string[];
}

/**
 * Judge parsed client data.
 *
 * @param data The parsed client data.
 * @param expected The ceremony type, its challenge and the accepted origins.
 * @throws {WebAuthnError} `type`, `challenge`, `origin` or `cross_origin`.
 */
function checkClientData(data: ClientData, expected: ClientDataExpectations): void {
  check(data.type === expected.type, "type", `clientData.type is not ${expected.type}`);
  check(
    bytesEqual(encoder.encode(data.challenge), encoder.encode(expected.challenge)),
    "challenge",
    "the challenge does not match this ceremony",
  );
  check(expected.origins.includes(data.origin), "origin", "the origin is not accepted");
  if (data.crossOrigin || data.topOrigin !== undefined) {
    check(
      data.crossOrigin && data.topOrigin !== undefined &&
        (expected.topOrigins ?? []).includes(data.topOrigin),
      "cross_origin",
      "a cross-origin ceremony is not accepted",
    );
  }
}

// ---- authenticator data (§6.1) ----------------------------------------------------

/** The authenticator data flags (§6.1, Table "flags"). */
export interface AuthenticatorFlags {
  /** Bit 0, UP: the user was present. */
  userPresent: boolean;
  /** Bit 2, UV: the user was verified (biometric, PIN). */
  userVerified: boolean;
  /** Bit 3, BE: the credential may be backed up (a synced passkey). */
  backupEligible: boolean;
  /** Bit 4, BS: the credential is currently backed up. */
  backedUp: boolean;
  /** Bit 6, AT: attested credential data follows. */
  attestedCredentialData: boolean;
  /** Bit 7, ED: extension data follows. */
  extensionData: boolean;
}

/** The credential the authenticator data attests to (§6.5.1). */
export interface AttestedCredential {
  /** The authenticator model, 16 bytes. */
  aaguid: Uint8Array;
  /** The credential ID (1–1023 bytes, §5.8.3). */
  credentialId: Uint8Array;
  /** The COSE_Key bytes, exactly as encoded. */
  publicKey: Uint8Array;
}

/** Parsed authenticator data. */
export interface AuthenticatorData {
  /** SHA-256 of the RP ID the credential is scoped to. */
  rpIdHash: Uint8Array;
  /** The flags. */
  flags: AuthenticatorFlags;
  /** The signature counter (§6.1.1); 0 when the authenticator keeps none. */
  signCount: number;
  /** Present when `flags.attestedCredentialData` is set. */
  attested?: AttestedCredential;
}

/** The longest credential ID a relying party accepts (§5.8.3 / §7.1 step 25). */
const MAX_CREDENTIAL_ID = 1023;

/**
 * Parse authenticator data (§6.1): RP ID hash (32), flags (1), counter (4, big-endian), then
 * the attested credential data when AT is set (§6.5.1: AAGUID 16, ID length 2, ID, COSE key)
 * and the extensions map when ED is set. Every byte must be accounted for.
 *
 * @param bytes The raw authenticator data.
 * @returns The parsed structure.
 * @throws {WebAuthnError} `malformed` for a truncated, oversized or inconsistent structure.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  check(bytes.length >= 37, "malformed", "authenticator data is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = bytes[32];
  const flags: AuthenticatorFlags = {
    userPresent: (f & 0x01) !== 0,
    userVerified: (f & 0x04) !== 0,
    backupEligible: (f & 0x08) !== 0,
    backedUp: (f & 0x10) !== 0,
    attestedCredentialData: (f & 0x40) !== 0,
    extensionData: (f & 0x80) !== 0,
  };
  // §6.1: "If the BE flag is not set, the BS flag MUST NOT be set."
  check(flags.backupEligible || !flags.backedUp, "backup_state", "BS is set without BE");
  const out: AuthenticatorData = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    signCount: view.getUint32(33),
  };
  let at = 37;
  if (flags.attestedCredentialData) {
    check(bytes.length >= at + 18, "malformed", "attested credential data is truncated");
    const aaguid = bytes.slice(at, at + 16);
    const idLength = view.getUint16(at + 16);
    at += 18;
    check(
      idLength >= 1 && idLength <= MAX_CREDENTIAL_ID && bytes.length >= at + idLength,
      "malformed",
      "the credential ID length is out of range",
    );
    const credentialId = bytes.slice(at, at + idLength);
    at += idLength;
    const key = cborPrefix(bytes.subarray(at));
    out.attested = { aaguid, credentialId, publicKey: bytes.slice(at, at + key) };
    at += key;
  }
  if (flags.extensionData) {
    const ext = cborPrefix(bytes.subarray(at));
    at += ext;
  }
  check(at === bytes.length, "malformed", "authenticator data has trailing bytes");
  return out;
}

/** The byte length of the CBOR item at the start of `bytes`, as a `malformed` error. */
function cborPrefix(bytes: Uint8Array): number {
  try {
    return decodeCborPrefix(bytes).length;
  } catch {
    throw new WebAuthnError("malformed", "invalid CBOR in authenticator data");
  }
}

// ---- COSE keys + signatures (RFC 9052 §7, RFC 9053 §2) -------------------------------

/** A credential public key, imported for verification. */
interface CredentialKey {
  /** Its COSE algorithm. */
  alg: PasskeyAlgorithm;
  /** The imported verification key. */
  key: CryptoKey;
}

/** A COSE_Key's map, or a `malformed` error. */
function coseMap(bytes: Uint8Array): Map<number | string, unknown> {
  let decoded: unknown;
  try {
    decoded = decodeCbor(bytes);
  } catch {
    throw new WebAuthnError("malformed", "the credential public key is not CBOR");
  }
  check(decoded instanceof Map, "malformed", "the credential public key is not a COSE_Key map");
  return decoded as Map<number | string, unknown>;
}

/** A COSE byte-string parameter of exactly `size` bytes (any size when omitted). */
function coseBytes(map: Map<number | string, unknown>, label: number, size?: number): Uint8Array {
  const value = map.get(label);
  check(
    value instanceof Uint8Array && (size === undefined || value.length === size),
    "algorithm",
    `COSE parameter ${label} is missing or the wrong size`,
  );
  return value;
}

/**
 * Import a COSE_Key (WebAuthn §5.8.5): EC2 / P-256 for ES256 (kty 2, crv 1, 32-byte x and y),
 * RSA for RS256 (kty 3, n, e), OKP / Ed25519 for EdDSA (kty 1, crv 6, 32-byte x). The `alg`
 * label must be present and agree with the key type; anything else is refused.
 *
 * @param bytes The COSE_Key, as stored at registration.
 * @returns The algorithm and the imported key.
 * @throws {WebAuthnError} `malformed` or `algorithm`.
 */
async function importCredentialKey(bytes: Uint8Array): Promise<CredentialKey> {
  const map = coseMap(bytes);
  const kty = map.get(1);
  const alg = map.get(3);
  if (alg === -7 && kty === 2) {
    check(map.get(-1) === 1, "algorithm", "ES256 requires the P-256 curve");
    const x = coseBytes(map, -2, 32);
    const y = coseBytes(map, -3, 32);
    const key = await crypto.subtle.importKey(
      "raw",
      concat(Uint8Array.of(0x04), x, y) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    ).catch(() => {
      throw new WebAuthnError("algorithm", "the P-256 point is invalid");
    });
    return { alg: -7, key };
  }
  if (alg === -257 && kty === 3) {
    const n = coseBytes(map, -1);
    const e = coseBytes(map, -2);
    check(n.length >= 256, "algorithm", "RS256 keys must be at least 2048 bits");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: base64UrlEncode(n), e: base64UrlEncode(e), alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ).catch(() => {
      throw new WebAuthnError("algorithm", "the RSA key is invalid");
    });
    return { alg: -257, key };
  }
  if (alg === -8 && kty === 1) {
    check(map.get(-1) === 6, "algorithm", "EdDSA is supported over Ed25519 only");
    const key = await crypto.subtle.importKey(
      "raw",
      coseBytes(map, -2, 32) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    ).catch(() => {
      throw new WebAuthnError("algorithm", "the Ed25519 key is invalid");
    });
    return { alg: -8, key };
  }
  throw new WebAuthnError("algorithm", "unsupported credential algorithm");
}

/**
 * An ECDSA signature as WebAuthn carries it — ASN.1 DER `SEQUENCE { r INTEGER, s INTEGER }`
 * (§6.5.5) — converted to the fixed-width `r ‖ s` WebCrypto verifies.
 *
 * @param der The DER signature.
 * @param size The scalar size in bytes (32 for P-256).
 * @returns The raw signature, or `null` when the DER is malformed.
 */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array | null {
  const seq = shortTlv(der, 0, 0x30);
  if (!seq || seq.end !== der.length) return null;
  const r = derInteger(der, seq.start, seq.end, size);
  const s = r && derInteger(der, r.end, seq.end, size);
  if (!r || !s || s.end !== seq.end) return null;
  const out = new Uint8Array(size * 2);
  out.set(r.value, size - r.value.length);
  out.set(s.value, size * 2 - s.value.length);
  return out;
}

/** A short-form DER TLV of `tag` at `at` (r and s of P-256 never need a long-form length). */
function shortTlv(
  der: Uint8Array,
  at: number,
  tag: number,
): { start: number; end: number } | null {
  if (der[at] !== tag || at + 2 > der.length || der[at + 1] & 0x80) return null;
  const start = at + 2;
  const end = start + der[at + 1];
  return end <= der.length ? { start, end } : null;
}

/**
 * A minimally encoded, positive DER INTEGER of at most `size` bytes at `at` (inside `limit`),
 * its leading sign byte dropped.
 */
function derInteger(
  der: Uint8Array,
  at: number,
  limit: number,
  size: number,
): { value: Uint8Array; end: number } | null {
  const int = shortTlv(der, at, 0x02);
  if (!int || int.end > limit || int.end === int.start) return null;
  const bytes = der.subarray(int.start, int.end);
  const padded = bytes.length > 1 && bytes[0] === 0;
  // One leading zero only when the next byte's high bit is set; never a negative value.
  if ((padded && (bytes[1] & 0x80) === 0) || bytes[0] & 0x80) return null;
  const value = padded ? bytes.subarray(1) : bytes;
  return value.length <= size ? { value, end: int.end } : null;
}

/**
 * Verify a WebAuthn signature with an imported key.
 *
 * @param key The algorithm and key.
 * @param signature The signature as the authenticator produced it (DER for ECDSA).
 * @param data The signed bytes.
 * @returns Whether it verifies.
 */
async function verifySignature(
  key: CredentialKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (key.alg === -7) {
    const raw = derToRawEcdsa(signature);
    if (!raw) return false;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key.key,
      raw as BufferSource,
      data as BufferSource,
    );
  }
  const name = key.alg === -257 ? "RSASSA-PKCS1-v1_5" : "Ed25519";
  return await crypto.subtle.verify(name, key.key, signature as BufferSource, data as BufferSource);
}

// ---- registration (§7.1) -----------------------------------------------------------

/** The registration response's two byte strings (`AuthenticatorAttestationResponse`). */
export interface RegistrationResponse {
  /** `response.clientDataJSON`. */
  clientDataJSON: Uint8Array;
  /** `response.attestationObject`. */
  attestationObject: Uint8Array;
}

/** What a registration must match. */
export interface RegistrationExpectations extends Omit<ClientDataExpectations, "type"> {
  /** The RP ID the credential must be scoped to (§7.1 step 13). */
  rpId: string;
  /** Require the UV flag (§7.1 step 15) — `userVerification: "required"`. */
  requireUserVerification: boolean;
  /** The algorithms offered in `pubKeyCredParams` (§7.1 step 17). Default: all supported. */
  algorithms?: readonly PasskeyAlgorithm[];
}

/** A verified registration: what to store as the credential record (§7.1 step 27). */
export interface RegistrationResult {
  /** The credential ID. */
  credentialId: Uint8Array;
  /** The COSE_Key bytes. */
  publicKey: Uint8Array;
  /** Its algorithm. */
  alg: PasskeyAlgorithm;
  /** The initial signature counter. */
  signCount: number;
  /** The authenticator model. */
  aaguid: Uint8Array;
  /** BE at registration — it may never change for this credential. */
  backupEligible: boolean;
  /** BS at registration. */
  backedUp: boolean;
  /** Whether UV was set. */
  userVerified: boolean;
  /** The attestation statement format. */
  fmt: "none" | "packed";
  /**
   * What the attestation established (§6.5.4): `"none"`, `"self"` (packed without `x5c`), or
   * `"basic"` — an `x5c` leaf whose signature and certificate profile verified. denext does
   * not chain the leaf to a trust anchor (no metadata service), so `"basic"` is unverified
   * attestation, never proof of a specific authenticator model.
   */
  attestationType: "none" | "self" | "basic";
}

/** A CBOR map's string-keyed value. */
function field(map: Map<number | string, unknown>, key: string): unknown {
  return map.get(key);
}

/**
 * Verify a registration ceremony's response (§7.1, steps 5–24). The caller has already
 * matched the challenge to a single-use, server-issued one, and checks the credential ID is
 * not registered yet (step 25) before storing the result (step 27).
 *
 * @param response The client's `clientDataJSON` and `attestationObject`.
 * @param expected The challenge, origins, RP ID and policy.
 * @returns The credential to store.
 * @throws {WebAuthnError} Naming the check that failed.
 */
export async function verifyRegistration(
  response: RegistrationResponse,
  expected: RegistrationExpectations,
): Promise<RegistrationResult> {
  // Steps 5–10: the client data.
  checkClientData(parseClientData(response.clientDataJSON), {
    ...expected,
    type: "webauthn.create",
  });
  // Step 11.
  const clientDataHash = await sha256(response.clientDataJSON);
  // Step 12: decode the attestation object.
  let decoded: unknown;
  try {
    decoded = decodeCbor(response.attestationObject);
  } catch {
    throw new WebAuthnError("malformed", "attestationObject is not CBOR");
  }
  check(decoded instanceof Map, "malformed", "attestationObject is not a map");
  const att = decoded as Map<number | string, unknown>;
  const fmt = field(att, "fmt");
  const authDataBytes = field(att, "authData");
  const attStmt = field(att, "attStmt");
  check(
    typeof fmt === "string" && authDataBytes instanceof Uint8Array && attStmt instanceof Map,
    "malformed",
    "attestationObject lacks fmt / authData / attStmt",
  );
  const authData = parseAuthenticatorData(authDataBytes);
  // Step 13: the RP ID hash.
  check(
    bytesEqual(authData.rpIdHash, await sha256(encoder.encode(expected.rpId))),
    "rp_id",
    "the credential is scoped to another RP ID",
  );
  // Steps 14–15: UP always, UV when required.
  check(authData.flags.userPresent, "user_presence", "the user was not present");
  check(
    !expected.requireUserVerification || authData.flags.userVerified,
    "user_verification",
    "user verification was required",
  );
  // Step 16 (BE/BS consistency) ran in parseAuthenticatorData. Step 17: the algorithm.
  const attested = authData.attested;
  check(attested, "malformed", "no attested credential data");
  const credential = await importCredentialKey(attested.publicKey);
  check(
    (expected.algorithms ?? PASSKEY_ALGORITHMS).includes(credential.alg),
    "algorithm",
    "the credential algorithm was not offered",
  );
  // Steps 19–21: the attestation statement.
  const attestationType = await verifyAttestation(
    fmt,
    attStmt as Map<number | string, unknown>,
    authDataBytes,
    clientDataHash,
    credential,
    attested.aaguid,
  );
  return {
    credentialId: attested.credentialId,
    publicKey: attested.publicKey,
    alg: credential.alg,
    signCount: authData.signCount,
    aaguid: attested.aaguid,
    backupEligible: authData.flags.backupEligible,
    backedUp: authData.flags.backedUp,
    userVerified: authData.flags.userVerified,
    fmt: fmt as "none" | "packed",
    attestationType,
  };
}

/**
 * Verify the attestation statement (§7.1 step 21) for the formats denext supports.
 *
 * @returns The attestation type it established.
 */
async function verifyAttestation(
  fmt: string,
  stmt: Map<number | string, unknown>,
  authData: Uint8Array,
  clientDataHash: Uint8Array,
  credential: CredentialKey,
  aaguid: Uint8Array,
): Promise<RegistrationResult["attestationType"]> {
  if (fmt === "none") {
    // §8.7: the statement is the empty map.
    check(stmt.size === 0, "attestation", "a none attestation statement must be empty");
    return "none";
  }
  check(fmt === "packed", "attestation", "unsupported attestation format");
  return await verifyPacked(stmt, concat(authData, clientDataHash), credential, aaguid);
}

/**
 * The packed attestation statement (§8.2): `{ alg, sig, x5c? }`, `sig` over
 * `authenticatorData ‖ clientDataHash`.
 */
async function verifyPacked(
  stmt: Map<number | string, unknown>,
  signed: Uint8Array,
  credential: CredentialKey,
  aaguid: Uint8Array,
): Promise<"self" | "basic"> {
  const alg = field(stmt, "alg");
  const sig = field(stmt, "sig");
  const x5c = field(stmt, "x5c");
  check(typeof alg === "number" && sig instanceof Uint8Array, "attestation", "packed alg / sig");
  if (x5c === undefined) {
    // Self attestation: `alg` matches the credential's, and the credential key verifies.
    check(alg === credential.alg, "attestation", "self attestation alg differs from the key's");
    check(
      await verifySignature(credential, sig, signed),
      "attestation",
      "the self-attestation signature does not verify",
    );
    return "self";
  }
  check(
    Array.isArray(x5c) && x5c.length >= 1 && x5c.every((c) => c instanceof Uint8Array),
    "attestation",
    "x5c must be a non-empty array of certificates",
  );
  const leaf = parseCertificate(x5c[0] as Uint8Array);
  checkPackedCertificate(leaf, aaguid);
  const key = await importCertificateKey(leaf, alg);
  check(
    await verifySignature(key, sig, signed),
    "attestation",
    "the attestation signature does not verify",
  );
  return "basic";
}

// ---- a minimal X.509 reader (RFC 5280) for the packed leaf (§8.2.1) -------------------

/** One DER TLV. */
interface Der {
  tag: number;
  /** The value bytes. */
  value: Uint8Array;
  /** The whole TLV, header included. */
  raw: Uint8Array;
}

/** Read the TLV at `at`; throws `attestation` on malformed DER. */
function derAt(bytes: Uint8Array, at: number): Der {
  check(at + 2 <= bytes.length, "attestation", "truncated certificate");
  const tag = bytes[at];
  let len = bytes[at + 1];
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    check(n >= 1 && n <= 3 && at + 2 + n <= bytes.length, "attestation", "bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | bytes[at + 2 + i];
    head += n;
  }
  check(at + head + len <= bytes.length, "attestation", "DER length exceeds the certificate");
  return {
    tag,
    value: bytes.subarray(at + head, at + head + len),
    raw: bytes.subarray(at, at + head + len),
  };
}

/** The TLVs inside a constructed value. */
function derChildren(value: Uint8Array): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < value.length;) {
    const child = derAt(value, at);
    out.push(child);
    at += child.raw.length;
  }
  return out;
}

/** What §8.2.1 asks of the attestation certificate. */
interface Certificate {
  /** The `version` field's value (2 means v3). */
  version: number;
  /** Subject attributes by OID (hex of the DER body). */
  subject: Map<string, string>;
  /** The SubjectPublicKeyInfo, DER. */
  spki: Uint8Array;
  /** Extensions by OID hex: criticality and the OCTET STRING's content. */
  extensions: Map<string, { critical: boolean; value: Uint8Array }>;
}

const OID_C = "550406";
const OID_O = "55040a";
const OID_OU = "55040b";
const OID_CN = "550403";
const OID_BASIC_CONSTRAINTS = "551d13";
/** `id-fido-gen-ce-aaguid`, 1.3.6.1.4.1.45724.1.1.4 (§8.2.1). */
const OID_FIDO_AAGUID = "2b0601040182e51c010104";

/** Hex of a byte string. */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `version` of a tbsCertificate's parts (`[0] EXPLICIT INTEGER`, v1 when absent). */
function certificateVersion(parts: Der[]): { version: number; next: number } {
  if (parts[0]?.tag !== 0xa0) return { version: 0, next: 0 };
  const v = derChildren(parts[0].value)[0];
  check(v?.tag === 0x02 && v.value.length === 1, "attestation", "bad version");
  return { version: v.value[0], next: 1 };
}

/** A Name's attributes by OID hex (RDNSequence of SETs of AttributeTypeAndValue). */
function nameAttributes(name: Der): Map<string, string> {
  const out = new Map<string, string>();
  for (const rdn of derChildren(name.value)) {
    for (const atv of derChildren(rdn.value)) {
      const [oid, value] = derChildren(atv.value);
      if (oid?.tag === 0x06 && value) {
        out.set(hex(oid.value), new TextDecoder().decode(value.value));
      }
    }
  }
  return out;
}

/** The `[3] EXPLICIT Extensions` among `parts`, by OID hex. */
function certificateExtensions(parts: Der[]): Certificate["extensions"] {
  const out: Certificate["extensions"] = new Map();
  const wrapper = parts.find((p) => p.tag === 0xa3);
  const [seq] = wrapper ? derChildren(wrapper.value) : [];
  for (const ext of seq ? derChildren(seq.value) : []) {
    // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
    const items = derChildren(ext.value);
    const octets = items[items.length - 1];
    if (items[0]?.tag !== 0x06 || octets?.tag !== 0x04) continue;
    const critical = items[1]?.tag === 0x01 && items[1].value[0] !== 0;
    out.set(hex(items[0].value), { critical, value: octets.value });
  }
  return out;
}

/** Parse the fields of a DER certificate that §8.2.1 checks. */
function parseCertificate(der: Uint8Array): Certificate {
  const cert = derAt(der, 0);
  check(cert.tag === 0x30 && cert.raw.length === der.length, "attestation", "not a certificate");
  const [tbs] = derChildren(cert.value);
  check(tbs?.tag === 0x30, "attestation", "no tbsCertificate");
  const parts = derChildren(tbs.value);
  const { version, next } = certificateVersion(parts);
  // serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
  const subject = parts[next + 4];
  const spki = parts[next + 5];
  check(subject?.tag === 0x30 && spki?.tag === 0x30, "attestation", "bad certificate body");
  return {
    version,
    subject: nameAttributes(subject),
    spki: spki.raw,
    extensions: certificateExtensions(parts.slice(next + 6)),
  };
}

/**
 * §8.2.1 "Certificate Requirements for Packed Attestation Statements": version 3; a subject
 * with C, O, CN and OU `"Authenticator Attestation"`; Basic Constraints with CA false; and an
 * `id-fido-gen-ce-aaguid` extension, if present, that is not critical and equals the AAGUID.
 */
function checkPackedCertificate(cert: Certificate, aaguid: Uint8Array): void {
  check(cert.version === 2, "attestation", "the attestation certificate is not X.509 v3");
  const s = cert.subject;
  check(
    !!s.get(OID_C) && !!s.get(OID_O) && !!s.get(OID_CN) &&
      s.get(OID_OU) === "Authenticator Attestation",
    "attestation",
    "the attestation certificate's subject does not meet §8.2.1",
  );
  const basic = cert.extensions.get(OID_BASIC_CONSTRAINTS);
  if (basic) {
    // BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE, … }
    const [first] = derChildren(derAt(basic.value, 0).value);
    check(
      !(first?.tag === 0x01 && first.value[0] !== 0),
      "attestation",
      "the attestation certificate is a CA",
    );
  }
  const ext = cert.extensions.get(OID_FIDO_AAGUID);
  if (ext) {
    check(!ext.critical, "attestation", "the AAGUID extension must not be critical");
    const inner = derAt(ext.value, 0);
    check(
      inner.tag === 0x04 && bytesEqual(inner.value, aaguid),
      "attestation",
      "the certificate's AAGUID differs from the authenticator data's",
    );
  }
}

/** Import the leaf's public key for the attestation `alg`. */
async function importCertificateKey(cert: Certificate, alg: number): Promise<CredentialKey> {
  const algorithms: Record<
    number,
    [PasskeyAlgorithm, AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams]
  > = {
    [-7]: [-7, { name: "ECDSA", namedCurve: "P-256" }],
    [-257]: [-257, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }],
    [-8]: [-8, { name: "Ed25519" }],
  };
  const entry = algorithms[alg];
  check(entry, "attestation", "unsupported attestation algorithm");
  const key = await crypto.subtle.importKey(
    "spki",
    cert.spki as BufferSource,
    entry[1],
    false,
    ["verify"],
  ).catch(() => {
    throw new WebAuthnError("attestation", "the attestation key does not match its algorithm");
  });
  return { alg: entry[0], key };
}

// ---- authentication (§7.2) --------------------------------------------------------

/** The assertion's byte strings (`AuthenticatorAssertionResponse`). */
export interface AuthenticationResponse {
  /** `response.clientDataJSON`. */
  clientDataJSON: Uint8Array;
  /** `response.authenticatorData`. */
  authenticatorData: Uint8Array;
  /** `response.signature`. */
  signature: Uint8Array;
}

/** The stored credential an assertion is checked against. */
export interface StoredCredential {
  /** The COSE_Key bytes. */
  publicKey: Uint8Array;
  /** The last signature counter seen. */
  signCount: number;
  /** BE as registered. */
  backupEligible: boolean;
}

/** What an authentication must match. */
export interface AuthenticationExpectations extends Omit<ClientDataExpectations, "type"> {
  /** The RP ID (§7.2 step 15). */
  rpId: string;
  /** Require the UV flag (§7.2 step 17). */
  requireUserVerification: boolean;
}

/** A verified assertion: what to write back to the credential record (§7.2 step 23). */
export interface AuthenticationResult {
  /** The new signature counter. */
  signCount: number;
  /** BS now. */
  backedUp: boolean;
  /** Whether UV was set. */
  userVerified: boolean;
}

/**
 * Verify an authentication ceremony's assertion (§7.2, steps 8–22) against the stored
 * credential the caller looked up by ID and bound to its user (steps 5–7).
 *
 * The counter (§6.1.1, step 22): when either the stored or the presented counter is non-zero,
 * the presented one must be strictly greater — anything else signals a cloned authenticator
 * (or a replayed assertion) and is refused with `counter`. Both zero means the authenticator
 * keeps no counter (synced passkeys), which is allowed.
 *
 * @param response The assertion.
 * @param credential The stored credential.
 * @param expected The challenge, origins, RP ID and policy.
 * @returns The new counter and flags.
 * @throws {WebAuthnError} Naming the check that failed.
 */
export async function verifyAuthentication(
  response: AuthenticationResponse,
  credential: StoredCredential,
  expected: AuthenticationExpectations,
): Promise<AuthenticationResult> {
  // Steps 8–14.
  checkClientData(parseClientData(response.clientDataJSON), { ...expected, type: "webauthn.get" });
  const authData = parseAuthenticatorData(response.authenticatorData);
  // Step 15.
  check(
    bytesEqual(authData.rpIdHash, await sha256(encoder.encode(expected.rpId))),
    "rp_id",
    "the assertion is for another RP ID",
  );
  // Steps 16–17.
  check(authData.flags.userPresent, "user_presence", "the user was not present");
  check(
    !expected.requireUserVerification || authData.flags.userVerified,
    "user_verification",
    "user verification was required",
  );
  // Step 18: BE is fixed at registration.
  check(
    authData.flags.backupEligible === credential.backupEligible,
    "backup_state",
    "the backup eligibility changed",
  );
  // An assertion carries no attested credential data.
  check(!authData.flags.attestedCredentialData, "malformed", "unexpected attested data");
  // Steps 20–21.
  const key = await importCredentialKey(credential.publicKey);
  const signed = concat(response.authenticatorData, await sha256(response.clientDataJSON));
  check(
    await verifySignature(key, response.signature, signed),
    "signature",
    "the assertion signature does not verify",
  );
  // Step 22.
  if (authData.signCount !== 0 || credential.signCount !== 0) {
    check(
      authData.signCount > credential.signCount,
      "counter",
      "the signature counter did not increase — possible cloned authenticator",
    );
  }
  return {
    signCount: authData.signCount,
    backedUp: authData.flags.backedUp,
    userVerified: authData.flags.userVerified,
  };
}

/**
 * Decode a base64url field of a client's JSON response, or throw `malformed`.
 *
 * @param value The field.
 * @param what Its name, for the message.
 * @returns The bytes.
 */
export function base64UrlField(value: unknown, what: string): Uint8Array {
  check(
    typeof value === "string" && /^[A-Za-z0-9_-]*$/.test(value) && value.length <= 65536,
    "malformed",
    `${what} is not base64url`,
  );
  try {
    return base64UrlDecode(value);
  } catch {
    throw new WebAuthnError("malformed", `${what} is not base64url`);
  }
}
