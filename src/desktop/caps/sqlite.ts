/**
 * The `sqlite` capability: an app SQLite database on Deno Desktop, backed by Deno's built-in
 * `node:sqlite`. It answers `openSqlite` / `deleteSqlite` (see `src/desktop/native.ts`), which on
 * the web run `@sqlite.org/sqlite-wasm` on OPFS.
 *
 * SECURITY / confinement:
 * - Every database file lives directly under the app-support directory. A database `name` is a
 *   single filename component: separators, `..` and absolute paths are refused, so a page cannot
 *   open or delete a file outside the app's own folder.
 * - `ATTACH` / `VACUUM INTO` are disabled on every connection ({@link confineDatabase}), since the
 *   page's arbitrary SQL could otherwise open or create a file anywhere.
 * - `open` returns an opaque handle (a random id); the page never sees or supplies a path. A
 *   method call for an unknown handle is `closed`.
 * - Blobs cross the wire as `{ $bytes: <base64> }` (JSON has no bytes); this side decodes bind
 *   values and encodes result cells to match `src/desktop/native.ts`. Booleans bind as 1/0.
 *
 * EVENT LOOP: `node:sqlite` is synchronous and exposes no interrupt or progress handler, so a single
 * long-running statement (a runaway recursive CTE, a huge aggregate) blocks the desktop process —
 * the bridge's 30 s deadline cannot preempt it, and every other request waits. What IS bounded:
 * `query` streams its rows and stops with `timeout` once {@link QUERY_TIME_BUDGET_MS} has elapsed
 * between rows. A page that can run arbitrary SQL can still hang its own app (a local DoS, never an
 * escalation); running the capability in a Worker that is terminated on the deadline is the fix if
 * that ever matters.
 *
 * Handles stay open until the page calls `close` or the process exits (a desktop app IS its Deno
 * process); an unclosed handle leaks a connection for the app's lifetime, no worse than the app
 * holding the DB open itself.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";

/** A blob on the wire: `{ $bytes: <base64> }` (matches `src/desktop/native.ts`). */
interface WireBytes {
  $bytes: string;
}

/** A validation error. */
function badInput(message: string): DesktopCapError {
  return new DesktopCapError("validation", message);
}

/**
 * Run a SQLite call, mapping the confinement refusal ({@link confineDatabase}) to a specific
 * `forbidden` code instead of a generic `internal`: `ATTACH` / `VACUUM INTO` surfaces as an
 * attached-database-limit error (`limits.attach = 0`) or an authorizer denial ("not authorized"),
 * and the page deserves to see WHY. Other SQL errors (syntax, constraints) pass through unchanged.
 */
function guardSql<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : "").toLowerCase();
    if (msg.includes("not authorized") || msg.includes("attached databas")) {
      throw new DesktopCapError(
        "forbidden",
        "ATTACH DATABASE / VACUUM INTO is not allowed on a page-driven connection",
        { status: 403 },
      );
    }
    throw err;
  }
}

/** A safe single-component database name (no separators, no `..`, non-empty). */
function safeName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw badInput("name must be a non-empty string");
  }
  if (
    name.includes("/") || name.includes("\\") || name === "." || name === ".." ||
    name.includes("\0")
  ) {
    throw badInput(`invalid database name "${name}"`);
  }
  return name;
}

/** Decode one wire bind value: `{ $bytes }` → bytes, boolean → 1/0, else itself. */
function decodeBind(value: unknown): string | number | bigint | Uint8Array | null {
  if (
    typeof value === "object" && value !== null && typeof (value as WireBytes).$bytes === "string"
  ) {
    return base64ToBytes((value as WireBytes).$bytes);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value;
  }
  return null;
}

/** Encode one result cell for the wire: bytes → `{ $bytes }`, bigint → number, pass the rest. */
function encodeCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) } satisfies WireBytes;
  if (typeof value === "bigint") return Number(value);
  return value ?? null;
}

/** A prepared statement enough of `node:sqlite`'s `StatementSync` to bind and read. */
interface Stmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  columns(): Array<{ name?: string; column?: string }>;
  setReturnArrays(on: boolean): void;
  setAllowBareNamedParameters(on: boolean): void;
}

/** Bind `params` (array → positional, record → one named object) and return the invocation args. */
function bindArgs(stmt: Stmt, params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params.map(decodeBind);
  if (typeof params === "object") {
    stmt.setAllowBareNamedParameters(true);
    const named: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) named[k] = decodeBind(v);
    return [named];
  }
  throw badInput("params must be an array or an object");
}

/** How long one `query` may keep producing rows (ms) before it stops with `timeout`. */
const QUERY_TIME_BUDGET_MS = 20_000;

/**
 * Forbid `ATTACH DATABASE` / `VACUUM INTO` on a page-driven connection: the page runs arbitrary SQL,
 * and either statement opens or creates a file at ANY path from inside SQLite (bypassing the name
 * check above). Deno already refuses them unless the process has every permission, but a desktop
 * app run with `-A` (a migrated `deno task desktop`, a dev launch) would not — so set SQLite's
 * attached-database limit to 0 on every connection.
 *
 * @param db The freshly opened connection.
 */
