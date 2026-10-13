/**
 * SAML 2.0 Service Provider primitives: IdP metadata parsing, SP metadata, HTTP-Redirect
 * AuthnRequests (signed when the SP has a signing key), strict verification of HTTP-POST
 * Responses (exclusive c14n, XML-DSig, signature-wrapping and comment-injection defenses,
 * replay protection, encrypted assertions), and Single Logout (signed LogoutRequest /
 * LogoutResponse out, both bindings in). A pure library — it mounts no routes; wire it into
 * your own SSO endpoints.
 *
 * @module
 */

export type { SamlIdpConfig, SamlPrivateKey, SamlSpConfig } from "./config.ts";
export { SamlError } from "./errors.ts";
export type { SamlErrorCode } from "./errors.ts";
export { parseIdpMetadata, spMetadataXml } from "./metadata.ts";
export { buildAuthnRequest } from "./request.ts";
export type { BuildAuthnRequestOptions } from "./request.ts";
export { inMemorySamlReplayCache, verifySamlResponse } from "./response.ts";
export type {
  SamlReplayCache,
  VerifiedSamlAssertion,
  VerifySamlResponseOptions,
} from "./response.ts";
export {
  buildLogoutRequest,
  buildLogoutResponse,
  peekLogoutMessage,
  verifyLogoutRequest,
  verifyLogoutResponse,
} from "./logout.ts";
export type {
  BuildLogoutRequestOptions,
  BuildLogoutResponseOptions,
  PeekedLogoutMessage,
  SamlBindingInput,
  VerifiedLogoutRequest,
  VerifiedLogoutResponse,
  VerifyLogoutOptions,
} from "./logout.ts";
