// `next-auth/providers/passkey` on denext's passkeys: listing it turns `passkeys` on (its relying
// party and user verification mapped), the provider lists as `type: "webauthn"`, and — driven by
// a software authenticator through the `NextAuth()` handlers — a signed-in user registers a
// passkey, signs out, and signs back in with it, its credential stored as Auth.js's own
// `Authenticator` row (and `webauthn` account) through an Auth.js adapter.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import NextAuth from "../src/compat/next-auth/index.ts";
import { fromAuthJsAdapter } from "../src/compat/next-auth/adapter.ts";
import { translateConfig } from "../src/compat/next-auth/config.ts";
import Credentials from "../src/compat/next-auth/providers/credentials.ts";
import Passkey from "../src/compat/next-auth/providers/passkey.ts";
import WebAuthn from "../src/compat/next-auth/providers/webauthn.ts";
import type { AuthJsAdapter, AuthJsAdapterAuthenticator } from "../src/compat/next-auth/adapter.ts";
import type { NextAuthConfig } from "../src/compat/next-auth/types.ts";
import { type CallInit, inRequest, Jar, request } from "./helpers/next-auth-harness.ts";
import { Authenticator } from "./helpers/soft-authenticator.ts";
import type { AuthPasskeyConfig } from "../src/server/auth/types.ts";
import {
  type CacheStore,
  getCacheStore,
  inMemoryCacheStore,
  setCacheStore,
} from "../src/server/cache.ts";
import { sqliteCacheStore } from "../src/server/sqlite-cache.ts";

const SECRET = "next-auth-passkey-test-secret-32-chars-plus";

/** An Auth.js adapter in memory, with the authenticator methods. */
function authJsAdapter() {
  const users = new Map<string, Record<string, unknown> & { id: string }>();
  const accounts = new Map<string, Record<string, unknown>>();
  const authenticators = new Map<string, AuthJsAdapterAuthenticator>();
  // A verified address: denext registers passkeys only for an account whose mailbox is proven.
  users.set("u-ada", {
    id: "u-ada",
    email: "ada@example.com",
    name: "Ada",
    emailVerified: new Date(),
  });
  const adapter: AuthJsAdapter = {
    createUser: (u) => (users.set(u.id, { ...u }), u),
    getUser: (id) => (users.get(id) as never) ?? null,
    getUserByEmail: (email) =>
      ([...users.values()].find((u) => u.email === email) as never) ?? null,
    getUserByAccount: (ref) => {
      const acc = accounts.get(`${ref.provider}:${ref.providerAccountId}`);
      return acc ? (users.get(String(acc.userId)) as never) ?? null : null;
    },
    updateUser: (patch) => {
      const row = { ...users.get(patch.id)!, ...patch };
      users.set(row.id, row);
      return row as never;
    },
    linkAccount: (account) =>
      void accounts.set(`${account.provider}:${account.providerAccountId}`, {
        ...account,
      }),
    getAuthenticator: (id) => authenticators.get(id) ?? null,
    createAuthenticator: (a) => {
      if (authenticators.has(a.credentialID)) throw new Error("unique constraint");
      authenticators.set(a.credentialID, { ...a });
      return a;
    },
    listAuthenticatorsByUserId: (userId) =>
      [...authenticators.values()].filter((a) => a.userId === userId),
    updateAuthenticatorCounter: (id, counter) => {
      const row = { ...authenticators.get(id)!, counter };
      authenticators.set(id, row);
      return row;
    },
  };
  return { adapter, users, accounts, authenticators };
}

