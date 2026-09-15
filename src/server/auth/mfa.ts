/**
 * Multi-factor authentication (TOTP): the step-up decision the sign-in tails consult,
 * enrollment (`enrollTotp` → `confirmTotp`), verification (`verifySecondFactor`, TOTP or a
 * single-use backup code), `disableTotp`, and the step-up that turns a pending session
 * into a complete one (`completeStepUp`).
 *
 * Three guards hold on every code check: a TOTP code is accepted within ±`mfa.window`
 * steps and its step is then **claimed** through the adapter's atomic `claimTotpStep`
 * (so the same code can't be presented twice); a backup code is spent through the
 * adapter's atomic `consumeBackupCode` (stored only as a {@link ./hasher.ts | Hasher}
 * hash); and the attempt budget is spent by the HTTP layer
 * ({@link ./routes-mfa.ts | the MFA routes}).
 *
 * **Disabling.** The adapter's MFA group has no delete: `disableTotp` writes an empty,
 * unconfirmed record (no secret, no backup codes) in the user's place, which reads as
 * "not enrolled" everywhere — {@linkcode mfaPendingFor}, {@linkcode mfaStatus}, and every
 * verification.
 *
 * @module
 */

import type { AuthAdapter, MfaRecord } from "./adapter.ts";
import { backupCodeMatcher, generateBackupCodes, isBackupCodeShaped } from "./backup-codes.ts";
import { emitAuthEvent } from "./events.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import type { AuthRouteContext } from "./routes-shared.ts";
import { issueAuthSession } from "./session.ts";
import { generateTotpSecret, totpAuthUri, verifyTotp } from "./totp.ts";
import type { AuthConfig, AuthSession, AuthUser } from "./types.ts";

/** The adapter methods the MFA flows need, all present. */
type MfaAdapter = Required<
  Pick<AuthAdapter, "getMfa" | "setMfa" | "consumeBackupCode" | "claimTotpStep">
>;

/** A second factor a step-up can be completed with: a TOTP code, or a backup code. */
export type MfaMethod = "totp" | "bcp";

/** A user's second-factor state, as {@linkcode mfaStatus} reports it. */
export interface MfaStatus {
  /**
   * A confirmed TOTP factor is on file, so sign-in asks for it — what `mfa.required:
   * "enrolled"` means by enrolled.
   */
  enrolled: boolean;
  /** An enrollment was started (a secret is on file) but not yet confirmed with a code. */
  pendingConfirmation: boolean;
  /** Unspent backup codes (`0` when not enrolled). */
  backupCodesRemaining: number;
}

/** A fresh, unconfirmed TOTP enrollment, as {@linkcode enrollTotp} returns it. */
export interface TotpEnrollment {
  /** The base32 secret, for manual entry into an authenticator app. */
  secret: string;
  /** The `otpauth://totp/…` provisioning URI — render it as a QR code. */
  uri: string;
}

/**
 * The outcome of {@linkcode enrollTotp}: the fresh secret and its URI, or why none was minted
 * — `"already_enrolled"` (a confirmed factor exists; disable it first) or `"reauth_required"`
 * (a complete session that didn't sign in recently).
 */
export type EnrollTotpResult =
  | ({ ok: true } & TotpEnrollment)
  | { ok: false; error: "already_enrolled" | "reauth_required" };

/**
 * The outcome of {@linkcode confirmTotp}: on success, the plaintext backup codes — the
 * only time they exist anywhere; show them to the user once. `"invalid_code"`: a wrong or
 * replayed code. `"not_pending"`: no enrollment awaits confirmation (none started, already
 * confirmed, or replaced meanwhile).
 */
export type ConfirmTotpResult =
  | { ok: true; backupCodes: string[] }
  | { ok: false; error: "invalid_code" | "not_pending" };

/**
 * The outcome of {@linkcode verifySecondFactor}: the method that verified, or why nothing did
 * — `"invalid_code"` (wrong, replayed or spent) or `"not_enrolled"` (no confirmed factor).
 */
export type SecondFactorResult =
  | { ok: true; method: MfaMethod }
  | { ok: false; error: "invalid_code" | "not_enrolled" };

