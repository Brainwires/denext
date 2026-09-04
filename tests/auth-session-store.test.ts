// Opt-in revocable sessions: the in-memory + node:sqlite SessionStores, the
// store-aware issue/read/clear path (the cookie carries only an id), revokeSession /
// revokeAllSessions, the plugin teardown seam, and the unchanged stateless default.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { auth, denextAuth, revokeAllSessions, revokeSession } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import { sqliteSessionStore } from "../src/server/auth/sqlite-session-store.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import type { PluginContext } from "../src/plugin/mod.ts";
import type { SqliteDb } from "../src/server/sqlite-cache.ts";

const ORIGIN = "https://app.test";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const session = (userId: string, expiresAt = inAnHour()): AuthSession => ({
  user: { id: userId, email: `${userId}@x.test` },
  provider: "credentials",
  expiresAt,
});

// ---- stores ----------------------------------------------------------------

/** The contract every SessionStore must meet — run against each implementation. */
async function storeContract(t: Deno.TestContext, make: () => SessionStore): Promise<void> {
  await t.step("create → get → delete", async () => {
    const s = make();
    await s.create("sid1", session("u1"));
    assertEquals((await s.get("sid1"))?.user.id, "u1");
    assertEquals(await s.get("nope"), undefined);
    await s.delete("sid1");
    assertEquals(await s.get("sid1"), undefined);
    await s.delete("sid1"); // unknown id: no-op, no throw
  });
  await t.step("deleteByUser removes every session of that user only", async () => {
    const s = make();
    await s.create("a1", session("alice"));
    await s.create("a2", session("alice"));
    await s.create("b1", session("bob"));
    await s.deleteByUser("alice");
    assertEquals(await s.get("a1"), undefined);
    assertEquals(await s.get("a2"), undefined);
    assertEquals((await s.get("b1"))?.user.id, "bob");
  });
  await t.step("an expired session reads as a miss", async () => {
    const s = make();
    await s.create("old", session("u", Math.floor(Date.now() / 1000) - 1));
    assertEquals(await s.get("old"), undefined);
  });
  await t.step("re-creating an id replaces the record", async () => {
    const s = make();
    await s.create("x", session("first"));
    await s.create("x", session("second"));
    assertEquals((await s.get("x"))?.user.id, "second");
  });
}

Deno.test("inMemorySessionStore meets the store contract", async (t) => {
  await storeContract(t, () => inMemorySessionStore());
});

Deno.test("inMemorySessionStore: FIFO cap + sweep of expired sessions", async () => {
  const s = inMemorySessionStore({ maxEntries: 2, sweepIntervalMs: 0 });
  await s.create("expired", session("u", Math.floor(Date.now() / 1000) - 1));
  await s.create("s1", session("u"));
  // The sweep on this write drops the expired row before the cap is enforced.
  await s.create("s2", session("u"));
  assertEquals((await s.get("s1"))?.user.id, "u", "s1 survives: the expired row was swept");
  await s.create("s3", session("u"));
  assertEquals(await s.get("s1"), undefined, "past the cap the oldest live session is evicted");
  assertEquals((await s.get("s3"))?.user.id, "u");
});

function tempSqlitePath(): string {
  return `${Deno.makeTempDirSync({ prefix: "denext-auth-sessions-" })}/sessions.db`;
}

Deno.test("sqliteSessionStore (real node:sqlite) meets the store contract", async (t) => {
  await storeContract(t, () => sqliteSessionStore({ path: tempSqlitePath() }));
});

Deno.test("sqliteSessionStore: durable across close/reopen, sweeps expired rows on write", async () => {
  const path = tempSqlitePath();
  const first = sqliteSessionStore({ path, sweepIntervalMs: 0 });
  await first.create("keep", session("u"));
  await first.create("stale", session("u", Math.floor(Date.now() / 1000) - 5));
  await first.close!();
  const second = sqliteSessionStore({ path, sweepIntervalMs: 0 });
  assertEquals((await second.get("keep"))?.user.id, "u", "survived a restart");
  // The stale row is expired (a miss) and the next write sweeps it physically.
  assertEquals(await second.get("stale"), undefined);
  await second.create("fresh", session("u"));
  await second.close!();
});

