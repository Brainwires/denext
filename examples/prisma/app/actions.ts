"use server";

// The write path: `addNote` runs only on the server (it uses the Prisma client) and
// is exposed as a secure, same-origin POST endpoint. The native <form action> posts
// here with no client JavaScript.

import { addNote } from "../lib/db.ts";

/** Native-form action: validate + insert one note via Prisma. */
export async function createNote(formData: FormData): Promise<void> {
  const title = String(formData.get("title") ?? "").trim();
  if (title && title.length <= 200) await addNote(title);
}
