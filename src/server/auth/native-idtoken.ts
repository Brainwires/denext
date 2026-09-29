/**
 * Native Apple / Google `id_token` verification, plus the two Sign in with Apple REST calls
 * account deletion needs (the code exchange that yields a refresh token, and its revocation).
 *
 * An `id_token` a native sign-in sheet returned is checked exactly as strictly as the web
 * OIDC flow checks its own: the signature against the provider's JWKS (cached per URL, one
 * throttled refetch on an unknown `kid`, so a key rotation is picked up), `iss` against the
 * provider's issuer(s), `exp`/`nbf`/`iat` with a minute of skew, and the audience against the
 * CONFIGURED client ids — `aud` must be one of them, a multi-valued `aud` needs an `azp`, and
 * any `azp` must be one of them too. The nonce is matched raw or as its SHA-256 hex (what the
 * Apple and Google native SDKs put in the token when handed a hashed nonce).
 *
 * Every network call goes through the host-pinned `safeFetch` (or the `native.fetch` seam in
 * tests). No token is ever logged.
 *
 * @module
 */

import { makeHostPinnedFetch, type ProviderFetch } from "./flow.ts";
import { sha256Hex } from "./hash.ts";
import { getJwks } from "./jwks-cache.ts";
import { type IdTokenClaims, idTokenKid, verifyIdToken } from "./jwt.ts";
import { base64UrlDecode } from "./oauth.ts";
import type { AdapterAccount } from "./adapter.ts";
import type { AuthConfig, NativeIdTokenProviderConfig } from "./types.ts";

/** The native id_token providers denext verifies. */
export type NativeIdTokenProvider = "apple" | "google";

/** Each provider's issuer(s) and JWKS endpoint. */
const PROVIDERS: Record<NativeIdTokenProvider, { issuers: string[]; jwksUrl: string }> = {
  apple: { issuers: ["https://appleid.apple.com"], jwksUrl: "https://appleid.apple.com/auth/keys" },
  google: {
    // Google documents both spellings of its issuer.
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  },
};

/** Apple's token and revocation endpoints. */
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/**
 * Whether `id` names a native id_token provider.
 *
 * @param id The `:provider` path segment.
 * @returns `true` for `"apple"` / `"google"`.
 */
export function isNativeIdTokenProvider(id: string): id is NativeIdTokenProvider {
  return id === "apple" || id === "google";
}

/** The fetch for `url`: the configured seam, else `safeFetch` pinned to that URL's host. */
function fetchFor(config: AuthConfig, url: string, label: string): ProviderFetch {
  return config.native?.fetch ??
    makeHostPinnedFetch([new URL(url).host], label, !!config.dangerouslyAllowInsecureProviders);
}

/** The unverified claims of a compact JWT (for choosing the issuer / audience to verify against). */
function peekClaims(token: string): IdTokenClaims | null {
  try {
    const part = token.split(".")[1];
    return part ? JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) : null;
  } catch {
    return null;
  }
}

/** A nonce claim matches the presented nonce raw, or as its SHA-256 hex. */
async function nonceMatches(claim: unknown, nonce: string): Promise<boolean> {
  if (typeof claim !== "string" || !nonce) return false;
  return claim === nonce || claim === await sha256Hex(nonce);
}

/**
 * The audience binding against a SET of our client ids (a native app has several: the iOS id,
 * the web id Android uses): `aud` names one of them, a multi-valued `aud` carries an `azp`, and
 * an `azp` names one of them.
 */
function assertAudience(claims: IdTokenClaims, clientIds: readonly string[]): string {
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const ours = aud.find((a): a is string => typeof a === "string" && clientIds.includes(a));
  if (!ours) throw new Error("id_token audience is not a configured client id");
  const azp = claims.azp;
  if (aud.length > 1 && azp === undefined) throw new Error("multi-valued aud without azp");
  if (azp !== undefined && (typeof azp !== "string" || !clientIds.includes(azp))) {
    throw new Error("id_token azp is not a configured client id");
  }
  return ours;
}

/** What {@link verifyNativeIdToken} returns. */
export interface VerifiedNativeIdToken {
  /** The verified claims. */
  claims: IdTokenClaims;
  /** The configured client id the token was issued to. */
  audience: string;
}

/**
 * Verify a native `id_token` for `provider` against its (cached) JWKS and the configured client
 * ids; with `nonce`, require the token's nonce to match it (raw or SHA-256 hex).
 *
 * @param config The app's auth config.
 * @param provider `"apple"` or `"google"`.
 * @param settings The provider's native settings (client ids, optional issuer/JWKS overrides).
 * @param idToken The compact `id_token`.
 * @param nonce The server-issued nonce the client used, when one is required.
 * @returns The verified claims and the matched audience.
 * @throws {Error} On any failed check (the caller answers a uniform refusal).
 */
