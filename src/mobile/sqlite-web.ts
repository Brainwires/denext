/**
 * The web backing of `denext/mobile`'s SQLite: the app's own `@sqlite.org/sqlite-wasm`
 * (the official SQLite build) running in a dedicated worker.
 *
 * Persistence uses the engine's `opfs-sahpool` VFS: OPFS sync access handles, which exist
 * only in a worker but need no cross-origin isolation (no COOP/COEP headers). The engine's
 * other OPFS VFS (`"opfs"`) needs `SharedArrayBuffer`, so it only works on a
 * cross-origin-isolated page; it is not used. When the pool cannot be installed (no OPFS, or
 * another tab of the same origin holds it), the database is in memory for the session and
 * {@linkcode SqliteDriver.backend} says `"memory"`.
 *
 * Internal to `denext/mobile`: not an entrypoint.
 *
 * @module
 */

/** A value SQLite stores. */
export type SqliteValue = string | number | null | Uint8Array;

/** A value a statement binds: booleans bind as 1/0, an `ArrayBuffer` as a blob. */
export type SqliteBindValue = string | number | boolean | null | Uint8Array | ArrayBuffer;

/**
 * A statement's parameters: positional (`?`), or named by their placeholder, prefix included
 * (`{ $id: 1 }` for `$id`, `{ ":id": 1 }` for `:id`).
 */
export type SqliteParams =
  | readonly SqliteBindValue[]
  | Readonly<Record<string, SqliteBindValue>>;

/** What a write reports. */
export interface SqliteRunResult {
  /** Rows the statement inserted, updated or deleted. */
  readonly changes: number;
  /** The rowid of the last inserted row. */
  readonly lastInsertRowId: number;
}

/** Rows as column names plus one value array per row, in column order. */
export interface SqliteRows {
  /** The result's column names. */
  readonly columns: string[];
  /** One array per row, a value per column. */
  readonly rows: SqliteValue[][];
}

/** Where a database lives: the native plugin, OPFS in the browser, or memory. */
export type SqliteBackend = "native" | "opfs" | "memory";

/** The calls a backing implements. Internal: the public face is `SqliteDatabase`. */
export interface SqliteDriver {
  readonly backend: SqliteBackend;
  exec(sql: string): Promise<void>;
  run(sql: string, params: SqliteParams): Promise<SqliteRunResult>;
  query(sql: string, params: SqliteParams): Promise<SqliteRows>;
  inTransaction(): Promise<boolean>;
  close(): Promise<void>;
}

/** The engine's two files. */
export interface SqliteWasmUrls {
  /** `@sqlite.org/sqlite-wasm`'s ES module (`dist/index.mjs`). */
  readonly moduleUrl: string;
  /** Its `sqlite3.wasm` (empty: the engine finds it beside the module). */
  readonly wasmUrl: string;
}

/**
 * The worker. Plain JavaScript in a string, so no build step can rewrite it: it loads the
 * engine from the URL it is given, installs the `opfs-sahpool` VFS once, and answers one
 * message per call. Integers beyond 2^53 come back from the engine as `BigInt`s and are sent
 * as numbers (Expo's JS API has no `BigInt` either).
 */
const WORKER_SOURCE = `
let engine = null;
let pool = null;
let poolNote = null;
const dbs = new Map();
const num = (v) => (typeof v === "bigint" ? Number(v) : v);
async function load(urls) {
  engine ??= import(urls.moduleUrl).then((m) => m.default({
    locateFile: urls.wasmUrl ? () => urls.wasmUrl : undefined,
    print: () => {},
    printErr: () => {},
  }));
  return await engine;
}
async function sahPool(sqlite3) {
  pool ??= (typeof sqlite3.installOpfsSAHPoolVfs === "function"
    ? sqlite3.installOpfsSAHPoolVfs({ name: "denext-sqlite", directory: ".denext-sqlite" })
    : Promise.reject(new Error("this engine build has no opfs-sahpool VFS")))
    .catch((err) => { poolNote = String(err && err.message || err); return null; });
  return await pool;
}
function entry(name) {
  const e = dbs.get(name);
  if (!e) throw new Error("database " + JSON.stringify(name) + " is not open");
  return e;
}
function bind(params) {
  if (params == null) return undefined;
  if (Array.isArray(params)) return params.length ? params : undefined;
  return Object.keys(params).length ? params : undefined;
}
async function open(msg) {
  if (dbs.has(msg.name)) return { backend: dbs.get(msg.name).backend, note: poolNote };
  const sqlite3 = await load(msg.urls);
  const p = await sahPool(sqlite3);
  let db;
  let backend;
  if (p) {
    if (p.getFileCount() + 2 > p.getCapacity()) await p.addCapacity(2);
    db = new p.OpfsSAHPoolDb("/" + msg.name);
    backend = "opfs";
  } else {
    db = new sqlite3.oo1.DB(":memory:", "c");
    backend = "memory";
  }
  dbs.set(msg.name, { db, backend, sqlite3 });
  return { backend, note: poolNote };
}
const ops = {
  open,
  exec(msg) { entry(msg.name).db.exec(msg.sql); return null; },
  run(msg) {
    const { db, sqlite3 } = entry(msg.name);
    db.exec({ sql: msg.sql, bind: bind(msg.params) });
    return {
      changes: db.changes(),
      lastInsertRowId: num(sqlite3.capi.sqlite3_last_insert_rowid(db.pointer)),
    };
  },
  query(msg) {
    const { db } = entry(msg.name);
    const rows = [];
    const columns = [];
    db.exec({ sql: msg.sql, bind: bind(msg.params), rowMode: "array", resultRows: rows, columnNames: columns });
    return { columns, rows: rows.map((row) => row.map(num)) };
  },
  inTransaction(msg) {
    const { db, sqlite3 } = entry(msg.name);
    return sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0;
  },
  close(msg) {
    const e = dbs.get(msg.name);
    if (e) { e.db.close(); dbs.delete(msg.name); }
    return null;
  },
  async remove(msg) {
    ops.close(msg);
    const sqlite3 = await load(msg.urls);
    const p = await sahPool(sqlite3);
    if (p) { p.unlink("/" + msg.name); p.unlink("/" + msg.name + "-journal"); }
    return null;
  },
};
self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const value = await ops[msg.op](msg);
    self.postMessage({ id: msg.id, ok: true, value });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  }
};
`;