/**
 * Whether signing `user` in must stop at a pending session that still owes a second
 * factor. `mfa.required: "always"` says yes for everyone (an unenrolled user is sent to
 * enrol); the default `"enrolled"` says yes only for a user with a confirmed factor.
 * Without an adapter (or one without the MFA group) nobody is enrolled.
 *
 * @param options The resolved auth options.
 * @param user The user the first factor authenticated.
 * @returns `true` when the session must be issued as MFA-pending.
 */
export async function mfaPendingFor(
  options: ResolvedAuthOptions,
  user: AuthUser,
): Promise<boolean> {
  if (options.mfa.required === "always") return true;
  // The same test every MFA check uses: a confirmed record that still holds a secret. An
  // adapter whose `setMfa` merges fields could keep `confirmedAt` on a disabled (secret-less)
  // record, which must not leave that user pending forever.
  return isConfirmed(await options.adapter?.getMfa?.(user.id));
}

/** The adapter when it implements the whole MFA group, else `undefined`. */
function mfaAdapter(options: ResolvedAuthOptions): MfaAdapter | undefined {
  const adapter = options.adapter;
  if (!adapter?.getMfa || !adapter.setMfa) return undefined;
  if (!adapter.consumeBackupCode || !adapter.claimTotpStep) return undefined;
  return adapter as MfaAdapter;
}

/**
 * Whether the configured adapter can run the MFA flows — it implements `getMfa`,
 * `setMfa`, `consumeBackupCode` and `claimTotpStep`. Without them the MFA endpoints don't
 * exist (a plain 404).
 *
 * @param options The resolved auth options.
 * @returns `true` when every MFA adapter method is present.
 */
export function hasMfaAdapter(options: ResolvedAuthOptions): boolean {
  return mfaAdapter(options) !== undefined;
}

/** The MFA adapter, or a descriptive throw naming the caller. */
function requireMfaAdapter(options: ResolvedAuthOptions, fn: string): MfaAdapter {
  const adapter = mfaAdapter(options);
  if (adapter) return adapter;
  throw new Error(
    `${fn}: the configured \`adapter\` has no MFA group (\`getMfa\`, \`setMfa\`, ` +
      "`consumeBackupCode`, `claimTotpStep`) — use `sqliteAuthAdapter({ path })`, or " +
      "`inMemoryAuthAdapter()` in tests.",
  );
}

/** A record with a live secret whose enrollment was confirmed. */
function isConfirmed(record: MfaRecord | undefined): record is MfaRecord {
  return !!record?.secret && record.confirmedAt !== undefined;
}

/**
 * A user's second-factor state — for an account-settings page.
 *
 * @param config The app's auth config.
 * @param userId The user.
 * @returns Whether a confirmed factor is on file, whether an enrollment awaits
 * confirmation, and how many backup codes remain.
 */
export async function mfaStatus(config: AuthConfig, userId: string): Promise<MfaStatus> {
  const record = await resolveAuthOptions(config).adapter?.getMfa?.(userId);
  if (!record?.secret) {
    return { enrolled: false, pendingConfirmation: false, backupCodesRemaining: 0 };
  }
  const confirmed = record.confirmedAt !== undefined;
  return {
    enrolled: confirmed,
    pendingConfirmation: !confirmed,
    backupCodesRemaining: record.backupCodeHashes.length,
  };
}

/**
 * Start a TOTP enrollment: mint a secret, store it **unconfirmed**, and return it with the
 * provisioning URI (issuer `mfa.issuer`, account `user.email ?? user.id`). An earlier
 * unconfirmed enrollment is replaced; a CONFIRMED factor is not — disable it first.
 *
 * From a complete session this needs a recent sign-in (`session.authTime` within
 * `mfa.freshness`, five minutes at least), exactly as `POST {basePath}/mfa/enroll` does: a
 * stolen long-lived session must not set up a factor of its own and lock the owner out. A
 * pending session (`mfa.required: "always"`) is minutes old and may enroll.
 *
 * @param config The app's auth config.
 * @param session The enrolling user's session (`auth()`, or `pendingMfaSession()`).
 * @returns `{ ok: true, secret, uri }`, or `{ ok: false, error }`.
 * @throws {Error} When the adapter has no MFA group.
 */
