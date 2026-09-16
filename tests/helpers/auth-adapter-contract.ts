// The shared AuthAdapter contract suite. Every adapter denext ships — the in-memory one
// (tests/auth-adapter.test.ts) and the node:sqlite one (tests/auth-adapter-sqlite.test.ts)
// — runs exactly these cases, so "implements AuthAdapter" means one thing and a new
// adapter (yours, or a future first-party one) has a definition of done.
//
// Each case gets a FRESH adapter from `make()` and closes it afterwards, so a case can
// never see another's rows and a leaked database handle fails the suite rather than the
// next test.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type { AuthAdapter } from "../../src/server/auth/adapter.ts";
import type { AuthSession } from "../../src/server/auth/types.ts";

/** One contract case: exercise a fresh adapter, throw to fail. */
type Case = (adapter: AuthAdapter) => Promise<void>;

/** Epoch seconds, `offset` seconds from now. */
const at = (offset: number): number => Math.floor(Date.now() / 1000) + offset;

/** A session payload for the `sessions` cases. */
const session = (userId: string, expiresAt = at(3600)): AuthSession => ({
  user: { id: userId, email: `${userId}@x.test` },
  provider: "credentials",
  expiresAt,
});

/** A verification-token record, expiring in an hour unless told otherwise. */
const token = (expires = at(3600)) => ({
  identifier: "user@x.test",
  tokenHash: "a".repeat(64),
  expires,
  purpose: "email" as const,
});

/** An API-token record for `userId`. */
const apiToken = (id: string, userId: string, expiresAt?: number) => ({
  id,
  userId,
  name: `token ${id}`,
  tokenHash: `hash-${id}`,
  createdAt: at(0),
  expiresAt,
});

/** A user + one linked Google account, the fixture most cases start from. */
async function seedLinkedUser(adapter: AuthAdapter, email = "ada@x.test") {
  const user = await adapter.createUser({ email, name: "Ada", emailVerified: at(-60) });
  await adapter.linkAccount({
    userId: user.id,
    provider: "google",
    providerAccountId: `sub-${user.id}`,
    type: "oidc",
  });
  return user;
}

// ---- users -----------------------------------------------------------------

