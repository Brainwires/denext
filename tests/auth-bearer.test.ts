// Bearer API tokens: minting + verification (`issueApiToken` / `verifyApiToken`), the
// `requireBearer()` API middleware (uniform 401s, scopes, roles, no cookies, the OpenAPI
// tag), and the `/auth/tokens` management endpoints (cookie session only, MFA-pending
// refused, own-tokens-only revocation).

import { credentials } from "../src/server/auth/providers.ts";
import { activeAuthConfig, denextAuth } from "../src/server/auth/mod.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import {
  issueApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "../src/server/auth/api-token.ts";
import { type BearerContext, requireBearer } from "../src/server/auth/bearer.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import { isApiError } from "../src/server/api-error.ts";
import type { ApiMiddleware, ApiMiddlewareInput } from "../src/server/define-api.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig, AuthUser } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

/** A config with an in-memory adapter (and its clock), plus the adapter itself. */
function setup(
  extra: Partial<AuthConfig> = {},
  now?: () => number,
): { config: AuthConfig; adapter: AuthAdapter } {
  const adapter = inMemoryAuthAdapter(now ? { now } : {});
  return {
    adapter,
    config: { secret: SECRET, canonicalOrigin: ORIGIN, providers: [], adapter, ...extra },
  };
}

/** SHA-256 (hex) — computed independently of the implementation under test. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How many users this file has created, so each gets its own (unique) address. */
let userCount = 0;

/** Create an adapter user and return its id. Addresses are unique — one account each. */
async function makeUser(adapter: AuthAdapter, roles?: string[]): Promise<string> {
  const user = await adapter.createUser({
    email: `dev-${++userCount}@x.test`,
    name: "Dev",
    roles,
  });
  return user.id;
}

/** Run a middleware against a request carrying `header`, inside a fresh request context. */
async function callMiddleware(
  middleware: ApiMiddleware<object, BearerContext>,
  header?: string,
): Promise<{ result: unknown; ctx: RequestContext }> {
  const request = new Request(`${ORIGIN}/api/pets`, {
    method: "POST",
    headers: header ? { authorization: header } : {},
  });
  const ctx = createRequestContext(request);
  const input = { request, params: {}, ctx: {}, method: "POST" } as ApiMiddlewareInput<object>;
  const result = await runWithContext(ctx, () => Promise.resolve(middleware(input)));
  return { result, ctx };
}

/** The status + code + message a middleware threw, or `undefined` when it passed. */
async function refusal(
  middleware: ApiMiddleware<object, BearerContext>,
  header?: string,
): Promise<{ status: number; code: string; message: string } | undefined> {
  try {
    await callMiddleware(middleware, header);
    return undefined;
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  }
}

/** Mint a session cookie pair for `user` without going through a provider flow. */
async function sessionCookie(config: AuthConfig, user: AuthUser): Promise<string> {
  const request = new Request(`${ORIGIN}/`);
  const ctx = createRequestContext(request);
  await runWithContext(ctx, () => issueAuthSession(config, user, "credentials"));
  const pair = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth="))!;
  assert(pair, "a session cookie was issued");
  return pair.split(";")[0];
}

/** Drive an auth endpoint the way the plugin does. */
async function call(
  config: AuthConfig,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response | null> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set("cookie", cookie);
  if (rest.method && rest.method !== "GET") headers.set("origin", ORIGIN);
  const request = new Request(ORIGIN + path, { ...rest, headers });
  const ctx = createRequestContext(request);
  return await runWithContext(ctx, () => handleAuthRequest(request, config));
}

// ---- minting + storage ------------------------------------------------------

Deno.test("issueApiToken: a tok_ secret is returned once and only its SHA-256 is stored", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const { token, record } = await issueApiToken(config, { userId, name: "CI" });

  assert(token.startsWith("tok_"), token);
  assert(token.length > 40, "256 bits of entropy");
  assertEquals(record.userId, userId);
  assertEquals(record.name, "CI");
  assertEquals(record.expiresAt, undefined, "no lifetime asked for → never expires");

  const stored = await listApiTokens(config, userId);
  assertEquals(stored.length, 1);
  assert(stored[0].tokenHash !== token, "the plaintext is never persisted");
  assertEquals(
    stored[0].tokenHash,
    await sha256Hex(token),
    "the hash is SHA-256 of the whole string",
  );
  assert(
    !JSON.stringify(stored).includes(token),
    "no stored field carries the plaintext token",
  );
});

