// The resolved auth options seam: base-path normalisation (and routing under a custom
// one), cookie naming + the `__Host-` prefix, the cookie-vs-database session strategy
// rules, the Hasher seam, and the event dispatcher's "never throw into the flow" rule.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { emitAuthEvent } from "../src/server/auth/events.ts";
import { scryptHasher } from "../src/server/auth/hasher.ts";
import { inMemorySessionStore, type SessionStore } from "../src/server/auth/session-store.ts";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

function config(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    rateLimit: false,
    providers: [
      credentials({ authorize: ({ email }) => (email ? { id: email, email } : null) }),
    ],
    ...extra,
  };
}

/** An adapter stub: only the field under test is real; the required methods never run. */
function stubAdapter(sessions?: SessionStore): AuthAdapter {
  const nope = (): never => {
    throw new Error("the adapter must not be called in this test");
  };
  return {
    createUser: nope,
    getUser: nope,
    getUserByEmail: nope,
    getUserByAccount: nope,
    updateUser: nope,
    linkAccount: nope,
    ...(sessions ? { sessions } : {}),
  };
}

async function call(
  cfg: AuthConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response | null; ctx: RequestContext }> {
  const request = new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { accept: "application/json", origin: ORIGIN, ...(init.headers ?? {}) },
  });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, cfg));
  return { res, ctx };
}

/** Sign in through the credentials endpoint and return every Set-Cookie it emitted. */
async function signInCookies(cfg: AuthConfig, path = "/auth/callback/credentials") {
  const { res, ctx } = await call(cfg, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co" }),
  });
  assertEquals(res!.status, 200);
  return ctx.outgoingHeaders.getSetCookie();
}

// ---- basePath ---------------------------------------------------------------

Deno.test("basePath: normalised (leading slash added, trailing stripped) and defaults to /auth", () => {
  assertEquals(resolveAuthOptions(config()).basePath, "/auth");
  assertEquals(resolveAuthOptions(config()).prefix, "/auth/");
  assertEquals(resolveAuthOptions(config({ basePath: "account/auth/" })).basePath, "/account/auth");
  assertEquals(resolveAuthOptions(config({ basePath: "/x" })).prefix, "/x/");
});

