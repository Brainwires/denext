// The Postgres tables behind denext auth — the adapter, the session store and the rate-limit
// store share them — and the lazily migrated handle all three drive.
//
// The schema is a list of migrations applied by the same runner an app's own migrations use
// (`migratePostgres`), recorded in `auth_migrations`: a later denext adds a migration, it never
// edits one. Every table is `auth_`-prefixed so it can share a database (and a schema) with the
// app's own.

import {
  type PostgresConnectionOptions,
  resolveConnection,
  schemaPrefix,
  type SqlClient,
} from "../postgres.ts";
import { migratePostgres, type Migration } from "../postgres-migrate.ts";
import { inRootContext } from "../root-context.ts";
import { oauthServerPostgresSql } from "./sql-adapter-oauth-server.ts";

/** The tracking table of the auth migrations. */
const AUTH_MIGRATIONS_TABLE = "auth_migrations";

/**
 * The auth schema, as migrations. `p` qualifies a table (`"app".` or `""`). Types are the
 * portable ones: `TEXT`, `BIGINT` epoch seconds, `BOOLEAN`, and JSON arrays in `TEXT` (so a
 * compare-and-swap on one is a plain string comparison).
 *
 * @param p The table prefix.
 * @returns The migrations, in order.
 */
function authMigrations(p: string): Migration[] {
  return [{
    name: "0001_auth_tables",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}auth_users (
  id TEXT PRIMARY KEY, email TEXT, email_lc TEXT, email_verified BIGINT, name TEXT, image TEXT,
  roles TEXT, created_at BIGINT);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email ON ${p}auth_users (email_lc)
  WHERE email_lc IS NOT NULL;
CREATE TABLE IF NOT EXISTS ${p}auth_accounts (
  provider TEXT NOT NULL, provider_account_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT,
  access_token TEXT, refresh_token TEXT, expires_at BIGINT, token_type TEXT, scope TEXT,
  id_token TEXT, PRIMARY KEY (provider, provider_account_id));
CREATE INDEX IF NOT EXISTS auth_accounts_user ON ${p}auth_accounts (user_id);
CREATE TABLE IF NOT EXISTS ${p}auth_verification_tokens (
  identifier TEXT NOT NULL, purpose TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires BIGINT NOT NULL, data TEXT, PRIMARY KEY (identifier, purpose));
CREATE INDEX IF NOT EXISTS auth_verification_expiry ON ${p}auth_verification_tokens (expires);
CREATE TABLE IF NOT EXISTS ${p}auth_credentials (
  user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${p}auth_api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, token_hash TEXT NOT NULL, scopes TEXT,
  expires_at BIGINT, last_used_at BIGINT, revoked_at BIGINT, created_at BIGINT);
CREATE UNIQUE INDEX IF NOT EXISTS auth_api_tokens_hash ON ${p}auth_api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS auth_api_tokens_user ON ${p}auth_api_tokens (user_id);
CREATE TABLE IF NOT EXISTS ${p}auth_mfa (
  user_id TEXT PRIMARY KEY, secret TEXT NOT NULL, confirmed_at BIGINT, backup_code_hashes TEXT,
  last_step BIGINT);
CREATE TABLE IF NOT EXISTS ${p}auth_native_grants (
  kind TEXT NOT NULL, hash TEXT NOT NULL, expires_at BIGINT NOT NULL, data TEXT,
  PRIMARY KEY (kind, hash));
CREATE INDEX IF NOT EXISTS auth_native_grants_expiry ON ${p}auth_native_grants (expires_at);
CREATE TABLE IF NOT EXISTS ${p}auth_native_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation BIGINT NOT NULL, salt TEXT NOT NULL,
  session TEXT NOT NULL, created_at BIGINT, expires_at BIGINT, revoked_at BIGINT,
  rotated_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_native_sessions_user ON ${p}auth_native_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_native_sessions_expiry ON ${p}auth_native_sessions (expires_at);
CREATE INDEX IF NOT EXISTS auth_native_sessions_revoked ON ${p}auth_native_sessions (revoked_at);
CREATE TABLE IF NOT EXISTS ${p}auth_passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key TEXT NOT NULL, alg BIGINT NOT NULL,
  sign_count BIGINT NOT NULL, backup_eligible BOOLEAN, backed_up BOOLEAN, transports TEXT,
  aaguid TEXT, name TEXT, created_at BIGINT, last_used_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_passkeys_user ON ${p}auth_passkeys (user_id);
CREATE TABLE IF NOT EXISTS ${p}auth_passkey_challenges (
  hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS auth_passkey_challenges_expiry
  ON ${p}auth_passkey_challenges (expires_at);
CREATE TABLE IF NOT EXISTS ${p}auth_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON ${p}auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON ${p}auth_sessions (expires_at);
CREATE TABLE IF NOT EXISTS ${p}auth_rate_limits (
  key TEXT PRIMARY KEY, hits BIGINT NOT NULL, reset_at DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS auth_rate_limits_reset ON ${p}auth_rate_limits (reset_at);
`,
  }, {
    // Supabase-shaped users and identities: phone, metadata, anonymous users, timestamps.
    name: "0002_auth_user_profile",
    sql: `
ALTER TABLE ${p}auth_users ADD COLUMN phone TEXT;
ALTER TABLE ${p}auth_users ADD COLUMN phone_verified BIGINT;
ALTER TABLE ${p}auth_users ADD COLUMN user_metadata TEXT;
ALTER TABLE ${p}auth_users ADD COLUMN app_metadata TEXT;
ALTER TABLE ${p}auth_users ADD COLUMN is_anonymous BOOLEAN;
ALTER TABLE ${p}auth_users ADD COLUMN updated_at BIGINT;
ALTER TABLE ${p}auth_users ADD COLUMN last_sign_in_at BIGINT;
ALTER TABLE ${p}auth_users ADD COLUMN banned_until BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_phone ON ${p}auth_users (phone)
  WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_users_created ON ${p}auth_users (created_at, id);
ALTER TABLE ${p}auth_accounts ADD COLUMN identity_id TEXT;
ALTER TABLE ${p}auth_accounts ADD COLUMN identity_data TEXT;
ALTER TABLE ${p}auth_accounts ADD COLUMN email TEXT;
ALTER TABLE ${p}auth_accounts ADD COLUMN created_at BIGINT;
ALTER TABLE ${p}auth_accounts ADD COLUMN updated_at BIGINT;
ALTER TABLE ${p}auth_accounts ADD COLUMN last_sign_in_at BIGINT;
CREATE TABLE IF NOT EXISTS ${p}auth_mfa_factors (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, factor_type TEXT NOT NULL, status TEXT NOT NULL,
  friendly_name TEXT, secret TEXT, phone TEXT, created_at BIGINT, updated_at BIGINT,
  last_step BIGINT, last_challenged_at BIGINT);
CREATE INDEX IF NOT EXISTS auth_mfa_factors_user ON ${p}auth_mfa_factors (user_id);
`,
  }, {
    // SAML SSO of /auth/v1: stored providers, their domains, the SSO origin of sessions (for
    // IdP-initiated Single Logout) and the SAML message ids every replica's replay check shares.
    name: "0004_auth_sso_providers",
    sql: `
CREATE TABLE IF NOT EXISTS ${p}auth_sso_providers (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, metadata_xml TEXT NOT NULL, metadata_url TEXT,
  attribute_mapping TEXT, name_id_format TEXT, created_at BIGINT, updated_at BIGINT);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sso_providers_entity ON ${p}auth_sso_providers (entity_id);
CREATE TABLE IF NOT EXISTS ${p}auth_sso_domains (
  domain TEXT PRIMARY KEY, provider_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_sso_domains_provider ON ${p}auth_sso_domains (provider_id);
CREATE TABLE IF NOT EXISTS ${p}auth_sso_sessions (
  session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name_id TEXT NOT NULL,
  session_index TEXT, user_id TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_sso_sessions_name ON ${p}auth_sso_sessions (provider_id, name_id);
CREATE INDEX IF NOT EXISTS auth_sso_sessions_user ON ${p}auth_sso_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sso_sessions_expiry ON ${p}auth_sso_sessions (expires_at);
CREATE TABLE IF NOT EXISTS ${p}auth_saml_message_ids (
  id TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS auth_saml_message_ids_expiry ON ${p}auth_saml_message_ids (expires_at);
`,
  }, {
    // The /auth/v1 OAuth 2.1 server (clients, authorizations, consents, the session families a
    // client holds), stored OAuth / OIDC providers and Web3 sign-in nonces.
    name: "0005_auth_oauth_server",
    sql: oauthServerPostgresSql(p),
  }];
}

/** Options every Postgres auth store takes: a client or URL, a schema, and `migrate`. */
export interface PostgresAuthStoreOptions extends PostgresConnectionOptions {
  /**
   * Apply the auth migrations on first use (default `true`). `false` when they are applied
   * out of band (a deploy step running with a role that may create tables).
   */
  migrate?: boolean;
}

/** The handle a Postgres auth store drives: a migrated client, the table names, and close. */
export interface AuthDb {
  /** The client, once the auth migrations have been applied (on the first call). */
  ready(): Promise<SqlClient>;
  /** A table's qualified name. */
  table(name: string): string;
  /** Close the client when denext opened it; every later `ready()` refuses. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build the shared handle.
 *
 * @param options The store's options.
 * @param feature The store, named in errors.
 * @returns The handle.
 */
export function authDb(options: PostgresAuthStoreOptions, feature: string): AuthDb {
  const prefix = schemaPrefix(options.schema, feature);
  const { sql, owned } = resolveConnection(options, feature);
  let migrated: Promise<void> | undefined;
  let closed = false;
  const migrate = (): Promise<void> => {
    if (options.migrate === false) return Promise.resolve();
    return migratePostgres(sql, {
      migrations: authMigrations(prefix),
      table: AUTH_MIGRATIONS_TABLE,
      schema: options.schema,
    }).then(() => undefined);
  };
  return {
    async ready() {
      // A closed store must not reach the database again: the server is draining.
      if (closed) {
        throw new Error(
          `${feature}: this store has been closed (the server drained, or close() was called) — ` +
            "build a new one instead of reusing it.",
        );
      }
      // One migration run per handle, shared by concurrent first calls; a failure is not
      // memoized, so the next call retries instead of disabling sign-in for good. It runs in
      // the root context: the request that happens to trigger it must not leak into the pool
      // connections it opens.
      migrated ??= inRootContext(migrate).catch((error) => {
        migrated = undefined;
        throw error;
      });
      await migrated;
      return sql;
    },
    table: (name) => `${prefix}${name}`,
    async close() {
      if (closed) return;
      closed = true;
      if (owned) await sql.close();
    },
  };
}
