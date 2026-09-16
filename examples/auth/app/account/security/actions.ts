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
  spendMfaAttempt,
  verifySecondFactor,
} from "denext/server";
import { authConfig } from "../../../lib/auth-config.ts";
import { onceKey, stashOnce } from "../../../lib/once.ts";
import { signedIn } from "../../../lib/session.ts";

/** Where every action lands. */
const PAGE = "/account/security";

/**
 * Spend one code attempt from the user's MFA budget — the same one the /auth/mfa endpoints
 * spend. EVERY attempt counts, right or wrong, so a correct guess never resets the count and a
 * stolen session can't brute-force its way to turning the factor off. `true` once it is gone.
 */
async function overBudget(userId: string): Promise<boolean> {
  return !(await spendMfaAttempt(authConfig, { userId })).ok;
}

/** The submitted code ("" when absent). */
function codeOf(formData: FormData): string {
  return String(formData.get("code") ?? "").trim();
}

/** Start an enrolment: a fresh secret, stored UNCONFIRMED, shown on the next render. */
export async function startEnrolment(): Promise<void> {
  const session = await signedIn(PAGE);
  // enrollTotp() refuses a session that didn't sign in recently, as /auth/mfa/enroll does.
  const enrolment = await enrollTotp(authConfig, session);
  if (!enrolment.ok) {
    redirect(
      enrolment.error === "reauth_required"
        ? `/login?error=reauth&callbackUrl=${PAGE}`
        : `${PAGE}?error=enrolled`,
    );
  }
  const { secret, uri } = enrolment;
  stashOnce(onceKey(session, "totp"), JSON.stringify({ secret, uri }));
  redirect(`${PAGE}?step=confirm`);
}

/** Confirm the enrolment with the app's first code; the backup codes are shown once. */
export async function confirmEnrolment(formData: FormData): Promise<void> {
  const session = await signedIn(PAGE);
  if (await overBudget(session.user.id)) redirect(`${PAGE}?error=throttled`);
  const result = await confirmTotp(authConfig, { user: session.user, code: codeOf(formData) });
  if (!result.ok) redirect(`${PAGE}?error=confirm`);
  stashOnce(onceKey(session, "backup"), JSON.stringify(result.backupCodes));
  redirect(`${PAGE}?confirmed=1`);
}

/** Turn the factor off — only with a current TOTP code or an unused backup code. */
export async function disableTwoFactor(formData: FormData): Promise<void> {
  const session = await signedIn(PAGE);
  if (await overBudget(session.user.id)) redirect(`${PAGE}?error=throttled`);
  const code = codeOf(formData);
  if (!(await verifySecondFactor(authConfig, { userId: session.user.id, code })).ok) {
    redirect(`${PAGE}?error=code`);
  }
  await disableTotp(authConfig, session.user.id);
  redirect(`${PAGE}?disabled=1`);
}