/** A NextAuth app with Credentials and Passkey, and a browser talking to its handlers. */
function app(config: Partial<NextAuthConfig> = {}) {
  const store = authJsAdapter();
  const result = NextAuth({
    secret: SECRET,
    adapter: store.adapter,
    session: { strategy: "jwt" },
    providers: [
      Credentials({
        credentials: { email: {}, password: {} },
        authorize: (c) =>
          c.email === "ada@example.com" && c.password === "pw"
            ? { id: "u-ada", name: "Ada", email: "ada@example.com" }
            : null,
      }),
      Passkey({ relayingParty: { id: "app.test", name: "App" } }),
    ],
    ...config,
  });
  const jar = new Jar();
  let ceremonyId: string | undefined;
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, init);
    const handler = req.method === "GET" ? result.handlers.GET : result.handlers.POST;
    const { value, error } = await inRequest(req, jar, () => handler(req));
    if (error) throw error;
    jar.take(value!.headers);
    return value!;
  };
  /** A passkey endpoint, as `denext/client`'s calls make it (the ceremony id carried along). */
  const passkey = async (path: string, body: Record<string, unknown> = {}) => {
    const verifying = !path.endsWith("/options");
    const res = await call(`/api/auth/passkey/${path}`, {
      json: verifying ? { ceremonyId, ...body } : body,
      headers: { accept: "application/json" },
    });
    if (!verifying && res.ok) ceremonyId = (await res.clone().json()).ceremonyId;
    return res;
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  const session = async () => await (await call("/api/auth/session")).json();
  return { result, store, jar, call, passkey, csrf, session };
}

Deno.test("next-auth passkey: the provider turns denext's passkeys on, with its settings", () => {
  const env = (name: string) => name === "AUTH_URL" ? "https://app.test/api/auth" : undefined;
  const plain = translateConfig({ secret: SECRET, providers: [Passkey] }, env);
  assertEquals(plain.denext.passkeys, { userVerification: "required" });
  assertEquals(plain.denext.canonicalOrigin, "https://app.test", "the relying party's origin");
  assertEquals(plain.denext.providers, [], "a WebAuthn provider is no denext provider");
  assertEquals(plain.providers[0].type, "webauthn");
  const tuned = translateConfig({
    secret: SECRET,
    providers: [
      WebAuthn({
        relayingParty: { id: ["example.com"], name: "Example", origin: "https://example.com" },
        authenticationOptions: { timeout: 120_000 },
      }),
    ],
  }, () => undefined);
  assertEquals(tuned.denext.passkeys, {
    rpId: "example.com",
    rpName: "Example",
    origins: ["https://example.com"],
    userVerification: "preferred",
    timeout: 120,
  });
  assertEquals(tuned.providers[0].id, "webauthn");
  const asked = translateConfig({
    secret: SECRET,
    providers: [WebAuthn({ authenticationOptions: { userVerification: "required" } })],
  }, env);
  assertEquals(asked.denext.passkeys, { userVerification: "required" });
  // An RP ID alone: its own https origin (never the request's).
  const rpOnly = translateConfig({
    secret: SECRET,
    providers: [Passkey({ relayingParty: { id: "example.com" } })],
  }, () => undefined);
  assertEquals((rpOnly.denext.passkeys as AuthPasskeyConfig).origins, ["https://example.com"]);
  // Neither AUTH_URL nor a relying party: refused, rather than trusting the Host header.
  assertThrows(
    () => translateConfig({ secret: SECRET, providers: [Passkey] }, () => undefined),
    TypeError,
    "AUTH_URL",
  );
});

Deno.test("next-auth passkey: listed as webauthn, and not a form on the built-in page", async () => {
  const a = app();
  const providers = await (await a.call("/api/auth/providers")).json();
  assertEquals(providers.passkey.type, "webauthn");
  const page = await (await a.call("/api/auth/signin")).text();
  assert(page.includes("/api/auth/callback/credentials"));
  assert(!page.includes("/signin/passkey"), "no plain form for a WebAuthn provider");
});

Deno.test("next-auth passkey: register, sign out, sign back in with the passkey", async () => {
  const a = app();
  const auth = await Authenticator.create();
  // Sign in with the password, then register a passkey (a recent sign-in).
  await a.call("/api/auth/callback/credentials", {
    form: { csrfToken: await a.csrf(), email: "ada@example.com", password: "pw" },
  });
  assertEquals((await a.session()).user.email, "ada@example.com");
  const options = await (await a.passkey("register/options")).json();
  assertEquals(options.authenticatorSelection.userVerification, "required");
  const registered = await a.passkey("register", { credential: await auth.register(options) });
  assertEquals(registered.status, 200, await registered.clone().text());
  // Stored as Auth.js stores it: standard base64, a `webauthn` account per credential.
  const row = [...a.store.authenticators.values()][0];
  assertEquals(row.credentialID, btoa(String.fromCharCode(...auth.credentialId)));
  assertEquals(row.userId, "u-ada");
  assertEquals(row.counter, 0);
  assertEquals(row.transports, "internal");
  assertEquals(a.store.accounts.get(`passkey:${row.credentialID}`)?.type, "webauthn");
  // Sign out, then back in with the passkey alone.
  await a.call("/api/auth/signout", { form: { csrfToken: await a.csrf() } });
  assertEquals(await a.session(), null);
  const signIn = await (await a.passkey("authenticate/options")).json();
  const res = await a.passkey("authenticate", { credential: await auth.assert(signIn) });
  assertEquals(res.status, 200, await res.clone().text());
  const session = await a.session();
  assertEquals(session.user.email, "ada@example.com");
  assertEquals(session.user.name, "Ada");
  assertEquals([...a.store.authenticators.values()][0].counter, 1, "the counter moved");
});