const USER_CASES: Record<string, Case> = {
  "createUser mints an id and getUser reads it back": async (adapter) => {
    const user = await adapter.createUser({ email: "ada@x.test", name: "Ada" });
    assert(user.id, "createUser must assign an id");
    const read = await adapter.getUser(user.id);
    assertEquals(read?.email, "ada@x.test");
    assertEquals(read?.name, "Ada");
    assertEquals(await adapter.getUser("nope"), undefined);
  },
  "createUser keeps an externally minted id, and ids are unique": async (adapter) => {
    const mine = await adapter.createUser({ id: "u-1", email: "a@x.test" });
    assertEquals(mine.id, "u-1");
    const a = await adapter.createUser({ email: "b@x.test" });
    const b = await adapter.createUser({ email: "c@x.test" });
    assertNotEquals(a.id, b.id);
  },
  "getUserByEmail is case- and whitespace-insensitive": async (adapter) => {
    const user = await adapter.createUser({ email: "Ada@X.test" });
    assertEquals((await adapter.getUserByEmail("ada@x.test"))?.id, user.id);
    assertEquals((await adapter.getUserByEmail("  ADA@x.TEST "))?.id, user.id);
    assertEquals(await adapter.getUserByEmail("someone@x.test"), undefined);
  },
  "getUserByAccount resolves a linked account, and only that one": async (adapter) => {
    const user = await seedLinkedUser(adapter);
    const found = await adapter.getUserByAccount({
      provider: "google",
      providerAccountId: `sub-${user.id}`,
    });
    assertEquals(found?.id, user.id);
    assertEquals(
      await adapter.getUserByAccount({ provider: "github", providerAccountId: `sub-${user.id}` }),
      undefined,
      "the provider is part of the key",
    );
    assertEquals(
      await adapter.getUserByAccount({ provider: "google", providerAccountId: "other" }),
      undefined,
    );
  },
  "updateUser merges the given fields and re-indexes the email": async (adapter) => {
    const user = await adapter.createUser({ email: "old@x.test", name: "Ada" });
    const updated = await adapter.updateUser({
      id: user.id,
      email: "new@x.test",
      roles: ["admin"],
    });
    assertEquals(updated.email, "new@x.test");
    assertEquals(updated.name, "Ada", "an absent field is unchanged");
    assertEquals(updated.roles, ["admin"]);
    assertEquals((await adapter.getUserByEmail("new@x.test"))?.id, user.id);
    assertEquals(await adapter.getUserByEmail("old@x.test"), undefined, "the old index is gone");
  },
  "emailVerified round-trips as epoch seconds": async (adapter) => {
    const when = at(-120);
    const user = await adapter.createUser({ email: "v@x.test", emailVerified: when });
    assertEquals((await adapter.getUser(user.id))?.emailVerified, when);
    const cleared = await adapter.createUser({ email: "u@x.test" });
    assertEquals((await adapter.getUser(cleared.id))?.emailVerified, undefined);
  },
  "one account per email address — a second user on one address is refused": async (adapter) => {
    // The SQLite adapter enforces this with a unique index; the in-memory one has to check
    // for itself. Both must refuse, or "which identity owns this address" — the question
    // account linking exists to answer — has two answers depending on the adapter.
    const ada = await adapter.createUser({ email: "ada@x.test" });
    await assertRejects(
      async () => await adapter.createUser({ email: "ADA@x.test" }),
      Error,
      undefined,
      "case-insensitively the same address, so it is the same address",
    );
    assertEquals(
      (await adapter.getUserByEmail("ada@x.test"))?.id,
      ada.id,
      "the first user survives the refusal",
    );
    const other = await adapter.createUser({ email: "grace@x.test" });
    await assertRejects(
      async () => await adapter.updateUser({ id: other.id, email: "ada@x.test" }),
      Error,
      undefined,
      "an update cannot take an address either",
    );
    // Address-less users are unconstrained, however many there are.
    await adapter.createUser({ name: "anonymous" });
    await adapter.createUser({ name: "also anonymous" });
  },
  "a record handed back is a copy — mutating it does not change the store": async (adapter) => {
    const user = await adapter.createUser({ email: "copy@x.test", name: "Ada" });
    const read = await adapter.getUser(user.id);
    assert(read);
    read.name = "mutated";
    assertEquals((await adapter.getUser(user.id))?.name, "Ada");
  },
};

// ---- accounts --------------------------------------------------------------

const ACCOUNT_CASES: Record<string, Case> = {
  "linkAccount stores the provider fields": async (adapter) => {
    const list = adapter.listAccounts;
    assert(list, "listAccounts is required by this contract");
    const user = await adapter.createUser({ email: "ada@x.test" });
    await adapter.linkAccount({
      userId: user.id,
      provider: "github",
      providerAccountId: "42",
      type: "oauth",
      scope: "read:user",
      expiresAt: at(3600),
    });
    const [account] = await list.call(adapter, user.id);
    assertEquals(account.provider, "github");
    assertEquals(account.providerAccountId, "42");
    assertEquals(account.scope, "read:user");
    assertEquals(account.userId, user.id);
  },
  "listAccounts returns only that user's accounts": async (adapter) => {
    const list = adapter.listAccounts;
    assert(list);
    const ada = await seedLinkedUser(adapter, "ada@x.test");
    const bob = await seedLinkedUser(adapter, "bob@x.test");
    await adapter.linkAccount({ userId: ada.id, provider: "github", providerAccountId: "gh-1" });
    assertEquals((await list.call(adapter, ada.id)).length, 2);
    assertEquals((await list.call(adapter, bob.id)).length, 1);
    assertEquals(await list.call(adapter, "nobody"), []);
  },
  "unlinkAccount removes exactly one link": async (adapter) => {
    const unlink = adapter.unlinkAccount;
    const list = adapter.listAccounts;
    assert(unlink && list, "unlinkAccount + listAccounts are required by this contract");
    const user = await seedLinkedUser(adapter);
    await adapter.linkAccount({ userId: user.id, provider: "github", providerAccountId: "gh-1" });
    await unlink.call(adapter, { provider: "google", providerAccountId: `sub-${user.id}` });
    assertEquals(
      await adapter.getUserByAccount({
        provider: "google",
        providerAccountId: `sub-${user.id}`,
      }),
      undefined,
    );
    assertEquals((await list.call(adapter, user.id)).length, 1, "the other link survives");
    await unlink.call(adapter, { provider: "google", providerAccountId: "gone" }); // no-op
  },
};

