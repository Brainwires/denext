/**
 * The `sqlite` capability: an app SQLite database on Deno Desktop, backed by Deno's built-in
 * `node:sqlite`. It answers `openSqlite` / `deleteSqlite` (see `src/desktop/native.ts`), which on
 * the web run `@sqlite.org/sqlite-wasm` on OPFS.
 *
 * SECURITY / confinement:
 * - Every database file lives directly under the app-support directory. A database `name` is a
 *   single filename component: separators, `..` and absolute paths are refused, so a page cannot
 *   open or delete a file outside the app's own folder.
 * - `open` returns an opaque handle (a random id); the page never sees or supplies a path. A
 *   method call for an unknown handle is `closed`.
 * - Blobs cross the wire as `{ $bytes: <base64> }` (JSON has no bytes); this side decodes bind
 *   values and encodes result cells to match `src/desktop/native.ts`. Booleans bind as 1/0.
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

/**
 * Build the `sqlite` capability over `dir` (the app-support directory). Databases are files
 * directly under `dir`; the factory keeps the open handles in a private registry.
 *
 * @param dir The resolved absolute app-support directory (`$APPDATA`).
 * @returns The `sqlite` {@link DesktopCapability}.
 */
export function sqliteCapability(dir: string): DesktopCapability {
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
          const handle = crypto.randomUUID();
          open.set(handle, { db, name });
          return { handle };
        },
      },
      exec: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown };
          if (typeof a.sql !== "string") throw badInput("sql must be a string");
          dbFor(a.handle).exec(a.sql);
          return { ok: true };
        },
      },
      run: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown; params?: unknown };
          const stmt = prepare(a.handle, a.sql);
          const r = stmt.run(...bindArgs(stmt, a.params));
          return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
      },
      query: {
        handler: (args) => {
          const a = (args ?? {}) as { handle?: unknown; sql?: unknown; params?: unknown };
          const stmt = prepare(a.handle, a.sql);
          stmt.setReturnArrays(true);
          const rows = stmt.all(...bindArgs(stmt, a.params)) as unknown[][];
          const columns = stmt.columns().map((c) => c.name ?? c.column ?? "");
          return { columns, rows: rows.map((row) => row.map(encodeCell)) };
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
