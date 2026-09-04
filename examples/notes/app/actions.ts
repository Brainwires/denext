"use server";

// Every exported async function here is a Server Action. Each `<form action={fn}>`
// posts to a generated, same-origin-checked endpoint and works with JavaScript
// disabled — denext renders the endpoint URL into the form and 303-redirects back
// after the action runs.

import { redirect, RedirectType } from "denext";
import { verifyPassword } from "../lib/crypto.ts";
import { createNote, deleteNote, findUserByEmail, getNote, updateNote } from "../lib/db.ts";
import { currentUser, session } from "../lib/auth.ts";

/** Only allow redirecting to a local path (no open redirect). */
function safeNext(next: unknown): string {
  const p = String(next ?? "");
  return p.startsWith("/") && !p.startsWith("//") ? p : "/notes";
}

const visibilityOf = (v: unknown): "public" | "private" => v === "public" ? "public" : "private";

/** A form field as trimmed text ("" when absent). */
const field = (formData: FormData, name: string): string => String(formData.get(name) ?? "").trim();

/** The signed-in user, or a redirect to the login page. */
async function requireUser(): Promise<
  NonNullable<Awaited<ReturnType<typeof currentUser>>>
> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user!;
}

/** Sign in: verify credentials, store the user id in the session, redirect. */
export async function login(formData: FormData): Promise<void> {
  const next = safeNext(formData.get("next"));
  const user = await authenticate(
    field(formData, "email").toLowerCase(),
    String(formData.get("password") ?? ""),
  );
  if (!user) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  await (await session()).set({ userId: user!.id });
  redirect(next);
}

/** The user for a valid email + password pair, else null. */
async function authenticate(email: string, password: string) {
  const user = findUserByEmail(email);
  if (!user) return null;
  return (await verifyPassword(password, user.password_hash)) ? user : null;
}

/** Sign out: clear the session and return to the login page. */
export async function logout(): Promise<void> {
  (await session()).clear();
  redirect("/login");
}

/** Create a note owned by the current user. */
export async function create(formData: FormData): Promise<void> {
  const user = await requireUser();
  const title = field(formData, "title");
  if (title) {
    createNote(
      user.id,
      title,
      field(formData, "body"),
      visibilityOf(formData.get("visibility")),
    );
  }
  // `RedirectType.push` (Next parity): a soft navigation PUSHES a history entry, so Back
  // returns to the form instead of skipping it (the default replaces the entry).
  redirect("/notes", RedirectType.push);
}

/** Update a note — only if the current user owns it. */
export async function update(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const title = field(formData, "title");
  if (ownsNote(user.id, id) && title) {
    updateNote(
      id,
      title,
      field(formData, "body"),
      visibilityOf(formData.get("visibility")),
    );
  }
  redirect("/notes");
}

/** Whether note `id` exists and belongs to `userId`. */
function ownsNote(userId: number, id: number): boolean {
  const note = getNote(id);
  return note !== undefined && note !== null && note.user_id === userId;
}

/** Delete a note — only if the current user owns it. */
export async function remove(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = Number(formData.get("id"));
  const note = getNote(id);
  if (note && note.user_id === user!.id) deleteNote(id);
  redirect("/notes");
}