// ---- verification tokens ---------------------------------------------------

const VERIFICATION_CASES: Record<string, Case> = {
  "useVerificationToken consumes exactly once": async (adapter) => {
    const create = adapter.createVerificationToken;
    const use = adapter.useVerificationToken;
    assert(create && use, "the verification-token group is required by this contract");
    const record = token();
    await create.call(adapter, { ...record, data: "payload" });
    const first = await use.call(adapter, record);
    assertEquals(first?.identifier, record.identifier);
    assertEquals(first?.data, "payload");
    assertEquals(await use.call(adapter, record), undefined, "a second redemption is a miss");
  },
  "an expired token never resolves — and is spent anyway": async (adapter) => {
    const create = adapter.createVerificationToken;
    const use = adapter.useVerificationToken;
    assert(create && use);
    const record = token(at(-1));
    await create.call(adapter, record);
    assertEquals(await use.call(adapter, record), undefined, "expired must not resolve");
    assertEquals(await use.call(adapter, record), undefined, "and it is gone, not retryable");
  },
  "the identifier, the hash and the purpose are all part of the key": async (adapter) => {
    const create = adapter.createVerificationToken;
    const use = adapter.useVerificationToken;
    assert(create && use);
    const record = token();
    await create.call(adapter, record);
    assertEquals(await use.call(adapter, { ...record, identifier: "other@x.test" }), undefined);
    assertEquals(await use.call(adapter, { ...record, tokenHash: "b".repeat(64) }), undefined);
    assertEquals(await use.call(adapter, { ...record, purpose: "reset" }), undefined);
    assertEquals(
      (await use.call(adapter, record))?.tokenHash,
      record.tokenHash,
      "none of those misses consumed the real token",
    );
  },
  "one identifier can hold a token per purpose": async (adapter) => {
    const create = adapter.createVerificationToken;
    const use = adapter.useVerificationToken;
    assert(create && use);
    await create.call(adapter, token());
    await create.call(adapter, { ...token(), purpose: "reset" });
    assertEquals((await use.call(adapter, { ...token(), purpose: "reset" }))?.purpose, "reset");
    assertEquals((await use.call(adapter, token()))?.purpose, "email");
  },
};

// ---- credentials -----------------------------------------------------------

const CREDENTIAL_CASES: Record<string, Case> = {
  "setCredential / getCredential round-trip, and replace": async (adapter) => {
    const get = adapter.getCredential;
    const set = adapter.setCredential;
    assert(get && set, "the credentials group is required by this contract");
    const user = await adapter.createUser({ email: "ada@x.test" });
    assertEquals(await get.call(adapter, user.id), undefined, "no password yet");
    await set.call(adapter, user.id, "scrypt$first");
    assertEquals(await get.call(adapter, user.id), "scrypt$first");
    await set.call(adapter, user.id, "scrypt$second");
    assertEquals(await get.call(adapter, user.id), "scrypt$second");
    assertEquals(await get.call(adapter, "someone-else"), undefined);
  },
  "deleteCredential removes the password, and removing a missing one is fine": async (adapter) => {
    const get = adapter.getCredential;
    const set = adapter.setCredential;
    const del = adapter.deleteCredential;
    assert(get && set && del, "both first-party adapters implement the optional delete");
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, user.id, "scrypt$first");
    await del.call(adapter, user.id);
    assertEquals(await get.call(adapter, user.id), undefined);
    await del.call(adapter, user.id);
  },
};

