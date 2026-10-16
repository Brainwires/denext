/**
 * The low-level pieces WebAuthn verification shares with the X.509 path validator and the
 * attestation formats: the refusal type, byte helpers, a DER reader, ECDSA signature
 * conversion and certificate extensions. No imports of its own beyond Node's constant-time
 * compare, so every verifier can depend on it without a cycle.
 *
 * @module
 */

import { timingSafeEqual } from "node:crypto";

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
export function check(
  condition: unknown,
  code: WebAuthnErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new WebAuthnError(code, message);
}

/** SHA-256 of `bytes`. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Constant-time equality of two byte strings (the length is not secret). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Concatenate byte strings (small, fixed inputs: authenticator data and a hash). */
export function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
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

/** One DER TLV. */
export interface Der {
  tag: number;
  /** The value bytes. */
  value: Uint8Array;
  /** The whole TLV, header included. */
  raw: Uint8Array;
}

/**
 * Read the DER TLV at `at`.
 *
 * @param bytes The DER bytes.
 * @param at The offset of the tag byte.
 * @returns The TLV.
 * @throws {WebAuthnError} `attestation` on malformed DER.
 */
export function derAt(bytes: Uint8Array, at: number): Der {
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

/**
 * The TLVs inside a constructed DER value.
 *
 * @param value The constructed value's content bytes.
 * @returns Its children, in order.
 * @throws {WebAuthnError} `attestation` on malformed DER.
 */
export function derChildren(value: Uint8Array): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < value.length;) {
    const child = derAt(value, at);
    out.push(child);
    at += child.raw.length;
  }
  return out;
}

/**
 * Hex of a byte string.
 *
 * @param bytes The bytes.
 * @returns Lowercase hex.
 */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One certificate extension: its criticality and the extnValue OCTET STRING's content. */
export interface CertificateExtension {
  critical: boolean;
  value: Uint8Array;
}

/**
 * The `[3] EXPLICIT Extensions` among a tbsCertificate's fields, by OID hex. A malformed
 * extension, or one that appears twice (RFC 5280 §4.2), fails the certificate.
 *
 * @param parts The tbsCertificate's fields.
 * @returns The extensions.
 * @throws {WebAuthnError} `attestation` on a malformed or repeated extension.
 */
export function certificateExtensions(parts: Der[]): Map<string, CertificateExtension> {
  const out = new Map<string, CertificateExtension>();
  const wrapper = parts.find((p) => p.tag === 0xa3);
  const [seq] = wrapper ? derChildren(wrapper.value) : [];
  for (const ext of seq ? derChildren(seq.value) : []) {
    // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
    const items = derChildren(ext.value);
    const octets = items[items.length - 1];
    check(items[0]?.tag === 0x06 && octets?.tag === 0x04, "attestation", "malformed extension");
    const id = hex(items[0].value);
    check(!out.has(id), "attestation", "a repeated certificate extension");
    out.set(id, {
      critical: items[1]?.tag === 0x01 && items[1].value[0] !== 0,
      value: octets.value,
    });
  }
  return out;
}

// ---- certificates (RFC 5280) -------------------------------------------------

/** What §8.2.1 asks of the attestation certificate. */
export interface Certificate {
  /** The `version` field's value (2 means v3). */
  version: number;
  /** Subject attributes by OID (hex of the DER body). */
  subject: Map<string, string>;
  /** The subject Name, DER (`30 00` when empty). */
  subjectDer: Uint8Array;
  /** The SubjectPublicKeyInfo, DER. */
  spki: Uint8Array;
  /** Extensions by OID hex: criticality and the OCTET STRING's content. */
  extensions: Map<string, CertificateExtension>;
}

/** The `version` of a tbsCertificate's parts (`[0] EXPLICIT INTEGER`, v1 when absent). */
function certificateVersion(parts: Der[]): { version: number; next: number } {
  if (parts[0]?.tag !== 0xa0) return { version: 0, next: 0 };
  const v = derChildren(parts[0].value)[0];
  check(v?.tag === 0x02 && v.value.length === 1, "attestation", "bad version");
  return { version: v.value[0], next: 1 };
}

/**
 * A Name's attributes by OID hex (RDNSequence of SETs of AttributeTypeAndValue), every RDN
 * and every attribute in it walked.
 *
 * @param name The Name.
 * @returns The values by OID.
 */
export function nameAttributes(name: Der): Map<string, string> {
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

/**
 * Parse the fields of a DER certificate that the attestation formats check (§8).
 *
 * @param der The certificate.
 * @returns Its version, subject, public key and extensions.
 * @throws {WebAuthnError} `attestation` on malformed DER.
 */
export function parseCertificate(der: Uint8Array): Certificate {
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
    subjectDer: subject.raw,
    spki: spki.raw,
    extensions: certificateExtensions(parts.slice(next + 6)),
  };
}
