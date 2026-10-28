/**
 * Revocation checking for the certificate paths denext validates (the FIDO Metadata Service
 * BLOB's signing chain and an attestation's `x5c` chain, {@link ./fido-mds.ts}): OCSP first
 * ({@link ./ocsp.ts}), then the CRL ({@link ./crl.ts}), under one failure policy.
 *
 * For each certificate of a validated path below its trust anchor:
 * 1. When its Authority Information Access names OCSP responders, a usable `revoked` answer
 *    refuses the path and a usable `good` one settles it.
 * 2. Otherwise, when it names CRL distribution points, a usable CRL settles it the same way.
 * 3. When neither gives a usable answer, the policy decides: `"require"` (`revocation: "hard"`, the
 *    default) refuses the path; `"best-effort"` (`"soft"`) goes on, logging once per
 *    certificate's sources; `"off"` asks nothing at all.
 *
 * A certificate that names no OCSP responder and no distribution point has nothing to check.
 *
 * @module
 */

import {
  CrlCache,
  distributionPoints,
  RevocationError,
  type RevocationOptions,
  type RevocationStatus,
} from "./crl.ts";
import { OcspCache, ocspUrlsOf } from "./ocsp.ts";
import type { ParsedCertificate } from "./x509-chain.ts";

/** Verifies a signature with an SPKI (`x509-chain`'s verifier). */
type SignatureVerifier = (
  spki: Uint8Array,
  algorithm: string,
  signature: Uint8Array,
  data: Uint8Array,
) => Promise<boolean>;

/** The largest OCSP response accepted. */
const OCSP_MAX_BYTES = 64 * 1024;

/** OCSP + CRL checks with one policy, one cache of each, for one configuration. */
export class RevocationChecker {
  private readonly ocsp: OcspCache;
  private readonly crl: CrlCache;
  private readonly warned = new Set<string>();

  /**
   * @param options The policy and bounds (`maxBytes` is the CRL cap; OCSP answers are capped at
   *   64 KiB).
   * @param verify Checks a signature with an SPKI.
   */
  constructor(readonly options: RevocationOptions, verify: SignatureVerifier) {
    this.ocsp = new OcspCache({
      timeoutMs: options.timeoutMs,
      maxBytes: OCSP_MAX_BYTES,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }, verify);
    const { warn: _warn, ...bounds } = options;
    this.crl = new CrlCache({ ...bounds, mode: "best-effort" }, verify);
  }

  /**
   * Check one certificate of a validated path against its issuer.
   *
   * @param cert The certificate.
   * @param issuer Its issuer.
   * @param now The validation time, epoch ms.
   * @throws {RevocationError} When it is revoked, or `require` establishes no status.
   */
  async check(cert: ParsedCertificate, issuer: ParsedCertificate, now: number): Promise<void> {
    if (this.options.mode === "off") return;
    const ocspUrls = ocspUrlsOf(cert.extensions);
    const crlUrls = distributionPoints(cert.extensions);
    if (ocspUrls.length === 0 && crlUrls.length === 0) return;
    const status = await this.status(cert, issuer, ocspUrls, crlUrls, now);
    if (status === "revoked") throw new RevocationError("a certificate in the path is revoked");
    if (status === "unknown") this.unknown([...ocspUrls, ...crlUrls].join(" "));
  }

  /** OCSP's answer, else the CRL's. */
  private async status(
    cert: ParsedCertificate,
    issuer: ParsedCertificate,
    ocspUrls: string[],
    crlUrls: string[],
    now: number,
  ): Promise<RevocationStatus> {
    const target = { serial: cert.serial, issuer: cert.issuer };
    const status = await this.ocsp.status({ ...target, ocspUrls }, issuer.spki, now);
    if (status !== "unknown" || crlUrls.length === 0) return status;
    return await this.crl.status({ ...target, crlUrls }, issuer.spki, now);
  }

  /** No status: `require` refuses; `best-effort` warns once per set of sources. */
  private unknown(sources: string): void {
    if (this.options.mode === "require") {
      throw new RevocationError("no revocation status for a certificate in the path");
    }
    if (this.warned.has(sources)) return;
    this.warned.add(sources);
    this.options.warn?.(
      `denextAuth: no OCSP answer or CRL from ${sources}; revocation not checked`,
    );
  }
}
