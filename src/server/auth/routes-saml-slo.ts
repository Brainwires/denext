/**
 * SAML 2.0 Single Logout on denextAuth's own endpoints, for a `saml()` provider with an
 * `sp.signingKey` (the key signs the LogoutRequest and the LogoutResponse; the SP metadata then
 * lists `{basePath}/saml/:id/slo` as its SingleLogoutService):
 *
 * - **SP-initiated.** `POST {basePath}/signout` for a session that provider started ends the
 *   session at once (as always), then sends the browser to the IdP's SingleLogoutService with a
 *   signed LogoutRequest (HTTP-Redirect, RSA-SHA256) for the session's NameID and SessionIndex —
 *   a `303`, or `{ ok: true, url }` for a JSON caller. The request's ID and a fresh RelayState
 *   ride the signed, single-use transaction cookie. The IdP's LogoutResponse comes back to
 *   `{basePath}/saml/:id/slo`, must answer that request (`InResponseTo`, the RelayState) and lands
 *   on the sign-out target — with `?error=saml_logout_failed` when the IdP reports a partial
 *   logout or the response can't be verified (the local session is gone either way).
 * - **IdP-initiated.** `{basePath}/saml/:id/slo` receives a LogoutRequest (HTTP-Redirect query
 *   signature, or HTTP-POST XML signature) from that provider's IdP, ends the sessions its NameID
 *   (and SessionIndexes) started, and answers a signed LogoutResponse to the IdP's
 *   SingleLogoutService (or `200` when it has none).
 *
 * Which sessions end: with a `sessionStore` and an adapter that keeps the SSO session group, a
 * SAML sign-in recorded its session (`saml-sessions.ts`), and exactly the named ones are deleted.
 * With stateless cookie sessions and an adapter that keeps the session index, a SAML sign-in
 * recorded its session's `sid` (`saml-revocation.ts`), and exactly the named `sid`s go on the
 * adapter's revocation list: those the SessionIndexes started, or with no SessionIndex every
 * session of that NameID. A target the index can't resolve (a cookie from before `sid`s, a pruned
 * row), or an adapter without the index, fails closed: every
 * session of the user that NameID is linked to, signed in before now, is ended
 * (`sessionsValidAfter`). The caller's own cookie is cleared too when it is one of them.
 *
 * Every message is checked by the same primitives `/auth/v1` uses (`saml/logout.ts`): signed,
 * Destination this SP's SLO URL, Issuer the configured IdP, fresh, InResponseTo, and its ID claimed
 * once in the shared replay cache.
 *
 * @module
 */

import {
  buildLogoutRequest,
  buildLogoutResponse,
  type PeekedLogoutMessage,
  peekLogoutMessage,
  type SamlBindingInput,
  type SamlSpConfig,
  verifyLogoutRequest,
  verifyLogoutResponse,
} from "./saml/mod.ts";
import { replayCacheOf, type SsoProvider } from "./gotrue/sso-providers.ts";
import { randomToken } from "./oauth.ts";
import {
  afterSignOut,
  type AuthRoute,
  type AuthRouteContext,
  clearTx,
  findProvider,
  readTx,
  redirect,
  setTx,
} from "./routes-shared.ts";
import { readForm, SLO_TX, spFor, ssoProviderOf } from "./routes-saml.ts";
import { COOKIE_SESSION_PREFIX, samlSessionStoreOf } from "./saml-sessions.ts";
import { cookieRevocationOf, revokeCookieSessions } from "./saml-revocation.ts";
import { clearAuthSession, endUserSessions, readAuthSession } from "./session.ts";
import { safeRedirectLocation } from "../config.ts";
import { type AuthSession, isSamlProvider, type SamlProvider } from "./types.ts";

/** A provider with Single Logout on, resolved for one request. */
interface SloProvider {
  provider: SamlProvider;
  sso: SsoProvider;
  sp: SamlSpConfig;
}

/** The provider when it has Single Logout on (a signing key), else `null`. */
async function sloProvider(
  ctx: AuthRouteContext,
  id: string | undefined,
): Promise<SloProvider | null> {
  const provider = id === undefined ? undefined : findProvider(ctx.config, id);
  if (!provider || !isSamlProvider(provider) || !provider.sp?.signingKey) return null;
  if (!ctx.options.adapter) return null;
  return { provider, sso: ssoProviderOf(ctx, provider), sp: await spFor(ctx, provider) };
}

/**
 * The IdP URL that carries a signed LogoutRequest for a session that just ended, after recording
 * the pending logout in the transaction cookie — or `undefined` when the session is not a SAML
 * one, its provider has no Single Logout, or the IdP has no SingleLogoutService. Never throws:
 * the local sign-out stands alone.
 *
 * @param ctx The route context.
 * @param ended The session that was signed out (`null` when there was none).
 * @param returnTo Where the IdP's LogoutResponse should land (same-origin).
 * @returns The URL, or `undefined`.
 */
