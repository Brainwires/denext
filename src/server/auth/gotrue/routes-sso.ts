/**
 * SAML 2.0 single sign-on for `/auth/v1` (`signInWithSSO`): `POST /sso` starts an
 * SP-initiated login at a configured or stored identity provider, `POST /sso/saml/acs` receives
 * its response (plaintext or encrypted), and `GET /sso/saml/metadata` publishes this service
 * provider's metadata. Single Logout lives in `routes-slo.ts`, the admin API in
 * `routes-sso-admin.ts`.
 *
 * The response is verified by denext's SAML primitives (strict XML-DSig over exclusive c14n,
 * signature-wrapping and replay defenses, audience / recipient / validity / InResponseTo
 * checks). Only SP-initiated logins are accepted: the `RelayState` names a single-use,
 * server-side record of the request this login answers, so a response is redeemed once, for
 * the request it was issued to. A PKCE login lands with a one-time `?code=` that only the
 * client holding the verifier can exchange.
 *
 * @module
 */

import { readCappedBody, STALLED, TOO_LARGE } from "../../body.ts";
import type { AdapterUser, SsoAttributeMapping } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { nativeAdapterOf } from "../native.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { signinStartLimiter } from "../rate-limit.ts";
import {
  buildAuthnRequest,
  spMetadataXml,
  type VerifiedSamlAssertion,
  verifySamlResponse,
} from "../saml/mod.ts";
import { createAccount, linkIdentity } from "./accounts.ts";
import {
  checkCaptcha,
  type GoTrueContext,
  normalizeEmail,
  nowSeconds,
  ok,
  readJson,
  redirectTarget,
  spendIp,
  str,
} from "./context.ts";
import { GoTrueError } from "./errors.ts";
import { createFlowCode, readChallenge } from "./pkce.ts";
import { type SsoSessionInfo, startSession } from "./session.ts";
import {
  findProvider,
  providerNotFound,
  replayCacheOf,
  spOf,
  type SsoProvider,
} from "./sso-providers.ts";

/** How long an SSO login may take, seconds. */
const LOGIN_TTL = 600;
/** The largest SAML form accepted. */
const FORM_LIMIT = 512 * 1024;

/** The SSO routes answer `sso_provider_not_found` when `/auth/v1` has no `saml` options. */
function requireSaml(ctx: GoTrueContext): void {
  if (!ctx.options.saml) throw providerNotFound();
}

function relayHash(relay: string): Promise<string> {
  return sha256Hex(`gotrue-sso:${relay}`);
}

/** `POST /sso`: `{ provider_id | domain, redirect_to, code_challenge? }` → `{ url }`. */
export async function start(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "sso");
  requireSaml(ctx);
  const providerId = str(body, "provider_id");
  const domain = str(body, "domain");
  if (!providerId && !domain) throw providerNotFound();
  const provider = await findProvider(ctx, providerId ? { id: providerId } : { domain: domain! });
  const challenge = readChallenge(str(body, "code_challenge"), str(body, "code_challenge_method"));
  const redirectTo = redirectTarget(ctx, str(body, "redirect_to"));
  const relayState = randomToken(24);
  const { id, url } = await buildAuthnRequest({
    sp: await spOf(ctx),
    idp: provider.idp,
    relayState,
    ...(provider.nameIdFormat && { nameIdFormat: provider.nameIdFormat }),
  });
  const grants = nativeAdapterOf(ctx.adapter);
  if (!grants) throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no grants");
  await grants.createNativeGrant({
    hash: await relayHash(relayState),
    kind: "nonce",
    expiresAt: nowSeconds() + LOGIN_TTL,
    data: JSON.stringify({
      gotrueSso: 1,
      providerId: provider.id,
      requestId: id,
      redirectTo,
      ...(challenge ? { challenge } : {}),
    }),
  });
  return ok({ url });
}

/** `GET /sso/saml/metadata`: this service provider's metadata. */
export async function metadata(ctx: GoTrueContext): Promise<Response> {
  requireSaml(ctx);
  return new Response(spMetadataXml(await spOf(ctx)), {
    headers: {
      "content-type": "application/samlmetadata+xml",
      "cache-control": "public, max-age=600",
    },
  });
}

interface PendingLogin {
  providerId: string;
  requestId: string;
  redirectTo: string;
  challenge?: string;
}

/**
 * Read a posted SAML form (`application/x-www-form-urlencoded`, size-capped).
 *
 * @param ctx The context.
 * @returns The form.
 */
