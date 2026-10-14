/**
 * GoTrue's error shape: `{ code, error_code, msg }` with the HTTP status — what `supabase-js`
 * maps into an `AuthApiError` (its `code` is `error_code`). Messages are fixed strings: a
 * refused credential never echoes what was presented.
 *
 * @module
 */

/** A GoTrue error code (the subset denext answers with). */
export type GoTrueErrorCode =
  | "anonymous_provider_disabled"
  | "bad_code_verifier"
  | "bad_json"
  | "bad_jwt"
  | "bad_oauth_callback"
  | "bad_oauth_state"
  | "captcha_failed"
  | "custom_provider_not_found"
  | "email_address_invalid"
  | "email_exists"
  | "email_not_confirmed"
  | "email_provider_disabled"
  | "flow_state_expired"
  | "flow_state_not_found"
  | "identity_already_exists"
  | "identity_not_found"
  | "insufficient_aal"
  | "invalid_credentials"
  | "manual_linking_disabled"
  | "mfa_challenge_expired"
  | "mfa_factor_not_found"
  | "mfa_verification_failed"
  | "mfa_verification_rejected"
  | "mfa_phone_enroll_not_enabled"
  | "no_authorization"
  | "oauth_authorization_not_found"
  | "oauth_client_not_found"
  | "not_admin"
  | "otp_disabled"
  | "otp_expired"
  | "over_email_send_rate_limit"
  | "over_request_rate_limit"
  | "over_sms_send_rate_limit"
  | "phone_exists"
  | "phone_provider_disabled"
  | "provider_disabled"
  | "reauthentication_needed"
  | "reauthentication_not_valid"
  | "refresh_token_already_used"
  | "refresh_token_not_found"
  | "same_password"
  | "saml_entity_id_mismatch"
  | "saml_idp_already_exists"
  | "saml_metadata_fetch_failed"
  | "saml_provider_disabled"
  | "session_not_found"
  | "signup_disabled"
  | "single_identity_not_deletable"
  | "sms_send_failed"
  | "sso_domain_already_exists"
  | "sso_provider_not_found"
  | "unexpected_failure"
  | "user_already_exists"
  | "user_banned"
  | "user_not_found"
  | "validation_failed"
  | "weak_password"
  | "web3_provider_disabled"
  | "web3_unsupported_chain"
  | "not_found"
  | "method_not_allowed";

/** A GoTrue-shaped refusal; {@linkcode goTrueErrorResponse} renders it. */
export class GoTrueError extends Error {
  /** The HTTP status. */
  readonly status: number;
  /** The error code (`error_code`). */
  readonly code: GoTrueErrorCode;
  /** Extra body fields (e.g. `weak_password: { reasons }`). */
  readonly extra?: Record<string, unknown>;
  /**
   * Create the error.
   *
   * @param status The HTTP status.
   * @param code The error code.
   * @param message The `msg`.
   * @param extra Extra body fields.
   */
  constructor(
    status: number,
    code: GoTrueErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GoTrueError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Render a {@linkcode GoTrueError} as GoTrue does.
 *
 * @param error The error.
 * @returns The JSON response.
 */
export function goTrueErrorResponse(error: GoTrueError): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (error.status === 429) headers["retry-after"] = "60";
  return Response.json(
    { code: error.status, error_code: error.code, msg: error.message, ...error.extra },
    { status: error.status, headers },
  );
}

/** Shorthands for the refusals every route shares. */
export const fail = {
  /** 400 `validation_failed`. */
  validation: (message: string): GoTrueError => new GoTrueError(400, "validation_failed", message),
  /** 400 `invalid_credentials` — the one answer for an unknown user and a wrong secret. */
  credentials: (): GoTrueError =>
    new GoTrueError(400, "invalid_credentials", "Invalid login credentials"),
  /** 401 `no_authorization`. */
  noAuthorization: (): GoTrueError =>
    new GoTrueError(401, "no_authorization", "This endpoint requires a valid Bearer token"),
  /** 403 `bad_jwt`. */
  badJwt: (message = "invalid JWT: unable to parse or verify signature"): GoTrueError =>
    new GoTrueError(403, "bad_jwt", message),
  /** 403 `not_admin`. */
  notAdmin: (): GoTrueError => new GoTrueError(403, "not_admin", "User not allowed"),
  /** 429 `over_request_rate_limit`. */
  rateLimited: (code: GoTrueErrorCode = "over_request_rate_limit"): GoTrueError =>
    new GoTrueError(429, code, "Request rate limit reached"),
  /** 403 `otp_expired` — a wrong, spent or expired code or link. */
  otpExpired: (): GoTrueError =>
    new GoTrueError(403, "otp_expired", "Token has expired or is invalid"),
  /** 404 `user_not_found`. */
  userNotFound: (): GoTrueError => new GoTrueError(404, "user_not_found", "User not found"),
};
