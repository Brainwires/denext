/**
 * The certificate-bearing WebAuthn attestation statement formats beyond `packed` (W3C Web
 * Authentication Level 3 §8): `tpm` (§8.3), `android-key` (§8.4), `fido-u2f` (§8.6) and `apple`
 * (§8.8), each verified exactly as its verification procedure says. Like `packed`, a verified
 * statement establishes its attestation type and returns its `x5c`; chaining that certificate to
 * a trust anchor is the FIDO Metadata Service's job one layer up ({@link ./fido-mds.ts}).
 *
 * The statement signatures may use any COSE algorithm Web Crypto can verify: ES256 / ES384 /
 * ES512, RS256 / RS384 / RS512 / RS1, PS256 / PS384 / PS512 and EdDSA (Ed25519).
 *
 * @module
 */

import { decodeCbor } from "./cbor.ts";
import { base64UrlEncode } from "./oauth.ts";
import {
  bytesEqual,
  type Certificate,
  check,
  concat,
  derAt,
  derChildren,
  derToRawEcdsa,
  hex,
  nameAttributes,
  parseCertificate,
  sha256,
} from "./webauthn-der.ts";

/** What an attestation statement established (§6.5.4). */
export type AttestationType = "none" | "self" | "basic" | "attca" | "anonca";

/** A verified statement: its type, and the certificate path it carried (leaf first). */
export interface VerifiedAttestation {
  /** The attestation type. */
  type: AttestationType;
  /** The `x5c` (DER, leaf first), for a certificate-based type. */
  x5c?: Uint8Array[];
}

/** What a format's verification procedure is given (§8: `attStmt`, `authenticatorData`, …). */
export interface AttestationInput {
  /** The attestation statement map. */
  stmt: Map<number | string, unknown>;
  /** The raw authenticator data. */
  authData: Uint8Array;
  /** SHA-256 of `clientDataJSON`. */
  clientDataHash: Uint8Array;
  /** The credential public key (COSE_Key bytes). */
  credentialPublicKey: Uint8Array;
  /** The credential ID. */
  credentialId: Uint8Array;
  /** The authenticator's AAGUID. */
  aaguid: Uint8Array;
  /** The RP ID hash from the authenticator data. */
  rpIdHash: Uint8Array;
}

const OID_FIDO_AAGUID = "2b0601040182e51c010104";
const OID_BASIC_CONSTRAINTS = "551d13";
const OID_SUBJECT_ALT_NAME = "551d11";
const OID_EXT_KEY_USAGE = "551d25";
/** `tcg-kp-AIKCertificate`, 2.23.133.8.3. */
const OID_TCG_KP_AIK = "6781050803";
/** `tcg-at-tpmManufacturer` / `tpmModel` / `tpmVersion`, 2.23.133.2.1–3. */
const OID_TCG_AT = ["6781050201", "6781050202", "6781050203"];
/** The Android Key Attestation extension, 1.3.6.1.4.1.11129.2.1.17. */
const OID_ANDROID_KEY = "2b06010401d679020111";
/** Apple's anonymous attestation nonce extension, 1.2.840.113635.100.8.2. */
const OID_APPLE_NONCE = "2a864886f763640802";

const fail = (message: string): never => {
  check(false, "attestation", message);
  throw new Error("unreachable");
};

// ---- signatures and keys ---------------------------------------------------------------

/** A COSE signature algorithm (RFC 9053, RFC 8812) as Web Crypto verifies it. */
interface SignatureAlgorithm {
  kind: "EC" | "RSA" | "PSS" | "OKP";
  hash: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
}

const COSE_SIGNATURE: Record<number, SignatureAlgorithm> = {
  [-7]: { kind: "EC", hash: "SHA-256" },
  [-35]: { kind: "EC", hash: "SHA-384" },
  [-36]: { kind: "EC", hash: "SHA-512" },
  [-257]: { kind: "RSA", hash: "SHA-256" },
  [-258]: { kind: "RSA", hash: "SHA-384" },
  [-259]: { kind: "RSA", hash: "SHA-512" },
  [-65535]: { kind: "RSA", hash: "SHA-1" },
  [-37]: { kind: "PSS", hash: "SHA-256" },
  [-38]: { kind: "PSS", hash: "SHA-384" },
  [-39]: { kind: "PSS", hash: "SHA-512" },
  [-8]: { kind: "OKP", hash: "SHA-512" },
};