export async function verifyNativeIdToken(
  config: AuthConfig,
  provider: NativeIdTokenProvider,
  settings: NativeIdTokenProviderConfig,
  idToken: string,
  nonce: string | undefined,
): Promise<VerifiedNativeIdToken> {
  const defaults = PROVIDERS[provider];
  const issuers = settings.issuers?.length ? settings.issuers : defaults.issuers;
  const jwksUrl = settings.jwksUrl ?? defaults.jwksUrl;
  const peeked = peekClaims(idToken);
  if (!peeked) throw new Error("malformed id_token");
  const issuer = issuers.find((iss) => iss === peeked.iss) ?? issuers[0];
  // A token for another client is refused before any key is fetched for it.
  const audience = assertAudience(peeked, settings.clientIds);
  const jwks = await getJwks(jwksUrl, fetchFor(config, jwksUrl, provider), {
    kid: idTokenKid(idToken),
  });
  // Signature, iss, exp/nbf/iat, then the audience again on the VERIFIED claims — against the
  // whole SET of client ids; the single-audience check is given the token's matching entry.
  const claims = await verifyIdToken({ idToken, jwks, issuer, audience, strictAudience: false });
  assertAudience(claims, settings.clientIds);
  if (nonce !== undefined && !(await nonceMatches(claims.nonce, nonce))) {
    throw new Error("id_token nonce mismatch");
  }
  return { claims, audience };
}

/** The Apple client secret: the native one, else the web `apple()` provider's (same team key). */
async function appleSecret(config: AuthConfig): Promise<string | undefined> {
  const configured = config.native?.apple?.clientSecret;
  if (typeof configured === "function") return await configured();
  if (typeof configured === "string" && configured) return configured;
  const web = config.providers.find((p) => p.id === "apple");
  return web && "clientSecret" in web && web.clientSecret ? web.clientSecret : undefined;
}

/** A form-encoded POST to an Apple endpoint. */
function applePost(config: AuthConfig, url: string, form: Record<string, string>) {
  return fetchFor(config, url, "apple")(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
}

/**
 * Exchange the `authorizationCode` a native Sign in with Apple returned for Apple's tokens, so
 * the refresh token can be revoked when the account is deleted. The response arrives directly
 * from Apple over TLS (OIDC Core §3.1.3.7 lets that stand in for a signature check); its
 * `id_token` must still name the same `sub` as the verified sign-in token, or nothing is kept.
 *
 * @param config The app's auth config.
 * @param input The code, the client id it was issued to, and the verified `sub`.
 * @returns The tokens to store on the account, or `undefined` (no secret, or the exchange failed).
 */
export async function exchangeAppleCode(
  config: AuthConfig,
  input: { code: string; clientId: string; sub: string },
): Promise<Pick<AdapterAccount, "refreshToken" | "idToken"> | undefined> {
  const secret = await appleSecret(config);
  if (!secret) return undefined;
  const res = await applePost(config, APPLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    client_secret: secret,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Apple token exchange failed (${res.status})`);
  }
  const body = await res.json() as { refresh_token?: unknown; id_token?: unknown };
  const idToken = typeof body.id_token === "string" ? body.id_token : undefined;
  if (!idToken || peekClaims(idToken)?.sub !== input.sub) {
    throw new Error("Apple token exchange answered for another subject");
  }
  return {
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    idToken,
  };
}

/** The client id an Apple account's tokens were issued to: its stored id_token's `aud`. */
function appleClientId(config: AuthConfig, account: AdapterAccount): string | undefined {
  const aud = account.idToken ? peekClaims(account.idToken)?.aud : undefined;
  const fromToken = Array.isArray(aud) ? aud[0] : aud;
  if (typeof fromToken === "string" && fromToken) return fromToken;
  const web = config.providers.find((p) => p.id === "apple");
  return web && "clientId" in web ? web.clientId : config.native?.apple?.clientIds[0];
}

/**
 * Revoke every stored Sign in with Apple token of a user at `appleid.apple.com/auth/revoke`
 * (the refresh token when there is one, else the access token).
 *
 * @param config The app's auth config.
 * @param accounts The user's linked accounts.
 * @returns `undefined` when there was nothing to revoke; `true` when every token was revoked;
 * `false` when at least one could not be (no secret, or Apple refused).
 */
export async function revokeAppleTokens(
  config: AuthConfig,
  accounts: AdapterAccount[],
): Promise<boolean | undefined> {
  const apple = accounts.filter((a) => a.provider === "apple" && (a.refreshToken || a.accessToken));
  if (apple.length === 0) return undefined;
  const secret = await appleSecret(config);
  if (!secret) return false;
  let all = true;
  for (const account of apple) {
    const clientId = appleClientId(config, account);
    const token = account.refreshToken ?? account.accessToken!;
    if (!clientId) {
      all = false;
      continue;
    }
    try {
      const res = await applePost(config, APPLE_REVOKE_URL, {
        client_id: clientId,
        client_secret: secret,
        token,
        token_type_hint: account.refreshToken ? "refresh_token" : "access_token",
      });
      await res.body?.cancel();
      if (!res.ok) all = false;
    } catch {
      all = false; // unreachable / refused: reported as not revoked, never thrown
    }
  }
  return all;
}
