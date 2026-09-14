// The node:sqlite AuthAdapter: the shared contract suite (against a real database and
// against an injected SqliteDb), the single handle it shares with its `sessions` store,
// cross-compatibility with a database sqliteSessionStore wrote, the additive schema
// policy, durability across a restart, and the consume-once guards on a real file.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import { sqliteSessionStore } from "../src/server/auth/sqlite-session-store.ts";
import type { AuthSession } from "../src/server/auth/types.ts";
import type { SqliteDb, SqlValue } from "../src/server/sqlite-cache.ts";
import { adapterContract } from "./helpers/auth-adapter-contract.ts";

const at = (offset: number): number => Math.floor(Date.now() / 1000) + offset;

const session = (userId: string, expiresAt = at(3600)): AuthSession => ({
  user: { id: userId, email: `${userId}@x.test` },
  provider: "credentials",
  expiresAt,
});

/** A fresh file in a fresh temp directory — one database per caller. */
function tempDbPath(): string {
  return `${Deno.makeTempDirSync({ prefix: "denext-auth-adapter-" })}/auth.db`;
}

/** The column names a table has on disk, read with a connection of our own. */
function columnsOf(path: string, table: string): string[] {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare(`PRAGMA table_info(${table})`).all().map((row) =>
      String((row as { name: unknown }).name)
    );
  } finally {
    raw.close();
  }
}

