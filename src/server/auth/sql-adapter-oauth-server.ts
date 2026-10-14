/**
 * The SQL implementation of the OAuth-server, stored-provider and Web3 nonce groups
 * (`./adapter-oauth-server.ts`), shared by `sqliteAuthAdapter()` and `postgresAuthAdapter()`.
 * Statements are written with `?` placeholders (the Postgres runner numbers them); table names
 * come from the runner (module constants, schema-qualified on Postgres) and every value is a
 * bound parameter. Records live as JSON in a `data` column, beside the columns a query or a
 * compare-and-swap reads.
 *
 * @module
 */

import type {
  CustomProviderAdapter,
  CustomProviderRecord,
  OAuthAuthorizationExpect,
  OAuthAuthorizationPatch,
  OAuthAuthorizationRecord,
  OAuthClientRecord,
  OAuthConsentRecord,
  OAuthServerAdapter,
  Web3NonceAdapter,
} from "./adapter-oauth-server.ts";

/** What the groups need from a database. */
export interface OAuthServerSql {
  /** Run a statement (`?` placeholders) and return its rows. */
  rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** A table's (qualified) name. */
  table(name: string): string;
  /** Epoch seconds. */
  now(): number;
}

/** One SQLite table spec, in the shape `sqliteAuthAdapter`'s schema reconciler reads. */
export interface OAuthServerTableSpec {
  /** Table name. */
  name: string;
  /** Columns: `[name, declaration]`. */
  columns: Array<[name: string, decl: string]>;
  /** A table-level constraint. */
  constraints?: string;
  /** Indexes. */
  indexes?: Array<{ sql: string }>;
}

/** The SQLite tables (the Postgres migration `0005_auth_oauth_server` creates the same). */
export const OAUTH_SERVER_SQLITE_TABLES: OAuthServerTableSpec[] = [
  {
    name: "auth_oauth_clients",
    columns: [["id", "TEXT PRIMARY KEY"], ["created_at", "INTEGER"], ["data", "TEXT NOT NULL"]],
  },
  {
    name: "auth_oauth_authorizations",
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["client_id", "TEXT NOT NULL"],
      ["user_id", "TEXT"],
      ["status", "TEXT NOT NULL"],
      ["code_hash", "TEXT"],
      ["session_id", "TEXT"],
      ["expires_at", "INTEGER NOT NULL"],
      ["data", "TEXT NOT NULL"],
    ],
    indexes: [
      {
        sql: "CREATE UNIQUE INDEX IF NOT EXISTS auth_oauth_authorizations_code " +
          "ON auth_oauth_authorizations (code_hash) WHERE code_hash IS NOT NULL",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS auth_oauth_authorizations_client " +
          "ON auth_oauth_authorizations (client_id)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS auth_oauth_authorizations_expiry " +
          "ON auth_oauth_authorizations (expires_at)",
      },
    ],
  },
  {
    name: "auth_oauth_consents",
    columns: [
      ["user_id", "TEXT NOT NULL"],
      ["client_id", "TEXT NOT NULL"],
      ["scopes", "TEXT NOT NULL"],
      ["granted_at", "INTEGER NOT NULL"],
      ["revoked_at", "INTEGER"],
    ],
    constraints: "PRIMARY KEY (user_id, client_id)",
    indexes: [{
      sql:
        "CREATE INDEX IF NOT EXISTS auth_oauth_consents_client ON auth_oauth_consents (client_id)",
    }],
  },
  {
    name: "auth_oauth_sessions",
    columns: [
      ["session_id", "TEXT PRIMARY KEY"],
      ["user_id", "TEXT NOT NULL"],
      ["client_id", "TEXT NOT NULL"],
      ["created_at", "INTEGER"],
    ],
    indexes: [
      {
        sql: "CREATE INDEX IF NOT EXISTS auth_oauth_sessions_grant " +
          "ON auth_oauth_sessions (user_id, client_id)",
      },
      {
        sql: "CREATE INDEX IF NOT EXISTS auth_oauth_sessions_client " +
          "ON auth_oauth_sessions (client_id)",
      },
    ],
  },
  {
    name: "auth_custom_providers",
    columns: [
      ["identifier", "TEXT PRIMARY KEY"],
      ["created_at", "INTEGER"],
      ["data", "TEXT NOT NULL"],
    ],
  },
  {
    name: "auth_web3_nonces",
    columns: [["hash", "TEXT PRIMARY KEY"], ["expires_at", "INTEGER NOT NULL"]],
    indexes: [{
      sql: "CREATE INDEX IF NOT EXISTS auth_web3_nonces_expiry ON auth_web3_nonces (expires_at)",
    }],
  },
];

