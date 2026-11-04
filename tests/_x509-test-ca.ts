// Test helpers for X.509 path validation and the FIDO Metadata Service checks: a throwaway
// certificate authority built at test time (ECDSA P-256 keys from Web Crypto, certificates
// encoded here in DER and really signed), a signed metadata BLOB (an ES256 JWS whose `x5c`
// chain is the caller's), CRLs and OCSP responses (RFC 6960) signed by the CA or a delegated
// responder.

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
export async function signDer(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
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
  /** CRL distribution point URIs. */
  crlUrls?: string[];
  /** The serial number (1–127; default: the next one). */
  serial?: number;
  /** OCSP responder URIs (Authority Information Access, `id-ad-ocsp`). */
  ocspUrls?: string[];
  /** Extended key usage `id-kp-OCSPSigning` (a delegated OCSP responder). */
  ocspSigning?: boolean;
  /** The whole subject Name, DER (default: one CN, {@linkcode CertOptions.subject}). */
  subjectName?: Uint8Array;
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
  out.push(...ocspExtensions(o));
  if (o.crlUrls) {
    // SEQUENCE OF DistributionPoint { [0] distributionPoint { [0] fullName { [6] URI } } }
    const points = o.crlUrls.map((u) => der(0x30, der(0xa0, der(0xa0, der(0x86, utf8(u))))));
    out.push(extension("2.5.29.31", false, der(0x30, ...points)));
  }
  return out;
}

/** The OCSP extensions of {@linkcode makeCert}: AIA responders, OCSPSigning. */
function ocspExtensions(o: CertOptions): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (o.ocspUrls) {
    // SEQUENCE OF AccessDescription { id-ad-ocsp, [6] URI }
    const access = o.ocspUrls.map((u) =>
      der(0x30, derOid("1.3.6.1.5.5.7.48.1"), der(0x86, utf8(u)))
    );
    out.push(extension("1.3.6.1.5.5.7.1.1", false, der(0x30, ...access)));
  }
  if (o.ocspSigning) {
    out.push(extension("2.5.29.37", false, der(0x30, derOid("1.3.6.1.5.5.7.3.9"))));
  }
  return out;
}

let serial = 1;

/**
 * The fixed clock the FIDO metadata tests run on (passed as every `now`): noon UTC, so a BLOB's
 * day-granular `nextUpdate` is never within hours of it. The wall clock made the rollback test
 * fail between 23:00 and 24:00 UTC, when `day(now + 5 days)` + the grace day fell before the
 * test's own `now + 5 days + 1 h`.
 */
export const TEST_NOW: number = Date.UTC(2026, 5, 15, 12);

/**
 * A DER certificate, really signed by its issuer's key (ECDSA P-256 / SHA-256).
 *
 * @param o What it says.
 * @returns The DER.
 */
export async function makeCert(o: CertOptions): Promise<Uint8Array> {
  const now = TEST_NOW;
  const issuer = o.issuer ?? { cn: o.subject, key: o.key };
  const algId = der(0x30, derOid("1.2.840.10045.4.3.2"));
  const extensions = extensionsFor(o);
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, [2])),
    der(0x02, [o.serial ?? (serial++ & 0x7f)]),
    algId,
    nameOf(issuer.cn),
    der(
      0x30,
      utcTime(o.notBefore ?? now - 3650 * 86_400_000),
      utcTime(o.notAfter ?? now + 3650 * 86_400_000),
    ),
    o.subjectName ?? nameOf(o.subject),
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

/** What a test CRL says. */
export interface CrlOptions {
  /** The issuer's CN and signing key. */
  issuer: { cn: string; key: TestKeyPair };
  /** The revoked serial numbers. */
  revoked?: number[];
  /** `thisUpdate` / `nextUpdate`, epoch ms (default: a day before / a week after TEST_NOW). */
  thisUpdate?: number;
  /** `null` leaves `nextUpdate` out. */
  nextUpdate?: number | null;
  /** A critical CRL extension OID this reader doesn't know (a delta CRL indicator, say). */
  unknownCritical?: string;
  /**
   * A critical issuingDistributionPoint (RFC 5280 §5.2.5): one scoping the CRL to some reasons
   * (`onlySomeReasons`), an indirect CRL, or one that only says it covers end-entity
   * certificates (`userCertsOnly`, which doesn't partition the revocations a reader needs).
   */
  issuingDistributionPoint?: "onlySomeReasons" | "indirect" | "userCertsOnly";
}

/** The DER of an issuingDistributionPoint extension value of `kind`. */
function issuingDistributionPointOf(kind: NonNullable<CrlOptions["issuingDistributionPoint"]>) {
  switch (kind) {
    case "onlySomeReasons":
      // [3] IMPLICIT ReasonFlags BIT STRING: keyCompromise only.
      return der(0x30, der(0x83, [0x06, 0x40]));
    case "indirect":
      // [4] IMPLICIT BOOLEAN TRUE.
      return der(0x30, der(0x84, [0xff]));
    case "userCertsOnly":
      // [1] IMPLICIT BOOLEAN TRUE (onlyContainsUserCerts).
      return der(0x30, der(0x81, [0xff]));
  }
}

/**
 * A DER CRL (RFC 5280 §5), really signed by its issuer's key.
 *
 * @param o What it says.
 * @returns The DER.
 */