Deno.test("next-auth passkey: registering needs a session", async () => {
  const a = app();
  assertEquals((await a.passkey("register/options")).status, 401);
});

Deno.test("next-auth adapter bridge: the passkey group on Auth.js's authenticators", async () => {
  const { adapter, authenticators } = authJsAdapter();
  const bridged = fromAuthJsAdapter(adapter, {
    credentialsProviders: new Set(),
    warn: () => {},
    webAuthnProvider: "passkey",
  });
  const auth = await Authenticator.create();
  const record = {
    id: auth.id,
    userId: "u-ada",
    publicKey: btoa(String.fromCharCode(...auth.cose)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, ""),
    alg: -7,
    signCount: 3,
    backupEligible: true,
    backedUp: true,
    transports: ["hybrid", "internal"],
    createdAt: 1,
  };
  assertEquals(await bridged.createPasskey!(record), true);
  assertEquals(await bridged.createPasskey!(record), false, "a credential ID is unique");
  const stored = (await bridged.getPasskey!(auth.id))!;
  assertEquals(stored.alg, -7, "read back off the COSE key");
  assertEquals(stored.backupEligible, true);
  assertEquals(stored.transports, ["hybrid", "internal"]);
  assertEquals((await bridged.listPasskeys!("u-ada")).length, 1);
  // A compare-and-swap on the counter.
  assertEquals(
    await bridged.updatePasskey!(auth.id, 2, { signCount: 4, backedUp: true, lastUsedAt: 1 }),
    false,
  );
  assertEquals(
    await bridged.updatePasskey!(auth.id, 3, { signCount: 4, backedUp: true, lastUsedAt: 1 }),
    true,
  );
  assertEquals([...authenticators.values()][0].counter, 4);
  // Two assertions racing on one counter (a cloned authenticator): only one moves it, though
  // Auth.js's port has no compare-and-swap (the read, check and write are serialized here).
  const raced = await Promise.all([
    bridged.updatePasskey!(auth.id, 4, { signCount: 5, backedUp: true, lastUsedAt: 2 }),
    bridged.updatePasskey!(auth.id, 4, { signCount: 5, backedUp: true, lastUsedAt: 2 }),
  ]);
  assertEquals(raced.filter(Boolean).length, 1, JSON.stringify(raced));
  assertEquals([...authenticators.values()][0].counter, 5);
  // Auth.js's adapters can't delete an authenticator.
  await assertRejects(
    () => Promise.resolve(bridged.deletePasskey!(auth.id)),
    Error,
    "deleteAuthenticator",
  );
  // Challenges: single-use, and an expired one is gone.
  const now = Math.floor(Date.now() / 1000);
  await bridged.createPasskeyChallenge!({ hash: "h1", expiresAt: now + 60, data: "d" });
  await bridged.createPasskeyChallenge!({ hash: "h2", expiresAt: now - 1, data: "d" });
  assertEquals((await bridged.usePasskeyChallenge!("h1"))?.data, "d");
  assertEquals(await bridged.usePasskeyChallenge!("h1"), undefined);
  assertEquals(await bridged.usePasskeyChallenge!("h2"), undefined);
  // Without a WebAuthn provider, the bridge offers no passkey group.
  const none = fromAuthJsAdapter(adapter, { credentialsProviders: new Set(), warn: () => {} });
  assertEquals(none.createPasskey, undefined);
});

