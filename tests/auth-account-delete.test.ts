// Account deletion (`POST {basePath}/account/delete`, Apple guideline 5.1.1(v)): the recent
// sign-in rule, the same-origin gate for the cookie caller, the native bearer caller, what is
// removed (the user and everything keyed by them, server-side sessions, native families),
// Sign in with Apple token revocation, `onAccountDeleted`, and `deleteUser` on both adapters.

import { assert, assertEquals } from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { issueApiToken } from "../src/server/auth/api-token.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { resolveNative, startNativeSession } from "../src/server/auth/native.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import { sqliteAuthAdapter } from "../src/server/auth/sqlite-adapter.ts";
import type { AccountDeletedPayload, AuthConfig } from "../src/server/auth/types.ts";
import { resolveCors } from "../src/server/cors.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "del@x.test";
const PASSWORD = "correct horse battery staple";
const SESSION_COOKIE = "__Host-denext_auth=";

interface Harness {
  config: AuthConfig;
  adapter: AuthAdapter;
  store: SessionStore;
  userId: string;
  deleted: AccountDeletedPayload[];
  revokes: URLSearchParams[];
}

async function setup(
  overrides: Partial<AuthConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
  revokeStatus = 200,
): Promise<Harness> {
  const user = await adapter.createUser({ email: EMAIL, emailVerified: 1 });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const store = inMemorySessionStore();
  const deleted: AccountDeletedPayload[] = [];
  const revokes: URLSearchParams[] = [];
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    sessionStore: store,
    rateLimit: false,
    native: {
      redirectUris: ["com.example.app://auth/callback"],
      apple: { clientIds: ["com.example.app"], clientSecret: () => "apple-secret-jwt" },
      fetch: (url, init) => {
        if (url === "https://appleid.apple.com/auth/revoke") {
          revokes.push(new URLSearchParams(init.body));
          return Promise.resolve(new Response(null, { status: revokeStatus }));
        }
        return Promise.resolve(new Response("", { status: 404 }));
      },
    },
    onAccountDeleted: (payload) => void deleted.push(payload),
    ...overrides,
  };
  return { config, adapter, store, userId: user.id, deleted, revokes };
}

interface Sent {
  res: Response | null;
  setCookies: string[];
}

