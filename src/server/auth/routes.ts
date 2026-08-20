/**
 * The auth endpoint handler — dispatched for every `/auth/*` request the plugin
 * claims. Implements the Authorization Code + PKCE flow, a Credentials POST, and
 * the session/providers/signout endpoints. All state (CSRF `state`, PKCE verifier,
 * OIDC `nonce`, return path) rides a single short-lived, httpOnly transaction
 * cookie; the callback re-derives the redirect URI byte-for-byte so it matches the
 * authorization request.
 *
 * @module
 */

import { absoluteUrl } from "../absolute-url.ts";
import { safeRedirectLocation } from "../config.ts";
import { getSession, type SessionOptions } from "../session.ts";
import { buildAuthorizationUrl, generatePkce, randomToken } from "./oauth.ts";
import { exchangeCodeForTokens, fetchJwks, fetchUserInfo, makeProviderFetch } from "./flow.ts";
import { verifyIdToken } from "./jwt.ts";
import { clearAuthSession, issueAuthSession, readAuthSession } from "./session.ts";
import {
  type AuthConfig,
  type AuthProvider,
  type AuthUser,
  isOAuthProvider,
  type OAuthProvider,
} from "./types.ts";

/** The reserved URL prefix all auth endpoints live under. */
export const AUTH_PREFIX = "/auth/";

/** The short-lived cookie carrying the in-flight OAuth transaction (origin-locked
 * via the `__Host-` prefix and signed, so it can't be forged or cross-subdomain
 * overwritten — a login-CSRF vector for an unsigned/plain tx cookie). */
const TX_COOKIE = "denext_auth_tx";

interface Transaction {
  provider: string;
  state: string;
  verifier: string;
  nonce?: string;
  returnTo?: string;
}

/** Signed, `__Host-`-prefixed, short-lived cookie carrying the OAuth transaction. */
function txSessionOptions(config: AuthConfig): SessionOptions {
  return {
    secret: config.secret,
    cookieName: TX_COOKIE,
    hostPrefix: true, // __Host- origin-locks it (Secure + Path=/ + no Domain)
    sameSite: "Lax", // sent on the top-level GET redirect back from the provider
    maxAge: 600,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}

function findProvider(config: AuthConfig, id: string): AuthProvider | undefined {
  return config.providers.find((p) => p.id === id);
}

/** Same-origin gate for state-changing POSTs (signout, credentials). */
function isSameOrigin(request: Request, config: AuthConfig): boolean {
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) return false;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  // With a canonical origin configured, match it exactly (scheme-strict) — the Host
  // header is attacker-controllable and unnecessary here.
  if (config.canonicalOrigin) {
    try {
      return u.origin === new URL(config.canonicalOrigin).origin;
    } catch {
      return false;
    }
  }
  // Otherwise fall back to the request's own Host.
  const host = request.headers.get("host");
  return !!host && u.host === host;
}

/** The byte-stable redirect URI for a provider callback (matches auth + token calls). */
function callbackUri(request: Request, config: AuthConfig, providerId: string): string {
  return absoluteUrl(request, `${AUTH_PREFIX}callback/${providerId}`, {
    canonicalOrigin: config.canonicalOrigin,
  });
}

async function setTx(config: AuthConfig, tx: Transaction): Promise<void> {
  const session = await getSession<Transaction>(txSessionOptions(config));
  await session.set(tx);
}

async function readTx(config: AuthConfig): Promise<Transaction | null> {
  const session = await getSession<Transaction>(txSessionOptions(config));
  return session.data ?? null;
}

async function clearTx(config: AuthConfig): Promise<void> {
  const session = await getSession<Transaction>(txSessionOptions(config));
  session.clear();
}

/**
 * Coerce a **request-derived** redirect target to a same-origin path. `callbackUrl`
 * (query or POST body) is attacker-supplied, and {@link safeRedirectLocation} passes
 * a fully-qualified `http(s)://…` value through unchanged by design (its SEC-L3
 * note) — an open redirect. So an absolute URL is admitted only when its origin
 * matches the app's canonical origin, and then only its path is kept; any other
 * absolute URL falls back to the default. Relative values still go through
 * `safeRedirectLocation` (which pins them to the current origin).
 */
