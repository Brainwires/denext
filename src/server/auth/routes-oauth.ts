/**
 * The OAuth 2.0 / OIDC half of the endpoints: `GET {basePath}/signin/:provider` starts
 * the Authorization Code + PKCE flow, and `GET {basePath}/callback/:provider` finishes
 * it. All flow state (CSRF `state`, PKCE verifier, OIDC `nonce`, return path) rides the
 * single short-lived, signed `__Host-` transaction cookie, and the callback re-derives
 * the redirect URI byte-for-byte so it matches the authorization request.
 *
 * Both endpoints reach the provider through
 * {@link ./discovery.ts | resolveProviderEndpoints}, so a provider that declares only its
 * `issuer` is resolved from its OIDC discovery document (cached, host-pinned) and one
 * that pins its endpoints never makes that request at all.
 *
 * Failures are *observable*: each one redirects to the sign-in page with a stable
 * `?error=` code, fires the `signInFailed` event, and — where the cause is an exception —
 * hands the exception to `logger.error`. Nothing vanishes silently any more, and nothing
 * leaks the provider's response or the client secret.
 *
 * @module
 */

import { safeRedirectLocation } from "../config.ts";
import {
  DiscoveryError,
  endpointHosts,
  type ProviderEndpoints,
  resolveProviderEndpoints,
} from "./discovery.ts";
import { emitAuthEvent } from "./events.ts";
import {
  exchangeCodeForTokens,
  fetchUserEmails,
  fetchUserInfo,
  makeProviderFetch,
} from "./flow.ts";
import { getJwks } from "./jwks-cache.ts";
import { idTokenKid, verifyIdToken } from "./jwt.ts";
import { buildAuthorizationUrl, generatePkce, randomToken } from "./oauth.ts";
import {
  afterSignIn,
  applySignInCallback,
  type AuthRouteContext,
  callbackUri,
  clearTx,
  findProvider,
  json,
  readTx,
  redirect,
  sameOriginRedirect,
  setTx,
  type Transaction,
} from "./routes-shared.ts";
import { issueAuthSession } from "./session.ts";
import { type AuthUser, isOAuthProvider, type OAuthProvider } from "./types.ts";

/**
 * Refuse a sign-in: emit `signInFailed`, then redirect to the sign-in page carrying a
 * stable `?error=` code. Every refusal in this module goes through here, so an app's
 * event handler sees the same reasons the URL does.
 *
 * @param ctx The route context.
 * @param providerId The provider the attempt targeted, when known.
 * @param reason The stable reason code (`"invalid_state"`, `"config"`, …).
 * @returns The redirect response.
 */
async function refuse(
  ctx: AuthRouteContext,
  providerId: string | undefined,
  reason: string,
): Promise<Response> {
  await emitAuthEvent(ctx.options, "signInFailed", { provider: providerId, reason });
  const signinPage = ctx.config.pages?.signIn || "/";
  return redirect(safeRedirectLocation(`${signinPage}?error=${encodeURIComponent(reason)}`));
}

/**
 * How the endpoints are resolved for this request: through OIDC discovery when the
 * provider names an issuer, with the dev insecure opt-in passed through and a discovery
 * failure that fell back to the provider's pinned URLs reported to the logger.
 *
 * @param ctx The route context.
 * @param provider The OAuth/OIDC provider.
 * @returns The resolved endpoints.
 */
function endpointsFor(ctx: AuthRouteContext, provider: OAuthProvider): Promise<ProviderEndpoints> {
  return resolveProviderEndpoints(provider, {
    allowInsecure: ctx.config.dangerouslyAllowInsecureProviders,
    onDiscoveryError: (error) =>
      ctx.options.logger.warn(
        `denextAuth: OIDC discovery for provider "${provider.id}" failed (${error.code}); ` +
          "falling back to the provider's configured endpoints",
        { provider: provider.id, code: error.code },
      ),
  });
}

