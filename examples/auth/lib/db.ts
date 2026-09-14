// The app's READ window onto the auth database.
//
// `sqliteAuthAdapter` (lib/users.ts) owns the `auth_*` tables: it creates them, extends
// them additively across denext versions, and writes every row. The adapter is a
// persistence *port* for the auth flow — createUser / getUserByEmail / linkAccount — not a
// query layer, so a screen that needs a LIST (the admin page) reads the tables itself,
// through this second `node:sqlite` handle. Zero npm, like the rest of the example.
//
// The handle opens lazily, on the first query: by then the adapter has already created the
// schema, so there is no ordering rule to remember.

import { DatabaseSync } from "node:sqlite";

/**
 * The one sqlite file — users, linked accounts, password hashes, API tokens AND sessions
 * (the adapter exposes a session store over the same handle). Point `AUTH_DB` somewhere
 * writable in production; it must be a real file, because this read handle opens it again.
 */
export const DB_PATH = Deno.env.get("AUTH_DB") ?? "auth.db";

let handle: DatabaseSync | undefined;

/** The lazily-opened read handle (a WAL reader never blocks the adapter's writes). */
function db(): DatabaseSync {
  handle ??= new DatabaseSync(DB_PATH);
  return handle;
}

/** A row of `auth_users`, exactly as the adapter stores it. */
export interface UserRow {
  /** The adapter-assigned user id — what `session.user.id` carries. */
  id: string;
  /** Primary email, or null for an account that has none. */
  email: string | null;
  /** Display name. */
  name: string | null;
  /** Roles as a JSON array of strings (`["admin","user"]`), or null. */
  roles: string | null;
  /** When the address was verified, epoch seconds; null while unverified. */
  email_verified: number | null;
  /** Creation time, epoch seconds. */
  created_at: number | null;
}

const USER_COLUMNS = "id, email, name, roles, email_verified, created_at";

/** Every account, newest first — the admin screen's list. */
export function listUsers(): UserRow[] {
  return db()
    .prepare(`SELECT ${USER_COLUMNS} FROM auth_users ORDER BY created_at DESC, id`)
    .all() as unknown as UserRow[];
}

/** How many accounts exist. The first one to register administers the app. */
export function countUsers(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM auth_users").get() as { n: number };
  return row.n;
}
