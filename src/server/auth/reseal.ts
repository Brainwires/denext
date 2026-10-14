/**
 * `denext auth reseal` — move every TOTP factor sealed under a retired auth `secret` (or a
 * pre-sealing plaintext row, or a pre-4.0 record's user binding) onto the current one, without
 * waiting for each user's next code. After a run that reports zero remaining, the retired
 * secret can be dropped from the `secret` list.
 *
 * Each factor is opened with the configured secrets, re-sealed under the first one and written
 * back through the adapter's `updateMfaFactor` — one factor at a time, so an interrupted run
 * has already kept everything it wrote and the next run resumes where it matters. A factor that
 * is already sealed under the current secret is left alone (idempotent). A factor no
 * configured secret opens is never written, only counted: no retired secret recovers it, and
 * {@linkcode disableTotp} is the administrator's recovery for its user.
 *
 * Both sign-in paths share one factor store, so this covers `/auth/v1`'s TOTP factors
 * (`supabase.auth.mfa`) as well as denextAuth's own. Nothing here logs, returns or prints a
 * secret: the report carries counts only.
 *
 * @module
 */

import type { AuthAdapter, MfaFactorRecord } from "./adapter.ts";
import { factorAad, factorStoreOf, openFactorSecret, userFactors } from "./factors.ts";
import { resolveAuthOptions } from "./options.ts";
import { authSecrets, openTotpSecret, sealTotpSecret } from "./totp-seal.ts";
import type { AuthConfig } from "./types.ts";

/** Options for {@linkcode resealTotpFactors}. */
export interface ResealOptions {
  /** Count what would change and write nothing. */
  dryRun?: boolean;
  /** Users read per `listUsers` page (default 200). */
  pageSize?: number;
}

/** What {@linkcode resealTotpFactors} found and did — counts only, never a secret. */
export interface ResealReport {
  /** Whether this was a dry run (nothing written). */
  dryRun: boolean;
  /** Users scanned. */
  users: number;
  /** TOTP factors holding a secret (a pre-4.0 record's secret counts as one). */
  factors: number;
  /** Factors already sealed under the current secret. */
  current: number;
  /** Factors re-sealed under the current secret by this run (always `0` in a dry run). */
  resealed: number;
  /**
   * Factors still owing a re-seal after the run: what a dry run would re-seal, and after a
   * real run what a verification pass still found. The retired secret can go once this is `0`.
   */
  remaining: number;
  /**
   * Factors no configured secret opens — never written, and no retired secret helps them; the
   * user's TOTP codes are refused until an administrator runs `disableTotp` and they enroll again.
   */
  unopenable: number;
}

/** The adapter methods a re-seal needs. */
type ResealAdapter = AuthAdapter & Required<Pick<AuthAdapter, "listUsers">>;

/** One factor's state against the configured secrets. */
type FactorState = "current" | "stale" | "unopenable";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

/** The adapter, or a descriptive throw: the re-seal walks every user and their factors. */
function resealAdapter(config: AuthConfig): ResealAdapter {
  const adapter = resolveAuthOptions(config).adapter;
  if (!adapter || !factorStoreOf(adapter) || typeof adapter.listUsers !== "function") {
    throw new Error(
      "auth reseal: the configured `adapter` needs `listUsers` and the MFA factor store " +
        "(`createMfaFactor`, `listMfaFactors`, `updateMfaFactor`, `claimMfaFactorStep`, " +
        "`deleteMfaFactor`) — every first-party adapter has them",
    );
  }
  return adapter as ResealAdapter;
}

/** Every user id, page by page (oldest first), each once. */
async function* everyUserId(adapter: ResealAdapter, pageSize: number): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (let page = 1;; page++) {
    const { users } = await adapter.listUsers({ page, perPage: pageSize });
    for (const user of users) {
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      yield user.id;
    }
    if (users.length < pageSize) return;
  }
}

/** Where one factor's secret stands. */
async function factorState(config: AuthConfig, factor: MfaFactorRecord): Promise<FactorState> {
  const opened = await openFactorSecret(config, factor, factor.secret!);
  if (!opened.ok) return "unopenable";
  return opened.stale ? "stale" : "current";
}

