/**
 * The two configuration shapes the SAML Service Provider primitives take.
 *
 * @module
 */

/** A trusted SAML 2.0 Identity Provider. */
export interface SamlIdpConfig {
  /** The IdP's entity id — the Issuer every Response and Assertion must carry. */
  entityId: string;
  /** The IdP's HTTP-Redirect-binding SingleSignOnService URL (where AuthnRequests go). */
  ssoUrl: string;
  /**
   * The IdP's signing certificates (X.509, PEM or bare base64 DER). Each one's public key
   * (RSA, or EC P-256/P-384/P-521) is trusted to sign; list two during a key rollover. A
   * certificate carried inside a message (KeyInfo) is never trusted.
   */
  certificates: string[];
}

/** This SAML 2.0 Service Provider. */
export interface SamlSpConfig {
  /** The SP's entity id — the Audience assertions must be restricted to. */
  entityId: string;
  /**
   * The SP's HTTP-POST AssertionConsumerService URL — the Destination of every Response and
   * the Recipient of every bearer confirmation, compared exactly.
   */
  acsUrl: string;
}
