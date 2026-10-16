/**
 * Certificate revocation lists (RFC 5280 §5) for the FIDO Metadata Service checks: the metadata
 * BLOB's signing chain and an attestation's `x5c` chain ({@link ./fido-mds.ts}). Each
 * certificate in a validated path that names CRL distribution points (§4.2.1.13) is checked
 * against its issuer's CRL.
 *
 * **Fetching** is bounded: only `http:` / `https:` distribution points (a CRL is signed, so a
 * plain-HTTP one can't be forged), at most four per certificate, one fetch per
 * URL at a time, a timeout, and a size cap on the body.
 *
 * **A CRL is used** only when its signature verifies with the issuer's key, its issuer is the
 * certificate's issuer (exact DER), it is current (`thisUpdate` ≤ now ≤ `nextUpdate`; a CRL with
 * no `nextUpdate` is refused), and it carries no critical extension this reader doesn't
 * understand (a delta CRL, an indirect CRL, or one partitioned by reason is refused). A
 * certificate whose serial number it lists is revoked.
 *
 * **Caching**: a usable CRL is kept per URL until its `nextUpdate` (at most
 * 64 lists, the oldest dropped first); a failed fetch is remembered for
 * {@linkcode FAILURE_BACKOFF_MS}, so an unreachable distribution point is not hammered.
 *
 * **Failure policy** (`passkeys.attestation.mds.revocation`):
 * - `"require"` — a certificate that names distribution points needs one usable CRL from them,
 *   else the path is refused (fail closed). The default, unless the BLOB is supplied offline.
 * - `"best-effort"` — a CRL that can't be fetched or used is skipped (and logged once per URL);
 *   a usable one that lists the certificate still refuses it. The default with `mds.blob`.
 * - `"off"` — no CRL is fetched.
 *
 * @module
 */

import { check, type Der, derAt, derChildren, hex } from "./webauthn-der.ts";
import { derTime } from "./x509-chain.ts";

/** How a missing CRL is treated (see the module doc). */
export type RevocationMode = "require" | "best-effort" | "off";

/** What a revocation check needs to fetch. */
export interface RevocationOptions {
  /** The failure policy. */
  mode: RevocationMode;
  /** The fetch timeout per CRL, ms. */
  timeoutMs: number;
  /** The largest CRL body accepted, bytes. */
  maxBytes: number;
  /** Fetch (injectable for tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Told when `best-effort` skips an unusable CRL. */
  warn?: (message: string) => void;
}

/** The distribution points followed per certificate. */
const MAX_URLS = 4;
/** The CRLs kept in memory. */
const MAX_CACHED = 64;
/** How long a failed fetch is remembered, ms. */
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

const OID_CRL_DISTRIBUTION_POINTS = "551d1f";
const OID_CRL_NUMBER = "551d14";
const OID_AUTHORITY_KEY_ID = "551d23";
const OID_ISSUING_DISTRIBUTION_POINT = "551d1c";
/** CRL extensions a CRL may mark critical and still be used. */
const UNDERSTOOD_CRITICAL = new Set([
  OID_CRL_NUMBER,
  OID_AUTHORITY_KEY_ID,
  OID_ISSUING_DISTRIBUTION_POINT,
]);

/** A certificate as the revocation check reads it. */
export interface RevocableCertificate {
  /** The serialNumber's content bytes. */
  serial: Uint8Array;
  /** The issuer Name, DER. */
  issuer: Uint8Array;
  /** Its CRL distribution point URLs (http/https). */
  crlUrls: string[];
}

/** A parsed, signature-unchecked CRL. */
export interface ParsedCrl {
  /** The `tbsCertList`, DER — what the issuer signed. */
  tbs: Uint8Array;
  /** The signature algorithm OID, hex. */
  signatureAlgorithm: string;
  /** The signature bytes. */
  signature: Uint8Array;
  /** The issuer Name, DER. */
  issuer: Uint8Array;
  /** `thisUpdate`, epoch ms. */
  thisUpdate: number;
  /** `nextUpdate`, epoch ms (`undefined` when absent). */
  nextUpdate?: number;
  /** The revoked serial numbers (hex of their content bytes). */
  revoked: Set<string>;
  /** Whether a critical extension this reader doesn't understand is present. */
  unusable: boolean;
}

