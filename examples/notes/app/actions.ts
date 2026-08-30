"use server";

// Every exported async function here is a Server Action. Each `<form action={fn}>`
// posts to a generated, same-origin-checked endpoint and works with JavaScript
// disabled — denext renders the endpoint URL into the form and 303-redirects back
// after the action runs.

import { redirect } from "denext";
import { verifyPassword } from "../lib/crypto.ts";
import { createNote, deleteNote, findUserByEmail, getNote, updateNote } from "../lib/db.ts";
import { currentUser, session } from "../lib/auth.ts";

/** Only allow redirecting to a local path (no open redirect). */
function safeNext(next: unknown): string {
  const p = String(next ?? "");
  return p.startsWith("/") && !p.startsWith("//") ? p : "/notes";
}

const visibilityOf = (v: unknown): "public" | "private" => v === "public" ? "public" : "private";

/** Sign in: verify credentials, store the user id in the session, redirect. */
export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  const user = findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  await (await session()).set({ userId: user!.id });
  redirect(next);
}

/** Sign out: clear the session and return to the login page. */
export async function logout(): Promise<void> {
  (await session()).clear();
  redirect("/login");
}

/** Create a note owned by the current user. */
export async function create(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (title) {
    createNote(user!.id, title, body, visibilityOf(formData.get("visibility")));
  }
  redirect("/notes");
}

/** Update a note — only if the current user owns it. */
export async function update(formData: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const id = Number(formData.get("id"));
  const note = getNote(id);
  if (note && note.user_id === user!.id) {
    const title = String(formData.get("title") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();
    if (title) {
      updateNote(id, title, body, visibilityOf(formData.get("visibility")));
    }
  }
  redirect("/notes");
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