/**
 * `GET {basePath}/signin/:provider` — begin the OAuth/OIDC flow: resolve the provider's
 * endpoints, stash PKCE/state/nonce in the transaction cookie, then redirect to the
 * provider.
 *
 * @param ctx The route context (`params.provider` names the provider).
 * @returns A redirect to the provider, a 404 for an unknown one, or a `?error=config` redirect.
 */
export async function handleSignin(ctx: AuthRouteContext): Promise<Response> {
  const provider = findProvider(ctx.config, ctx.params.provider);
  if (!provider || !isOAuthProvider(provider)) {
    return json({ error: "unknown provider" }, 404);
  }
  try {
    const endpoints = await endpointsFor(ctx, provider);
    const pkce = await generatePkce();
    const state = randomToken();
    const nonce = provider.type === "oidc" ? randomToken() : undefined;
    // Coerce the caller-supplied return target to a same-origin path before it rides
    // the transaction cookie (defense in depth; the callback coerces again).
    const rawReturn = ctx.url.searchParams.get("callbackUrl");
    const returnTo = rawReturn
      ? sameOriginRedirect(ctx.config, rawReturn, ctx.config.pages?.afterSignIn || "/")
      : undefined;
    await setTx(ctx, { provider: provider.id, state, verifier: pkce.verifier, nonce, returnTo });

    return redirect(buildAuthorizationUrl({
      authorizationUrl: endpoints.authorizationUrl,
      clientId: provider.clientId,
      redirectUri: callbackUri(ctx, provider.id),
      scope: provider.scopes.join(" "),
      state,
      codeChallenge: pkce.challenge,
      nonce,
      extra: provider.authorizationParams,
    }));
  } catch (error) {
    // A misconfigured provider (a malformed authorizationUrl, an unreachable or
    // untrustworthy discovery document) must not surface as a raw 500 — degrade to the
    // sign-in page with an error, like the callback path, and log what actually happened.
    ctx.options.logger.error(
      `denextAuth: could not start the sign-in flow for provider "${provider.id}"`,
      error,
    );
    return await refuse(ctx, provider.id, "config");
  }
}

/**
 * `GET {basePath}/callback/:provider` — complete the OAuth/OIDC flow: verify the
 * transaction-bound `state`, exchange the code, map the profile, then issue a session.
 * Every failure degrades to the sign-in page with an `?error=` code; none of them leak
 * the provider's response or the client secret.
 *
 * @param ctx The route context.
 * @param provider The OAuth/OIDC provider the callback belongs to.
 * @returns A redirect — to the post-sign-in target, or to the sign-in page with an error.
 */
export async function handleOAuthCallback(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
): Promise<Response> {
  const providerError = ctx.url.searchParams.get("error");
  if (providerError) return await refuse(ctx, provider.id, providerError);

  const tx = await readTx(ctx);
  await clearTx(ctx);
  const code = ctx.url.searchParams.get("code");
  const state = ctx.url.searchParams.get("state");
  if (!tx || tx.provider !== provider.id || !code || !state || tx.state !== state) {
    return await refuse(ctx, provider.id, "invalid_state");
  }

  try {
    const redirectUri = callbackUri(ctx, provider.id);
    const profile = await fetchOAuthProfile(ctx, provider, { code, tx, redirectUri });
    if (!profile.id) throw new Error("provider profile had no id");

    const user = await applySignInCallback(ctx.config, profile, provider.id);
    if (!user) return await refuse(ctx, provider.id, "access_denied");

    await issueAuthSession(ctx.config, user, provider.id);
    await emitAuthEvent(ctx.options, "signIn", { user, provider: provider.id });
    return redirect(afterSignIn(ctx.config, tx.returnTo));
  } catch (error) {
    // A provider round-trip that failed used to vanish here. Log it (the app's logger is
    // silent by default, so this is opt-in), and tell an unresolvable provider apart from
    // a failed exchange so the sign-in page can say something useful.
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" callback failed`,
      error,
    );
    return await refuse(
      ctx,
      provider.id,
      error instanceof DiscoveryError ? "config" : "oauth_failed",
    );
  }
}

