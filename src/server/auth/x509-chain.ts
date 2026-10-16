/**
 * X.509 certificate path validation (RFC 5280 §6, the subset a pinned-anchor relying party
 * needs) over Web Crypto: each certificate's signature over its `tbsCertificate` by the next
 * one's key, issuer/subject name chaining (exact DER), validity at `now`, `basicConstraints`
 * `cA` and `pathLenConstraint` on every issuer, `keyUsage` `keyCertSign` on an issuer that
 * declares a key usage, and no unrecognised critical extension anywhere in the path. The path
 * must end at one of the caller's trust anchors — a certificate given as an anchor is trusted
 * for its key and name; a certificate carried in the path is never trusted on its own.
 *
 * Signatures: RSASSA-PKCS1-v1_5 and ECDSA (P-256, P-384) with SHA-256/384/512. Revocation is
 * the caller's: pass a {@linkcode RevocationCheck} (the FIDO Metadata Service passes its CRL
 * cache, {@link ./crl.ts}) and every certificate of the validated path below the anchor is
 * checked against its issuer once the path is found. OCSP is not used.
 *
 * Used by the FIDO Metadata Service checks ({@link ./fido-mds.ts}): the metadata BLOB's
 * signing chain to the pinned FIDO root, and a packed attestation's `x5c` to the
 * authenticator's metadata roots.
 *
 * @module
 */

import {
  type CertificateExtension,
  certificateExtensions,
  type Der,
  derAt,
  derChildren,
  derToRawEcdsa,
  hex,
} from "./webauthn-der.ts";

/** A path that does not validate. The message names the check, never echoes input. */
export class CertificateChainError extends Error {
  override name = "CertificateChainError";
}

function fail(message: string): never {
  throw new CertificateChainError(message);
}

/** The fields path validation reads from one certificate. */
export interface ParsedCertificate {
  /** The whole certificate, DER. */
  der: Uint8Array;
  /** The serialNumber's content bytes. */
  serial: Uint8Array;
  /** The `tbsCertificate`, DER — what the issuer signed. */
  tbs: Uint8Array;
  /** The `signatureAlgorithm` OID, hex. */
  signatureAlgorithm: string;
  /** The signature's bytes (the BIT STRING without its unused-bits octet). */
  signature: Uint8Array;
  /** The issuer Name, DER. */
  issuer: Uint8Array;
  /** The subject Name, DER. */
  subject: Uint8Array;
  /** `notBefore`, epoch ms. */
  notBefore: number;
  /** `notAfter`, epoch ms. */
  notAfter: number;
  /** The SubjectPublicKeyInfo, DER. */
  spki: Uint8Array;
  /** Extensions by OID hex. */
  extensions: Map<string, CertificateExtension>;
}

const OID_BASIC_CONSTRAINTS = "551d13";
const OID_KEY_USAGE = "551d0f";
const OID_SUBJECT_ALT_NAME = "551d11";
/** Critical extensions this validator understands (or that constrain nothing it relies on). */
const UNDERSTOOD_CRITICAL = new Set([
  OID_BASIC_CONSTRAINTS,
  OID_KEY_USAGE,
  "551d25", // extKeyUsage
  "551d20", // certificatePolicies
  OID_SUBJECT_ALT_NAME,
]);
/** The longest path (certificates below the anchor) followed. */
const MAX_PATH = 6;

/**
 * `UTCTime` (YYMMDDHHMMSSZ) or `GeneralizedTime` (YYYYMMDDHHMMSSZ) → epoch ms.
 *
 * @param node The time node.
 * @returns Epoch ms.
 * @throws {CertificateChainError} On any other form.
 */
