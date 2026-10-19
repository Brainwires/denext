// The backend's copy of the data: Deno's built-in SQLite (node:sqlite), server-only.
//
// Every write bumps one sequence and stamps the row with it, so "what changed since checkpoint
// N" is `version > N`. Deletions stay as tombstones (`deleted = 1`) so a device that missed them
// still learns about them. Writes are last-arrival-wins, as PowerSync's default upload handling
// is: the backend applies each operation in the order the device queued it.

import { DatabaseSync } from "node:sqlite";
import type { ChangesResponse, CrudOp } from "../../src/protocol.ts";

const db = new DatabaseSync(Deno.env.get("OFFLINE_SYNC_DB") ?? ":memory:");
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_version ON notes (version);
  CREATE TABLE IF NOT EXISTS seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
  INSERT OR IGNORE INTO seq (id, value) VALUES (1, 0);
`);

/** The next version number (call inside the batch's transaction). */
function nextVersion(): number {
  const row = db.prepare(
    "UPDATE seq SET value = value + 1 WHERE id = 1 RETURNING value",
  ).get();
  return Number((row as { value: number }).value);
}

/** The time an operation carries, else now. */
function stamp(op: CrudOp): number {
  const value = op.data?.updated_at;
  return typeof value === "number" ? value : Date.now();
}

/** Each operation, applied (PATCH: only the columns sent, and only on a live row). */
const APPLY: Record<CrudOp["op"], (op: CrudOp) => void> = {
  DELETE: (op) => {
    db.prepare("UPDATE notes SET deleted = 1, version = ? WHERE id = ?").run(
      nextVersion(),
      op.id,
    );
  },
  PUT: (op) => {
    db.prepare(
      `INSERT INTO notes (id, body, updated_at, deleted, version) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
         deleted = 0, version = excluded.version`,
    ).run(op.id, String(op.data?.body), stamp(op), nextVersion());
  },
  PATCH: (op) => {
    if (typeof op.data?.body !== "string") return;
    db.prepare(
      "UPDATE notes SET body = ?, updated_at = ?, version = ? WHERE id = ? AND deleted = 0",
    ).run(op.data.body, stamp(op), nextVersion(), op.id);
  },
};

/**
 * Apply a batch in one transaction: all of it, or none.
 *
 * @param batch The operations, in the order the device queued them.
 * @returns The checkpoint after it.
 */
export function applyBatch(batch: readonly CrudOp[]): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const op of batch) APPLY[op.op](op);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return checkpoint();
}

/** The current checkpoint. */
function checkpoint(): number {
  return Number(
    (db.prepare("SELECT value FROM seq WHERE id = 1").get() as {
      value: number;
    }).value,
  );
}

/**
 * The rows changed after `since`.
 *
 * @param since A checkpoint from an earlier answer (0 for everything; one ahead of this
 *   database, which was reset, also means everything).
 * @returns The rows and the checkpoint they bring the device to.
 */
export function changesSince(since: number): ChangesResponse {
  // A checkpoint ahead of this database (it was reset) starts the device over.
  const from = since > checkpoint() ? 0 : since;
  const rows = db.prepare(
    "SELECT id, body, updated_at, deleted, version FROM notes WHERE version > ? ORDER BY version",
  ).all(from) as Array<
    {
      id: string;
      body: string;
      updated_at: number;
      deleted: number;
      version: number;
    }
  >;
  return {
    checkpoint: rows.length ? Number(rows[rows.length - 1].version) : from,
    rows: rows.map((r) => ({
      id: r.id,
      body: r.body,
      updated_at: Number(r.updated_at),
      deleted: r.deleted === 1,
    })),
  };
}
