// The device side of the sync: a local SQLite database (denext/mobile's `openSqlite`) the UI
// reads and writes at once, online or not, and a loop that reconciles it with the backend.
//
// It follows PowerSync's client model, small:
//
// - A write changes the local table and appends the operation to an upload queue (`crud_queue`,
//   PowerSync's `ps_crud`) in ONE transaction, so the UI never waits on the network.
// - `sync()` uploads the queue in order, in batches. A batch leaves the queue only once the
//   backend has applied it; a network failure keeps it for the next try (the device is offline).
// - Server changes are applied only when the queue is empty, as PowerSync does: a row the device
//   changed is never overwritten by an older server copy while its upload is still pending.
//
// The database is anything with `openSqlite`'s `exec` / `run` / `query`, so the tests run this
// module over node:sqlite and the app over the native plugin or the browser's OPFS.

import type { ChangesResponse, CrudOp, Note, UploadBody } from "./protocol.ts";

/** A value this module binds. */
export type BindValue = string | number | null;

/** The slice of `SqliteDatabase` (denext/mobile) this module uses. */
export interface SyncDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly BindValue[]): Promise<unknown>;
  query<T>(sql: string, params?: readonly BindValue[]): Promise<T[]>;
}

/** How the client reaches the backend. */
export interface SyncClientOptions {
  /** The backend's origin; `""` for the page's own origin (the SPA's dev proxy). */
  readonly origin?: string;
  /** The fetch to use (tests pass one bound to an in-process app). */
  readonly fetch?: typeof fetch;
  /** Operations per upload request. Default 100. */
  readonly batchSize?: number;
  /** A fresh id for a new note. Default `crypto.randomUUID()`. */
  readonly newId?: () => string;
  /** The clock. Default `Date.now`. */
  readonly now?: () => number;
}

/** What one {@linkcode SyncClient.sync} did. */
export interface SyncResult {
  /** Operations the backend applied. */
  readonly uploaded: number;
  /** Server rows applied locally. */
  readonly downloaded: number;
  /** Operations still queued. */
  readonly pending: number;
  /** Whether the backend could not be reached (the queue is kept). */
  readonly offline: boolean;
}

/** The local store and its sync loop. */
export interface SyncClient {
  /** Every live note, newest first. */
  list(): Promise<Note[]>;
  /** Create a note (queued for upload); resolves its id. */
  add(body: string): Promise<string>;
  /** Change a note's body (queued). */
  edit(id: string, body: string): Promise<void>;
  /** Delete a note (queued). */
  remove(id: string): Promise<void>;
  /** Operations waiting for upload. */
  pending(): Promise<number>;
  /** Upload the queue, then (when it is empty) apply the server's changes. */
  sync(): Promise<SyncResult>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crud_queue (
    op_id INTEGER PRIMARY KEY AUTOINCREMENT,
    op TEXT NOT NULL,
    tbl TEXT NOT NULL,
    row_id TEXT NOT NULL,
    data TEXT
  );
  CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)
