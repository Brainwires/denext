"use server";

// Server Actions for the account flows. Each `<form action={fn}>` works with
// JavaScript disabled (denext renders a same-origin, CSRF-checked endpoint).
//
// Every write goes through the auth ADAPTER (lib/users.ts) — this app keeps no user table
// of its own, so `session.user.id` and the stored record are always the same identity.

import { redirect } from "denext";
import { requestEmailVerification, revokeAllSessions } from "denext/server";
import { authConfig } from "../lib/auth-config.ts";
import { signedIn } from "../lib/session.ts";
import { checkPassword, createAccount, findUser, setPassword } from "../lib/users.ts";

/** A form field as text ("" when absent). */
const field = (formData: FormData, name: string): string => String(formData.get(name) ?? "");

/** The registration error code, or null when the input is acceptable. */
async function registrationError(email: string, password: string): Promise<string | null> {
  if (!email.includes("@") || password.length < 8) return "invalid";
  return await findUser(email) ? "taken" : null;
}

/** Create an account: the adapter user, its credentials account row, and a scrypt hash. */
export async function register(formData: FormData): Promise<void> {
  const email = field(formData, "email").trim().toLowerCase();
  const password = field(formData, "password");
  const error = await registrationError(email, password);
  if (error) redirect(`/register?error=${error}`);
  await createAccount(email, field(formData, "name").trim(), password);
  redirect("/login?registered=1");
}

/** Change the password, then revoke every session — a stolen cookie is now useless. */
export async function changePassword(formData: FormData): Promise<void> {
  const session = await signedIn();
  const user = await findUser(session.user.email ?? "");
  const next = field(formData, "next");
  if (!await checkPassword(user, field(formData, "current"))) {
    redirect("/dashboard?error=current");
  }
  if (next.length < 8) redirect("/dashboard?error=weak");
  await setPassword(session.user.id, next);
  await revokeAllSessions(session.user.id);
  redirect("/login?changed=1");
}

/** "Sign out everywhere": revoke every session of the current user, on every device. */
export async function signOutEverywhere(): Promise<void> {
  const session = await signedIn();
  await revokeAllSessions(session.user.id);
  redirect("/?everywhere=1");
}

/**
 * Email the signed-in user a verification link. The mail goes out AFTER the response
 * (`after()`), and an already-verified address is sent nothing — the page hides the form then.
 */
export async function sendVerificationEmail(): Promise<void> {
  const session = await signedIn("/verify-email");
  const result = await requestEmailVerification(authConfig, session.user.email ?? "");
  redirect(result.throttled ? "/verify-email?error=throttled" : "/verify-email?sent=1");
}
