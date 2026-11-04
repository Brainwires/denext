/**
 * SAML 2.0 sign-in on denextAuth's own endpoints (a `saml({ … })` provider):
 *
 * - `GET {basePath}/signin/:id` — an SP-initiated login: an AuthnRequest over the HTTP-Redirect
 *   binding (signed when the provider's `sp.signingKey` is set), its ID and a fresh RelayState
 *   kept in the signed, single-use transaction cookie (`SameSite=None`, since the IdP's Response
 *   comes back as a cross-site form POST).
 * - `POST {basePath}/callback/:id` — the IdP's Response (HTTP-POST binding). The transaction
 *   must name this provider and the posted RelayState, and the Response must answer exactly its
 *   AuthnRequest (`InResponseTo`); IdP-initiated logins are not accepted.
 * - `GET {basePath}/saml/:id/metadata` — this service provider's metadata, for the IdP.
 *
 * Nothing SAML-specific is implemented here: the Response is verified by the same primitives
 * `/auth/v1` uses (`verifySamlResponse`: strict XML-DSig over exclusive c14n, signature-wrapping
 * and comment-injection defenses, audience / recipient / destination / validity checks, the
 * shared assertion replay cache, encrypted assertions), and the user is resolved by the same
 * SSO rules (`ssoUser`: the email bound only on the provider's domains, no takeover of an
 * existing account unless `linkExistingAccounts`, an SSO user of another IdP never linked). The
 * session records `sso/saml`, so it is an SSO sign-in under `sso-user.ts` — the only kind an
 * SSO user's session may be — and owes a second factor like any other sign-in.
 *
 * @module
 */

import { readCappedBody, STALLED } from "@denext/denext/auth-kit";
import type { SamlSpConfig, VerifiedSamlAssertion } from "./saml/mod.ts";
import { buildAuthnRequest, spMetadataXml, verifySamlResponse } from "./saml/mod.ts";
import { checkKeyPair } from "./saml/keys.ts";
import { emitAuthEvent } from "./events.ts";
import { toAuthUser } from "./adapter-link.ts";
import { GoTrueError } from "./gotrue/errors.ts";
import { ssoUser } from "./gotrue/routes-sso.ts";
import { assertIdpEndpoints, assertMetadataFresh } from "./gotrue/sso-metadata.ts";
import { fromConfig, replayCacheOf, type SsoProvider } from "./gotrue/sso-providers.ts";
import { absoluteUrl } from "@denext/denext/auth-kit";
import {
  applySignInCallback,
  type AuthRoute,
  type AuthRouteContext,
  callbackUri,
  clearTx,
  findProvider,
  readTx,
  redirect,
  sameOriginRedirect,
  setTx,
} from "./routes-shared.ts";
import { finishSignIn } from "./sign-in-tail.ts";
import { safeRedirectLocation } from "@denext/denext/auth-kit";
import { isSamlProvider, type SamlProvider, type SignInFailedReason } from "./types.ts";

/** The largest SAML form accepted (a signed, encrypted Response with attributes). */
const FORM_LIMIT = 512 * 1024;

/** A refused SAML sign-in: the `signInFailed` event, then the sign-in page with `?error=`. */
async function refuse(
  ctx: AuthRouteContext,
  providerId: string,
  reason: SignInFailedReason,
): Promise<Response> {
  await emitAuthEvent(ctx.options, "signInFailed", { provider: providerId, reason });
  const page = ctx.config.pages?.signIn || "/";
  return redirect(safeRedirectLocation(`${page}?error=${encodeURIComponent(reason)}`));
}

/** An absolute URL under `{basePath}/saml/:id/`. */
function samlUrl(ctx: AuthRouteContext, provider: SamlProvider, leaf: string): string {
  return absoluteUrl(
    ctx.request,
    `${ctx.options.prefix}saml/${encodeURIComponent(provider.id)}/${leaf}`,
    { canonicalOrigin: ctx.config.canonicalOrigin },
  );
}

/**
 * The marker a Single Logout transaction carries in `verifier` (a sign-in's is empty), so the
 * ACS never accepts one.
 */
export const SLO_TX = "saml-slo";

