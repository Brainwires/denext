// `@denext/backend` Vault, on a scripted Postgres: AES-256-GCM in the app with HKDF-derived keys,
// the row id as additional authenticated data, key ids and rotation, and the errors (no key, a
// short key, a ciphertext that does not open, not configured). The SQL runs against a real
// Postgres in tests/backend-platform-integration.test.ts.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  deriveVaultKey,
  installVault,
  openSecret,
  sealSecret,
  vault,
  VaultError,
  vaultMigrations,
} from "../packages/backend/src/vault.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import { scriptedSql } from "./helpers/scripted-sql.ts";

const KEY = "k".repeat(32);
const OTHER = "o".repeat(40);

interface Row {
  id: string;
  name: string | null;
  description: string;
  secret: string;
  key_id: string | null;
  nonce: Uint8Array | null;
  created_at: Date;
  updated_at: Date;
}

/** A scripted `vault.secrets`, enough for the statements vault.ts sends. */
function vaultTable() {
  const rows = new Map<string, Row>();
  const all = () => [...rows.values()].map((r) => ({ ...r }));
  const insert = (p: unknown[]) => {
    rows.set(p[0] as string, {
      id: p[0] as string,
      name: p[1] as string | null,
      description: p[2] as string,
      secret: p[3] as string,
      nonce: p[4] as Uint8Array,
      key_id: p[5] as string,
      created_at: new Date(Date.now() + rows.size),
      updated_at: new Date(),
    });
    return [];
  };
  // `$1::uuid` matches any spelling of the id, as Postgres does; `id::text` prints it lowercase.
  const byId = (id: unknown) => rows.get(String(id).toLowerCase());
  const rename = (p: unknown[]) => {
    const row = byId(p[0]);
    if (!row) return [];
    if (p[1]) row.name = p[2] as string | null;
    if (p[3] !== null) row.description = p[3] as string;
    return [{ id: row.id }];
  };
  const reseal = (p: unknown[]) => {
    const row = byId(p[0]);
    if (!row) return [];
    Object.assign(row, { secret: p[1], nonce: p[2], key_id: p[3] });
    return [{ id: row.id }];
  };
  const byName = (name: unknown) => [...rows.values()].find((r) => r.name === name);
  const handlers: Array<[RegExp, (p: unknown[]) => unknown[]]> = [
    [/^INSERT INTO vault\.secrets/, insert],
    [/^UPDATE vault\.secrets SET name/, rename],
    [/^UPDATE vault\.secrets SET secret/, reseal],
    [/^SELECT .* WHERE name = \$1/s, (p) => all().filter((r) => r.name === p[0])],
    [/IS DISTINCT FROM/, (p) => all().filter((r) => r.key_id !== p[0])],
    [/^SELECT/, all],
    [/^DELETE FROM vault\.secrets WHERE id/, (p) => (rows.delete(p[0] as string) ? [{}] : [])],
    [
      /^DELETE FROM vault\.secrets WHERE name/,
      (p) => (rows.delete(byName(p[0])?.id ?? "") ? [{}] : []),
    ],
  ];
  const sql = scriptedSql((text, p) => {
    const found = handlers.find(([pattern]) => pattern.test(text));
    if (!found) throw new Error(`unexpected: ${text}`);
    return found[1](p);
  });
  return { rows, sql };
}

function setUp(key: string | string[] | undefined, env: Record<string, string> = {}) {
  const table = vaultTable();
  installPostgres({ sql: table.sql, rls: { migrate: false } });
  installVault({ key, migrate: false }, (name) => env[name]);
  return table;
}

function tearDown() {
  installVault(undefined);
  installPostgres(undefined);
}

Deno.test("vault keys: HKDF-derived, a stable id per key, at least 32 characters", async () => {
  const a = await deriveVaultKey(KEY);
  const b = await deriveVaultKey(KEY);
  const c = await deriveVaultKey(OTHER);
  assertEquals(a.id, b.id);
  assertNotEquals(a.id, c.id);
  assert(/^[0-9a-f-]{36}$/.test(a.id));
  await assertRejects(() => deriveVaultKey("short"), VaultError, "at least 32");
});

Deno.test("vault crypto: sealed per row, authenticated, opened only by its key", async () => {
  const key = await deriveVaultKey(KEY);
  const other = await deriveVaultKey(OTHER);
  const sealed = await sealSecret(key, "row-1", "s3cret");
  assert(!sealed.secret.includes("s3cret"));
  assertEquals(sealed.nonce.length, 12);
  const row = {
    id: "row-1",
    secret: sealed.secret,
    nonce: new Uint8Array(sealed.nonce),
    keyId: key.id,
  };
  assertEquals(await openSecret([key], row), "s3cret");
  assertEquals(await openSecret([other, key], { ...row, keyId: null }), "s3cret");
  assertEquals(await openSecret([key], { ...row, id: "row-2" }), null, "bound to its row");
  assertEquals(await openSecret([other], row), null, "another key id");
  assertEquals(await openSecret([key], { ...row, nonce: null }), null);
  assertEquals(await openSecret([key], { ...row, secret: "!!not base64" }), null);
  const again = await sealSecret(key, "row-1", "s3cret");
  assertNotEquals(again.secret, sealed.secret, "a fresh nonce every time");
});

