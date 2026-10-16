/**
 * Multi-factor authentication: the step-up decision the sign-in tails consult, TOTP
 * enrollment (`enrollTotp` → `confirmTotp`), verification (`verifySecondFactor`: a TOTP code
 * from any TOTP factor, an SMS challenge's code, or a single-use backup code), `disableTotp`,
 * and the step-up that turns a pending session into a complete one (`completeStepUp`). The
 * factors themselves live in the one store `/auth/v1` shares ({@link ./factors.ts | factors}).
 *
 * Three guards hold on every code check: a TOTP code is accepted within ±`mfa.window`
 * steps and its step is then **claimed** on its factor through the adapter's atomic
 * `claimMfaFactorStep` (so the same code can't be presented twice); a backup code is spent
 * through the adapter's atomic `consumeBackupCode` (stored only as a
 * {@link ./hasher.ts | Hasher} hash); and the attempt budget is spent by the HTTP layer
 * ({@link ./routes-mfa.ts | the MFA routes}).
 *
 * **At rest.** A TOTP secret reaches the adapter sealed (AES-256-GCM under a key derived
 * from the auth `secret`, bound to its factor, see {@link ./totp-seal.ts | totp-seal}) and is
 * opened only to verify a code; one sealed under a rotated-out `secret` still in the list is
 * re-sealed under the current one after a code it accepts.
 *
 * @module
 */

import type { AuthAdapter } from "./adapter.ts";
import { isBanned } from "./ban.ts";
import { backupCodeMatcher, generateBackupCodes, isBackupCodeShaped } from "./backup-codes.ts";
import { emitAuthEvent } from "./events.ts";
import { resolveAuthOptions, type ResolvedAuthOptions } from "./options.ts";
import { consumeHitBudget, mfaLimiter, subjectBucketKeys } from "./rate-limit.ts";
import { currentContext } from "../request-context.ts";
import type { AuthRouteContext } from "./routes-shared.ts";
import { issueAuthSession } from "./session.ts";
import {
  factorStoreOf,
  hasVerifiedFactor,
  markFactorVerified,
  phoneCodeMatches,
  redeemFactorChallenge,
  totpFactorAccepts,
  userFactors,
  verifiedTotpFactorFor,
} from "./factors.ts";
import { generateTotpSecret, totpAuthUri } from "./totp.ts";
import { authSecrets, sealTotpSecret } from "./totp-seal.ts";
import type { AuthConfig, AuthSession, AuthUser } from "./types.ts";

/** The adapter methods the MFA flows need, all present: backup codes and the factor store. */
type MfaAdapter = Required<Pick<AuthAdapter, "getMfa" | "setMfa" | "consumeBackupCode">>;

/**
 * A second factor a step-up can be completed with: a TOTP code, a backup code, an SMS code
 * (`"sms"`), or a passkey (`"hwk"`, RFC 8176's proof of possession of a hardware-secured key).
 */
export type MfaMethod = "totp" | "bcp" | "hwk" | "sms";

/** A user's second-factor state, as {@linkcode mfaStatus} reports it. */
export interface MfaStatus {
  /**
   * A verified factor (TOTP, phone or WebAuthn) is on file, so sign-in asks for it — what
   * `mfa.required: "enrolled"` means by enrolled.
   */
  enrolled: boolean;
  /** A TOTP enrollment was started but not yet confirmed with a code (and none is verified). */
  pendingConfirmation: boolean;
  /** Unspent backup codes (`0` when there are none). */
  backupCodesRemaining: number;
}

/** A fresh, unconfirmed TOTP enrollment, as {@linkcode enrollTotp} returns it. */
export interface TotpEnrollment {
  /** The factor's id (it is also listed by `/auth/v1` as a TOTP factor). */
  factorId: string;
  /** The base32 secret, for manual entry into an authenticator app. */
  secret: string;
  /** The `otpauth://totp/…` provisioning URI — render it as a QR code. */
  uri: string;
}

