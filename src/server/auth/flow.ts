/**
 * The networked half of the OAuth flow: exchange an authorization `code` for tokens and
 * fetch userinfo. All requests go through the SSRF-safe `safeFetch`, pinned to the
 * provider's own hosts — the endpoints it configured, plus the ones OIDC discovery
 * resolved for it (see `discovery.ts`). In development a provider on `http://localhost`
 * can be permitted with an explicit opt-in (the production `safeFetch` blocks
 * loopback/private addresses). The JWKS fetch lives in `jwks-cache.ts`, because it is
 * cached.
 *
 * @module
 */

import { safeFetch } from "../safe-fetch.ts";
import type { OAuthProvider } from "./types.ts";

/** A `fetch` used for provider calls (real `safeFetch`, or a dev-insecure variant). */
export type ProviderFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/** The hosts safeFetch may reach for a provider (from its configured endpoints). */
function providerHosts(provider: OAuthProvider, extraHosts: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (
    const url of [
      provider.authorizationUrl,
      provider.tokenUrl,
      provider.userinfoUrl,
      provider.userEmailsUrl,
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
  for (const h of extraHosts) hosts.add(h);
  return [...hosts];
}

/**
 * Build the provider fetch: `safeFetch` pinned to the provider's hosts by default,
 * or — only when `allowInsecure` is set (development) — plain `fetch` restricted to
 * the same host allowlist, so a localhost provider works without opening SSRF in
 * production.
 *
 * @param provider The provider whose configured endpoints seed the host allowlist.
 * @param allowInsecure Development opt-in permitting `http://localhost` providers.
 * @param extraHosts Hosts resolved after the fact (OIDC discovery), added to the allowlist.
 * @returns The pinned fetch to hand the flow helpers.
 */
export function makeProviderFetch(
  provider: OAuthProvider,
  allowInsecure = false,
  extraHosts: readonly string[] = [],
): ProviderFetch {
  return makeHostPinnedFetch(providerHosts(provider, extraHosts), provider.id, allowInsecure);
}

/**
 * The primitive behind {@link makeProviderFetch}: a fetch that may reach these hosts and
 * nothing else. Discovery uses it directly, pinned to the issuer's host alone — the
 * document that decides where the client secret is sent must itself come from the issuer.
 *
 * @param hosts The exact hosts this fetch may reach.
 * @param label The provider id, used in the refusal message.
 * @param allowInsecure Development opt-in: use the platform `fetch` (so `http://localhost`
 * works) while still enforcing the host allowlist ourselves.
 * @returns The pinned fetch.
 */
export function makeHostPinnedFetch(
  hosts: readonly string[],
  label: string,
  allowInsecure: boolean,
): ProviderFetch {
  const allowed = [...hosts];
  if (!allowInsecure) {
    return (url, init) => safeFetch(url, { ...init, allowedHosts: allowed });
  }
  return makeInsecureHostPinnedFetch(allowed, label);
}

/** Redirect statuses the dev fetch follows itself (the set `safeFetch` follows). */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** How many hops the dev fetch follows before giving up — `safeFetch`'s default. */
const MAX_REDIRECTS = 5;

/** The request as it stands on the current redirect hop (mirrors `safe-fetch.ts`). */
interface DevHop {
  /** Where this hop goes. */
  url: string;
  /** The method this hop uses (a 303, or a 301/302 off a POST, downgrades to GET). */
  method: string;
  /** The body this hop carries — dropped with the method downgrade. */
  body?: string;
}

/**
 * The development variant of the pinned fetch: the platform `fetch` (so an
 * `http://localhost` provider works, which `safeFetch`'s loopback block refuses), with
 * the host allowlist enforced here instead.
 *
 * Redirects are followed **manually**, and EVERY hop is re-checked against the allowlist.
 * Letting the platform follow them silently meant a provider that answered the token
 * endpoint with a `307` could send denext — and with it the `client_secret` in the POST
 * body — to any host it named; only the first URL had ever been checked.
 */
function makeInsecureHostPinnedFetch(allowed: readonly string[], label: string): ProviderFetch {
  return async (url, init) => {
    const hop: DevHop = { url, method: init.method, body: init.body };
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      assertHostAllowed(hop.url, allowed, label);
      const res = await fetch(hop.url, {
        method: hop.method,
        headers: init.headers,
        body: hop.body,
        redirect: "manual",
      });
      const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
      if (location === null) return res;
      await res.body?.cancel().catch(() => {});
      advanceHop(hop, res.status, location);
    }
    throw new Error(`auth: provider ${label} redirected more than ${MAX_REDIRECTS} times`);
  };
}

/** Refuse a URL that is not on the provider's allowlist (the check every hop repeats). */
function assertHostAllowed(url: string, allowed: readonly string[], label: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`auth: provider ${label} redirected to an unparseable URL`);
  }
  if (!allowed.includes(host)) {
    throw new Error(`auth: host ${host} not permitted for provider ${label}`);
  }
}

