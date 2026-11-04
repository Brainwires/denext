/**
 * Online Certificate Status Protocol (RFC 6960, with RFC 5019's lightweight profile) for the
 * revocation checks of the FIDO Metadata Service paths ({@link ./fido-mds.ts}): the metadata
 * BLOB's signing chain and an attestation's `x5c` chain. A certificate whose Authority
 * Information Access extension names an OCSP responder (`id-ad-ocsp`) is asked about by its
 * `CertID` — SHA-1 hashes of its issuer's name and key plus its serial number, the form every
 * responder answers — in a DER `OCSPRequest` POSTed as `application/ocsp-request`.
 *
 * **A response is used** only when it is `successful`, a `BasicOCSPResponse`, signed either by
 * the issuer's own key or by a delegated responder certificate the issuer signed directly, that
 * carries `id-kp-OCSPSigning` and is valid now (§4.2.2.2); when one of its `SingleResponse`s
 * names this certificate's `CertID` exactly; and when that answer is current (`thisUpdate` no
 * more than five minutes ahead of now, `nextUpdate` present and not passed). Anything else —
 * no answer, a malformed or unsigned one, a stale one, `unknown` — establishes nothing, and the
 * failure policy one layer up ({@link ./revocation.ts}) decides what that means.
 *
 * **Fetching** is bounded like the CRL path ({@link ./crl.ts}): `http:` / `https:` responders
 * only (a response is signed, so plain HTTP can't forge one), at most four per certificate, a
 * timeout, a size cap, one request per certificate at a time. No nonce is sent: RFC 5019
 * responders serve pre-signed answers and ignore one, so freshness rests on the answer's own
 * `thisUpdate` / `nextUpdate`.
 *
 * **Caching**: a usable `good` or `revoked` answer is kept per `CertID` until its `nextUpdate`
 * (at most 256 answers, the oldest dropped first); a certificate whose responders gave no
 * usable answer is not asked again for {@linkcode OCSP_FAILURE_BACKOFF_MS}.
 *
 * @module
 */

import { check, type Der, derAt, derChildren, hex } from "./webauthn-der.ts";
import { cappedBytes, type RevocationStatus } from "./crl.ts";
import { derTime, parseX509Certificate } from "./x509-chain.ts";

/** The bounds of the OCSP client. */
export interface OcspOptions {
  /** The fetch timeout per responder, ms. */
  timeoutMs: number;
  /** The largest response body accepted, bytes. */
  maxBytes: number;
  /** Fetch (injectable for tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** What an OCSP request needs to know about the certificate it asks about. */
export interface OcspTarget {
  /** The serialNumber's content bytes. */
  serial: Uint8Array;
  /** The certificate's issuer Name, DER (= the issuer's subject). */
  issuer: Uint8Array;
  /** Its OCSP responder URLs (http/https). */
  ocspUrls: string[];
}

/** The responders followed per certificate. */
const MAX_URLS = 4;
/** The answers kept in memory. */
const MAX_CACHED = 256;
/** How far ahead of now a `thisUpdate` may be (clock skew), ms. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** How long a certificate with no usable answer is not asked about again, ms. */
export const OCSP_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

const OID_AUTHORITY_INFO_ACCESS = "2b06010505070101";
const OID_AD_OCSP = "2b06010505073001";
const OID_OCSP_BASIC = "2b0601050507300101";
const OID_KP_OCSP_SIGNING = "2b06010505070309";
const OID_EXT_KEY_USAGE = "551d25";
/** `CertID.hashAlgorithm`s by OID hex → Web Crypto. */
const CERT_ID_HASHES: Record<string, string> = {
  "2b0e03021a": "SHA-1",
  "608648016503040201": "SHA-256",
};
/** `id-sha1` (1.3.14.3.2.26), the `CertID` hash requests use. */
const SHA1_OID = Uint8Array.of(0x2b, 0x0e, 0x03, 0x02, 0x1a);

// ---- DER out -------------------------------------------------------------------------------

/** One DER TLV of `tag` around `parts`. */
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const head = length < 0x80
    ? [tag, length]
    : length < 0x100
    ? [tag, 0x81, length]
    : [tag, 0x82, length >> 8, length & 0xff];
  const out = new Uint8Array(head.length + length);
  out.set(head);
  parts.reduce((at, p) => (out.set(p, at), at + p.length), head.length);
  return out;
}

// ---- CertID ---------------------------------------------------------------------------------

/** A `CertID`'s comparable parts. */
interface CertId {
  hash: string;
  nameHash: Uint8Array;
  keyHash: Uint8Array;
  serial: Uint8Array;
}