Deno.test("vault: create, get, update, list, decrypted secrets, delete", async () => {
  const { rows } = setUp(KEY);
  try {
    const id = await vault.createSecret("sk_live", "stripe", "Stripe key");
    assert(!rows.get(id)!.secret.includes("sk_live"));
    assertEquals(await vault.get("stripe"), "sk_live");
    assertEquals(await vault.get("missing"), null);
    await vault.updateSecret(id, { secret: "sk_new", description: "rotated" });
    assertEquals(await vault.get("stripe"), "sk_new");
    await vault.updateSecret(id, { name: "payments" });
    assertEquals(await vault.get("payments"), "sk_new");
    await vault.updateSecret(id, { name: null });
    assertEquals(rows.get(id)!.name, null);
    await assertRejects(() => vault.updateSecret("not-a-uuid", {}), VaultError, "no such secret");
    await assertRejects(
      () => vault.updateSecret(crypto.randomUUID(), { description: "x" }),
      VaultError,
      "no such secret",
    );
    const other = await vault.createSecret("plain");
    const listed = await vault.list();
    assertEquals(listed.map((s) => [s.id, s.description]), [[id, "rotated"], [other, ""]]);
    assert(listed[0].createdAt instanceof Date);
    const decrypted = await vault.decryptedSecrets();
    assertEquals(decrypted.map((s) => s.decryptedSecret), ["sk_new", "plain"]);
    // A ciphertext moved onto another row does not open there.
    rows.get(other)!.secret = rows.get(id)!.secret;
    rows.get(other)!.nonce = rows.get(id)!.nonce;
    rows.get(other)!.name = "moved";
    await assertRejects(() => vault.get("moved"), VaultError, "does not decrypt");
    assertEquals(await vault.delete(other), true);
    assertEquals(await vault.delete("payments"), false, "renamed to null");
    assertEquals(await vault.delete(id), true);
    assertEquals(await vault.delete("nope"), false);
    await assertRejects(
      () => vault.createSecret(42 as unknown as string),
      TypeError,
      "must be a string",
    );
  } finally {
    tearDown();
  }
});

Deno.test("vault: an id in another case updates the secret it names, and it still reads", async () => {
  const { rows } = setUp(KEY);
  try {
    const id = await vault.createSecret("before", "upper");
    // `$1::uuid` matches the uppercase id; the ciphertext must be bound to the id the database
    // reads it back under (`id::text`, lowercase), or the secret is lost for good.
    await vault.updateSecret(id.toUpperCase(), { secret: "after" });
    assertEquals(await vault.get("upper"), "after");
    assertEquals((await vault.decryptedSecrets()).map((s) => s.decryptedSecret), ["after"]);
    // The AAD is the canonical id however the caller spells it.
    const key = await deriveVaultKey(KEY);
    const sealed = await sealSecret(key, id.toUpperCase(), "x");
    const row = { id, secret: sealed.secret, nonce: new Uint8Array(sealed.nonce), keyId: key.id };
    assertEquals(await openSecret([key], row), "x");
    assertEquals(await openSecret([key], { ...row, id: id.toUpperCase() }), "x");
    assertEquals(rows.size, 1);
  } finally {
    tearDown();
  }
});

Deno.test("vault: bytea read back as hex text decrypts too", async () => {
  const { rows } = setUp(KEY);
  try {
    const id = await vault.createSecret("hex", "h");
    const row = rows.get(id)!;
    (row as { nonce: unknown }).nonce = "\\x" +
      Array.from(row.nonce!, (b) => b.toString(16).padStart(2, "0")).join("");
    assertEquals(await vault.get("h"), "hex");
  } finally {
    tearDown();
  }
});

Deno.test("vault: rotation re-encrypts under the first key; the old one still reads", async () => {
  // Same table across a key change: the old key listed second.
  const table = vaultTable();
  installPostgres({ sql: table.sql, rls: { migrate: false } });
  try {
    installVault({ key: OTHER, migrate: false });
    const id = await vault.createSecret("old", "legacy");
    const before = table.rows.get(id)!.key_id;
    installVault({ key: [KEY, OTHER], migrate: false });
    assertEquals(await vault.get("legacy"), "old");
    assertEquals(await vault.rotate(), 1);
    assertNotEquals(table.rows.get(id)!.key_id, before);
    assertEquals(await vault.rotate(), 0);
    installVault({ key: KEY, migrate: false });
    assertEquals(await vault.get("legacy"), "old", "readable with the new key alone");
    // A row no key opens is skipped by rotate and refused by get.
    installVault({ key: "z".repeat(32), migrate: false });
    assertEquals(await vault.rotate(), 0);
    await assertRejects(() => vault.get("legacy"), VaultError, "does not decrypt");
  } finally {
    tearDown();
  }
});

