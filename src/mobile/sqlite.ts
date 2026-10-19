/**
 * SQLite databases for `denext/mobile`: a file in the app's storage through the native
 * `CapacitorSQLite` plugin in the shell (`denext mobile add sqlite` installs
 * `@capacitor-community/sqlite`), else the app's own `@sqlite.org/sqlite-wasm` in a worker,
 * persisted to OPFS.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import {
  deleteWebSqlite,
  openWebSqlite,
  type SqliteBackend,
  type SqliteBindValue,
  type SqliteDriver,
  type SqliteParams,
  type SqliteRows,
  type SqliteRunResult,
  type SqliteValue,
  type SqliteWasmUrls,
} from "./sqlite-web.ts";

export type {
  SqliteBackend,
  SqliteBindValue,
  SqliteParams,
  SqliteRows,
  SqliteRunResult,
  SqliteValue,
  SqliteWasmUrls,
};

/** A row as an object keyed by column name. */
export type SqliteRow = Record<string, SqliteValue>;

/** An open database ({@linkcode openSqlite}). */
export interface SqliteDatabase {
  /** The name it was opened with. */
  readonly name: string;
  /**
   * Where it lives: `"native"` (the plugin's file), `"opfs"` (persisted in the browser) or
   * `"memory"` (the browser could not persist it; gone when the page closes).
   */
  readonly backend: SqliteBackend;
  /** Run one or more statements, separated by `;`, with no parameters and no results. */
  exec(sql: string): Promise<void>;
  /** Run one statement and report what it changed. */
  run(sql: string, params?: SqliteParams): Promise<SqliteRunResult>;
  /** Run one statement and return its rows as objects. */
  query<T = SqliteRow>(sql: string, params?: SqliteParams): Promise<T[]>;
  /** Run one statement and return its column names and value rows. */
  queryRows(sql: string, params?: SqliteParams): Promise<SqliteRows>;
  /** Whether a transaction is open (`BEGIN` without its `COMMIT` / `ROLLBACK`). */
  inTransaction(): Promise<boolean>;
  /** Close it. Later calls reject. */
  close(): Promise<void>;
}

/** Options for {@linkcode openSqlite} and {@linkcode deleteSqlite}. */
export interface SqliteOptions {
  /**
   * The web engine's files, when the build does not provide them. The esbuild (SPA /
   * compat) build finds an installed `@sqlite.org/sqlite-wasm` itself; pass these to serve
   * the engine from elsewhere.
   */
  readonly web?: SqliteWasmUrls;
  /**
   * Open it encrypted (SQLCipher) with this passphrase, as `PRAGMA key = '…'` does: only in the
   * shell, through `@capacitor-community/sqlite` with encryption on in `capacitor.config.ts`
   * (`plugins.CapacitorSQLite.iosIsEncryption` / `androidIsEncryption: true`). The plugin keeps
   * ONE passphrase for every database of the app (in the Keychain / Keystore): a different one
   * is refused (`WRONG_KEY`). A plain database of that name is encrypted in place. The web
   * engine and Deno Desktop have no SQLCipher: they refuse with `ENCRYPTION_UNAVAILABLE` before
   * anything is opened. Keep the passphrase itself in `secureStore`. (`openSqlite` only;
   * ignored by `deleteSqlite`.)
   */
  readonly encryptionKey?: string;
}

/** Why {@linkcode SqliteEncryptionError} was thrown. */
export type SqliteEncryptionErrorCode =
  | "ENCRYPTION_UNAVAILABLE"
  | "WRONG_KEY"
  | "KEY_REQUIRED"
  | "UNSUPPORTED";

/**
 * A refused encryption request: `ENCRYPTION_UNAVAILABLE` (this backing has no SQLCipher, or the
 * plugin has encryption off; nothing ran), `WRONG_KEY` (another passphrase than the one the
 * plugin keeps), `KEY_REQUIRED` (the database is encrypted: run `PRAGMA key` first) or
 * `UNSUPPORTED` (a key pragma other than `PRAGMA key = '…'` as the first statement, such as
 * `PRAGMA rekey`).
 */
