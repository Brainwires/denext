// The data layer, backed by Deno's built-in `node:sqlite` (`DatabaseSync`) — a
// real, file-backed SQL database with ZERO npm dependencies. The connection is a
// module singleton created once; every query below is a small prepared statement.
//
// Set `NOTES_DB=:memory:` for an ephemeral database (the CI test does this); the
// default is a `notes.db` file in the working directory.

import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "./crypto.ts";

/** A user row (never expose `password_hash` to a view). */
export interface User {
  id: number;
  email: string;
}

/** A note row, joined with its author's email for display. */
export interface Note {
  id: number;
  user_id: number;
  author: string;
  title: string;
  body: string;
  visibility: "public" | "private";
  updated_at: string;
}

const DB_PATH = Deno.env.get("NOTES_DB") ?? "notes.db";
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/** Seed two demo users and a few notes the first time the database is created. */
async function seed(): Promise<void> {
  const demo = createUser("demo@denext.dev", await hashPassword("password"));
  const alice = createUser("alice@denext.dev", await hashPassword("password"));
  createNote(
    demo,
    "Welcome to denext notes",
    "This one is public — anyone can read it.",
    "public",
  );
  createNote(
    demo,
    "A private thought",
    "Only I can see this in my notes list.",
    "private",
  );
  createNote(
    alice,
    "Alice says hi",
    "Alice's public note, shown on the home feed.",
    "public",
  );
}

const seeded = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n > 0;
if (!seeded) await seed();

/** Look up a user (with hash) by email, for login. */
export function findUserByEmail(
  email: string,
): { id: number; email: string; password_hash: string } | undefined {
  return db.prepare(
    "SELECT id, email, password_hash FROM users WHERE email = ?",
  ).get(
    email,
  ) as unknown as
    | { id: number; email: string; password_hash: string }
    | undefined;
}

/** Read a user by id (no hash). */
export function getUser(id: number): User | undefined {
  return db.prepare("SELECT id, email FROM users WHERE id = ?").get(
    id,
  ) as unknown as
    | User
    | undefined;
}

/** Insert a user, returning the new id. */
export function createUser(email: string, passwordHash: string): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email, passwordHash);
  return Number(lastInsertRowid);
}

const NOTE_COLUMNS =
  "n.id, n.user_id, u.email AS author, n.title, n.body, n.visibility, n.updated_at";

/** Public notes from everyone, newest first — the home feed. */
export function listPublicNotes(): Note[] {
  return db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes n JOIN users u ON u.id = n.user_id
     WHERE n.visibility = 'public' ORDER BY n.updated_at DESC, n.id DESC`,
  ).all() as unknown as Note[];
}

/** Every note owned by `userId`, newest first. */
export function listUserNotes(userId: number): Note[] {
  return db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes n JOIN users u ON u.id = n.user_id
     WHERE n.user_id = ? ORDER BY n.updated_at DESC, n.id DESC`,
  ).all(userId) as unknown as Note[];
}

/** One note by id, or `undefined`. */
export function getNote(id: number): Note | undefined {
  return db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = ?`,
  ).get(id) as unknown as Note | undefined;
}

/** Insert a note owned by `userId`, returning its id. */
export function createNote(
  userId: number,
  title: string,
  body: string,
  visibility: "public" | "private",
): number {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO notes (user_id, title, body, visibility) VALUES (?, ?, ?, ?)",
    )
    .run(userId, title, body, visibility);
  return Number(lastInsertRowid);
}

/** Update a note's fields and bump `updated_at`. */
export function updateNote(
  id: number,
  title: string,
  body: string,
  visibility: "public" | "private",
): void {
  db.prepare(
    "UPDATE notes SET title = ?, body = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(title, body, visibility, id);
}

/** Delete a note by id. */
export function deleteNote(id: number): void {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}
