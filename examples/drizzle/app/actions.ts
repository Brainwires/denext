"use server";

// A "use server" module: the write path. `addNote` runs only on the server (it
// touches the Drizzle/SQLite singleton) and is exposed as a secure, same-origin
// POST endpoint. The native <form action={createNote}> below posts here with no
// client JavaScript.

import { addNote } from "../lib/db.ts";

/** Native-form action: validate + insert one note via Drizzle. */
export function createNote(formData: FormData): void {
  const title = String(formData.get("title") ?? "").trim();
  if (title && title.length <= 200) addNote(title);
}