export function derTime(node: Der): number {
  const text = new TextDecoder().decode(node.value);
  const utc = node.tag === 0x17 && /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  const gen = node.tag === 0x18 && /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  const m = utc || gen;
  if (!m) fail("unsupported certificate time");
  let year = Number(m[1]);
  if (utc) year += year >= 50 ? 1900 : 2000; // RFC 5280 §4.1.2.5.1
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** The algorithm OID and signature bytes of a certificate's outer SEQUENCE. */
function outerSignature(alg: Der | undefined, sig: Der | undefined): [string, Uint8Array] {
  if (alg?.tag !== 0x30 || sig?.tag !== 0x03 || sig.value[0] !== 0) fail("bad signature fields");
  const [oid] = derChildren(alg.value);
  if (oid?.tag !== 0x06) fail("bad signature algorithm");
  return [hex(oid.value), sig.value.subarray(1)];
}

/** `notBefore` / `notAfter` of a Validity SEQUENCE, epoch ms. */
function validityOf(validity: Der): [number, number] {
  const [notBefore, notAfter] = derChildren(validity.value);
  if (!notBefore || !notAfter) fail("bad validity");
  return [derTime(notBefore), derTime(notAfter)];
}

/** The tbsCertificate's serial, issuer, validity, subject and SPKI (after the optional version). */
function tbsFields(parts: Der[]): { serial: Uint8Array; fields: Der[]; rest: Der[] } {
  const at = parts[0]?.tag === 0xa0 ? 1 : 0;
  // serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
  const serial = parts[at];
  const fields = parts.slice(at + 2, at + 6);
  if (serial?.tag !== 0x02) fail("bad serial number");
  if (fields.length !== 4 || fields.some((p) => p.tag !== 0x30)) fail("bad certificate body");
  return { serial: serial.value, fields, rest: parts.slice(at + 6) };
}

/**
 * Parse a DER certificate's path-validation fields.
 *
 * @param der The certificate.
 * @returns The parsed fields.
 * @throws {CertificateChainError} Or a `WebAuthnError` on malformed DER.
 */
function parseCertificate(der: Uint8Array): ParsedCertificate {
  const cert = derAt(der, 0);
  if (cert.tag !== 0x30 || cert.raw.length !== der.length) fail("not a certificate");
  const [tbs, alg, sig] = derChildren(cert.value);
  if (tbs?.tag !== 0x30) fail("no tbsCertificate");
  const [signatureAlgorithm, signature] = outerSignature(alg, sig);
  const { serial, fields: [issuer, validity, subject, spki], rest } = tbsFields(
    derChildren(tbs.value),
  );
  const [notBefore, notAfter] = validityOf(validity);
  return {
    der,
    serial,
    tbs: tbs.raw,
    signatureAlgorithm,
    signature,
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore,
    notAfter,
    spki: spki.raw,
    extensions: certificateExtensions(rest),
  };
}

/** `basicConstraints`: `cA` and `pathLenConstraint`. */
function basicConstraints(cert: ParsedCertificate): { ca: boolean; pathLen?: number } {
  const ext = cert.extensions.get(OID_BASIC_CONSTRAINTS);
  if (!ext) return { ca: false };
  const items = derChildren(derAt(ext.value, 0).value);
  const ca = items[0]?.tag === 0x01 && items[0].value[0] !== 0;
  const len = items.find((i) => i.tag === 0x02);
  return len && len.value.length <= 2
    ? { ca, pathLen: len.value.reduce((n, b) => n * 256 + b, 0) }
    : { ca };
}

/** Whether a `keyUsage` extension, when present, allows signing certificates (bit 5). */
function mayCertSign(cert: ParsedCertificate): boolean {
  const ext = cert.extensions.get(OID_KEY_USAGE);
  if (!ext) return true;
  const bits = derAt(ext.value, 0);
  return bits.tag === 0x03 && bits.value.length >= 2 && (bits.value[1] & 0x04) !== 0;
}

/** Hash, key family and EC curve per signature algorithm OID. */
const SIGNATURE_ALGORITHMS: Record<string, { hash: string; kind: "RSA" | "EC" }> = {
  "2a864886f70d01010b": { hash: "SHA-256", kind: "RSA" },
  "2a864886f70d01010c": { hash: "SHA-384", kind: "RSA" },
  "2a864886f70d01010d": { hash: "SHA-512", kind: "RSA" },
  "2a8648ce3d040302": { hash: "SHA-256", kind: "EC" },
  "2a8648ce3d040303": { hash: "SHA-384", kind: "EC" },
  "2a8648ce3d040304": { hash: "SHA-512", kind: "EC" },
};

/** EC curve OIDs (hex) → Web Crypto names and scalar sizes. */
const CURVES: Record<string, { name: string; size: number }> = {
  "2a8648ce3d030107": { name: "P-256", size: 32 },
  "2b81040022": { name: "P-384", size: 48 },
};

/** The SPKI's curve, for an EC key. */
function spkiCurve(spki: Uint8Array): { name: string; size: number } {
  const [alg] = derChildren(derAt(spki, 0).value);
  const [, params] = alg ? derChildren(alg.value) : [];
  const curve = params?.tag === 0x06 ? CURVES[hex(params.value)] : undefined;
  if (!curve) fail("unsupported EC curve");
  return curve;
}

/**
 * Verify a signature with the public key in `spki`, for a signature algorithm OID.
 *
 * @param spki The signer's SubjectPublicKeyInfo, DER.
 * @param algorithm The signature algorithm OID, hex (X.509) — or a JWS `alg`.
 * @param signature The signature (DER for ECDSA in X.509, raw `r‖s` for a JWS).
 * @param data The signed bytes.
 * @returns Whether it verifies (a key the algorithm can't use is `false`).
 */
export async function verifyWithSpki(
  spki: Uint8Array,
  algorithm: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const spec = SIGNATURE_ALGORITHMS[algorithm] ?? JWS_ALGORITHMS[algorithm];
  if (!spec) return false;
  try {
    if (spec.kind === "RSA") {
      const key = await crypto.subtle.importKey(
        "spki",
        spki as BufferSource,
        { name: "RSASSA-PKCS1-v1_5", hash: spec.hash },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature as BufferSource,
        data as BufferSource,
      );
    }
    const curve = spkiCurve(spki);
    const raw = algorithm in JWS_ALGORITHMS ? signature : derToRawEcdsa(signature, curve.size);
    if (!raw || raw.length !== curve.size * 2) return false;
    const key = await crypto.subtle.importKey(
      "spki",
      spki as BufferSource,
      { name: "ECDSA", namedCurve: curve.name },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: spec.hash },
      key,
      raw as BufferSource,
      data as BufferSource,
    );
  } catch {
    return false;
  }
}