/** EC curves by SPKI parameter OID (hex): Web Crypto name, scalar size, COSE `crv`. */
const CURVES: Record<string, { name: string; size: number; crv: number }> = {
  "2a8648ce3d030107": { name: "P-256", size: 32, crv: 1 },
  "2b81040022": { name: "P-384", size: 48, crv: 2 },
  "2b81040023": { name: "P-521", size: 66, crv: 3 },
};

const HASH_BYTES = { "SHA-1": 20, "SHA-256": 32, "SHA-384": 48, "SHA-512": 64 } as const;

/** The algorithm a statement's `alg` names, or a refusal. */
function signatureAlgorithm(alg: unknown): SignatureAlgorithm {
  const spec = typeof alg === "number" ? COSE_SIGNATURE[alg] : undefined;
  return spec ?? fail("unsupported attestation signature algorithm");
}

/** An SPKI's curve, for an EC key (`undefined` for any other key). */
function spkiCurve(spki: Uint8Array): (typeof CURVES)[string] | undefined {
  const [alg] = derChildren(derAt(spki, 0).value);
  const [, params] = alg ? derChildren(alg.value) : [];
  return params?.tag === 0x06 ? CURVES[hex(params.value)] : undefined;
}

/** Import an SPKI for `spec` (extractable, so a key can also be compared). */
function importSpki(spki: Uint8Array, spec: SignatureAlgorithm, usage: KeyUsage[]) {
  const params = spec.kind === "EC"
    ? { name: "ECDSA", namedCurve: spkiCurve(spki)?.name ?? "" }
    : spec.kind === "RSA"
    ? { name: "RSASSA-PKCS1-v1_5", hash: spec.hash }
    : spec.kind === "PSS"
    ? { name: "RSA-PSS", hash: spec.hash }
    : { name: "Ed25519" };
  return crypto.subtle.importKey("spki", spki as BufferSource, params, true, usage);
}

/**
 * Verify a statement signature with a certificate's key: `false` when it doesn't verify, or the
 * key can't be used with `alg` (a malformed key included).
 *
 * @param spki The signer's SubjectPublicKeyInfo, DER.
 * @param alg The statement's COSE `alg`.
 * @param signature The signature (DER `r,s` for ECDSA).
 * @param data The signed bytes.
 * @returns Whether it verifies.
 */