export class SqliteEncryptionError extends Error {
  /** Why. */
  readonly code: SqliteEncryptionErrorCode;

  /**
   * A refusal with its code.
   *
   * @param code Why.
   * @param message What happened and what to do.
   */
  constructor(code: SqliteEncryptionErrorCode, message: string) {
    super(message);
    this.name = "SqliteEncryptionError";
    this.code = code;
  }
}

/** The encryption methods of `@capacitor-community/sqlite`. */
interface CapacitorSqliteCipher {
  isSecretStored(): Promise<{ result?: boolean }>;
  setEncryptionSecret(options: { passphrase: string }): Promise<void>;
  checkEncryptionSecret(options: { passphrase: string }): Promise<{ result?: boolean }>;
  isDatabaseEncrypted(options: { database: string }): Promise<{ result?: boolean }>;
}

/** The slice of `@capacitor-community/sqlite`'s native plugin this module calls. */
interface CapacitorSqlitePlugin {
  checkConnectionsConsistency(options: {
    dbNames: string[];
    openModes: string[];
  }): Promise<{ result?: boolean }>;
  createConnection(options: {
    database: string;
    version: number;
    encrypted: boolean;
    mode: string;
    readonly: boolean;
  }): Promise<void>;
  open(options: { database: string; readonly: boolean }): Promise<void>;
  isDBOpen(options: { database: string; readonly: boolean }): Promise<{ result?: boolean }>;
  close(options: { database: string; readonly: boolean }): Promise<void>;
  closeConnection(options: { database: string; readonly: boolean }): Promise<void>;
  run(options: {
    database: string;
    statement: string;
    values: unknown[];
    transaction: boolean;
    readonly: boolean;
    returnMode: string;
  }): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  query(options: {
    database: string;
    statement: string;
    values: unknown[];
    readonly: boolean;
  }): Promise<{ values?: Array<Record<string, unknown>> }>;
  isTransactionActive(options: { database: string; readonly: boolean }): Promise<{
    result?: boolean;
  }>;
  deleteDatabase(options: { database: string; readonly: boolean }): Promise<void>;
}

/** The plugin's encryption methods, when it has them all. */
function cipherOf(plugin: CapacitorSqlitePlugin): CapacitorSqliteCipher | undefined {
  const p = plugin as Partial<CapacitorSqliteCipher>;
  const all = [p.isSecretStored, p.setEncryptionSecret, p.checkEncryptionSecret];
  return all.every((fn) => typeof fn === "function") && typeof p.isDatabaseEncrypted === "function"
    ? plugin as unknown as CapacitorSqliteCipher
    : undefined;
}

/** The native plugin, when the shell has it. */
function sqlitePlugin(): CapacitorSqlitePlugin | undefined {
  return nativePlugin<CapacitorSqlitePlugin>("CapacitorSQLite", [
    "checkConnectionsConsistency",
    "createConnection",
    "open",
    "isDBOpen",
    "close",
    "closeConnection",
    "run",
    "query",
    "isTransactionActive",
    "deleteDatabase",
  ]);
}

// --- SQL text ----------------------------------------------------------------