export async function readForm(ctx: GoTrueContext): Promise<URLSearchParams> {
  const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new GoTrueError(400, "validation_failed", "SAML responses arrive as a form POST");
  }
  const bytes = await readCappedBody(ctx.request, FORM_LIMIT);
  if (bytes === TOO_LARGE || bytes === STALLED) {
    throw new GoTrueError(400, "validation_failed", "SAML response too large");
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/**
 * Spend the single-use record a RelayState names (a nonce grant stored under
 * `sha256(domain:relay)`), returning its data when it is live and carries `marker: 1`.
 *
 * @param ctx The context.
 * @param relay The RelayState received.
 * @param domain The hash domain (`gotrue-sso`, `gotrue-slo`).
 * @param marker The flag the record's data must carry.
 * @returns The record's data, or `undefined`.
 */
export async function spendRelay<T>(
  ctx: GoTrueContext,
  relay: string | null | undefined,
  domain: string,
  marker: string,
): Promise<T | undefined> {
  const grants = nativeAdapterOf(ctx.adapter);
  const record = relay && grants
    ? await grants.useNativeGrant(await sha256Hex(`${domain}:${relay}`), "nonce")
    : undefined;
  if (!record?.data || record.expiresAt <= nowSeconds()) return undefined;
  try {
    const data = JSON.parse(record.data);
    return data?.[marker] === 1 ? data as T : undefined;
  } catch {
    return undefined;
  }
}

async function pendingLogin(ctx: GoTrueContext, relay: string | null): Promise<PendingLogin> {
  const data = await spendRelay<PendingLogin>(ctx, relay, "gotrue-sso", "gotrueSso");
  if (!data) {
    throw new GoTrueError(
      400,
      "bad_oauth_state",
      "SAML RelayState is invalid or expired (IdP-initiated logins are not accepted)",
    );
  }
  return data;
}

/**
 * A 303 to where the browser lands (no caching, no referrer).
 *
 * @param location The target.
 * @returns The redirect.
 */
export function land(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/**
 * Land on `redirectTo` with an error: in the query for a PKCE flow, in the fragment otherwise.
 *
 * @param redirectTo The landing URL.
 * @param pkce Whether the flow is PKCE.
 * @param code The `error_code`.
 * @param description The `error_description`.
 * @returns The redirect.
 */
export function landWithError(
  redirectTo: string,
  pkce: boolean,
  code: string,
  description: string,
): Response {
  const fail = new URLSearchParams({
    error: "access_denied",
    error_code: code,
    error_description: description,
  });
  if (pkce) {
    const url = new URL(redirectTo);
    for (const [key, value] of fail) url.searchParams.set(key, value);
    return land(url.href);
  }
  return land(`${redirectTo.split("#")[0]}#${fail}`);
}

/**
 * The provider a pending browser flow (login, logout) answers to — or, when its metadata has
 * expired, the landing on `redirectTo` that reports `saml_metadata_expired`.
 *
 * @param ctx The context.
 * @param providerId The provider.
 * @param redirectTo Where the flow lands.
 * @param pkce Whether the flow is PKCE.
 * @returns The provider, or the error landing.
 */
export async function pendingProvider(
  ctx: GoTrueContext,
  providerId: string,
  redirectTo: string,
  pkce: boolean,
): Promise<SsoProvider | Response> {
  try {
    return await findProvider(ctx, { id: providerId });
  } catch (error) {
    if (!(error instanceof GoTrueError) || error.code !== "saml_metadata_expired") throw error;
    return landWithError(redirectTo, pkce, error.code, error.message);
  }
}

function refused(pending: PendingLogin): Response {
  return landWithError(
    pending.redirectTo,
    !!pending.challenge,
    "saml_assertion_invalid",
    "SAML assertion could not be verified",
  );
}

/** Verify the posted Response for a pending login; `null` when it is refused (logged). */
async function verified(
  ctx: GoTrueContext,
  form: URLSearchParams,
  pending: PendingLogin,
  provider: SsoProvider,
): Promise<VerifiedSamlAssertion | null> {
  const sp = await spOf(ctx);
  try {
    return await verifySamlResponse({
      samlResponse: form.get("SAMLResponse") ?? "",
      idp: provider.idp,
      sp,
      expectedInResponseTo: pending.requestId,
      replayCache: replayCacheOf(ctx, "assertion"),
    });
  } catch (error) {
    if ((error as { code?: string }).code === "bad_key") throw error;
    resolveAuthOptions(ctx.config).logger.warn("/auth/v1: a SAML response was refused", {
      provider: provider.id,
      code: (error as { code?: string }).code,
    });
    return null;
  }
}

/** `POST /sso/saml/acs`: verify the response, then land on `redirect_to`. */
export async function acs(ctx: GoTrueContext): Promise<Response> {
  requireSaml(ctx);
  const form = await readForm(ctx);
  const pending = await pendingLogin(ctx, form.get("RelayState"));
  const provider = await pendingProvider(
    ctx,
    pending.providerId,
    pending.redirectTo,
    !!pending.challenge,
  );
  if (provider instanceof Response) return provider;
  const assertion = await verified(ctx, form, pending, provider);
  if (!assertion) return refused(pending);
  const user = await ssoUser(ctx, provider, assertion);
  const amr = { method: "sso/saml", timestamp: nowSeconds(), provider: `sso:${provider.id}` };
  const sso: SsoSessionInfo = { providerId: provider.id, nameId: assertion.nameId };
  if (assertion.nameIdFormat !== undefined) sso.nameIdFormat = assertion.nameIdFormat;
  if (assertion.sessionIndex !== undefined) sso.sessionIndex = assertion.sessionIndex;
  if (pending.challenge) {
    const code = await createFlowCode(ctx, pending.challenge, { userId: user.id, amr, sso });
    const url = new URL(pending.redirectTo);
    url.searchParams.set("code", code);
    return land(url.href);
  }
  const session = await startSession(ctx.session, user, amr, sso);
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    expires_at: String(session.expires_at),
    expires_in: String(session.expires_in),
    refresh_token: session.refresh_token,
    token_type: "bearer",
  });
  return land(`${pending.redirectTo.split("#")[0]}#${fragment}`);
}