/**
 * The outcome of {@linkcode enrollTotp}: the fresh secret and its URI, or why none was minted
 * — `"already_enrolled"` (a verified TOTP factor exists and this session did not just prove a
 * second factor) or `"reauth_required"` (a complete session that didn't sign in recently).
 */
export type EnrollTotpResult =
  | ({ ok: true } & TotpEnrollment)
  | { ok: false; error: "already_enrolled" | "reauth_required" };

/**
 * The outcome of {@linkcode confirmTotp}: on success, the plaintext backup codes — the
 * only time they exist anywhere; show them to the user once (empty when the user already had
 * a verified factor, whose codes stay valid). `"invalid_code"`: a wrong or replayed code.
 * `"not_pending"`: no enrollment awaits confirmation.
 */
export type ConfirmTotpResult =
  | { ok: true; backupCodes: string[] }
  | { ok: false; error: "invalid_code" | "not_pending" };

/**
 * The outcome of {@linkcode verifySecondFactor}: the method that verified, or why nothing did
 * — `"invalid_code"` (wrong, replayed or spent) or `"not_enrolled"` (no verified factor).
 */
export type SecondFactorResult =
  | { ok: true; method: MfaMethod; factorId?: string }
  | { ok: false; error: "invalid_code" | "not_enrolled" };

/**
 * Whether signing `user` in must stop at a pending session that still owes a second
 * factor. `mfa.required: "always"` says yes for everyone (an unenrolled user is sent to
 * enrol); the default `"enrolled"` says yes only for a user with a verified factor — the same
 * rule that makes an `/auth/v1` session `aal1`. Without the factor store nobody is enrolled.
 *
 * @param config The app's auth config.
 * @param user The user the first factor authenticated.
 * @returns `true` when the session must be issued as MFA-pending.
 */
export async function mfaPendingFor(config: AuthConfig, user: AuthUser): Promise<boolean> {
  if (resolveAuthOptions(config).mfa.required === "always") return true;
  return await hasVerifiedFactor(config, user.id);
}

/** The adapter when it implements the backup codes and the factor store, else `undefined`. */
function mfaAdapter(options: ResolvedAuthOptions): MfaAdapter | undefined {
  const adapter = options.adapter;
  if (!adapter?.getMfa || !adapter.setMfa || !adapter.consumeBackupCode) return undefined;
  return factorStoreOf(adapter) ? adapter as MfaAdapter : undefined;
}

/**
 * Whether the configured adapter can run the MFA flows — it implements the factor group
 * (`createMfaFactor`, `listMfaFactors`, `updateMfaFactor`, `claimMfaFactorStep`,
 * `deleteMfaFactor`) and the backup-code record (`getMfa`, `setMfa`, `consumeBackupCode`).
 * Without them the MFA endpoints don't exist (a plain 404).
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
    `${fn}: the configured \`adapter\` has no MFA factor store (\`createMfaFactor\`, ` +
      "`listMfaFactors`, `updateMfaFactor`, `claimMfaFactorStep`, `deleteMfaFactor`) and " +
      "backup codes (`getMfa`, `setMfa`, `consumeBackupCode`) — use `sqliteAuthAdapter({ path })`, " +
      "`postgresAuthAdapter()`, or `inMemoryAuthAdapter()` in tests.",
  );
}

/**
 * A user's second-factor state — for an account-settings page.
 *
 * @param config The app's auth config.
 * @param userId The user.
 * @returns Whether a verified factor is on file, whether a TOTP enrollment awaits
 * confirmation, and how many backup codes remain.
 */
export async function mfaStatus(config: AuthConfig, userId: string): Promise<MfaStatus> {
  const factors = await userFactors(config, userId);
  const enrolled = factors.some((f) => f.status === "verified");
  const record = await resolveAuthOptions(config).adapter?.getMfa?.(userId);
  return {
    enrolled,
    pendingConfirmation: !enrolled &&
      factors.some((f) => f.type === "totp" && f.status === "unverified"),
    backupCodesRemaining: record?.backupCodeHashes.length ?? 0,
  };
}

