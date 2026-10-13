/**
 * The one error type the SAML Service Provider primitives throw.
 *
 * @module
 */

/**
 * The stable machine codes a {@link SamlError} carries. Switch on `code`, never on the
 * message (which is for logs and may change between versions).
 */
export type SamlErrorCode =
  /** The bytes are not well-formed XML, are too large or too deep, or not valid base64/UTF-8. */
  | "malformed_xml"
  /** The document carries a DOCTYPE or another markup declaration (XXE / entity expansion). */
  | "doctype_forbidden"
  /** The XML is well formed but is not the SAML shape expected (missing or repeated parts). */
  | "malformed_response"
  /** A value that must be plain text (NameID, Issuer, Audience, …) holds a comment or element. */
  | "unexpected_markup"
  /** Neither the Response nor the Assertion carries a signature. */
  | "unsigned"
  /** A signature (or its digest) does not verify against any configured certificate. */
  | "bad_signature"
  /** The signed element is not the one being read (duplicate IDs, a moved Reference, …). */
  | "signature_wrapping"
  /** The document holds more than one Assertion element anywhere. */
  | "multiple_assertions"
  /** The Response carries an EncryptedAssertion / EncryptedID, which is not supported. */
  | "encrypted_assertion_unsupported"
  /** The Response's top-level StatusCode is not `…:status:Success`. */
  | "status_not_success"
  /** The Response's Destination is not this SP's ACS URL. */
  | "bad_destination"
  /** No bearer SubjectConfirmation names this SP's ACS URL as its Recipient. */
  | "bad_recipient"
  /** No bearer SubjectConfirmation is present. */
  | "bad_subject_confirmation"
  /** The AudienceRestriction does not name this SP's entity id. */
  | "bad_audience"
  /** The Response or Assertion Issuer is not the configured IdP. */
  | "bad_issuer"
  /** The Assertion (or its bearer confirmation, or its session) has expired. */
  | "expired"
  /** The Assertion's validity window has not started yet. */
  | "not_yet_valid"
  /** InResponseTo does not match the AuthnRequest the caller expected. */
  | "in_response_to_mismatch"
  /** An unsolicited (IdP-initiated) Response arrived and `allowIdpInitiated` is not set. */
  | "idp_initiated_disallowed"
  /** The Assertion ID was already consumed (the replay cache refused it). */
  | "replay"
  /** A signature, digest, canonicalization or transform algorithm outside the allowed list. */
  | "unsupported_algorithm"
  /** A configured certificate cannot be parsed or carries an unsupported key type. */
  | "bad_certificate"
  /** IdP metadata is missing the entity id, the redirect SSO endpoint or a signing certificate. */
  | "bad_metadata";

/**
 * A refused SAML message or bad SAML configuration. `code` is a stable machine code
 * (see {@link SamlErrorCode}); the message is human-readable detail for logs. Never echo
 * the message to an end user — report a generic sign-in failure.
 */
export class SamlError extends Error {
  /** The stable machine code. */
  readonly code: SamlErrorCode;

  /**
   * Create a refusal with a stable machine code.
   *
   * @param code The stable machine code.
   * @param message Human-readable detail for logs.
   */
  constructor(code: SamlErrorCode, message: string) {
    super(message);
    this.name = "SamlError";
    this.code = code;
  }
}
