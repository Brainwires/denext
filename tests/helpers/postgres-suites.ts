// The Postgres store suites, run twice: against the node:sqlite-backed fake client on every
// Deno (tests/postgres-stores.test.ts) and against a real Postgres server on denext's runtime
// (tests/postgres-integration.test.ts). Each case gets a FRESH database from `fresh()` — a new
// fake, or a new schema on the real server — so no case can see another's rows.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SqlClient } from "../../src/server/postgres.ts";
import { postgresAuthAdapter } from "../../src/server/auth/postgres-adapter.ts";
import { postgresSessionStore } from "../../src/server/auth/postgres-session-store.ts";
import { postgresRateLimitStore } from "../../src/server/auth/postgres-rate-limit.ts";
import { postgresCacheStore } from "../../src/server/postgres-cache.ts";
import { migratePostgres, postgresMigrationStatus } from "../../src/server/postgres-migrate.ts";
import type { PasskeyRecord } from "../../src/server/auth/adapter.ts";
import type { CachedPage } from "../../src/server/cache.ts";
import { adapterContract } from "./auth-adapter-contract.ts";
import {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
} from "../../src/testing/store-contracts.ts";
import { DELETED_USER_CASES } from "./deleted-user-tokens.ts";

/** A fresh database for one case: a client, and the schema to keep its tables in. */
export interface Fresh {
  sql: SqlClient;
  schema?: string;
}

type Case = (db: Fresh) => Promise<void>;

// Seconds from now. A case that compares a stored time with an expected one computes it ONCE and
// reuses that value: computing `at(…)` again could land on the next second.
const at = (offset: number): number => Math.floor(Date.now() / 1000) + offset;

const passkey = (id: string, userId: string, createdAt = at(0)): PasskeyRecord => ({
  id,
  userId,
  publicKey: "pk",
  alg: -7,
  signCount: 0,
  backupEligible: true,
  backedUp: false,
  transports: ["internal"],
  createdAt,
});

const PASSKEY_CASES: Record<string, Case> = {
  "passkeys: create refuses a taken ID, get/list read back, delete removes": async (db) => {
    const adapter = postgresAuthAdapter(db);
    try {
      const created = at(-10);
      assertEquals(await adapter.createPasskey!(passkey("cred-1", "u1", created)), true);
      assertEquals(await adapter.createPasskey!(passkey("cred-1", "u2")), false, "ID taken");
      await adapter.createPasskey!(passkey("cred-2", "u1"));
      const read = await adapter.getPasskey!("cred-1");
      assertEquals(read, { ...passkey("cred-1", "u1", created) });
      assertEquals((await adapter.listPasskeys!("u1")).map((p) => p.id), ["cred-1", "cred-2"]);
      assertEquals(await adapter.getPasskey!("nope"), undefined);
      await adapter.deletePasskey!("cred-1");
      assertEquals(await adapter.getPasskey!("cred-1"), undefined);
    } finally {
      await adapter.close?.();
    }
  },
  "passkeys: updatePasskey is a compare-and-swap on the counter": async (db) => {
    const adapter = postgresAuthAdapter(db);
    try {
      await adapter.createPasskey!(passkey("c", "u1"));
      const update = { signCount: 5, backedUp: true, lastUsedAt: at(0) };
      const both = await Promise.all([
        adapter.updatePasskey!("c", 0, update),
        adapter.updatePasskey!("c", 0, update),
      ]);
      assertEquals(both.filter(Boolean).length, 1);
      const read = await adapter.getPasskey!("c");
      assertEquals(
        [read?.signCount, read?.backedUp, read?.lastUsedAt],
        [5, true, update.lastUsedAt],
      );
    } finally {
      await adapter.close?.();
    }
  },
  "passkeys: a challenge is single-use and fails closed on expiry": async (db) => {
    const adapter = postgresAuthAdapter(db);
    try {
      await adapter.createPasskeyChallenge!({ hash: "h", expiresAt: at(60), data: "{}" });
      const both = await Promise.all([
        adapter.usePasskeyChallenge!("h"),
        adapter.usePasskeyChallenge!("h"),
      ]);
      assertEquals(both.filter(Boolean).length, 1);
      await adapter.createPasskeyChallenge!({ hash: "old", expiresAt: at(-1), data: "{}" });
      assertEquals(await adapter.usePasskeyChallenge!("old"), undefined);
      assertEquals(await adapter.usePasskeyChallenge!("old"), undefined, "and it is spent");
    } finally {
      await adapter.close?.();
    }
  },
  "deleteUser also clears passkeys, tokens, MFA, credentials and store sessions": async (db) => {
    const adapter = postgresAuthAdapter(db);
    try {
      const user = await adapter.createUser({ email: "gone@x.test" });
      await adapter.createPasskey!(passkey("pk-gone", user.id));
      await adapter.setCredential!(user.id, "scrypt$x");
      await adapter.setMfa!({ userId: user.id, secret: "S", backupCodeHashes: [] });
      await adapter.createVerificationToken!({
        identifier: "gone@x.test",
        tokenHash: "t",
        expires: at(60),
        purpose: "reset",
      });
      await adapter.sessions!.create("s-gone", {
        user: { id: user.id },
        provider: "credentials",
        expiresAt: at(60),
      });
      await adapter.deleteUser!(user.id);
      assertEquals(await adapter.getPasskey!("pk-gone"), undefined);
      assertEquals(await adapter.getCredential!(user.id), undefined);
      assertEquals(await adapter.getMfa!(user.id), undefined);
      assertEquals(await adapter.sessions!.get("s-gone"), undefined);
      assertEquals(
        await adapter.useVerificationToken!({
          identifier: "gone@x.test",
          tokenHash: "t",
          purpose: "reset",
        }),
        undefined,
      );
    } finally {
      await adapter.close?.();
    }
  },
  "a closed adapter refuses instead of reconnecting": async (db) => {
    const adapter = postgresAuthAdapter(db);
    await adapter.close?.();
    await assertRejects(() => Promise.resolve(adapter.getUser("x")), Error, "closed");
  },
};