/** The tables keyed by `user_id` that a user's deletion clears. */
export const OAUTH_SERVER_USER_TABLES = [
  "auth_oauth_authorizations",
  "auth_oauth_consents",
  "auth_oauth_sessions",
];

/**
 * The Postgres migration (`p` qualifies a table).
 *
 * @param p The table prefix.
 * @returns The SQL.
 */
export function oauthServerPostgresSql(p: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${p}auth_oauth_clients (
  id TEXT PRIMARY KEY, created_at BIGINT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${p}auth_oauth_authorizations (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT, status TEXT NOT NULL,
  code_hash TEXT, session_id TEXT, expires_at BIGINT NOT NULL, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS auth_oauth_authorizations_code
  ON ${p}auth_oauth_authorizations (code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_oauth_authorizations_client
  ON ${p}auth_oauth_authorizations (client_id);
CREATE INDEX IF NOT EXISTS auth_oauth_authorizations_user
  ON ${p}auth_oauth_authorizations (user_id);
CREATE INDEX IF NOT EXISTS auth_oauth_authorizations_expiry
  ON ${p}auth_oauth_authorizations (expires_at);
CREATE TABLE IF NOT EXISTS ${p}auth_oauth_consents (
  user_id TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
  granted_at BIGINT NOT NULL, revoked_at BIGINT, PRIMARY KEY (user_id, client_id));
CREATE INDEX IF NOT EXISTS auth_oauth_consents_client ON ${p}auth_oauth_consents (client_id);
CREATE TABLE IF NOT EXISTS ${p}auth_oauth_sessions (
  session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, created_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_oauth_sessions_grant ON ${p}auth_oauth_sessions (user_id, client_id);
CREATE INDEX IF NOT EXISTS auth_oauth_sessions_client ON ${p}auth_oauth_sessions (client_id);
CREATE TABLE IF NOT EXISTS ${p}auth_custom_providers (
  identifier TEXT PRIMARY KEY, created_at BIGINT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${p}auth_web3_nonces (hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_web3_nonces_expiry ON ${p}auth_web3_nonces (expires_at);
`;
}

const num = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function parseData<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** The groups over a database. */
export type SqlOAuthServerGroups =
  & Required<OAuthServerAdapter>
  & Required<CustomProviderAdapter>
  & Required<Web3NonceAdapter>;

/**
 * Build the groups.
 *
 * @param db The database.
 * @returns The methods.
 */
export function sqlOAuthServerGroups(db: OAuthServerSql): SqlOAuthServerGroups {
  return {
    ...clientMethods(db),
    ...authorizationMethods(db),
    ...consentMethods(db),
    ...providerMethods(db),
    async claimWeb3Nonce(hash, expiresAt) {
      const t = db.table("auth_web3_nonces");
      await db.rows(`DELETE FROM ${t} WHERE expires_at <= ?`, [db.now() - 60]);
      // An unexpired claim keeps the row; an expired one is taken over — one statement.
      const won = await db.rows(
        `INSERT INTO ${t} (hash, expires_at) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE ` +
          "SET expires_at = excluded.expires_at WHERE auth_web3_nonces.expires_at <= ? " +
          "RETURNING hash",
        [hash, expiresAt, db.now()],
      );
      return won.length === 1;
    },
  };
}

function clientMethods(db: OAuthServerSql): Pick<
  SqlOAuthServerGroups,
  | "createOAuthClient"
  | "getOAuthClient"
  | "listOAuthClients"
  | "updateOAuthClient"
  | "deleteOAuthClient"
> {
  const t = () => db.table("auth_oauth_clients");
  return {
    async createOAuthClient(client) {
      await db.rows(`INSERT INTO ${t()} (id, created_at, data) VALUES (?, ?, ?)`, [
        client.id,
        client.createdAt,
        JSON.stringify(client),
      ]);
    },
    async getOAuthClient(id) {
      const [row] = await db.rows(`SELECT data FROM ${t()} WHERE id = ?`, [id]);
      return parseData<OAuthClientRecord>(row?.data);
    },
    async listOAuthClients({ page, perPage }) {
      const [count] = await db.rows(`SELECT COUNT(*) AS n FROM ${t()}`, []);
      const rows = await db.rows(
        `SELECT data FROM ${t()} ORDER BY created_at, id LIMIT ? OFFSET ?`,
        [perPage, (page - 1) * perPage],
      );
      const clients = rows.map((row) => parseData<OAuthClientRecord>(row.data))
        .filter((c): c is OAuthClientRecord => c !== undefined);
      return { clients, total: num(count?.n) ?? 0 };
    },
    async updateOAuthClient(client) {
      await db.rows(`UPDATE ${t()} SET data = ? WHERE id = ?`, [JSON.stringify(client), client.id]);
    },
    async deleteOAuthClient(id) {
      for (const table of ["auth_oauth_authorizations", "auth_oauth_consents"]) {
        await db.rows(`DELETE FROM ${db.table(table)} WHERE client_id = ?`, [id]);
      }
      await db.rows(`DELETE FROM ${db.table("auth_oauth_sessions")} WHERE client_id = ?`, [id]);
      await db.rows(`DELETE FROM ${t()} WHERE id = ?`, [id]);
    },
  };
}

/** The immutable part of an authorization, kept as JSON. */
type AuthorizationData = Pick<
  OAuthAuthorizationRecord,
  "redirectUri" | "scope" | "state" | "nonce" | "codeChallenge" | "createdAt"
>;

function authorizationFromRow(row: Record<string, unknown> | undefined) {
  if (!row) return undefined;
  const data = parseData<AuthorizationData>(row.data);
  if (!data) return undefined;
  const record: OAuthAuthorizationRecord = {
    ...data,
    id: String(row.id),
    clientId: String(row.client_id),
    status: String(row.status) as OAuthAuthorizationRecord["status"],
    expiresAt: num(row.expires_at) ?? 0,
  };
  const userId = text(row.user_id);
  const codeHash = text(row.code_hash);
  const sessionId = text(row.session_id);
  if (userId) record.userId = userId;
  if (codeHash) record.codeHash = codeHash;
  if (sessionId) record.sessionId = sessionId;
  return record;
}

const PATCH_COLUMNS: Record<keyof OAuthAuthorizationPatch, string> = {
  userId: "user_id",
  status: "status",
  codeHash: "code_hash",
  sessionId: "session_id",
  expiresAt: "expires_at",
};

function casClause(expect: OAuthAuthorizationExpect): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (expect.status !== undefined) {
    parts.push("status = ?");
    params.push(expect.status);
  }
  if (expect.userId === null) parts.push("user_id IS NULL");
  else if (expect.userId !== undefined) {
    parts.push("user_id = ?");
    params.push(expect.userId);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(""), params };
}

function authorizationMethods(db: OAuthServerSql): Pick<
  SqlOAuthServerGroups,
  | "createOAuthAuthorization"
  | "getOAuthAuthorization"
  | "getOAuthAuthorizationByCode"
  | "updateOAuthAuthorization"
> {
  const t = () => db.table("auth_oauth_authorizations");
  return {
    async createOAuthAuthorization(record) {
      // Requests an hour past their expiry are reclaimed on every write (an indexed delete).
      await db.rows(`DELETE FROM ${t()} WHERE expires_at <= ?`, [db.now() - 3600]);
      const data: AuthorizationData = {
        redirectUri: record.redirectUri,
        scope: record.scope,
        codeChallenge: record.codeChallenge,
        createdAt: record.createdAt,
        ...(record.state !== undefined ? { state: record.state } : {}),
        ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      };
      await db.rows(
        `INSERT INTO ${t()} (id, client_id, user_id, status, code_hash, session_id, expires_at, ` +
          "data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          record.id,
          record.clientId,
          record.userId ?? null,
          record.status,
          record.codeHash ?? null,
          record.sessionId ?? null,
          record.expiresAt,
          JSON.stringify(data),
        ],
      );
    },
    async getOAuthAuthorization(id) {
      return authorizationFromRow((await db.rows(`SELECT * FROM ${t()} WHERE id = ?`, [id]))[0]);
    },
    async getOAuthAuthorizationByCode(codeHash) {
      const rows = await db.rows(`SELECT * FROM ${t()} WHERE code_hash = ?`, [codeHash]);
      return authorizationFromRow(rows[0]);
    },
    async updateOAuthAuthorization(id, patch, expect) {
      const sets = (Object.keys(PATCH_COLUMNS) as Array<keyof OAuthAuthorizationPatch>)
        .filter((key) => patch[key] !== undefined);
      if (!sets.length) return false;
      const cas = casClause(expect);
      const updated = await db.rows(
        `UPDATE ${t()} SET ${sets.map((key) => `${PATCH_COLUMNS[key]} = ?`).join(", ")} ` +
          `WHERE id = ?${cas.sql} RETURNING id`,
        [...sets.map((key) => patch[key]), id, ...cas.params],
      );
      return updated.length === 1;
    },
  };
}

function consentFromRow(row: Record<string, unknown>): OAuthConsentRecord {
  const consent: OAuthConsentRecord = {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    scopes: parseData<string[]>(row.scopes) ?? [],
    grantedAt: num(row.granted_at) ?? 0,
  };
  const revokedAt = num(row.revoked_at);
  if (revokedAt !== undefined) consent.revokedAt = revokedAt;
  return consent;
}

function consentMethods(db: OAuthServerSql): Pick<
  SqlOAuthServerGroups,
  | "putOAuthConsent"
  | "getOAuthConsent"
  | "listOAuthConsents"
  | "linkOAuthSession"
  | "listOAuthSessions"
  | "listOAuthClientSessions"
> {
  const consents = () => db.table("auth_oauth_consents");
  const links = () => db.table("auth_oauth_sessions");
  return {
    async putOAuthConsent(consent) {
      await db.rows(
        `INSERT INTO ${consents()} (user_id, client_id, scopes, granted_at, revoked_at) ` +
          "VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, client_id) DO UPDATE SET " +
          "scopes = excluded.scopes, granted_at = excluded.granted_at, " +
          "revoked_at = excluded.revoked_at",
        [
          consent.userId,
          consent.clientId,
          JSON.stringify(consent.scopes),
          consent.grantedAt,
          consent.revokedAt ?? null,
        ],
      );
    },
    async getOAuthConsent(userId, clientId) {
      const [row] = await db.rows(
        `SELECT * FROM ${consents()} WHERE user_id = ? AND client_id = ?`,
        [userId, clientId],
      );
      return row ? consentFromRow(row) : undefined;
    },
    async listOAuthConsents(userId) {
      const rows = await db.rows(
        `SELECT * FROM ${consents()} WHERE user_id = ? ORDER BY granted_at, client_id`,
        [userId],
      );
      return rows.map(consentFromRow);
    },
    async linkOAuthSession(link) {
      await db.rows(
        `INSERT INTO ${links()} (session_id, user_id, client_id, created_at) VALUES (?, ?, ?, ?) ` +
          "ON CONFLICT (session_id) DO NOTHING",
        [link.sessionId, link.userId, link.clientId, link.createdAt],
      );
    },
    async listOAuthSessions(userId, clientId) {
      const rows = await db.rows(
        `SELECT session_id FROM ${links()} WHERE user_id = ? AND client_id = ?`,
        [userId, clientId],
      );
      return rows.map((row) => String(row.session_id));
    },
    async listOAuthClientSessions(clientId) {
      const rows = await db.rows(`SELECT session_id FROM ${links()} WHERE client_id = ?`, [
        clientId,
      ]);
      return rows.map((row) => String(row.session_id));
    },
  };
}

function providerMethods(db: OAuthServerSql): Required<CustomProviderAdapter> {
  const t = () => db.table("auth_custom_providers");
  return {
    async createCustomProvider(record) {
      const inserted = await db.rows(
        `INSERT INTO ${t()} (identifier, created_at, data) VALUES (?, ?, ?) ` +
          "ON CONFLICT (identifier) DO NOTHING RETURNING identifier",
        [record.identifier, record.createdAt, JSON.stringify(record)],
      );
      return inserted.length === 1;
    },
    async getCustomProvider(identifier) {
      const [row] = await db.rows(`SELECT data FROM ${t()} WHERE identifier = ?`, [identifier]);
      return parseData<CustomProviderRecord>(row?.data);
    },
    async listCustomProviders() {
      const rows = await db.rows(`SELECT data FROM ${t()} ORDER BY created_at, identifier`, []);
      return rows.map((row) => parseData<CustomProviderRecord>(row.data))
        .filter((p): p is CustomProviderRecord => p !== undefined);
    },
    async updateCustomProvider(record) {
      await db.rows(`UPDATE ${t()} SET data = ? WHERE identifier = ?`, [
        JSON.stringify(record),
        record.identifier,
      ]);
    },
    async deleteCustomProvider(identifier) {
      await db.rows(`DELETE FROM ${t()} WHERE identifier = ?`, [identifier]);
    },
  };
}

/**
 * Number a statement's `?` placeholders `$1, $2, …` for Postgres (the statements here hold no
 * `?` anywhere else).
 *
 * @param sql The statement.
 * @returns The numbered statement.
 */
export function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}