function sameOriginRedirect(
  config: AuthConfig,
  requested: string | null | undefined,
  fallback: string,
): string {
  if (requested && /^https?:\/\//i.test(requested)) {
    if (config.canonicalOrigin) {
      try {
        const u = new URL(requested);
        if (u.origin === new URL(config.canonicalOrigin).origin) {
          return safeRedirectLocation(u.pathname + u.search + u.hash);
        }
      } catch { /* fall through to the fallback */ }
    }
    return safeRedirectLocation(fallback);
  }
  return safeRedirectLocation(requested || fallback);
}

function afterSignIn(config: AuthConfig, requested?: string | null): string {
  return sameOriginRedirect(config, requested, config.pages?.afterSignIn || "/");
}

/**
 * Handle an auth request. Returns a `Response` for a claimed `/auth/*` endpoint, or
 * `null` to let denext fall through (any non-auth path, or an unknown auth path).
 */
export async function handleAuthRequest(
  request: Request,
  config: AuthConfig,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(AUTH_PREFIX)) return null;
  const rest = url.pathname.slice(AUTH_PREFIX.length);
  const method = request.method.toUpperCase();

  if (rest === "session" && method === "GET") {
    const session = await readAuthSession(config);
    return json({ user: session?.user ?? null, expires: session?.expiresAt ?? null });
  }
  if (rest === "providers" && method === "GET") {
    return json(config.providers.map((p) => ({ id: p.id, type: p.type })));
  }
  if (rest === "signout" && method === "POST") {
    if (!isSameOrigin(request, config)) return json({ error: "forbidden" }, 403);
    await clearAuthSession(config);
    const back = afterSignInSignout(config, url.searchParams.get("callbackUrl"), "afterSignOut");
    return wantsJson(request) ? json({ ok: true }) : redirect(back);
  }

  const signinMatch = rest.match(/^signin\/([^/]+)$/);
  if (signinMatch && method === "GET") {
    return await startSignin(request, config, decodeURIComponent(signinMatch[1]), url);
  }

  const callbackMatch = rest.match(/^callback\/([^/]+)$/);
  if (callbackMatch) {
    const providerId = decodeURIComponent(callbackMatch[1]);
    const provider = findProvider(config, providerId);
    if (!provider) return json({ error: "unknown provider" }, 404);
    if (provider.type === "credentials" && method === "POST") {
      return await handleCredentials(request, config, provider);
    }
    if (isOAuthProvider(provider) && method === "GET") {
      return await handleOAuthCallback(request, config, provider, url);
    }
    return json({ error: "method not allowed" }, 405);
  }

  return null;
}

function afterSignInSignout(
  config: AuthConfig,
  requested: string | null,
  which: "afterSignOut",
): string {
  return sameOriginRedirect(config, requested, config.pages?.[which] || "/");
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json") ||
    request.headers.get("x-denext-auth") === "1";
}

/** Begin the OAuth/OIDC flow: stash PKCE/state/nonce, redirect to the provider. */
async function startSignin(
  request: Request,
  config: AuthConfig,
  providerId: string,
  url: URL,
): Promise<Response> {
  const provider = findProvider(config, providerId);
  if (!provider || !isOAuthProvider(provider)) {
    return json({ error: "unknown provider" }, 404);
  }
  const pkce = await generatePkce();
  const state = randomToken();
  const nonce = provider.type === "oidc" ? randomToken() : undefined;
  // Coerce the caller-supplied return target to a same-origin path before it rides
  // the transaction cookie (defense in depth; the callback coerces again).
  const rawReturn = url.searchParams.get("callbackUrl");
  const returnTo = rawReturn
    ? sameOriginRedirect(config, rawReturn, config.pages?.afterSignIn || "/")
    : undefined;
  await setTx(config, { provider: provider.id, state, verifier: pkce.verifier, nonce, returnTo });

  const authUrl = buildAuthorizationUrl({
    authorizationUrl: provider.authorizationUrl,
    clientId: provider.clientId,
    redirectUri: callbackUri(request, config, provider.id),
    scope: provider.scopes.join(" "),
    state,
    codeChallenge: pkce.challenge,
    nonce,
    extra: provider.authorizationParams,
  });
  return redirect(authUrl);
}