async function verifyCoseSignature(
  spki: Uint8Array,
  alg: unknown,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const spec = signatureAlgorithm(alg);
  try {
    const key = await importSpki(spki, spec, ["verify"]);
    if (spec.kind === "EC") {
      const raw = derToRawEcdsa(signature, spkiCurve(spki)!.size);
      return !!raw && await crypto.subtle.verify(
        { name: "ECDSA", hash: spec.hash },
        key,
        raw as BufferSource,
        data as BufferSource,
      );
    }
    const params = spec.kind === "PSS"
      ? { name: "RSA-PSS", saltLength: HASH_BYTES[spec.hash] }
      : { name: key.algorithm.name };
    return await crypto.subtle.verify(params, key, signature as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

/** A COSE_Key map. */
function coseKey(bytes: Uint8Array): Map<number, unknown> {
  try {
    const map = decodeCbor(bytes);
    if (map instanceof Map) return map as Map<number, unknown>;
  } catch { /* refused below */ }
  return fail("the credential public key is not a COSE_Key");
}

const b64u = (value: unknown) => value instanceof Uint8Array ? base64UrlEncode(value) : "";

/**
 * Whether a certificate's public key is the credential public key (§8.4 step 3, §8.8 step 5):
 * the same key type, curve and point for EC2, modulus and exponent for RSA, point for OKP.
 *
 * @param spki The certificate's SubjectPublicKeyInfo, DER.
 * @param cose The credential public key, COSE_Key bytes.
 * @returns Whether they are one key.
 */
async function spkiMatchesCose(spki: Uint8Array, cose: Uint8Array): Promise<boolean> {
  const map = coseKey(cose);
  const kty = map.get(1);
  try {
    if (kty === 2) {
      const curve = spkiCurve(spki);
      if (!curve || map.get(-1) !== curve.crv) return false;
      const jwk = await crypto.subtle.exportKey(
        "jwk",
        await importSpki(spki, { kind: "EC", hash: "SHA-256" }, ["verify"]),
      );
      return jwk.x === b64u(map.get(-2)) && jwk.y === b64u(map.get(-3));
    }
    if (kty === 3) {
      const jwk = await crypto.subtle.exportKey(
        "jwk",
        await importSpki(spki, { kind: "RSA", hash: "SHA-256" }, ["verify"]),
      );
      return jwk.n === b64u(map.get(-1)) && jwk.e === b64u(map.get(-2));
    }
    if (kty === 1 && map.get(-1) === 6) {
      const jwk = await crypto.subtle.exportKey(
        "jwk",
        await importSpki(spki, { kind: "OKP", hash: "SHA-512" }, ["verify"]),
      );
      return jwk.x === b64u(map.get(-2));
    }
  } catch {
    return false;
  }
  return false;
}

// ---- shared statement checks ---------------------------------------------------------------

/** A statement's `x5c`: a non-empty array of DER certificates. */
function x5cOf(stmt: Map<number | string, unknown>): Uint8Array[] {
  const x5c = stmt.get("x5c");
  check(
    Array.isArray(x5c) && x5c.length >= 1 && x5c.every((c) => c instanceof Uint8Array),
    "attestation",
    "x5c must be a non-empty array of certificates",
  );
  return x5c as Uint8Array[];
}

/** A statement's `sig`. */
function sigOf(stmt: Map<number | string, unknown>): Uint8Array {
  const sig = stmt.get("sig");
  check(sig instanceof Uint8Array, "attestation", "the statement has no sig");
  return sig;
}

/**
 * The `id-fido-gen-ce-aaguid` extension, when present, is not critical and names the
 * authenticator data's AAGUID (§8.2.1, §8.3.1).
 *
 * @param cert The attestation certificate.
 * @param aaguid The authenticator data's AAGUID.
 */
export function checkAaguidExtension(cert: Certificate, aaguid: Uint8Array): void {
  const ext = cert.extensions.get(OID_FIDO_AAGUID);
  if (!ext) return;
  check(!ext.critical, "attestation", "the AAGUID extension must not be critical");
  const inner = derAt(ext.value, 0);
  check(
    inner.tag === 0x04 && bytesEqual(inner.value, aaguid),
    "attestation",
    "the certificate's AAGUID differs from the authenticator data's",
  );
}

/** Basic Constraints, when present, must not make the certificate a CA. */
function checkNotCa(cert: Certificate): void {
  const basic = cert.extensions.get(OID_BASIC_CONSTRAINTS);
  if (!basic) return;
  const [first] = derChildren(derAt(basic.value, 0).value);
  check(
    !(first?.tag === 0x01 && first.value[0] !== 0),
    "attestation",
    "the attestation certificate is a CA",
  );
}

// ---- tpm (§8.3) ------------------------------------------------------------------------------

/** A big-endian reader over a TPM structure (TPM 2.0 Part 2). */
class TpmReader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  private take(n: number): Uint8Array {
    check(this.at + n <= this.bytes.length, "attestation", "a truncated TPM structure");
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u16(): number {
    const b = this.take(2);
    return (b[0] << 8) | b[1];
  }
  u32(): number {
    const b = this.take(4);
    return ((b[0] << 24) >>> 0) + ((b[1] << 16) | (b[2] << 8) | b[3]);
  }
  /** A `TPM2B_*`: a 16-bit size, then that many bytes. */
  sized(): Uint8Array {
    return this.take(this.u16());
  }
  skip(n: number): void {
    this.take(n);
  }
  end(): void {
    check(this.at === this.bytes.length, "attestation", "trailing bytes in a TPM structure");
  }
}

const TPM_ALG_RSA = 0x0001;
const TPM_ALG_ECC = 0x0023;
const TPM_ALG_NULL = 0x0010;
const TPM_GENERATED_VALUE = 0xff544347;
const TPM_ST_ATTEST_CERTIFY = 0x8017;
/** `TPMI_ALG_HASH` → Web Crypto. */
const TPM_HASHES: Record<number, string> = {
  0x0004: "SHA-1",
  0x000b: "SHA-256",
  0x000c: "SHA-384",
  0x000d: "SHA-512",
};
/** `TPM_ECC_CURVE` → COSE `crv`. */
const TPM_CURVES: Record<number, number> = { 0x0003: 1, 0x0004: 2, 0x0005: 3 };

/** The parts of a `TPMT_PUBLIC` the checks read. */
interface TpmPublic {
  type: number;
  nameAlg: number;
  exponent?: number;
  curve?: number;
  unique: Uint8Array[];
}

/** A `TPMT_SYM_DEF_OBJECT` or a scheme: an algorithm, then details unless it is NULL. */
function skipScheme(r: TpmReader, detailBytes: number): void {
  if (r.u16() !== TPM_ALG_NULL) r.skip(detailBytes);
}

/** Parse `pubArea` (`TPMT_PUBLIC`): an RSA or ECC key. */
function parsePubArea(bytes: Uint8Array): TpmPublic {
  const r = new TpmReader(bytes);
  const type = r.u16();
  const nameAlg = r.u16();
  r.u32(); // objectAttributes
  r.sized(); // authPolicy
  skipScheme(r, 4); // symmetric: keyBits + mode
  skipScheme(r, 2); // scheme: hashAlg
  if (type === TPM_ALG_RSA) {
    r.u16(); // keyBits
    const exponent = r.u32();
    const unique = [r.sized()];
    r.end();
    return { type, nameAlg, exponent, unique };
  }
  check(type === TPM_ALG_ECC, "attestation", "pubArea is neither an RSA nor an ECC key");
  const curve = r.u16();
  skipScheme(r, 2); // kdf: hashAlg
  const unique = [r.sized(), r.sized()];
  r.end();
  return { type, nameAlg, curve, unique };
}

/** Big-endian integer bytes, leading zeros dropped. */
function trimmed(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
}

/** §8.3 step 2: `pubArea` is the credential public key. */
function checkPubAreaKey(pub: TpmPublic, cose: Uint8Array): void {
  const map = coseKey(cose);
  const same = (a: unknown, b: Uint8Array) =>
    a instanceof Uint8Array && bytesEqual(trimmed(a), trimmed(b));
  if (pub.type === TPM_ALG_RSA) {
    const e = pub.exponent === 0 ? 65537 : pub.exponent!;
    const eBytes = Uint8Array.of(e >>> 24, (e >>> 16) & 0xff, (e >>> 8) & 0xff, e & 0xff);
    check(
      map.get(1) === 3 && same(map.get(-1), pub.unique[0]) && same(map.get(-2), eBytes),
      "attestation",
      "pubArea is not the credential public key",
    );
    return;
  }
  check(
    map.get(1) === 2 && map.get(-1) === TPM_CURVES[pub.curve!] &&
      same(map.get(-2), pub.unique[0]) && same(map.get(-3), pub.unique[1]),
    "attestation",
    "pubArea is not the credential public key",
  );
}

/** The parts of a `TPMS_ATTEST` the checks read. */
interface TpmAttest {
  magic: number;
  type: number;
  extraData: Uint8Array;
  name: Uint8Array;
}

/** Parse `certInfo` (`TPMS_ATTEST` carrying a `TPMS_CERTIFY_INFO`). */
function parseCertInfo(bytes: Uint8Array): TpmAttest {
  const r = new TpmReader(bytes);
  const magic = r.u32();
  const type = r.u16();
  r.sized(); // qualifiedSigner
  const extraData = r.sized();
  r.skip(17); // clockInfo: clock (8), resetCount (4), restartCount (4), safe (1)
  r.skip(8); // firmwareVersion
  const name = r.sized();
  r.sized(); // qualifiedName
  r.end();
  return { magic, type, extraData, name };
}

/** A digest of `data` with a Web Crypto hash name. */
async function digest(hash: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, data as BufferSource));
}

/** §8.3 step 4: `certInfo` is a certify statement over this ceremony and this `pubArea`. */
async function checkCertInfo(
  info: TpmAttest,
  pubArea: Uint8Array,
  nameAlg: number,
  alg: SignatureAlgorithm,
  attToBeSigned: Uint8Array,
): Promise<void> {
  check(info.magic === TPM_GENERATED_VALUE, "attestation", "certInfo magic is not TPM_GENERATED");
  check(info.type === TPM_ST_ATTEST_CERTIFY, "attestation", "certInfo is not a certify statement");
  check(
    bytesEqual(info.extraData, await digest(alg.hash, attToBeSigned)),
    "attestation",
    "certInfo extraData is not the hash of the ceremony",
  );
  const hash = TPM_HASHES[nameAlg] ?? fail("unsupported pubArea nameAlg");
  const name = concat(Uint8Array.of(nameAlg >> 8, nameAlg & 0xff), await digest(hash, pubArea));
  check(bytesEqual(info.name, name), "attestation", "certInfo does not name pubArea");
}

/** The OIDs (hex) an extended-key-usage extension lists. */
function extendedKeyUsages(cert: Certificate): string[] {
  const ext = cert.extensions.get(OID_EXT_KEY_USAGE);
  if (!ext) return [];
  return derChildren(derAt(ext.value, 0).value).filter((n) => n.tag === 0x06).map((n) =>
    hex(n.value)
  );
}

/** The attribute OIDs of every directoryName in a Subject Alternative Name extension. */
function sanDirectoryAttributes(cert: Certificate): Set<string> {
  const ext = cert.extensions.get(OID_SUBJECT_ALT_NAME);
  check(ext, "attestation", "the AIK certificate has no Subject Alternative Name");
  const out = new Set<string>();
  for (const general of derChildren(derAt(ext.value, 0).value)) {
    if (general.tag !== 0xa4) continue; // [4] directoryName (EXPLICIT Name)
    for (const name of derChildren(general.value)) {
      for (const oid of nameAttributes(name).keys()) out.add(oid);
    }
  }
  return out;
}

/** §8.3.1: the AIK certificate's requirements. */
function checkAikCertificate(cert: Certificate, aaguid: Uint8Array): void {
  check(cert.version === 2, "attestation", "the AIK certificate is not X.509 v3");
  check(
    cert.subjectDer.length === 2,
    "attestation",
    "the AIK certificate's subject must be empty",
  );
  const san = sanDirectoryAttributes(cert);
  check(
    OID_TCG_AT.every((oid) => san.has(oid)),
    "attestation",
    "the AIK certificate's Subject Alternative Name lacks the TPM manufacturer, model or version",
  );
  check(
    extendedKeyUsages(cert).includes(OID_TCG_KP_AIK),
    "attestation",
    "the AIK certificate is not for tcg-kp-AIKCertificate",
  );
  checkNotCa(cert);
  checkAaguidExtension(cert, aaguid);
}

/**
 * The `tpm` statement (§8.3): `{ ver: "2.0", alg, x5c, sig, certInfo, pubArea }`.
 *
 * @param input The statement and the ceremony.
 * @returns `attca` with the `x5c`.
 * @throws {WebAuthnError} `attestation` naming the step that failed.
 */
async function verifyTpm(input: AttestationInput): Promise<VerifiedAttestation> {
  const { stmt } = input;
  check(stmt.get("ver") === "2.0", "attestation", "tpm ver must be 2.0");
  const alg = signatureAlgorithm(stmt.get("alg"));
  const sig = sigOf(stmt);
  const certInfo = stmt.get("certInfo");
  const pubArea = stmt.get("pubArea");
  check(
    certInfo instanceof Uint8Array && pubArea instanceof Uint8Array,
    "attestation",
    "tpm certInfo / pubArea",
  );
  // ECDAA was removed from the specification: only an x5c statement is accepted.
  const x5c = x5cOf(stmt);
  const pub = parsePubArea(pubArea);
  checkPubAreaKey(pub, input.credentialPublicKey);
  const attToBeSigned = concat(input.authData, input.clientDataHash);
  await checkCertInfo(parseCertInfo(certInfo), pubArea, pub.nameAlg, alg, attToBeSigned);
  const aik = parseCertificate(x5c[0]);
  check(
    await verifyCoseSignature(aik.spki, stmt.get("alg"), sig, certInfo),
    "attestation",
    "the tpm signature does not verify",
  );
  checkAikCertificate(aik, input.aaguid);
  return { type: "attca", x5c };
}

// ---- android-key (§8.4) -----------------------------------------------------------------------

/** One BER/DER node with its tag number decoded (high-tag-number form included). */
interface Asn1 {
  /** The class: 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  /** The tag number. */
  tag: number;
  /** The content bytes. */
  value: Uint8Array;
  /** The offset after the node. */
  end: number;
}

/** Read the node at `at`; Android's authorization lists use tags up to [10000]. */
function asn1At(bytes: Uint8Array, at: number): Asn1 {
  check(at + 2 <= bytes.length, "attestation", "truncated key description");
  const first = bytes[at++];
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0;; i++) {
      check(i < 4 && at < bytes.length, "attestation", "bad key description tag");
      const b = bytes[at++];
      tag = tag * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
  }
  check(at < bytes.length, "attestation", "truncated key description");
  let len = bytes[at++];
  if (len & 0x80) {
    const n = len & 0x7f;
    check(n >= 1 && n <= 3 && at + n <= bytes.length, "attestation", "bad key description length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[at++];
  }
  check(at + len <= bytes.length, "attestation", "key description length overruns");
  return { cls: first >> 6, tag, value: bytes.subarray(at, at + len), end: at + len };
}

/** The nodes inside a constructed value. */
function asn1Children(value: Uint8Array): Asn1[] {
  const out: Asn1[] = [];
  for (let at = 0; at < value.length;) {
    const node = asn1At(value, at);
    out.push(node);
    at = node.end;
  }
  return out;
}

/** A small non-negative INTEGER / ENUMERATED. */
function smallInt(node: Asn1 | undefined): number | undefined {
  if (!node || node.value.length === 0 || node.value.length > 4) return undefined;
  return node.value.reduce((n, b) => n * 256 + b, 0);
}

/** An AuthorizationList (`[n] EXPLICIT` fields) by tag number. */
function authorizationList(node: Asn1 | undefined): Map<number, Asn1> {
  const out = new Map<number, Asn1>();
  for (const field of node ? asn1Children(node.value) : []) {
    if (field.cls === 2) out.set(field.tag, field);
  }
  return out;
}

const KM_TAG_PURPOSE = 1;
const KM_TAG_ALL_APPLICATIONS = 600;
const KM_TAG_ORIGIN = 702;
const KM_ORIGIN_GENERATED = 0;
const KM_PURPOSE_SIGN = 2;

/** The integers of an `[1] EXPLICIT SET OF INTEGER` purpose field. */
function purposes(field: Asn1 | undefined): number[] {
  if (!field) return [];
  const [set] = asn1Children(field.value);
  return set ? asn1Children(set.value).map((n) => smallInt(n) ?? -1) : [];
}

/** The value of an `[702] EXPLICIT INTEGER` origin field. */
function originOf(field: Asn1 | undefined): number | undefined {
  return field ? smallInt(asn1Children(field.value)[0]) : undefined;
}

/**
 * §8.4 step 4: the key description says the key answers this ceremony
 * (`attestationChallenge`), is scoped to this app (no `allApplications`), was generated in the
 * keystore (`origin`) and signs (`purpose`) — judged over the union of the software- and
 * TEE-enforced lists.
 */
function checkKeyDescription(ext: Uint8Array, clientDataHash: Uint8Array): void {
  const seq = asn1At(ext, 0);
  const fields = asn1Children(seq.value);
  check(seq.tag === 0x10 && fields.length >= 8, "attestation", "malformed key description");
  const challenge = fields[4];
  check(
    challenge.tag === 0x04 && bytesEqual(challenge.value, clientDataHash),
    "attestation",
    "the key attestation challenge is not this ceremony's",
  );
  const lists = [authorizationList(fields[6]), authorizationList(fields[7])];
  check(
    lists.every((list) => !list.has(KM_TAG_ALL_APPLICATIONS)),
    "attestation",
    "the key is usable by every application",
  );
  const origins = lists.map((l) => originOf(l.get(KM_TAG_ORIGIN))).filter((o) => o !== undefined);
  check(
    origins.length > 0 && origins.every((o) => o === KM_ORIGIN_GENERATED),
    "attestation",
    "the key was not generated in the keystore",
  );
  const purpose = lists.flatMap((l) => purposes(l.get(KM_TAG_PURPOSE)));
  check(
    purpose.length > 0 && purpose.every((p) => p === KM_PURPOSE_SIGN),
    "attestation",
    "the key's purpose is not signing",
  );
}

/**
 * The `android-key` statement (§8.4): `{ alg, sig, x5c }`.
 *
 * @param input The statement and the ceremony.
 * @returns `basic` with the `x5c`.
 * @throws {WebAuthnError} `attestation` naming the step that failed.
 */
async function verifyAndroidKey(input: AttestationInput): Promise<VerifiedAttestation> {
  const { stmt } = input;
  const sig = sigOf(stmt);
  const x5c = x5cOf(stmt);
  const leaf = parseCertificate(x5c[0]);
  check(
    await verifyCoseSignature(
      leaf.spki,
      stmt.get("alg"),
      sig,
      concat(input.authData, input.clientDataHash),
    ),
    "attestation",
    "the android-key signature does not verify",
  );
  check(
    await spkiMatchesCose(leaf.spki, input.credentialPublicKey),
    "attestation",
    "the attestation certificate's key is not the credential key",
  );
  const ext = leaf.extensions.get(OID_ANDROID_KEY);
  check(ext, "attestation", "the certificate has no key attestation extension");
  checkKeyDescription(ext.value, input.clientDataHash);
  return { type: "basic", x5c };
}

// ---- fido-u2f (§8.6) -------------------------------------------------------------------------

/**
 * The `fido-u2f` statement (§8.6): `{ sig, x5c: [attCert] }`, an ECDSA P-256 signature over
 * `0x00 ‖ rpIdHash ‖ clientDataHash ‖ credentialId ‖ 0x04 ‖ x ‖ y`.
 *
 * @param input The statement and the ceremony.
 * @returns `basic` with the `x5c`.
 * @throws {WebAuthnError} `attestation` naming the step that failed.
 */
async function verifyFidoU2f(input: AttestationInput): Promise<VerifiedAttestation> {
  const { stmt } = input;
  const sig = sigOf(stmt);
  const x5c = x5cOf(stmt);
  check(x5c.length === 1, "attestation", "a fido-u2f x5c holds exactly one certificate");
  const cert = parseCertificate(x5c[0]);
  check(spkiCurve(cert.spki)?.name === "P-256", "attestation", "the U2F key is not P-256");
  const key = coseKey(input.credentialPublicKey);
  const x = key.get(-2);
  const y = key.get(-3);
  check(
    key.get(1) === 2 && key.get(-1) === 1 && x instanceof Uint8Array && x.length === 32 &&
      y instanceof Uint8Array && y.length === 32,
    "attestation",
    "a fido-u2f credential key must be EC2 P-256",
  );
  const verificationData = concat(
    Uint8Array.of(0x00),
    input.rpIdHash,
    input.clientDataHash,
    input.credentialId,
    Uint8Array.of(0x04),
    x,
    y,
  );
  check(
    await verifyCoseSignature(cert.spki, -7, sig, verificationData),
    "attestation",
    "the fido-u2f signature does not verify",
  );
  return { type: "basic", x5c };
}

// ---- apple (§8.8) ----------------------------------------------------------------------------

/**
 * The `apple` statement (§8.8): `{ x5c }`. The credential certificate's nonce extension must
 * hold `SHA-256(authenticatorData ‖ clientDataHash)`, and its key must be the credential key.
 *
 * @param input The statement and the ceremony.
 * @returns `anonca` with the `x5c`.
 * @throws {WebAuthnError} `attestation` naming the step that failed.
 */
async function verifyApple(input: AttestationInput): Promise<VerifiedAttestation> {
  const x5c = x5cOf(input.stmt);
  const cert = parseCertificate(x5c[0]);
  const nonce = await sha256(concat(input.authData, input.clientDataHash));
  const ext = cert.extensions.get(OID_APPLE_NONCE);
  check(ext, "attestation", "the credential certificate has no nonce extension");
  // SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
  const tagged = derChildren(derAt(ext.value, 0).value).find((n) => n.tag === 0xa1);
  const octets = tagged ? derAt(tagged.value, 0) : undefined;
  check(
    octets?.tag === 0x04 && bytesEqual(octets.value, nonce),
    "attestation",
    "the apple nonce is not this ceremony's",
  );
  check(
    await spkiMatchesCose(cert.spki, input.credentialPublicKey),
    "attestation",
    "the credential certificate's key is not the credential key",
  );
  return { type: "anonca", x5c };
}

/** The formats this module verifies, by `fmt`. */
export const CERTIFIED_FORMATS: Record<
  string,
  (input: AttestationInput) => Promise<VerifiedAttestation>
> = {
  tpm: verifyTpm,
  "android-key": verifyAndroidKey,
  "fido-u2f": verifyFidoU2f,
  apple: verifyApple,
};
