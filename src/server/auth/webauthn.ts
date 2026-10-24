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
 * - the attestation statement (§8): `none` (§8.7), `packed` (§8.2) — self attestation, or
 *   an `x5c` leaf whose signature and §8.2.1 certificate requirements are checked — `tpm`,
 *   `android-key`, `android-safetynet`, `fido-u2f` and `apple` ({@link ./webauthn-attestation.ts}),
 *   and `compound` (§8.9), each of its statements verified; the chain to a trust anchor is
 *   evaluated only with `passkeys.attestation.mds`, one layer up (see
 *   {@linkcode RegistrationResult}) — but for android-safetynet's, to Google's root;
 * - the assertion signature over `authenticatorData ‖ SHA-256(clientDataJSON)` (§7.2 step 20),
 *   the backup-eligibility flag against the stored record, and the signature counter (§6.1.1):
 *   a counter that doesn't increase is a possible cloned authenticator and is refused.
 *
 * The functions are pure: challenge storage (single use) and the credential records live in
 * the adapter, one layer up ({@link ./passkeys.ts}).
 *
 * @module
 */

import { decodeCbor, decodeCborPrefix } from "./cbor.ts";
import { base64UrlDecode, base64UrlEncode } from "./oauth.ts";
import {
  bytesEqual,
  type Certificate,
  check,
  concat,
  derAt,
  derChildren,
  derToRawEcdsa,
  parseCertificate,
  sha256,
  WebAuthnError,
} from "./webauthn-der.ts";

import {
  type AttestationType,
  CERTIFIED_FORMATS,
  checkAaguidExtension,
  type VerifiedAttestation,
} from "./webauthn-attestation.ts";

export { derToRawEcdsa, hex, WebAuthnError, type WebAuthnErrorCode } from "./webauthn-der.ts";

/** A COSE algorithm this relying party verifies: ES256, RS256 or EdDSA (Ed25519). */
export type PasskeyAlgorithm = -7 | -257 | -8;

/** The supported algorithms, in the preference order offered to the client. */
export const PASSKEY_ALGORITHMS: readonly PasskeyAlgorithm[] = [-8, -7, -257];

const encoder = new TextEncoder();

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
  /**
   * Accept an attestation statement format this relying party can't verify (one outside
   * {@linkcode AttestationFormat}, or a `compound` statement holding one) as no attestation
   * (`fmt: "none"`) instead of refusing the registration — what a relying party that asks for
   * `"direct"` attestation but accepts unattested credentials needs. Default `false`.
   */
  acceptUnverifiedFormats?: boolean;
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
  /**
   * The attestation statement format — `"none"` also for a format accepted unverified under
   * {@linkcode RegistrationExpectations.acceptUnverifiedFormats}.
   */
  fmt: AttestationFormat;
  /**
   * What the attestation established (§6.5.4): `"none"`, `"self"` (packed without `x5c`),
   * `"basic"` (packed / android-key / android-safetynet / fido-u2f with a verified `x5c` leaf),
   * `"attca"` (tpm) or `"anonca"` (apple); for `compound`, its first certificate statement's
   * type. This function does not chain the leaf to a trust anchor (but for android-safetynet's
   * chain to Google's root), so on its own a certificate type is unverified attestation, never
   * proof of a specific authenticator model; `passkeys.attestation.mds` chains it to the FIDO
   * Metadata Service's roots one layer up ({@link ./fido-mds.ts}).
   */
  attestationType: AttestationType;
  /**
   * The statement's `x5c` (DER, leaf first), for a certificate attestation type — for
   * `compound`, its first certificate statement's.
   */
  attestationCertificates?: Uint8Array[];
  /** For `compound` (§8.9): each verified statement, in order. */
  attestationStatements?: VerifiedStatement[];
}

/** One statement of a verified `compound` attestation. */
export interface VerifiedStatement {
  /** Its format. */
  fmt: Exclude<AttestationFormat, "compound">;
  /** What it established. */
  attestationType: AttestationType;
  /** Its `x5c` (DER, leaf first), for a certificate attestation type. */
  attestationCertificates?: Uint8Array[];
}

/** The attestation statement formats this relying party verifies. */
export type AttestationFormat =
  | "none"
  | "packed"
  | "tpm"
  | "android-key"
  | "android-safetynet"
  | "fido-u2f"
  | "apple"
  | "compound";

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
    typeof fmt === "string" && authDataBytes instanceof Uint8Array &&
      (attStmt instanceof Map || (fmt === "compound" && Array.isArray(attStmt))),
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
  const ceremony = {
    authData: authDataBytes,
    clientDataHash,
    credentialPublicKey: attested.publicKey,
    credentialId: attested.credentialId,
    aaguid: attested.aaguid,
    rpIdHash: authData.rpIdHash,
  };
  const unverified = expected.acceptUnverifiedFormats === true;
  const attestation = fmt === "compound"
    ? await verifyCompound(attStmt as unknown[], ceremony, credential, unverified)
    : await verifyAttestation(
      fmt,
      { stmt: attStmt as Map<number | string, unknown>, ...ceremony },
      credential,
      unverified,
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
    fmt: attestation.unverified ? "none" : fmt as AttestationFormat,
    attestationType: attestation.type,
    ...(attestation.x5c ? { attestationCertificates: attestation.x5c } : {}),
    ...(attestation.statements ? { attestationStatements: attestation.statements } : {}),
  };
}

