"use server";

// Server Actions for the account flows. Each `<form action={fn}>` works with
// JavaScript disabled (denext renders a same-origin, CSRF-checked endpoint).
//
// Every write goes through the auth ADAPTER (lib/users.ts) — this app keeps no user table
// of its own, so `session.user.id` and the stored record are always the same identity.

import { redirect } from "denext";
import { auth, type AuthSession, revokeAllSessions } from "denext/server";
import { checkPassword, createAccount, findUser, setPassword } from "../lib/users.ts";

/** A form field as text ("" when absent). */
const field = (formData: FormData, name: string): string => String(formData.get(name) ?? "");

/** The signed-in session, or a redirect to the login page. */
async function requireSession(): Promise<AuthSession> {
  const session = await auth();
  if (!session) redirect("/login");
  return session!;
}

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
  const session = await requireSession();
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
  const session = await requireSession();
  await revokeAllSessions(session.user.id);
  redirect("/?everywhere=1");
}
