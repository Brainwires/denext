// The absolute session lifetime (`session.maxLifetime`): a hard ceiling counted from the
// sign-in (`authTime`) that sliding refresh never extends — on the stateless cookie strategy
// and the database strategy alike. Refresh before the ceiling extends `expiresAt` up to it and
// no further; at the ceiling a session reads as signed out whatever its `expiresAt` says; a
// `callbacks.session` can't lift an expiry past it; a session without `authTime` never slides;
// and the config is validated at `denextAuth()` time.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { getSession } from "../src/server/session.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { issueAuthSession, readAuthSession, refreshIfStale } from "../src/server/auth/session.ts";
import { cookieSessionOptions, resolveAuthOptions } from "../src/server/auth/options.ts";
import { inMemorySessionStore } from "../src/server/auth/session-store.ts";
import { credentials } from "../src/server/auth/providers.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const MAX_AGE = 3600;
const UPDATE_AGE = 60;
const MAX_LIFETIME = 7200;
const SESSION_COOKIE = "__Host-denext_auth=";
const DAY = 86_400;

const nowSec = (): number => Math.floor(Date.now() / 1000);

function config(
  session: AuthConfig["session"] = {},
  extra: Partial<AuthConfig> = {},
): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    rateLimit: false,
    session: { maxAge: MAX_AGE, updateAge: UPDATE_AGE, maxLifetime: MAX_LIFETIME, ...session },
    providers: [credentials({ authorize: ({ email }) => ({ id: email, email }) })],
    ...extra,
  };
}

/**
 * A complete session signed in `signedInAgo` seconds ago and last slid `slidAgo` seconds ago,
 * its expiry minted as the framework would (a full `maxAge`, capped at the ceiling).
 */
function payload(
  signedInAgo: number,
  slidAgo: number,
  over: Partial<AuthSession> = {},
): AuthSession {
  const issuedAt = nowSec() - slidAgo;
  const authTime = nowSec() - signedInAgo;
  return {
    user: { id: "u1", email: "u1@x.test" },
    provider: "credentials",
    expiresAt: Math.min(issuedAt + MAX_AGE, authTime + MAX_LIFETIME),
    v: 2,
    issuedAt,
    authTime,
    ...over,
  };
}

/** Signed in 70 minutes ago, last slid 30 minutes ago: 30 minutes left, 50 before the ceiling. */
const NEAR_CEILING = { signedInAgo: MAX_LIFETIME - 3000, slidAgo: 1800 } as const;

async function inContext<T>(
  request: Request,
  body: (ctx: RequestContext) => Promise<T>,
): Promise<{ value: T; cookies: string[] }> {
  const ctx = createRequestContext(request);
  const value = await runWithContext(ctx, () => body(ctx));
  return { value, cookies: ctx.outgoingHeaders.getSetCookie() };
}

/** Sign `data` as this config's session cookie, exactly as the framework would. */
async function mintCookie(cfg: AuthConfig, data: unknown): Promise<string> {
  const options = resolveAuthOptions(cfg);
  const { cookies } = await inContext(new Request(`${ORIGIN}/`), async () => {
    const cookie = await getSession<unknown>(
      cookieSessionOptions(cfg, options.cookies.session, options.maxAge),
    );
    await cookie.set(data);
  });
  return cookies.find((c) => c.startsWith(SESSION_COOKIE))!.split(";")[0];
}

function read(cfg: AuthConfig, cookie: string): Promise<AuthSession | null> {
  return inContext(
    new Request(`${ORIGIN}/`, { headers: { cookie } }),
    () => readAuthSession(cfg),
  ).then((r) => r.value);
}

function refresh(cfg: AuthConfig, session: AuthSession): Promise<AuthSession> {
  return inContext(new Request(`${ORIGIN}/`), () => refreshIfStale(cfg, session)).then((r) =>
    r.value
  );
}

// ---- sliding up to the ceiling, never past it --------------------------------------

Deno.test("cookie: a slide far from the ceiling gets a full maxAge", async () => {
  const cfg = config();
  const session = payload(UPDATE_AGE * 2, UPDATE_AGE * 2);
  // The clock may tick over a second boundary during the refresh: bracket it.
  const before = nowSec();
  const slid = await refresh(cfg, session);
  const after = nowSec();
  assert(
    slid.expiresAt >= before + MAX_AGE && slid.expiresAt <= after + MAX_AGE,
    `a full maxAge from the slide (got ${slid.expiresAt}, window ${before + MAX_AGE}..${
      after + MAX_AGE
    })`,
  );
  assertEquals(slid.authTime, session.authTime, "a slide never moves authTime");
});

