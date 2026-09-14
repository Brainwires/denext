"use server";

// The TOTP second factor, as no-JS Server Actions: start an enrolment, confirm it with the
// first code (which mints the backup codes), and turn it off with a current code. denext
// also mounts JSON endpoints for a JavaScript client (POST /auth/mfa/enroll, /confirm and
// /disable); these actions call the same functions from `denext/server`.
//
// What these screens must show exactly once — the new secret, then the backup codes —
// reaches the next render through the single-use server-side slot (lib/once.ts), never the
// redirect URL.

import { redirect } from "denext";
import {
  confirmTotp,
  disableTotp,
  enrollTotp,
  inMemoryRateLimitStore,
  verifySecondFactor,
} from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";
import { onceKey, stashOnce } from "../../../lib/once.ts";
import { signedIn } from "../../../lib/session.ts";

/** Where every action lands. */
const PAGE = "/account/security";

/**
 * Code checks per user per window. As on the /auth/mfa endpoints EVERY attempt counts,
 * right or wrong, so a correct guess never resets the count — a stolen session can't
 * brute-force its way to turning the factor off.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60_000;
const attempts = inMemoryRateLimitStore({ lockoutAt: MAX_ATTEMPTS });

/** Spend one code attempt for `userId`; `true` once the window's budget is gone. */
async function overBudget(userId: string): Promise<boolean> {
  const window = await attempts.increment(`totp|${userId}`, WINDOW_MS);
  return window.count > MAX_ATTEMPTS;
}

/** The submitted code ("" when absent). */
function codeOf(formData: FormData): string {
  return String(formData.get("code") ?? "").trim();
}

/** Start an enrolment: a fresh secret, stored UNCONFIRMED, shown on the next render. */
export async function startEnrolment(): Promise<void> {
  const session = await signedIn(PAGE);
  const enrolment = await enrollTotp(authConfig, session.user);
  if (!enrolment) redirect(`${PAGE}?error=enrolled`);
  stashOnce(onceKey(session, "totp"), JSON.stringify(enrolment));
  redirect(`${PAGE}?step=confirm`);
}

/** Confirm the enrolment with the app's first code; the backup codes are shown once. */
export async function confirmEnrolment(formData: FormData): Promise<void> {
  const session = await signedIn(PAGE);
  if (await overBudget(session.user.id)) redirect(`${PAGE}?error=throttled`);
  const result = await confirmTotp(authConfig, session.user, codeOf(formData));
  if (!result.ok) redirect(`${PAGE}?error=confirm`);
  stashOnce(onceKey(session, "backup"), JSON.stringify(result.backupCodes));
  redirect(`${PAGE}?confirmed=1`);
}

/** Turn the factor off — only with a current TOTP code or an unused backup code. */
export async function disableTwoFactor(formData: FormData): Promise<void> {
  const session = await signedIn(PAGE);
  if (await overBudget(session.user.id)) redirect(`${PAGE}?error=throttled`);
  if (!await verifySecondFactor(authConfig, session.user.id, codeOf(formData))) {
    redirect(`${PAGE}?error=code`);
  }
  await disableTotp(authConfig, session.user.id);
  redirect(`${PAGE}?disabled=1`);
}
