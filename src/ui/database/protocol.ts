// The contract between `denext ui`'s Database section and the child that does its work.
//
// The UI process never opens the project's database itself: it would have to evaluate the
// project's config (where `backend({ postgres })`, a custom `sql` client and the storage buckets
// are declared), and the UI never runs project code. Every request below is written as JSON to
// the stdin of a `denext db-admin --json` child (`src/cli/commands/db-admin.ts`), which loads
// the project, opens the connection, runs the one operation and prints a {@linkcode DbReply}.
//
// Types only, plus the limits both sides enforce — nothing here touches a database.

/** The longest a single statement may run, in ms (`SET LOCAL statement_timeout`). */
export const DB_STATEMENT_TIMEOUT_MS = 5_000;

/** The statement timeout for applying migrations, which may legitimately run longer. */
export const DB_MIGRATE_TIMEOUT_MS = 60_000;

/** Rows per page of the row browser (and of the user list). */
export const DB_PAGE_ROWS = 50;

/** The most tables the overview lists. */
export const DB_MAX_TABLES = 1_000;

/** The longest cell value the row browser shows before cutting it (the row view shows more). */
export const DB_CELL_PREVIEW_CHARS = 200;

/** The longest cell value the row view shows. */
export const DB_CELL_MAX_CHARS = 65_536;

/** The longest value a cell edit or an insert may carry. */
export const DB_VALUE_MAX_CHARS = 65_536;

/** The largest object the storage browser downloads through the UI. */
export const DB_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Objects per page of the storage browser. */
export const DB_OBJECTS_PAGE = 50;

/** The largest object the storage browser uploads through the UI. */
export const DB_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** The longest the SQL editor's statement may run, in ms. */
export const DB_SQL_TIMEOUT_MS = 30_000;

/** The longest text the SQL editor runs. */
export const DB_SQL_MAX_CHARS = 100_000;

/** The most result rows the SQL editor shows (the rest are counted, not sent). */
export const DB_SQL_MAX_ROWS = 500;

/** The ban lengths the Users page offers, in seconds ("until unbanned" is a century). */
export const DB_BAN_DURATIONS: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 7 * 86_400, label: "7 days" },
  { seconds: 30 * 86_400, label: "30 days" },
  { seconds: 365 * 86_400, label: "1 year" },
  { seconds: 100 * 365 * 86_400, label: "Until unbanned" },
];

/** The shortest password the Users page sets (denext auth's own minimum). */
export const DB_MIN_PASSWORD = 8;

/** The longest password the Users page sets (denext auth's own maximum). */
export const DB_MAX_PASSWORD = 1024;

/** Who a read runs as: the service role (no row-level security), `anon`, or a user. */
export type DbActor =
  | { readonly kind: "service" }
  | { readonly kind: "anon" }
  | { readonly kind: "user"; readonly id: string; readonly email?: string };

/** A `column = value` filter (`value: null` is `IS NULL`). */
export interface DbFilter {
  /** The column (checked against the catalog). */
  readonly column: string;
  /** The value, cast to the column's type; `null` for `IS NULL`. */
  readonly value: string | null;
}

/** Every operation the child answers. Writes carry `confirm`: without it they only preview. */
export type DbRequest =
  | { readonly op: "overview" }
  | { readonly op: "table"; readonly schema: string; readonly table: string }
  | {
    readonly op: "rows";
    readonly schema: string;
    readonly table: string;
    readonly sort?: string;
    readonly direction?: "asc" | "desc";
    readonly after?: readonly (string | null)[];
    readonly filter?: DbFilter;
    readonly actor?: DbActor;
  }
  | {
    readonly op: "row";
    readonly schema: string;
    readonly table: string;
    readonly key: Readonly<Record<string, string>>;
  }
  | {
    readonly op: "write";
    readonly action: "update" | "insert" | "delete";
    readonly schema: string;
    readonly table: string;
    readonly key?: Readonly<Record<string, string>>;
    readonly values?: Readonly<Record<string, string | null>>;
    readonly confirm: boolean;
  }
  | { readonly op: "policies" }
  | { readonly op: "migrations" }
  | { readonly op: "migrate"; readonly confirm: boolean }
  | { readonly op: "buckets" }
  | {
    readonly op: "objects";
    readonly bucket: string;
    readonly prefix?: string;
    readonly cursor?: string;
  }
  | { readonly op: "download"; readonly bucket: string; readonly key: string }
  | {
    readonly op: "removeObject";
    readonly bucket: string;
    readonly key: string;
    readonly confirm: boolean;
  }
  | {
    readonly op: "upload";
    readonly bucket: string;
    readonly key: string;
    /** The bytes, base64 (at most {@linkcode DB_UPLOAD_MAX_BYTES} decoded). */
    readonly base64: string;
    readonly contentType?: string;
    /** Replace an object already at `key` (otherwise that is refused). */
    readonly upsert: boolean;
  }
  | { readonly op: "users"; readonly after?: string; readonly query?: string }
  | { readonly op: "user"; readonly id: string }
  | {
    readonly op: "userAction";
    readonly action: DbUserAction;
    readonly id: string;
    /** `ban`: how long, in seconds (one of {@linkcode DB_BAN_DURATIONS}). */
    readonly seconds?: number;
    /** `password`: the new password (never echoed back; its hash is masked in previews). */
    readonly password?: string;
    readonly confirm: boolean;
  }
  | {
    readonly op: "createUser";
    readonly email: string;
    readonly name?: string;
    /** A password to sign in with; absent: the user signs in another way (a link, OAuth). */
    readonly password?: string;
    /** Mark the email verified (an admin vouches for it). */
    readonly verified: boolean;
  }
  | {
    readonly op: "sql";
    /** The statement(s), run as the connecting role — the editor is admin-only by design. */
    readonly text: string;
    /** `read`: a `READ ONLY` transaction; `write`: one that commits. */
    readonly mode: "read" | "write";
  };