/**
 * Start a TOTP enrollment: mint a secret, store it as an **unverified** TOTP factor, and return
 * it with the provisioning URI (issuer `mfa.issuer`, account `user.email ?? user.id`). Earlier
 * unverified TOTP factors are replaced. While a verified TOTP factor exists another one is
 * added only from a session that proved a second factor recently (`hasFreshFactor`), and a
 * pending session adds none while any verified factor exists; otherwise the answer is
 * `already_enrolled` — a first factor alone must never add a factor next to one.
 *
 * From a complete session this needs a recent sign-in (`session.authTime` within
 * `mfa.freshness`, five minutes at least), exactly as `POST {basePath}/mfa/enroll` does: a
 * stolen long-lived session must not set up a factor of its own and lock the owner out. A
 * pending session (`mfa.required: "always"`) is minutes old and may enroll.
 *
 * @param config The app's auth config.
 * @param session The enrolling user's session (`auth()`, or `pendingMfaSession()`).
 * @returns `{ ok: true, factorId, secret, uri }`, or `{ ok: false, error }`.
 * @throws {Error} When the adapter has no MFA factor store.
 */
export async function enrollTotp(
  config: AuthConfig,
  session: AuthSession,
): Promise<EnrollTotpResult> {
  const options = resolveAuthOptions(config);
  requireMfaAdapter(options, "enrollTotp");
  if (!session.mfaPending && !recentlyAuthenticated(options, session)) {
    return { ok: false, error: "reauth_required" };
  }
  const user = session.user;
  const store = factorStoreOf(options.adapter)!;
  const factors = await userFactors(config, user.id);
  const verified = factors.some((f) => f.type === "totp" && f.status === "verified");
  // A pending session (a first factor alone) never adds a factor next to a verified one of any
  // kind — confirming it would complete the step-up; a complete one adds a second
  // authenticator only with a fresh second factor of its own.
  const owes = factors.some((f) => f.status === "verified");
  if (session.mfaPending ? owes : verified && !hasFreshFactor(options, session)) {
    return { ok: false, error: "already_enrolled" };
  }
  for (const stale of factors.filter((f) => f.type === "totp" && f.status === "unverified")) {
    await store.deleteMfaFactor(stale.id);
  }
  const secret = generateTotpSecret();
  const id = crypto.randomUUID();
  const at = Math.floor(Date.now() / 1000);
  await store.createMfaFactor({
    id,
    userId: user.id,
    type: "totp",
    status: "unverified",
    friendlyName: verified ? `Authenticator ${factors.length + 1}` : "Authenticator",
    secret: await sealTotpSecret(authSecrets(config.secret), `${user.id}:${id}`, secret),
    createdAt: at,
    updatedAt: at,
  });
  const account = user.email ?? user.id;
  return {
    ok: true,
    factorId: id,
    secret,
    uri: totpAuthUri({ secret, account, issuer: options.mfa.issuer }),
  };
}

/**
 * Confirm a pending TOTP enrollment with a code from the authenticator app. On success the
 * factor is verified and — for a user's first verified factor — `mfa.backupCodes` backup
 * codes are minted, returned here in plaintext exactly once and stored only as hashes. The
 * code's step is claimed, so it can't then be replayed at the step-up.
 *
 * @param config The app's auth config.
 * @param input The user confirming, and the code they typed.
 * @returns `{ ok: true, backupCodes }`, or `{ ok: false, error }`.
 * @throws {Error} When the adapter has no MFA factor store.
 */
export async function confirmTotp(
  config: AuthConfig,
  input: { user: AuthUser; code: string },
): Promise<ConfirmTotpResult> {
  const { user, code } = input;
  const options = resolveAuthOptions(config);
  const adapter = requireMfaAdapter(options, "confirmTotp");
  const factors = await userFactors(config, user.id);
  const pending = factors.filter((f) => f.type === "totp" && f.status === "unverified").at(-1);
  if (!pending) return { ok: false, error: "not_pending" };
  if (!await totpFactorAccepts(config, pending, code, options.mfa.window)) {
    return { ok: false, error: "invalid_code" };
  }
  const firstFactor = !factors.some((f) => f.status === "verified");
  await markFactorVerified(config, pending);
  if (!firstFactor) return { ok: true, backupCodes: [] };
  const { codes, hashes } = await generateBackupCodes(options.hasher, options.mfa.backupCodes);
  const record = await adapter.getMfa(user.id);
  await adapter.setMfa({
    ...(record ?? { userId: user.id }),
    secret: "",
    confirmedAt: Math.floor(Date.now() / 1000),
    backupCodeHashes: hashes,
  });
  return { ok: true, backupCodes: codes };
}

