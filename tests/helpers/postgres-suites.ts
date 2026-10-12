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

/** A fresh database for one case: a client, and the schema to keep its tables in. */
export interface Fresh {
  sql: SqlClient;
  schema?: string;
}

type Case = (db: Fresh) => Promise<void>;

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
      assertEquals(await adapter.createPasskey!(passkey("cred-1", "u1", at(-10))), true);
      assertEquals(await adapter.createPasskey!(passkey("cred-1", "u2")), false, "ID taken");
      await adapter.createPasskey!(passkey("cred-2", "u1"));
      const read = await adapter.getPasskey!("cred-1");
      assertEquals(read, { ...passkey("cred-1", "u1", at(-10)) });
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
      assertEquals([read?.signCount, read?.backedUp, read?.lastUsedAt], [5, true, at(0)]);
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

const SESSION_CASES: Record<string, Case> = {
  "session store: create/get/update/delete/deleteByUser": async (db) => {
    const store = postgresSessionStore({ ...db, sweepIntervalMs: 0 });
    try {
      const s = (id: string, expiresAt = at(3600)) => ({
        user: { id },
        provider: "credentials",
        expiresAt,
      });
      await store.create("a", s("alice"));
      await store.create("b", s("bob"));
      assertEquals((await store.get("a"))?.user.id, "alice");
      assertEquals(await store.update!("a", s("alice", at(7200))), true);
      assertEquals((await store.get("a"))?.expiresAt, at(7200));
      assertEquals(await store.update!("nope", s("x")), false, "write-only-if-present");
      await store.create("old", s("carol", at(-1)));
      assertEquals(await store.get("old"), undefined, "expired is a miss");
      assertEquals(await store.update!("old", s("carol")), false, "an expired row stays dead");
      await store.deleteByUser("alice");
      assertEquals(await store.get("a"), undefined);
      await store.delete("b");
      assertEquals(await store.get("b"), undefined);
    } finally {
      await store.close?.();
    }
  },
};

const RATE_LIMIT_CASES: Record<string, Case> = {
  "rate-limit store: counts in a window, resets, decrements and starts over": async (db) => {
    const store = postgresRateLimitStore({ ...db, sweepIntervalMs: 0 });
    try {
      assertEquals(await store.get("k"), undefined);
      const first = await store.increment("k", 60_000);
      assertEquals(first.count, 1);
      assert(first.resetAt > Date.now());
      const concurrent = await Promise.all([
        store.increment("k", 60_000),
        store.increment("k", 60_000),
        store.increment("k", 60_000),
      ]);
      assertEquals(concurrent.map((w) => w.count).sort(), [2, 3, 4], "every failure counted");
      assertEquals((await store.get("k"))?.count, 4);
      assertEquals((await store.get("k"))?.resetAt, first.resetAt, "the window does not slide");
      await store.decrement!("k");
      assertEquals((await store.get("k"))?.count, 3);
      await store.reset("k");
      assertEquals(await store.get("k"), undefined);
      // A window already closed starts over at 1 with a new reset time.
      await store.increment("short", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertEquals(await store.get("short"), undefined, "a closed window reads as none");
      assertEquals((await store.increment("short", 60_000)).count, 1);
    } finally {
      await store.close();
    }
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
  "cache: data round-trips (value, expiry, staleAt) and misses after expiry": async (db) => {
    const store = postgresCacheStore(db);
    try {
      await store.setData("k", { value: { n: 1, s: "x" }, expiresAt: Infinity, tags: ["t"] });
      assertEquals(await store.getData("k"), {
        value: { n: 1, s: "x" },
        expiresAt: Infinity,
        tags: ["t"],
      });
      await store.setData("s", {
        value: 2,
        expiresAt: Date.now() + 60_000,
        staleAt: 123,
        tags: [],
      });
      assertEquals((await store.getData("s"))?.staleAt, 123);
      await store.setData("old", { value: 3, expiresAt: Date.now() - 1, tags: [] });
      assertEquals(await store.getData("old"), undefined);
      assertEquals(await store.getData("missing"), undefined);
    } finally {
      await store.close();
    }
  },
  "cache: pages round-trip with PPR extras; deleteByPath / deleteByTag": async (db) => {
    const store = postgresCacheStore(db);
    try {
      await store.setPage("p1", page("/a", ["blog"], { csp: "x", holeIds: ["h1"] }));
      await store.setPage("p2", page("/b", ["blog", "home"]));
      await store.setData("d1", { value: 1, expiresAt: Infinity, tags: ["blog"] });
      const read = await store.getPage("p1");
      assertEquals([read?.path, read?.csp, read?.holeIds, read?.status], ["/a", "x", ["h1"], 200]);
      await store.deleteByPath("/a");
      assertEquals(await store.getPage("p1"), undefined);
      assert(await store.getPage("p2"));
      await store.deleteByTag("blog");
      assertEquals(await store.getPage("p2"), undefined);
      assertEquals(await store.getData("d1"), undefined);
    } finally {
      await store.close();
    }
  },
  "cache: expireByTag soft-expires in place; a retag drops the old tag": async (db) => {
    const store = postgresCacheStore(db);
    try {
      await store.setData("d", { value: 1, expiresAt: Infinity, tags: ["a"] });
      await store.setPage("p", page("/p", ["a"]));
      const staleAt = Date.now() - 1;
      await store.expireByTag!("a", { staleAt, expiresAt: Date.now() + 60_000 });
      assertEquals((await store.getData("d"))?.staleAt, staleAt);
      assertEquals((await store.getPage("p"))?.staleAt, staleAt);
      await store.setData("d", { value: 2, expiresAt: Infinity, tags: ["b"] });
      await store.deleteByTag("a");
      assertEquals((await store.getData("d"))?.value, 2, "no longer tagged a");
    } finally {
      await store.close();
    }
  },
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
  "cache: sweepPages keeps one prefix and reports how many went": async (db) => {
    const store = postgresCacheStore(db);
    try {
      await store.setPage("v2:new:/a", page("/a", ["t"]));
      await store.setPage("v2:old:/a", page("/a", ["t"]));
      await store.setPage("v1:/b", page("/b", []));
      assertEquals(await store.sweepPages!("v2:new:"), 2);
      assert(await store.getPage("v2:new:/a"));
      assertEquals(await store.sweepPages!("v2:new:"), 0);
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
  await runCases(t, fresh, SESSION_CASES);
  await runCases(t, fresh, RATE_LIMIT_CASES);
  await runCases(t, fresh, CACHE_CASES);
  await runCases(t, fresh, MIGRATION_CASES);
}