export async function makeCrl(o: CrlOptions): Promise<Uint8Array> {
  const algId = der(0x30, derOid("1.2.840.10045.4.3.2"));
  const at = utcTime(TEST_NOW - 86_400_000);
  const entries = (o.revoked ?? []).map((s) => der(0x30, der(0x02, [s]), at));
  const tbs = der(
    0x30,
    der(0x02, [1]),
    algId,
    nameOf(o.issuer.cn),
    utcTime(o.thisUpdate ?? TEST_NOW - 86_400_000),
    ...(o.nextUpdate === null ? [] : [utcTime(o.nextUpdate ?? TEST_NOW + 7 * 86_400_000)]),
    ...(entries.length ? [der(0x30, ...entries)] : []),
    ...(o.unknownCritical || o.issuingDistributionPoint
      ? [der(
        0xa0,
        der(
          0x30,
          ...(o.unknownCritical ? [extension(o.unknownCritical, true, der(0x02, [1]))] : []),
          ...(o.issuingDistributionPoint
            ? [extension("2.5.29.28", true, issuingDistributionPointOf(o.issuingDistributionPoint))]
            : []),
        ),
      )]
      : []),
  );
  const signature = await signDer(o.issuer.key.privateKey, tbs);
  return der(0x30, tbs, algId, der(0x03, [0, ...signature]));
}

/** `YYYYMMDDHHMMSSZ` GeneralizedTime of an epoch-ms time. */
function generalizedTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString();
  return der(0x18, utf8(iso.slice(0, 19).replace(/[-:T]/g, "") + "Z"));
}

/** One answer of a test OCSP response. */
export interface OcspEntry {
  /** The serial number asked about. */
  serial: number;
  /** Its status. */
  status: "good" | "revoked" | "unknown";
  /** `thisUpdate` (default: an hour before TEST_NOW). */
  thisUpdate?: number;
  /** `nextUpdate` (default: a day after TEST_NOW); `null` leaves it out. */
  nextUpdate?: number | null;
  /** The `CertID` hash (default SHA-1). */
  hash?: "SHA-1" | "SHA-256";
  /** The issuer the `CertID` names (default: the response's `issuer`). */
  issuer?: { cn: string; key: TestKeyPair };
}

/** What a test OCSP response says. */
export interface OcspResponseOptions {
  /** The CA whose certificates are answered for. */
  issuer: { cn: string; key: TestKeyPair };
  /** The key that signs it (default: the issuer's). */
  signer?: TestKeyPair;
  /** Certificates to include (a delegated responder's). */
  certs?: Uint8Array[];
  /** The answers. */
  entries: OcspEntry[];
  /** A non-zero `responseStatus` (e.g. 3, tryLater) sends no response bytes. */
  responseStatus?: number;
}

const digest = async (hash: string, data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest(hash, data as BufferSource));

/** A `CertID` for `serial` issued by `issuer`. */
async function certId(
  issuer: { cn: string; key: TestKeyPair },
  serial: number,
  hash: "SHA-1" | "SHA-256",
): Promise<Uint8Array> {
  const oid = hash === "SHA-1" ? "1.3.14.3.2.26" : "2.16.840.1.101.3.4.2.1";
  // A P-256 SPKI ends with its 65-byte uncompressed point: the subjectPublicKey's bits.
  const key = issuer.key.spki.subarray(issuer.key.spki.length - 65);
  return der(
    0x30,
    der(0x30, derOid(oid), der(0x05)),
    der(0x04, await digest(hash, nameOf(issuer.cn))),
    der(0x04, await digest(hash, key)),
    der(0x02, [serial]),
  );
}

/**
 * A DER `OCSPResponse` (RFC 6960 §4.2) carrying a `BasicOCSPResponse`, really signed.
 *
 * @param o What it says.
 * @returns The DER.
 */
export async function makeOcspResponse(o: OcspResponseOptions): Promise<Uint8Array> {
  if (o.responseStatus) return der(0x30, der(0x0a, [o.responseStatus]));
  const singles: Uint8Array[] = [];
  for (const e of o.entries) {
    const status = e.status === "good"
      ? der(0x80)
      : e.status === "revoked"
      ? der(0xa1, generalizedTime(TEST_NOW - 86_400_000))
      : der(0x82);
    const next = e.nextUpdate === null ? [] : [
      der(0xa0, generalizedTime(e.nextUpdate ?? TEST_NOW + 86_400_000)),
    ];
    singles.push(der(
      0x30,
      await certId(e.issuer ?? o.issuer, e.serial, e.hash ?? "SHA-1"),
      status,
      generalizedTime(e.thisUpdate ?? TEST_NOW - 3_600_000),
      ...next,
    ));
  }
  const signer = o.signer ?? o.issuer.key;
  const tbs = der(
    0x30,
    der(0xa2, der(0x04, await digest("SHA-1", signer.spki.subarray(signer.spki.length - 65)))),
    generalizedTime(TEST_NOW - 3_600_000),
    der(0x30, ...singles),
  );
  const algId = der(0x30, derOid("1.2.840.10045.4.3.2"));
  const signature = await signDer(signer.privateKey, tbs);
  const basic = der(
    0x30,
    tbs,
    algId,
    der(0x03, [0, ...signature]),
    ...(o.certs?.length ? [der(0xa0, der(0x30, ...o.certs))] : []),
  );
  return der(
    0x30,
    der(0x0a, [0]),
    der(0xa0, der(0x30, derOid("1.3.6.1.5.5.7.48.1.1"), der(0x04, basic))),
  );
}

/** A Name of the given attributes (`[oid, value]`, one RDN each, UTF8String). */
export function nameWith(attributes: [string, string][]): Uint8Array {
  return der(
    0x30,
    ...attributes.map(([oid, v]) => der(0x31, der(0x30, derOid(oid), der(0x0c, utf8(v))))),
  );
}
