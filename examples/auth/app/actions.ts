"use server";

// Server Actions for the account flows. Each `<form action={fn}>` works with
// JavaScript disabled (denext renders a same-origin, CSRF-checked endpoint).

import { redirect } from "denext";
import {
  auth,
  type AuthSession,
  hashPassword,
  revokeAllSessions,
  verifyPassword,
} from "denext/server";
import { createUser, findUserByEmail, updatePasswordHash, type UserRow } from "../lib/db.ts";

/** A form field as text ("" when absent). */
const field = (formData: FormData, name: string): string => String(formData.get(name) ?? "");

/** The signed-in session, or a redirect to the login page. */
async function requireSession(): Promise<AuthSession> {
  const session = await auth();
  if (!session) redirect("/login");
  return session!;
}

/** The registration error code, or null when the input is acceptable. */
function registrationError(email: string, password: string): string | null {
  if (!email.includes("@") || password.length < 8) return "invalid";
  return findUserByEmail(email) ? "taken" : null;
}

/** Create an account: the password is stored as a scrypt hash, never in the clear. */
export async function register(formData: FormData): Promise<void> {
  const email = field(formData, "email").trim().toLowerCase();
  const password = field(formData, "password");
  const error = registrationError(email, password);
  if (error) redirect(`/register?error=${error}`);
  createUser(
    email,
    field(formData, "name").trim(),
    await hashPassword(password),
  );
  redirect("/login?registered=1");
}

/** The change-password error code, or null when the change may proceed. */
async function passwordChangeError(
  row: UserRow | undefined,
  current: string,
  next: string,
): Promise<string | null> {
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return "current";
  }
  return next.length < 8 ? "weak" : null;
}

/** Change the password, then revoke every session — a stolen cookie is now useless. */
export async function changePassword(formData: FormData): Promise<void> {
  const session = await requireSession();
  const row = findUserByEmail(session.user.email ?? "");
  const next = field(formData, "next");
  const error = await passwordChangeError(
    row,
    field(formData, "current"),
    next,
  );
  if (error) redirect(`/dashboard?error=${error}`);
  updatePasswordHash(row!.id, await hashPassword(next));
  await revokeAllSessions(session.user.id);
  redirect("/login?changed=1");
}

/** "Sign out everywhere": revoke every session of the current user, on every device. */
export async function signOutEverywhere(): Promise<void> {
  const session = await requireSession();
  await revokeAllSessions(session.user.id);
  redirect("/?everywhere=1");
}
