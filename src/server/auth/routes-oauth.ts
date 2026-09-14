/**
 * The OAuth 2.0 / OIDC half of the endpoints: `GET {basePath}/signin/:provider` starts
 * the Authorization Code + PKCE flow, and `GET {basePath}/callback/:provider` finishes
 * it. All flow state (CSRF `state`, PKCE verifier, OIDC `nonce`, return path) rides the
 * single short-lived, signed `__Host-` transaction cookie, and the callback re-derives
 * the redirect URI byte-for-byte so it matches the authorization request.
 *
 * @module
 */

import { safeRedirectLocation } from "../config.ts";
import {
  exchangeCodeForTokens,
  fetchJwks,
  fetchUserEmails,
  fetchUserInfo,
  makeProviderFetch,
} from "./flow.ts";
import { verifyIdToken } from "./jwt.ts";
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
 * `GET {basePath}/signin/:provider` — begin the OAuth/OIDC flow: stash PKCE/state/nonce
 * in the transaction cookie, then redirect to the provider.
 *
 * @param ctx The route context (`params.provider` names the provider).
 * @returns A redirect to the provider, a 404 for an unknown one, or a `?error=config` redirect.
 */
export async function handleSignin(ctx: AuthRouteContext): Promise<Response> {
  const provider = findProvider(ctx.config, ctx.params.provider);
  if (!provider || !isOAuthProvider(provider)) {
    return json({ error: "unknown provider" }, 404);
  }
  const signinPage = ctx.config.pages?.signIn || "/";
  try {
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
      authorizationUrl: provider.authorizationUrl,
      clientId: provider.clientId,
      redirectUri: callbackUri(ctx, provider.id),
      scope: provider.scopes.join(" "),
      state,
      codeChallenge: pkce.challenge,
      nonce,
      extra: provider.authorizationParams,
    }));
  } catch {
    // A misconfigured provider (e.g. a malformed authorizationUrl) must not surface as
    // a raw 500 — degrade to the sign-in page with an error, like the callback path.
    return redirect(safeRedirectLocation(`${signinPage}?error=config`));
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
  const signinPage = ctx.config.pages?.signIn || "/";
  const error = ctx.url.searchParams.get("error");
  if (error) {
    return redirect(safeRedirectLocation(`${signinPage}?error=${encodeURIComponent(error)}`));
  }

  const tx = await readTx(ctx);
  await clearTx(ctx);
  const code = ctx.url.searchParams.get("code");
  const state = ctx.url.searchParams.get("state");
  if (!tx || tx.provider !== provider.id || !code || !state || tx.state !== state) {
    return redirect(safeRedirectLocation(`${signinPage}?error=invalid_state`));
  }

  try {
    const redirectUri = callbackUri(ctx, provider.id);
    const profile = await fetchOAuthProfile(ctx, provider, { code, tx, redirectUri });
    if (!profile.id) throw new Error("provider profile had no id");

    const user = await applySignInCallback(ctx.config, profile, provider.id);
    if (!user) return redirect(safeRedirectLocation(`${signinPage}?error=access_denied`));

    await issueAuthSession(ctx.config, user, provider.id);
    return redirect(afterSignIn(ctx.config, tx.returnTo));
  } catch {
    return redirect(safeRedirectLocation(`${signinPage}?error=oauth_failed`));
  }
}

/**
 * The networked half of the callback: exchange the code, verify the `id_token` (OIDC),
 * fetch userinfo / the verified-email list, and map it all through `provider.profile`.
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
  const doFetch = makeProviderFetch(provider, ctx.config.dangerouslyAllowInsecureProviders);
  const tokens = await exchangeCodeForTokens(
    provider,
    { code: params.code, codeVerifier: params.tx.verifier, redirectUri: params.redirectUri },
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
      nonce: params.tx.nonce,
    }) as Record<string, unknown>;
  }
  const userinfo = provider.userinfoUrl && tokens.access_token
    ? await fetchUserInfo(provider, tokens.access_token, doFetch)
    : undefined;
  // OAuth providers (no id_token `email_verified`) may expose a verified-email list —
  // fetch it so the mapper can avoid trusting an unverified `userinfo.email`.
  const emails = provider.userEmailsUrl && tokens.access_token
    ? await fetchUserEmails(provider, tokens.access_token, doFetch)
    : undefined;
  return provider.profile({ tokens, userinfo, claims, emails });
}