const page = (path: string, tags: string[], extra: Partial<CachedPage> = {}): CachedPage => ({
  body: `<p>${path}</p>`,
  status: 200,
  path,
  expiresAt: Infinity,
  tags,
  ...extra,
});

const CACHE_CASES: Record<string, Case> = {
  "cache: the oldest-written rows go past the cap; expired rows are swept": async (db) => {
    const store = postgresCacheStore({
      ...db,
      maxDataEntries: 2,
      maxPageEntries: 1,
      sweepIntervalMs: 0,
    });
    try {
      for (const key of ["a", "b", "c"]) {
        await store.setData(key, { value: key, expiresAt: Infinity, tags: ["t"] });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assertEquals(await store.getData("a"), undefined, "evicted");
      assertEquals((await store.getData("c"))?.value, "c");
      await store.setPage("p1", page("/1", []));
      await new Promise((resolve) => setTimeout(resolve, 2));
      await store.setPage("p2", page("/2", []));
      assertEquals(await store.getPage("p1"), undefined);
      await store.setData("x", { value: 1, expiresAt: Date.now() - 1, tags: [] });
      await store.setData("y", { value: 1, expiresAt: Infinity, tags: [] }); // sweeps x
      assertEquals(await store.getData("x"), undefined);
    } finally {
      await store.close();
    }
  },
};

const MIGRATION_CASES: Record<string, Case> = {
  "migrations: dry run, apply in order, status, then nothing pending": async (db) => {
    const p = db.schema ? `"${db.schema}".` : "";
    const migrations = [
      { name: "002_b", sql: `CREATE TABLE IF NOT EXISTS ${p}mb (id INTEGER PRIMARY KEY);` },
      {
        name: "001_a",
        sql: `CREATE TABLE IF NOT EXISTS ${p}ma (id INTEGER PRIMARY KEY);\n` +
          `INSERT INTO ${p}ma (id) VALUES (1);`,
      },
    ];
    const options = { migrations, schema: db.schema };
    const before = await postgresMigrationStatus(db.sql, options);
    assertEquals(before.pending, ["001_a", "002_b"]);
    const dry = await migratePostgres(db.sql, { ...options, dryRun: true });
    assertEquals(dry, { applied: [], pending: ["001_a", "002_b"], dryRun: true });
    assertEquals((await postgresMigrationStatus(db.sql, options)).pending.length, 2, "dry");
    // Two runners at once (two instances deploying): each migration applies exactly once.
    const [one, two] = await Promise.all([
      migratePostgres(db.sql, options),
      migratePostgres(db.sql, options),
    ]);
    assertEquals([...one.applied, ...two.applied].sort(), ["001_a", "002_b"]);
    const after = await postgresMigrationStatus(db.sql, options);
    assertEquals(after.pending, []);
    assert(after.migrations.every((m) => m.applied && m.appliedAt instanceof Date));
    assertEquals((await migratePostgres(db.sql, options)).applied, []);
    // An edited migration is reported, not re-run; a vanished one is listed as unknown.
    const edited = await postgresMigrationStatus(db.sql, {
      migrations: [{ name: "001_a", sql: "SELECT 1;" }],
      schema: db.schema,
    });
    assertEquals(edited.migrations[0].changed, true);
    assertEquals(edited.unknown, ["002_b"]);
  },
  "migrations: a failing one rolls back alone and names itself": async (db) => {
    const prefix = db.schema ? `"${db.schema}".` : "";
    const options = {
      schema: db.schema,
      migrations: [
        { name: "1_ok", sql: `CREATE TABLE IF NOT EXISTS ${prefix}ok_t (id INTEGER);` },
        {
          name: "2_bad",
          sql: `CREATE TABLE ${prefix}bad_t (id INTEGER);\nSELECT * FROM ${prefix}no_such_table;`,
        },
      ],
    };
    await assertRejects(() => migratePostgres(db.sql, options), Error, "migration 2_bad failed");
    const status = await postgresMigrationStatus(db.sql, options);
    assertEquals(status.pending, ["2_bad"]);
    await assertRejects(() => Promise.resolve(db.sql.unsafe(`SELECT * FROM ${prefix}bad_t`)));
  },
};

/** Run one group of cases, each on its own fresh database. */
async function runCases(
  t: Deno.TestContext,
  fresh: () => Promise<Fresh>,
  group: Record<string, Case>,
): Promise<void> {
  for (const [name, run] of Object.entries(group)) {
    await t.step(name, async () => await run(await fresh()));
  }
}

/**
 * Every Postgres store suite: the shared AuthAdapter contract, then passkeys, deletion,
 * sessions, rate limits, the cache store and the migration runner.
 *
 * @param t The test context.
 * @param fresh A fresh database per case.
 */
export async function postgresSuites(
  t: Deno.TestContext,
  fresh: () => Promise<Fresh>,
): Promise<void> {
  await t.step("AuthAdapter contract", async (t) => {
    await adapterContract(t, async () => postgresAuthAdapter(await fresh()));
  });
  await runCases(t, fresh, PASSKEY_CASES);
  // The exported store contracts (denext/testing), as every store runs them.
  await t.step("SessionStore contract", async (t) => {
    await sessionStoreContract(
      t,
      async () => postgresSessionStore({ ...await fresh(), sweepIntervalMs: 0 }),
    );
  });
  await t.step("RateLimitStore contract", async (t) => {
    await rateLimitStoreContract(
      t,
      async () => postgresRateLimitStore({ ...await fresh(), sweepIntervalMs: 0 }),
    );
  });
  await t.step("CacheStore contract", async (t) => {
    await cacheStoreContract(t, async () => postgresCacheStore(await fresh()));
  });
  await runCases(t, fresh, CACHE_CASES);
  await runCases(t, fresh, MIGRATION_CASES);
  for (const [name, run] of Object.entries(DELETED_USER_CASES)) {
    await t.step(name, async () => {
      const db = await fresh();
      const adapter = postgresAuthAdapter(db);
      const users = db.schema ? `"${db.schema}".auth_users` : "auth_users";
      try {
        // The user's row alone, as a deletion that left its sessions behind would.
        await run({
          adapter,
          forget: async (id) =>
            void await db.sql.unsafe(`DELETE FROM ${users} WHERE id = $1`, [id]),
        });
      } finally {
        await adapter.close?.();
      }
    });
  }
}