Deno.test("issueApiToken: two tokens never collide, and a bad lifetime is refused", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const a = await issueApiToken(config, { userId });
  const b = await issueApiToken(config, { userId });
  assert(a.token !== b.token);
  assert(a.record.id !== b.record.id);

  await assertRejects(() => issueApiToken(config, { userId, expiresInSeconds: 0 }), Error);
  await assertRejects(() => issueApiToken(config, { userId, expiresInSeconds: -60 }), Error);
});

Deno.test("verifyApiToken: the presented token verifies; anything else is null", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const { token, record } = await issueApiToken(config, { userId, scopes: ["pets:write"] });

  assertEquals((await verifyApiToken(config, token))?.id, record.id);
  assertEquals(await verifyApiToken(config, ""), null);
  assertEquals(await verifyApiToken(config, "tok_not-a-real-token"), null);
  assertEquals(await verifyApiToken(config, record.tokenHash), null, "the hash is not the token");
  assertEquals(await verifyApiToken(config, token + "x"), null);
});

Deno.test("verifyApiToken: revoked and expired tokens stop verifying", async () => {
  let clock = 1_000_000;
  const { config, adapter } = setup({}, () => clock);
  const userId = await makeUser(adapter);

  const revoked = await issueApiToken(config, { userId });
  await revokeApiToken(config, revoked.record.id);
  assertEquals(await verifyApiToken(config, revoked.token), null);

  const expiring = await issueApiToken(config, { userId, expiresInSeconds: 60 });
  assert(await verifyApiToken(config, expiring.token), "live before the deadline");
  clock = Math.floor(Date.now() / 1000) + 3600; // past its expiry, on the adapter's clock
  assertEquals(await verifyApiToken(config, expiring.token), null);
});

Deno.test("verifyApiToken: a dead row handed back by a third-party adapter is still refused", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const { token, record } = await issueApiToken(config, { userId });
  const now = Math.floor(Date.now() / 1000);

  // An adapter that forgets to hide revoked/expired rows must not authenticate them.
  const leaky = setup().config;
  leaky.adapter = { ...adapter, getApiTokenByHash: () => ({ ...record, revokedAt: now - 1 }) };
  assertEquals(await verifyApiToken(leaky, token), null, "revoked");
  leaky.adapter = { ...adapter, getApiTokenByHash: () => ({ ...record, expiresAt: now - 1 }) };
  assertEquals(await verifyApiToken(leaky, token), null, "expired");
});

Deno.test("the API-token functions throw a config-time error without a capable adapter", async () => {
  const bare: AuthConfig = { secret: SECRET, canonicalOrigin: ORIGIN, providers: [] };
  assertThrows(() => requireBearer(bare), Error, "API-token group");
  await assertRejects(() => issueApiToken(bare, { userId: "u" }), Error, "API-token group");
  await assertRejects(() => revokeApiToken(bare, "id"), Error, "API-token group");
  await assertRejects(() => listApiTokens(bare, "u"), Error, "API-token group");
  // Verification is the exception: "not configured" reads as "no such token", uniformly.
  assertEquals(await verifyApiToken(bare, "tok_whatever"), null);
});

// ---- requireBearer ----------------------------------------------------------

Deno.test("requireBearer: a valid token yields the token, the user and a session-shaped ctx", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter, ["admin"]);
  const { token, record } = await issueApiToken(config, { userId, scopes: ["pets:write"] });

  const { result, ctx } = await callMiddleware(requireBearer(config), `Bearer ${token}`);
  const extension = result as BearerContext;
  assertEquals(extension.token.id, record.id);
  assertEquals(extension.token.scopes, ["pets:write"]);
  assertEquals(extension.user.id, userId);
  assertEquals(extension.session.user.id, userId, "handlers written for requireSession still work");
  assertEquals(extension.session.user.roles, ["admin"]);
  assertEquals(extension.session.provider, "api-token");
  assertEquals(extension.session.amr, ["bearer"]);
  assertEquals(ctx.outgoingHeaders.getSetCookie(), [], "bearer auth never sets a cookie");

  // A lower-cased scheme is still a bearer credential (RFC 7235).
  assert(await callMiddleware(requireBearer(config), `bearer ${token}`));
  // The presentation is recorded.
  assert((await listApiTokens(config, userId))[0].lastUsedAt, "lastUsedAt was touched");
});