/**
 * The networked half of the callback: resolve the endpoints, exchange the code, verify
 * the `id_token` (OIDC), fetch userinfo / the verified-email list, and map it all through
 * `provider.profile`.
 *
 * @param ctx The route context.
 * @param provider The OAuth/OIDC provider.
 * @param params The authorization code, the transaction it belongs to, and the redirect URI.
 * @returns The provider-mapped {@link AuthUser}.
 */
async function fetchOAuthProfile(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
  params: { code: string; tx: Transaction; redirectUri: string },
): Promise<AuthUser> {
  const endpoints = await endpointsFor(ctx, provider);
  // Pin the fetch to the provider's own hosts PLUS whatever discovery resolved — a
  // discovery-only provider configures no URL for `providerHosts` to derive them from.
  const doFetch = makeProviderFetch(
    provider,
    ctx.config.dangerouslyAllowInsecureProviders,
    endpointHosts(endpoints),
  );
  const tokens = await exchangeCodeForTokens(
    provider,
    {
      code: params.code,
      codeVerifier: params.tx.verifier,
      redirectUri: params.redirectUri,
      tokenUrl: endpoints.tokenUrl,
    },
    doFetch,
  );

  const claims = provider.type === "oidc"
    ? await verifyProviderIdToken(provider, endpoints, tokens.id_token, params.tx.nonce, doFetch)
    : undefined;
  // Userinfo is fetched for a plain OAuth provider (which has no id_token to read) and
  // for an OIDC provider that asked for it by configuring `userinfoUrl` — never just
  // because a discovery document happens to advertise a `userinfo_endpoint`, which would
  // add a round-trip to every OIDC login that an `id_token` already answers.
  const wantsUserinfo = provider.type === "oauth" || !!provider.userinfoUrl;
  const userinfo = wantsUserinfo && endpoints.userinfoUrl && tokens.access_token
    ? await fetchUserInfo(endpoints.userinfoUrl, tokens.access_token, doFetch)
    : undefined;
  // OAuth providers (no id_token `email_verified`) may expose a verified-email list —
  // fetch it so the mapper can avoid trusting an unverified `userinfo.email`.
  const emails = provider.userEmailsUrl && tokens.access_token
    ? await fetchUserEmails(provider, tokens.access_token, doFetch)
    : undefined;
  return provider.profile({ tokens, userinfo, claims, emails });
}

/**
 * Verify an OIDC provider's `id_token` against its (cached) JWKS. The token's `kid` is
 * handed to the cache so a key rotation triggers one throttled refetch instead of a
 * refetch per login — and the verification itself is unchanged.
 *
 * @param provider The OIDC provider.
 * @param endpoints Its resolved endpoints (issuer + JWKS URL).
 * @param idToken The `id_token` from the exchange.
 * @param nonce The nonce this login issued.
 * @param doFetch The pinned provider fetch.
 * @returns The verified claims.
 */
async function verifyProviderIdToken(
  provider: OAuthProvider,
  endpoints: ProviderEndpoints,
  idToken: string | undefined,
  nonce: string | undefined,
  doFetch: Parameters<typeof getJwks>[1],
): Promise<Record<string, unknown>> {
  if (!idToken) throw new Error("provider returned no id_token");
  if (!endpoints.issuer || !endpoints.jwksUrl) {
    throw new DiscoveryError(
      "missing_endpoint",
      `auth: provider "${provider.id}" is an OIDC provider without an issuer/JWKS endpoint`,
    );
  }
  const jwks = await getJwks(endpoints.jwksUrl, doFetch, { kid: idTokenKid(idToken) });
  return await verifyIdToken({
    idToken,
    jwks,
    issuer: endpoints.issuer,
    audience: provider.clientId,
    nonce,
    strictAudience: provider.strictAudience,
  }) as Record<string, unknown>;
}