/** Complete the OAuth/OIDC flow: verify state, exchange the code, issue a session. */
async function handleOAuthCallback(
  request: Request,
  config: AuthConfig,
  provider: OAuthProvider,
  url: URL,
): Promise<Response> {
  const signinPage = config.pages?.signIn || "/";
  const error = url.searchParams.get("error");
  if (error) {
    return redirect(safeRedirectLocation(`${signinPage}?error=${encodeURIComponent(error)}`));
  }

  const tx = await readTx(config);
  await clearTx(config);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!tx || tx.provider !== provider.id || !code || !state || tx.state !== state) {
    return redirect(safeRedirectLocation(`${signinPage}?error=invalid_state`));
  }

  try {
    const doFetch = makeProviderFetch(provider, config.dangerouslyAllowInsecureProviders);
    const tokens = await exchangeCodeForTokens(
      provider,
      { code, codeVerifier: tx.verifier, redirectUri: callbackUri(request, config, provider.id) },
      doFetch,
    );

    let claims: Record<string, unknown> | undefined;
    if (provider.type === "oidc") {
      if (!tokens.id_token) throw new Error("provider returned no id_token");
      const jwks = await fetchJwks(provider, doFetch);
      claims = await verifyIdToken({
        idToken: tokens.id_token,
        jwks,
        issuer: provider.issuer!,
        audience: provider.clientId,
        nonce: tx.nonce,
      }) as Record<string, unknown>;
    }
    const userinfo = provider.userinfoUrl && tokens.access_token
      ? await fetchUserInfo(provider, tokens.access_token, doFetch)
      : undefined;

    const profile = provider.profile({ tokens, userinfo, claims });
    if (!profile.id) throw new Error("provider profile had no id");

    const user = await applySignInCallback(config, profile, provider.id);
    if (!user) return redirect(safeRedirectLocation(`${signinPage}?error=access_denied`));

    await issueAuthSession(config, user, provider.id);
    return redirect(afterSignIn(config, tx.returnTo));
  } catch {
    return redirect(safeRedirectLocation(`${signinPage}?error=oauth_failed`));
  }
}

/** Handle a Credentials POST: authorize, then issue a session. */
async function handleCredentials(
  request: Request,
  config: AuthConfig,
  provider: AuthProvider,
): Promise<Response> {
  if (isOAuthProvider(provider)) return json({ error: "not a credentials provider" }, 400);
  if (!isSameOrigin(request, config)) return json({ error: "forbidden" }, 403);

  const creds = await readCredentials(request);
  let user: AuthUser | null = null;
  try {
    user = await provider.authorize(creds);
  } catch {
    user = null;
  }
  // Generic failure — never reveal whether the account exists.
  if (!user) return json({ error: "invalid credentials" }, 401);

  const approved = await applySignInCallback(config, user, provider.id);
  if (!approved) return json({ error: "access denied" }, 403);

  await issueAuthSession(config, approved, provider.id);
  if (wantsJson(request)) return json({ ok: true, user: approved });
  const back = afterSignIn(config, creds.callbackUrl);
  return redirect(back);
}

/** Parse credentials from a JSON or form-encoded POST body. */
async function readCredentials(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await request.json();
      return typeof body === "object" && body ? body as Record<string, string> : {};
    }
    const form = await request.formData();
    const out: Record<string, string> = {};
    for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Run the app's signIn callback: `false` denies, an object enriches, else pass through. */
async function applySignInCallback(
  config: AuthConfig,
  user: AuthUser,
  providerId: string,
): Promise<AuthUser | null> {
  if (!config.callbacks?.signIn) return user;
  const result = await config.callbacks.signIn(user, providerId);
  if (result === false) return null;
  if (result && typeof result === "object") return result;
  return user;
}
