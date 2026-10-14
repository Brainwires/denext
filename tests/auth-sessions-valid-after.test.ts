// A per-user `sessionsValidAfter` ends cookie sessions early — stateless ones included, which
// nothing else can reach: `readAuthSession` refuses a session that signed in (`authTime`, else
// its issue time) before it. It is stamped by `revokeAllSessions(userId)`, a password reset, the
// pre-account-hijacking eviction, an `/auth/v1` ban, password change (by the user or an admin)
// and deletion, and denextAuth's own account deletion. A session signed in after the stamp —
// the reset's own sign-in, say — is unaffected. Each case signs in two minutes "ago" (the stamp
// is to the second) and fails without the stamp.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { AdapterUser, AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { markVerified, resetPassword } from "../src/server/auth/email.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { inMemorySessionStore } from "../src/server/auth/session-store.ts";
import { endedByUser, endUserSessions, readAuthSession } from "../src/server/auth/session.ts";
import { denextAuth, revokeAllSessions } from "../src/server/auth/mod.ts";
import { issueVerificationToken } from "../src/server/auth/verification.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

const PASSWORD = "the first password";
const SESSION_COOKIE = /^__Host-denext_auth=[^;]/;

/** Run `fn` with the clock `offsetMs` away from now. */
async function shifted<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  authConfig: Partial<AuthConfig> = {},
  adapter: AuthAdapter = inMemoryAuthAdapter(),
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter,
    authConfig: { providers: [credentials()], ...authConfig },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** A confirmed user with a password, created through the adapter. */
async function passwordUser(app: SupabaseAuthApp, email: string): Promise<string> {
  const adapter = app.config.adapter!;
  const user = await adapter.createUser({ email, emailVerified: Math.floor(Date.now() / 1000) });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  return user.id;
}