Deno.test("requireBearer: absent, malformed, unknown, revoked and expired all fail identically", async () => {
  let clock = 1_000_000;
  const { config, adapter } = setup({}, () => clock);
  const userId = await makeUser(adapter);
  const revoked = await issueApiToken(config, { userId });
  await revokeApiToken(config, revoked.record.id);
  const expiring = await issueApiToken(config, { userId, expiresInSeconds: 60 });
  clock = Math.floor(Date.now() / 1000) + 3600;

  const middleware = requireBearer(config);
  const answers = [
    await refusal(middleware),
    await refusal(middleware, ""),
    await refusal(middleware, "Bearer"),
    await refusal(middleware, "Bearer "),
    await refusal(middleware, "Basic dXNlcjpwYXNz"),
    await refusal(middleware, "Bearer tok_unknown-token-value"),
    await refusal(middleware, `Bearer ${revoked.token}`),
    await refusal(middleware, `Bearer ${expiring.token}`),
  ];
  for (const answer of answers) {
    assertEquals(answer, answers[0], "every failure is byte-identical");
  }
  assertEquals(answers[0]?.status, 401);
  assertEquals(answers[0]?.code, "unauthorized");

  // A token whose user is gone is as dead as a revoked one, and says so no louder.
  const orphan = await issueApiToken(config, { userId: "deleted-user" });
  assertEquals(await refusal(middleware, `Bearer ${orphan.token}`), answers[0]);
});

Deno.test("requireBearer({ scope }): any-of, and a scopeless token satisfies nothing", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const scoped = await issueApiToken(config, { userId, scopes: ["pets:read", "pets:write"] });
  const scopeless = await issueApiToken(config, { userId });

  assert(
    await callMiddleware(requireBearer(config, { scope: "pets:write" }), `Bearer ${scoped.token}`),
  );
  assert(
    await callMiddleware(
      requireBearer(config, { scope: ["admin", "pets:read"] }),
      `Bearer ${scoped.token}`,
    ),
    "any one of the listed scopes suffices",
  );

  const denied = await refusal(requireBearer(config, { scope: "admin" }), `Bearer ${scoped.token}`);
  assertEquals([denied?.status, denied?.code], [403, "forbidden"]);
  const bare = await refusal(
    requireBearer(config, { scope: "pets:read" }),
    `Bearer ${scopeless.token}`,
  );
  assertEquals([bare?.status, bare?.code], [403, "forbidden"], "no scopes → never satisfies one");
  assert(
    await callMiddleware(requireBearer(config), `Bearer ${scopeless.token}`),
    "no requirement → a scopeless token is fine",
  );
});

Deno.test("requireBearer({ role }): the token's user must hold one of the roles", async () => {
  const { config, adapter } = setup();
  const admin = await issueApiToken(config, { userId: await makeUser(adapter, ["admin"]) });
  const nobody = await issueApiToken(config, { userId: await makeUser(adapter) });

  assert(await callMiddleware(requireBearer(config, { role: "admin" }), `Bearer ${admin.token}`));
  const denied = await refusal(requireBearer(config, { role: "admin" }), `Bearer ${nobody.token}`);
  assertEquals([denied?.status, denied?.code], [403, "forbidden"]);
  const custom = requireBearer(config, { role: "admin", forbiddenMessage: "nope" });
  assertEquals((await refusal(custom, `Bearer ${nobody.token}`))?.message, "nope");
});

Deno.test("requireBearer: it carries the OpenAPI bearerAuth requirement (documentsSecurity)", () => {
  const { config } = setup();
  const docs = (requireBearer(config) as unknown as Record<symbol, { security?: unknown }>)[
    Symbol.for("denext.api.middlewareDocs")
  ];
  assertEquals(docs?.security, [{ bearerAuth: [] }]);
});

// ---- /auth/tokens -----------------------------------------------------------

Deno.test("/auth/tokens: POST mints (once), GET lists redacted, DELETE revokes", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });

  const created = (await call(config, "/auth/tokens", {
    method: "POST",
    cookie,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CI", scopes: ["pets:write"], expiresInSeconds: 3600 }),
  }))!;
  assertEquals(created.status, 201);
  assertEquals(created.headers.get("cache-control"), "no-store");
  const body = await created.json();
  assert(body.token.startsWith("tok_"));
  assertEquals(body.name, "CI");
  assertEquals(body.scopes, ["pets:write"]);
  assert(body.expiresAt > body.createdAt);
  assertEquals(body.tokenHash, undefined, "the stored hash never leaves the server");

  // The minted token authenticates an API call.
  assertEquals((await verifyApiToken(config, body.token))?.id, body.id);

  const listed = await (await call(config, "/auth/tokens", { cookie }))!.json();
  assertEquals(listed.tokens.length, 1);
  assertEquals(listed.tokens[0].id, body.id);
  assertEquals(listed.tokens[0].tokenHash, undefined, "the list is redacted");
  assertEquals(listed.tokens[0].token, undefined, "the plaintext is never listed");

  const deleted = (await call(config, `/auth/tokens/${body.id}`, { method: "DELETE", cookie }))!;
  assertEquals(deleted.status, 200);
  assertEquals(await verifyApiToken(config, body.token), null, "revoked immediately");
  assertEquals((await (await call(config, "/auth/tokens", { cookie }))!.json()).tokens, []);
  // Revoking it again: it is already gone, and 404 is also what a stranger's id gets.
  assertEquals(
    (await call(config, `/auth/tokens/${body.id}`, { method: "DELETE", cookie }))!.status,
    404,
  );
});

