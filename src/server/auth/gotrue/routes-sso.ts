/**
 * SAML 2.0 single sign-on for `/auth/v1` (`signInWithSSO`): `POST /sso` starts an
 * SP-initiated login at a configured identity provider, `POST /sso/saml/acs` receives its
 * response, and `GET /sso/saml/metadata` publishes this service provider's metadata.
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
import type { AdapterUser } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { nativeAdapterOf } from "../native.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { signinStartLimiter } from "../rate-limit.ts";
import {
  buildAuthnRequest,
  inMemorySamlReplayCache,
  parseIdpMetadata,
  type SamlIdpConfig,
  type SamlSpConfig,
  spMetadataXml,
  verifySamlResponse,
} from "../saml/mod.ts";
import { createAccount, linkIdentity } from "./accounts.ts";
import {
  checkCaptcha,
  GOTRUE_PREFIX,
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
import type { GoTrueSamlProvider } from "./options.ts";
import { createFlowCode, readChallenge } from "./pkce.ts";
import { startSession } from "./session.ts";

/** How long an SSO login may take, seconds. */
const LOGIN_TTL = 600;
/** The largest SAMLResponse form accepted. */
const ACS_BODY_LIMIT = 512 * 1024;

/** Defense in depth: InResponseTo + the single-use RelayState already stop a replay. */
const replayCache = inMemorySamlReplayCache();

const idpCache = new WeakMap<GoTrueSamlProvider, SamlIdpConfig>();

function idpOf(provider: GoTrueSamlProvider): SamlIdpConfig {
  let idp = idpCache.get(provider);
  if (!idp) {
    idp = parseIdpMetadata(provider.metadataXml);
    idpCache.set(provider, idp);
  }
  return idp;
}

function spOf(ctx: GoTrueContext): SamlSpConfig {
  return {
    entityId: ctx.options.saml?.entityId ?? `${ctx.origin}${GOTRUE_PREFIX}/sso/saml/metadata`,
    acsUrl: `${ctx.origin}${GOTRUE_PREFIX}/sso/saml/acs`,
  };
}

function notFound(): GoTrueError {
  return new GoTrueError(404, "sso_provider_not_found", "No SSO provider assigned for this domain");
}

function providerFor(
  ctx: GoTrueContext,
  providerId: string | undefined,
  domain: string | undefined,
): GoTrueSamlProvider {
  const providers = ctx.options.saml?.providers ?? [];
  const found = providerId
    ? providers.find((p) => p.id === providerId)
    : domain
    ? providers.find((p) => p.domains?.some((d) => d.toLowerCase() === domain.toLowerCase()))
    : undefined;
  if (!found) throw notFound();
  return found;
}

function relayHash(relay: string): Promise<string> {
  return sha256Hex(`gotrue-sso:${relay}`);
}