/**
 * Check a second-factor proof for a user with a verified factor: a TOTP code from any of their
 * TOTP factors (its step claimed — a replay is refused), the code of an open SMS challenge
 * (`challengeId`), or a backup code (spent on a match).
 *
 * @param config The app's auth config.
 * @param input The user, the code they typed (TOTP digits, an SMS code or a backup code, hyphen
 * optional), and for an SMS code the challenge it answers.
 * @returns `{ ok: true, method, factorId? }`, or `{ ok: false, error }`.
 */
export async function verifySecondFactor(
  config: AuthConfig,
  input: { userId: string; code: string; challengeId?: string; factorId?: string },
): Promise<SecondFactorResult> {
  const { userId, code } = input;
  const options = resolveAuthOptions(config);
  const adapter = mfaAdapter(options);
  if (!adapter || !(await hasVerifiedFactor(config, userId))) {
    return { ok: false, error: "not_enrolled" };
  }
  if (input.challengeId && input.factorId) return await phoneStep(config, input);
  const totp = await verifiedTotpFactorFor(config, userId, code, options.mfa.window);
  if (totp) return { ok: true, method: "totp", factorId: totp.id };
  // A code that can't be a backup code (a mistyped 6-digit TOTP) skips the walk: it would run
  // the hasher once per stored code and could never match.
  if (!isBackupCodeShaped(code)) return { ok: false, error: "invalid_code" };
  const spent = await adapter.consumeBackupCode(userId, backupCodeMatcher(options.hasher, code));
  return spent ? { ok: true, method: "bcp" } : { ok: false, error: "invalid_code" };
}

/** An SMS code answering an open challenge of one of the user's verified phone factors. */
async function phoneStep(
  config: AuthConfig,
  input: { userId: string; code: string; challengeId?: string; factorId?: string },
): Promise<SecondFactorResult> {
  const factor = (await userFactors(config, input.userId)).find((f) =>
    f.id === input.factorId && f.type === "phone" && f.status === "verified"
  );
  const challenge = factor && await redeemFactorChallenge(config, input.challengeId!, factor);
  const ok = !!challenge && !challenge.expired &&
    await phoneCodeMatches(input.challengeId!, input.code, challenge.codeHash);
  return ok
    ? { ok: true, method: "sms", factorId: factor!.id }
    : { ok: false, error: "invalid_code" };
}

/**
 * Remove a user's TOTP factors — and their backup codes when no other verified factor remains.
 * A no-op for a user without one. Callers must have proved a fresh factor first — see the
 * `/mfa/disable` endpoint.
 *
 * It is also the **administrator's recovery** for a factor no configured `secret` opens any
 * more (a `secret` replaced rather than rotated, or an altered row): such a user can't pass a
 * TOTP check, so without a backup code or a passkey with user verification they can't reach
 * `/mfa/disable` themselves, and `enrollTotp` keeps answering `already_enrolled` — by design,
 * since a pending (password-only) session may enroll and must not be able to replace a factor.
 * Verify the user's identity out of band, call this, and they enroll again.
 *
 * @param config The app's auth config.
 * @param userId The user.
 * @throws {Error} When the adapter has no MFA factor store.
 */
