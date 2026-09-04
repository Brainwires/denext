// The user table, on Deno's built-in `node:sqlite` (zero npm). Passwords are stored
// as `hashPassword` output — a self-describing, salted scrypt string — and checked
// with `verifyPassword` (see lib/auth-config.ts). Set `AUTH_DB=:memory:` for an
// ephemeral database (the CI test does).

import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "denext/server";

/** A user row, including the hash (never render it). */
export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
}

const db = new DatabaseSync(Deno.env.get("AUTH_DB") ?? "auth.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL
  );
`);

/** Look up a user (with hash) by email — the `authorize` lookup. */
export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare(
    "SELECT id, email, name, password_hash FROM users WHERE email = ?",
  )
    .get(email) as unknown as UserRow | undefined;
}

/** Insert a user whose `passwordHash` came from `hashPassword`; returns the new id. */
export function createUser(
  email: string,
  name: string,
  passwordHash: string,
): number {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)")
    .run(email, name, passwordHash);
  return Number(lastInsertRowid);
}

/** Replace a user's password hash (the caller revokes their sessions afterwards). */
export function updatePasswordHash(id: number, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    passwordHash,
    id,
  );
}

// Seed a demo account the first time the database is created.
const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
if (count === 0) {
  createUser("demo@denext.dev", "Demo User", await hashPassword("password"));
}