/** A path that is revoked, or whose revocation status `require` could not establish. */
export class RevocationError extends Error {
  override name = "RevocationError";
}

const isTime = (n: Der | undefined) => n?.tag === 0x17 || n?.tag === 0x18;

/** The serial numbers a `revokedCertificates` SEQUENCE lists. */
function revokedSerials(list: Der | undefined): Set<string> {
  const out = new Set<string>();
  for (const entry of list ? derChildren(list.value) : []) {
    const [serial] = derChildren(entry.value);
    if (serial?.tag === 0x02) out.add(hex(serial.value));
  }
  return out;
}

/** Whether a `[0] EXPLICIT Extensions` holds a critical extension the reader doesn't know. */
function hasUnknownCritical(wrapper: Der | undefined): boolean {
  const [seq] = wrapper ? derChildren(wrapper.value) : [];
  for (const ext of seq ? derChildren(seq.value) : []) {
    const [oid, flag] = derChildren(ext.value);
    const critical = flag?.tag === 0x01 && flag.value[0] !== 0;
    if (critical && !UNDERSTOOD_CRITICAL.has(hex(oid.value))) return true;
    if (hex(oid.value) === OID_ISSUING_DISTRIBUTION_POINT && partitioned(ext)) return true;
  }
  return false;
}

/** An issuingDistributionPoint scoping the CRL to some reasons, or naming it indirect. */
function partitioned(ext: Der): boolean {
  const items = derChildren(ext.value);
  const value = derAt(items[items.length - 1].value, 0);
  // [3] onlySomeReasons, [4] indirectCRL
  return derChildren(value.value).some((n) =>
    n.tag === 0x83 || (n.tag === 0x84 && n.value[0] !== 0)
  );
}

/**
 * Parse a DER `CertificateList`.
 *
 * @param der The CRL.
 * @returns Its fields.
 * @throws {WebAuthnError} `attestation` when it is malformed.
 */
export function parseCrl(der: Uint8Array): ParsedCrl {
  const list = derAt(der, 0);
  check(list.tag === 0x30 && list.raw.length === der.length, "attestation", "not a CRL");
  const [tbs, alg, sig] = derChildren(list.value);
  check(tbs?.tag === 0x30 && alg?.tag === 0x30 && sig?.tag === 0x03, "attestation", "bad CRL");
  const parts = derChildren(tbs.value);
  let at = parts[0]?.tag === 0x02 ? 1 : 0; // version
  at++; // signature AlgorithmIdentifier
  const issuer = parts[at++];
  const thisUpdate = parts[at++];
  check(issuer?.tag === 0x30 && isTime(thisUpdate), "attestation", "bad CRL body");
  const nextUpdate = isTime(parts[at]) ? parts[at++] : undefined;
  const revoked = parts[at]?.tag === 0x30 ? parts[at++] : undefined;
  const [oid] = derChildren(alg.value);
  return {
    tbs: tbs.raw,
    signatureAlgorithm: hex(oid.value),
    signature: sig.value.subarray(1),
    issuer: issuer.raw,
    thisUpdate: derTime(thisUpdate),
    ...(nextUpdate ? { nextUpdate: derTime(nextUpdate) } : {}),
    revoked: revokedSerials(revoked),
    unusable: hasUnknownCritical(parts.find((p) => p.tag === 0xa0)),
  };
}

/**
 * The http/https URIs of a CRL distribution points extension value
 * (`SEQUENCE OF DistributionPoint`, each `[0] distributionPoint [0] fullName GeneralNames`).
 *
 * @param value The extension's OCTET STRING content.
 * @returns The URLs, at most four.
 */
