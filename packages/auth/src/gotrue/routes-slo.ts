/**
 * SAML 2.0 Single Logout for `/auth/v1`, on when `saml.signingKey` is configured.
 *
 * - SP-initiated: `POST /logout` for a session a SAML assertion started ends the session at
 *   once (as always) and answers `200 { url }` instead of `204`: the IdP's SingleLogoutService
 *   URL carrying a signed LogoutRequest (HTTP-Redirect, RSA-SHA256) for the NameID and
 *   SessionIndex of that session. The IdP's LogoutResponse comes back to `/sso/saml/slo`, which
 *   lands on the `redirect_to` the logout named (single-use RelayState record, InResponseTo).
 * - IdP-initiated: `/sso/saml/slo` receives a LogoutRequest (HTTP-Redirect query signature or
 *   HTTP-POST XML signature), ends every session that NameID (and SessionIndex) started, and
 *   answers with a signed LogoutResponse to the IdP.
 *
 * @module
 */

import { nativeAdapterOf } from "../native.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { sha256Hex } from "@denext/denext/auth-kit";
import {
  buildLogoutRequest,
  buildLogoutResponse,
  type PeekedLogoutMessage,
  peekLogoutMessage,
  type SamlBindingInput,
  verifyLogoutRequest,
  verifyLogoutResponse,
} from "../saml/mod.ts";
import { type GoTrueContext, nowSeconds, ok, redirectTarget } from "./context.ts";
import { GoTrueError } from "./errors.ts";
import { land, landWithError, pendingProvider, readForm, spendRelay } from "./routes-sso.ts";
import { familiesOf, ssoOriginOf } from "./session.ts";
import { findProvider, replayCacheOf, spOf, ssoAdapterOf } from "./sso-providers.ts";

/** How long an SP-initiated logout may take at the IdP, seconds. */
const LOGOUT_TTL = 600;

function relayHash(relay: string): Promise<string> {
  return sha256Hex(`gotrue-slo:${relay}`);
}

function sloDisabled(): GoTrueError {
  return new GoTrueError(404, "saml_provider_disabled", "SAML Single Logout is not enabled");
}

/**
 * The IdP URL that carries a signed LogoutRequest for a SAML session, after recording the
 * pending logout — or `undefined` when the session is not a SAML one, Single Logout is off, or
 * the IdP has no SingleLogoutService. Never throws for those: the local logout stands alone.
 *
 * @param ctx The context.
 * @param sessionId The session family being signed out.
 * @returns The URL, or `undefined`.
 */
export async function spLogoutUrl(
  ctx: GoTrueContext,
  sessionId: string,
): Promise<string | undefined> {
  if (!ctx.options.saml?.signingKey) return undefined;
  const origin = await ssoOriginOf(ctx.config, sessionId);
  const grants = nativeAdapterOf(ctx.adapter);
  if (!origin || !grants) return undefined;
  let provider;
  try {
    provider = await findProvider(ctx, { id: origin.providerId });
  } catch {
    return undefined; // the provider is gone: nothing to tell
  }
  if (!provider.idp.sloUrl) return undefined;
  const relayState = randomToken(24);
  const { id, url } = await buildLogoutRequest({
    sp: await spOf(ctx),
    idp: provider.idp,
    nameId: origin.nameId,
    ...(origin.nameIdFormat !== undefined && { nameIdFormat: origin.nameIdFormat }),
    ...(origin.sessionIndex !== undefined && { sessionIndex: origin.sessionIndex }),
    relayState,
  });
  await grants.createNativeGrant({
    hash: await relayHash(relayState),
    kind: "nonce",
    expiresAt: nowSeconds() + LOGOUT_TTL,
    data: JSON.stringify({
      gotrueSlo: 1,
      providerId: provider.id,
      requestId: id,
      redirectTo: redirectTarget(ctx, ctx.url.searchParams.get("redirect_to")),
    }),
  });
  return url;
}

interface PendingLogout {
  providerId: string;
  requestId: string;
  redirectTo: string;
}

/** Spend the single-use record of an SP-initiated logout. */
async function pendingLogout(
  ctx: GoTrueContext,
  relay: string | undefined,
): Promise<PendingLogout> {
  const data = await spendRelay<PendingLogout>(ctx, relay, "gotrue-slo", "gotrueSlo");
  if (!data) {
    throw new GoTrueError(400, "bad_oauth_state", "SAML RelayState is invalid or expired");
  }
  return data;
}