// ---- API tokens ------------------------------------------------------------

const API_TOKEN_CASES: Record<string, Case> = {
  "createApiToken / getApiTokenByHash is an exact match": async (adapter) => {
    const create = adapter.createApiToken;
    const byHash = adapter.getApiTokenByHash;
    assert(create && byHash, "the API-token group is required by this contract");
    const user = await adapter.createUser({ email: "ada@x.test" });
    await create.call(adapter, apiToken("t1", user.id));
    const found = await byHash.call(adapter, "hash-t1");
    assertEquals(found?.id, "t1");
    assertEquals(found?.userId, user.id);
    assertEquals(await byHash.call(adapter, "hash-t"), undefined, "no prefix matching");
    assertEquals(await byHash.call(adapter, "hash-t1 "), undefined, "no trimming");
  },
  "touchApiToken records the last use": async (adapter) => {
    const create = adapter.createApiToken;
    const touch = adapter.touchApiToken;
    const byHash = adapter.getApiTokenByHash;
    assert(create && touch && byHash);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await create.call(adapter, apiToken("t1", user.id));
    assertEquals((await byHash.call(adapter, "hash-t1"))?.lastUsedAt, undefined);
    const when = at(0);
    await touch.call(adapter, "t1", when);
    assertEquals((await byHash.call(adapter, "hash-t1"))?.lastUsedAt, when);
    await touch.call(adapter, "unknown", when); // no-op, no throw
  },
  "a revoked token stops authenticating and stops being listed": async (adapter) => {
    const create = adapter.createApiToken;
    const revoke = adapter.revokeApiToken;
    const byHash = adapter.getApiTokenByHash;
    const list = adapter.listApiTokens;
    assert(create && revoke && byHash && list);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await create.call(adapter, apiToken("t1", user.id));
    await create.call(adapter, apiToken("t2", user.id));
    await revoke.call(adapter, "t1");
    assertEquals(await byHash.call(adapter, "hash-t1"), undefined);
    assertEquals((await list.call(adapter, user.id)).map((t) => t.id), ["t2"]);
    await revoke.call(adapter, "unknown"); // no-op, no throw
  },
  "an expired token is invisible to both reads": async (adapter) => {
    const create = adapter.createApiToken;
    const byHash = adapter.getApiTokenByHash;
    const list = adapter.listApiTokens;
    assert(create && byHash && list);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await create.call(adapter, apiToken("live", user.id, at(3600)));
    await create.call(adapter, apiToken("stale", user.id, at(-1)));
    assertEquals(await byHash.call(adapter, "hash-stale"), undefined);
    assertEquals((await byHash.call(adapter, "hash-live"))?.id, "live");
    assertEquals((await list.call(adapter, user.id)).map((t) => t.id), ["live"]);
  },
  "listApiTokens is scoped to one user": async (adapter) => {
    const create = adapter.createApiToken;
    const list = adapter.listApiTokens;
    assert(create && list);
    const ada = await adapter.createUser({ email: "ada@x.test" });
    const bob = await adapter.createUser({ email: "bob@x.test" });
    await create.call(adapter, apiToken("a1", ada.id));
    await create.call(adapter, apiToken("b1", bob.id));
    assertEquals((await list.call(adapter, ada.id)).map((t) => t.id), ["a1"]);
    assertEquals(await list.call(adapter, "nobody"), []);
  },
};

// ---- MFA -------------------------------------------------------------------

