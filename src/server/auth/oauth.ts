/**
 * OAuth 2.0 primitives for denext auth: PKCE, CSRF `state`, OIDC `nonce`, and the
 * authorization-URL builder. These are pure (crypto + URL) — the network calls
 * (token exchange, userinfo) live in {@link ./flow.ts | flow.ts} on top of the
 * SSRF-safe `safeFetch`.
 *
 * @module
 */

const encoder = new TextEncoder();

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

/**
 * A cryptographically-random URL-safe token (for `state` / `nonce` / PKCE verifier).
 *
 * @param bytes Entropy in bytes (default 32 → a 43-char token).
 * @returns A base64url string of `bytes` random bytes.
 */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
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
  /** PKCE S256 challenge. */
  codeChallenge: string;
  /** OIDC `nonce` (omit for plain OAuth 2.0 providers). */
  nonce?: string;
  /** Extra provider-specific query params (e.g. `access_type: "offline"`). */
  extra?: Record<string, string>;
}

/**
 * Build the provider authorization URL for the Authorization Code + PKCE flow.
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
  q.set("scope", params.scope);
  q.set("state", params.state);
  q.set("code_challenge", params.codeChallenge);
  q.set("code_challenge_method", "S256");
  if (params.nonce) q.set("nonce", params.nonce);
  for (const [k, v] of Object.entries(params.extra ?? {})) q.set(k, v);
  return url.href;
}
