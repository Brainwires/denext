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
  /**
   * The IdP's HTTP-Redirect-binding SingleLogoutService `Location` — where this SP sends its
   * LogoutRequests (and its LogoutResponses, unless {@linkcode sloResponseUrl} is set). Without
   * it there is no Single Logout with this IdP.
   */
  sloUrl?: string;
  /** The SingleLogoutService `ResponseLocation`, when it differs from {@linkcode sloUrl}. */
  sloResponseUrl?: string;
}

/**
 * An SP private key: a PKCS #8 PEM (`-----BEGIN PRIVATE KEY-----`) or an RSA private JWK.
 * Only RSA keys are supported (RSA-SHA256 signatures, RSA-OAEP key transport).
 */
export type SamlPrivateKey = string | JsonWebKey;

/** This SAML 2.0 Service Provider. */
export interface SamlSpConfig {
  /** The SP's entity id — the Audience assertions must be restricted to. */
  entityId: string;
  /**
   * The SP's HTTP-POST AssertionConsumerService URL — the Destination of every Response and
   * the Recipient of every bearer confirmation, compared exactly.
   */
  acsUrl: string;
  /**
   * The SP's SingleLogoutService URL (HTTP-Redirect and HTTP-POST) — the Destination every
   * LogoutRequest / LogoutResponse sent to this SP must carry.
   */
  sloUrl?: string;
  /**
   * The SP's signing key (RSA, used with RSA-SHA256): signs AuthnRequests, LogoutRequests and
   * LogoutResponses over the HTTP-Redirect binding. Pair it with {@linkcode signingCertificate}.
   */
  signingKey?: SamlPrivateKey;
  /** The X.509 certificate of {@linkcode signingKey}, published in the SP metadata. */
  signingCertificate?: string;
  /**
   * The SP's decryption key (RSA): unwraps the content key of an EncryptedAssertion
   * (RSA-OAEP). Pair it with {@linkcode encryptionCertificate}.
   */
  encryptionKey?: SamlPrivateKey;
  /** The X.509 certificate of {@linkcode encryptionKey}, published with `use="encryption"`. */
  encryptionCertificate?: string;
}
