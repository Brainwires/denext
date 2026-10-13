/**
 * The `/auth/v1` (GoTrue-compatible) options: `backend({ supabase: { auth } })` passes them, and
 * `denextAuth()` supplies everything else (the adapter, the password hasher, the providers, the
 * email delivery, the rate limits).
 *
 * @module
 */

import type { AdapterUser } from "../adapter.ts";
import type { SamlPrivateKey } from "../saml/config.ts";
import type { NativeIdTokenProviderConfig } from "../types.ts";

/** What {@linkcode GoTrueOptions.sendSms} delivers. */
export interface GoTrueSmsMessage {
  /** The number, E.164 (`+15551234567`). */
  phone: string;
  /** The one-time code. */
  otp: string;
  /** A ready-to-send text (`Your code is 123456`). */
  message: string;
  /** `sms` or `whatsapp`, as the client asked. */
  channel: "sms" | "whatsapp";
  /** Why it is sent. */
  type: "signup" | "sms" | "phone_change" | "reauthentication" | "mfa";
  /** The user it is for, when one exists yet. */
  user?: AdapterUser;
}

/** What {@linkcode GoTrueHooks.sendEmail} receives — Supabase's Send Email Hook payload. */
export interface GoTrueSendEmailPayload {
  /** The user (GoTrue's JSON shape). */
  user: Record<string, unknown>;
  /** The email's data. */
  email_data: {
    /** The one-time code. */
    token: string;
    /** The hash a link carries (`/auth/v1/verify?token=<token_hash>&type=…`). */
    token_hash: string;
    /** Where the link lands after verification. */
    redirect_to: string;
    /** `signup`, `invite`, `magiclink`, `recovery`, `email_change`, `reauthentication` or `email`. */
    email_action_type: string;
    /** The site URL. */
    site_url: string;
    /** The ready-to-click verification link. */
    action_link: string;
    /** For an email change: the code and hash for the NEW address. */
    token_new?: string;
    /** For an email change: the hash for the new address. */
    token_hash_new?: string;
  };
}

/** What {@linkcode GoTrueHooks.customAccessToken} receives. */
export interface GoTrueAccessTokenHookInput {
  /** The user id. */
  user_id: string;
  /** The claims about to be signed. */
  claims: Record<string, unknown>;
  /** How the session was authenticated (`password`, `otp`, `oauth`, …). */
  authentication_method: string;
}

/** Supabase's auth hooks, as functions. */
export interface GoTrueHooks {
  /**
   * Shape every access token: return the claims to sign (Supabase's Custom Access Token Hook).
   * `sub`, `role`, `aud`, `session_id`, `iat`, `exp`, `aal` and `is_anonymous` are restored
   * after it runs (it may add claims and change `app_metadata` / `user_metadata` /
   * `email` / `phone` in the token only). A throw refuses the sign-in.
   */
  customAccessToken?: (
    input: GoTrueAccessTokenHookInput,
  ) => Promise<{ claims: Record<string, unknown> }> | { claims: Record<string, unknown> };
  /** Deliver every auth email yourself (replaces `sendVerificationRequest` for `/auth/v1`). */
  sendEmail?: (payload: GoTrueSendEmailPayload) => Promise<void> | void;
  /** Deliver every auth SMS yourself (replaces {@linkcode GoTrueOptions.sendSms}). */
  sendSms?: (message: GoTrueSmsMessage) => Promise<void> | void;
}

/** Captcha verification for sign-up, sign-in, OTP, recovery and anonymous sign-in. */
export interface GoTrueCaptchaOptions {
  /** `hcaptcha` or `turnstile`. */
  provider: "hcaptcha" | "turnstile";
  /** The provider's secret key. */
  secret: string;
  /** The verification endpoint (default: the provider's). */
  verifyUrl?: string;
  /** `fetch` for the verification call (tests). */
  fetch?: typeof fetch;
}

/** A SAML 2.0 identity provider for `signInWithSSO`. */
export interface GoTrueSamlProvider {
  /** A stable id (a UUID is conventional) — `signInWithSSO({ providerId })`. */
  id: string;
  /** Email domains that route to this provider — `signInWithSSO({ domain })`. */
  domains?: string[];
  /** The IdP's metadata XML (entity id, SSO URL, signing certificates). */
  metadataXml: string;
  /**
   * Map the assertion's attributes to user metadata (`{ email: "mail", name: "displayName" }`);
   * the email defaults to the NameID when it is an address, else to `email` / `mail`.
   */
  attributeMapping?: Record<string, string>;
}

