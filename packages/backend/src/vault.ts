// Vault: encrypted secrets in the app's Postgres, in Supabase Vault's table shape
// (`vault.secrets`: id, name, description, secret, key_id, nonce, created_at, updated_at).
//
// The secret column holds AES-256-GCM ciphertext (base64, tag included), encrypted and decrypted
// in the app — never in the database: the key comes from the environment (`DENEXT_VAULT_KEY`, or
// `backend({ vault: { key } })`) and never reaches Postgres, its logs or a backup. The row's id is
// the additional authenticated data, so a ciphertext copied onto another row fails to decrypt;
// `nonce` is the 96-bit IV, fresh for every write; `key_id` names the key that encrypted it (a
// fingerprint), so a key can be rotated: list the new key first and the old after it — reads use
// whichever matches, writes the first, and `vault.rotate()` re-encrypts every row under it.
//
// Supabase decrypts in SQL (`vault.decrypted_secrets`, with pgsodium's server key). Here that would
// put the key inside the database, so the plaintext is only ever read by server code: `vault.get`,
// `vault.decryptedSecrets()`. The table has row-level security on and no grants to `anon` or
// `authenticated`: only the app's own database user (the service role) reaches it.

import { migratePostgres, type Migration, type SqlClient } from "@denext/denext/server";
import { db } from "./postgres.ts";
import { VAULT_KEYS_SETTING, vaultKeysJson, vaultSqlMigrations } from "./vault-sql.ts";

/** `backend({ vault })`. */
export interface VaultOptions {
  /**
   * The encryption key (default `DENEXT_VAULT_KEY`): at least 32 characters (a random 32-byte
   * value, base64-encoded, is ideal). A list rotates keys: the first encrypts, every one decrypts.
   */
  key?: string | string[];
  /** Apply the `backend_vault_0001` migration on first use (default `true`). */
  migrate?: boolean;
  /**
   * Supabase's SQL surface too: `vault.create_secret()`, `vault.update_secret()` and the
   * `vault.decrypted_secrets` view, for SQL and migrations written for Supabase. They read the key
   * from a transaction-local setting the app sets — only in `vault.withKey()` transactions and
   * `denext db push / reset / diff` — so outside those they raise an error. Needs `pgcrypto`.
   * See the docs for what this mode trusts the database session with.
   */
  sql?: boolean;
}

/** One secret's metadata (no plaintext). */
export interface VaultSecret {
  /** The secret's id. */
  id: string;
  /** Its unique name, if it has one. */
  name: string | null;
  /** Its description. */
  description: string;
  /** The id of the key that encrypted it. */
  keyId: string | null;
  /** When it was created. */
  createdAt: Date;
  /** When it last changed. */
  updatedAt: Date;
}

/** A secret with its plaintext — a row of Supabase's `vault.decrypted_secrets`. */
export interface DecryptedSecret extends VaultSecret {
  /** The plaintext, or `null` when no configured key decrypts it. */
  decryptedSecret: string | null;
}

/** Thrown when the vault is used without a key, or a secret fails authentication. */
export class VaultError extends Error {
  /** `no_key`, `not_found`, `bad_ciphertext` or `not_configured`. */
  readonly code: string;
  /**
   * Build the error.
   *
   * @param code The error code.
   * @param message The message.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/** The environment variable the key is read from. */
const VAULT_KEY_ENV = "DENEXT_VAULT_KEY";

const VAULT_TABLE = "backend_migrations";

/** The vault's table, in Supabase's shape; RLS on, nothing granted to `anon` / `authenticated`. */
export function vaultMigrations(): Migration[] {
  return [{
    name: "backend_vault_0001",
    sql: `CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE,
  description text NOT NULL DEFAULT '',
  secret text NOT NULL,
  key_id uuid,
  nonce bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vault.secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
REVOKE ALL ON vault.secrets FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON vault.secrets FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON vault.secrets FROM authenticated';
  END IF;
END $do$;`,
  }];
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** A derived key and its id. */
export interface VaultKey {
  /** The key's public id (`key_id`). */
  id: string;
  /** The AES-256-GCM key. */
  key: CryptoKey;
  /** Its raw bytes, for the SQL mode only. */
  raw: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 16 bytes in a UUID's 8-4-4-4-12 layout. */
function asUuid(bytes: Uint8Array): string {
  let out = "";
  bytes.subarray(0, 16).forEach((b, i) => {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += b.toString(16).padStart(2, "0");
  });
  return out;
}

/**
 * Derive the AES-256-GCM key (HKDF-SHA-256) and its public id from a configured secret.
 *
 * @param secret The configured key (at least 32 characters).
 * @returns The key and its id.
 * @throws {VaultError} For a key shorter than 32 characters.
 */
export async function deriveVaultKey(secret: string): Promise<VaultKey> {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new VaultError("no_key", `the vault key must be at least 32 characters`);
  }
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("denext-vault"),
    info: encoder.encode(info),
  });
  // The same 256 bits `deriveKey` would produce; kept raw for the SQL mode (`vault: { sql }`),
  // which hands them to the database for one transaction at a time.
  const raw = new Uint8Array(
    await crypto.subtle.deriveBits(params("aes-256-gcm v1"), material, 256),
  );
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  const id = new Uint8Array(await crypto.subtle.deriveBits(params("key id v1"), material, 128));
  return { id: asUuid(id), key, raw };
}