Deno.test("/auth/tokens: a signed-out caller — and a Bearer header — get 401", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const { token } = await issueApiToken(config, { userId, scopes: ["admin"] });

  assertEquals((await call(config, "/auth/tokens", { method: "POST" }))!.status, 401);
  assertEquals((await call(config, "/auth/tokens"))!.status, 401);
  assertEquals((await call(config, "/auth/tokens/x", { method: "DELETE" }))!.status, 401);

  // A valid bearer token is NOT a credential here: it can't mint or list more of itself.
  const bearer = { authorization: `Bearer ${token}` };
  assertEquals((await call(config, "/auth/tokens", { headers: bearer }))!.status, 401);
  assertEquals(
    (await call(config, "/auth/tokens", { method: "POST", headers: bearer }))!.status,
    401,
  );
});

Deno.test("/auth/tokens: an MFA-pending session mints nothing", async () => {
  const { config, adapter } = setup({
    callbacks: { session: (s) => ({ ...s, mfaPending: true as const }) },
  });
  const userId = await makeUser(adapter);
  const pending = await sessionCookie(config, { id: userId, email: "dev@x.test" });

  assertEquals(
    (await call(config, "/auth/tokens", { method: "POST", cookie: pending }))!.status,
    401,
    "a first factor alone can't mint a credential that outlives the second",
  );
  assertEquals((await call(config, "/auth/tokens", { cookie: pending }))!.status, 401);
  assertEquals(
    (await call(config, "/auth/tokens/x", { method: "DELETE", cookie: pending }))!.status,
    401,
  );
});

Deno.test("/auth/tokens: cross-origin mutations are refused, and bad bodies are 400", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });

  const evil = new Request(`${ORIGIN}/auth/tokens`, {
    method: "POST",
    headers: { cookie, origin: "https://evil.test" },
  });
  const ctx = createRequestContext(evil);
  const cross = (await runWithContext(ctx, () => handleAuthRequest(evil, config)))!;
  assertEquals(cross.status, 403);

  const bad = async (payload: unknown) =>
    (await call(config, "/auth/tokens", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }))!.status;
  assertEquals(await bad({ name: "x".repeat(500) }), 400);
  assertEquals(await bad({ scopes: [1, 2] }), 400);
  assertEquals(await bad({ scopes: "ok" }), 201, "a form-style scope list is accepted");
  assertEquals(await bad({ expiresInSeconds: -1 }), 400);
  assertEquals(await bad([]), 400);
  assertEquals(
    (await call(config, "/auth/tokens", { method: "POST", cookie }))!.status,
    201,
    "no body at all → a token with every field defaulted",
  );
});

Deno.test("/auth/tokens: DELETE of another user's token is a 404, and never revokes it", async () => {
  const { config, adapter } = setup();
  const mine = await makeUser(adapter);
  const theirs = await adapter.createUser({ email: "other@x.test" });
  const cookie = await sessionCookie(config, { id: mine, email: "dev@x.test" });
  const victim = await issueApiToken(config, { userId: theirs.id });

  const res = (await call(config, `/auth/tokens/${victim.record.id}`, {
    method: "DELETE",
    cookie,
  }))!;
  assertEquals(res.status, 404, "someone else's id is indistinguishable from an unknown one");
  assertEquals(
    (await call(config, "/auth/tokens/does-not-exist", { method: "DELETE", cookie }))!.status,
    404,
  );
  assert(await verifyApiToken(config, victim.token), "their token still works");
});

