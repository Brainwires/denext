/**
 * The one MFA factor store both sign-in paths read: denext's cookie sign-in (`/auth/mfa*`,
 * `verifySecondFactor`, `mfaPendingFor`) and the `/auth/v1` API (`supabase.auth.mfa.*`).
 *
 * - **Factors** are the adapter's factor group (`auth_mfa_factors`): TOTP authenticators, phones
 *   that receive SMS codes, and WebAuthn authenticators enrolled as second factors. A user may
 *   hold several of each kind. TOTP secrets are sealed under the auth `secret` with the factor
 *   as associated data; a TOTP step is claimed per factor, so a code is accepted at most once.
 * - **Backup (recovery) codes** stay in the user's `MfaRecord.backupCodeHashes`, spent through
 *   the adapter's atomic `consumeBackupCode`; GoTrue lists them as one `recovery_code` factor.
 * - A TOTP secret that an earlier denext stored in `MfaRecord.secret` is moved into a factor the
 *   first time the user's factors are read (re-sealed for the factor, its replay step kept),
 *   and the record keeps only the backup codes.
 *
 * A user is **enrolled** — owes a second factor at sign-in, and an `/auth/v1` session of theirs
 * is `aal1` until one is verified — when any factor is verified.
 *
 * @module
 */

import type { AuthAdapter, MfaFactorRecord } from "./adapter.ts";
import { constantTimeEqualHex, sha256Hex } from "./hash.ts";
import { nativeAdapterOf } from "./native.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { verifyTotp } from "./totp.ts";
import { authSecrets, openTotpSecret, sealTotpSecret } from "./totp-seal.ts";
import type { AuthConfig } from "./types.ts";

/** The adapter methods the factor store needs. */
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

/** How long a factor challenge stays answerable, seconds. */
const CHALLENGE_TTL = 300;

/**
 * The adapter's factor group, or `null` when it lacks one.
 *
 * @param adapter The configured adapter.
 * @returns The adapter narrowed to the factor methods.
 */
export function factorStoreOf(adapter: AuthAdapter | undefined): FactorAdapter | null {
  if (!adapter) return null;
  return FACTOR_METHODS.every((m) => typeof adapter[m] === "function")
    ? adapter as FactorAdapter
    : null;
}