Deno.test("sqliteSessionStore: drives a stub SqliteDb via openDb and closes it on close()", async () => {
  const sql: string[] = [];
  const rows = new Map<string, { payload: string; expires_at: number }>();
  let closed = 0;
  const stub: SqliteDb = {
    exec(s, params = []) {
      sql.push(s);
      if (s.startsWith("INSERT")) {
        rows.set(String(params[0]), {
          payload: String(params[2]),
          expires_at: Number(params[3]),
        });
      }
      if (s.startsWith("DELETE FROM sessions WHERE id")) rows.delete(String(params[0]));
    },
    query<T>(s: string, params: unknown[] = []): T[] {
      sql.push(s);
      const r = rows.get(String(params[0]));
      return (r && r.expires_at > Number(params[1]) ? [{ payload: r.payload }] : []) as T[];
    },
    close: () => void closed++,
  };
  let openedPath = "";
  const store = sqliteSessionStore({
    path: "/virtual/sessions.db",
    openDb: (p) => {
      openedPath = p;
      return stub;
    },
  });
  await store.create("sid", session("u9"));
  assertEquals(openedPath, "/virtual/sessions.db");
  assert(sql.some((s) => s.includes("CREATE TABLE IF NOT EXISTS sessions")), "schema created");
  assertEquals((await store.get("sid"))?.user.id, "u9");
  await store.delete("sid");
  assertEquals(await store.get("sid"), undefined);
  await store.close!();
  assertEquals(closed, 1);
});

// ---- the auth flow with a store ---------------------------------------------

function storeConfig(sessionStore?: SessionStore): AuthConfig {
  return {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email, password }) => password === "pw" ? { id: email, email } : null,
      }),
    ],
    rateLimit: false,
    ...(sessionStore ? { sessionStore } : {}),
  };
}

/** Call an auth endpoint; returns the response and the `__Host-denext_auth=…` pair set (if any). */
async function call(
  config: AuthConfig,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ res: Response; cookie: string | undefined; ctx: RequestContext }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("origin", ORIGIN);
  if (init.cookie) headers.set("cookie", init.cookie);
  const request = new Request(`${ORIGIN}${path}`, { ...init, headers });
  const ctx = createRequestContext(request);
  const res = (await runWithContext(ctx, () => handleAuthRequest(request, config)))!;
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;"))
    ?.split(";")[0];
  return { res, cookie, ctx };
}

function signIn(config: AuthConfig, email: string) {
  return call(config, "/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pw" }),
  });
}

async function sessionUser(config: AuthConfig, cookie: string | undefined): Promise<unknown> {
  const { res } = await call(config, "/auth/session", { cookie });
  return (await res.json()).user;
}

/** The signed cookie's decoded payload (`d` of `{d,e}`). */
function cookiePayload(cookie: string): Record<string, unknown> {
  const b64 = cookie.split("=")[1].split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(atob(padded)).d;
}

Deno.test("store-backed: the cookie carries only a session id; the store holds the payload", async () => {
  const store = inMemorySessionStore();
  const config = storeConfig(store);
  const { res, cookie } = await signIn(config, "alice");
  assertEquals(res.status, 200);
  assert(cookie, "session cookie issued");
  const payload = cookiePayload(cookie);
  assertEquals(Object.keys(payload), ["sid"], "no user data in the cookie");
  assertEquals((await store.get(payload.sid as string))?.user.id, "alice");
  assertEquals(((await sessionUser(config, cookie)) as { id: string }).id, "alice");
});