function refusal(ctx: GoTrueContext, what: string, providerId: string, error: unknown): void {
  resolveAuthOptions(ctx.config).logger.warn(`/auth/v1: a SAML ${what} was refused`, {
    provider: providerId,
    code: (error as { code?: string }).code,
  });
}

/** The IdP's LogoutResponse to an SP-initiated logout: verify it, land on `redirect_to`. */
async function finishSpLogout(
  ctx: GoTrueContext,
  input: SamlBindingInput,
  peeked: PeekedLogoutMessage,
): Promise<Response> {
  const pending = await pendingLogout(ctx, peeked.relayState);
  const provider = await pendingProvider(ctx, pending.providerId, pending.redirectTo, false);
  if (provider instanceof Response) return provider;
  try {
    const result = await verifyLogoutResponse({
      input,
      idp: provider.idp,
      sp: await spOf(ctx),
      replayCache: replayCacheOf(ctx, "logout"),
      expectedInResponseTo: pending.requestId,
    });
    if (result.success) return land(pending.redirectTo);
    return landWithError(pending.redirectTo, false, "saml_logout_failed", "partial logout");
  } catch (error) {
    if ((error as { code?: string }).code === "bad_key") throw error;
    refusal(ctx, "LogoutResponse", provider.id, error);
    return landWithError(
      pending.redirectTo,
      false,
      "saml_logout_invalid",
      "SAML logout response could not be verified",
    );
  }
}

/** End every session the NameID (and, when named, the SessionIndexes) started. */
async function endSessions(
  ctx: GoTrueContext,
  providerId: string,
  nameId: string,
  sessionIndexes: string[],
): Promise<void> {
  const store = ssoAdapterOf(ctx.adapter);
  if (!store) return;
  const families = familiesOf(ctx.config);
  for (const record of await store.listSsoSessions(providerId, nameId)) {
    const named = !sessionIndexes.length ||
      (record.sessionIndex !== undefined && sessionIndexes.includes(record.sessionIndex));
    if (named) await families.revokeNativeSession(record.sessionId);
  }
}

/** An IdP-initiated LogoutRequest: verify it, end the sessions, answer a LogoutResponse. */
async function answerIdpLogout(
  ctx: GoTrueContext,
  input: SamlBindingInput,
  peeked: PeekedLogoutMessage,
): Promise<Response> {
  if (!peeked.issuer) throw invalid();
  const provider = await findProvider(ctx, { entityId: peeked.issuer });
  const sp = await spOf(ctx);
  let request;
  try {
    request = await verifyLogoutRequest({
      input,
      idp: provider.idp,
      sp,
      replayCache: replayCacheOf(ctx, "logout"),
    });
  } catch (error) {
    if ((error as { code?: string }).code === "bad_key") throw error;
    refusal(ctx, "LogoutRequest", provider.id, error);
    throw invalid();
  }
  await endSessions(ctx, provider.id, request.nameId, request.sessionIndexes);
  if (!provider.idp.sloUrl) return ok({});
  return land(
    await buildLogoutResponse({
      sp,
      idp: provider.idp,
      inResponseTo: request.id,
      ...(request.relayState !== undefined && { relayState: request.relayState }),
    }),
  );
}

function invalid(): GoTrueError {
  return new GoTrueError(400, "validation_failed", "SAML logout message could not be verified");
}

/**
 * `GET | POST /sso/saml/slo`: a LogoutRequest from the IdP, or its LogoutResponse to ours —
 * HTTP-Redirect (GET, query signature) or HTTP-POST (form, XML signature).
 */
export async function slo(ctx: GoTrueContext): Promise<Response> {
  if (!ctx.options.saml?.signingKey) throw sloDisabled();
  const input: SamlBindingInput = ctx.method === "POST"
    ? { form: await readForm(ctx) }
    : { query: ctx.url.search };
  let peeked: PeekedLogoutMessage;
  try {
    peeked = await peekLogoutMessage(input);
  } catch {
    throw invalid();
  }
  return peeked.kind === "LogoutResponse"
    ? await finishSpLogout(ctx, input, peeked)
    : await answerIdpLogout(ctx, input, peeked);
}