/** A key's certificate is required, and must hold the key's public half (checked once). */
async function checkPair(
  provider: SamlProvider,
  key: NonNullable<NonNullable<SamlProvider["sp"]>["signingKey"]>,
  certificate: string | undefined,
  use: "signing" | "encryption",
): Promise<void> {
  if (!certificate) {
    throw new Error(`auth: saml provider "${provider.id}" sp.${use}Key needs sp.${use}Certificate`);
  }
  await checkKeyPair(key, certificate);
}

/**
 * This service provider as `provider`'s IdP sees it. With a signing key it also has a
 * SingleLogoutService (`{basePath}/saml/:id/slo`), published in its metadata.
 *
 * @param ctx The route context.
 * @param provider The SAML provider.
 * @returns The SP configuration.
 */
export async function spFor(ctx: AuthRouteContext, provider: SamlProvider): Promise<SamlSpConfig> {
  const options = provider.sp ?? {};
  const sp: SamlSpConfig = {
    entityId: options.entityId ?? samlUrl(ctx, provider, "metadata"),
    acsUrl: callbackUri(ctx, provider.id),
  };
  if (options.signingKey) {
    await checkPair(provider, options.signingKey, options.signingCertificate, "signing");
    sp.signingKey = options.signingKey;
    sp.signingCertificate = options.signingCertificate;
    sp.sloUrl = samlUrl(ctx, provider, "slo");
  }
  if (options.encryptionKey) {
    await checkPair(provider, options.encryptionKey, options.encryptionCertificate, "encryption");
    sp.encryptionKey = options.encryptionKey;
    sp.encryptionCertificate = options.encryptionCertificate;
  }
  return sp;
}

/**
 * The provider in the shape the shared SSO rules take: config-declared (so an address off its
 * domains is left unbound rather than refused), its metadata parsed, fresh and HTTPS-only.
 *
 * @param ctx The route context.
 * @param provider The SAML provider.
 * @returns The SSO provider.
 */
export function ssoProviderOf(ctx: AuthRouteContext, provider: SamlProvider): SsoProvider {
  const sso = fromConfig(provider);
  assertMetadataFresh({ config: ctx.config }, provider.id, sso.idp);
  assertIdpEndpoints({ config: ctx.config }, sso.idp);
  return provider.nameIdFormat ? { ...sso, nameIdFormat: provider.nameIdFormat } : sso;
}

/**
 * `GET {basePath}/signin/:id` for a SAML provider: send the browser to the IdP.
 *
 * @param ctx The route context.
 * @param provider The SAML provider.
 * @returns A redirect to the IdP, or to the sign-in page with `?error=config`.
 */
export async function startSamlSignIn(
  ctx: AuthRouteContext,
  provider: SamlProvider,
): Promise<Response> {
  if (!ctx.options.adapter) return await refuse(ctx, provider.id, "config");
  try {
    const sso = ssoProviderOf(ctx, provider);
    const relayState = crypto.randomUUID().replaceAll("-", "");
    const { id, url } = await buildAuthnRequest({
      sp: await spFor(ctx, provider),
      idp: sso.idp,
      relayState,
      ...(sso.nameIdFormat ? { nameIdFormat: sso.nameIdFormat } : {}),
    });
    const rawReturn = ctx.url.searchParams.get("callbackUrl");
    const returnTo = rawReturn
      ? sameOriginRedirect(ctx.config, rawReturn, ctx.config.pages?.afterSignIn || "/")
      : undefined;
    // `verifier` is unused by SAML; the AuthnRequest ID rides in `nonce`.
    await setTx(ctx, {
      provider: provider.id,
      state: relayState,
      verifier: "",
      nonce: id,
      returnTo,
    }, {
      crossSite: true,
    });
    return redirect(url);
  } catch (error) {
    ctx.options.logger.error(
      `denextAuth: could not start the SAML sign-in for provider "${provider.id}"`,
      error,
    );
    return await refuse(ctx, provider.id, "config");
  }
}

/**
 * The posted form, or `null` for anything but a bounded urlencoded body.
 *
 * @param ctx The route context.
 * @returns The form, or `null`.
 */