Deno.test("store-backed: revokeSession ends one session; revokeAllSessions ends every one", async () => {
  const store = inMemorySessionStore();
  const config = storeConfig(store);
  denextAuth(config); // activates the config for revoke*/auth()
  const a1 = (await signIn(config, "alice")).cookie!;
  const a2 = (await signIn(config, "alice")).cookie!;
  const b1 = (await signIn(config, "bob")).cookie!;

  // auth() exposes the id of the current session so an app can revoke "this device".
  const req = new Request(`${ORIGIN}/`, { headers: { cookie: a1 } });
  const current = await runWithContext(createRequestContext(req), () => auth());
  assertEquals(current?.user.id, "alice");
  assertEquals(current?.sessionId, cookiePayload(a1).sid);

  await revokeSession(current!.sessionId!);
  assertEquals(await sessionUser(config, a1), null, "revoked session reads as signed out");
  assert(await sessionUser(config, a2), "alice's other session still works");

  await revokeAllSessions("alice");
  assertEquals(await sessionUser(config, a2), null, "sign out everywhere");
  assert(await sessionUser(config, b1), "bob is unaffected");
});

Deno.test("store-backed: signout deletes the store record, not just the cookie", async () => {
  const store = inMemorySessionStore();
  const config = storeConfig(store);
  const cookie = (await signIn(config, "alice")).cookie!;
  const sid = cookiePayload(cookie).sid as string;
  assert(await store.get(sid));
  const { res } = await call(config, "/auth/signout", { method: "POST", cookie });
  assertEquals(res.status, 200);
  assertEquals(await store.get(sid), undefined, "a replayed cookie can't resurrect the session");
  assertEquals(await sessionUser(config, cookie), null);
});

Deno.test("store-backed: a stateless-shaped cookie is not honored, and vice versa", async () => {
  const stateless = storeConfig();
  const backed = storeConfig(inMemorySessionStore());
  const statelessCookie = (await signIn(stateless, "alice")).cookie!;
  const backedCookie = (await signIn(backed, "alice")).cookie!;
  assertEquals(await sessionUser(backed, statelessCookie), null, "payload cookie vs store");
  assertEquals(await sessionUser(stateless, backedCookie), null, "id cookie vs stateless");
});

Deno.test("default (no sessionStore): the stateless payload cookie is unchanged", async () => {
  const config = storeConfig();
  const cookie = (await signIn(config, "alice")).cookie!;
  const payload = cookiePayload(cookie);
  assertEquals((payload.user as { id: string }).id, "alice", "the cookie carries the user");
  assertEquals(payload.provider, "credentials");
  assert(typeof payload.expiresAt === "number");
  assertEquals("sid" in payload, false);
  assertEquals("sessionId" in payload, false);
  assertEquals(((await sessionUser(config, cookie)) as { id: string }).id, "alice");
});

Deno.test("revokeSession / revokeAllSessions throw without a sessionStore (stateless can't revoke)", async () => {
  denextAuth(storeConfig());
  await assertRejects(() => revokeSession("x"), Error, "no `sessionStore`");
  await assertRejects(() => revokeAllSessions("alice"), Error, "no `sessionStore`");
});

Deno.test("denextAuth registers a teardown that closes a closable sessionStore", async () => {
  let closed = 0;
  const store: SessionStore = { ...inMemorySessionStore(), close: () => void closed++ };
  const plugin = denextAuth(storeConfig(store));
  const teardowns: Array<() => void | Promise<void>> = [];
  const ctx = {
    addRequestHandler: () => {},
    addTeardown: (fn: () => void | Promise<void>) => void teardowns.push(fn),
  } as unknown as PluginContext;
  await plugin.setup(ctx);
  assertEquals(teardowns.length, 1);
  await teardowns[0]();
  assertEquals(closed, 1);
  // A store without close() registers nothing.
  teardowns.length = 0;
  await denextAuth(storeConfig(inMemorySessionStore())).setup(ctx);
  assertEquals(teardowns.length, 0);
});