/** What the Users page can do to one user. */
export type DbUserAction = "revoke" | "delete" | "ban" | "unban" | "password";

/** What the child is told besides the operation. */
export interface DbEnvelope {
  /** `denext ui --read-only`: the child refuses every write and runs reads `READ ONLY`. */
  readonly readOnly: boolean;
  /** The operation. */
  readonly request: DbRequest;
}

/** Why a request failed, as a machine-readable code. */
export type DbErrorCode =
  | "not_configured"
  | "unsupported"
  | "bad_request"
  | "read_only"
  | "not_found"
  | "query_failed";

/** A failed request. */
export interface DbFailure {
  /** Always false. */
  readonly ok: false;
  /** What kind of failure. */
  readonly code: DbErrorCode;
  /** The reason, with any connection-string password masked. */
  readonly reason: string;
  /** The statement that failed, when one did. */
  readonly sql?: string;
}

/** A table, as the overview lists it. */
export interface DbTableSummary {
  /** Its schema. */
  readonly schema: string;
  /** Its name. */
  readonly name: string;
  /** `table`, `partitioned`, `view`, `materialized view` or `foreign table`. */
  readonly kind: string;
  /** The planner's row estimate (`null` before the table was ever analyzed). */
  readonly estimate: number | null;
  /** Row-level security is enabled. */
  readonly rls: boolean;
  /** Row-level security is forced (applies to the owner too). */
  readonly forced: boolean;
  /** It has a primary key (the row browser can page and edit it). */
  readonly hasPrimaryKey: boolean;
}

/** One column. */
export interface DbColumn {
  /** Its name. */
  readonly name: string;
  /** Its type, as Postgres prints it (`character varying(40)`). */
  readonly type: string;
  /** Its type without a modifier — what a value is cast to (`character varying`). */
  readonly castType: string;
  /** It may be NULL. */
  readonly nullable: boolean;
  /** Its default expression. */
  readonly default: string | null;
  /** `always` / `by default` for an identity column. */
  readonly identity: "always" | "by default" | null;
  /** A generated (computed) column: never written. */
  readonly generated: boolean;
}

/** A table's structure. */
export interface DbTableInfo extends DbTableSummary {
  /** The columns, in order. */
  readonly columns: readonly DbColumn[];
  /** The primary key's columns, in key order (empty without one). */
  readonly primaryKey: readonly string[];
  /** The indexes. */
  readonly indexes: readonly { name: string; definition: string }[];
  /** The foreign keys. */
  readonly foreignKeys: readonly { name: string; definition: string }[];
  /** The table's row-level security policies. */
  readonly policies: readonly DbPolicy[];
}

/** One row-level security policy (`pg_policies`). */
export interface DbPolicy {
  /** The table's schema. */
  readonly schema: string;
  /** The table. */
  readonly table: string;
  /** The policy's name. */
  readonly name: string;
  /** `PERMISSIVE` or `RESTRICTIVE`. */
  readonly permissive: string;
  /** The roles it applies to. */
  readonly roles: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  readonly command: string;
  /** Its `USING` expression. */
  readonly using: string | null;
  /** Its `WITH CHECK` expression. */
  readonly check: string | null;
}

/** A statement as it will be (or was) sent: the text and its bound parameters. */
export interface DbStatement {
  /** The SQL text (identifiers quoted from the catalog; every value a `$n` parameter). */
  readonly text: string;
  /** The parameters, as text (each cast in the SQL to its column's type). */
  readonly params: readonly (string | null)[];
}

/** One stored object. */
export interface DbObject {
  /** Its key. */
  readonly key: string;
  /** Its size in bytes. */
  readonly size: number;
  /** Its content type, when the store reports it in listings. */
  readonly contentType?: string;
  /** When it was last written (ISO). */
  readonly lastModified?: string;
}