export function crlUrlsOf(value: Uint8Array): string[] {
  const out: string[] = [];
  for (const point of derChildren(derAt(value, 0).value)) {
    const name = derChildren(point.value).find((n) => n.tag === 0xa0);
    const full = name ? derChildren(name.value).find((n) => n.tag === 0xa0) : undefined;
    for (const general of full ? derChildren(full.value) : []) {
      if (general.tag !== 0x86) continue; // [6] uniformResourceIdentifier
      const uri = new TextDecoder().decode(general.value);
      if (/^https?:\/\//i.test(uri)) out.push(uri);
    }
  }
  return out.slice(0, MAX_URLS);
}

/** The distribution point URLs a certificate's extensions name. */
export function distributionPoints(
  extensions: Map<string, { value: Uint8Array }>,
): string[] {
  const ext = extensions.get(OID_CRL_DISTRIBUTION_POINTS);
  return ext ? crlUrlsOf(ext.value) : [];
}

/**
 * Read a response body up to `max` bytes, cancelling it past the cap.
 *
 * @param response The response.
 * @param max The cap, bytes.
 * @returns The bytes, or `null` when the body (declared or read) is larger.
 */
export async function cappedBytes(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let step = await reader?.read(); step && !step.done; step = await reader!.read()) {
    total += step.value.byteLength;
    if (total > max) {
      await reader!.cancel();
      return null;
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  chunks.reduce((at, chunk) => (out.set(chunk, at), at + chunk.byteLength), 0);
  return out;
}

/** What the cache holds for one URL. */
type Cached = { crl: ParsedCrl; expires: number } | { failed: number };

/**
 * The CRL cache and fetcher for one MDS configuration.
 */
export class CrlCache {
  private readonly entries = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<ParsedCrl | null>>();
  private readonly warned = new Set<string>();

  /**
   * @param options The policy and bounds.
   * @param verify Checks a CRL's signature with its issuer's SPKI (`x509-chain`'s verifier).
   */
  constructor(
    readonly options: RevocationOptions,
    private readonly verify: (
      spki: Uint8Array,
      algorithm: string,
      signature: Uint8Array,
      data: Uint8Array,
    ) => Promise<boolean>,
  ) {}

  /** A parsed CRL for `url`: cached until its `nextUpdate`, else one bounded fetch. */
  private async load(url: string, now: number): Promise<ParsedCrl | null> {
    const hit = this.entries.get(url);
    if (hit && "crl" in hit && now <= hit.expires) return hit.crl;
    if (hit && "failed" in hit && now - hit.failed < FAILURE_BACKOFF_MS) return null;
    let pending = this.inFlight.get(url);
    if (!pending) {
      pending = this.fetchCrl(url).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, pending);
    }
    const crl = await pending;
    this.remember(url, crl ? { crl, expires: crl.nextUpdate ?? 0 } : { failed: now });
    return crl;
  }

  private remember(url: string, entry: Cached): void {
    this.entries.delete(url);
    this.entries.set(url, entry);
    while (this.entries.size > MAX_CACHED) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  private async fetchCrl(url: string): Promise<ParsedCrl | null> {
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: { accept: "application/pkix-crl, application/x-pkcs7-crl" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const body = await cappedBytes(response, this.options.maxBytes);
      return body ? parseCrl(body) : null;
    } catch {
      return null;
    }
  }

  /** Whether `crl` may judge `cert`, issued by the holder of `issuerSpki`, at `now`. */
  private async usable(
    crl: ParsedCrl,
    cert: RevocableCertificate,
    issuerSpki: Uint8Array,
    now: number,
  ): Promise<boolean> {
    if (crl.unusable || crl.nextUpdate === undefined) return false;
    if (now < crl.thisUpdate || now > crl.nextUpdate) return false;
    if (
      crl.issuer.length !== cert.issuer.length || !crl.issuer.every((b, i) => b === cert.issuer[i])
    ) {
      return false;
    }
    return await this.verify(issuerSpki, crl.signatureAlgorithm, crl.signature, crl.tbs);
  }

  /**
   * Check one certificate of a validated path against its issuer's CRL.
   *
   * @param cert The certificate.
   * @param issuerSpki Its issuer's SubjectPublicKeyInfo.
   * @param now The validation time, epoch ms.
   * @throws {RevocationError} When it is revoked, or `require` finds no usable CRL.
   */
  async check(cert: RevocableCertificate, issuerSpki: Uint8Array, now: number): Promise<void> {
    if (this.options.mode === "off" || cert.crlUrls.length === 0) return;
    for (const url of cert.crlUrls) {
      const crl = await this.load(url, now);
      if (!crl || !(await this.usable(crl, cert, issuerSpki, now))) continue;
      if (crl.revoked.has(hex(cert.serial))) {
        throw new RevocationError("a certificate in the path is revoked");
      }
      return;
    }
    if (this.options.mode === "require") {
      throw new RevocationError("no usable CRL for a certificate in the path");
    }
    const key = cert.crlUrls.join(" ");
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.options.warn?.(`denextAuth: no usable CRL at ${key}; revocation not checked`);
    }
  }
}