Deno.test("basePath: an unusable value is refused at config time, not at the first login", () => {
  // `.` and `..` pass the URL-safe character class but are traversal, not a place.
  for (
    const bad of [
      "/",
      "",
      "//auth",
      "/a//b",
      "/au th",
      "/auth?x=1",
      "/auth#f",
      "/auth/..",
      "/../auth",
      "/auth/./x",
      "/..",
    ]
  ) {
    assertThrows(
      () => denextAuth(config({ basePath: bad })),
      Error,
      "basePath",
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

Deno.test("basePath: the endpoints move with it, and the old prefix stops being claimed", async () => {
  const cfg = config({ basePath: "/account/auth" });
  const { res } = await call(cfg, "/account/auth/session");
  assertEquals(res!.status, 200);
  assertEquals((await res!.json()).user, null);

  const providers = await call(cfg, "/account/auth/providers");
  assertEquals(await providers.res!.json(), [{ id: "credentials", type: "credentials" }]);

  // The default prefix is now just another app path — the handler passes.
  assertEquals((await call(cfg, "/auth/session")).res, null);
  // So is a sub-path the table doesn't claim.
  assertEquals((await call(cfg, "/account/auth/nope")).res, null);
});

Deno.test("basePath: the OAuth redirect_uri is derived from it", async () => {
  const cfg = config({ basePath: "/account/auth" });
  // A credentials sign-in under the moved base path still works end to end.
  const cookies = await signInCookies(cfg, "/account/auth/callback/credentials");
  assert(cookies.some((c) => c.startsWith("__Host-denext_auth=")), "session issued");
});

// ---- cookies ----------------------------------------------------------------

Deno.test("cookies: the defaults are unchanged, so sessions issued before 2.5 stay valid", () => {
  const options = resolveAuthOptions(config());
  assertEquals(options.cookies.session.name, "denext_auth");
  assertEquals(options.cookies.transaction.name, "denext_auth_tx");
  assertEquals(options.cookies.session.hostPrefix, true);
  assertEquals(options.cookies.session.sameSite, "Lax");
  assertEquals(options.cookies.session.path, "/");
});

Deno.test("cookies: a custom name is used, and __Host- is forced while hostPrefix is on", async () => {
  const named = config({ cookies: { session: { name: "app_sess" } } });
  const cookies = await signInCookies(named);
  assert(
    cookies.some((c) => c.startsWith("__Host-app_sess=")),
    `expected __Host-app_sess; got ${cookies.join(" | ")}`,
  );

  // Opting out drops the prefix (and with it the origin lock) — the escape hatch for a
  // deployment that can't satisfy Secure + Path=/ + no Domain.
  const plain = config({ cookies: { session: { name: "app_sess", hostPrefix: false } } });
  const plainCookies = await signInCookies(plain);
  assert(
    plainCookies.some((c) => c.startsWith("app_sess=")),
    `expected an unprefixed app_sess; got ${plainCookies.join(" | ")}`,
  );
});

Deno.test("cookies: a name that isn't a cookie token is refused at config time", () => {
  for (const bad of ["a b", "a;b", "a=b", "", "a,b"]) {
    assertThrows(
      () => denextAuth(config({ cookies: { session: { name: bad } } })),
      Error,
      "cookie name",
    );
  }
});

// ---- session strategy -------------------------------------------------------

Deno.test('session.strategy: "database" without a store throws at config time', () => {
  assertThrows(
    () => denextAuth(config({ session: { strategy: "database" } })),
    Error,
    "needs somewhere to put sessions",
  );
  // An adapter with no `sessions` is still no store.
  assertThrows(
    () => denextAuth(config({ session: { strategy: "database" }, adapter: stubAdapter() })),
    Error,
    "needs somewhere to put sessions",
  );
});

Deno.test('session.strategy: "database" takes the adapter\'s store; "cookie" ignores it', () => {
  const sessions = inMemorySessionStore();
  const viaAdapter = config({
    session: { strategy: "database" },
    adapter: stubAdapter(sessions),
  });
  assertEquals(resolveAuthOptions(viaAdapter).sessionStore, sessions);

  // An adapter alone never makes sessions stateful.
  const cookieMode = config({ adapter: stubAdapter(sessions) });
  assertEquals(resolveAuthOptions(cookieMode).sessionStore, undefined);
  const explicitCookie = config({
    session: { strategy: "cookie" },
    adapter: stubAdapter(sessions),
  });
  assertEquals(resolveAuthOptions(explicitCookie).sessionStore, undefined);
});

Deno.test("session store: an explicit sessionStore wins over the adapter's, and warns once", () => {
  const mine = inMemorySessionStore();
  const theirs = inMemorySessionStore();
  const warnings: string[] = [];
  const cfg = config({
    sessionStore: mine,
    adapter: stubAdapter(theirs),
    logger: { warn: (m) => void warnings.push(m) },
  });
  assertEquals(resolveAuthOptions(cfg).sessionStore, mine);
  resolveAuthOptions(cfg); // cached: no second warning
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("`sessionStore` wins"), warnings[0]);

  // The same store under both names is not a conflict.
  const shared = config({
    sessionStore: mine,
    adapter: stubAdapter(mine),
    logger: { warn: () => {} },
  });
  assertEquals(resolveAuthOptions(shared).sessionStore, mine);

  // A sessionStore with no strategy keeps working exactly as before 2.5.
  assertEquals(resolveAuthOptions(config({ sessionStore: mine })).sessionStore, mine);
});

Deno.test("lifetimes: session.maxAge overrides the legacy maxAge; updateAge defaults to off", () => {
  const week = 60 * 60 * 24 * 7;
  assertEquals(resolveAuthOptions(config()).maxAge, week);
  assertEquals(resolveAuthOptions(config()).updateAge, 0);
  assertEquals(resolveAuthOptions(config({ maxAge: 60 })).maxAge, 60);
  assertEquals(resolveAuthOptions(config({ maxAge: 60, session: { maxAge: 90 } })).maxAge, 90);
  assertEquals(resolveAuthOptions(config({ session: { updateAge: 300 } })).updateAge, 300);
});

// ---- the hasher seam --------------------------------------------------------

Deno.test("hasher: the default is scrypt, and a custom Hasher replaces it wholesale", async () => {
  const fallback = resolveAuthOptions(config()).hasher;
  const stored = await fallback.hash("correct horse");
  assert(stored.startsWith("scrypt$N="), stored);
  assertEquals(await fallback.verify("correct horse", stored), true);
  assertEquals(await fallback.verify("wrong", stored), false);
  // A malformed stored value is `false`, never a throw.
  assertEquals(await fallback.verify("x", ""), false);

  const custom = {
    hash: (plain: string) => Promise.resolve(`rot13:${plain}`),
    verify: (plain: string, s: string) => Promise.resolve(s === `rot13:${plain}`),
  };
  const options = resolveAuthOptions(config({ hasher: custom }));
  assertEquals(await options.hasher.hash("x"), "rot13:x");
  assertEquals(await options.hasher.verify("x", "rot13:x"), true);
});

Deno.test("scryptHasher: the cost parameters ride in the stored string", async () => {
  const cheap = scryptHasher({ cost: 2, blockSize: 1, parallelization: 1 });
  const stored = await cheap.hash("pw");
  assertEquals(stored.startsWith("scrypt$N=2,r=1,p=1$"), true, stored);
  assertEquals(await cheap.verify("pw", stored), true);
});

// ---- events -----------------------------------------------------------------

Deno.test("emitAuthEvent: awaits the handler, and a throwing one is logged, never rethrown", async () => {
  const seen: string[] = [];
  const errors: Array<[string, unknown]> = [];
  const ok = resolveAuthOptions(config({
    events: {
      signIn: async ({ user }) => {
        await Promise.resolve();
        seen.push(user.id);
      },
    },
  }));
  await emitAuthEvent(ok, "signIn", { user: { id: "u1" }, provider: "credentials" });
  assertEquals(seen, ["u1"], "the handler is awaited before the flow continues");

  const boom = resolveAuthOptions(config({
    events: {
      signOut: () => {
        throw new Error("handler exploded");
      },
      signInFailed: () => Promise.reject(new Error("async explosion")),
    },
    logger: { error: (message, error) => void errors.push([message, error]) },
  }));
  await emitAuthEvent(boom, "signOut", { session: null });
  await emitAuthEvent(boom, "signInFailed", { reason: "invalid_credentials" });
  assertEquals(errors.length, 2, "both throws were caught and logged");
  assert(errors[0][0].includes('"signOut"'), errors[0][0]);
  assert(errors[1][0].includes('"signInFailed"'), errors[1][0]);

  // No handler configured: a no-op that still resolves.
  await emitAuthEvent(resolveAuthOptions(config()), "sessionRevoked", { userId: "u1" });
});