/** The `subjectPublicKey` BIT STRING's bytes (after its unused-bits octet) of an SPKI. */
function publicKeyBits(spki: Uint8Array): Uint8Array {
  const [, bits] = derChildren(derAt(spki, 0).value);
  check(bits?.tag === 0x03 && bits.value.length > 1, "attestation", "bad issuer public key");
  return bits.value.subarray(1);
}

async function digest(hash: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, data as BufferSource));
}

/** The `CertID` of `target` under `hash` (RFC 6960 §4.1.1). */
async function certIdOf(target: OcspTarget, issuerSpki: Uint8Array, hash: string) {
  return {
    hash,
    nameHash: await digest(hash, target.issuer),
    keyHash: await digest(hash, publicKeyBits(issuerSpki)),
    serial: target.serial,
  } satisfies CertId;
}

/**
 * The DER `OCSPRequest` for one certificate: an unsigned v1 request with a single SHA-1
 * `CertID` and no extensions (RFC 5019 §2.1.1).
 *
 * @param target The certificate.
 * @param issuerSpki Its issuer's SubjectPublicKeyInfo.
 * @returns The request.
 */
export async function buildOcspRequest(
  target: OcspTarget,
  issuerSpki: Uint8Array,
): Promise<Uint8Array> {
  const id = await certIdOf(target, issuerSpki, "SHA-1");
  const certId = tlv(
    0x30,
    tlv(0x30, tlv(0x06, SHA1_OID), tlv(0x05)),
    tlv(0x04, id.nameHash),
    tlv(0x04, id.keyHash),
    tlv(0x02, id.serial),
  );
  // OCSPRequest { TBSRequest { requestList SEQUENCE OF Request { reqCert CertID } } }
  return tlv(0x30, tlv(0x30, tlv(0x30, tlv(0x30, certId))));
}

// ---- the response --------------------------------------------------------------------------

/** One `SingleResponse`. */
export interface OcspSingleResponse {
  /** The `CertID` it answers. */
  certId: CertId;
  /** `good`, `revoked` or `unknown`. */
  status: RevocationStatus;
  /** `thisUpdate`, epoch ms. */
  thisUpdate: number;
  /** `nextUpdate`, epoch ms (`undefined` when absent). */
  nextUpdate?: number;
}

/** A parsed, signature-unchecked `BasicOCSPResponse`. */
export interface ParsedOcspResponse {
  /** The `tbsResponseData`, DER — what the responder signed. */
  tbs: Uint8Array;
  /** The signature algorithm OID, hex. */
  signatureAlgorithm: string;
  /** The signature bytes. */
  signature: Uint8Array;
  /** The answers. */
  responses: OcspSingleResponse[];
  /** The certificates the responder sent (DER) — a delegated responder's among them. */
  certs: Uint8Array[];
}

/** A `CertID` SEQUENCE's parts (the hash named by OID; an unknown hash is `""`). */
function parseCertId(node: Der): CertId {
  const [alg, nameHash, keyHash, serial] = derChildren(node.value);
  const [oid] = derChildren(alg.value);
  check(
    nameHash?.tag === 0x04 && keyHash?.tag === 0x04 && serial?.tag === 0x02,
    "attestation",
    "bad OCSP CertID",
  );
  return {
    hash: CERT_ID_HASHES[hex(oid.value)] ?? "",
    nameHash: nameHash.value,
    keyHash: keyHash.value,
    serial: serial.value,
  };
}

const STATUS_BY_TAG: Record<number, RevocationStatus> = {
  0x80: "good", // [0] IMPLICIT NULL
  0xa1: "revoked", // [1] IMPLICIT RevokedInfo
  0x82: "unknown", // [2] IMPLICIT UnknownInfo
};

/** One `SingleResponse`. */
function parseSingleResponse(node: Der): OcspSingleResponse {
  const [certId, status, thisUpdate, ...rest] = derChildren(node.value);
  check(certId?.tag === 0x30 && thisUpdate?.tag === 0x18, "attestation", "bad SingleResponse");
  const next = rest.find((n) => n.tag === 0xa0); // [0] EXPLICIT GeneralizedTime
  return {
    certId: parseCertId(certId),
    status: STATUS_BY_TAG[status.tag] ?? "unknown",
    thisUpdate: derTime(thisUpdate),
    ...(next ? { nextUpdate: derTime(derAt(next.value, 0)) } : {}),
  };
}

/**
 * Parse a DER `OCSPResponse` carrying a `BasicOCSPResponse`.
 *
 * @param der The response.
 * @returns Its answers and signature, or `null` when it is not a successful basic response.
 * @throws {WebAuthnError} `attestation` when it is malformed.
 */
export function parseOcspResponse(der: Uint8Array): ParsedOcspResponse | null {
  const basic = basicResponseBytes(der);
  return basic ? parseBasicResponse(basic) : null;
}

