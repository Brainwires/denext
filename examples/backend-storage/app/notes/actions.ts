"use server";
import { storage } from "@denext/backend/server";

/** Save the note: the `notes` bucket is versioned, so the previous text is kept. */
export async function saveNote(form: FormData): Promise<void> {
  const text = String(form.get("text") ?? "").slice(0, 10_000);
  await storage.bucket("notes").upload("note.txt", text, {
    contentType: "text/plain",
  });
}