/** The `/auth/v1` options. */
export interface GoTrueOptions {
  /** The site URL — the default redirect after a link (default: the auth `canonicalOrigin`). */
  siteUrl?: string;
  /**
   * Other URLs a `redirect_to` may name (`*` matches within one path segment or host label,
   * `**` anything). A `redirect_to` not on the list falls back to {@linkcode siteUrl}.
   */
  redirectUrls?: string[];
  /** Access-token lifetime in seconds (default 3600). */
  jwtExpiry?: number;
  /** Seconds within which a used refresh token may be presented again (default 10). */
  refreshTokenReuseInterval?: number;
  /** Refuse new sign-ups (`signup_disabled`); invited and admin-created users still work. */
  disableSignup?: boolean;
  /** Sign a user in at sign-up without confirming the email first (default `false`). */
  autoconfirm?: boolean;
  /** The same for phone sign-ups (default `false`). */
  phoneAutoconfirm?: boolean;
  /** Allow `signInAnonymously()` (default `false`). */
  anonymousUsers?: boolean;
  /** Minimum password length (default 8). */
  minPasswordLength?: number;
  /** Digits in an email / SMS one-time code (default 6, 6–10). */
  otpLength?: number;
  /** Seconds an email / SMS code or link stays valid (default 3600). */
  otpExpiry?: number;
  /**
   * Deliver an SMS (a one-time code). Phone sign-up, phone OTP and phone MFA are off without
   * it (or `hooks.sendSms`).
   */
  sendSms?: (message: GoTrueSmsMessage) => Promise<void> | void;
  /** Verify a `captcha_token` on the endpoints that create sessions or send messages. */
  captcha?: GoTrueCaptchaOptions;
  /** Supabase's auth hooks. */
  hooks?: GoTrueHooks;
  /**
   * A password change on an account that already has one needs a fresh reauthentication nonce
   * (`reauthenticate()`, then `updateUser({ password, nonce })`). Default `false`.
   */
  requireReauthentication?: boolean;
  /** Allow `linkIdentity()` (default `true`). */
  manualLinking?: boolean;
  /** Second factors: TOTP is on; `phone: true` adds SMS factors (needs `sendSms`). */
  mfa?: { phone?: boolean; maxFactors?: number };
  /**
   * `signInWithIdToken({ provider: "google" | "apple" })`: the client ids a native id_token may
   * be issued to (default: the auth config's `native.google` / `native.apple`).
   */
  idTokenProviders?: { google?: NativeIdTokenProviderConfig; apple?: NativeIdTokenProviderConfig };
  /** SAML 2.0 single sign-on (`signInWithSSO`, the SSO admin API, Single Logout). */
  saml?: GoTrueSamlOptions;
}

/** The `/auth/v1` SAML 2.0 options. */
export interface GoTrueSamlOptions {
  /**
   * Identity providers declared in config (read-only to the admin API). Providers can also be
   * stored through `POST /auth/v1/admin/sso/providers`; both kinds work side by side, and an
   * entity id or domain belongs to one provider only.
   */
  providers?: GoTrueSamlProvider[];
  /** This service provider's entity id (default: the metadata URL). */
  entityId?: string;
  /**
   * The SP signing key — a PKCS #8 PEM or an RSA private JWK (RSA-SHA256). It signs
   * AuthnRequests and Single Logout messages, and turns Single Logout on (the SP metadata then
   * advertises `/auth/v1/sso/saml/slo`). Requires {@linkcode signingCertificate}.
   */
  signingKey?: SamlPrivateKey;
  /** The X.509 certificate (PEM) of {@linkcode signingKey}, published in the SP metadata. */
  signingCertificate?: string;
  /**
   * The SP decryption key — a PKCS #8 PEM or an RSA private JWK: IdPs may then encrypt
   * assertions to this SP (RSA-OAEP key transport; AES-GCM or AES-CBC content). Requires
   * {@linkcode encryptionCertificate}.
   */
  encryptionKey?: SamlPrivateKey;
  /** The X.509 certificate (PEM) of {@linkcode encryptionKey}, published `use="encryption"`. */
  encryptionCertificate?: string;
}
