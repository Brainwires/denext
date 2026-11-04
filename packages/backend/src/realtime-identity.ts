// Who is on the other end of a realtime socket or a REST broadcast, as a row-level-security scope.
//
// Today: the denext session cookie — read when the socket is upgraded and re-read on a timer, and
// honoured only on a same-origin request (a cross-site page can open a WebSocket to the app with
// the visitor's cookies; it must not act as them) — else `anon`.
//
// An `access_token` (the join payload's, or an `access_token` push) is verified with the keys
// `backend({ supabase })` installs, as `resolveIdentity()` verifies a bearer: a user's access
// token is that user (until its `exp`, when the channel closes, as Supabase's does); the
// secret key is `service_role`; the publishable / anon key means "no user" — the socket's own
// session, or anon. A token that is presented and refused (bad signature, expired, unknown key)
// refuses the join, or closes the channel. Without installed keys a token grants nothing (only
// its expiry is checked). `installAccessTokenVerifier` replaces the verification (tests).

import {
  apiKeyRole,
  installedSupabaseKeys,
  looksLikeJwt,
  opaqueKeyRole,
  type SupabaseKeys,
} from "@denext/denext/server";
import { activeAuthConfig, verifyAccessToken } from "@denext/auth";
import type { RlsScope } from "./rls.ts";
import { ANON_SCOPE } from "./rls.ts";
import { resolveScope } from "./postgres.ts";
import { identityScope } from "./identity.ts";

/** A resolved identity: the RLS scope, and when it stops being valid. */
export interface SocketIdentity {
  /** The role and claims queries run as. */
  scope: RlsScope;
  /** When the session or token expires (epoch milliseconds), if it does. */
  expiresAt?: number;
}

/** A token that was presented and refused: past its `exp`, or not a valid token or key. */
export interface ExpiredToken {
  expired: true;
  /** How long ago it expired, in seconds (0 for a token refused for another reason). */
  agoSeconds: number;
  /** Why, as Supabase Realtime words it. */
  reason: string;
}

/** Verifies a Supabase access token into an identity (`null`: not a token it accepts). */
export type AccessTokenVerifier = (token: string) => Promise<SocketIdentity | null>;

const SLOT = Symbol.for("denext.backend.accessTokenVerifier");
type Holder = { [SLOT]?: AccessTokenVerifier };

/**
 * Install the access-token verifier (W2's shared identity function), or clear it.
 *
 * @param verifier The verifier, or `undefined`.
 */
export function installAccessTokenVerifier(verifier: AccessTokenVerifier | undefined): void {
  (globalThis as Holder)[SLOT] = verifier;
}

/** The anonymous identity. */
export const ANON_SOCKET_IDENTITY: SocketIdentity = { scope: ANON_SCOPE };

/** The `exp` claim of a scope, as epoch milliseconds. */
function expiryOf(scope: RlsScope): number | undefined {
  try {
    const exp = (JSON.parse(scope.claims) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The current request's identity from its session cookie (call inside the request, or a
 * captured context of it).
 *
 * @returns The identity (`anon` when signed out).
 */
export async function sessionIdentity(): Promise<SocketIdentity> {
  const scope = await resolveScope();
  const expiresAt = expiryOf(scope);
  return expiresAt === undefined ? { scope } : { scope, expiresAt };
}

/** A JWT's payload, unverified (only to read `exp`); `null` when it is not a JWT. */
function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"));
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The identity an access token gives, falling back to `fallback` (the socket's cookie session)
 * when there is no token or it is not one the verifier accepts. A JWT past its `exp` is refused
 * whether or not it can be verified.
 *
 * @param token The token, if any.
 * @param fallback The identity without one.
 * @param now The time (epoch milliseconds).
 * @returns The identity, or why the token was refused.
 */
export async function tokenIdentity(
  token: unknown,
  fallback: SocketIdentity,
  now = Date.now(),
): Promise<SocketIdentity | ExpiredToken> {
  if (typeof token !== "string" || token === "") return fallback;
  const claims = jwtPayload(token);
  const exp = claims?.exp;
  if (typeof exp === "number" && exp * 1000 <= now) {
    const agoSeconds = Math.max(0, Math.floor((now - exp * 1000) / 1000));
    return { expired: true, agoSeconds, reason: `Token has expired ${agoSeconds} seconds ago` };
  }
  const verify = (globalThis as Holder)[SLOT];
  if (verify) return (await verify(token)) ?? fallback;
  const keys = installedSupabaseKeys();
  if (!keys) return fallback;
  try {
    return (await verifiedIdentity(keys, token)) ?? fallback;
  } catch (error) {
    return { expired: true, agoSeconds: 0, reason: (error as Error).message || "invalid token" };
  }
}

/** The auth config denext auth runs with (its adapter knows revoked sessions), if any. */
function authConfig() {
  try {
    return activeAuthConfig();
  } catch {
    return null;
  }
}

/** A service-role identity (the secret key). */
const SERVICE_IDENTITY: SocketIdentity = {
  scope: identityScope({
    role: "service_role",
    claims: { role: "service_role" },
    source: "api_key",
  }),
};

/**
 * A token verified with the installed keys, classified as `resolveIdentity()` classifies a
 * bearer: a user (`null` for "no user": an anon key, or an opaque value that is no key).
 *
 * @throws {Error} A token or key that is refused (bad signature, expired, unknown `sb_` key).
 */
async function verifiedIdentity(keys: SupabaseKeys, token: string): Promise<SocketIdentity | null> {
  let role: string;
  if (looksLikeJwt(token)) {
    const claims = await verifyAccessToken(keys, token, authConfig());
    if (claims.role === "authenticated") {
      const scope = identityScope({
        role: "authenticated",
        claims,
        ...(typeof claims.sub === "string" ? { userId: claims.sub } : {}),
        source: "jwt",
      });
      return typeof claims.exp === "number" ? { scope, expiresAt: claims.exp * 1000 } : { scope };
    }
    role = String(claims.role);
  } else if (token.startsWith("sb_")) {
    role = await apiKeyRole(keys, token);
  } else {
    role = (await opaqueKeyRole(keys, token)) ?? "anon";
  }
  return role === "service_role" ? SERVICE_IDENTITY : null;
}

/**
 * Check an API key (the socket's `apikey` query parameter) against the installed keys.
 *
 * @param apikey The key, if any.
 * @returns `null` when it is accepted (or no keys are installed), else why it is refused.
 */
export async function apiKeyRefusal(apikey: string | null): Promise<string | null> {
  const keys = installedSupabaseKeys();
  if (!keys) return null;
  if (!apikey) return "No API key found in request";
  try {
    if (looksLikeJwt(apikey)) {
      await verifyAccessToken(keys, apikey, null);
    } else if (apikey.startsWith("sb_")) {
      await apiKeyRole(keys, apikey);
    } else if (!(await opaqueKeyRole(keys, apikey))) {
      return "Invalid API key";
    }
    return null;
  } catch (error) {
    return (error as Error).message || "Invalid API key";
  }
}

/**
 * The identity's subject: `anon` or `authenticated:<sub>` — two scopes with the same subject
 * are the same user (a refreshed token).
 *
 * @param identity The identity.
 * @returns Its subject.
 */
export function subjectOf(identity: SocketIdentity): string {
  if (identity.scope.role === "anon" || identity.scope.role === "service_role") {
    return identity.scope.role;
  }
  try {
    return `authenticated:${String((JSON.parse(identity.scope.claims) as { sub?: unknown }).sub)}`;
  } catch {
    return "authenticated:?";
  }
}