/** `POST /sso`: `{ provider_id | domain, redirect_to, code_challenge? }` → `{ url }`. */
export async function start(ctx: GoTrueContext): Promise<Response> {
  const body = await readJson(ctx);
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "sso");
  const provider = providerFor(ctx, str(body, "provider_id"), str(body, "domain"));
  const challenge = readChallenge(str(body, "code_challenge"), str(body, "code_challenge_method"));
  const redirectTo = redirectTarget(ctx, str(body, "redirect_to"));
  const relayState = randomToken(24);
  const { id, url } = await buildAuthnRequest({ sp: spOf(ctx), idp: idpOf(provider), relayState });
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
export function metadata(ctx: GoTrueContext): Response {
  if (!ctx.options.saml?.providers.length) throw notFound();
  return new Response(spMetadataXml(spOf(ctx)), {
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

async function readForm(ctx: GoTrueContext): Promise<URLSearchParams> {
  const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new GoTrueError(400, "validation_failed", "SAML responses arrive as a form POST");
  }
  const bytes = await readCappedBody(ctx.request, ACS_BODY_LIMIT);
  if (bytes === TOO_LARGE || bytes === STALLED) {
    throw new GoTrueError(400, "validation_failed", "SAML response too large");
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

async function pendingLogin(ctx: GoTrueContext, relay: string | null): Promise<PendingLogin> {
  const grants = nativeAdapterOf(ctx.adapter);
  const record = relay && grants
    ? await grants.useNativeGrant(await relayHash(relay), "nonce")
    : undefined;
  let data: (PendingLogin & { gotrueSso?: number }) | undefined;
  try {
    data = record?.data ? JSON.parse(record.data) : undefined;
  } catch {
    data = undefined;
  }
  if (!record || record.expiresAt <= nowSeconds() || data?.gotrueSso !== 1) {
    throw new GoTrueError(
      400,
      "bad_oauth_state",
      "SAML RelayState is invalid or expired (IdP-initiated logins are not accepted)",
    );
  }
  return data;
}

function land(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function refused(pending: PendingLogin): Response {
  const fail = new URLSearchParams({
    error: "access_denied",
    error_code: "saml_assertion_invalid",
    error_description: "SAML assertion could not be verified",
  });
  if (pending.challenge) {
    const url = new URL(pending.redirectTo);
    for (const [key, value] of fail) url.searchParams.set(key, value);
    return land(url.href);
  }
  return land(`${pending.redirectTo.split("#")[0]}#${fail}`);
}

/** `POST /sso/saml/acs`: verify the response, then land on `redirect_to`. */
export async function acs(ctx: GoTrueContext): Promise<Response> {
  const form = await readForm(ctx);
  const pending = await pendingLogin(ctx, form.get("RelayState"));
  const provider = providerFor(ctx, pending.providerId, undefined);
  let assertion;
  try {
    assertion = await verifySamlResponse({
      samlResponse: form.get("SAMLResponse") ?? "",
      idp: idpOf(provider),
      sp: spOf(ctx),
      expectedInResponseTo: pending.requestId,
      replayCache,
    });
  } catch (error) {
    resolveAuthOptions(ctx.config).logger.warn("/auth/v1: a SAML response was refused", {
      provider: provider.id,
      code: (error as { code?: string }).code,
    });
    return refused(pending);
  }
  const user = await ssoUser(ctx, provider, assertion);
  const amr = { method: "sso/saml", timestamp: nowSeconds(), provider: `sso:${provider.id}` };
  if (pending.challenge) {
    const code = await createFlowCode(ctx, pending.challenge, { userId: user.id, amr });
    const url = new URL(pending.redirectTo);
    url.searchParams.set("code", code);
    return land(url.href);
  }
  const session = await startSession(ctx.session, user, amr);
  const fragment = new URLSearchParams({
    access_token: session.access_token,
    expires_at: String(session.expires_at),
    expires_in: String(session.expires_in),
    refresh_token: session.refresh_token,
    token_type: "bearer",
  });
  return land(`${pending.redirectTo.split("#")[0]}#${fragment}`);
}

/** The attribute values an assertion carries, by the provider's mapping. */
function mapped(
  provider: GoTrueSamlProvider,
  attributes: Record<string, string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, attribute] of Object.entries(provider.attributeMapping ?? {})) {
    const value = attributes[attribute]?.[0];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function emailOf(
  fields: Record<string, string>,
  assertion: { nameId: string; attributes: Record<string, string[]> },
): string | undefined {
  const raw = fields.email ?? (assertion.nameId.includes("@") ? assertion.nameId : undefined) ??
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
  provider: GoTrueSamlProvider,
  assertion: { nameId: string; attributes: Record<string, string[]> },
): Promise<AdapterUser> {
  const providerId = `sso:${provider.id}`;
  const fields = mapped(provider, assertion.attributes);
  const email = emailOf(fields, assertion);
  const domainOwned = !!email &&
    (provider.domains ?? []).some((d) => email.endsWith(`@${d.toLowerCase()}`));
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