/** JWS `alg` values (RFC 7518 §3.1) a signed metadata BLOB may use. */
const JWS_ALGORITHMS: Record<string, { hash: string; kind: "RSA" | "EC" }> = {
  RS256: { hash: "SHA-256", kind: "RSA" },
  RS384: { hash: "SHA-384", kind: "RSA" },
  RS512: { hash: "SHA-512", kind: "RSA" },
  ES256: { hash: "SHA-256", kind: "EC" },
  ES384: { hash: "SHA-384", kind: "EC" },
};

/** Byte equality (public data). */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Validity at `now`, and no critical extension this validator doesn't understand. */
function checkUsable(cert: ParsedCertificate, now: number): void {
  if (now < cert.notBefore || now > cert.notAfter) fail("a certificate is outside its validity");
  for (const [id, ext] of cert.extensions) {
    if (ext.critical && !UNDERSTOOD_CRITICAL.has(id)) fail("unrecognised critical extension");
  }
}

/**
 * `issuer` may sign `child` with `below` CA certificates between them and the leaf. A trust
 * anchor is trusted for its key and name as configured (RFC 5280 §6.1.1 (d)), so `cA` and
 * `keyUsage` are required of the carried intermediates only — an old v1 root has neither.
 */
async function issues(
  issuer: ParsedCertificate,
  child: ParsedCertificate,
  below: number,
  anchor = false,
): Promise<boolean> {
  if (!same(issuer.subject, child.issuer)) return false;
  const constraints = basicConstraints(issuer);
  if (!anchor && (!constraints.ca || !mayCertSign(issuer))) return false;
  if (constraints.pathLen !== undefined && below > constraints.pathLen) return false;
  return await verifyWithSpki(issuer.spki, child.signatureAlgorithm, child.signature, child.tbs);
}