/** One mapped field: the first named attribute present (all values with `array`), else the default. */
function mappedValue(
  key: NonNullable<SsoAttributeMapping["keys"]>[string],
  attributes: Record<string, string[]>,
): unknown {
  const names = [...(key.name ? [key.name] : []), ...(key.names ?? [])];
  for (const name of names) {
    const values = Object.hasOwn(attributes, name) ? attributes[name] : undefined;
    if (values?.length) return key.array ? [...values] : values[0];
  }
  return key.default;
}

/** The user-metadata fields an assertion yields, by the provider's mapping. */
function mapped(
  provider: SsoProvider,
  attributes: Record<string, string[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(provider.mapping.keys ?? {})) {
    if (field === "__proto__") continue;
    const value = mappedValue(key, attributes);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function emailOf(
  fields: Record<string, unknown>,
  assertion: { nameId: string; attributes: Record<string, string[]> },
): string | undefined {
  const mappedEmail = typeof fields.email === "string" ? fields.email : undefined;
  const raw = mappedEmail ?? (assertion.nameId.includes("@") ? assertion.nameId : undefined) ??
    assertion.attributes.email?.[0] ?? assertion.attributes.mail?.[0];
  try {
    return normalizeEmail(raw);
  } catch {
    return undefined;
  }
}

/**
 * The user an assertion signs in: its linked SSO identity, else an existing account on one of
 * the provider's own domains (the IdP is authoritative for them), else a new user.
 */
async function ssoUser(
  ctx: GoTrueContext,
  provider: SsoProvider,
  assertion: { nameId: string; attributes: Record<string, string[]> },
): Promise<AdapterUser> {
  const providerId = `sso:${provider.id}`;
  const fields = mapped(provider, assertion.attributes);
  const email = emailOf(fields, assertion);
  const domainOwned = !!email &&
    provider.domains.some((d) => email.endsWith(`@${d}`));
  let user = await ctx.adapter.getUserByAccount({
    provider: providerId,
    providerAccountId: assertion.nameId,
  });
  if (!user && email) {
    const existing = await ctx.adapter.getUserByEmail(email);
    if (existing && !domainOwned) {
      throw new GoTrueError(
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
    }
    user = existing;
  }
  user ??= await createAccount(ctx, {
    email,
    emailVerified: !!email,
    userMetadata: { ...fields, sub: assertion.nameId },
    appMetadata: { provider: providerId, providers: [providerId] },
  });
  await linkIdentity(ctx, user, {
    provider: providerId,
    providerAccountId: assertion.nameId,
    email,
    identityData: { sub: assertion.nameId, ...fields, custom_claims: assertion.attributes },
  });
  return user;
}
