/**
 * OAuth for `/auth/v1`: `GET /authorize?provider=…` (`signInWithOAuth`) and
 * `GET /user/identities/authorize` (`linkIdentity`) start the denext OAuth flow of a provider
 * configured in `denextAuth()`, and its callback (the provider's registered
 * `{basePath}/callback/:provider`) is handed back here: the user is resolved by the same
 * account-linking rules a cookie sign-in uses, and the browser lands on `redirect_to` with the
 * session in the fragment (implicit flow) or a one-time `?code=` (PKCE).
 *
 * A flow is bound to the browser that started it by denext's signed, single-use transaction
 * cookie. A PKCE flow may also finish without it (the start was a cross-origin fetch): its
 * state is kept server-side, and nothing — no session, no identity link — takes effect until
 * the client that holds the code verifier exchanges the code, so a stolen or forced callback
 * achieves nothing.
 *
 * @module
 */

import { absoluteUrl } from "../../absolute-url.ts";
import type { AdapterUser } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { nativeAdapterOf } from "../native.ts";
import { buildAuthorizationUrl, generatePkce, randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { signinStartLimiter } from "../rate-limit.ts";
import { isSsoUser } from "../sso-user.ts";
import {
  accountFromTokens,
  endpointsFor,
  extraParams,
  fetchOAuthProfile,
  resolveSessionUser,
} from "../routes-oauth.ts";
import {
  applySignInCallback,
  type AuthRouteContext,
  callbackUri,
  clearTx,
  findProvider,
  readTx,
  setTx,
  type Transaction,
} from "../routes-shared.ts";
import { isOAuthProvider, type OAuthProvider } from "../types.ts";
import { linkIdentity as storeIdentity } from "./accounts.ts";
import { isStoredProvider, storedProvider } from "./custom-providers.ts";
import {
  GOTRUE_PREFIX,
  type GoTrueContext,
  nowSeconds,
  ok,
  redirectTarget,
  requireAal2WithFactor,
  requireUser,
  spendIp,
} from "./context.ts";
import { GoTrueError } from "./errors.ts";
import { createFlowCode, readChallenge } from "./pkce.ts";
import { type SessionContext, startSession } from "./session.ts";

/** How long a server-side OAuth state lives, seconds (the transaction cookie's lifetime). */
const STATE_TTL = 600;

function routeContext(ctx: GoTrueContext, providerId: string): AuthRouteContext {
  return {
    request: ctx.request,
    config: ctx.config,
    options: resolveAuthOptions(ctx.config),
    url: ctx.url,
    method: ctx.method,
    params: { provider: providerId },
  };
}

function stateHash(state: string): Promise<string> {
  return sha256Hex(`gotrue-oauth:${state}`);
}

/**
 * Where the provider sends the browser back: denext's `{basePath}/callback/:provider` for a
 * configured provider, `/auth/v1/callback` (GoTrue's own) for a stored one.
 */
function redirectUriFor(route: AuthRouteContext, provider: OAuthProvider): string {
  return isStoredProvider(provider)
    ? absoluteUrl(route.request, `${GOTRUE_PREFIX}/callback`, {
      canonicalOrigin: route.config.canonicalOrigin,
    })
    : callbackUri(route, provider.id);
}

/** A configured OAuth provider, or a stored `custom:` one. */
async function oauthProviderOf(
  ctx: GoTrueContext,
  providerId: string,
): Promise<OAuthProvider | undefined> {
  const configured = findProvider(ctx.config, providerId);
  if (configured) return isOAuthProvider(configured) ? configured : undefined;
  return providerId.startsWith("custom:") ? await storedProvider(ctx, providerId) : undefined;
}

/** Start a provider round-trip for `/authorize` or a link. */
async function start(
  ctx: GoTrueContext,
  linkUserId: string | undefined,
): Promise<{ url: string }> {
  await spendIp(ctx, signinStartLimiter(ctx.config), "authorize");
  const params = ctx.url.searchParams;
  const providerId = params.get("provider") ?? "";
  const provider = await oauthProviderOf(ctx, providerId);
  if (!provider) {
    throw new GoTrueError(
      400,
      "validation_failed",
      "Unsupported provider: provider is not enabled",
    );
  }
  const redirectTo = redirectTarget(ctx, params.get("redirect_to"));
  const challenge = readChallenge(
    params.get("code_challenge"),
    params.get("code_challenge_method"),
  );
  const route = routeContext(ctx, provider.id);
  const endpoints = await endpointsFor(route, provider);
  const pkce = await generatePkce();
  // A stored provider's callback is the shared `/auth/v1/callback`: its state names it.
  const state = isStoredProvider(provider)
    ? `${provider.id.slice("custom:".length)}.${randomToken()}`
    : randomToken();
  const nonce = provider.type === "oidc" ? randomToken() : undefined;
  const tx: Transaction = {
    provider: provider.id,
    state,
    verifier: pkce.verifier,
    ...(nonce ? { nonce } : {}),
    gotrue: {
      redirectTo,
      ...(challenge ? { challenge } : {}),
      ...(linkUserId ? { linkUserId } : {}),
    },
  };
  const formPost = provider.responseMode === "form_post";
  await setTx(route, tx, { crossSite: formPost });
  if (challenge) {
    await nativeAdapterOf(ctx.adapter)?.createNativeGrant({
      hash: await stateHash(state),
      kind: "nonce",
      expiresAt: nowSeconds() + STATE_TTL,
      data: JSON.stringify(tx),
    });
  }
  const extraScopes = (params.get("scopes") ?? "").split(/[\s,]+/).filter(Boolean);
  const scopes = [...new Set([...provider.scopes, ...extraScopes])];
  return {
    url: buildAuthorizationUrl({
      authorizationUrl: endpoints.authorizationUrl,
      clientId: provider.clientId,
      redirectUri: redirectUriFor(route, provider),
      scope: scopes.join(" "),
      state,
      codeChallenge: pkce.challenge,
      nonce,
      extra: provider.authorizationParams,
      responseMode: formPost ? "form_post" : undefined,
    }),
  };
}

/** `GET /authorize?provider=…&redirect_to=…[&code_challenge=…]`. */
export async function authorize(ctx: GoTrueContext): Promise<Response> {
  const { url } = await start(ctx, undefined);
  if (ctx.url.searchParams.get("skip_http_redirect") === "true") return ok({ url });
  return new Response(null, {
    status: 302,
    headers: { location: url, "cache-control": "no-store" },
  });
}

/** `GET /user/identities/authorize?provider=…` (`linkIdentity`). */
export async function authorizeLink(ctx: GoTrueContext): Promise<Response> {
  if (ctx.options.manualLinking === false) {
    throw new GoTrueError(404, "manual_linking_disabled", "Manual linking is disabled");
  }
  const caller = await requireUser(ctx);
  // Linking a sign-in method changes what can reach the account: not from a password alone.
  await requireAal2WithFactor(ctx, caller, "link an identity");
  // An SSO user gains another sign-in method only from a session its identity provider started.
  if (isSsoUser(caller.user) && !ssoAuthenticated(caller.claims)) {
    throw new GoTrueError(
      422,
      "user_sso_managed",
      "Linking an identity to a SSO account is only possible from a SSO session",
    );
  }
  const { url } = await start(ctx, caller.user.id);
  if (ctx.url.searchParams.get("skip_http_redirect") === "false") {
    return new Response(null, { status: 302, headers: { location: url } });
  }
  return ok({ url });
}

/** Whether an access token's session was started by an SSO sign-in (an `sso/saml` `amr` entry). */
function ssoAuthenticated(claims: Record<string, unknown>): boolean {
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  return amr.some((entry) => (entry as { method?: unknown })?.method === "sso/saml");
}

/** What the `/auth/v1` callback needs that the request does not carry. */
export interface GoTrueCallbackDeps {
  /** Build the session context for the request. */
  session: (request: Request, config: AuthRouteContext["config"]) => SessionContext;
}

function appendParams(target: string, params: Record<string, string>, fragment: boolean): string {
  const query = new URLSearchParams(params).toString();
  if (fragment) return `${target.split("#")[0]}#${query}`;
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function land(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function refuse(target: string, pkce: boolean, code: string, description: string): Response {
  return land(appendParams(target, {
    error: code === "access_denied" ? "access_denied" : "server_error",
    error_code: code,
    error_description: description,
  }, !pkce));
}

/** The GoTrue flow a callback belongs to, or `null` for a denext cookie sign-in. */
async function flowOf(
  ctx: AuthRouteContext,
  provider: OAuthProvider,
  state: string | null,
): Promise<Transaction | null | "forged"> {
  const cookie = await readTx(ctx);
  const grants = nativeAdapterOf(ctx.config.adapter);
  const stored = state && grants
    ? await grants.useNativeGrant(await stateHash(state), "nonce")
    : undefined;
  if (cookie?.gotrue) {
    await clearTx(ctx);
    return cookie.provider === provider.id && cookie.state === state ? cookie : "forged";
  }
  if (!stored?.data) return null;
  let tx: Transaction;
  try {
    tx = JSON.parse(stored.data) as Transaction;
  } catch {
    return "forged";
  }
  // Without the cookie, only a PKCE flow may finish: its effect waits for the verifier.
  if (
    !tx.gotrue?.challenge || tx.provider !== provider.id || tx.state !== state ||
    stored.expiresAt <= nowSeconds()
  ) {
    return "forged";
  }
  return tx;
}

/**
 * The callback for an `/auth/v1` OAuth flow (registered with denext's OAuth callback).
 *
 * @param deps The session context factory.
 * @returns The callback hook.
 */
export function gotrueOAuthCallback(deps: GoTrueCallbackDeps) {
  return async (
    ctx: AuthRouteContext,
    provider: OAuthProvider,
    params: URLSearchParams,
  ): Promise<Response | null> => {
    const flow = await flowOf(ctx, provider, params.get("state"));
    if (flow === null) return null;
    const fallback = ctx.config.canonicalOrigin ??
      new URL(absoluteUrl(ctx.request, "/", { canonicalOrigin: ctx.config.canonicalOrigin }))
        .origin;
    if (flow === "forged") {
      return refuse(fallback, false, "bad_oauth_state", "OAuth callback with invalid state");
    }
    const target = flow.gotrue!.redirectTo;
    const pkce = !!flow.gotrue!.challenge;
    const providerError = params.get("error");
    if (providerError) {
      const code = /^[a-z_]{1,64}$/.test(providerError) ? providerError : "server_error";
      return refuse(
        target,
        pkce,
        code === "access_denied" ? "access_denied" : "bad_oauth_callback",
        "Error getting user profile from external provider",
      );
    }
    const code = params.get("code");
    if (!code) {
      return refuse(
        target,
        pkce,
        "bad_oauth_callback",
        "OAuth callback with missing authorization code",
      );
    }
    try {
      const callbackParams = provider.responseMode === "form_post"
        ? extraParams(params)
        : undefined;
      const result = await fetchOAuthProfile(ctx, provider, {
        code,
        tx: flow,
        redirectUri: redirectUriFor(ctx, provider),
        callbackParams,
      });
      if (!result.profile.id) throw new Error("provider profile had no id");
      return await finish(ctx, deps, provider, flow, result);
    } catch (error) {
      if (error instanceof GoTrueError) return refuse(target, pkce, error.code, error.message);
      resolveAuthOptions(ctx.config).logger.error(
        `/auth/v1: the "${provider.id}" callback failed`,
        error,
      );
      return refuse(
        target,
        pkce,
        "bad_oauth_callback",
        "Error getting user profile from external provider",
      );
    }
  };
}

function identityData(
  result: Awaited<ReturnType<typeof fetchOAuthProfile>>,
): Record<string, unknown> {
  const { profile } = result;
  return {
    sub: profile.id,
    provider_id: profile.id,
    ...(profile.email ? { email: profile.email } : {}),
    email_verified: profile.emailVerified === true,
    ...(profile.name ? { name: profile.name, full_name: profile.name } : {}),
    ...(profile.image ? { avatar_url: profile.image, picture: profile.image } : {}),
  };
}

async function finish(
  ctx: AuthRouteContext,
  deps: GoTrueCallbackDeps,
  provider: OAuthProvider,
  flow: Transaction,
  result: Awaited<ReturnType<typeof fetchOAuthProfile>>,
): Promise<Response> {
  const gotrue = flow.gotrue!;
  const gctx = {
    config: ctx.config,
    adapter: ctx.config.adapter!,
    request: ctx.request,
    url: ctx.url,
  } as GoTrueContext;
  const link = {
    provider: provider.id,
    providerAccountId: result.profile.id,
    identityData: identityData(result),
    type: provider.type,
    ...(result.profile.email ? { email: result.profile.email } : {}),
  };
  const user = gotrue.linkUserId
    ? await linkTarget(gctx, gotrue.linkUserId, link, !gotrue.challenge)
    : await signInUser(ctx, gctx, provider, result, link);
  const amr = { method: "oauth", timestamp: nowSeconds(), provider: provider.id };
  const providerTokens = {
    ...(typeof result.tokens.access_token === "string"
      ? { provider_token: result.tokens.access_token }
      : {}),
    ...(typeof result.tokens.refresh_token === "string"
      ? { provider_refresh_token: result.tokens.refresh_token }
      : {}),
  };
  if (gotrue.challenge) {
    const code = await createFlowCode(gctx, gotrue.challenge, {
      userId: user.id,
      amr,
      providerToken: providerTokens.provider_token,
      providerRefreshToken: providerTokens.provider_refresh_token,
      ...(gotrue.linkUserId ? { link } : {}),
    });
    return land(appendParams(gotrue.redirectTo, { code }, false));
  }
  const tokens = await startSession(deps.session(ctx.request, ctx.config), user, amr);
  return land(appendParams(gotrue.redirectTo, {
    access_token: tokens.access_token,
    expires_at: String(tokens.expires_at),
    expires_in: String(tokens.expires_in),
    ...providerTokens,
    refresh_token: tokens.refresh_token,
    token_type: "bearer",
  }, true));
}

type IdentityLink = Parameters<typeof storeIdentity>[2];

/** `linkIdentity`: the signed-in user the identity joins (linked now, unless PKCE defers it). */
async function linkTarget(
  gctx: GoTrueContext,
  userId: string,
  link: IdentityLink,
  now: boolean,
): Promise<AdapterUser> {
  const owner = await gctx.adapter.getUserByAccount(link);
  if (owner && owner.id !== userId) {
    throw new GoTrueError(
      422,
      "identity_already_exists",
      "Identity is already linked to another user",
    );
  }
  const user = await gctx.adapter.getUser(userId);
  if (!user) throw new GoTrueError(404, "user_not_found", "User not found");
  if (now) await storeIdentity(gctx, user, link);
  return user;
}

/** A sign-in: denext's account-linking rules decide the user; the identity row is refreshed. */
async function signInUser(
  ctx: AuthRouteContext,
  gctx: GoTrueContext,
  provider: OAuthProvider,
  result: Awaited<ReturnType<typeof fetchOAuthProfile>>,
  link: IdentityLink,
): Promise<AdapterUser> {
  const account = accountFromTokens(ctx, provider, result.profile, result.tokens);
  const resolved = await resolveSessionUser(ctx, provider, result.profile, account);
  if (!resolved) {
    throw new GoTrueError(
      422,
      "email_exists",
      "A user with this email address has already been registered",
    );
  }
  const allowed = await applySignInCallback(ctx.config, resolved.user, provider.id);
  if (!allowed) throw new GoTrueError(403, "provider_disabled", "Sign in denied");
  const user = await gctx.adapter.getUser(resolved.user.id);
  if (!user) throw new GoTrueError(404, "user_not_found", "User not found");
  await storeIdentity(gctx, user, link);
  const providers = new Set(
    Array.isArray(user.appMetadata?.providers) ? user.appMetadata!.providers as string[] : [],
  );
  providers.add(provider.id);
  return await gctx.adapter.updateUser({
    id: user.id,
    appMetadata: {
      ...(user.appMetadata ?? {}),
      provider: user.appMetadata?.provider ?? provider.id,
      providers: [...providers],
    },
    userMetadata: { ...link.identityData, ...(user.userMetadata ?? {}) },
    updatedAt: nowSeconds(),
  });
}

/**
 * `GET /callback` — a stored (`custom:`) provider's redirect back: the state names the provider,
 * and the flow finishes exactly as a configured provider's does.
 *
 * @param ctx The context.
 * @returns The redirect to `redirect_to` (tokens, a code, or an error).
 */
export async function storedProviderCallback(ctx: GoTrueContext): Promise<Response> {
  const params = ctx.url.searchParams;
  const name = (params.get("state") ?? "").split(".")[0];
  const provider = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)
    ? await storedProvider(ctx, `custom:${name}`)
    : undefined;
  const handled = provider
    ? await gotrueOAuthCallback({ session: () => ctx.session })(
      routeContext(ctx, provider.id),
      provider,
      params,
    )
    : null;
  return handled ??
    refuse(ctx.siteUrl, false, "bad_oauth_state", "OAuth callback with invalid state");
}
