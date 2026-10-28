/**
 * WebAuthn MFA factors for `/auth/v1` (`supabase.auth.mfa.*` with `factorType: "webauthn"`): a
 * factor's first challenge is a registration (`type: "create"`), later ones are assertions
 * (`type: "request"`). The credential lives in the passkey store denext's own passkeys use, so a
 * WebAuthn factor is also a passkey the user can sign in or step up with on denext's endpoints.
 *
 * The relying party is the one `denextAuth({ passkeys })` configures. The client names an
 * `rpId` (and origins) as supabase-js does; they must match the configured relying party, which
 * alone decides what is accepted.
 *
 * @module
 */

import type { AdapterUser, MfaFactorRecord } from "../adapter.ts";
import { factorStoreOf } from "../factors.ts";
import {
  challengeOf,
  creationOptions,
  credentialOf,
  requestOptions,
  verifyNewPasskey,
  verifyPasskeyAssertion,
} from "../passkey-ceremony.ts";
import {
  type PasskeyAdapter,
  passkeyAdapterOf,
  type ResolvedPasskeys,
  resolvePasskeys,
} from "../passkeys.ts";
import { randomToken } from "../oauth.ts";
import { resolveAuthOptions } from "../options.ts";
import { WebAuthnError } from "../webauthn.ts";
import type { GoTrueContext } from "./context.ts";
import { GoTrueError } from "./errors.ts";

/**
 * The relying party and the passkey store, or a 422 when passkeys are not configured.
 *
 * @param ctx The context.
 * @returns The relying party and the adapter.
 */
export function requireRelyingParty(
  ctx: GoTrueContext,
): { rp: ResolvedPasskeys; store: PasskeyAdapter } {
  const rp = resolvePasskeys(ctx.config);
  const store = passkeyAdapterOf(ctx.adapter);
  if (!rp || !store) {
    throw new GoTrueError(
      422,
      "validation_failed",
      "WebAuthn is disabled (configure denextAuth({ passkeys }))",
    );
  }
  return { rp, store };
}

/** The client's `rpId` / `rpOrigins` must name the configured relying party. */
function checkClientRp(rp: ResolvedPasskeys, webauthn: Record<string, unknown> | undefined): void {
  const rpId = webauthn?.rpId ?? webauthn?.rp_id;
  const origins = webauthn?.rpOrigins ?? webauthn?.rp_origins;
  if (rpId !== undefined && rpId !== rp.rpId) {
    throw new GoTrueError(422, "validation_failed", "rpId does not match the relying party");
  }
  if (
    origins !== undefined &&
    (!Array.isArray(origins) || origins.some((o) => !rp.origins.includes(String(o))))
  ) {
    throw new GoTrueError(422, "validation_failed", "rpOrigins are not the relying party's");
  }
}

/** What a WebAuthn challenge answers with, and keeps. */
export interface WebauthnChallenge {
  /** The `webauthn` field of the challenge response. */
  json: Record<string, unknown>;
  /** What the stored challenge keeps (the WebAuthn challenge, the ceremony type). */
  extra: Record<string, unknown>;
}

/**
 * The options for a WebAuthn factor's challenge: a registration while the factor is
 * unverified, an assertion for its credential once verified.
 *
 * @param ctx The context.
 * @param user The user.
 * @param factor The factor.
 * @param body The challenge body (`webauthn: { rpId, rpOrigins }`).
 * @returns The response field and what to store.
 */
export async function webauthnChallengeOptions(
  ctx: GoTrueContext,
  user: AdapterUser,
  factor: MfaFactorRecord,
  body: Record<string, unknown>,
): Promise<WebauthnChallenge> {
  const { rp, store } = requireRelyingParty(ctx);
  checkClientRp(rp, body.webauthn as Record<string, unknown> | undefined);
  const challenge = randomToken(32);
  if (factor.status === "unverified" || !factor.secret) {
    const existing = await store.listPasskeys(user.id);
    const publicKey = creationOptions(rp, { ...user, name: user.name }, existing, challenge);
    return {
      json: { type: "create", credential_options: { publicKey } },
      extra: { webauthn: challenge, type: "create" },
    };
  }
  const passkey = await store.getPasskey(factor.secret);
  const publicKey = requestOptions(rp, challenge, passkey ? [passkey] : []);
  return {
    json: { type: "request", credential_options: { publicKey } },
    extra: { webauthn: challenge, type: "request" },
  };
}

/**
 * Verify a WebAuthn factor's response: a registration stores the new passkey and binds it to the
 * factor; an assertion must be signed by the factor's passkey.
 *
 * @param ctx The context.
 * @param user The user.
 * @param factor The factor.
 * @param body The verify body (`webauthn: { type, credential_response }`).
 * @param extra What the challenge stored.
 * @returns Whether it verified.
 */
export async function completeWebauthnFactor(
  ctx: GoTrueContext,
  user: AdapterUser,
  factor: MfaFactorRecord,
  body: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const { rp, store } = requireRelyingParty(ctx);
  const webauthn = body.webauthn as Record<string, unknown> | undefined;
  checkClientRp(rp, webauthn);
  if (typeof extra.webauthn !== "string" || webauthn?.type !== extra.type) return false;
  try {
    const credential = credentialOf(webauthn?.credential_response);
    if (challengeOf(credential) !== extra.webauthn) return false;
    if (extra.type === "create") {
      const record = await verifyNewPasskey(
        rp,
        credential,
        extra.webauthn,
        user.id,
        factor.friendlyName,
      );
      if (!(await store.createPasskey(record))) return false;
      await factorStoreOf(ctx.adapter)!.updateMfaFactor(factor.id, { secret: record.id });
      return true;
    }
    if (credential.id !== factor.secret) return false;
    await verifyPasskeyAssertion(rp, store, credential, extra.webauthn, user.id);
    return true;
  } catch (error) {
    if (!(error instanceof WebAuthnError)) throw error;
    resolveAuthOptions(ctx.config).logger.warn("/auth/v1: a WebAuthn factor response was refused", {
      code: error.code,
    });
    return false;
  }
}