/** Re-seal one stale factor under the current secret; `false` when it no longer opens. */
async function resealFactor(config: AuthConfig, factor: MfaFactorRecord): Promise<boolean> {
  const opened = await openFactorSecret(config, factor, factor.secret!);
  if (!opened.ok || !opened.stale) return false;
  const sealed = await sealTotpSecret(authSecrets(config.secret), factorAad(factor), opened.secret);
  await factorStoreOf(config.adapter)!.updateMfaFactor(factor.id, { secret: sealed });
  return true;
}

/**
 * A pre-4.0 record's TOTP secret, which a real run moves into a factor first (that is what
 * reading the user's factors does): counted in a dry run as the factor it will become.
 */
async function legacyRecordState(
  config: AuthConfig,
  adapter: ResealAdapter,
  userId: string,
): Promise<FactorState | null> {
  const stored = (await adapter.getMfa?.(userId))?.secret;
  if (!stored) return null;
  const opened = await openTotpSecret(authSecrets(config.secret), userId, stored);
  // Moving it into a factor re-binds it, so even an opened-with-current one is due.
  return opened.ok ? "stale" : "unopenable";
}

/** A user's TOTP factors holding a secret — moving a legacy record's in first unless dry. */
async function totpFactorsOf(
  config: AuthConfig,
  adapter: ResealAdapter,
  userId: string,
  dryRun: boolean,
): Promise<MfaFactorRecord[]> {
  const factors = dryRun
    ? await factorStoreOf(adapter)!.listMfaFactors(userId)
    : await userFactors(config, userId);
  return factors.filter((f) => f.type === "totp" && !!f.secret);
}

/** One pass over every user: tally, and re-seal what is stale unless `write` is off. */
async function pass(
  config: AuthConfig,
  adapter: ResealAdapter,
  pageSize: number,
  write: boolean,
): Promise<Omit<ResealReport, "dryRun">> {
  const report = { users: 0, factors: 0, current: 0, resealed: 0, remaining: 0, unopenable: 0 };
  const tally = (state: FactorState) => {
    report.factors++;
    if (state === "current") report.current++;
    else if (state === "unopenable") report.unopenable++;
    else report.remaining++;
  };
  for await (const userId of everyUserId(adapter, pageSize)) {
    report.users++;
    if (!write) {
      const legacy = await legacyRecordState(config, adapter, userId);
      if (legacy) tally(legacy);
    }
    for (const factor of await totpFactorsOf(config, adapter, userId, !write)) {
      const state = await factorState(config, factor);
      if (state === "stale" && write && await resealFactor(config, factor)) {
        report.factors++;
        report.resealed++;
      } else tally(state);
    }
  }
  return report;
}

/**
 * Re-seal every TOTP factor that a retired `secret` (or a pre-sealing plaintext row) still
 * holds under the current `secret` — the job behind `denext auth reseal`, also callable from a
 * `jobs/` module. Idempotent and resumable: run it again after an interruption. A real run ends
 * with a read-only verification pass, whose count is the report's `remaining`; drop the retired
 * secret once it is `0`.
 *
 * ```ts
 * // jobs/reseal.ts
 * import { activeAuthConfig, defineJob, resealTotpFactors } from "denext/server";
 * export default defineJob({
 *   description: "re-seal TOTP factors under the current auth secret",
 *   handler: async () => console.log(await resealTotpFactors(activeAuthConfig())),
 * });
 * ```
 *
 * @param config The auth config — the one `denextAuth()` was built with (`activeAuthConfig()`).
 * @param options `dryRun` to count only; `pageSize` for the user walk.
 * @returns Counts only — never a secret.
 * @throws {Error} When the adapter lacks `listUsers` or the MFA factor store.
 */
export async function resealTotpFactors(
  config: AuthConfig,
  options: ResealOptions = {},
): Promise<ResealReport> {
  const adapter = resealAdapter(config);
  const dryRun = options.dryRun === true;
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  const first = await pass(config, adapter, pageSize, !dryRun);
  if (dryRun) return { dryRun, ...first };
  // A user deleted mid-walk shifts later pages by one, so a user can be skipped: the count the
  // operator acts on comes from a read-only pass after the writes.
  const verify = await pass(config, adapter, pageSize, false);
  return { dryRun, ...verify, resealed: first.resealed };
}