/**
 * Encrypt `plaintext` for the row `id`.
 *
 * @param key The key.
 * @param id The row id (the additional authenticated data).
 * @param plaintext The secret.
 * @returns The base64 ciphertext and the nonce.
 */
export async function sealSecret(
  key: VaultKey,
  id: string,
  plaintext: string,
): Promise<{ secret: string; nonce: Uint8Array }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aadOf(id) },
    key.key,
    encoder.encode(plaintext),
  );
  return { secret: toBase64(new Uint8Array(sealed)), nonce };
}

/**
 * Decrypt a row's secret with whichever key encrypted it.
 *
 * @param keys The configured keys.
 * @param row The row's id, ciphertext, nonce and key id.
 * @returns The plaintext, or `null` when no configured key matches or authentication fails.
 */
export async function openSecret(
  keys: readonly VaultKey[],
  row: { id: string; secret: string; nonce: Uint8Array<ArrayBuffer> | null; keyId: string | null },
): Promise<string | null> {
  if (!row.nonce) return null;
  const candidates = row.keyId ? keys.filter((k) => k.id === row.keyId) : keys;
  for (const key of candidates) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: row.nonce, additionalData: aadOf(row.id) },
        key.key,
        fromBase64(row.secret),
      );
      return decoder.decode(plain);
    } catch {
      // Not this key, or tampered: try the next; none → null.
    }
  }
  return null;
}

/**
 * A row id as the additional authenticated data: a UUID in Postgres's canonical text form (what
 * `id::text` prints, and what the SQL side binds), so `C50F5012-…` and `c50f5012-…` seal alike.
 */
function aadOf(id: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(UUID.test(id) ? id.toLowerCase() : id);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
}

// ── The installed vault ──────────────────────────────────────────────────────

interface VaultSlot {
  keys: () => Promise<VaultKey[]>;
  migrate: boolean;
  sql: boolean;
}

const SLOT = Symbol.for("denext.backend.vault");
type Holder = { [SLOT]?: VaultSlot };

function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install the vault (plugin setup), or clear it with `undefined` (tests). The keys are derived
 * on first use, so a missing key fails where the vault is used, not at startup.
 *
 * @param options The vault options, or `undefined` to clear.
 * @param env Reads an environment variable.
 */
export function installVault(
  options: VaultOptions | undefined,
  env: (name: string) => string | undefined = readEnv,
): void {
  if (!options) {
    (globalThis as Holder)[SLOT] = undefined;
    return;
  }
  let derived: Promise<VaultKey[]> | undefined;
  const keys = () => {
    if (!derived) {
      const configured = options.key ?? env(VAULT_KEY_ENV);
      const list = configured === undefined
        ? []
        : Array.isArray(configured)
        ? configured
        : [configured];
      derived = list.length === 0
        ? Promise.reject(
          new VaultError("no_key", `the vault needs a key: set ${VAULT_KEY_ENV} (32+ characters)`),
        )
        : Promise.all(list.map(deriveVaultKey));
      derived.catch(() => (derived = undefined));
    }
    return derived;
  };
  (globalThis as Holder)[SLOT] = {
    keys,
    migrate: options.migrate !== false,
    sql: options.sql === true,
  };
}

function slot(): VaultSlot {
  const found = (globalThis as Holder)[SLOT];
  if (!found) {
    throw new VaultError(
      "not_configured",
      "vault: not configured — add backend({ postgres: {}, vault: {} }) to denext.config.ts",
    );
  }
  return found;
}

const migrated = new WeakMap<SqlClient, Promise<void>>();