Deno.test("vault: the key comes from DENEXT_VAULT_KEY; none, or a short one, is an error at use", async () => {
  setUp(undefined, { DENEXT_VAULT_KEY: KEY });
  try {
    await vault.createSecret("x", "from-env");
    assertEquals(await vault.get("from-env"), "x");
  } finally {
    tearDown();
  }
  setUp(undefined);
  try {
    await assertRejects(() => vault.get("x"), VaultError, "DENEXT_VAULT_KEY");
    // Not remembered: the next call derives again.
    await assertRejects(() => vault.get("x"), VaultError, "DENEXT_VAULT_KEY");
  } finally {
    tearDown();
  }
  setUp("too-short");
  try {
    await assertRejects(() => vault.createSecret("x"), VaultError, "at least 32");
  } finally {
    tearDown();
  }
  await assertRejects(() => vault.get("x"), VaultError, "not configured");
});

Deno.test("vault: the migration is Supabase's table shape, with nothing granted to clients", () => {
  const [migration] = vaultMigrations();
  assertEquals(migration.name, "backend_vault_0001");
  for (
    const part of [
      "CREATE TABLE IF NOT EXISTS vault.secrets",
      "key_id uuid",
      "nonce bytea",
      "ENABLE ROW LEVEL SECURITY",
      "REVOKE ALL ON vault.secrets FROM anon",
    ]
  ) assertStringIncludes(migration.sql, part);
});

Deno.test("vault: the migration runs once before the first call", async () => {
  const sql = scriptedSql(() => []);
  installPostgres({ sql, rls: { migrate: false } });
  installVault({ key: KEY });
  try {
    await vault.list();
    await vault.list();
    assertEquals(
      sql.calls.filter((c) => c.text.includes("CREATE TABLE IF NOT EXISTS vault.secrets")).length,
      1,
    );
  } finally {
    tearDown();
  }
});

Deno.test("vault SQL mode: withKey sets the keys for one transaction, as a bound parameter", async () => {
  const { vaultKeyedClient } = await import("../packages/backend/src/vault.ts");
  const { vaultKeysJson, vaultSqlMigrations } = await import(
    "../packages/backend/src/vault-sql.ts"
  );
  // Only the test's own (lowercase) statements return a row; the migration runner's see none.
  const sql = scriptedSql((text) => (text.startsWith("select") ? [{ ok: 1 }] : []));
  installPostgres({ sql, rls: { migrate: false } });
  try {
    installVault({ key: KEY, migrate: false });
    await assertRejects(() => vault.withKey(() => 1), VaultError, "sql: true");
    assertEquals(await vaultKeyedClient(sql), sql, "off: the client unchanged");
    installVault({ key: KEY, migrate: false, sql: true });
    const result = await vault.withKey(async (tx) => [...await tx`select 1 as ok`]);
    assertEquals(result, [{ ok: 1 }]);
    const set = sql.calls.find((c) =>
      c.text.includes("set_config('denext.vault_keys', $1, true)")
    )!;
    const key = await deriveVaultKey(KEY);
    assertEquals(set.params, [vaultKeysJson([key])]);
    assert(!set.text.includes(JSON.parse(set.params[0] as string)[0].key), "never in the text");
    assertEquals(JSON.parse(set.params[0] as string)[0].id, key.id);
    // The keyed client: every transaction gets the keys; plain statements do not.
    const keyed = await vaultKeyedClient(sql);
    sql.calls.length = 0;
    await keyed.begin(async (tx) => await tx`select 2`);
    assert(sql.calls[0].text.includes("set_config"));
    await keyed`select 3`;
    assertEquals(sql.calls.at(-1)!.text.includes("set_config"), false);
    // No key configured: unchanged, so the SQL raises its own error.
    installVault({ sql: true, migrate: false }, () => undefined);
    assertEquals(await vaultKeyedClient(sql), sql);
    // With migrate on, the SQL migration runs after the table's.
    installVault({ key: KEY, sql: true });
    sql.calls.length = 0;
    await vault.list();
    const order = sql.calls.map((c) => c.text).filter((t) =>
      /CREATE TABLE IF NOT EXISTS vault\.secrets|vault\.create_secret/.test(t)
    );
    assertEquals(order.length, 2);
    const [migration] = vaultSqlMigrations();
    for (
      const part of [
        "CREATE EXTENSION IF NOT EXISTS pgcrypto",
        "vault.decrypted_secrets",
        "SET search_path = pg_catalog, pg_temp",
        "REVOKE ALL ON vault.decrypted_secrets FROM anon",
        "aes-ecb/pad:none",
      ]
    ) assertStringIncludes(migration.sql, part);
  } finally {
    tearDown();
  }
});
