// Loopy's memories on disk: one row per finished voice turn (what the user said, what Loopy
// answered, when) with the turn's embedding, in Deno's built-in SQLite (`node:sqlite`). The file
// is in the app's data folder in the desktop app and in `.loopy/` under the dev server; it is
// opened only when something is written, so with memory off nothing is created. Deletes overwrite
// the freed pages (`secure_delete`), and forgetting everything vacuums the file. The store takes
// an open database, so the tests use an in-memory one.

import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

/** A memory as the settings list shows it. */
export interface MemoryRecord {
  readonly id: number;
  /** When the turn ended, in milliseconds since the epoch. */
  readonly createdAt: number;
  readonly user: string;
  readonly assistant: string;
}

/** A memory with its embedding (`null` when embedding it failed). */
export interface StoredMemory extends MemoryRecord {
  readonly embedding: Float32Array | null;
}

/** The most memories kept: past it, the oldest go. */
export const MAX_MEMORIES = 2_000;

/** The memories. */
export interface MemoryStore {
  /** Keep a memory; returns its id. */
  add(memory: Omit<StoredMemory, "id">): number;
  /** The newest `limit` memories, newest first. */
  list(limit: number): MemoryRecord[];
  /** Every memory with its embedding (for a search). */
  all(): StoredMemory[];
  /** Forget memory `id`; whether there was one. */
  remove(id: number): boolean;
  /** Forget every memory; how many there were. */
  clear(): number;
  close(): void;
}

/** An embedding as a BLOB, and back. */
const toBlob = (v: Float32Array) =>
  new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
const fromBlob = (b: unknown): Float32Array | null =>
  b instanceof Uint8Array && b.byteLength % 4 === 0 && b.byteLength > 0
    ? new Float32Array(b.slice().buffer)
    : null;

/** A row as a record. */
function record(row: Record<string, unknown>): MemoryRecord {
  return {
    id: Number(row.id),
    createdAt: Number(row.created_at),
    user: String(row.user_text ?? ""),
    assistant: String(row.assistant_text ?? ""),
  };
}

/** The memories in `db` (the table is created when missing). */
export function memoryStore(db: DatabaseSync): MemoryStore {
  db.exec("PRAGMA secure_delete = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    embedding BLOB
  )`);
  const insert = db.prepare(
    "INSERT INTO memories (created_at, user_text, assistant_text, embedding) VALUES (?, ?, ?, ?)",
  );
  const prune = db.prepare(
    "DELETE FROM memories WHERE id NOT IN (SELECT id FROM memories ORDER BY id DESC LIMIT ?)",
  );
  return {
    add(m) {
      const result = insert.run(
        m.createdAt,
        m.user,
        m.assistant,
        m.embedding ? toBlob(m.embedding) : null,
      );
      prune.run(MAX_MEMORIES);
      return Number(result.lastInsertRowid);
    },
    list(limit) {
      return db.prepare(
        "SELECT id, created_at, user_text, assistant_text FROM memories ORDER BY id DESC LIMIT ?",
      ).all(limit).map((r) => record(r as Record<string, unknown>));
    },
    all() {
      return db.prepare("SELECT * FROM memories ORDER BY id").all().map((r) => {
        const row = r as Record<string, unknown>;
        return { ...record(row), embedding: fromBlob(row.embedding) };
      });
    },
    remove(id) {
      return Number(db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
    },
    clear() {
      const n = Number(db.prepare("DELETE FROM memories").run().changes);
      db.exec("VACUUM");
      return n;
    },
    close: () => db.close(),
  };
}

/** Whether `path` exists. */
function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The store in file `path`, opened on first use. */
export interface MemoryFile {
  /** The store, creating the file (and its folder) when `create`; `null` when there is none. */
  open(create: boolean): MemoryStore | null;
  close(): void;
}

/** The memory file at `path` (owner-only on macOS and Linux). */
export function memoryFile(path: string): MemoryFile {
  let store: MemoryStore | null = null;
  return {
    open(create) {
      if (store) return store;
      if (!create && !exists(path)) return null;
      Deno.mkdirSync(dirname(path), { recursive: true });
      store = memoryStore(new DatabaseSync(path));
      if (Deno.build.os !== "windows") Deno.chmodSync(path, 0o600);
      return store;
    },
    close() {
      store?.close();
      store = null;
    },
  };
}