/** Whether `fmt` is a single-statement format this relying party verifies. */
function isVerifiedFormat(fmt: string): fmt is Exclude<AttestationFormat, "compound"> {
  return fmt === "none" || fmt === "packed" || Object.hasOwn(CERTIFIED_FORMATS, fmt);
}

/** A verified statement, as the registration reports it. */
interface Attested extends VerifiedAttestation {
  /** An unsupported format accepted unverified: reported as `fmt: "none"`. */
  unverified?: boolean;
  /** For `compound`: each statement. */
  statements?: VerifiedStatement[];
}

/** The most statements a `compound` attestation may hold. */
const MAX_COMPOUND = 8;

/**
 * The `compound` statement (L3 §8.9): an array of at least two `{ fmt, attStmt }` maps, none
 * itself `compound`, each verified by its own format's procedure over the same ceremony; any
 * failure refuses the registration. The result's type and `x5c` are its first certificate
 * statement's (else `self`, else `none`), and every statement is reported.
 */
async function verifyCompound(
  stmts: unknown[],
  ceremony: Omit<Parameters<(typeof CERTIFIED_FORMATS)[string]>[0], "stmt">,
  credential: CredentialKey,
  acceptUnverifiedFormats: boolean,
): Promise<Attested> {
  check(
    stmts.length >= 2 && stmts.length <= MAX_COMPOUND,
    "attestation",
    "a compound attestation holds 2 to 8 statements",
  );
  const entries = stmts.map(compoundEntry);
  // A format denext can't verify, accepted unverified: the whole compound proves nothing.
  if (acceptUnverifiedFormats && entries.some(([fmt]) => !isVerifiedFormat(fmt))) {
    return { type: "none", unverified: true };
  }
  const statements: VerifiedStatement[] = [];
  for (const [fmt, stmt] of entries) {
    const result = await verifyAttestation(fmt, { stmt, ...ceremony }, credential, false);
    statements.push({
      fmt: fmt as VerifiedStatement["fmt"],
      attestationType: result.type,
      ...(result.x5c ? { attestationCertificates: result.x5c } : {}),
    });
  }
  return { ...compoundType(statements), statements };
}

/** One `{ fmt, attStmt }` entry of a compound statement, not itself compound. */
function compoundEntry(entry: unknown): [string, Map<number | string, unknown>] {
  const map = entry instanceof Map ? entry : new Map();
  const fmt = map.get("fmt");
  const stmt = map.get("attStmt");
  check(
    typeof fmt === "string" && fmt !== "compound" && stmt instanceof Map,
    "attestation",
    "a compound statement entry must be a non-compound { fmt, attStmt }",
  );
  return [fmt, stmt];
}

/** A compound's type and `x5c`: its first certificate statement's, else `self`, else `none`. */
function compoundType(statements: VerifiedStatement[]): VerifiedAttestation {
  const certified = statements.find((s) => s.attestationCertificates);
  if (certified) return { type: certified.attestationType, x5c: certified.attestationCertificates };
  return { type: statements.some((s) => s.attestationType === "self") ? "self" : "none" };
}

/**
 * Verify the attestation statement (§7.1 step 21) for the formats denext supports.
 *
 * @returns The attestation type it established (and the `x5c` chain of a certificate one).
 */
async function verifyAttestation(
  fmt: string,
  input: Parameters<(typeof CERTIFIED_FORMATS)[string]>[0],
  credential: CredentialKey,
  acceptUnverifiedFormats: boolean,
): Promise<Attested> {
  // An unsupported format, accepted unverified: its statement proves nothing here.
  if (!isVerifiedFormat(fmt) && acceptUnverifiedFormats) return { type: "none", unverified: true };
  if (fmt === "none") {
    // §8.7: the statement is the empty map.
    check(input.stmt.size === 0, "attestation", "a none attestation statement must be empty");
    return { type: "none" };
  }
  if (fmt === "packed") {
    const signed = concat(input.authData, input.clientDataHash);
    return await verifyPacked(input.stmt, signed, credential, input.aaguid);
  }
  check(isVerifiedFormat(fmt), "attestation", "unsupported attestation format");
  return await CERTIFIED_FORMATS[fmt](input);
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
): Promise<VerifiedAttestation> {
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
    return { type: "self" };
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
  return { type: "basic", x5c: x5c as Uint8Array[] };
}

// ---- a minimal X.509 reader (RFC 5280) for the packed leaf (§8.2.1) -------------------

const OID_C = "550406";
const OID_O = "55040a";
const OID_OU = "55040b";
const OID_CN = "550403";
const OID_BASIC_CONSTRAINTS = "551d13";

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
  checkAaguidExtension(cert, aaguid);
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