/** A credentials sign-in two minutes ago (unless `agoMs` says otherwise); the cookie pair. */
function signIn(app: SupabaseAuthApp, email: string, agoMs = 120_000): Promise<string> {
  return shifted(-agoMs, async () => {
    const res = await app.fetch(`${ORIGIN}/auth/callback/credentials`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    await res.body?.cancel();
    const pair = res.headers.getSetCookie().find((c) => SESSION_COOKIE.test(c));
    assert(pair, `a session cookie (${res.status})`);
    return pair.split(";")[0];
  });
}

/** Read the cookie's session in a request of its own. */
function read(app: SupabaseAuthApp, cookie: string): Promise<AuthSession | null> {
  const ctx = createRequestContext(new Request(`${ORIGIN}/`, { headers: { cookie } }));
  return runWithContext(ctx, () => readAuthSession(app.config));
}

/** A `/auth/v1` call. */
async function api(
  app: SupabaseAuthApp,
  path: string,
  init: { method?: string; body?: unknown; token?: string; key?: string } = {},
) {
  const headers: Record<string, string> = { apikey: init.key ?? app.publishableKey };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(`${ORIGIN}/auth/v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

// ---- the rule -------------------------------------------------------------------------------

Deno.test("endedByUser: a session that signed in before sessionsValidAfter is ended, to the second", () => {
  const user: AdapterUser = { id: "u", sessionsValidAfter: 1_000 };
  const session = (authTime?: number, issuedAt?: number): AuthSession => ({
    user: { id: "u" },
    provider: "credentials",
    expiresAt: 9_999,
    ...(authTime !== undefined ? { authTime } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  });
  assert(endedByUser(user, session(999)));
  assert(!endedByUser(user, session(1_000)), "signed in that very second: kept");
  assert(!endedByUser(user, session(1_001)));
  assert(endedByUser(user, session(undefined, 999)), "no authTime: the issue time decides");
  assert(!endedByUser(user, session(undefined, 1_000)));
  assert(!endedByUser({ id: "u" }, session(1)), "no stamp: nothing ended");
});

Deno.test("endUserSessions: stamps now, never moves the stamp back, skips a missing user", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: "a@x.test" });
  await endUserSessions(adapter, user.id, 2_000);
  await endUserSessions(adapter, user.id, 1_500);
  assertEquals((await adapter.getUser(user.id))?.sessionsValidAfter, 2_000);
  await endUserSessions(adapter, "nobody", 3_000); // no throw
});

// ---- revokeAllSessions -----------------------------------------------------------------------------

Deno.test("revokeAllSessions(userId) ends a stateless cookie session; a later sign-in works", async () => {
  await withApp(async (app) => {
    const id = await passwordUser(app, "ada@example.test");
    const other = await passwordUser(app, "bob@example.test");
    const cookie = await signIn(app, "ada@example.test");
    const bobs = await signIn(app, "bob@example.test");
    assert(await read(app, cookie), "live before");
    await revokeAllSessions(id);
    assertEquals(await read(app, cookie), null, "the stateless cookie is ended");
    assert(await read(app, bobs), "another user's session stands");
    const fresh = await signIn(app, "ada@example.test", 0);
    assert(await read(app, fresh), "a session signed in after the stamp works");
    assertEquals((await app.config.adapter!.getUser(other))?.sessionsValidAfter, undefined);
  });
});

Deno.test("revokeAllSessions: a store-backed session ends too, and without adapter or store it throws", async () => {
  await withApp(async (app) => {
    const id = await passwordUser(app, "ada@example.test");
    const cookie = await signIn(app, "ada@example.test");
    assert(await read(app, cookie));
    await revokeAllSessions(id);
    assertEquals(await read(app, cookie), null);
  }, { sessionStore: inMemorySessionStore() });
  denextAuth({
    secret: "a-secret-that-is-at-least-32-characters",
    providers: [credentials({ authorize: () => null })],
  });
  await assertRejects(() => revokeAllSessions("u"), Error, "no `adapter` or `sessionStore`");
});

// ---- denextAuth's own flows ------------------------------------------------------------------------

Deno.test("a password reset ends the user's stateless cookie sessions", async () => {
  await withApp(async (app) => {
    await passwordUser(app, "ada@example.test");
    const cookie = await signIn(app, "ada@example.test");
    const { token } = await issueVerificationToken(app.config, {
      identifier: "ada@example.test",
      purpose: "reset",
      ttl: 3600,
    });
    const result = await resetPassword(app.config, {
      email: "ada@example.test",
      token,
      password: "a brand new password",
    });
    assert(result.ok);
    assertEquals(await read(app, cookie), null);
  });
});

Deno.test("the pre-account-hijacking eviction ends the unverified account's stateless sessions", async () => {
  await withApp(async (app) => {
    const adapter = app.config.adapter!;
    const squatter = await adapter.createUser({ email: "victim@example.test" });
    await adapter.setCredential!(squatter.id, await hashPassword(PASSWORD));
    const cookie = await signIn(app, "victim@example.test");
    assert(await read(app, cookie), "the squatter's session, before the owner proves the mailbox");
    await markVerified(app.config, resolveAuthOptions(app.config), adapter, squatter);
    assertEquals(await read(app, cookie), null);
  });
});

Deno.test("denextAuth's account deletion stamps the user (an adapter that keeps the row)", async () => {
  // A soft-deleting adapter: deleteUser only marks the row, so the stamp is what ends sessions.
  const base = inMemoryAuthAdapter();
  const softDeleting: AuthAdapter = { ...base, deleteUser: () => {} };
  await withApp(
    async (app) => {
      await passwordUser(app, "ada@example.test");
      const cookie = await signIn(app, "ada@example.test");
      const res = await app.fetch(`${ORIGIN}/auth/account/delete`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie, accept: "application/json" },
      });
      // The two-minute-old sign-in is recent enough for deletion.
      assertEquals(res.status, 200, await res.text());
      assertEquals(await read(app, cookie), null);
    },
    {},
    softDeleting,
  );
});

// ---- /auth/v1 ------------------------------------------------------------------------------------------

Deno.test("/auth/v1: a ban ends cookie sessions for good — not just while it lasts", async () => {
  await withApp(async (app) => {
    const id = await passwordUser(app, "ada@example.test");
    const cookie = await signIn(app, "ada@example.test");
    const banned = await api(app, `/admin/users/${id}`, {
      method: "PUT",
      key: app.secretKey,
      body: { ban_duration: "1h" },
    });
    assertEquals(banned.status, 200);
    assertEquals(await read(app, cookie), null, "refused while banned");
    // Lift the ban: the stateless cookie from before it stays ended.
    const lifted = await api(app, `/admin/users/${id}`, {
      method: "PUT",
      key: app.secretKey,
      body: { ban_duration: "none" },
    });
    assertEquals(lifted.status, 200);
    assertEquals(await read(app, cookie), null, "still ended after the ban is lifted");
  });
});

Deno.test("/auth/v1: a password change ends cookie sessions and keeps the caller's token session", async () => {
  await withApp(async (app) => {
    await passwordUser(app, "ada@example.test");
    const cookie = await signIn(app, "ada@example.test");
    const tokens = await api(app, "/token?grant_type=password", {
      body: { email: "ada@example.test", password: PASSWORD },
    });
    assertEquals(tokens.status, 200);
    const changed = await api(app, "/user", {
      method: "PUT",
      token: tokens.json.access_token,
      body: { password: "a different password" },
    });
    assertEquals(changed.status, 200, JSON.stringify(changed.json));
    assertEquals(await read(app, cookie), null);
    assertEquals(
      (await api(app, "/user", { token: tokens.json.access_token })).status,
      200,
      "the caller's own session is kept",
    );
  });
});

Deno.test("/auth/v1: an admin password change ends cookie sessions", async () => {
  await withApp(async (app) => {
    const id = await passwordUser(app, "ada@example.test");
    const cookie = await signIn(app, "ada@example.test");
    const res = await api(app, `/admin/users/${id}`, {
      method: "PUT",
      key: app.secretKey,
      body: { password: "set by an admin" },
    });
    assertEquals(res.status, 200);
    assertEquals(await read(app, cookie), null);
  });
});