/** A UUID-shaped id derived from a string (stable for the legacy factor of a user). */
export async function derivedId(input: string): Promise<string> {
  const hex = await sha256Hex(input);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${
    hex.slice(20, 32)
  }`;
}

/** The associated data a factor's sealed TOTP secret is bound to. */
export function factorAad(factor: Pick<MfaFactorRecord, "userId" | "id">): string {
  return `${factor.userId}:${factor.id}`;
}

/** The id of the factor a user's legacy `MfaRecord` TOTP secret moves into. */
function legacyFactorId(userId: string): Promise<string> {
  return derivedId(`legacy-totp:${userId}`);
}

/**
 * Move a TOTP secret stored in the user's `MfaRecord` (denext before the factor store) into a
 * factor, once. The stored value is copied as it is — sealed (bound to the user, which the
 * legacy factor's opening accepts) or a pre-sealing plaintext row — so nothing has to be opened
 * here: a secret no configured key opens still moves, and the user stays enrolled (fail closed)
 * until a key that opens it is configured. Idempotent: the factor id is derived from the user,
 * and the record's secret is cleared with a compare-and-swap.
 */
async function migrateLegacyTotp(
  options: ResolvedAuthOptions,
  store: FactorAdapter,
  userId: string,
): Promise<void> {
  const adapter = options.adapter!;
  const record = await adapter.getMfa?.(userId);
  if (!record?.secret) return;
  const id = await legacyFactorId(userId);
  if (!(await store.listMfaFactors(userId)).some((f) => f.id === id)) {
    const at = Math.floor(Date.now() / 1000);
    await store.createMfaFactor({
      id,
      userId,
      type: "totp",
      status: record.confirmedAt !== undefined ? "verified" : "unverified",
      friendlyName: "Authenticator",
      secret: record.secret,
      createdAt: record.confirmedAt ?? at,
      updatedAt: at,
      ...(record.lastStep !== undefined ? { lastStep: record.lastStep } : {}),
    });
  }
  // Keep the backup codes; drop the secret now that the factor holds it.
  if (adapter.replaceMfaSecret) await adapter.replaceMfaSecret(userId, record.secret, "");
  else await adapter.setMfa?.({ ...record, secret: "" });
}

/**
 * Open a factor's TOTP secret: sealed for the factor, or — for the factor a legacy record moved
 * into — still sealed for the user, or a pre-sealing plaintext row. Anything but the first is
 * `stale` (re-sealed for the factor after a code it accepts, or by `denext auth reseal`).
 *
 * @param config The auth config (its `secret` list, current first).
 * @param factor The factor the secret belongs to.
 * @param stored The stored value.
 * @returns The opened secret and whether it is stale, or `{ ok: false }`.
 */
export async function openFactorSecret(
  config: AuthConfig,
  factor: MfaFactorRecord,
  stored: string,
): Promise<{ ok: true; secret: string; stale: boolean } | { ok: false }> {
  const keys = authSecrets(config.secret);
  const opened = await openTotpSecret(keys, factorAad(factor), stored);
  if (opened.ok || factor.id !== await legacyFactorId(factor.userId)) return opened;
  const legacy = await openTotpSecret(keys, factor.userId, stored);
  return legacy.ok ? { ...legacy, stale: true } : legacy;
}

/**
 * A user's factors (any status), oldest first — after moving a legacy TOTP secret in.
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns The factors (`[]` when the adapter keeps none).
 */
export async function userFactors(config: AuthConfig, userId: string): Promise<MfaFactorRecord[]> {
  const options = resolveAuthOptions(config);
  const store = factorStoreOf(options.adapter);
  if (!store) return [];
  await migrateLegacyTotp(options, store, userId);
  return await store.listMfaFactors(userId);
}

/**
 * Whether a user holds a verified second factor (the "enrolled" every MFA rule reads).
 *
 * @param config The auth config.
 * @param userId The user.
 * @returns `true` with at least one verified factor.
 */
export async function hasVerifiedFactor(config: AuthConfig, userId: string): Promise<boolean> {
  return (await userFactors(config, userId)).some((f) => f.status === "verified");
}

/**
 * Check a TOTP code against one factor and claim its step (a replay is refused).
 *
 * @param config The auth config.
 * @param factor The factor.
 * @param code The code.
 * @param window The accepted step window.
 * @returns Whether the code was accepted.
 */
export async function totpFactorAccepts(
  config: AuthConfig,
  factor: MfaFactorRecord,
  code: string,
  window = 1,
): Promise<boolean> {
  const store = factorStoreOf(config.adapter);
  if (factor.type !== "totp" || !factor.secret || !store) return false;
  const opened = await openFactorSecret(config, factor, factor.secret);
  if (!opened.ok) {
    resolveAuthOptions(config).logger.warn(
      "denextAuth: a TOTP factor's secret could not be opened with any configured `secret`; " +
        "its codes are refused and the user stays enrolled (backup codes still work)",
      { userId: factor.userId, factorId: factor.id },
    );
    return false;
  }
  const result = await verifyTotp(opened.secret, code, { window });
  if (!result.ok || !(await store.claimMfaFactorStep(factor.id, result.step))) return false;
  if (opened.stale) {
    // Plaintext, a retired key, or the legacy binding: re-seal under the current key.
    const sealed = await sealTotpSecret(
      authSecrets(config.secret),
      factorAad(factor),
      opened.secret,
    );
    await store.updateMfaFactor(factor.id, { secret: sealed });
  }
  return true;
}

/**
 * Accept a TOTP code from any of a user's verified TOTP factors.
 *
 * @param config The auth config.
 * @param userId The user.
 * @param code The code.
 * @param window The accepted step window.
 * @returns The factor that accepted it, or `null`.
 */
export async function verifiedTotpFactorFor(
  config: AuthConfig,
  userId: string,
  code: string,
  window = 1,
): Promise<MfaFactorRecord | null> {
  if (!/^\s*\d[\d\s]{4,12}$/.test(code)) return null;
  for (const factor of await userFactors(config, userId)) {
    if (factor.status !== "verified" || factor.type !== "totp") continue;
    if (await totpFactorAccepts(config, factor, code, window)) return factor;
  }
  return null;
}

function challengeHash(id: string): Promise<string> {
  return sha256Hex(`mfa-challenge:${id}`);
}

/** A six-digit code, every digit uniform. */
function randomCode(): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

/** What a stored challenge carries. */
export interface FactorChallenge {
  /** The challenge id. */
  id: string;
  /** Expiry, epoch seconds. */
  expiresAt: number;
  /** For a phone factor: the code to send (never stored, only its hash). */
  code?: string;
}

/**
 * Open a single-use challenge for a factor. A phone factor's challenge carries a fresh code
 * (returned for sending; only its hash is stored); a WebAuthn factor's carries the WebAuthn
 * challenge in `extra`.
 *
 * @param config The auth config.
 * @param factor The factor.
 * @param extra Ceremony data to keep with it (WebAuthn).
 * @returns The challenge.
 */
export async function openFactorChallenge(
  config: AuthConfig,
  factor: MfaFactorRecord,
  extra: Record<string, unknown> = {},
): Promise<FactorChallenge> {
  const grants = nativeAdapterOf(config.adapter);
  if (!grants) throw new Error("the auth adapter keeps no grants");
  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL;
  const code = factor.type === "phone" ? randomCode() : undefined;
  await grants.createNativeGrant({
    hash: await challengeHash(id),
    kind: "nonce",
    expiresAt,
    data: JSON.stringify({
      mfa: 1,
      factorId: factor.id,
      userId: factor.userId,
      ...(code ? { codeHash: await sha256Hex(`${id}:${code}`) } : {}),
      extra,
    }),
  });
  await factorStoreOf(config.adapter)?.updateMfaFactor(factor.id, {
    lastChallengedAt: Math.floor(Date.now() / 1000),
  });
  return { id, expiresAt, ...(code ? { code } : {}) };
}

/** A redeemed challenge. */
export interface RedeemedChallenge {
  /** Whether it had expired (it is spent either way). */
  expired: boolean;
  /** A phone challenge's code hash. */
  codeHash?: string;
  /** Ceremony data stored with it. */
  extra: Record<string, unknown>;
}

/**
 * Redeem a challenge for this factor and user: consumed on the first try, right or wrong.
 *
 * @param config The auth config.
 * @param challengeId The challenge id.
 * @param factor The factor it must belong to.
 * @returns The challenge, or `null` when unknown, spent or another factor's.
 */
export async function redeemFactorChallenge(
  config: AuthConfig,
  challengeId: string,
  factor: MfaFactorRecord,
): Promise<RedeemedChallenge | null> {
  const grants = nativeAdapterOf(config.adapter);
  if (!grants || !challengeId || challengeId.length > 64) return null;
  const record = await grants.useNativeGrant(await challengeHash(challengeId), "nonce");
  let data: {
    mfa?: number;
    factorId?: string;
    userId?: string;
    codeHash?: string;
    extra?: Record<string, unknown>;
  } = {};
  try {
    data = record?.data ? JSON.parse(record.data) : {};
  } catch { /* refused below */ }
  if (!record || data.mfa !== 1 || data.factorId !== factor.id || data.userId !== factor.userId) {
    return null;
  }
  return {
    expired: record.expiresAt <= Math.floor(Date.now() / 1000),
    ...(data.codeHash ? { codeHash: data.codeHash } : {}),
    extra: data.extra ?? {},
  };
}

/**
 * Whether a phone challenge's code matches (constant time).
 *
 * @param challengeId The challenge id.
 * @param code The code typed.
 * @param codeHash The stored hash.
 * @returns Whether it matches.
 */
export async function phoneCodeMatches(
  challengeId: string,
  code: string,
  codeHash: string | undefined,
): Promise<boolean> {
  if (!codeHash || !/^[0-9]{6}$/.test(code)) return false;
  return constantTimeEqualHex(await sha256Hex(`${challengeId}:${code}`), codeHash);
}

/**
 * Mark a factor verified (its first successful verification).
 *
 * @param config The auth config.
 * @param factor The factor.
 */
export async function markFactorVerified(
  config: AuthConfig,
  factor: MfaFactorRecord,
): Promise<void> {
  if (factor.status === "verified") return;
  await factorStoreOf(config.adapter)?.updateMfaFactor(factor.id, {
    status: "verified",
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

/**
 * Remove every factor of a user and their backup codes (the pre-account-hijacking eviction, an
 * administrator's reset).
 *
 * @param config The auth config.
 * @param userId The user.
 */
export async function removeAllFactors(config: AuthConfig, userId: string): Promise<void> {
  const options = resolveAuthOptions(config);
  const store = factorStoreOf(options.adapter);
  for (const factor of await store?.listMfaFactors(userId) ?? []) {
    await store!.deleteMfaFactor(factor.id);
  }
  const adapter = options.adapter;
  if (!(await adapter?.getMfa?.(userId))) return;
  if (adapter?.deleteMfa) await adapter.deleteMfa(userId);
  else await adapter?.setMfa?.({ userId, secret: "", backupCodeHashes: [] });
}

/**
 * Remove the WebAuthn factor a passkey backs (when the passkey itself is removed), so no
 * verified factor is left without its credential.
 *
 * @param config The auth config.
 * @param userId The owner.
 * @param credentialId The passkey's credential id.
 */
export async function forgetPasskeyFactor(
  config: AuthConfig,
  userId: string,
  credentialId: string,
): Promise<void> {
  const store = factorStoreOf(config.adapter);
  for (const factor of await store?.listMfaFactors(userId) ?? []) {
    if (factor.type === "webauthn" && factor.secret === credentialId) {
      await store!.deleteMfaFactor(factor.id);
    }
  }
}