export async function readForm(ctx: AuthRouteContext): Promise<URLSearchParams | null> {
  const type = (ctx.request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  const bytes = await readCappedBody(ctx.request, FORM_LIMIT).catch(() => STALLED);
  if (typeof bytes === "symbol") return null;
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/** Verify the Response for this transaction; `null` when it is refused (logged, no detail). */
async function verifiedAssertion(
  ctx: AuthRouteContext,
  provider: SamlProvider,
  sso: SsoProvider,
  samlResponse: string,
  requestId: string,
): Promise<VerifiedSamlAssertion | null> {
  try {
    return await verifySamlResponse({
      samlResponse,
      idp: sso.idp,
      sp: await spFor(ctx, provider),
      expectedInResponseTo: requestId,
      replayCache: replayCacheOf({ adapter: ctx.options.adapter! }, "assertion"),
    });
  } catch (error) {
    ctx.options.logger.warn("denextAuth: a SAML response was refused", {
      provider: provider.id,
      code: (error as { code?: string }).code,
    });
    return null;
  }
}

/** The `?error=` an SSO account rule maps to. */
function ruleRefusal(error: unknown): SignInFailedReason | null {
  if (!(error instanceof GoTrueError)) return null;
  return error.code === "signup_disabled" ? "access_denied" : "account_not_linked";
}

/**
 * `POST {basePath}/callback/:id` for a SAML provider: the IdP's Response.
 *
 * @param ctx The route context.
 * @param provider The SAML provider.
 * @returns A redirect — to the post-sign-in target (or the second-factor step), or to the
 *   sign-in page with an error.
 */
export async function handleSamlAcs(
  ctx: AuthRouteContext,
  provider: SamlProvider,
): Promise<Response> {
  const form = await readForm(ctx);
  const tx = await readTx(ctx);
  await clearTx(ctx);
  const relay = form?.get("RelayState");
  const samlResponse = form?.get("SAMLResponse");
  if (
    !form || !tx || tx.provider !== provider.id || tx.verifier === SLO_TX || !tx.nonce ||
    !relay || tx.state !== relay || !samlResponse || !ctx.options.adapter
  ) {
    return await refuse(ctx, provider.id, "invalid_state");
  }
  let sso: SsoProvider;
  try {
    sso = ssoProviderOf(ctx, provider);
  } catch {
    return await refuse(ctx, provider.id, "config");
  }
  const assertion = await verifiedAssertion(ctx, provider, sso, samlResponse, tx.nonce);
  if (!assertion) return await refuse(ctx, provider.id, "invalid_token");
  let resolved: Awaited<ReturnType<typeof ssoUser>>;
  try {
    resolved = await ssoUser(
      { adapter: ctx.options.adapter, config: ctx.config, options: {} },
      sso,
      assertion,
    );
  } catch (error) {
    const reason = ruleRefusal(error);
    if (!reason) throw error;
    return await refuse(ctx, provider.id, reason);
  }
  const user = await applySignInCallback(ctx.config, toAuthUser(resolved.user), provider.id);
  if (!user) return await refuse(ctx, provider.id, "access_denied");
  return await finishSignIn(ctx, user, provider.id, {
    isNewUser: resolved.isNewUser,
    returnTo: tx.returnTo,
    amr: ["sso/saml"],
    json: false,
    saml: {
      nameId: assertion.nameId,
      ...(assertion.nameIdFormat !== undefined && { nameIdFormat: assertion.nameIdFormat }),
      ...(assertion.sessionIndex !== undefined && { sessionIndex: assertion.sessionIndex }),
    },
  });
}

/** `GET {basePath}/saml/:provider/metadata` — this SP's metadata for one SAML provider. */
async function handleMetadata(ctx: AuthRouteContext): Promise<Response | null> {
  const provider = findProvider(ctx.config, ctx.params.provider);
  if (!provider || !isSamlProvider(provider)) return null;
  const sso = ssoProviderOf(ctx, provider);
  return new Response(
    spMetadataXml(await spFor(ctx, provider), {
      ...(sso.nameIdFormat ? { nameIdFormat: sso.nameIdFormat } : {}),
    }),
    {
      headers: {
        "content-type": "application/samlmetadata+xml",
        "cache-control": "public, max-age=600",
      },
    },
  );
}

/** The SAML rows, relative to `basePath` (sign-in and the ACS ride `/signin` and `/callback`). */
export const samlRoutes: AuthRoute[] = [
  { method: "GET", pattern: "/saml/:provider/metadata", handler: handleMetadata },
];