/** The `BasicOCSPResponse` DER of a successful `OCSPResponse`, else `null`. */
function basicResponseBytes(der: Uint8Array): Uint8Array | null {
  const outer = derAt(der, 0);
  check(outer.tag === 0x30 && outer.raw.length === der.length, "attestation", "not OCSP");
  const [status, bytes] = derChildren(outer.value);
  check(tagged([status], [0x0a]), "attestation", "bad OCSP responseStatus");
  if (hex(status.value) !== "00" || !tagged([bytes], [0xa0])) return null; // successful(0)
  // ResponseBytes { responseType OID, response OCTET STRING }
  const [type, octets] = derChildren(derAt(bytes.value, 0).value);
  const basic = tagged([type, octets], [0x06, 0x04]) && hex(type.value) === OID_OCSP_BASIC;
  return basic ? octets.value : null;
}

/** Whether each node is present with its tag. */
function tagged(nodes: (Der | undefined)[], tags: number[]): nodes is Der[] {
  return tags.every((tag, i) => nodes[i]?.tag === tag);
}

/** A `BasicOCSPResponse`'s signed data, signature, answers and certificates. */
function parseBasicResponse(der: Uint8Array): ParsedOcspResponse {
  const [tbs, alg, sig, certsWrapper] = derChildren(derAt(der, 0).value);
  check(tagged([tbs, alg, sig], [0x30, 0x30, 0x03]), "attestation", "bad OCSP");
  const parts = derChildren(tbs.value);
  // [version], responderID, producedAt, responses
  const responses = parts[tagged(parts, [0xa0]) ? 3 : 2];
  check(tagged([responses], [0x30]), "attestation", "bad OCSP ResponseData");
  const [oid] = derChildren(alg.value);
  return {
    tbs: tbs.raw,
    signatureAlgorithm: hex(oid.value),
    signature: sig.value.subarray(1),
    responses: derChildren(responses.value).map(parseSingleResponse),
    certs: responderCertificates(certsWrapper),
  };
}

/** The `certs [0] EXPLICIT SEQUENCE OF Certificate` of a basic response (DER each). */
function responderCertificates(wrapper: Der | undefined): Uint8Array[] {
  if (wrapper?.tag !== 0xa0) return [];
  const [seq] = derChildren(wrapper.value);
  return seq ? derChildren(seq.value).map((c) => c.raw) : [];
}

/**
 * The http/https OCSP responder URIs of a certificate's Authority Information Access extension
 * (`SEQUENCE OF AccessDescription { accessMethod, accessLocation [6] URI }`).
 *
 * @param extensions The certificate's extensions by OID hex.
 * @returns The URLs, at most four.
 */
