/**
 * The networked half of the OAuth flow: exchange an authorization `code` for
 * tokens, fetch userinfo, and fetch a provider's JWKS. All requests go through the
 * SSRF-safe `safeFetch`, pinned to the provider's own hosts. In development a
 * provider on `http://localhost` can be permitted with an explicit opt-in (the
 * production `safeFetch` blocks loopback/private addresses).
 *
 * @module
 */

import { safeFetch } from "../safe-fetch.ts";
import type { Jwk } from "./jwt.ts";
import type { OAuthProvider } from "./types.ts";

/** A `fetch` used for provider calls (real `safeFetch`, or a dev-insecure variant). */
export type ProviderFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/** The hosts safeFetch may reach for a provider (from its configured endpoints). */
export function providerHosts(provider: OAuthProvider): string[] {
  const hosts = new Set<string>();
  for (
    const url of [
      provider.authorizationUrl,
      provider.tokenUrl,
      provider.userinfoUrl,
      provider.jwksUrl,
    ]
  ) {
    if (url) {
      try {
        hosts.add(new URL(url).host);
      } catch { /* skip malformed */ }
    }
  }
  for (const h of provider.allowedHosts ?? []) hosts.add(h);
  return [...hosts];
}

/**
 * Build the provider fetch: `safeFetch` pinned to the provider's hosts by default,
 * or — only when `allowInsecure` is set (development) — plain `fetch` restricted to
 * the same host allowlist, so a localhost provider works without opening SSRF in
 * production.
 */
export function makeProviderFetch(provider: OAuthProvider, allowInsecure = false): ProviderFetch {
  const hosts = providerHosts(provider);
  if (!allowInsecure) {
    return (url, init) => safeFetch(url, { ...init, allowedHosts: hosts });
  }
  return (url, init) => {
    // Dev-only: enforce the same allowlist ourselves, then use the platform fetch
    // (which safeFetch's loopback block would otherwise reject).
    const host = new URL(url).host;
    if (!hosts.includes(host)) {
      return Promise.reject(
        new Error(`auth: host ${host} not permitted for provider ${provider.id}`),
      );
    }
    return fetch(url, init);
  };
}

/** Tokens returned by the token endpoint. */
export interface TokenResponse {
  access_token?: string;
  token_type?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  [k: string]: unknown;
}

/**
 * Exchange an authorization `code` (+ PKCE verifier) for tokens at the provider's
 * token endpoint.
 *
 * @throws if the endpoint returns a non-2xx or a body with an `error`.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  params: { code: string; codeVerifier: string; redirectUri: string },
  doFetch: ProviderFetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: params.codeVerifier,
  }).toString();

  const res = await doFetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body,
  });
  const tokens = await res.json().catch(() => ({})) as TokenResponse;
  if (!res.ok || tokens.error) {
    throw new Error(`token exchange failed (${res.status}): ${tokens.error ?? "unknown"}`);
  }
  return tokens;
}

/** Fetch the userinfo profile (OAuth providers without an id_token). */
export async function fetchUserInfo(
  provider: OAuthProvider,
  accessToken: string,
  doFetch: ProviderFetch,
): Promise<Record<string, unknown>> {
  if (!provider.userinfoUrl) return {};
  const res = await doFetch(provider.userinfoUrl, {
    method: "GET",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "accept": "application/json",
      "user-agent": "denext-auth",
    },
  });
  if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
  return await res.json().catch(() => ({})) as Record<string, unknown>;
}

/** Fetch a provider's JWKS keys (for id_token verification). */
export async function fetchJwks(
  provider: OAuthProvider,
  doFetch: ProviderFetch,
): Promise<Jwk[]> {
  if (!provider.jwksUrl) return [];
  const res = await doFetch(provider.jwksUrl, {
    method: "GET",
    headers: { "accept": "application/json" },
  });
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  const body = await res.json().catch(() => ({})) as { keys?: Jwk[] };
  return body.keys ?? [];
}