function confineDatabase(db: DatabaseSync): void {
  // Defensive mode too: no writable_schema / shadow-table tricks that corrupt the file.
  (db as unknown as { enableDefensive?: (on: boolean) => void }).enableDefensive?.(true);
  const limits = (db as unknown as { limits?: Record<string, number> }).limits;
  if (limits && typeof limits === "object" && "attach" in limits) {
    limits.attach = 0;
    return;
  }
  // No `limits` (an older runtime): refuse ATTACH through the authorizer (SQLITE_ATTACH = 24;
  // VACUUM INTO attaches its target too), else fail closed.
  const auth = (db as unknown as { setAuthorizer?: (cb: (action: number) => number) => void })
    .setAuthorizer;
  if (typeof auth === "function") {
    auth.call(db, (action) => (action === 24 ? 1 /* SQLITE_DENY */ : 0 /* SQLITE_OK */));
    return;
  }
  db.close();
  throw new DesktopCapError("unavailable", "this runtime cannot confine SQLite ATTACH");
}

/**
 * Build the `sqlite` capability over `dir` (the app-support directory). Databases are files
 * directly under `dir`; the factory keeps the open handles in a private registry.
 *
 * @param dir The resolved absolute app-support directory (`$APPDATA`).
 * @param options `queryTimeBudgetMs`: how long one `query` may produce rows (default 20 s).
 * @returns The `sqlite` {@link DesktopCapability}.
 */
export function sqliteCapability(
  dir: string,
  options: { readonly queryTimeBudgetMs?: number } = {},
): DesktopCapability {
  const budgetMs = options.queryTimeBudgetMs ?? QUERY_TIME_BUDGET_MS;
  const open = new Map<string, { db: DatabaseSync; name: string }>();

  const dbFor = (handle: unknown): DatabaseSync => {
    const entry = typeof handle === "string" ? open.get(handle) : undefined;
    if (!entry) throw new DesktopCapError("closed", "the database is closed");
    return entry.db;
  };

  const prepare = (handle: unknown, sql: unknown): Stmt => {
    if (typeof sql !== "string") throw badInput("sql must be a string");
    return dbFor(handle).prepare(sql) as unknown as Stmt;
  };

  return {
    name: "sqlite",
    methods: {
      open: {
        permissions: { read: ["$APPDATA"], write: ["$APPDATA"] },
        handler: async (args) => {
          const name = safeName((args as { name?: unknown })?.name);
          await Deno.mkdir(dir, { recursive: true }).catch((err) => {
            if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
          });
          const db = new DatabaseSync(join(dir, name));
          confineDatabase(db);
          const handle = crypto.randomUUID();
          open.set(handle, { db, name });
          return { handle };
        },
      },
      exec: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown };
          if (typeof a.sql !== "string") throw badInput("sql must be a string");
          guardSql(() => dbFor(a.handle).exec(a.sql as string));
          return { ok: true };
        },
      },
      run: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown; params?: unknown };
          const stmt = prepare(a.handle, a.sql);
          const r = guardSql(() => stmt.run(...bindArgs(stmt, a.params)));
          return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
      },
      query: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown; params?: unknown };
          const stmt = prepare(a.handle, a.sql);
          stmt.setReturnArrays(true);
          // Row by row against a time budget: a sync query can't be preempted, but one that keeps
          // producing rows stops here instead of pinning the event loop (see the module notes).
          const deadline = Date.now() + budgetMs;
          const rows: unknown[][] = [];
          return guardSql(() => {
            for (const row of stmt.iterate(...bindArgs(stmt, a.params))) {
              rows.push((row as unknown[]).map(encodeCell));
              if (Date.now() > deadline) {
                throw new DesktopCapError("timeout", "the query ran past its time budget", {
                  status: 408,
                });
              }
            }
            const columns = stmt.columns().map((c) => c.name ?? c.column ?? "");
            return { columns, rows };
          });
        },
      },
      inTransaction: {
        handler: (args) => {
          const db = dbFor((args as { handle?: unknown })?.handle) as unknown as {
            isTransaction?: boolean;
          };
          return db.isTransaction === true;
        },
      },
      close: {
        handler: (args) => {
          const handle = (args as { handle?: unknown })?.handle;
          const entry = typeof handle === "string" ? open.get(handle) : undefined;
          if (entry && typeof handle === "string") {
            open.delete(handle);
            entry.db.close();
          }
          return { ok: true };
        },
      },
      delete: {
        permissions: { write: ["$APPDATA"] },
        handler: async (args) => {
          const name = safeName((args as { name?: unknown })?.name);
          // Close any open handle to this file first (a delete of an open DB is undefined).
          for (const [handle, entry] of open) {
            if (entry.name === name) {
              open.delete(handle);
              try {
                entry.db.close();
              } catch {
                // already closed
              }
            }
          }
          await Deno.remove(join(dir, name)).catch((err) => {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          });
          return { ok: true };
        },
      },
    },
  };
}