export function ocspUrlsOf(extensions: Map<string, { value: Uint8Array }>): string[] {
  const ext = extensions.get(OID_AUTHORITY_INFO_ACCESS);
  if (!ext) return [];
  const out: string[] = [];
  for (const access of derChildren(derAt(ext.value, 0).value)) {
    const [method, location] = derChildren(access.value);
    if (method?.tag !== 0x06 || hex(method.value) !== OID_AD_OCSP || location?.tag !== 0x86) {
      continue;
    }
    const uri = new TextDecoder().decode(location.value);
    if (/^https?:\/\//i.test(uri)) out.push(uri);
  }
  return out.slice(0, MAX_URLS);
}

// ---- the client ----------------------------------------------------------------------------

/** Verifies a signature with an SPKI (`x509-chain`'s verifier). */
type SignatureVerifier = (
  spki: Uint8Array,
  algorithm: string,
  signature: Uint8Array,
  data: Uint8Array,
) => Promise<boolean>;

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether a certificate lists `id-kp-OCSPSigning` in its extended key usage. */
function mayOcspSign(extensions: Map<string, { value: Uint8Array }>): boolean {
  const ext = extensions.get(OID_EXT_KEY_USAGE);
  if (!ext) return false;
  return derChildren(derAt(ext.value, 0).value).some((n) =>
    n.tag === 0x06 && hex(n.value) === OID_KP_OCSP_SIGNING
  );
}

/** Whether a `CertID` names `target` exactly (its hash algorithm's name and key hashes). */
async function namesTarget(id: CertId, target: OcspTarget, issuerSpki: Uint8Array) {
  if (!id.hash || !same(id.serial, target.serial)) return false;
  const want = await certIdOf(target, issuerSpki, id.hash);
  return same(id.nameHash, want.nameHash) && same(id.keyHash, want.keyHash);
}

/** `thisUpdate` no more than the clock skew ahead; `nextUpdate` present and not passed. */
function isCurrent(single: OcspSingleResponse, now: number): boolean {
  return single.thisUpdate <= now + CLOCK_SKEW_MS && single.nextUpdate !== undefined &&
    now <= single.nextUpdate;
}

/** What the cache holds for one `CertID`. */
type Cached = Definite | { failed: number };
/** A usable `good` / `revoked` answer, kept until its `nextUpdate`. */
type Definite = { status: "good" | "revoked"; expires: number };

/** The OCSP answers for one configuration. */
export class OcspCache {
  private readonly entries = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<Definite | null>>();

  /**
   * @param options The bounds.
   * @param verify Checks a signature with an SPKI.
   */
  constructor(readonly options: OcspOptions, private readonly verify: SignatureVerifier) {}

  /**
   * A delegated responder certificate the issuer signed directly, valid now and for OCSP
   * signing — or `undefined`, in which case the issuer's own key must have signed.
   */
  private async delegatedSigner(
    certs: Uint8Array[],
    issuerName: Uint8Array,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<Uint8Array | undefined> {
    for (const der of certs) {
      try {
        const cert = parseX509Certificate(der);
        if (!same(cert.issuer, issuerName) || !mayOcspSign(cert.extensions)) continue;
        if (now < cert.notBefore || now > cert.notAfter) continue;
        if (await this.verify(issuerSpki, cert.signatureAlgorithm, cert.signature, cert.tbs)) {
          return cert.spki;
        }
      } catch { /* not a usable responder certificate */ }
    }
    return undefined;
  }

  /** Whether `response`'s signature is the issuer's or its delegated responder's. */
  private async signedFor(
    response: ParsedOcspResponse,
    target: OcspTarget,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<boolean> {
    const { signatureAlgorithm: alg, signature, tbs } = response;
    if (await this.verify(issuerSpki, alg, signature, tbs)) return true;
    const delegated = await this.delegatedSigner(response.certs, target.issuer, issuerSpki, now);
    return !!delegated && await this.verify(delegated, alg, signature, tbs);
  }

  /** The current answer for `target` in `response`, if it is usable. */
  private async answerIn(
    response: ParsedOcspResponse,
    target: OcspTarget,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<OcspSingleResponse | null> {
    for (const single of response.responses) {
      if (!(await namesTarget(single.certId, target, issuerSpki))) continue;
      if (!isCurrent(single, now)) return null;
      return await this.signedFor(response, target, issuerSpki, now) ? single : null;
    }
    return null;
  }

  /** Ask one responder; `null` when it gives no usable answer. */
  private async ask(
    url: string,
    request: Uint8Array,
    target: OcspTarget,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<OcspSingleResponse | null> {
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          "content-type": "application/ocsp-request",
          accept: "application/ocsp-response",
        },
        body: request as BodyInit,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const body = await cappedBytes(response, this.options.maxBytes);
      const parsed = body ? parseOcspResponse(body) : null;
      return parsed ? await this.answerIn(parsed, target, issuerSpki, now) : null;
    } catch {
      return null;
    }
  }

  /** Each responder in turn until one gives a usable, definite answer. */
  private async query(
    target: OcspTarget,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<Definite | null> {
    const request = await buildOcspRequest(target, issuerSpki);
    for (const url of target.ocspUrls.slice(0, MAX_URLS)) {
      const answer = await this.ask(url, request, target, issuerSpki, now);
      if (answer && answer.status !== "unknown") {
        return { status: answer.status, expires: answer.nextUpdate! };
      }
    }
    return null;
  }

  private remember(key: string, entry: Cached): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_CACHED) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /**
   * The revocation status of one certificate: a cached answer until its `nextUpdate`, else its
   * responders asked in turn.
   *
   * @param target The certificate.
   * @param issuerSpki Its issuer's SubjectPublicKeyInfo.
   * @param now The validation time, epoch ms.
   * @returns `good` or `revoked` from a usable answer; `unknown` when none could be had.
   */
  async status(target: OcspTarget, issuerSpki: Uint8Array, now: number): Promise<RevocationStatus> {
    if (target.ocspUrls.length === 0) return "unknown";
    const key = `${hex(target.issuer)}:${hex(publicKeyBits(issuerSpki))}:${hex(target.serial)}`;
    const cached = this.cached(key, now);
    if (cached) return cached;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.query(target, issuerSpki, now).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    const answer = await pending;
    this.remember(key, answer ?? { failed: now });
    return answer?.status ?? "unknown";
  }

  /** A cached answer still current, `unknown` while a failure backs off, else `undefined`. */
  private cached(key: string, now: number): RevocationStatus | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if ("status" in hit) return now <= hit.expires ? hit.status : undefined;
    return now - hit.failed < OCSP_FAILURE_BACKOFF_MS ? "unknown" : undefined;
  }
}