/** One auth user. */
export interface DbAuthUser {
  /** The user id. */
  readonly id: string;
  /** The email. */
  readonly email: string | null;
  /** The display name. */
  readonly name: string | null;
  /** The roles (a JSON array, as stored). */
  readonly roles: string | null;
  /** Created (epoch seconds). */
  readonly createdAt: number | null;
  /** Live sessions in the session store plus live native-app sessions. */
  readonly sessions: number;
  /** A confirmed second factor (TOTP). */
  readonly mfa: boolean;
  /** Registered passkeys. */
  readonly passkeys: number;
  /** Banned until (epoch seconds), when a ban is in force. */
  readonly bannedUntil?: number | null;
}

/** One migration's state. */
export interface DbMigration {
  /** The file name. */
  readonly name: string;
  /** `applied`, `pending` or `changed` (applied, then edited). */
  readonly state: "applied" | "pending" | "changed";
  /** When it was applied (ISO). */
  readonly appliedAt?: string;
}

/** The answer to each operation, keyed by `op`. */
export interface DbReplies {
  /** `overview`. */
  overview: {
    /** The connection, its password masked. */
    connection: string;
    /** Where it came from: the backend plugin, or `DATABASE_URL`. */
    source: "backend" | "env";
    /** Whether the backend plugin declares storage. */
    storage: boolean;
    /** The schema holding denext auth's tables, when there is one. */
    authSchema: string | null;
    /** The tables. */
    tables: DbTableSummary[];
    /** True when the list was cut at {@linkcode DB_MAX_TABLES}. */
    truncated: boolean;
  };
  /** `table`. */
  table: { table: DbTableInfo };
  /** `rows`. */
  rows: {
    table: DbTableInfo;
    rows: Record<string, string | null>[];
    /** The cursor of the next page, when there is one. */
    next?: (string | null)[];
    /** The statement that read the page. */
    statement: DbStatement;
  };
  /** `row`. */
  row: { table: DbTableInfo; row: Record<string, string | null> | null };
  /** `write`. */
  write: { statement: DbStatement; applied: boolean; affected?: number };
  /** `policies`. */
  policies: { tables: DbTableSummary[]; policies: DbPolicy[] };
  /** `migrations`. */
  migrations: {
    /** The migrations directory, relative to the project (`migrations`). */
    dir: string;
    migrations: DbMigration[];
    /** Recorded as applied but no longer on disk. */
    unknown: string[];
    /** Each pending migration's SQL — what applying would run. */
    pendingSql: { name: string; sql: string }[];
  };
  /** `migrate`. */
  migrate: { pending: string[]; applied: string[]; pendingSql: { name: string; sql: string }[] };
  /** `buckets`. */
  buckets: {
    driver: string | null;
    buckets: { name: string; public: boolean; maxBytes: number; mime: string[] | null }[];
  };
  /** `objects`. */
  objects: { bucket: string; objects: DbObject[]; cursor?: string };
  /** `download`. */
  download: { key: string; contentType: string; size: number; base64: string };
  /** `removeObject`. */
  removeObject: { bucket: string; key: string; applied: boolean };
  /** `upload`. */
  upload: { bucket: string; key: string; size: number };
  /** `users`. */
  users: { schema: string | null; users: DbAuthUser[]; next?: string };
  /** `user`. */
  user: { schema: string | null; user: DbAuthUser | null };
  /** `userAction`. */
  userAction: { statements: DbStatement[]; applied: boolean };
  /** `createUser`. */
  createUser: { id: string; statements: DbStatement[] };
  /** `sql`. */
  sql: DbSqlResult;
}

/** What the SQL editor shows: the last statement's rows, as text. */
export interface DbSqlResult {
  /** The transaction it ran in. */
  readonly mode: "read" | "write";
  /** The result's column names (empty when it returned no rows). */
  readonly columns: string[];
  /** Up to {@linkcode DB_SQL_MAX_ROWS} rows, each a list of values as text (or `null`). */
  readonly cells: (string | null)[][];
  /** How many rows it returned in all. */
  readonly rowCount: number;
  /** True when rows were cut at {@linkcode DB_SQL_MAX_ROWS}. */
  readonly truncated: boolean;
  /** How long it took, in ms. */
  readonly ms: number;
}

/** A successful answer to `op`. */
export type DbSuccess<K extends keyof DbReplies> = { readonly ok: true } & DbReplies[K];

/** What the child prints. */
export type DbReply<K extends keyof DbReplies = keyof DbReplies> = DbSuccess<K> | DbFailure;

/**
 * Mask the password in every `postgres://user:password@host` the text mentions.
 *
 * @param text A URL, an error message, anything.
 * @returns The text with each such password replaced by `•••`.
 */
export function maskSecrets(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]*:)[^@\s]*@/gi, "$1•••@");
}