export async function enrollTotp(
  config: AuthConfig,
  session: AuthSession,
): Promise<EnrollTotpResult> {
  const options = resolveAuthOptions(config);
  const adapter = requireMfaAdapter(options, "enrollTotp");
  if (!session.mfaPending && !recentlyAuthenticated(options, session)) {
    return { ok: false, error: "reauth_required" };
  }
  const user = session.user;
  if (isConfirmed(await adapter.getMfa(user.id))) return { ok: false, error: "already_enrolled" };
  const secret = generateTotpSecret();
  await adapter.setMfa({ userId: user.id, secret, backupCodeHashes: [] });
  const account = user.email ?? user.id;
  return { ok: true, secret, uri: totpAuthUri({ secret, account, issuer: options.mfa.issuer }) };
}

/**
 * Verify a TOTP code against `record`'s secret (±`mfa.window` steps) and claim its step,
 * so the same code can never be accepted twice.
 */
async function claimTotp(
  options: ResolvedAuthOptions,
  adapter: MfaAdapter,
  record: MfaRecord,
  code: string,
): Promise<boolean> {
  const result = await verifyTotp(record.secret, code, { window: options.mfa.window });
  return result.ok && await adapter.claimTotpStep(record.userId, result.step);
}

/**
 * Confirm a pending enrollment with a code from the authenticator app. On success the
 * factor is marked confirmed and `mfa.backupCodes` backup codes are minted — returned
 * here in plaintext exactly once, and stored only as hashes. The code's step is claimed,
 * so it can't then be replayed at the step-up.
 *
 * @param config The app's auth config.
 * @param input The user confirming, and the code they typed.
 * @returns `{ ok: true, backupCodes }`, or `{ ok: false, error }`.
 * @throws {Error} When the adapter has no MFA group.
 */
export async function confirmTotp(
  config: AuthConfig,
  input: { user: AuthUser; code: string },
): Promise<ConfirmTotpResult> {
  const { user, code } = input;
  const options = resolveAuthOptions(config);
  const adapter = requireMfaAdapter(options, "confirmTotp");
  const record = await adapter.getMfa(user.id);
  if (!record?.secret || record.confirmedAt !== undefined) {
    return { ok: false, error: "not_pending" };
  }
  if (!await claimTotp(options, adapter, record, code)) return { ok: false, error: "invalid_code" };
  const { codes, hashes } = await generateBackupCodes(options.hasher, options.mfa.backupCodes);
  // Re-read: the claim just advanced `lastStep`, which the write below must keep — and an
  // enrollment replaced meanwhile must not be confirmed with the old secret's code.
  const current = await adapter.getMfa(user.id);
  if (current?.secret !== record.secret) return { ok: false, error: "not_pending" };
  const confirmedAt = Math.floor(Date.now() / 1000);
  await adapter.setMfa({ ...current, confirmedAt, backupCodeHashes: hashes });
  return { ok: true, backupCodes: codes };
}

/**
 * Check a second-factor code for a user with a confirmed factor: first as a TOTP code
 * (claiming its step — a replay is refused), else as a backup code (spent on a match).
 *
 * @param config The app's auth config.
 * @param input The user, and the code they typed (TOTP digits or a backup code, hyphen
 * optional).
 * @returns `{ ok: true, method }` (`"totp"` or `"bcp"`), or `{ ok: false, error }`.
 */
export async function verifySecondFactor(
  config: AuthConfig,
  input: { userId: string; code: string },
): Promise<SecondFactorResult> {
  const { userId, code } = input;
  const options = resolveAuthOptions(config);
  const adapter = mfaAdapter(options);
  const record = await adapter?.getMfa(userId);
  if (!adapter || !isConfirmed(record)) return { ok: false, error: "not_enrolled" };
  if (await claimTotp(options, adapter, record, code)) return { ok: true, method: "totp" };
  // A code that can't be a backup code (a mistyped 6-digit TOTP) skips the walk: it would run
  // the hasher once per stored code and could never match.
  if (!isBackupCodeShaped(code)) return { ok: false, error: "invalid_code" };
  const spent = await adapter.consumeBackupCode(userId, backupCodeMatcher(options.hasher, code));
  return spent ? { ok: true, method: "bcp" } : { ok: false, error: "invalid_code" };
}