/** How many rows a table holds, read with a connection of our own. */
function countOf(path: string, table: string): number {
  const raw = new DatabaseSync(path);
  try {
    return Number((raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    raw.close();
  }
}

/**
 * An `openDb` hook over an in-memory node:sqlite database that records every statement,
 * every open and every close — the seam an app can use to supply its own handle.
 */
function recordingHandle() {
  const sql: string[] = [];
  const seen = { opens: 0, closes: 0, paths: [] as string[] };
  const open = (path: string): SqliteDb => {
    seen.opens++;
    seen.paths.push(path);
    const raw = new DatabaseSync(":memory:");
    return {
      exec(statement: string, params?: SqlValue[]): void {
        sql.push(statement);
        if (params?.length) raw.prepare(statement).run(...params);
        else raw.exec(statement);
      },
      query<T>(statement: string, params?: SqlValue[]): T[] {
        sql.push(statement);
        return raw.prepare(statement).all(...(params ?? [])) as T[];
      },
      close(): void {
        seen.closes++;
        raw.close(); // a second close would throw here, so double-closing fails the test
      },
    };
  };
  return { open, sql, seen };
}

// ---- the shared contract ---------------------------------------------------

Deno.test("sqliteAuthAdapter (real node:sqlite) meets the adapter contract", async (t) => {
  await adapterContract(t, () => sqliteAuthAdapter({ path: ":memory:" }));
});

Deno.test("sqliteAuthAdapter meets the same contract over an injected SqliteDb", async (t) => {
  await adapterContract(
    t,
    () => sqliteAuthAdapter({ path: "/virtual/auth.db", openDb: recordingHandle().open }),
  );
});

// ---- the shared handle ------------------------------------------------------

Deno.test("sqliteAuthAdapter: one handle carries the auth schema AND sessions", async () => {
  const { open, sql, seen } = recordingHandle();
  const adapter = sqliteAuthAdapter({ path: "/virtual/auth.db", openDb: open });
  const store = adapter.sessions;
  assert(store, "the adapter exposes a session store");
  const user = await adapter.createUser({ email: "ada@x.test" });
  await store.create("sid", session(user.id));

  assertEquals(seen.opens, 1, "the adapter and its session store share ONE handle");
  assertEquals(seen.paths, ["/virtual/auth.db"], "the configured path reaches openDb");
  assert(sql.some((s) => s.includes("CREATE TABLE IF NOT EXISTS auth_users")), "auth schema");
  assert(sql.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sessions")), "sessions schema");
  assertEquals((await store.get("sid"))?.user.id, user.id);

  await adapter.close?.();
  assertEquals(seen.closes, 1, "closed once, not once per owner");
  await adapter.close?.();
  assertEquals(seen.closes, 1, "close() is idempotent");
});

Deno.test("sqliteAuthAdapter: a database sqliteSessionStore wrote is readable, and vice versa", async () => {
  const path = tempDbPath();
  const store = sqliteSessionStore({ path });
  await store.create("from-store", session("alice"));
  await store.close?.();

  // The `sessions` DDL is identical, so pointing an adapter at an existing session
  // database is a zero-step migration — nobody is logged out.
  const adapter = sqliteAuthAdapter({ path });
  assertEquals((await adapter.sessions?.get("from-store"))?.user.id, "alice");
  await adapter.sessions?.create("from-adapter", session("bob"));
  await adapter.createUser({ id: "bob", email: "bob@x.test" });
  await adapter.close?.();

  const reopened = sqliteSessionStore({ path });
  assertEquals((await reopened.get("from-adapter"))?.user.id, "bob", "and back the other way");
  await reopened.close?.();
  assertEquals(countOf(path, "auth_users"), 1, "both schemas live in the one file");
});

// ---- schema -----------------------------------------------------------------

Deno.test("sqliteAuthAdapter: durable across close/reopen, and a second open changes nothing", async () => {
  const path = tempDbPath();
  const first = sqliteAuthAdapter({ path });
  const user = await first.createUser({ email: "Ada@X.test", name: "Ada", roles: ["admin"] });
  await first.linkAccount({
    userId: user.id,
    provider: "google",
    providerAccountId: "sub-1",
    type: "oidc",
    scope: "openid email",
  });
  await first.setCredential?.(user.id, "scrypt$stored");
  await first.createApiToken?.({
    id: "t1",
    userId: user.id,
    name: "CI",
    tokenHash: "hash-t1",
    createdAt: at(-10),
    scopes: ["read"],
  });
  await first.setMfa?.({ userId: user.id, secret: "JBSWY3DPEHPK3PXP", backupCodeHashes: ["h1"] });
  const before = columnsOf(path, "auth_users");
  await first.close?.();

  const second = sqliteAuthAdapter({ path });
  assertEquals((await second.getUser(user.id))?.name, "Ada", "the user survived a restart");
  assertEquals((await second.getUser(user.id))?.roles, ["admin"], "JSON columns round-trip");
  assertEquals((await second.getUserByEmail("ada@x.test"))?.id, user.id, "and the email index");
  assertEquals(
    (await second.getUserByAccount({ provider: "google", providerAccountId: "sub-1" }))?.id,
    user.id,
  );
  assertEquals((await second.listAccounts?.(user.id))?.[0].scope, "openid email");
  assertEquals(await second.getCredential?.(user.id), "scrypt$stored");
  assertEquals((await second.getApiTokenByHash?.("hash-t1"))?.scopes, ["read"]);
  assertEquals((await second.getMfa?.(user.id))?.backupCodeHashes, ["h1"]);
  assertEquals(columnsOf(path, "auth_users"), before, "re-opening is idempotent, not additive");
  await second.close?.();
});

Deno.test("sqliteAuthAdapter: an older table gains the columns it lacks, with its backfill", async () => {
  const path = tempDbPath();
  const raw = new DatabaseSync(path);
  // A database written by a denext that knew only three of the columns.
  raw.exec("CREATE TABLE auth_users (id TEXT PRIMARY KEY, email TEXT, name TEXT)");
  raw.prepare("INSERT INTO auth_users VALUES (?, ?, ?)").run("legacy", "Legacy@X.test", "Legacy");
  raw.close();

  const adapter = sqliteAuthAdapter({ path });
  // The handle opens lazily, so the first read is what reconciles the schema.
  assertEquals((await adapter.getUser("legacy"))?.name, "Legacy", "the old row is untouched");
  const columns = columnsOf(path, "auth_users");
  for (const added of ["email_lc", "email_verified", "image", "roles", "created_at"]) {
    assert(columns.includes(added), `${added} was added to the older table`);
  }
  assertEquals(
    (await adapter.getUserByEmail("legacy@x.test"))?.id,
    "legacy",
    "the derived email index was backfilled from the rows that predate it",
  );
  await adapter.updateUser({ id: "legacy", roles: ["admin"] });
  assertEquals((await adapter.getUser("legacy"))?.roles, ["admin"], "and the new column is live");
  await adapter.close?.();
});

Deno.test("sqliteAuthAdapter: a unique index keeps one account per email address", async () => {
  const adapter = sqliteAuthAdapter({ path: ":memory:" });
  const ada = await adapter.createUser({ email: "ada@x.test" });
  assertThrows(
    () => void adapter.createUser({ email: "ADA@x.test" }),
    Error,
    undefined,
    "a second user on one address is refused, not silently merged",
  );
  assertEquals((await adapter.getUserByEmail("ada@x.test"))?.id, ada.id, "the first user survives");
  await adapter.createUser({ name: "anonymous" }); // no address: always allowed
  await adapter.createUser({ name: "also anonymous" });
  await adapter.close?.();
});

// ---- clock, sweep, races -----------------------------------------------------

Deno.test("sqliteAuthAdapter: `now` drives expiry, and the sweep reclaims spent tokens", async () => {
  const path = tempDbPath();
  let clock = at(0);
  const adapter = sqliteAuthAdapter({ path, now: () => clock, sweepEvery: 0 });
  const token = {
    identifier: "ada@x.test",
    tokenHash: "a".repeat(64),
    expires: clock + 60,
    purpose: "reset" as const,
  };
  await adapter.createVerificationToken?.(token);
  await adapter.createApiToken?.({
    id: "t1",
    userId: "u1",
    tokenHash: "hash-t1",
    createdAt: clock,
    expiresAt: clock + 60,
  });
  assertEquals((await adapter.getApiTokenByHash?.("hash-t1"))?.id, "t1");

  clock += 61;
  assertEquals(await adapter.useVerificationToken?.(token), undefined, "expired under our clock");
  assertEquals(await adapter.getApiTokenByHash?.("hash-t1"), undefined, "and so is the API token");

  // The next write sweeps: an expired token row is physically gone, not merely invisible.
  await adapter.createVerificationToken?.({
    ...token,
    identifier: "bob@x.test",
    expires: clock + 60,
  });
  assertEquals(countOf(path, "auth_verification_tokens"), 1, "only the live token is left");
  await adapter.close?.();
});

Deno.test("sqliteAuthAdapter: concurrent redemption of one backup code yields one success", async () => {
  const path = tempDbPath();
  const adapter = sqliteAuthAdapter({ path });
  const user = await adapter.createUser({ email: "ada@x.test" });
  await adapter.setMfa?.({ userId: user.id, secret: "S", backupCodeHashes: ["h1", "h2"] });
  // A real comparison is scrypt — async, and therefore a window a non-atomic
  // implementation would hand to both callers.
  const slow = async (hash: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return hash === "h1";
  };
  const results = await Promise.all([
    adapter.consumeBackupCode?.(user.id, slow),
    adapter.consumeBackupCode?.(user.id, slow),
    adapter.consumeBackupCode?.(user.id, slow),
  ]);
  assertEquals(results.filter(Boolean).length, 1, "a backup code is single-use under a race");
  assertEquals((await adapter.getMfa?.(user.id))?.backupCodeHashes, ["h2"]);

  // Two callers redeeming DIFFERENT codes both succeed: the compare-and-swap loser
  // retries against the rewritten list rather than reporting a spurious miss.
  await adapter.setMfa?.({ userId: user.id, secret: "S", backupCodeHashes: ["h1", "h2"] });
  const is = (want: string) => async (hash: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return hash === want;
  };
  const both = await Promise.all([
    adapter.consumeBackupCode?.(user.id, is("h1")),
    adapter.consumeBackupCode?.(user.id, is("h2")),
  ]);
  assertEquals(both, [true, true], "distinct codes are not lost to the race");
  assertEquals((await adapter.getMfa?.(user.id))?.backupCodeHashes, []);

  // The TOTP replay guard is one statement, so a burst of claims on one step is decided by
  // SQLite rather than by JS interleaving.
  const claims = await Promise.all([
    adapter.claimTotpStep?.(user.id, 42),
    adapter.claimTotpStep?.(user.id, 42),
  ]);
  assertEquals(claims.filter(Boolean).length, 1, "a TOTP step is claimed exactly once");
  await adapter.close?.();
});