const MFA_CASES: Record<string, Case> = {
  "deleteMfa removes the factor, and removing a missing one is fine": async (adapter) => {
    const get = adapter.getMfa;
    const set = adapter.setMfa;
    const del = adapter.deleteMfa;
    assert(get && set && del, "both first-party adapters implement the optional delete");
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, { userId: user.id, secret: "S", backupCodeHashes: ["h1"] });
    await del.call(adapter, user.id);
    assertEquals(await get.call(adapter, user.id), undefined);
    await del.call(adapter, user.id);
  },
  "setMfa / getMfa round-trip, and setMfa replaces": async (adapter) => {
    const get = adapter.getMfa;
    const set = adapter.setMfa;
    assert(get && set, "the MFA group is required by this contract");
    const user = await adapter.createUser({ email: "ada@x.test" });
    assertEquals(await get.call(adapter, user.id), undefined);
    await set.call(adapter, {
      userId: user.id,
      secret: "JBSWY3DPEHPK3PXP",
      backupCodeHashes: ["h1", "h2"],
    });
    const record = await get.call(adapter, user.id);
    assertEquals(record?.secret, "JBSWY3DPEHPK3PXP");
    assertEquals(record?.backupCodeHashes, ["h1", "h2"]);
    assertEquals(record?.confirmedAt, undefined);
    const confirmedAt = at(0);
    await set.call(adapter, {
      userId: user.id,
      secret: "NEWSECRET",
      backupCodeHashes: [],
      confirmedAt,
    });
    assertEquals((await get.call(adapter, user.id))?.secret, "NEWSECRET");
    assertEquals((await get.call(adapter, user.id))?.confirmedAt, confirmedAt);
  },
  "consumeBackupCode spends exactly one matching code": async (adapter) => {
    const set = adapter.setMfa;
    const get = adapter.getMfa;
    const consume = adapter.consumeBackupCode;
    assert(set && get && consume);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, {
      userId: user.id,
      secret: "S",
      backupCodeHashes: ["h1", "h2", "h3"],
    });
    const is = (want: string) => (hash: string) => hash === want;
    assertEquals(await consume.call(adapter, user.id, is("h2")), true);
    assertEquals((await get.call(adapter, user.id))?.backupCodeHashes, ["h1", "h3"]);
    assertEquals(await consume.call(adapter, user.id, is("h2")), false, "single use");
    assertEquals(await consume.call(adapter, user.id, is("nope")), false);
    assertEquals(await consume.call(adapter, "no-such-user", is("h1")), false);
  },
  "concurrent redemptions of one backup code yield exactly one success": async (adapter) => {
    const set = adapter.setMfa;
    const consume = adapter.consumeBackupCode;
    assert(set && consume);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, { userId: user.id, secret: "S", backupCodeHashes: ["h1"] });
    // An async comparison (a real one is scrypt) gives a non-atomic implementation the
    // window it needs to hand the same code to both callers.
    const slow = async (hash: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return hash === "h1";
    };
    const results = await Promise.all([
      consume.call(adapter, user.id, slow),
      consume.call(adapter, user.id, slow),
    ]);
    assertEquals(results.filter(Boolean).length, 1, "a backup code is single-use under a race");
  },
  "claimTotpStep refuses a replay and every older step": async (adapter) => {
    const set = adapter.setMfa;
    const claim = adapter.claimTotpStep;
    assert(set && claim);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, { userId: user.id, secret: "S", backupCodeHashes: [] });
    assertEquals(await claim.call(adapter, user.id, 100), true);
    assertEquals(await claim.call(adapter, user.id, 100), false, "the same step is a replay");
    assertEquals(await claim.call(adapter, user.id, 99), false, "an older step is spent too");
    assertEquals(await claim.call(adapter, user.id, 101), true, "the next step is fine");
    assertEquals(await claim.call(adapter, "no-such-user", 1), false);
  },
  "the stored step survives a getMfa": async (adapter) => {
    const set = adapter.setMfa;
    const get = adapter.getMfa;
    const claim = adapter.claimTotpStep;
    assert(set && get && claim);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await set.call(adapter, { userId: user.id, secret: "S", backupCodeHashes: [] });
    await claim.call(adapter, user.id, 7);
    assertEquals((await get.call(adapter, user.id))?.lastStep, 7);
  },
};