/**
 * Remove a user's TOTP factor and backup codes. A no-op for a user who never enrolled.
 * Callers must have proved a fresh factor first — see the `/mfa/disable` endpoint.
 *
 * @param config The app's auth config.
 * @param userId The user.
 * @throws {Error} When the adapter has no MFA group.
 */
export async function disableTotp(config: AuthConfig, userId: string): Promise<void> {
  const adapter = requireMfaAdapter(resolveAuthOptions(config), "disableTotp");
  if (!(await adapter.getMfa(userId))) return;
  await adapter.setMfa({ userId, secret: "", backupCodeHashes: [] });
}

/**
 * Whether `session` carries a second-factor proof recent enough for a sensitive action:
 * its `amr` includes `totp` or `bcp` and it authenticated at most `mfa.freshness` seconds
 * ago — measured from `authTime`, which sliding expiry never moves.
 *
 * A session issued before 2.5.0-rc.3 has no `authTime`; it is measured from `issuedAt`
 * instead, and never counts with sliding expiry on (a slide re-stamps `issuedAt`).
 *
 * @param options The resolved auth options.
 * @param session A complete session.
 * @param nowMs The clock, in epoch ms (injectable for tests).
 * @returns `true` when the session's own second factor still counts as fresh.
 */
export function hasFreshFactor(
  options: ResolvedAuthOptions,
  session: AuthSession,
  nowMs: number = Date.now(),
): boolean {
  const provedAt = session.authTime ?? (options.updateAge > 0 ? undefined : session.issuedAt);
  if (provedAt === undefined) return false;
  const proved = (session.amr ?? []).some((method) => method === "totp" || method === "bcp");
  const age = Math.floor(nowMs / 1000) - provedAt;
  return proved && age >= 0 && age <= options.mfa.freshness;
}

/** The shortest window `/mfa/enroll` allows, so `mfa.freshness: 0` can't make enrolling impossible. */
const ENROLL_MIN_WINDOW = 300;

/**
 * Whether `session` signed in recently enough to set up its own second factor: its
 * `authTime` is at most `mfa.freshness` seconds old (never less than five minutes). Without
 * this a stolen session could enroll a factor, locking the owner out at the next sign-in. A
 * session issued before 2.5.0-rc.3 carries no `authTime` and does not count.
 *
 * @param options The resolved auth options.
 * @param session A complete session.
 * @param nowMs The clock, in epoch ms (injectable for tests).
 * @returns `true` when the sign-in is recent.
 */
export function recentlyAuthenticated(
  options: ResolvedAuthOptions,
  session: AuthSession,
  nowMs: number = Date.now(),
): boolean {
  if (session.authTime === undefined) return false;
  const age = Math.floor(nowMs / 1000) - session.authTime;
  return age >= 0 && age <= Math.max(options.mfa.freshness, ENROLL_MIN_WINDOW);
}

/**
 * Finish a step-up: mint a **fresh** complete session for the pending one's user —
 * never upgrade the pending session in place (session fixation). A store-backed pending
 * session's record is deleted first; a stateless one is replaced by the new cookie. The
 * new session's `amr` is the pending one's plus `method`. Fires `signIn` — the event a
 * pending sign-in deferred.
 *
 * @param ctx The route context.
 * @param session The pending session the second factor was proven for.
 * @param method How the second factor was proven.
 * @returns The new, complete session.
 */
export async function completeStepUp(
  ctx: AuthRouteContext,
  session: AuthSession,
  method: MfaMethod,
): Promise<AuthSession> {
  if (session.sessionId) await ctx.options.sessionStore?.delete(session.sessionId);
  const fresh = await issueAuthSession(ctx.config, session.user, session.provider, {
    amr: [...(session.amr ?? []), method],
  });
  await emitAuthEvent(ctx.options, "signIn", {
    user: session.user,
    provider: session.provider,
    isNewUser: false,
  });
  return fresh;
}