/** The end of the quoted run starting at `i` (`'…'`, `"…"`, `` `…` ``, `[…]`), doubled quotes kept. */
function quotedEnd(sql: string, i: number): number {
  const close = sql[i] === "[" ? "]" : sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (close !== "]" && sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

/** The end of the comment starting at `i`, or -1 when none starts there. */
function commentEnd(sql: string, i: number): number {
  if (sql.startsWith("--", i)) {
    const nl = sql.indexOf("\n", i);
    return nl === -1 ? sql.length : nl + 1;
  }
  if (sql.startsWith("/*", i)) {
    const end = sql.indexOf("*/", i + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return -1;
}

/** One lexical piece of SQL: code, a quoted run, or a comment. */
interface Piece {
  readonly kind: "code" | "quoted" | "comment";
  readonly text: string;
}

/** Split SQL into code, quoted runs and comments (so `;` and `?` are only seen in code). */
function lex(sql: string): Piece[] {
  const pieces: Piece[] = [];
  let code = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const comment = commentEnd(sql, i);
    const quoted = c === "'" || c === '"' || c === "`" || c === "[";
    if (comment === -1 && !quoted) {
      code += c;
      i++;
      continue;
    }
    if (code) pieces.push({ kind: "code", text: code });
    code = "";
    const end = comment !== -1 ? comment : quotedEnd(sql, i);
    pieces.push({ kind: comment !== -1 ? "comment" : "quoted", text: sql.slice(i, end) });
    i = end;
  }
  if (code) pieces.push({ kind: "code", text: code });
  return pieces;
}

/** Whether a statement (comments stripped) opens a trigger, whose body holds `;`s. */
function isTrigger(statement: string): boolean {
  return /^\s*create\s+(?:temp\s+|temporary\s+)?trigger\b/i.test(statement);
}

/**
 * Split `sql` into its statements at the `;`s outside quotes, comments and trigger bodies,
 * with comments dropped (a comment becomes a space). Empty statements are left out.
 *
 * @param sql One or more statements.
 * @returns The statements, without their `;`.
 */
export function splitSqlStatements(sql: string): string[] {
  const splitter = new StatementSplitter();
  for (const piece of lex(sql)) {
    if (piece.kind === "code") {
      for (const part of piece.text.split(/(;|\bbegin\b|\bend\b|\bcase\b)/i)) {
        splitter.code(part);
      }
    } else splitter.text(piece.kind === "comment" ? " " : piece.text);
  }
  return splitter.finish();
}

/** The statement being built, and the `BEGIN … END` depth inside a trigger body. */
class StatementSplitter {
  #out: string[] = [];
  #current = "";
  #depth = 0;

  /** Text that cannot end a statement (a quoted run, or a comment's stand-in space). */
  text(text: string): void {
    this.#current += text;
  }

  /** A piece of code: a `;`, a `begin` / `end` / `case` keyword, or the code between them. */
  code(part: string): void {
    if (part === ";" && this.#depth === 0) return this.#flush();
    const word = part.toLowerCase();
    if ((word === "begin" || word === "case") && isTrigger(this.#current)) this.#depth++;
    else if (word === "end" && this.#depth > 0) this.#depth--;
    this.#current += part;
  }

  /** The statements, the last one included. */
  finish(): string[] {
    this.#flush();
    return this.#out;
  }

  #flush(): void {
    if (this.#current.trim()) this.#out.push(this.#current.trim());
    this.#current = "";
  }
}

/** Whether a statement returns rows (so it goes through `query`, not `run`, natively). */
function returnsRows(statement: string): boolean {
  if (/^\s*(?:select|pragma|with|values|explain)\b/i.test(statement)) return true;
  return lex(statement).some((p) => p.kind === "code" && /\breturning\b/i.test(p.text));
}

/**
 * Positional values for `params`: an array as given; a named record ordered the way SQLite
 * numbers named parameters (each distinct name at its first appearance). A name the record
 * lacks binds null, as an unbound parameter does.
 *
 * @param sql The statement.
 * @param params Its parameters.
 * @returns The values in parameter order.
 */
export function positionalParams(sql: string, params: SqliteParams): SqliteBindValue[] {
  if (Array.isArray(params)) return [...params];
  const named = params as Readonly<Record<string, SqliteBindValue>>;
  const order: string[] = [];
  for (const piece of lex(sql)) {
    if (piece.kind !== "code") continue;
    for (const match of piece.text.matchAll(/[:@$][A-Za-z_][A-Za-z0-9_]*/g)) {
      if (!order.includes(match[0])) order.push(match[0]);
    }
  }
  return order.map((name) => (Object.hasOwn(named, name) ? named[name] : null));
}

// --- native ------------------------------------------------------------------

/** Values as the plugin binds them: booleans as 1/0, blobs as byte arrays. */
function nativeValues(values: SqliteBindValue[]): unknown[] {
  return values.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof Uint8Array) return Array.from(v);
    if (v instanceof ArrayBuffer) return Array.from(new Uint8Array(v));
    return v;
  });
}

/**
 * The plugin's rows as {@linkcode SqliteRows}. iOS leads with a `{ ios_columns: […] }` entry
 * naming the columns in order; Android reports rows only (column order follows each row's
 * keys). A blob comes back as an array of bytes.
 */
function nativeRows(values: Array<Record<string, unknown>> | undefined): SqliteRows {
  const list = values ?? [];
  let columns: string[] | null = null;
  let start = 0;
  const head = list[0];
  if (head && Array.isArray(head.ios_columns)) {
    columns = head.ios_columns.map(String);
    start = 1;
  }
  const rows: SqliteValue[][] = [];
  for (const row of list.slice(start)) {
    columns ??= Object.keys(row);
    rows.push(columns.map((c) => {
      const v = row[c];
      if (Array.isArray(v)) return Uint8Array.from(v as number[]);
      return v === undefined ? null : v as SqliteValue;
    }));
  }
  return { columns: columns ?? [], rows };
}

/** The plugin's database name for `name`: it appends `SQLite.db` itself, so a `.db` is dropped. */
function nativeName(name: string): string {
  return name.replace(/\.db$/i, "");
}

/** Whether the plugin's leftover connections were reset for this page. */
let nativeReset: Promise<unknown> | null = null;

/** An error's message. */
function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** The plugin's "encryption is off" refusal, as an {@linkcode SqliteEncryptionError}. */
function nativeFailure(name: string, err: unknown): unknown {
  if (!/no encryption set in capacitor\.config|'no encryption'/i.test(messageOf(err))) return err;
  return new SqliteEncryptionError(
    "ENCRYPTION_UNAVAILABLE",
    `openSqlite("${name}"): @capacitor-community/sqlite has encryption off; set ` +
      "plugins.CapacitorSQLite.iosIsEncryption and androidIsEncryption to true in " +
      "capacitor.config.ts, then rebuild the app.",
  );
}

/** A plugin call that failed because the plugin dropped the connection (another database keyed). */
function lostConnection(err: unknown): boolean {
  return /no available connection|connection to .* not available/i.test(messageOf(err));
}

/**
 * Open `name` through the plugin. A page reload keeps the native side's connections, so the
 * first open of a page closes them all (the plugin's own consistency check with an empty
 * list), then opens fresh. With `passphrase` it opens encrypted; without, an encrypted file is
 * left locked until `PRAGMA key` ({@linkcode SqliteDriver.encrypt}).
 */
async function openNative(
  plugin: CapacitorSqlitePlugin,
  name: string,
  passphrase?: string,
): Promise<SqliteDriver> {
  const database = nativeName(name);
  const conn = { database, readonly: false };
  nativeReset ??= plugin.checkConnectionsConsistency({ dbNames: [], openModes: [] })
    .catch(() => {});
  await nativeReset;
  let encrypted = false;
  /** Whether the file is encrypted and no key was given yet. */
  let locked = false;
  /** Whether the page closed it (a dropped connection is then not reopened). */
  let closed = false;
  const connect = async (mode: string) => {
    try {
      await plugin.createConnection({
        database,
        version: 1,
        encrypted: mode !== "no-encryption",
        mode,
        readonly: false,
      });
    } catch (err) {
      if (!/already exists/i.test(messageOf(err))) throw nativeFailure(name, err);
    }
    if (!(await plugin.isDBOpen(conn)).result) await plugin.open(conn);
  };
  const encrypt = async (key: string) => {
    const cipher = cipherOf(plugin);
    if (!cipher) {
      throw new SqliteEncryptionError(
        "ENCRYPTION_UNAVAILABLE",
        `openSqlite("${name}"): this @capacitor-community/sqlite has no encryption methods.`,
      );
    }
    try {
      if (!(await cipher.isSecretStored()).result) {
        await cipher.setEncryptionSecret({ passphrase: key });
      } else if (!(await cipher.checkEncryptionSecret({ passphrase: key })).result) {
        throw new SqliteEncryptionError(
          "WRONG_KEY",
          `openSqlite("${name}"): @capacitor-community/sqlite keeps one passphrase for every ` +
            "database of the app, and this one is not it.",
        );
      }
      // Setting or checking the secret closed every connection the plugin had: open anew,
      // encrypting a plain file in place, else opening (or creating) an encrypted one.
      const plain = await cipher.isDatabaseEncrypted({ database })
        .then((r) => r.result !== true, () => false);
      await plugin.closeConnection(conn).catch(() => {});
      await connect(plain ? "encryption" : "secret");
    } catch (err) {
      throw err instanceof SqliteEncryptionError ? err : nativeFailure(name, err);
    }
    encrypted = true;
    locked = false;
  };
  if (passphrase !== undefined) {
    await encrypt(passphrase);
  } else {
    try {
      await connect("no-encryption");
    } catch (err) {
      const cipher = cipherOf(plugin);
      const isEncrypted = cipher &&
        await cipher.isDatabaseEncrypted({ database }).then((r) => r.result === true, () => false);
      if (!isEncrypted) throw err;
      locked = true;
    }
  }
  /** Run `call`, reconnecting once when the plugin dropped the connection. */
  const live = async <T>(call: () => Promise<T>): Promise<T> => {
    if (locked) {
      throw new SqliteEncryptionError(
        "KEY_REQUIRED",
        `openSqlite("${name}"): the database is encrypted; run PRAGMA key = '…' first (or open ` +
          "it with encryptionKey).",
      );
    }
    try {
      return await call();
    } catch (err) {
      if (closed || !lostConnection(err)) throw err;
      await connect(encrypted ? "secret" : "no-encryption");
      return await call();
    }
  };
  const run = (statement: string, values: SqliteBindValue[]) =>
    live(async () => {
      const res = await plugin.run({
        ...conn,
        statement,
        values: nativeValues(values),
        transaction: false,
        returnMode: "no",
      });
      return {
        changes: Math.max(0, res.changes?.changes ?? 0),
        lastInsertRowId: Math.max(0, res.changes?.lastId ?? 0),
      };
    });
  const query = (statement: string, values: SqliteBindValue[]) =>
    live(async () =>
      nativeRows((await plugin.query({ ...conn, statement, values: nativeValues(values) })).values)
    );
  return {
    backend: "native",
    encrypt,
    async exec(sql) {
      for (const statement of splitSqlStatements(sql)) {
        if (returnsRows(statement)) await query(statement, []);
        else await run(statement, []);
      }
    },
    async run(sql, params) {
      const values = positionalParams(sql, params);
      if (!returnsRows(sql)) return await run(sql, values);
      await query(sql, values);
      return { changes: 0, lastInsertRowId: 0 };
    },
    query(sql, params) {
      return query(sql, positionalParams(sql, params));
    },
    async inTransaction() {
      return (await plugin.isTransactionActive(conn)).result === true;
    },
    async close() {
      closed = true;
      await plugin.close(conn).catch(() => {});
      await plugin.closeConnection(conn);
    },
  };
}

// --- web ---------------------------------------------------------------------

/** The engine's files: the caller's, else what the build found, else null. */
async function webUrls(options: SqliteOptions | undefined): Promise<SqliteWasmUrls> {
  if (options?.web) return options.web;
  // A page that loads the prebuilt runtime unbundled (the per-module dev loop) cannot
  // resolve the bridge's bare specifier: treat it as "no engine".
  const { moduleUrl, wasmUrl } = await import("./sqlite-wasm.ts").catch(() => ({
    moduleUrl: null,
    wasmUrl: null,
  }));
  if (moduleUrl && wasmUrl) return { moduleUrl, wasmUrl };
  throw new Error(
    "openSqlite: the web backing needs @sqlite.org/sqlite-wasm — install it in the app " +
      "(`npm install @sqlite.org/sqlite-wasm`) and rebuild. The engine is emitted by the " +
      "bundled esbuild pipeline (SPA and compat builds, and their bundled dev loop); " +
      "elsewhere pass `web: { moduleUrl, wasmUrl }`.",
  );
}

// --- public ------------------------------------------------------------------

/** Refuse a name that is empty or would leave the database folder. */
function checkName(fn: string, name: string): void {
  if (typeof name !== "string" || name === "" || /[/\\]|^\.\.?$/.test(name)) {
    throw new TypeError(`${fn}: "${String(name)}" is not a database name (no slashes)`);
  }
}

/** A SQLCipher key pragma's name: `key`, `rekey`, `hexkey`, `textrekey`, … */
const KEY_PRAGMA = /^\s*pragma\s+(?:[\w"`[\]]+\s*\.\s*)?((?:hex|text)?(?:re)?key)\b/i;

/** `'…'` / `"…"` as its text (doubled quotes undone), or undefined for anything else. */
function quotedText(text: string): string | undefined {
  const m = /^\s*(?:=\s*|\(\s*)('(?:[^']|'')*'|"(?:[^"]|"")*")\s*\)?\s*$/.exec(text);
  if (!m) return undefined;
  const q = m[1][0];
  return m[1].slice(1, -1).replaceAll(q + q, q);
}

/**
 * The passphrase of the `PRAGMA key = '…'` that `sql` starts with, and the statements after it;
 * null when `sql` runs no key pragma. Any other key pragma (`rekey`, `hexkey`, one that is not
 * first) is refused.
 */
function keyPragma(name: string, sql: string): { passphrase: string; rest: string[] } | null {
  if (!/pragma/i.test(sql) || !/key/i.test(sql)) return null;
  const statements = splitSqlStatements(sql);
  const at = statements.findIndex((st) => KEY_PRAGMA.test(st));
  if (at === -1) return null;
  const m = KEY_PRAGMA.exec(statements[at])!;
  const passphrase = quotedText(statements[at].slice(m.index + m[0].length));
  if (at !== 0 || m[1].toLowerCase() !== "key" || passphrase === undefined) {
    throw new SqliteEncryptionError(
      "UNSUPPORTED",
      `openSqlite("${name}"): only PRAGMA key = '<passphrase>', as the first statement, is ` +
        `supported (not "${statements[at].trim()}"); nothing ran.`,
    );
  }
  if (statements.slice(1).some((st) => KEY_PRAGMA.test(st))) {
    throw new SqliteEncryptionError(
      "UNSUPPORTED",
      `openSqlite("${name}"): one key pragma per call; nothing ran.`,
    );
  }
  return { passphrase, rest: statements.slice(1) };
}

/** Why `driver` cannot encrypt. */
function noCipher(name: string, driver: SqliteDriver): SqliteEncryptionError {
  const where = driver.backend === "native"
    ? "the Deno Desktop runtime's SQLite"
    : "the web build's SQLite (@sqlite.org/sqlite-wasm)";
  return new SqliteEncryptionError(
    "ENCRYPTION_UNAVAILABLE",
    `openSqlite("${name}"): encryption needs SQLCipher, which ${where} does not have, so the ` +
      "database would stay unencrypted; nothing ran. Encrypted databases run in the iOS / " +
      "Android app (`denext mobile add sqlite`).",
  );
}

/** The public face over a driver; a `PRAGMA key` keys the database through the driver. */
function database(name: string, driver: SqliteDriver): SqliteDatabase {
  /** Run `sql`'s key pragma; the statements after it, or null when it has none. */
  const keyed = async (sql: string): Promise<string[] | null> => {
    const pragma = keyPragma(name, sql);
    if (!pragma) return null;
    if (!driver.encrypt) throw noCipher(name, driver);
    await driver.encrypt(pragma.passphrase);
    return pragma.rest;
  };
  const query = async (sql: string, params: SqliteParams): Promise<SqliteRows> => {
    const rest = await keyed(sql);
    if (rest === null) return await driver.query(sql, params);
    return rest.length === 0
      ? { columns: [], rows: [] }
      : await driver.query(rest.join(";"), params);
  };
  return {
    name,
    backend: driver.backend,
    async exec(sql) {
      const rest = await keyed(sql);
      if (rest === null) return await driver.exec(sql);
      if (rest.length > 0) await driver.exec(rest.join(";\n"));
    },
    async run(sql, params = []) {
      const rest = await keyed(sql);
      if (rest === null) return await driver.run(sql, params);
      return rest.length === 0
        ? { changes: 0, lastInsertRowId: 0 }
        : await driver.run(rest.join(";"), params);
    },
    async query<T>(sql: string, params: SqliteParams = []): Promise<T[]> {
      const { columns, rows } = await query(sql, params);
      return rows.map((row) => {
        const obj: SqliteRow = {};
        columns.forEach((column, i) => (obj[column] = row[i]));
        return obj as T;
      });
    },
    queryRows: (sql, params = []) => query(sql, params),
    inTransaction: () => driver.inTransaction(),
    close: () => driver.close(),
  };
}

/**
 * Open (creating when missing) the SQLite database `name`.
 *
 * - Inside the native shell with `@capacitor-community/sqlite` installed (`denext mobile add
 *   sqlite`), it is a file in the app's storage, opened through the plugin.
 * - In a Deno Desktop window (`denext desktop add sqlite`), it is a file in the app's folder
 *   of the OS app-support directory, opened with `node:sqlite` in the desktop runtime
 *   (`backend: "native"`).
 * - In the browser it runs the app's own `@sqlite.org/sqlite-wasm` (`npm install
 *   @sqlite.org/sqlite-wasm`; denext ships no npm runtime dependency) in a worker, persisted
 *   to the Origin Private File System through the engine's `opfs-sahpool` VFS, which needs
 *   no cross-origin isolation. Where that is not possible (no OPFS, or another tab of the
 *   origin holds the pool) the database lives in memory for the session:
 *   {@linkcode SqliteDatabase.backend} is then `"memory"`.
 *
 * Integers beyond 2^53 lose precision (rows carry JS numbers). Natively, parameters bind
 * positionally, so a named record is reordered to SQLite's parameter numbering.
 *
 * Encryption (SQLCipher): `encryptionKey`, or `PRAGMA key = '…'` as the first statement run on
 * it (expo-sqlite's way), keys the database in the shell through `@capacitor-community/sqlite`
 * (see {@linkcode SqliteOptions.encryptionKey}). The web engine and Deno Desktop have no
 * SQLCipher, so both refuse with a {@linkcode SqliteEncryptionError} and run nothing, rather
 * than leave the data unencrypted.
 *
 * @example
 * ```ts
 * import { openSqlite } from "denext/mobile";
 *
 * const db = await openSqlite("app.db");
 * await db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
 * await db.run("INSERT INTO notes (body) VALUES (?)", ["hello"]);
 * const notes = await db.query<{ id: number; body: string }>("SELECT * FROM notes");
 * ```
 *
 * @param name The database name (a file name: no slashes).
 * @param options Where the web engine is, when the build does not provide it, and the
 * `encryptionKey`.
 * @returns The open database.
 */
export async function openSqlite(name: string, options?: SqliteOptions): Promise<SqliteDatabase> {
  checkName("openSqlite", name);
  const key = options?.encryptionKey;
  if (key !== undefined && (typeof key !== "string" || key === "")) {
    throw new TypeError("openSqlite: encryptionKey must be a non-empty string");
  }
  const plugin = onDesktop() ? undefined : sqlitePlugin();
  if (key !== undefined && !plugin) {
    throw noCipher(name, { backend: onDesktop() ? "native" : "opfs" } as SqliteDriver);
  }
  const desktop = onDesktop() && await viaDesktop("sqlite", (d) => d.openDesktopSqlite(name), true);
  if (desktop) return database(name, desktop.value);
  const driver = plugin
    ? await openNative(plugin, name, key)
    : await openWebSqlite(name, await webUrls(options));
  return database(name, driver);
}

/**
 * Delete the database `name` (closing it first when open). A missing database is not an
 * error.
 *
 * @param name The database name.
 * @param options Where the web engine is, when the build does not provide it.
 */
export async function deleteSqlite(name: string, options?: SqliteOptions): Promise<void> {
  checkName("deleteSqlite", name);
  if (onDesktop() && await viaDesktop("sqlite", (d) => d.deleteDesktopSqlite(name), true)) return;
  const plugin = sqlitePlugin();
  if (!plugin) return await deleteWebSqlite(name, await webUrls(options));
  const conn = { database: nativeName(name), readonly: false };
  const driver = await openNative(plugin, name);
  await plugin.deleteDatabase(conn);
  await driver.close().catch(() => {});
}

/** Forget that this page reset the plugin's connections (tests). */
export function resetSqliteForTesting(): void {
  nativeReset = null;
}