`;

/** A rejected upload: the backend refused the batch (a 4xx), so it is not retried as-is. */
export class UploadRejectedError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`the backend refused the upload (${status}): ${detail}`);
    this.name = "UploadRejectedError";
  }
}

/** Run `work` in one transaction. */
async function transaction(
  db: SyncDb,
  work: () => Promise<void>,
): Promise<void> {
  await db.exec("BEGIN");
  try {
    await work();
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}

/** A queued row as stored. */
interface QueuedRow {
  op_id: number;
  op: CrudOp["op"];
  tbl: CrudOp["table"];
  row_id: string;
  data: string | null;
}

/**
 * Create the local tables (when missing) and the client over them.
 *
 * @param db The local database (`await openSqlite("notes.db")`).
 * @param options Where the backend is.
 * @returns The client.
 */
export async function createSyncClient(
  db: SyncDb,
  options: SyncClientOptions = {},
): Promise<SyncClient> {
  await db.exec(SCHEMA);
  const origin = options.origin ?? "";
  const doFetch = options.fetch ?? fetch;
  const batchSize = options.batchSize ?? 100;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  let running: Promise<SyncResult> | null = null;

  /** Write a row change and its queued operation together. */
  const write = (op: CrudOp, local: () => Promise<void>) =>
    transaction(db, async () => {
      await local();
      await db.run(
        "INSERT INTO crud_queue (op, tbl, row_id, data) VALUES (?, ?, ?, ?)",
        [
          op.op,
          op.table,
          op.id,
          op.data ? JSON.stringify(op.data) : null,
        ],
      );
    });

  const pending = async () =>
    (await db.query<{ n: number }>("SELECT count(*) AS n FROM crud_queue"))[0]
      .n;

  /** One upload request; false when the backend could not be reached. */
  async function uploadBatch(rows: QueuedRow[]): Promise<boolean> {
    const body: UploadBody = {
      batch: rows.map((r) => ({
        op: r.op,
        table: r.tbl,
        id: r.row_id,
        ...(r.data ? { data: JSON.parse(r.data) } : {}),
      })),
    };
    let res: Response;
    try {
      res = await doFetch(`${origin}/api/data`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return false; // offline: keep the queue
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      return false; // the backend is down: retry later
    }
    if (!res.ok) throw new UploadRejectedError(res.status, await res.text());
    await res.body?.cancel();
    await db.run("DELETE FROM crud_queue WHERE op_id <= ?", [
      rows[rows.length - 1].op_id,
    ]);
    return true;
  }

  /** Apply the server's changes since the stored checkpoint; -1 when unreachable. */
  async function download(): Promise<number> {
    const state = await db.query<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'checkpoint'",
    );
    const since = state[0]?.value ?? "0";
    let changes: ChangesResponse;
    try {
      const res = await doFetch(
        `${origin}/api/changes?since=${encodeURIComponent(since)}`,
      );
      if (!res.ok) {
        await res.body?.cancel();
        return -1;
      }
      changes = await res.json();
    } catch {
      return -1;
    }
    await transaction(db, async () => {
      for (const row of changes.rows) {
        if (row.deleted) {
          await db.run("DELETE FROM notes WHERE id = ?", [row.id]);
        } else {
          await db.run(
            `INSERT INTO notes (id, body, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
            [row.id, row.body, row.updated_at],
          );
        }
      }
      await db.run(
        "INSERT INTO sync_state (key, value) VALUES ('checkpoint', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(changes.checkpoint)],
      );
    });
    return changes.rows.length;
  }

  async function runSync(): Promise<SyncResult> {
    let uploaded = 0;
    for (;;) {
      const rows = await db.query<QueuedRow>(
        "SELECT op_id, op, tbl, row_id, data FROM crud_queue ORDER BY op_id LIMIT ?",
        [batchSize],
      );
      if (rows.length === 0) break;
      if (!await uploadBatch(rows)) {
        return {
          uploaded,
          downloaded: 0,
          pending: await pending(),
          offline: true,
        };
      }
      uploaded += rows.length;
    }
    // A write made while the queue drained waits for the next sync before server rows land.
    if (await pending() > 0) {
      return {
        uploaded,
        downloaded: 0,
        pending: await pending(),
        offline: false,
      };
    }
    const downloaded = await download();
    return {
      uploaded,
      downloaded: Math.max(downloaded, 0),
      pending: await pending(),
      offline: downloaded < 0,
    };
  }

  return {
    list: () =>
      db.query<Note>(
        "SELECT id, body, updated_at FROM notes ORDER BY updated_at DESC",
      ),
    async add(body) {
      const id = newId();
      const note = { body, updated_at: now() };
      await write({ op: "PUT", table: "notes", id, data: note }, async () => {
        await db.run(
          "INSERT INTO notes (id, body, updated_at) VALUES (?, ?, ?)",
          [
            id,
            note.body,
            note.updated_at,
          ],
        );
      });
      return id;
    },
    async edit(id, body) {
      const data = { body, updated_at: now() };
      await write({ op: "PATCH", table: "notes", id, data }, async () => {
        await db.run("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?", [
          body,
          data.updated_at,
          id,
        ]);
      });
    },
    async remove(id) {
      await write({ op: "DELETE", table: "notes", id }, async () => {
        await db.run("DELETE FROM notes WHERE id = ?", [id]);
      });
    },
    pending,
    sync() {
      // One sync at a time: a second call while one runs shares its result.
      running ??= runSync().finally(() => (running = null));
      return running;
    },
  };
}