// ---- sessions + lifecycle --------------------------------------------------

const SESSION_CASES: Record<string, Case> = {
  "sessions: create → get → delete": async (adapter) => {
    const store = adapter.sessions;
    assert(store, "this contract expects an adapter that exposes `sessions`");
    await store.create("sid1", session("u1"));
    assertEquals((await store.get("sid1"))?.user.id, "u1");
    assertEquals(await store.get("nope"), undefined);
    await store.delete("sid1");
    assertEquals(await store.get("sid1"), undefined);
    await store.delete("sid1"); // unknown id: no-op, no throw
  },
  "sessions: deleteByUser removes that user's sessions only": async (adapter) => {
    const store = adapter.sessions;
    assert(store);
    await store.create("a1", session("alice"));
    await store.create("a2", session("alice"));
    await store.create("b1", session("bob"));
    await store.deleteByUser("alice");
    assertEquals(await store.get("a1"), undefined);
    assertEquals(await store.get("a2"), undefined);
    assertEquals((await store.get("b1"))?.user.id, "bob");
  },
  "sessions: an expired session reads as a miss, and an id can be replaced": async (adapter) => {
    const store = adapter.sessions;
    assert(store);
    await store.create("old", session("u", at(-1)));
    assertEquals(await store.get("old"), undefined);
    await store.create("x", session("first"));
    await store.create("x", session("second"));
    assertEquals((await store.get("x"))?.user.id, "second");
  },
};

const LIFECYCLE_CASES: Record<string, Case> = {
  "close() is idempotent": async (adapter) => {
    await adapter.createUser({ email: "ada@x.test" });
    await adapter.close?.();
    await adapter.close?.(); // and the runner closes it a third time
  },
  "updateUser refuses an unknown id": async (adapter) => {
    await assertRejects(async () => await adapter.updateUser({ id: "nope", name: "x" }));
  },
};

/** Run one group of cases, each against its own fresh (and afterwards closed) adapter. */
async function runCases(
  t: Deno.TestContext,
  make: () => AuthAdapter | Promise<AuthAdapter>,
  group: Record<string, Case>,
): Promise<void> {
  for (const [name, run] of Object.entries(group)) {
    await t.step(name, async () => {
      const adapter = await make();
      try {
        await run(adapter);
      } finally {
        await adapter.close?.();
      }
    });
  }
}

/**
 * Run the shared {@link ../../src/server/auth/adapter.ts | AuthAdapter} contract against
 * one implementation: users, accounts, verification tokens, credentials, API tokens, MFA
 * (including the consume-once guarantees), the `sessions` store, and `close()`.
 *
 * denext's own adapters implement every optional group, so a missing method fails the
 * suite rather than skipping the case.
 *
 * @param t The test context to register the steps on.
 * @param make Builds a FRESH, empty adapter — it is called once per case and the adapter
 * is closed afterwards, so a file-backed implementation must hand out a new database.
 * @returns A promise that resolves when every case has run.
 */
export async function adapterContract(
  t: Deno.TestContext,
  make: () => AuthAdapter | Promise<AuthAdapter>,
): Promise<void> {
  await runCases(t, make, USER_CASES);
  await runCases(t, make, ACCOUNT_CASES);
  await runCases(t, make, VERIFICATION_CASES);
  await runCases(t, make, CREDENTIAL_CASES);
  await runCases(t, make, API_TOKEN_CASES);
  await runCases(t, make, MFA_CASES);
  await runCases(t, make, SESSION_CASES);
  await runCases(t, make, LIFECYCLE_CASES);
}