/**
 * Move `hop` to a redirect's target. 303 — and 301/302 off a non-idempotent method —
 * downgrade to a bodyless GET, exactly as the fetch spec (and `safeFetch`) do.
 */
function advanceHop(hop: DevHop, status: number, location: string): void {
  try {
    hop.url = new URL(location, hop.url).href;
  } catch {
    throw new Error(`auth: invalid redirect location: ${location}`);
  }
  const downgrades = status === 303 ||
    ((status === 301 || status === 302) && hop.method !== "GET" && hop.method !== "HEAD");
  if (!downgrades) return;
  hop.method = "GET";
  hop.body = undefined;
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
 * @param provider The provider (supplies the client credentials).
 * @param params The code, the PKCE verifier, the byte-stable redirect URI, and the
 * resolved token endpoint (configured, or from OIDC discovery).
 * @param doFetch The pinned provider fetch.
 * @returns The parsed token response.
 * @throws if the endpoint returns a non-2xx or a body with an `error`.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  params: { code: string; codeVerifier: string; redirectUri: string; tokenUrl: string },
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

  const res = await doFetch(params.tokenUrl, {
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

/** Authenticated `GET` returning parsed JSON, shared by userinfo/emails fetches. */
async function fetchAuthedJson(
  url: string,
  accessToken: string,
  doFetch: ProviderFetch,
  what: string,
): Promise<unknown> {
  const res = await doFetch(url, {
    method: "GET",
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "accept": "application/json",
      "user-agent": "denext-auth",
    },
  });
  if (!res.ok) throw new Error(`${what} failed (${res.status})`);
  return await res.json().catch(() => null);
}

/**
 * Fetch the userinfo profile (OAuth providers without an id_token).
 *
 * @param userinfoUrl The resolved userinfo endpoint.
 * @param accessToken The access token from the exchange.
 * @param doFetch The pinned provider fetch.
 * @returns The parsed profile (`{}` when the provider answers with nothing usable).
 */
export async function fetchUserInfo(
  userinfoUrl: string,
  accessToken: string,
  doFetch: ProviderFetch,
): Promise<Record<string, unknown>> {
  const json = await fetchAuthedJson(userinfoUrl, accessToken, doFetch, "userinfo");
  return (json ?? {}) as Record<string, unknown>;
}

/**
 * Fetch the account's email list (e.g. GitHub `/user/emails`) so a mapper can select a
 * verified address. Returns `undefined` when the provider has no `userEmailsUrl`;
 * a non-2xx or unparseable response throws (the caller treats it as no verified email).
 *
 * @param provider The provider (its `userEmailsUrl` is never part of discovery).
 * @param accessToken The access token from the exchange.
 * @param doFetch The pinned provider fetch.
 * @returns The raw list, or `undefined` when there is no endpoint / no list.
 */
export async function fetchUserEmails(
  provider: OAuthProvider,
  accessToken: string,
  doFetch: ProviderFetch,
): Promise<unknown[] | undefined> {
  if (!provider.userEmailsUrl) return undefined;
  const json = await fetchAuthedJson(provider.userEmailsUrl, accessToken, doFetch, "user emails");
  return Array.isArray(json) ? json : undefined;
}