/** Two "instances": separate bridges over one Auth.js adapter, each with its own cache handle. */
function instances(store: () => CacheStore, other: () => CacheStore = store) {
  const { adapter } = authJsAdapter();
  const bridge = (challengeStore: () => CacheStore) =>
    fromAuthJsAdapter(adapter, {
      credentialsProviders: new Set(),
      warn: () => {},
      webAuthnProvider: "passkey",
      challengeStore,
    });
  return [bridge(store), bridge(other)] as const;
}

Deno.test("next-auth adapter bridge: a passkey challenge in a shared cache store", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-passkey-challenge-" });
  // Two handles on one SQLite file stand in for two instances sharing a store.
  const a = sqliteCacheStore({ path: `${dir}/cache.db` });
  const b = sqliteCacheStore({ path: `${dir}/cache.db` });
  try {
    const [one, two] = instances(() => a, () => b);
    const now = Math.floor(Date.now() / 1000);
    await one.createPasskeyChallenge!({ hash: "h1", expiresAt: now + 60, data: "d1" });
    // Begun on one instance, finished on the other — no sticky session needed.
    assertEquals((await two.usePasskeyChallenge!("h1"))?.data, "d1");
    assertEquals(await one.usePasskeyChallenge!("h1"), undefined, "single use, across instances");
    // Racing redemptions of one challenge: exactly one wins.
    await one.createPasskeyChallenge!({ hash: "h2", expiresAt: now + 60, data: "d2" });
    const raced = await Promise.all([
      one.usePasskeyChallenge!("h2"),
      two.usePasskeyChallenge!("h2"),
      one.usePasskeyChallenge!("h2"),
    ]);
    assertEquals(raced.filter(Boolean).length, 1);
    // Expired, and capped at 15 minutes whatever the ceremony asked for.
    await one.createPasskeyChallenge!({ hash: "h3", expiresAt: now - 1, data: "d3" });
    assertEquals(await two.usePasskeyChallenge!("h3"), undefined);
    await one.createPasskeyChallenge!({ hash: "h4", expiresAt: now + 86_400, data: "d4" });
    const capped = (await a.getData("denext:passkey-challenge:h4"))!;
    assert(capped.expiresAt <= (now + 15 * 60) * 1000);
    assertEquals(capped.tags, [], "no tag a revalidation could reach");
    // Something else under the key, or a record for another hash, is not a challenge.
    await a.setData("denext:passkey-challenge:h5", {
      value: { x: 1 },
      expiresAt: Infinity,
      tags: [],
    });
    assertEquals(await two.usePasskeyChallenge!("h5"), undefined);
    await a.setData("denext:passkey-challenge:h6", {
      value: { hash: "other", data: "d", expiresAt: now + 60 },
      expiresAt: Infinity,
      tags: [],
    });
    assertEquals(await two.usePasskeyChallenge!("h6"), undefined);
  } finally {
    a.close();
    b.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-auth adapter bridge: the app's cache store by default; memory without takeData", async () => {
  const previous = getCacheStore();
  const dir = await Deno.makeTempDir({ prefix: "dnx-passkey-default-" });
  const shared = sqliteCacheStore({ path: `${dir}/cache.db` });
  try {
    const { adapter } = authJsAdapter();
    const bridge = () =>
      fromAuthJsAdapter(adapter, {
        credentialsProviders: new Set(),
        warn: () => {},
        webAuthnProvider: "passkey",
      });
    const now = Math.floor(Date.now() / 1000);
    setCacheStore(shared);
    const [one, two] = [bridge(), bridge()];
    await one.createPasskeyChallenge!({ hash: "s1", expiresAt: now + 60, data: "d" });
    assertEquals((await two.usePasskeyChallenge!("s1"))?.data, "d", "through the app's store");
    // The in-memory cache store has no takeData: each instance keeps its own challenges.
    setCacheStore(inMemoryCacheStore());
    const [three, four] = [bridge(), bridge()];
    await three.createPasskeyChallenge!({ hash: "m1", expiresAt: now + 60, data: "d" });
    assertEquals(await four.usePasskeyChallenge!("m1"), undefined, "another instance's memory");
    assertEquals((await three.usePasskeyChallenge!("m1"))?.data, "d");
  } finally {
    setCacheStore(previous);
    shared.close();
    await Deno.remove(dir, { recursive: true });
  }
});