export async function samlLogoutUrl(
  ctx: AuthRouteContext,
  ended: AuthSession | null,
  returnTo: string,
): Promise<string | undefined> {
  if (!ended?.saml) return undefined;
  try {
    const slo = await sloProvider(ctx, ended.provider);
    if (!slo?.sso.idp.sloUrl) return undefined;
    const relayState = randomToken(24);
    const { id, url } = await buildLogoutRequest({
      sp: slo.sp,
      idp: slo.sso.idp,
      nameId: ended.saml.nameId,
      ...(ended.saml.nameIdFormat !== undefined && { nameIdFormat: ended.saml.nameIdFormat }),
      ...(ended.saml.sessionIndex !== undefined && { sessionIndex: ended.saml.sessionIndex }),
      relayState,
    });
    await setTx(ctx, {
      provider: slo.provider.id,
      state: relayState,
      verifier: SLO_TX,
      nonce: id,
      returnTo,
    }, { crossSite: true });
    return url;
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: could not start SAML Single Logout for provider "${ended.provider}"`,
      error,
    );
    return undefined;
  }
}

/** The sign-out target with an `?error=` code. */
function landWithError(ctx: AuthRouteContext, target: string, code: string): Response {
  const url = new URL(target, ctx.url);
  url.searchParams.set("error", code);
  return redirect(
    safeRedirectLocation(url.origin === ctx.url.origin ? url.pathname + url.search : url.href),
  );
}

function refused(ctx: AuthRouteContext, what: string, providerId: string, error: unknown): void {
  ctx.options.logger.warn(`denextAuth: a SAML ${what} was refused`, {
    provider: providerId,
    code: (error as { code?: string }).code,
  });
}

/** The IdP's LogoutResponse to an SP-initiated logout: check it against the transaction, land. */
async function finishSpLogout(
  ctx: AuthRouteContext,
  slo: SloProvider,
  input: SamlBindingInput,
  peeked: PeekedLogoutMessage,
): Promise<Response> {
  const tx = await readTx(ctx);
  await clearTx(ctx);
  const target = tx?.returnTo ?? afterSignOut(ctx.config);
  if (
    !tx || tx.provider !== slo.provider.id || tx.verifier !== SLO_TX || !tx.nonce ||
    !peeked.relayState || tx.state !== peeked.relayState
  ) {
    return landWithError(ctx, afterSignOut(ctx.config), "saml_logout_failed");
  }
  try {
    const result = await verifyLogoutResponse({
      input,
      idp: slo.sso.idp,
      sp: slo.sp,
      replayCache: replayCacheOf({ adapter: ctx.options.adapter! }, "logout"),
      expectedInResponseTo: tx.nonce,
    });
    return result.success ? redirect(target) : landWithError(ctx, target, "saml_logout_failed");
  } catch (error) {
    refused(ctx, "LogoutResponse", slo.provider.id, error);
    return landWithError(ctx, target, "saml_logout_failed");
  }
}

/** Who a LogoutRequest ended: the user, and the cookie `sid`s when it named them exactly. */
interface EndedSessions {
  userId: string;
  sids?: string[];
}

/**
 * End the sessions a NameID started at `providerId`: the recorded ones its SessionIndexes name
 * (store-backed), the indexed cookie `sid`s they name (stateless), else every session of the
 * linked user signed in before now.
 */
async function endSamlSessions(
  ctx: AuthRouteContext,
  providerId: string,
  nameId: string,
  sessionIndexes: string[],
): Promise<EndedSessions | null> {
  const adapter = ctx.options.adapter!;
  const user = await adapter.getUserByAccount({
    provider: `sso:${providerId}`,
    providerAccountId: nameId,
  });
  if (!user) return null;
  if (await endStoredSessions(ctx, providerId, nameId, user.id, sessionIndexes)) {
    return { userId: user.id };
  }
  if (ctx.options.revocableCookies) {
    const sids = await revokedCookieSids(ctx, providerId, nameId, sessionIndexes);
    if (sids) return { userId: user.id, sids };
  }
  await endUserSessions(adapter, user.id);
  return { userId: user.id };
}

/**
 * Delete the store-backed sessions of `userId` that a NameID's recorded SAML sign-ins started and
 * the SessionIndexes name (all of them with none): `false` when there is no store or no record.
 */
async function endStoredSessions(
  ctx: AuthRouteContext,
  providerId: string,
  nameId: string,
  userId: string,
  sessionIndexes: string[],
): Promise<boolean> {
  const records = samlSessionStoreOf(ctx.options.adapter);
  const sessions = ctx.options.sessionStore;
  if (!records || !sessions) return false;
  const mine = (await records.listSsoSessions(providerId, nameId)).filter((r) =>
    r.sessionId.startsWith(COOKIE_SESSION_PREFIX) && r.userId === userId
  );
  for (const record of mine) {
    const named = !sessionIndexes.length ||
      (record.sessionIndex !== undefined && sessionIndexes.includes(record.sessionIndex));
    if (named) await sessions.delete(record.sessionId.slice(COOKIE_SESSION_PREFIX.length));
  }
  return mine.length > 0;
}

/** {@linkcode revokeCookieSessions}, with an adapter failure logged and read as unresolved. */
async function revokedCookieSids(
  ctx: AuthRouteContext,
  providerId: string,
  nameId: string,
  sessionIndexes: string[],
): Promise<string[] | null> {
  try {
    return await revokeCookieSessions(
      cookieRevocationOf(ctx.options.adapter)!,
      providerId,
      nameId,
      sessionIndexes,
    );
  } catch (error) {
    ctx.options.logger.error(
      "denextAuth: the session revocation list could not be written; ending every session " +
        "of the user instead",
      error,
    );
    return null;
  }
}

/** Whether the caller's own session is one the LogoutRequest just ended. */
function endedHere(
  current: AuthSession | null,
  providerId: string,
  ended: EndedSessions,
  nameId: string,
): boolean {
  if (
    current?.provider !== providerId || current.user.id !== ended.userId ||
    current.saml?.nameId !== nameId
  ) {
    return false;
  }
  return !ended.sids || (current.sid !== undefined && ended.sids.includes(current.sid));
}

/** An IdP-initiated LogoutRequest: verify it, end the sessions, answer a LogoutResponse. */
async function answerIdpLogout(
  ctx: AuthRouteContext,
  slo: SloProvider,
  input: SamlBindingInput,
  peeked: PeekedLogoutMessage,
): Promise<Response> {
  if (peeked.issuer !== slo.sso.idp.entityId) return badMessage();
  let request;
  try {
    request = await verifyLogoutRequest({
      input,
      idp: slo.sso.idp,
      sp: slo.sp,
      replayCache: replayCacheOf({ adapter: ctx.options.adapter! }, "logout"),
    });
  } catch (error) {
    refused(ctx, "LogoutRequest", slo.provider.id, error);
    return badMessage();
  }
  // The browser carrying a front-channel request may hold one of those sessions: clear it too.
  const current = await readAuthSession(ctx.config);
  const ended = await endSamlSessions(
    ctx,
    slo.provider.id,
    request.nameId,
    request.sessionIndexes,
  );
  if (ended && endedHere(current, slo.provider.id, ended, request.nameId)) {
    await clearAuthSession(ctx.config);
  }
  if (!slo.sso.idp.sloUrl) return new Response(null, { status: 200 });
  return redirect(
    await buildLogoutResponse({
      sp: slo.sp,
      idp: slo.sso.idp,
      inResponseTo: request.id,
      ...(request.relayState !== undefined && { relayState: request.relayState }),
    }),
  );
}

function badMessage(): Response {
  return new Response("SAML logout message could not be verified", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * `GET | POST {basePath}/saml/:provider/slo` — a LogoutRequest from the IdP, or its
 * LogoutResponse to ours: HTTP-Redirect (GET, query signature) or HTTP-POST (form, XML
 * signature). A provider without Single Logout falls through (`null`).
 */
async function handleSlo(ctx: AuthRouteContext): Promise<Response | null> {
  const method = ctx.request.method;
  if (method !== "GET" && method !== "POST") return null;
  let slo: SloProvider | null;
  try {
    slo = await sloProvider(ctx, ctx.params.provider);
  } catch (error) {
    ctx.options.logger.error("denextAuth: SAML Single Logout is misconfigured", error);
    return badMessage();
  }
  if (!slo) return null;
  let input: SamlBindingInput;
  if (method === "POST") {
    const form = await readForm(ctx);
    if (!form) return badMessage();
    input = { form };
  } else {
    input = { query: ctx.url.search };
  }
  let peeked: PeekedLogoutMessage;
  try {
    peeked = await peekLogoutMessage(input);
  } catch {
    return badMessage();
  }
  return peeked.kind === "LogoutResponse"
    ? await finishSpLogout(ctx, slo, input, peeked)
    : await answerIdpLogout(ctx, slo, input, peeked);
}

/** The Single Logout row, relative to `basePath`. */
export const samlSloRoutes: AuthRoute[] = [
  { method: "*", pattern: "/saml/:provider/slo", handler: handleSlo },
];
