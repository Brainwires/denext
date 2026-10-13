// The shared AuthAdapter contract suite. Every adapter denext ships — the in-memory one
// (tests/auth-adapter.test.ts) and the node:sqlite one (tests/auth-adapter-sqlite.test.ts)
// — runs exactly these cases, so "implements AuthAdapter" means one thing and a new
// adapter (yours, or a future first-party one) has a definition of done.
//
// Each case gets a FRESH adapter from `make()` and closes it afterwards, so a case can
// never see another's rows and a leaked database handle fails the suite rather than the
// next test.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type {
  AuthAdapter,
  VerificationTokenRecord,
  VerificationTokenRef,
} from "../../src/server/auth/adapter.ts";
import type { AuthSession } from "../../src/server/auth/types.ts";
import { OAUTH_SERVER_CASES } from "./auth-adapter-contract-oauth-server.ts";

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

/** The verification-token pair, bound to `adapter`. */
function tokenMethods(adapter: AuthAdapter) {
  const create = adapter.createVerificationToken;
  const use = adapter.useVerificationToken;
  assert(create && use);
  return {
    create: (record: VerificationTokenRecord) => create.call(adapter, record),
    use: (ref: VerificationTokenRef) => use.call(adapter, ref),
  };
}

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
  "a newer token for the same identifier and purpose replaces the older": async (adapter) => {
    const { create, use } = tokenMethods(adapter);
    await create(token());
    await create({ ...token(), tokenHash: "c".repeat(64) });
    assertEquals(await use(token()), undefined, "the older token is gone");
    assertEquals(
      (await use({ ...token(), tokenHash: "c".repeat(64) }))?.tokenHash,
      "c".repeat(64),
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
    assertEquals(await revoke.call(adapter, "t1"), true, "an actual revocation");
    assertEquals(await byHash.call(adapter, "hash-t1"), undefined);
    assertEquals((await list.call(adapter, user.id)).map((t) => t.id), ["t2"]);
    assertEquals(await revoke.call(adapter, "t1"), false, "already revoked");
    assertEquals(await revoke.call(adapter, "unknown"), false, "no-op, no throw");
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
  "replaceMfaSecret swaps only the secret, only while it is the expected one": async (adapter) => {
    const set = adapter.setMfa;
    const get = adapter.getMfa;
    const replace = adapter.replaceMfaSecret;
    const claim = adapter.claimTotpStep;
    assert(set && get && replace && claim, "both first-party adapters implement the swap");
    const user = await adapter.createUser({ email: "ada@x.test" });
    const confirmedAt = at(0);
    await set.call(adapter, {
      userId: user.id,
      secret: "OLD",
      backupCodeHashes: ["h1"],
      confirmedAt,
    });
    assertEquals(await claim.call(adapter, user.id, 7), true);
    assertEquals(await replace.call(adapter, user.id, "STALE", "NEW"), false, "a lost swap");
    assertEquals((await get.call(adapter, user.id))?.secret, "OLD");
    assertEquals(await replace.call(adapter, user.id, "OLD", "NEW"), true);
    assertEquals(await get.call(adapter, user.id), {
      userId: user.id,
      secret: "NEW",
      backupCodeHashes: ["h1"],
      confirmedAt,
      lastStep: 7,
    }, "the replay guard and the backup codes are left alone");
    assertEquals(await replace.call(adapter, "no-such-user", "OLD", "NEW"), false);
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

// ---- native app sessions + deletion ------------------------------------------

/** A native session family for `userId`, far from expiry. */
function family(id: string, userId: string) {
  return {
    id,
    userId,
    generation: 0,
    salt: "salt",
    session: "{}",
    createdAt: 1,
    expiresAt: 4_000_000_000,
  };
}

const NATIVE_CASES: Record<string, Case> = {
  "useNativeGrant consumes once, by kind, and fails closed on expiry": async (adapter) => {
    const create = adapter.createNativeGrant;
    const use = adapter.useNativeGrant;
    assert(create && use);
    await create.call(adapter, { hash: "h1", kind: "code", expiresAt: at(600), data: "d" });
    assertEquals(await use.call(adapter, "h1", "nonce"), undefined, "a code is not a nonce");
    assertEquals((await use.call(adapter, "h1", "code"))?.data, "d");
    assertEquals(await use.call(adapter, "h1", "code"), undefined, "single use");
    await create.call(adapter, { hash: "old", kind: "nonce", expiresAt: at(-1) });
    assertEquals(await use.call(adapter, "old", "nonce"), undefined, "expired → miss");
  },
  "concurrent redemptions of one grant yield exactly one record": async (adapter) => {
    const create = adapter.createNativeGrant;
    const use = adapter.useNativeGrant;
    assert(create && use);
    await create.call(adapter, { hash: "race", kind: "code", expiresAt: at(600) });
    const results = await Promise.all([
      use.call(adapter, "race", "code"),
      use.call(adapter, "race", "code"),
    ]);
    assertEquals(results.filter(Boolean).length, 1);
  },
  "rotateNativeSession is a compare-and-swap on the generation": async (adapter) => {
    const create = adapter.createNativeSession;
    const get = adapter.getNativeSession;
    const rotate = adapter.rotateNativeSession;
    const revoke = adapter.revokeNativeSession;
    assert(create && get && rotate && revoke);
    await create.call(adapter, family("f1", "u1"));
    const both = await Promise.all([
      rotate.call(adapter, "f1", 0, at(100)),
      rotate.call(adapter, "f1", 0, at(100)),
    ]);
    assertEquals(both.filter(Boolean).length, 1, "one rotation per generation");
    assertEquals((await get.call(adapter, "f1"))?.generation, 1);
    assertEquals(await rotate.call(adapter, "f1", 0, at(100)), false, "an old generation loses");
    await revoke.call(adapter, "f1");
    assert((await get.call(adapter, "f1"))?.revokedAt !== undefined);
    assertEquals(
      await rotate.call(adapter, "f1", 1, at(100)),
      false,
      "a revoked family never rotates",
    );
    await revoke.call(adapter, "unknown"); // no-op
  },
  "rotateNativeSession records rotatedAt": async (adapter) => {
    const create = adapter.createNativeSession;
    const get = adapter.getNativeSession;
    const rotate = adapter.rotateNativeSession;
    assert(create && get && rotate);
    await create.call(adapter, family("r1", "u1"));
    assertEquals((await get.call(adapter, "r1"))?.rotatedAt, undefined, "none before a rotation");
    const expiresAt = at(100); // once: a second `at(100)` could land on the next second
    assert(await rotate.call(adapter, "r1", 0, expiresAt, { rotatedAt: 50 }));
    let stored = await get.call(adapter, "r1");
    assertEquals([stored?.rotatedAt, stored?.expiresAt, stored?.createdAt], [50, expiresAt, 1]);
    assert(await rotate.call(adapter, "r1", 1, at(200), { rotatedAt: 70 }));
    stored = await get.call(adapter, "r1");
    assertEquals([stored?.rotatedAt, stored?.generation], [70, 2]);
    assertEquals(await rotate.call(adapter, "r1", 0, at(300), { rotatedAt: 90 }), false);
    assertEquals((await get.call(adapter, "r1"))?.rotatedAt, 70, "a lost swap writes nothing");
  },
  "revokeNativeSessionsByUser revokes that user's families only": async (adapter) => {
    const create = adapter.createNativeSession;
    const get = adapter.getNativeSession;
    const revokeAll = adapter.revokeNativeSessionsByUser;
    assert(create && get && revokeAll);
    await create.call(adapter, family("a1", "alice"));
    await create.call(adapter, family("a2", "alice"));
    await create.call(adapter, family("b1", "bob"));
    await revokeAll.call(adapter, "alice");
    assert((await get.call(adapter, "a1"))?.revokedAt !== undefined);
    assert((await get.call(adapter, "a2"))?.revokedAt !== undefined);
    assertEquals((await get.call(adapter, "b1"))?.revokedAt, undefined);
  },
  "deleteUser removes the user, their accounts and their families": async (adapter) => {
    const del = adapter.deleteUser;
    assert(del && adapter.createNativeSession && adapter.getNativeSession);
    const user = await adapter.createUser({ email: "ada@x.test" });
    await adapter.linkAccount({ userId: user.id, provider: "google", providerAccountId: "g1" });
    await adapter.createNativeSession(family("fd", user.id));
    await del.call(adapter, user.id);
    assertEquals(await adapter.getUser(user.id), undefined);
    assertEquals(await adapter.getUserByEmail("ada@x.test"), undefined);
    assertEquals(
      await adapter.getUserByAccount({ provider: "google", providerAccountId: "g1" }),
      undefined,
    );
    assertEquals(await adapter.getNativeSession("fd"), undefined);
    await del.call(adapter, user.id); // already gone: no throw
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

const PROFILE_CASES: Record<string, Case> = {
  "Supabase fields round-trip: phone, metadata, anonymous, timestamps, ban": async (adapter) => {
    const user = await adapter.createUser({
      phone: "+15555550100",
      phoneVerified: at(-10),
      userMetadata: { name: "Ada", nested: { a: [1, 2] } },
      appMetadata: { provider: "phone", providers: ["phone"] },
      isAnonymous: true,
      updatedAt: at(-5),
      lastSignInAt: at(-1),
      bannedUntil: at(3600),
    });
    const read = await adapter.getUser(user.id);
    assertEquals(read?.phone, "+15555550100");
    assertEquals(read?.phoneVerified, at(-10));
    assertEquals(read?.userMetadata, { name: "Ada", nested: { a: [1, 2] } });
    assertEquals(read?.appMetadata, { provider: "phone", providers: ["phone"] });
    assertEquals(read?.isAnonymous, true);
    assertEquals(read?.lastSignInAt, at(-1));
    assertEquals(read?.bannedUntil, at(3600));
    assert(typeof read?.createdAt === "number", "createdAt is stamped");
    assertEquals((await adapter.getUserByPhone!("+15555550100"))?.id, user.id);
    assertEquals(await adapter.getUserByPhone!("+15555550199"), undefined);
    const plain = await adapter.createUser({ email: "plain@x.test" });
    assertEquals((await adapter.getUser(plain.id))?.isAnonymous, undefined, "false reads absent");
    const promoted = await adapter.updateUser({ id: user.id, isAnonymous: false });
    assert(!promoted.isAnonymous);
    assert(!(await adapter.getUser(user.id))?.isAnonymous);
  },
  "listUsers pages oldest first and counts every user": async (adapter) => {
    for (let i = 0; i < 5; i++) await adapter.createUser({ email: `u${i}@x.test` });
    const page1 = await adapter.listUsers!({ page: 1, perPage: 2 });
    assertEquals(page1.total, 5);
    assertEquals(page1.users.length, 2);
    const page3 = await adapter.listUsers!({ page: 3, perPage: 2 });
    assertEquals(page3.users.length, 1);
    const ids = new Set([
      ...page1.users,
      ...(await adapter.listUsers!({ page: 2, perPage: 2 })).users,
      ...page3.users,
    ].map((u) => u.id));
    assertEquals(ids.size, 5);
  },
  "identity fields round-trip on linked accounts": async (adapter) => {
    const user = await adapter.createUser({ email: "id@x.test" });
    await adapter.linkAccount({
      userId: user.id,
      provider: "github",
      providerAccountId: "42",
      identityId: "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a0001",
      identityData: { sub: "42", login: "ada" },
      email: "id@x.test",
      updatedAt: at(-2),
      lastSignInAt: at(-1),
    });
    const [account] = await adapter.listAccounts!(user.id);
    assertEquals(account.identityId, "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a0001");
    assertEquals(account.identityData, { sub: "42", login: "ada" });
    assertEquals(account.email, "id@x.test");
    assertEquals(account.lastSignInAt, at(-1));
    assert(typeof account.createdAt === "number", "createdAt is stamped");
  },
  "MFA factors: create, list, update, claim a step once, delete": async (adapter) => {
    const user = await adapter.createUser({ email: "f@x.test" });
    await adapter.createMfaFactor!({
      id: "f1",
      userId: user.id,
      type: "totp",
      status: "unverified",
      friendlyName: "app",
      secret: "sealed",
      createdAt: at(-10),
      updatedAt: at(-10),
    });
    await adapter.createMfaFactor!({
      id: "f2",
      userId: user.id,
      type: "phone",
      status: "unverified",
      phone: "+15555550100",
      createdAt: at(-5),
      updatedAt: at(-5),
    });
    const listed = await adapter.listMfaFactors!(user.id);
    assertEquals(listed.map((f) => f.id), ["f1", "f2"]);
    assertEquals(listed[0].secret, "sealed");
    assertEquals(listed[1].phone, "+15555550100");
    await adapter.updateMfaFactor!("f1", { status: "verified", lastChallengedAt: at(-1) });
    await adapter.updateMfaFactor!("f1", {});
    const [f1] = await adapter.listMfaFactors!(user.id);
    assertEquals(f1.status, "verified");
    assertEquals(f1.lastChallengedAt, at(-1));
    assertEquals(f1.friendlyName, "app");
    assertEquals(await adapter.claimMfaFactorStep!("f1", 100), true);
    assertEquals(await adapter.claimMfaFactorStep!("f1", 100), false);
    assertEquals(await adapter.claimMfaFactorStep!("f1", 99), false);
    assertEquals(await adapter.claimMfaFactorStep!("f1", 101), true);
    assertEquals(await adapter.claimMfaFactorStep!("nope", 1), false);
    await adapter.deleteMfaFactor!("f2");
    await adapter.deleteMfaFactor!("nope");
    assertEquals((await adapter.listMfaFactors!(user.id)).map((f) => f.id), ["f1"]);
    await adapter.deleteUser!(user.id);
    assertEquals(await adapter.listMfaFactors!(user.id), []);
  },
  "revokeNativeSessionsByUser can keep one family": async (adapter) => {
    const family = (id: string) => ({
      id,
      userId: "u1",
      generation: 0,
      salt: "s",
      session: "{}",
      createdAt: at(0),
      expiresAt: at(3600),
    });
    await adapter.createNativeSession!(family("keep"));
    await adapter.createNativeSession!(family("drop"));
    await adapter.revokeNativeSessionsByUser!("u1", "keep");
    assertEquals((await adapter.getNativeSession!("keep"))?.revokedAt, undefined);
    assert((await adapter.getNativeSession!("drop"))?.revokedAt !== undefined);
  },
};

/** A stored SAML provider record. */
const ssoProvider = (id: string, entityId: string, domains: string[]) => ({
  id,
  entityId,
  metadataXml: `<md:EntityDescriptor entityID="${entityId}"/>`,
  domains,
  createdAt: at(-10),
  updatedAt: at(-10),
});

const SSO_CASES: Record<string, Case> = {
  "SSO providers: create, read by id / entity id / domain, list, update, delete": async (
    adapter,
  ) => {
    const a = {
      ...ssoProvider("p1", "https://idp-a", ["a.test", "b.test"]),
      metadataUrl: "https://idp-a/metadata",
      attributeMapping: { keys: { email: { name: "mail" }, groups: { name: "g", array: true } } },
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    };
    assertEquals(await adapter.createSsoProvider!(a), "ok");
    assertEquals(await adapter.createSsoProvider!(ssoProvider("p2", "https://idp-b", [])), "ok");
    assertEquals(await adapter.getSsoProvider!("p1"), a);
    assertEquals((await adapter.getSsoProviderByEntityId!("https://idp-b"))?.id, "p2");
    assertEquals((await adapter.getSsoProviderByDomain!("b.test"))?.id, "p1");
    assertEquals(await adapter.getSsoProviderByDomain!("c.test"), undefined);
    assertEquals(await adapter.getSsoProvider!("nope"), undefined);
    assertEquals((await adapter.listSsoProviders!()).map((p) => p.id), ["p1", "p2"]);
    const moved = { ...a, domains: ["c.test"], updatedAt: at(0) };
    assertEquals(await adapter.updateSsoProvider!(moved), "ok");
    assertEquals(await adapter.getSsoProviderByDomain!("a.test"), undefined);
    assertEquals((await adapter.getSsoProvider!("p1"))?.domains, ["c.test"]);
    assertEquals(
      await adapter.updateSsoProvider!(ssoProvider("nope", "https://x", [])),
      "not_found",
    );
    assertEquals(await adapter.deleteSsoProvider!("p1"), true);
    assertEquals(await adapter.deleteSsoProvider!("p1"), false);
    assertEquals(await adapter.getSsoProviderByDomain!("c.test"), undefined);
    assertEquals((await adapter.listSsoProviders!()).map((p) => p.id), ["p2"]);
  },
  "SSO providers: entity ids and domains are unique across providers": async (adapter) => {
    assertEquals(
      await adapter.createSsoProvider!(ssoProvider("p1", "https://idp", ["a.test"])),
      "ok",
    );
    assertEquals(
      await adapter.createSsoProvider!(ssoProvider("p2", "https://idp", ["z.test"])),
      "entity_id_exists",
    );
    assertEquals(
      await adapter.createSsoProvider!(ssoProvider("p3", "https://other", ["z.test", "a.test"])),
      "domain_exists",
    );
    // Nothing of a refused create is stored.
    assertEquals(await adapter.getSsoProviderByDomain!("z.test"), undefined);
    assertEquals(await adapter.createSsoProvider!(ssoProvider("p4", "https://four", [])), "ok");
    assertEquals(
      await adapter.updateSsoProvider!(ssoProvider("p4", "https://idp", [])),
      "entity_id_exists",
    );
    assertEquals(
      await adapter.updateSsoProvider!(ssoProvider("p4", "https://four", ["a.test"])),
      "domain_exists",
    );
    assertEquals((await adapter.getSsoProvider!("p4"))?.domains, []);
    // A provider keeps (and re-saves) its own domains.
    assertEquals(
      await adapter.updateSsoProvider!(ssoProvider("p1", "https://idp", ["a.test", "b.test"])),
      "ok",
    );
  },
  "SSO sessions: recorded, listed by NameID, dropped with the provider and the user": async (
    adapter,
  ) => {
    await adapter.createSsoProvider!(ssoProvider("p1", "https://idp", []));
    const user = await adapter.createUser({ email: "s@x.test" });
    const record = (sessionId: string, nameId: string, expiresAt = at(3600)) => ({
      sessionId,
      providerId: "p1",
      nameId,
      sessionIndex: `_${sessionId}`,
      userId: user.id,
      expiresAt,
    });
    await adapter.createSsoSession!(record("f1", "alice"));
    await adapter.createSsoSession!(record("f2", "alice"));
    await adapter.createSsoSession!(record("f3", "bob"));
    await adapter.createSsoSession!(record("f4", "alice", at(-1)));
    const alice = await adapter.listSsoSessions!("p1", "alice");
    assertEquals(alice.map((s) => s.sessionId).sort(), ["f1", "f2"]);
    assertEquals(alice.find((s) => s.sessionId === "f1"), record("f1", "alice"));
    assertEquals(await adapter.listSsoSessions!("p2", "alice"), []);
    await adapter.deleteUser!(user.id);
    assertEquals(await adapter.listSsoSessions!("p1", "alice"), []);
    await adapter.createSsoSession!(record("f5", "carol"));
    await adapter.deleteSsoProvider!("p1");
    assertEquals(await adapter.listSsoSessions!("p1", "carol"), []);
  },
  "claimSamlMessageId claims an id once until it expires": async (adapter) => {
    assertEquals(await adapter.claimSamlMessageId!("m1", at(60)), true);
    assertEquals(await adapter.claimSamlMessageId!("m1", at(60)), false);
    assertEquals(await adapter.claimSamlMessageId!("m2", at(60)), true);
    assertEquals(await adapter.claimSamlMessageId!("old", at(-5)), true);
    // An expired claim is reclaimed by the next write, so the id can be claimed again.
    assertEquals(await adapter.claimSamlMessageId!("m3", at(60)), true);
    assertEquals(await adapter.claimSamlMessageId!("old", at(60)), true);
    assertEquals(await adapter.claimSamlMessageId!("m1", at(60)), false);
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
 * (including the consume-once guarantees), native app sessions + `deleteUser`, SAML SSO
 * providers / sessions / message ids, the `sessions` store, and `close()`.
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
  await runCases(t, make, NATIVE_CASES);
  await runCases(t, make, SESSION_CASES);
  await runCases(t, make, PROFILE_CASES);
  await runCases(t, make, SSO_CASES);
  await runCases(t, make, LIFECYCLE_CASES);
  await runCases(t, make, OAUTH_SERVER_CASES);
}
