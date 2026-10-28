/**
 * OAuth 2.0 primitives for denext auth: PKCE, CSRF `state`, OIDC `nonce`, and the
 * authorization-URL builder. These are pure (crypto + URL) — the network calls
 * (token exchange, userinfo) live in {@link ./flow.ts | flow.ts} on top of the
 * SSRF-safe `safeFetch`.
 *
 * @module
 */

import type { OAuthCheck } from "./types.ts";
import { randomToken } from "@denext/denext/auth-kit";

export { randomToken };

const encoder = new TextEncoder();

/** Every value {@linkcode OAuthCheck} takes. */
export const OAUTH_CHECKS: readonly OAuthCheck[] = ["pkce", "state", "nonce", "none"];

/** Which of the optional protections one flow runs (`state` always runs). */
export interface FlowChecks {
  /** Send a PKCE challenge, and redeem the code with its verifier. */
  pkce: boolean;
  /** Send a `nonce`, and require it in the `id_token`. */
  nonce: boolean;
}

/**
 * The protections a provider's flow runs: PKCE, plus a `nonce` for OIDC, unless its `checks`
 * say otherwise (Auth.js's semantics; `state` is never optional).
 *
 * @param provider The provider's type and `checks`.
 * @returns Whether the flow sends PKCE and a `nonce`.
 */
export function flowChecks(
  provider: { type: "oauth" | "oidc"; checks?: readonly OAuthCheck[] },
): FlowChecks {
  const { checks } = provider;
  return {
    pkce: !checks || checks.includes("pkce"),
    nonce: provider.type === "oidc" && (!checks || checks.includes("nonce")),
  };
}

/** URL-safe base64 of bytes (no padding) — the encoding OAuth/JOSE expect. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decode a URL-safe base64 string (padding optional) to bytes. */
export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A PKCE verifier/challenge pair (RFC 7636, S256). */
export interface Pkce {
  /** The high-entropy secret kept client-side (in a signed cookie) until callback. */
  verifier: string;
  /** `BASE64URL(SHA256(verifier))`, sent on the authorization request. */
  challenge: string;
}

/**
 * Generate a PKCE pair using the S256 method. The `verifier` is stored (signed,
 * httpOnly) until the callback; the `challenge` rides the authorization URL, so an
 * intercepted `code` is useless without the verifier.
 *
 * @returns A {@link Pkce} pair.
 */
export async function generatePkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier) as BufferSource,
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/** Inputs to {@link buildAuthorizationUrl}. */
export interface AuthorizationUrlParams {
  /** The provider's authorization endpoint. */
  authorizationUrl: string;
  /** The OAuth client id. */
  clientId: string;
  /** The (byte-stable) redirect URI registered with the provider. */
  redirectUri: string;
  /** Requested scopes (space-joined). */
  scope: string;
  /** CSRF `state` value (also carries the post-login return path when you choose). */
  state: string;
  /** PKCE S256 challenge (left out for a provider whose `checks` don't list `"pkce"`). */
  codeChallenge?: string;
  /** OIDC `nonce` (omit for plain OAuth 2.0 providers). */
  nonce?: string;
  /** Extra provider-specific query params (e.g. `access_type: "offline"`). */
  extra?: Record<string, string>;
  /** `"form_post"` adds `response_mode=form_post` (OAuth 2.0 Form Post Response Mode §2). */
  responseMode?: "query" | "form_post";
}

/**
 * Build the provider authorization URL for the Authorization Code flow (+ PKCE when the
 * challenge is given).
 *
 * @param params {@link AuthorizationUrlParams}.
 * @returns The full authorization URL to redirect the user to.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.authorizationUrl);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", params.clientId);
  q.set("redirect_uri", params.redirectUri);
  // A provider that takes its scopes from the app registration (Zoom, Notion) gets none.
  if (params.scope) q.set("scope", params.scope);
  q.set("state", params.state);
  if (params.codeChallenge) {
    q.set("code_challenge", params.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  if (params.nonce) q.set("nonce", params.nonce);
  if (params.responseMode === "form_post") q.set("response_mode", "form_post");
  for (const [k, v] of Object.entries(params.extra ?? {})) q.set(k, v);
  return url.href;
}
