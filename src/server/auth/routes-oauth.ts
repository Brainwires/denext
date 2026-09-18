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
 * Between the provider round-trip and `callbacks.signIn` sits the persistence step: with
 * an {@link ./adapter.ts | AuthAdapter} configured, the profile is resolved (or created,
 * or linked) through {@link ./adapter-link.ts | resolveSignInUser}, the provider tokens
 * are written onto the account row, and the session then carries the **adapter's** user
 * id and roles. With no adapter that step is a pass-through and nothing is persisted —
 * byte-for-byte the flow denext shipped before 2.5.
 *
 * Failures are *observable*: each one redirects to the sign-in page with a stable
 * `?error=` code, fires the `signInFailed` event, and — where the cause is an exception —
 * hands the exception to `logger.error`. Nothing vanishes silently any more, and nothing
 * leaks the provider's response or the client secret.
 *
 * @module
 */

import { safeRedirectLocation } from "../config.ts";
import { accountNotLinkedCode, type ResolvedSignIn, resolveSignInUser } from "./adapter-link.ts";
import type { AdapterAccount } from "./adapter.ts";
import {
  DiscoveryError,
  endpointHosts,
  type ProviderEndpoints,
  resolveProviderEndpoints,
} from "./discovery.ts";
import { emailKey } from "./email-key.ts";
import { emitAuthEvent } from "./events.ts";
import {
  exchangeCodeForTokens,
  fetchUserEmails,
  fetchUserInfo,
  makeProviderFetch,
  type TokenResponse,
} from "./flow.ts";
import { getJwks } from "./jwks-cache.ts";
import { idTokenKid, isStrictAudienceError, verifyIdToken } from "./jwt.ts";
import { buildAuthorizationUrl, generatePkce, randomToken } from "./oauth.ts";
import {
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
import { finishSignIn } from "./sign-in-tail.ts";
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
 * A provider's `?error=` as a reason code. Anyone can craft a callback URL, so only a
 * protocol-shaped code (`access_denied`, `login_required`) reaches the sign-in page's
 * `?error=` and `signInFailed.reason`; free text reads `"oauth_failed"` and is logged.
 *
 * @param ctx The route context.
 * @param providerId The provider the callback is for.
 * @param raw The `error` query parameter as received.
 * @returns The reason code to report.
 */
function providerErrorCode(ctx: AuthRouteContext, providerId: string, raw: string): string {
  if (/^[a-z_]{1,64}$/.test(raw)) return raw;
  ctx.options.logger.warn(`denextAuth: provider "${providerId}" returned an unrecognised error`, {
    provider: providerId,
    error: raw.slice(0, 200),
  });
  return "oauth_failed";
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
 * transaction-bound `state`, exchange the code, map the profile, resolve it through the
 * adapter (when one is configured), then issue a session. Every failure degrades to the
 * sign-in page with an `?error=` code — a refused account link included, which answers
 * `?error=account_not_linked` rather than a `500`; none of them leak the provider's
 * response or the client secret.
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
  if (providerError) {
    return await refuse(ctx, provider.id, providerErrorCode(ctx, provider.id, providerError));
  }

  const tx = await readTx(ctx);
  await clearTx(ctx);
  const code = ctx.url.searchParams.get("code");
  const state = ctx.url.searchParams.get("state");
  if (!tx || tx.provider !== provider.id || !code || !state || tx.state !== state) {
    return await refuse(ctx, provider.id, "invalid_state");
  }

  try {
    const redirectUri = callbackUri(ctx, provider.id);
    const result = await fetchOAuthProfile(ctx, provider, { code, tx, redirectUri });
    if (!result.profile.id) throw new Error("provider profile had no id");
    return await completeSignIn(ctx, provider, result, tx.returnTo);
  } catch (error) {
    // A provider round-trip that failed used to vanish here. Log it (the app's logger is
    // silent by default, so this is opt-in), and tell an unresolvable provider apart from
    // a failed exchange so the sign-in page can say something useful.
    ctx.options.logger.error(
      `denextAuth: the "${provider.id}" callback failed`,
      error,
    );
    warnOnStrictAudience(provider.id, error);
    return await refuse(
      ctx,
      provider.id,
      error instanceof DiscoveryError ? "config" : "oauth_failed",
    );
  }
}

/** Whether the strict-audience escape hatch has already been named this process. */
let warnedStrictAudience = false;

/**
 * A strict-audience refusal reaches the user as a bare `?error=oauth_failed`, and the
 * app's `logger` is a no-op unless one was configured — so the one class of failure whose
 * fix is a single documented flag used to be invisible. Name it on the console, once.
 *
 * @param providerId The provider whose `id_token` was refused.
 * @param error Whatever the callback threw.
 */
function warnOnStrictAudience(providerId: string, error: unknown): void {
  if (warnedStrictAudience || !isStrictAudienceError(error)) return;
  warnedStrictAudience = true;
  console.warn(
    `denextAuth: the "${providerId}" provider's id_token was refused by the strict audience ` +
      `check (${(error as Error).message}). That is OIDC Core §3.1.3.7 done properly; if this ` +
      "provider legitimately mints multi-audience tokens without `azp`, set " +
      `\`strictAudience: false\` on the ${providerId} provider to fall back to the ` +
      "membership check.",
  );
}

/**
 * The tail of a completed provider round-trip: resolve (or create) the user the sign-in
 * belongs to, run the app's `signIn` callback, issue the session, and announce it. Split
 * out of {@linkcode handleOAuthCallback} so that callback stays a readable sequence of
 * gates — and so the persistence step has one home.
 *
 * @param ctx The route context.
 * @param provider The provider that authenticated the profile.
 * @param result The mapped profile and the tokens it arrived with.
 * @param returnTo The already-coerced same-origin path the transaction asked to return to.
 * @returns A redirect — to the post-sign-in target, or to the sign-in page with an error.
 */
async function completeSignIn(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
  result: OAuthProfileResult,
  returnTo: string | undefined,
): Promise<Response> {
  const account = accountFromTokens(ctx, provider, result.profile, result.tokens);
  const resolved = await resolveSessionUser(ctx, provider, result.profile, account);
  if (!resolved) return await refuse(ctx, provider.id, "account_not_linked");

  const user = await applySignInCallback(ctx.config, resolved.user, provider.id);
  if (!user) return await refuse(ctx, provider.id, "access_denied");

  return await finishSignIn(ctx, user, provider.id, {
    isNewUser: resolved.isNewUser,
    returnTo,
    amr: ["ext"],
    json: false,
  });
}

/**
 * The two fields the account-linking rules read off a provider: its id, and whether it
 * opted into linking on an **unverified** address. A Credentials provider has no such
 * flag, so {@linkcode resolveSessionUser} takes this narrow view of a provider and the
 * credentials route passes itself straight in.
 */
export type LinkingProvider = Pick<OAuthProvider, "id" | "allowDangerousEmailAccountLinking">;

/**
 * Resolve the user a sign-in should become through the configured adapter — reusing the
 * user the account is already linked to, linking it to a matching local identity, or
 * creating both records — and turn the one refusal those rules can raise into a value
 * instead of an exception.
 *
 * With **no adapter** this is a pass-through: `profile` comes straight back, so an app
 * written for 2.4 keeps issuing sessions carrying the provider's own id, and no token is
 * persisted anywhere.
 *
 * Both sign-in routes share this, and each answers a refusal in its own currency: the
 * OAuth callback redirects with `?error=account_not_linked`, while the credentials POST
 * keeps its GENERIC 401 — answering "that address exists, under another provider" there
 * would be exactly the user-enumeration oracle that endpoint is built not to be.
 *
 * @param ctx The route context (its options carry the adapter, the events and the logger).
 * @param provider The provider that authenticated the user.
 * @param profile The provider-mapped (or credentials-authorized) user.
 * @param account The account row this sign-in links, minus the `userId` it resolves.
 * @returns The user to issue a session for (and whether this sign-in created the adapter
 * record — the `signIn` event's `isNewUser`), or `undefined` when linking was refused.
 */
export async function resolveSessionUser(
  ctx: AuthRouteContext,
  provider: LinkingProvider,
  profile: AuthUser,
  account: Omit<AdapterAccount, "userId">,
): Promise<ResolvedSignIn | undefined> {
  try {
    // The linking rules read only the two fields `LinkingProvider` names, which is what
    // lets the credentials route — whose provider has neither concept — share them.
    return await resolveSignInUser(
      ctx.options,
      provider as OAuthProvider,
      keyedProfile(ctx, profile),
      account,
    );
  } catch (error) {
    if (!accountNotLinkedCode(error)) throw error;
    ctx.options.logger.error(
      `denextAuth: refused to link the "${provider.id}" sign-in to an existing account`,
      error,
    );
    return undefined;
  }
}

/**
 * `profile` with its email in the one spelling the adapters key on ({@link emailKey}), so
 * the match-by-email step finds the record a credentials sign-up or a magic link made for
 * `a@bücher.de` / `a@xn--bcher-kva.de` — through a custom adapter as much as a bundled
 * one — and a record this sign-in creates is keyed the way the emailed flows key theirs.
 * Without an adapter the profile IS the session user and passes through untouched.
 */
function keyedProfile(ctx: AuthRouteContext, profile: AuthUser): AuthUser {
  if (!ctx.options.adapter || typeof profile.email !== "string") return profile;
  const email = emailKey(profile.email);
  return email === profile.email ? profile : { ...profile, email };
}

/**
 * The account row this sign-in links. The token fields are attached **only when an
 * adapter is configured**: persisting them is what an adapter is for, and without one
 * there is nowhere to put them — a provider's refresh token then never outlives the
 * request it arrived on.
 *
 * @param ctx The route context (its resolved options say whether an adapter exists).
 * @param provider The provider that authenticated the profile.
 * @param profile The provider-mapped user — its `id` IS the provider-side account id.
 * @param tokens The token endpoint's response.
 * @returns The account to link, minus the `userId` the linking rules decide.
 */
function accountFromTokens(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
  profile: AuthUser,
  tokens: TokenResponse,
): Omit<AdapterAccount, "userId"> {
  const account: Omit<AdapterAccount, "userId"> = {
    provider: provider.id,
    providerAccountId: profile.id,
    type: provider.type,
  };
  if (!ctx.options.adapter) return account;
  return {
    ...account,
    ...withoutUndefined({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      tokenType: tokens.token_type,
      scope: typeof tokens.scope === "string" ? tokens.scope : undefined,
      expiresAt: expiryAt(tokens.expires_in),
    }),
  };
}

/** The entries whose value is defined — an absent token is never stored as `undefined`. */
function withoutUndefined<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * When an access token expires, absolute, from the relative `expires_in` a provider
 * returned.
 *
 * @param expiresIn Seconds until expiry, when the provider said.
 * @returns Epoch seconds, or `undefined` when it didn't say (or said something unusable).
 */
function expiryAt(expiresIn: number | undefined): number | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return undefined;
  return Math.floor(Date.now() / 1000) + Math.floor(expiresIn);
}

/** What one provider round-trip produced. */
interface OAuthProfileResult {
  /** The provider-mapped session user. */
  profile: AuthUser;
  /** The token endpoint's response — what an adapter persists on the account row. */
  tokens: TokenResponse;
}

/**
 * The networked half of the callback: resolve the endpoints, exchange the code, verify
 * the `id_token` (OIDC), fetch userinfo / the verified-email list, and map it all through
 * `provider.profile`.
 *
 * @param ctx The route context.
 * @param provider The OAuth/OIDC provider.
 * @param params The authorization code, the transaction it belongs to, and the redirect URI.
 * @returns The provider-mapped {@link AuthUser} and the tokens it was mapped from.
 */
async function fetchOAuthProfile(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
  params: { code: string; tx: Transaction; redirectUri: string },
): Promise<OAuthProfileResult> {
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
  return { profile: provider.profile({ tokens, userinfo, claims, emails }), tokens };
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
