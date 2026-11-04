/**
 * Just enough DER to take the SubjectPublicKeyInfo out of an X.509 certificate and say
 * what kind of key it holds, so WebCrypto can import it (`spki`). The certificate's own
 * signature, validity and extensions are deliberately not interpreted: SAML trust is the
 * configured certificate itself (key pinning), never a chain.
 *
 * @module
 */

import { SamlError } from "./errors.ts";

/** A public key taken from a configured certificate. */
export interface CertificateKey {
  /** The DER SubjectPublicKeyInfo, ready for `crypto.subtle.importKey("spki", …)`. */
  spki: Uint8Array<ArrayBuffer>;
  /** The key family. */
  kind: "RSA" | "EC";
  /** The named curve, for an EC key. */
  namedCurve?: "P-256" | "P-384" | "P-521";
}

function bad(message: string): never {
  throw new SamlError("bad_certificate", message);
}

interface Tlv {
  tag: number;
  /** Offset of the first content byte. */
  start: number;
  /** Offset just past the last content byte. */
  end: number;
  /** Offset of the tag byte (the element's first byte). */
  head: number;
}

function readTlv(der: Uint8Array, pos: number, limit: number): Tlv {
  if (pos + 2 > limit) bad("truncated DER");
  const tag = der[pos];
  if ((tag & 0x1f) === 0x1f) bad("high-tag-number DER is not supported");
  let len = der[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) bad("unsupported DER length");
    if (start + n > limit) bad("truncated DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i];
    start += n;
  }
  const end = start + len;
  if (end > limit) bad("DER length overruns its container");
  return { tag, start, end, head: pos };
}

/** The children of a constructed TLV. */
function children(der: Uint8Array, tlv: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = tlv.start;
  while (pos < tlv.end) {
    const child = readTlv(der, pos, tlv.end);
    out.push(child);
    pos = child.end;
  }
  return out;
}

function oid(der: Uint8Array, tlv: Tlv): string {
  if (tlv.tag !== 0x06 || tlv.end === tlv.start) bad("expected an OBJECT IDENTIFIER");
  const bytes = der.subarray(tlv.start, tlv.end);
  const parts: number[] = [];
  let value = 0;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  const first = parts.shift()!;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

const CURVES: Record<string, CertificateKey["namedCurve"]> = {
  "1.2.840.10045.3.1.7": "P-256",
  "1.3.132.0.34": "P-384",
  "1.3.132.0.35": "P-521",
};

function keyFromSpki(der: Uint8Array<ArrayBuffer>, spki: Tlv): CertificateKey {
  const [alg] = children(der, spki);
  if (!alg || alg.tag !== 0x30) bad("bad SubjectPublicKeyInfo");
  const [algOid, params] = children(der, alg);
  const id = oid(der, algOid);
  const bytes = der.slice(spki.head, spki.end);
  if (id === "1.2.840.113549.1.1.1") return { spki: bytes, kind: "RSA" };
  if (id === "1.2.840.10045.2.1") {
    const curve = params ? CURVES[oid(der, params)] : undefined;
    if (!curve) bad("unsupported EC curve");
    return { spki: bytes, kind: "EC", namedCurve: curve };
  }
  return bad(`unsupported public key algorithm ${id}`);
}

/** Decode strict base64 (whitespace allowed between characters). */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  const s = text.replace(/[ \t\r\n]/g, "");
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The DER bytes of a PEM `CERTIFICATE` block or a bare base64 certificate. */
function certificateDer(cert: string): Uint8Array<ArrayBuffer> {
  let body = cert.trim();
  const pem = /^-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----$/.exec(body);
  if (pem) body = pem[1];
  else if (body.startsWith("-----")) bad("expected a PEM CERTIFICATE block");
  const der = decodeBase64(body);
  if (!der || der.byteLength === 0) bad("certificate is not valid base64");
  return der;
}

/**
 * Take the public key out of an X.509 certificate.
 *
 * @param cert PEM (`-----BEGIN CERTIFICATE-----`) or bare base64 DER.
 * @throws {SamlError} `bad_certificate` when it cannot be parsed or the key type is not
 *   RSA or EC P-256/P-384/P-521.
 */
export function certificateKey(cert: string): CertificateKey {
  const der = certificateDer(cert);
  const outer = readTlv(der, 0, der.length);
  if (outer.tag !== 0x30 || outer.end !== der.length) bad("not a DER certificate");
  const [tbs] = children(der, outer);
  if (!tbs || tbs.tag !== 0x30) bad("missing tbsCertificate");
  const fields = children(der, tbs);
  // [0] EXPLICIT version is optional; then serial, signature, issuer, validity, subject, SPKI.
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const spki = fields[offset + 5];
  if (!spki || spki.tag !== 0x30) bad("missing SubjectPublicKeyInfo");
  return keyFromSpki(der, spki);
}