Deno.test("cookie: a slide near the ceiling stops exactly at authTime + maxLifetime", async () => {
  const cfg = config();
  const session = payload(NEAR_CEILING.signedInAgo, NEAR_CEILING.slidAgo);
  const slid = await refresh(cfg, session);
  const ceiling = session.authTime! + MAX_LIFETIME;
  assert(slid.expiresAt > session.expiresAt, "the slide still extended the session…");
  assertEquals(slid.expiresAt, ceiling, "…but only up to the ceiling");
  assert(slid.expiresAt < nowSec() + MAX_AGE);

  // Sliding again at the ceiling extends nothing: the session is handed back as it was.
  const again = await refresh(cfg, { ...slid, issuedAt: nowSec() - UPDATE_AGE * 2 });
  assertEquals(again.expiresAt, ceiling);
});

Deno.test("database: a slide near the ceiling is capped in the store record too", async () => {
  const store = inMemorySessionStore();
  const cfg = config({ strategy: "database" }, { sessionStore: store });
  const session = payload(NEAR_CEILING.signedInAgo, NEAR_CEILING.slidAgo);
  await store.create("sid-1", session);
  const slid = await refresh(cfg, { ...session, sessionId: "sid-1" });
  const ceiling = session.authTime! + MAX_LIFETIME;
  assertEquals(slid.expiresAt, ceiling);
  assertEquals((await store.get("sid-1"))?.expiresAt, ceiling);
});

// ---- past the ceiling: invalid on both strategies ------------------------------------

Deno.test("cookie: a session past its ceiling reads as signed out even with expiresAt ahead", async () => {
  const cfg = config();
  // `expiresAt` an hour ahead (as a session slid before the ceiling existed carries it) —
  // but signed in past the ceiling.
  const stale = payload(MAX_LIFETIME + 1, 60, { expiresAt: nowSec() + MAX_AGE });
  assert(stale.expiresAt > nowSec());
  assertEquals(await read(cfg, await mintCookie(cfg, stale)), null);

  const fresh = payload(MAX_LIFETIME - 60, 60);
  assertEquals((await read(cfg, await mintCookie(cfg, fresh)))?.user.id, "u1", "just inside");
});

Deno.test("database: a stored session past its ceiling reads as signed out", async () => {
  const store = inMemorySessionStore();
  const cfg = config({ strategy: "database" }, { sessionStore: store });
  await store.create("old", payload(MAX_LIFETIME + 1, 60, { expiresAt: nowSec() + MAX_AGE }));
  await store.create("ok", payload(MAX_LIFETIME - 60, 60));
  assertEquals(await read(cfg, await mintCookie(cfg, { sid: "old" })), null);
  assertEquals((await read(cfg, await mintCookie(cfg, { sid: "ok" })))?.sessionId, "ok");
});

// ---- minting -------------------------------------------------------------------------

Deno.test("a session callback can't lift the expiry past the ceiling", async () => {
  const cfg = config({}, {
    callbacks: { session: (s) => ({ ...s, expiresAt: s.expiresAt + 365 * DAY }) },
  });
  const { value: issued } = await inContext(
    new Request(`${ORIGIN}/`),
    () => issueAuthSession(cfg, { id: "u1" }, "credentials"),
  );
  assertEquals(issued.expiresAt, issued.authTime! + MAX_LIFETIME);
});

Deno.test("a session without authTime (pre-2.5.0-rc.3) is never slid", async () => {
  const cfg = config();
  const { authTime: _drop, ...legacy } = payload(UPDATE_AGE * 2, UPDATE_AGE * 2);
  const slid = await refresh(cfg, legacy);
  assertEquals(slid, legacy, "handed back unchanged: it ends at its current expiry");
});

// ---- config ----------------------------------------------------------------------------

Deno.test("session.maxLifetime: the default is 30 days, or maxAge when that is longer", () => {
  const base = { secret: SECRET, providers: [] } as unknown as AuthConfig;
  assertEquals(resolveAuthOptions({ ...base }).maxLifetime, 30 * DAY);
  assertEquals(
    resolveAuthOptions({ ...base, session: { maxAge: 90 * DAY } }).maxLifetime,
    90 * DAY,
  );
  assertEquals(resolveAuthOptions({ ...base, maxAge: 60 * DAY }).maxLifetime, 60 * DAY);
  assertEquals(
    resolveAuthOptions({ ...base, session: { maxAge: DAY, maxLifetime: 2 * DAY } }).maxLifetime,
    2 * DAY,
  );
});

Deno.test("session.maxLifetime: invalid values and a ceiling below maxAge throw at denextAuth()", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600"]) {
    assertThrows(
      () => denextAuth(config({ maxLifetime: bad as number })),
      Error,
      "session.maxLifetime",
      `refuses ${String(bad)}`,
    );
  }
  assertThrows(
    () => denextAuth(config({ maxAge: 7 * DAY, maxLifetime: DAY })),
    Error,
    "shorter than the session `maxAge`",
  );
});