/** The service client, with the vault's migration applied once. */
async function client(): Promise<SqlClient> {
  const sql = db.service();
  if (slot().migrate) {
    let pending = migrated.get(sql);
    if (!pending) {
      const migrations = [...vaultMigrations(), ...(slot().sql ? vaultSqlMigrations() : [])];
      pending = migratePostgres(sql, { migrations, table: VAULT_TABLE }).then(() => undefined);
      pending.catch(() => migrated.delete(sql));
      migrated.set(sql, pending);
    }
    await pending;
  }
  return sql;
}

interface SecretRow {
  id: string;
  name: string | null;
  description: string;
  secret: string;
  key_id: string | null;
  nonce: Uint8Array | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function metadata(row: SecretRow): VaultSecret {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keyId: row.key_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function bytesOf(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  // A driver that returns bytea as `\x…` hex text.
  if (typeof value === "string" && value.startsWith("\\x")) {
    const h = value.slice(2);
    return Uint8Array.from(
      { length: h.length / 2 },
      (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16),
    );
  }
  return null;
}

async function decrypted(row: SecretRow, keys: VaultKey[]): Promise<DecryptedSecret> {
  return {
    ...metadata(row),
    decryptedSecret: await openSecret(keys, {
      id: row.id,
      secret: row.secret,
      nonce: bytesOf(row.nonce),
      keyId: row.key_id,
    }),
  };
}

const COLUMNS = "id::text AS id, name, description, secret, key_id::text AS key_id, nonce, " +
  "created_at, updated_at";

/** The server's vault API (`vault` from `@denext/backend/server`). */
export interface Vault {
  /**
   * Store a secret, encrypted — Supabase's `vault.create_secret(secret, name, description)`.
   *
   * @returns The new secret's id.
   */
  createSecret(secret: string, name?: string, description?: string): Promise<string>;
  /** Change a secret's value, name or description — Supabase's `vault.update_secret`. */
  updateSecret(
    id: string,
    changes: { secret?: string; name?: string | null; description?: string },
  ): Promise<void>;
  /** The plaintext of the secret named `name`, or `null` when there is none. */
  get(name: string): Promise<string | null>;
  /** Every secret with its plaintext — the rows of Supabase's `vault.decrypted_secrets`. */
  decryptedSecrets(): Promise<DecryptedSecret[]>;
  /** Every secret's metadata, without the plaintext. */
  list(): Promise<VaultSecret[]>;
  /** Delete the secret with this id or name. Resolves `true` when one was deleted. */
  delete(idOrName: string): Promise<boolean>;
  /** Re-encrypt every secret not under the first key with it. Resolves the count. */
  rotate(): Promise<number>;
  /**
   * Run `fn` in a transaction (as the app's own database user) where Supabase's SQL vault works:
   * the keys are set transaction-locally, so `vault.create_secret()` and
   * `select … from vault.decrypted_secrets` run inside it, and nothing outlives it. Needs
   * `vault: { sql: true }`.
   */
  withKey<T>(fn: (sql: SqlClient) => T | Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Seal `plaintext` into the row `id` names. `id` must be the row's id as the database prints it
 * (`id::text`): the ciphertext is bound to it, so a write under any other spelling could never be
 * read back. The update is checked: it must land on exactly that row.
 */
async function writeSecret(
  sql: SqlClient,
  key: VaultKey,
  id: string,
  plaintext: string,
): Promise<void> {
  const { secret, nonce } = await sealSecret(key, id, plaintext);
  const written = await sql.unsafe<{ id: string }>(
    "UPDATE vault.secrets SET secret = $2, nonce = $3, key_id = $4::uuid, updated_at = now() " +
      "WHERE id = $1::uuid RETURNING id::text AS id",
    [id, secret, nonce, key.id],
  );
  if (written.length !== 1 || written[0].id !== id.toLowerCase()) {
    throw new VaultError("not_found", "vault: the secret changed while it was being written");
  }
}

/**
 * The vault: encrypted secrets in Postgres, decrypted only in server code. Server-only: it uses
 * the app's own database user (no row-level security), and every call needs the vault key.
 *
 * ```ts
 * import { vault } from "@denext/backend/server";
 * const id = await vault.createSecret("sk_live_…", "stripe_key", "Stripe secret key");
 * const stripeKey = await vault.get("stripe_key");
 * ```
 */
export const vault: Vault = {
  async createSecret(secret, name, description = "") {
    if (typeof secret !== "string") {
      throw new TypeError("vault.createSecret: secret must be a string");
    }
    const [key] = await slot().keys();
    const sql = await client();
    const id = crypto.randomUUID();
    const sealed = await sealSecret(key, id, secret);
    await sql.unsafe(
      "INSERT INTO vault.secrets (id, name, description, secret, nonce, key_id) " +
        "VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)",
      [id, name ?? null, description, sealed.secret, sealed.nonce, key.id],
    );
    return id;
  },
  async updateSecret(id, changes) {
    if (!UUID.test(id)) throw new VaultError("not_found", "vault.updateSecret: no such secret");
    const [key] = await slot().keys();
    const sql = await client();
    const found = await sql.unsafe<{ id: string }>(
      "UPDATE vault.secrets SET name = CASE WHEN $2 THEN $3 ELSE name END, " +
        "description = COALESCE($4, description), updated_at = now() WHERE id = $1::uuid " +
        "RETURNING id::text AS id",
      [id, "name" in changes, changes.name ?? null, changes.description ?? null],
    );
    if (!found.length) throw new VaultError("not_found", "vault.updateSecret: no such secret");
    // Sealed under the id as the database prints it (`id::text`, lowercase), never the caller's
    // spelling: `$1::uuid` matches an uppercase id too, and readers bind the canonical one.
    if (changes.secret !== undefined) await writeSecret(sql, key, found[0].id, changes.secret);
  },
  async get(name) {
    const keys = await slot().keys();
    const sql = await client();
    const [row] = await sql.unsafe<SecretRow>(
      `SELECT ${COLUMNS} FROM vault.secrets WHERE name = $1`,
      [name],
    );
    if (!row) return null;
    const out = await decrypted(row, keys);
    if (out.decryptedSecret === null) {
      throw new VaultError(
        "bad_ciphertext",
        `vault: the secret ${JSON.stringify(name)} does not decrypt with the configured key(s)`,
      );
    }
    return out.decryptedSecret;
  },
  async decryptedSecrets() {
    const keys = await slot().keys();
    const sql = await client();
    const rows = await sql.unsafe<SecretRow>(
      `SELECT ${COLUMNS} FROM vault.secrets ORDER BY created_at, id`,
    );
    return await Promise.all([...rows].map((row) => decrypted(row, keys)));
  },
  async list() {
    const sql = await client();
    const rows = await sql.unsafe<SecretRow>(
      `SELECT ${COLUMNS} FROM vault.secrets ORDER BY created_at, id`,
    );
    return [...rows].map(metadata);
  },
  async delete(idOrName) {
    const sql = await client();
    const rows = UUID.test(idOrName)
      ? await sql.unsafe("DELETE FROM vault.secrets WHERE id = $1::uuid RETURNING 1", [idOrName])
      : await sql.unsafe("DELETE FROM vault.secrets WHERE name = $1 RETURNING 1", [idOrName]);
    return rows.length > 0;
  },
  async withKey(fn) {
    if (!slot().sql) {
      throw new VaultError(
        "not_configured",
        "vault.withKey() needs backend({ vault: { sql: true } })",
      );
    }
    const keys = await slot().keys();
    const sql = await client();
    return await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${VAULT_KEYS_SETTING}', $1, true)`, [
        vaultKeysJson(keys),
      ]);
      return await fn(tx);
    });
  },
  async rotate() {
    const keys = await slot().keys();
    const sql = await client();
    const rows = await sql.unsafe<SecretRow>(
      `SELECT ${COLUMNS} FROM vault.secrets WHERE key_id IS DISTINCT FROM $1::uuid`,
      [keys[0].id],
    );
    let count = 0;
    for (const row of rows) {
      const plain = (await decrypted(row, keys)).decryptedSecret;
      if (plain === null) continue;
      await writeSecret(sql, keys[0], row.id, plain);
      count++;
    }
    return count;
  },
};

/**
 * A client whose every transaction (`begin`) first sets the vault keys transaction-locally — what
 * `denext db push` runs migrations with in SQL mode, so a migration that calls
 * `vault.create_secret()` works. Statements outside a transaction get no key.
 *
 * @param sql The connecting role's client.
 * @returns The client, or `sql` unchanged when the SQL vault is off or has no key.
 */
export async function vaultKeyedClient(sql: SqlClient): Promise<SqlClient> {
  const found = (globalThis as Holder)[SLOT];
  if (!found?.sql) return sql;
  let keys: VaultKey[];
  try {
    keys = await found.keys();
  } catch {
    return sql; // No key: SQL that needs it fails with the vault's own error.
  }
  const json = vaultKeysJson(keys);
  const begin = (fn: (tx: SqlClient) => unknown) =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('${VAULT_KEYS_SETTING}', $1, true)`, [json]);
      return await fn(tx);
    });
  return new Proxy(sql, {
    get(target, key) {
      if (key === "begin") return begin;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