async function send(
  h: Harness,
  path: string,
  init: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Sent> {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (init.cookie) headers.set("cookie", init.cookie);
  for (const [k, v] of Object.entries(init.headers ?? { origin: ORIGIN })) headers.set(k, v);
  const request = new Request(`${ORIGIN}/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? {}),
  });
  const ctx = createRequestContext(request);
  ctx.cors = resolveCors({ origins: ["capacitor://localhost"] });
  const res = await runWithContext(ctx, () => handleAuthRequest(request, h.config));
  return { res, setCookies: ctx.outgoingHeaders.getSetCookie() };
}

/** Password sign-in → the session cookie. */
async function signIn(h: Harness): Promise<string> {
  const { res, setCookies } = await send(h, "/callback/credentials", {
    body: { email: EMAIL, password: PASSWORD },
  });
  assertEquals(res?.status, 200);
  const cookie = setCookies.find((c) => c.startsWith(SESSION_COOKIE))?.split(";")[0];
  assert(cookie);
  return cookie;
}

/** Give the user an Apple account with a stored refresh token, an API token and a native family. */
async function populate(h: Harness): Promise<{ access: string }> {
  await h.adapter.linkAccount({
    userId: h.userId,
    provider: "apple",
    providerAccountId: "001.apple",
    type: "oidc",
    refreshToken: "apple-refresh-1",
  });
  await issueApiToken(h.config, { userId: h.userId, name: "ci" });
  const pair = await startNativeSession(h.config, resolveNative(h.config)!, {
    user: { id: h.userId, email: EMAIL },
    provider: "apple",
    amr: ["ext"],
    authTime: Math.floor(Date.now() / 1000),
  });
  return { access: pair.access_token };
}

Deno.test("cookie caller, fresh sign-in: the user and everything keyed by them are gone", async () => {
  const h = await setup();
  await populate(h);
  const cookie = await signIn(h);
  const { res, setCookies } = await send(h, "/account/delete", { cookie });
  assertEquals(res?.status, 200);
  assertEquals(await res!.json(), { ok: true });
  assertEquals(await h.adapter.getUser(h.userId), undefined);
  assertEquals(await h.adapter.getUserByEmail(EMAIL), undefined);
  assertEquals(await h.adapter.listAccounts!(h.userId), []);
  assertEquals(await h.adapter.getCredential!(h.userId), undefined);
  assertEquals(await h.adapter.listApiTokens!(h.userId), []);
  // The session cookie is cleared, and the server-side record is gone too.
  assert(
    setCookies.some((c) =>
      c.startsWith(SESSION_COOKIE) && (/max-age=0/i.test(c) || /expires=thu, 01 jan 1970/i.test(c))
    ),
    `the session cookie is cleared: ${setCookies.join(" | ")}`,
  );
  assertEquals((await send(h, "/account/delete", { cookie })).res?.status, 401);
  // Apple's token was revoked with the configured secret; the hook heard about it.
  assertEquals(h.revokes.length, 1);
  assertEquals(h.revokes[0].get("token"), "apple-refresh-1");
  assertEquals(h.revokes[0].get("token_type_hint"), "refresh_token");
  assertEquals(h.revokes[0].get("client_id"), "com.example.app");
  assertEquals(h.revokes[0].get("client_secret"), "apple-secret-jwt");
  assertEquals(h.deleted.length, 1);
  assertEquals(h.deleted[0].user.id, h.userId);
  assertEquals(h.deleted[0].appleRevoked, true);
});

Deno.test("a sign-in older than the freshness window must re-authenticate first", async () => {
  const h = await setup({ mfa: { freshness: 600 } });
  const cookie = await signIn(h);
  const realNow = Date.now;
  Date.now = () => realNow() + 601_000;
  try {
    const { res } = await send(h, "/account/delete", { cookie });
    assertEquals(res?.status, 403);
    assertEquals(await res!.json(), { error: "reauth_required" });
  } finally {
    Date.now = realNow;
  }
  assert(await h.adapter.getUser(h.userId), "nothing was deleted");
});

Deno.test("a cookie caller must be same-origin; no session is a 401", async () => {
  const h = await setup();
  const cookie = await signIn(h);
  for (const origin of ["https://evil.test", "capacitor://localhost", "null"]) {
    const { res } = await send(h, "/account/delete", { cookie, headers: { origin } });
    assertEquals(res?.status, 403, origin);
  }
  assertEquals((await send(h, "/account/delete", {})).res?.status, 401);
  assert(await h.adapter.getUser(h.userId));
});

Deno.test("native bearer caller: deletes, revokes the families, and answers with CORS", async () => {
  const h = await setup();
  const { access } = await populate(h);
  const { res } = await send(h, "/account/delete", {
    headers: { origin: "capacitor://localhost", authorization: `Bearer ${access}` },
  });
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assertEquals(await h.adapter.getUser(h.userId), undefined);
  // The same token is dead now.
  const again = await send(h, "/account/delete", {
    headers: { authorization: `Bearer ${access}` },
  });
  assertEquals(again.res?.status, 401);
  // A foreign origin with a (valid-looking) bearer is refused before anything else.
  const h2 = await setup();
  const other = await populate(h2);
  const evil = await send(h2, "/account/delete", {
    headers: { origin: "https://evil.test", authorization: `Bearer ${other.access}` },
  });
  assertEquals(evil.res?.status, 403);
  assert(await h2.adapter.getUser(h2.userId));
});

Deno.test("Apple refusing the revocation is reported (appleRevoked: false), deletion still happens", async () => {
  const h = await setup({}, inMemoryAuthAdapter(), 400);
  await populate(h);
  const cookie = await signIn(h);
  assertEquals((await send(h, "/account/delete", { cookie })).res?.status, 200);
  assertEquals(await h.adapter.getUser(h.userId), undefined);
  assertEquals(h.deleted[0].appleRevoked, false);
});

Deno.test("no Apple secret anywhere: nothing is sent to Apple, appleRevoked false", async () => {
  const h = await setup();
  h.config.native = { ...h.config.native!, apple: { clientIds: ["com.example.app"] } };
  await h.adapter.linkAccount({
    userId: h.userId,
    provider: "apple",
    providerAccountId: "001.apple",
    refreshToken: "t",
  });
  const cookie = await signIn(h);
  assertEquals((await send(h, "/account/delete", { cookie })).res?.status, 200);
  assertEquals(h.revokes.length, 0);
  assertEquals(h.deleted[0].appleRevoked, false);
});

Deno.test("a throwing onAccountDeleted is logged, the answer is still 200", async () => {
  const errors: string[] = [];
  const h = await setup({
    onAccountDeleted: () => {
      throw new Error("app cleanup failed");
    },
    logger: { error: (m) => void errors.push(m) },
  });
  const cookie = await signIn(h);
  assertEquals((await send(h, "/account/delete", { cookie })).res?.status, 200);
  assert(errors.some((m) => m.includes("onAccountDeleted")));
});

Deno.test("an adapter without deleteUser: the endpoint does not exist", async () => {
  const base = inMemoryAuthAdapter();
  const h = await setup({ native: undefined }, { ...base, deleteUser: undefined });
  const cookie = await signIn(h);
  assertEquals((await send(h, "/account/delete", { cookie })).res, null);
});

// ---- deleteUser on both adapters -----------------------------------------------------------

async function assertDeleteUserContract(adapter: AuthAdapter): Promise<void> {
  const victim = await adapter.createUser({ email: "v@x.test" });
  const bystander = await adapter.createUser({ email: "b@x.test" });
  for (const u of [victim, bystander]) {
    await adapter.linkAccount({ userId: u.id, provider: "google", providerAccountId: `g-${u.id}` });
    await adapter.setCredential!(u.id, "hash");
    await adapter.createApiToken!({
      id: `t-${u.id}`,
      userId: u.id,
      tokenHash: `h-${u.id}`,
      createdAt: 1,
    });
    await adapter.setMfa!({ userId: u.id, secret: "S", backupCodeHashes: [] });
    await adapter.createNativeSession!({
      id: `f-${u.id}`,
      userId: u.id,
      generation: 0,
      salt: "s",
      session: "{}",
      createdAt: 1,
      expiresAt: 4_000_000_000,
    });
  }
  await adapter.createVerificationToken!({
    identifier: "v@x.test",
    tokenHash: "vt",
    expires: 4_000_000_000,
    purpose: "reset",
  });
  await adapter.deleteUser!(victim.id);
  assertEquals(await adapter.getUser(victim.id), undefined);
  assertEquals(await adapter.getUserByEmail("v@x.test"), undefined);
  assertEquals(
    await adapter.getUserByAccount({ provider: "google", providerAccountId: `g-${victim.id}` }),
    undefined,
  );
  assertEquals(await adapter.listAccounts!(victim.id), []);
  assertEquals(await adapter.getCredential!(victim.id), undefined);
  assertEquals(await adapter.getApiTokenByHash!(`h-${victim.id}`), undefined);
  assertEquals(await adapter.getMfa!(victim.id), undefined);
  assertEquals(await adapter.getNativeSession!(`f-${victim.id}`), undefined);
  assertEquals(
    await adapter.useVerificationToken!({
      identifier: "v@x.test",
      tokenHash: "vt",
      purpose: "reset",
    }),
    undefined,
  );
  // The other user is untouched.
  assert(await adapter.getUser(bystander.id));
  assertEquals((await adapter.listAccounts!(bystander.id)).length, 1);
  assertEquals(await adapter.getCredential!(bystander.id), "hash");
  assert(await adapter.getApiTokenByHash!(`h-${bystander.id}`));
  assert(await adapter.getMfa!(bystander.id));
  assert(await adapter.getNativeSession!(`f-${bystander.id}`));
  // Deleting an unknown user is not an error.
  await adapter.deleteUser!("nobody");
}

Deno.test("inMemoryAuthAdapter.deleteUser removes the user and everything keyed by them", async () => {
  await assertDeleteUserContract(inMemoryAuthAdapter());
});

Deno.test("sqliteAuthAdapter.deleteUser removes the user and everything keyed by them", async () => {
  const adapter = sqliteAuthAdapter({ path: ":memory:" });
  try {
    await assertDeleteUserContract(adapter);
  } finally {
    await adapter.close?.();
  }
});