Deno.test("/auth/tokens: without an API-token adapter the endpoints don't exist", async () => {
  const bare: AuthConfig = { secret: SECRET, canonicalOrigin: ORIGIN, providers: [] };
  assertEquals(await call(bare, "/auth/tokens"), null, "falls through to a normal 404");
  assertEquals(await call(bare, "/auth/tokens", { method: "POST" }), null);
  assertEquals(await call(bare, "/auth/tokens/x", { method: "DELETE" }), null);
  // The rest of the auth surface is unaffected.
  assertEquals((await call(bare, "/auth/session"))!.status, 200);
});

Deno.test("/auth/tokens: a per-user cap bounds how many live tokens one session can mint", async () => {
  // A session can mint in a loop and an API token never expires unless asked to, so without
  // a cap one compromised session leaves an unbounded number of long-lived credentials.
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });
  const mint = () => call(config, "/auth/tokens", { method: "POST", cookie });

  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const res = (await mint())!;
    assertEquals(res.status, 201, `token ${i + 1} of the budget`);
    ids.push((await res.json()).id);
  }
  const refused = (await mint())!;
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).error, "too many tokens");

  // Revoking one frees a slot — the cap counts LIVE tokens, not tokens ever minted.
  const gone = (await call(config, `/auth/tokens/${ids[0]}`, { method: "DELETE", cookie }))!;
  assertEquals(gone.status, 200);
  assertEquals((await mint())!.status, 201);
});

Deno.test("/auth/tokens: minting needs a recent sign-in — a stale session gets reauth_required", async () => {
  // A token outlives every session and survives revokeAllSessions(), so an old (possibly
  // stolen) session must not be able to turn itself into one.
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000; // past the 15-minute freshness window
  try {
    const stale = (await call(config, "/auth/tokens", { method: "POST", cookie }))!;
    assertEquals(stale.status, 403);
    assertEquals(await stale.json(), { error: "reauth_required" });
    assertEquals(await adapter.listApiTokens!(userId), [], "nothing was minted");
  } finally {
    Date.now = realNow;
  }
  assertEquals((await call(config, "/auth/tokens", { method: "POST", cookie }))!.status, 201);
});

Deno.test("/auth/tokens: concurrent mints can't overrun the live-token cap", async () => {
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });
  for (let i = 0; i < 48; i++) await issueApiToken(config, { userId });
  const burst = await Promise.all(
    Array.from({ length: 6 }, () => call(config, "/auth/tokens", { method: "POST", cookie })),
  );
  assertEquals(burst.map((res) => res!.status).sort(), [201, 201, 409, 409, 409, 409]);
  assertEquals((await adapter.listApiTokens!(userId)).length, 50);
});

Deno.test("/auth/tokens and /auth/mfa: an adapter failure is logged and answered 503, not a bare 500", async () => {
  const errors: string[] = [];
  const { config, adapter } = setup({ logger: { error: (message) => void errors.push(message) } });
  const userId = await makeUser(adapter);
  const cookie = await sessionCookie(config, { id: userId, email: "dev@x.test" });
  adapter.listApiTokens = () => Promise.reject(new Error("database is locked"));
  adapter.getMfa = () => Promise.reject(new Error("database is locked"));
  const calls = [["/auth/tokens", "POST"], ["/auth/tokens", "GET"], ["/auth/mfa/enroll", "POST"]];
  for (const [path, method] of calls) {
    const res = (await call(config, path, { method, cookie }))!;
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals(await res.json(), { error: "unavailable" });
  }
  assertEquals(errors.length, 3, "each failure reached the auth logger");
});

Deno.test("requireBearer({ scope: [] }) is unsatisfiable, like role: []", async () => {
  // A computed requirement that came out empty must not admit every live token.
  const { config, adapter } = setup();
  const userId = await makeUser(adapter);
  const scoped = await issueApiToken(config, { userId, scopes: ["pets:read"] });
  const denied = await refusal(requireBearer(config, { scope: [] }), `Bearer ${scoped.token}`);
  assertEquals([denied?.status, denied?.code], [403, "forbidden"]);
});

Deno.test("requireBearer({ scope }) reads the active config denextAuth() was built with", async () => {
  const { config, adapter } = setup({ providers: [credentials()] });
  denextAuth(config);
  assertEquals(activeAuthConfig(), config);
  const userId = await makeUser(adapter);
  const scoped = await issueApiToken(config, { userId, scopes: ["pets:read"] });
  assert(await callMiddleware(requireBearer({ scope: "pets:read" }), `Bearer ${scoped.token}`));
  const denied = await refusal(requireBearer({ scope: "admin" }), `Bearer ${scoped.token}`);
  assertEquals([denied?.status, denied?.code], [403, "forbidden"]);
});
