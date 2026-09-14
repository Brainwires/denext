// The DEVELOPMENT mailer. denext ships no mailer: every emailed token — an email
// verification link, a password-reset link, a magic sign-in link — is handed to the
// `sendVerificationRequest` you configure. This one keeps the message in an in-process
// outbox (listed at /dev/outbox, so you can click the links) and prints the link.
//
// A real app plugs its mail service in here instead — an SMTP relay, Postmark, SES, Resend
// — and sends `url` to `identifier`. In production this mailer REFUSES: a reset link on a
// page or in a log is a live credential, so nothing is captured or printed there, and the
// flows stay silent until a real mailer is configured (denext logs the failed delivery
// through `logger.error`, never the link).

import type { SendVerificationRequest, VerificationRequestParams } from "denext/server";
import { isProduction } from "./env.ts";

/** One captured message. */
export interface Mail extends VerificationRequestParams {
  /** When it was "sent", epoch ms. */
  sentAt: number;
}

/** The most messages kept; older ones are dropped first. */
const MAX_MAIL = 50;

/** What each purpose's message would say in its subject line. */
const SUBJECTS: Record<Mail["purpose"], string> = {
  email: "Verify your email address",
  reset: "Reset your password",
  magic: "Your sign-in link",
  otp: "Your sign-in code",
};

// The outbox lives on `globalThis`, not in a module variable: the auth plugin is loaded
// with denext.config.ts and the pages with the app, and a dev-server reload re-evaluates
// modules — one shared list keeps every copy of this module writing to the same place.
const KEY = Symbol.for("denext.examples.auth.outbox");
const store = globalThis as typeof globalThis & { [KEY]?: Mail[] };

/** The captured messages, oldest first. */
function mailbox(): Mail[] {
  store[KEY] ??= [];
  return store[KEY];
}

/**
 * The subject line a message would carry.
 *
 * @param mail A captured message.
 * @returns A human-readable subject.
 */
export function subjectOf(mail: Mail): string {
  return SUBJECTS[mail.purpose];
}

/**
 * Every captured message, newest first — empty in production, where nothing is captured.
 *
 * @returns The messages.
 */
export function listMail(): Mail[] {
  return isProduction() ? [] : [...mailbox()].reverse();
}

/** The development `sendVerificationRequest`: capture, and print the link. */
export const devMailer: SendVerificationRequest = (params) => {
  if (isProduction()) {
    throw new Error(
      "examples/auth: no mail service is configured — replace devMailer (lib/outbox.ts) " +
        "with one before deploying",
    );
  }
  const box = mailbox();
  box.push({ ...params, sentAt: Date.now() });
  if (box.length > MAX_MAIL) box.splice(0, box.length - MAX_MAIL);
  console.log(`[mail] ${SUBJECTS[params.purpose]} → ${params.identifier}: ${params.url}`);
};