/** The anchor that issued `cert` (or `cert` itself, byte for byte), if any. */
async function anchorFor(
  cert: ParsedCertificate,
  anchors: ParsedCertificate[],
  below: number,
): Promise<ParsedCertificate | undefined> {
  for (const anchor of anchors) {
    if (same(anchor.der, cert.der)) return anchor;
    if (await issues(anchor, cert, below, true)) return anchor;
  }
  return undefined;
}

/** The next certificate up the path among the carried intermediates, if one issued `cert`. */
async function intermediateFor(
  cert: ParsedCertificate,
  pool: ParsedCertificate[],
  below: number,
): Promise<ParsedCertificate | undefined> {
  for (const candidate of pool) {
    if (await issues(candidate, cert, below)) return candidate;
  }
  return undefined;
}

/**
 * Checks one certificate of a validated path for revocation, given its issuer; throws to refuse
 * the path.
 */
export type RevocationCheck = (
  cert: ParsedCertificate,
  issuer: ParsedCertificate,
  now: number,
) => Promise<void>;

/** Run `revocation` over each certificate of the path and its issuer (the anchor last). */
async function checkRevocation(
  path: ParsedCertificate[],
  anchor: ParsedCertificate,
  now: number,
  revocation: RevocationCheck | undefined,
): Promise<void> {
  if (!revocation) return;
  for (let i = 0; i < path.length; i++) {
    const issuer = path[i + 1] ?? anchor;
    if (same(path[i].der, anchor.der)) continue; // the anchor itself is trusted as configured
    await revocation(path[i], issuer, now);
  }
}

/**
 * Validate a certification path from `chain[0]` (the end entity) to one of `anchors`, using the
 * rest of `chain` as untrusted intermediates in any order.
 *
 * @param chain The end-entity certificate first, then intermediates (DER).
 * @param anchors The trust anchors (DER) — trusted for their key and name (their own `cA` and
 *   `keyUsage` aren't required), and checked for validity at `now` like every certificate.
 * @param now The validation time, epoch ms.
 * @param revocation Checks each certificate of the found path against its issuer (optional).
 * @returns The parsed end-entity certificate.
 * @throws {CertificateChainError} When no valid path reaches an anchor — or whatever
 *   `revocation` throws for a revoked certificate.
 */
export async function verifyCertificateChain(
  chain: readonly Uint8Array[],
  anchors: readonly Uint8Array[],
  now: number,
  revocation?: RevocationCheck,
): Promise<ParsedCertificate> {
  if (chain.length === 0 || chain.length > MAX_PATH) fail("bad certificate path length");
  const [leaf, ...pool] = chain.map(parseCertificate);
  const roots = anchors.map(parseCertificate);
  let current = leaf;
  const path = [leaf];
  checkUsable(current, now);
  for (let below = 0; below < MAX_PATH; below++) {
    const anchor = await anchorFor(current, roots, below);
    if (anchor) {
      checkUsable(anchor, now);
      await checkRevocation(path, anchor, now, revocation);
      return leaf;
    }
    const next = await intermediateFor(current, pool, below);
    if (!next) break;
    checkUsable(next, now);
    pool.splice(pool.indexOf(next), 1);
    path.push(next);
    current = next;
  }
  return fail("the certificate path does not reach a trust anchor");
}

/**
 * The DNS names a certificate is for: its `subjectAltName` dNSNames, or — without that
 * extension — nothing (a CN is not a host name, RFC 6125 §6.4.4).
 *
 * @param cert The certificate.
 * @returns The lower-cased DNS names.
 */
export function dnsNames(cert: ParsedCertificate): string[] {
  const ext = cert.extensions.get(OID_SUBJECT_ALT_NAME);
  if (!ext) return [];
  return derChildren(derAt(ext.value, 0).value)
    .filter((name) => name.tag === 0x82) // [2] IMPLICIT IA5String dNSName
    .map((name) => new TextDecoder().decode(name.value).toLowerCase());
}

/**
 * The DER bytes of a base64 (standard alphabet) certificate, as JWS `x5c` and FIDO metadata
 * carry them.
 *
 * @param text The base64.
 * @returns The DER.
 * @throws {CertificateChainError} When it isn't base64.
 */
export function base64Der(text: unknown): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4) {
    fail("a certificate is not base64");
  }
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
