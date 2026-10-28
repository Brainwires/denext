/**
 * The MFA factors as GoTrue lists them (`user.factors`): the shared factor store's TOTP, phone
 * and WebAuthn factors, plus the backup codes as one `recovery_code` factor.
 *
 * @module
 */

import type { MfaFactorRecord } from "../adapter.ts";
import { derivedId, type FactorAdapter, factorStoreOf, userFactors } from "../factors.ts";
import type { AuthConfig } from "../types.ts";
import { type GoTrueFactor, iso } from "./user.ts";

/**
 * The configured adapter's factor group, or `null`.
 *
 * @param config The auth config.
 * @returns The adapter narrowed to the factor methods.
 */
export function factorAdapterOf(config: AuthConfig): FactorAdapter | null {
  return factorStoreOf(config.adapter);
}

/**
 * The id the backup codes are listed under (stable per user).
 *
 * @param userId The user.
 * @returns The factor id.
 */
export function recoveryFactorId(userId: string): Promise<string> {
  return derivedId(`recovery-codes:${userId}`);
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
 * A user's factors in GoTrue's shape (`[]` when the adapter keeps none), the backup codes last.
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns The factors.
 */
export async function factorsJson(config: AuthConfig, userId: string): Promise<GoTrueFactor[]> {
  const out = (await userFactors(config, userId)).map(factorJson);
  const record = await config.adapter?.getMfa?.(userId);
  if (record && record.backupCodeHashes.length > 0) {
    const at = iso(record.confirmedAt ?? Math.floor(Date.now() / 1000))!;
    out.push({
      id: await recoveryFactorId(userId),
      factor_type: "recovery_code",
      status: "verified",
      friendly_name: "Recovery codes",
      created_at: at,
      updated_at: at,
    });
  }
  return out;
}