/** One pending call. */
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** The worker and its in-flight calls. */
interface WorkerClient {
  call<T>(op: string, fields: Record<string, unknown>): Promise<T>;
  terminate(): void;
}

/** Turns an app-relative URL absolute, so the worker (a blob: document) can load it. */
function absolute(url: string): string {
  if (url === "") return url;
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  return base ? new URL(url, base).href : new URL(url).href;
}

/** Start the worker (once per page). */
function startWorker(): WorkerClient {
  if (typeof Worker === "undefined") {
    throw new Error("openSqlite: no Worker here (called during SSR?)");
  }
  const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob), { type: "module" });
  const pending = new Map<number, Pending>();
  let next = 0;
  worker.onmessage = (event: MessageEvent) => {
    const { id, ok, value, error } = event.data as {
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    };
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (ok) call.resolve(value);
    else call.reject(new Error(error));
  };
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault?.();
    const error = new Error(`openSqlite: the SQLite worker failed: ${event.message}`);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  return {
    call<T>(op: string, fields: Record<string, unknown>): Promise<T> {
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        worker.postMessage({ id, op, ...fields });
      });
    },
    terminate() {
      worker.terminate();
      const error = new Error("openSqlite: the SQLite worker was stopped");
      for (const call of pending.values()) call.reject(error);
      pending.clear();
    },
  };
}

let client: WorkerClient | null = null;

/** The page's one SQLite worker. */
function sqliteWorker(): WorkerClient {
  return client ??= startWorker();
}

/** Blobs as `Uint8Array`s and booleans as 1/0, the forms the engine binds. */
function webParams(params: SqliteParams): unknown {
  const value = (v: SqliteBindValue) =>
    typeof v === "boolean" ? (v ? 1 : 0) : v instanceof ArrayBuffer ? new Uint8Array(v) : v;
  if (Array.isArray(params)) return params.map(value);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(params)) out[key] = value(v as SqliteBindValue);
  return out;
}

/**
 * Open `name` in the page's SQLite worker.
 *
 * @param name The database name (one OPFS file per name).
 * @param urls Where the engine is.
 * @returns The driver.
 */
export async function openWebSqlite(name: string, urls: SqliteWasmUrls): Promise<SqliteDriver> {
  const worker = sqliteWorker();
  const resolved = { moduleUrl: absolute(urls.moduleUrl), wasmUrl: absolute(urls.wasmUrl) };
  const { backend } = await worker.call<{ backend: SqliteBackend }>("open", {
    name,
    urls: resolved,
  });
  let closed = false;
  const live = () => {
    if (closed) throw new Error(`openSqlite: database "${name}" is closed`);
  };
  return {
    backend,
    async exec(sql) {
      live();
      await worker.call("exec", { name, sql });
    },
    run(sql, params) {
      live();
      return worker.call<SqliteRunResult>("run", { name, sql, params: webParams(params) });
    },
    query(sql, params) {
      live();
      return worker.call<SqliteRows>("query", { name, sql, params: webParams(params) });
    },
    inTransaction() {
      live();
      return worker.call<boolean>("inTransaction", { name });
    },
    async close() {
      if (closed) return;
      closed = true;
      await worker.call("close", { name });
    },
  };
}

/**
 * Delete `name`'s OPFS file (closing it first when open).
 *
 * @param name The database name.
 * @param urls Where the engine is.
 */
export async function deleteWebSqlite(name: string, urls: SqliteWasmUrls): Promise<void> {
  await sqliteWorker().call("remove", {
    name,
    urls: { moduleUrl: absolute(urls.moduleUrl), wasmUrl: absolute(urls.wasmUrl) },
  });
}

/** Stop the page's worker (tests): every open web database is gone with it. */
export function resetSqliteWorkerForTesting(): void {
  client?.terminate();
  client = null;
}
