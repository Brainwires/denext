/**
 * The `/auth/v1` MFA factors as stored (the adapter's factor group) and as GoTrue lists them.
 *
 * @module
 */

import type { AuthAdapter, MfaFactorRecord } from "../adapter.ts";
import type { AuthConfig } from "../types.ts";
import { type GoTrueFactor, iso } from "./user.ts";

/** The adapter methods the factor endpoints need. */
export type FactorAdapter = Required<
  Pick<
    AuthAdapter,
    | "createMfaFactor"
    | "listMfaFactors"
    | "updateMfaFactor"
    | "claimMfaFactorStep"
    | "deleteMfaFactor"
  >
>;

const FACTOR_METHODS = [
  "createMfaFactor",
  "listMfaFactors",
  "updateMfaFactor",
  "claimMfaFactorStep",
  "deleteMfaFactor",
] as const;

/**
 * The configured adapter's factor group, or `null`.
 *
 * @param config The auth config.
 * @returns The adapter narrowed to the factor methods.
 */
export function factorAdapterOf(config: AuthConfig): FactorAdapter | null {
  const adapter = config.adapter;
  if (!adapter) return null;
  return FACTOR_METHODS.every((m) => typeof adapter[m] === "function")
    ? adapter as FactorAdapter
    : null;
}

/**
 * One stored factor in GoTrue's shape (the secret never leaves).
 *
 * @param factor The stored factor.
 * @returns The JSON.
 */
export function factorJson(factor: MfaFactorRecord): GoTrueFactor {
  const out: GoTrueFactor = {
    id: factor.id,
    factor_type: factor.type,
    status: factor.status,
    created_at: iso(factor.createdAt)!,
    updated_at: iso(factor.updatedAt)!,
  };
  if (factor.friendlyName) out.friendly_name = factor.friendlyName;
  if (factor.phone) out.phone = factor.phone;
  if (factor.lastChallengedAt) out.last_challenged_at = iso(factor.lastChallengedAt);
  return out;
}

/**
 * A user's factors in GoTrue's shape (`[]` when the adapter keeps none).
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns The factors.
 */
export async function factorsJson(config: AuthConfig, userId: string): Promise<GoTrueFactor[]> {
  const adapter = factorAdapterOf(config);
  if (!adapter) return [];
  return (await adapter.listMfaFactors(userId)).map(factorJson);
}