export async function disableTotp(config: AuthConfig, userId: string): Promise<void> {
  const options = resolveAuthOptions(config);
  const adapter = requireMfaAdapter(options, "disableTotp");
  const store = factorStoreOf(options.adapter)!;
  const factors = await userFactors(config, userId);
  for (const factor of factors.filter((f) => f.type === "totp")) {
    await store.deleteMfaFactor(factor.id);
  }
  if (factors.some((f) => f.type !== "totp" && f.status === "verified")) return;
  if (!(await adapter.getMfa(userId))) return;
  if (options.adapter?.deleteMfa) await options.adapter.deleteMfa(userId);
  else await adapter.setMfa({ userId, secret: "", backupCodeHashes: [] });
}

/**
 * Whether `session` carries a second-factor proof recent enough for a sensitive action:
 * its `amr` includes `totp`, `bcp` or `mfa` (a passkey with user verification, or a passkey
 * step-up) and it authenticated at most `mfa.freshness` seconds
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
  const proved = (session.amr ?? []).some((method) =>
    method === "totp" || method === "bcp" || method === "mfa"
  );
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
 * Whether a session that still owes its second factor may go on toward a complete one. What
 * would have revoked a stateless pending cookie is checked here too (besides the
 * `sessionsValidAfter` every read applies), from the stored user: the user still exists, is not banned, and had its first address proof
 * (which retires every session set up before it) no later than this sign-in.
 *
 * @param config The app's auth config.
 * @param session The pending session.
 * @param nowMs The clock, in epoch ms.
 * @returns `true` when the step-up may proceed.
 */
export async function pendingSessionLive(
  config: AuthConfig,
  session: AuthSession,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const adapter = resolveAuthOptions(config).adapter;
  if (!adapter) return true;
  const user = await adapter.getUser(session.user.id);
  if (!user || isBanned(user, Math.floor(nowMs / 1000))) return false;
  const proofs = [user.emailVerified, user.phoneVerified].filter((t): t is number =>
    typeof t === "number"
  );
  const firstProof = proofs.length ? Math.min(...proofs) : undefined;
  return firstProof === undefined || session.authTime === undefined ||
    session.authTime >= firstProof;
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
  // A passkey step-up records the key AND that the session is now multi-factor (`mfa`), which
  // is what `hasFreshFactor` reads — `hwk` alone is also what a one-factor passkey sign-in says.
  const added = method === "hwk" ? ["hwk", "mfa"] : [method];
  const fresh = await issueAuthSession(ctx.config, session.user, session.provider, {
    amr: [...(session.amr ?? []), ...added],
    ...(session.saml ? { saml: session.saml } : {}),
  });
  await emitAuthEvent(ctx.options, "signIn", {
    user: session.user,
    provider: session.provider,
    isNewUser: false,
  });
  return fresh;
}

/** The outcome of {@linkcode spendMfaAttempt}. */
export type MfaAttemptResult =
  | { ok: true }
  | { ok: false; error: "rate_limited"; retryAfter: number };

/**
 * Spend one second-factor attempt from the user's MFA budget — the one the
 * `POST {basePath}/mfa*` endpoints spend — before a Server Action checks a code with
 * {@linkcode verifySecondFactor} or {@linkcode confirmTotp}, which spend nothing themselves.
 * Every attempt counts, right or wrong, so a correct guess never resets the count. The per-user
 * budget is `rateLimit.mfa` (5 per 5 minutes by default), and the client IP's bucket counts too
 * when a request is in scope. Pass the config you passed to `denextAuth()` so the endpoints and
 * your actions share one budget.
 *
 * @param config The app's auth config.
 * @param input The user, and optionally the request (default: the one being handled).
 * @returns `{ ok: true }` — check the code — or `{ ok: false, error: "rate_limited", retryAfter }`
 *   with the seconds until the budget refills.
 */
export async function spendMfaAttempt(
  config: AuthConfig,
  input: { userId: string; request?: Request },
): Promise<MfaAttemptResult> {
  const request = input.request ?? currentContext()?.request;
  const keys = subjectBucketKeys("mfa", input.userId, request, config);
  const retryAfter = await consumeHitBudget(mfaLimiter(config), keys);
  return retryAfter === null ? { ok: true } : { ok: false, error: "rate_limited", retryAfter };
}
