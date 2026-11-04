/**
 * PKCE for `/auth/v1` (`flowType: "pkce"` in supabase-js): a link or an OAuth callback lands on
 * `redirect_to?code=<auth_code>`, and the client exchanges the code with its verifier at
 * `POST /token?grant_type=pkce`. The code is single-use (consumed on the first exchange, right
 * or wrong), lives five minutes, is stored only as a hash, and is bound to an S256 challenge.
 *
 * @module
 */

import { sha256Hex } from "@denext/denext/auth-kit";
import { constantTimeEqualHex } from "@denext/denext/auth-kit";
import { base64UrlEncode } from "../oauth.ts";
import { nativeAdapterOf } from "../native.ts";
import type { GoTrueContext } from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
import type { AmrEntry, SsoSessionInfo } from "./session.ts";

/** How long an auth code stays redeemable, seconds. */
const CODE_TTL = 300;
/** RFC 7636 §4.1: 43–128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** An S256 challenge: 43 base64url characters. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** What an auth code redeems for. */
export interface FlowState {
  /** The user who authenticated. */
  userId: string;
  /** How. */
  amr: AmrEntry;
  /** The provider's tokens, for an OAuth sign-in (`provider_token`). */
  providerToken?: string;
  /** The provider's refresh token. */
  providerRefreshToken?: string;
  /** A `linkIdentity` flow: the identity to link when the code is exchanged. */
  link?: {
    provider: string;
    providerAccountId: string;
    identityData: Record<string, unknown>;
    email?: string;
    type?: "oauth" | "oidc";
  };
  /** A SAML sign-in: its origin, kept with the session for Single Logout. */
  sso?: SsoSessionInfo;
}

/**
 * Read the PKCE fields of a request: `code_challenge` + `code_challenge_method` (S256 only).
 *
 * @param challenge The challenge.
 * @param method The method.
 * @returns The challenge, or `undefined` for an implicit-flow request.
 * @throws {GoTrueError} `validation_failed` for a malformed challenge or a non-S256 method.
 */
export function readChallenge(
  challenge: string | null | undefined,
  method: string | null | undefined,
): string | undefined {
  if (!challenge) return undefined;
  if ((method ?? "").toLowerCase() !== "s256") {
    throw fail.validation("code_challenge_method must be s256");
  }
  if (!CHALLENGE_RE.test(challenge)) throw fail.validation("invalid code_challenge");
  return challenge;
}

function grantHash(code: string): Promise<string> {
  return sha256Hex(`gotrue-flow:${code}`);
}

/**
 * Mint an auth code bound to `challenge`.
 *
 * @param ctx The context.
 * @param challenge The S256 challenge.
 * @param state What the code redeems for.
 * @returns The code.
 */
export async function createFlowCode(
  ctx: GoTrueContext,
  challenge: string,
  state: FlowState,
): Promise<string> {
  const adapter = nativeAdapterOf(ctx.adapter);
  if (!adapter) throw new GoTrueError(500, "unexpected_failure", "the adapter keeps no grants");
  const code = crypto.randomUUID();
  await adapter.createNativeGrant({
    hash: await grantHash(code),
    kind: "code",
    expiresAt: Math.floor(Date.now() / 1000) + CODE_TTL,
    data: JSON.stringify({ gotrue: 1, challenge, state }),
  });
  return code;
}

/**
 * Redeem an auth code with its verifier.
 *
 * @param ctx The context.
 * @param code The `auth_code`.
 * @param verifier The `code_verifier`.
 * @returns The flow state.
 * @throws {GoTrueError} `flow_state_not_found` / `flow_state_expired` / `bad_code_verifier`.
 */
export async function redeemFlowCode(
  ctx: GoTrueContext,
  code: string,
  verifier: string,
): Promise<FlowState> {
  const adapter = nativeAdapterOf(ctx.adapter);
  if (!adapter || !code || code.length > 64) {
    throw new GoTrueError(
      404,
      "flow_state_not_found",
      "invalid flow state, no valid flow state found",
    );
  }
  const record = await adapter.useNativeGrant(await grantHash(code), "code");
  if (!record?.data) {
    throw new GoTrueError(
      404,
      "flow_state_not_found",
      "invalid flow state, no valid flow state found",
    );
  }
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new GoTrueError(400, "flow_state_expired", "invalid flow state, flow state has expired");
  }
  let parsed: { gotrue?: number; challenge?: string; state?: FlowState };
  try {
    parsed = JSON.parse(record.data);
  } catch {
    parsed = {};
  }
  if (parsed.gotrue !== 1 || typeof parsed.challenge !== "string" || !parsed.state) {
    throw new GoTrueError(
      404,
      "flow_state_not_found",
      "invalid flow state, no valid flow state found",
    );
  }
  if (!VERIFIER_RE.test(verifier)) {
    throw new GoTrueError(
      400,
      "bad_code_verifier",
      "code challenge does not match previously saved code verifier",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = base64UrlEncode(new Uint8Array(digest));
  if (!constantTimeEqualHex(computed, parsed.challenge)) {
    throw new GoTrueError(
      400,
      "bad_code_verifier",
      "code challenge does not match previously saved code verifier",
    );
  }
  return parsed.state;
}
