// Test helpers for X.509 path validation and the FIDO Metadata Service checks: a throwaway
// certificate authority built at test time (ECDSA P-256 keys from Web Crypto, certificates
// encoded here in DER and really signed), and a signed metadata BLOB (an ES256 JWS whose `x5c`
// chain is the caller's).

import { der, derOid } from "./_saml-helpers.ts";

/** A key pair and its SubjectPublicKeyInfo. */
export interface TestKeyPair {
  privateKey: CryptoKey;
  spki: Uint8Array;
}

/** A fresh ECDSA P-256 key pair. */
export async function testKey(): Promise<TestKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    privateKey: pair.privateKey,
    spki: new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

/** A DER INTEGER of non-negative big-endian bytes (leading zeros stripped, sign byte added). */
function derUint(bytes: Uint8Array): Uint8Array {
  let at = 0;
  while (at < bytes.length - 1 && bytes[at] === 0) at++;
  const body = Array.from(bytes.subarray(at));
  return der(0x02, body[0] & 0x80 ? [0, ...body] : body);
}

/** An ECDSA P-256 / SHA-256 signature, DER-encoded as X.509 carries it. */
async function signDer(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource),
  );
  return der(0x30, derUint(raw.subarray(0, 32)), derUint(raw.subarray(32)));
}

const utf8 = (s: string) => new TextEncoder().encode(s);
/** A Name with one CN. */
const nameOf = (cn: string): Uint8Array =>
  der(0x30, der(0x31, der(0x30, derOid("2.5.4.3"), der(0x0c, utf8(cn)))));
/** `YYMMDDHHMMSSZ` UTCTime of an epoch-ms time (years 1950–2049). */
function utcTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString(); // 2026-10-14T12:00:00.000Z
  const text = iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) +
    iso.slice(14, 16) + iso.slice(17, 19) + "Z";
  return der(0x17, utf8(text));
}

/** One extension. */
function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return der(0x30, derOid(oid), ...(critical ? [der(0x01, [0xff])] : []), der(0x04, value));
}

/** What a test certificate says. */
export interface CertOptions {
  /** The subject CN. */
  subject: string;
  /** The subject's public key. */
  key: TestKeyPair;
  /** The issuer's CN and signing key (default: self-signed). */
  issuer?: { cn: string; key: TestKeyPair };
  /** `basicConstraints` `cA` (omitted entirely when `undefined`). */
  ca?: boolean;
  /** `pathLenConstraint`. */
  pathLen?: number;
  /** `keyUsage` bits byte (e.g. `0x06` keyCertSign + cRLSign, `0x80` digitalSignature). */
  keyUsage?: number;
  /** `subjectAltName` dNSNames. */
  dns?: string[];
  /** Validity, epoch ms (default: a year either side of now). */
  notBefore?: number;
  notAfter?: number;
  /** An extra critical extension OID this validator doesn't know. */
  unknownCritical?: string;
}

/** The optional extensions of {@linkcode makeCert}. */
function extensionsFor(o: CertOptions): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (o.ca !== undefined) {
    const body = [
      ...(o.ca ? [der(0x01, [0xff])] : []),
      ...(o.pathLen !== undefined ? [der(0x02, [o.pathLen])] : []),
    ];
    out.push(extension("2.5.29.19", true, der(0x30, ...body)));
  }
  if (o.keyUsage !== undefined) {
    out.push(extension("2.5.29.15", true, der(0x03, [0x01, o.keyUsage])));
  }
  if (o.dns) {
    out.push(extension("2.5.29.17", false, der(0x30, ...o.dns.map((d) => der(0x82, utf8(d))))));
  }
  if (o.unknownCritical) out.push(extension(o.unknownCritical, true, der(0x05, [])));
  return out;
}

let serial = 1;

/**
 * A DER certificate, really signed by its issuer's key (ECDSA P-256 / SHA-256).
 *
 * @param o What it says.
 * @returns The DER.
 */
export async function makeCert(o: CertOptions): Promise<Uint8Array> {
  const now = Date.now();
  const issuer = o.issuer ?? { cn: o.subject, key: o.key };
  const algId = der(0x30, derOid("1.2.840.10045.4.3.2"));
  const extensions = extensionsFor(o);
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, [2])),
    der(0x02, [serial++ & 0x7f]),
    algId,
    nameOf(issuer.cn),
    der(
      0x30,
      utcTime(o.notBefore ?? now - 365 * 86_400_000),
      utcTime(o.notAfter ?? now + 365 * 86_400_000),
    ),
    nameOf(o.subject),
    o.key.spki,
    ...(extensions.length ? [der(0xa3, der(0x30, ...extensions))] : []),
  );
  const signature = await signDer(issuer.key.privateKey, tbs);
  return der(0x30, tbs, algId, der(0x03, [0, ...signature]));
}

/** Standard base64 of DER. */
export const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array): string =>
  b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A CA hierarchy for a test: root → intermediate → leaves. */
export interface TestPki {
  rootKey: TestKeyPair;
  root: Uint8Array;
  intermediateKey: TestKeyPair;
  intermediate: Uint8Array;
}

/** A root and an intermediate CA (both P-256). */
export async function testPki(rootCn = "Test Root"): Promise<TestPki> {
  const rootKey = await testKey();
  const root = await makeCert({ subject: rootCn, key: rootKey, ca: true, keyUsage: 0x06 });
  const intermediateKey = await testKey();
  const intermediate = await makeCert({
    subject: `${rootCn} Intermediate`,
    key: intermediateKey,
    issuer: { cn: rootCn, key: rootKey },
    ca: true,
    pathLen: 0,
    keyUsage: 0x06,
  });
  return { rootKey, root, intermediateKey, intermediate };
}

/** A leaf issued by `pki`'s intermediate. */
export async function leafOf(
  pki: TestPki,
  o: Partial<CertOptions> = {},
): Promise<{ key: TestKeyPair; cert: Uint8Array }> {
  const key = o.key ?? await testKey();
  const cert = await makeCert({
    subject: "Test Leaf",
    issuer: { cn: "Test Root Intermediate", key: pki.intermediateKey },
    ca: false,
    keyUsage: 0x80,
    ...o,
    key,
  });
  return { key, cert };
}

/** A metadata BLOB payload. */
export interface BlobPayload {
  no: number;
  nextUpdate: string;
  entries: unknown[];
}

/**
 * A signed metadata BLOB (ES256 compact JWS) over `payload`, with `x5c` = `chain`.
 *
 * @param payload The payload.
 * @param signer The leaf key.
 * @param chain The `x5c` certificates (leaf first).
 * @returns The JWT.
 */
export async function signBlob(
  payload: BlobPayload,
  signer: TestKeyPair,
  chain: Uint8Array[],
): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ alg: "ES256", typ: "JWT", x5c: chain.map(b64) })));
  const body = b64url(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      utf8(`${header}.${body}`) as BufferSource,
    ),
  );
  return `${header}.${body}.${b64url(sig)}`;
}

/** `YYYY-MM-DD` of an epoch-ms time. */
export const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
