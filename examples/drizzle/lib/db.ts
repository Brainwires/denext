// A server-only module: opens SQLite once as a module singleton and exposes typed
// queries through Drizzle. `better-sqlite3` here is denext's compat over Deno's
// built-in `node:sqlite` (see ../vendor/better-sqlite3) — no native addon, no npm
// download. Drizzle's better-sqlite3 driver talks to it exactly as it would the
// real library.

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc } from "drizzle-orm";
import { type Note, notes } from "./schema.ts";

const sqlite = new Database(Deno.env.get("DB_PATH") ?? ":memory:");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

export const db = drizzle(sqlite, { schema: { notes } });

// Seed a couple of rows on first boot so the page isn't empty on a fresh :memory:
// database. (Idempotent: only seeds when the table is empty.)
if (db.select().from(notes).all().length === 0) {
  db.insert(notes).values([
    { title: "Drizzle runs on denext", createdAt: Date.now() },
    { title: "…over node:sqlite, zero native addons", createdAt: Date.now() },
  ]).run();
}

/** All notes, newest first. */
export function listNotes(): Note[] {
  return db.select().from(notes).orderBy(desc(notes.id)).all();
}

/** Insert a note (used by the Server Action). */
export function addNote(title: string): void {
  db.insert(notes).values({ title, createdAt: Date.now() }).run();
}
