// The adapter-backed default a Credentials provider gets when it has no `authorize`:
// `getUserByEmail` → `getCredential` → the configured `Hasher`. Asserted here: the
// sign-in it produces (the adapter's record IS the session user, no account linking), the
// byte-identical generic 401 for every way it refuses, equal hasher work for an unknown
// address, the limiter counting its failures, the config-time refusal when nothing could
// verify a login, and that a provider WITH `authorize` never touches it.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { AuthAdapter } from "../src/server/auth/adapter.ts";
import { type Hasher, scryptHasher } from "../src/server/auth/hasher.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import type { AuthConfig, AuthUser, CredentialsProvider } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const EMAIL = "ada@x.test";

/** A Credentials provider with no `authorize` — the one the default serves. */
const DEFAULT_PROVIDER: CredentialsProvider = { id: "credentials", type: "credentials" };

// ---- harness ---------------------------------------------------------------

/** What the app's `events` + `logger` observed. */
interface Log {
  /** Event names in the order they fired. */
  names: string[];
  /** Each `signInFailed` reason. */
  failed: string[];
  /** Messages routed to `logger.error`. */
  errors: string[];
}

/** A Hasher that records the `stored` value of every `verify`, delegating to `inner`. */
function spyHasher(inner: Hasher = scryptHasher()): { hasher: Hasher; verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    hasher: {
      hash: (plain) => inner.hash(plain),
      verify: (plain, stored) => {
        verified.push(stored);
        return inner.verify(plain, stored);
      },
    },
  };
}

/**
 * An in-memory adapter holding one user (unverified address, an `admin` role) whose
 * password hash was written by `hashPassword` — or by `hasher.hash` when given.
 */
async function seeded(
  password = "pw",
  hasher?: Hasher,
): Promise<{ adapter: AuthAdapter; userId: string }> {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL, name: "Ada", roles: ["admin"] });
  const hash = hasher ? await hasher.hash(password) : await hashPassword(password);
  await adapter.setCredential!(user.id, hash);
  return { adapter, userId: user.id };
}

/** An auth app on `adapter` with a recording `events` + `logger`. */
function harness(
  adapter: AuthAdapter | undefined,
  overrides: Partial<AuthConfig> = {},
): { config: AuthConfig; log: Log } {
  const log: Log = { names: [], failed: [], errors: [] };
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [DEFAULT_PROVIDER],
    adapter,
    logger: { error: (message) => void log.errors.push(message) },
    events: {
      createUser: () => void log.names.push("createUser"),
      linkAccount: () => void log.names.push("linkAccount"),
      signIn: () => void log.names.push("signIn"),
      signInFailed: ({ reason }) => {
        log.names.push("signInFailed");
        log.failed.push(reason);
      },
    },
    ...overrides,
  };
  return { config, log };
}

/** POST the credentials callback as a JSON API client, or as a plain HTML form. */
async function login(
  config: AuthConfig,
  body: Record<string, string>,
  form = false,
): Promise<{ res: Response; ctx: RequestContext }> {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: form
      ? { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }
      : { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res: res!, ctx };
}

/** The session cookie a response issued, as a `name=value` pair. */
function sessionCookie(ctx: RequestContext): string | undefined {
  return ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth="))
    ?.split(";")[0];
}

/** Read back the session a response issued, through `GET /auth/session`. */
async function sessionUser(config: AuthConfig, ctx: RequestContext): Promise<AuthUser | null> {
  const cookie = sessionCookie(ctx);
  if (!cookie) return null;
  const request = new Request(`${ORIGIN}/auth/session`, {
    headers: { cookie, accept: "application/json" },
  });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  );
  return (await res!.json()).user;
}

/** Everything a client can see of a refusal: status, content type, and the exact body. */
async function refusal(res: Response): Promise<[number, string | null, string]> {
  return [res.status, res.headers.get("content-type"), await res.text()];
}

// ---- sign-in -----------------------------------------------------------------

Deno.test("default authorize: the right password signs in as the adapter's record, with no account linking", async () => {
  const { adapter, userId } = await seeded();
  const { config, log } = harness(adapter);

  const { res, ctx } = await login(config, { email: EMAIL, password: "pw" });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).user.id, userId);
  assert(sessionCookie(ctx), "a session cookie was issued");

  const user = await sessionUser(config, ctx);
  assertEquals(user?.id, userId);
  assertEquals(user?.email, EMAIL);
  assertEquals(user?.roles, ["admin"], "the stored roles ride the session");
  assertEquals(user?.emailVerified, false, "an unverified address never blocks a proven password");
  assertEquals(log.names, ["signIn"], "the record IS the identity: no createUser/linkAccount");
  assertEquals(await adapter.listAccounts!(userId), []);
});

Deno.test("default authorize: a hashPassword-written hash verifies from a form post, address trimmed + case-folded", async () => {
  const { adapter } = await seeded("correct horse");
  const { config } = harness(adapter);
  const { res, ctx } = await login(config, {
    email: "  ADA@X.Test ",
    password: "correct horse",
  }, true);
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/");
  assert(sessionCookie(ctx), "a session cookie was issued");
});

// ---- refusals ----------------------------------------------------------------

Deno.test("default authorize: a wrong password is the generic 401 — JSON client and form post alike", async () => {
  const { adapter } = await seeded();
  const { config, log } = harness(adapter);
  const json = await login(config, { email: EMAIL, password: "nope" });
  const form = await login(config, { email: EMAIL, password: "nope" }, true);
  const jsonRefusal = await refusal(json.res);
  assertEquals(jsonRefusal, [
    401,
    "application/json; charset=utf-8",
    '{"error":"invalid credentials"}',
  ]);
  assertEquals(await refusal(form.res), jsonRefusal, "a form post is refused byte-identically");
  assertEquals(sessionCookie(json.ctx), undefined);
  assertEquals(sessionCookie(form.ctx), undefined);
  assertEquals(log.failed, ["invalid_credentials", "invalid_credentials"]);
});

Deno.test("default authorize: an unknown address answers byte-identically and still pays one verify", async (t) => {
  const { adapter } = await seeded();
  const spy = spyHasher();
  const { config } = harness(adapter, { hasher: spy.hasher });

  const wrong = await refusal((await login(config, { email: EMAIL, password: "nope" })).res);
  spy.verified.length = 0;
  const unknown = await refusal((await login(config, { email: "eve@x.test", password: "pw" })).res);

  await t.step("indistinguishable to the client", () => assertEquals(unknown, wrong));
  await t.step("equal work: exactly one verify, against the empty (dummy) hash", () => {
    assertEquals(spy.verified, [""]);
  });
  await t.step(
    "a hasher that wrongly accepts the dummy hash still cannot sign an unknown address in",
    async () => {
      const permissive: Hasher = {
        hash: (p) => Promise.resolve(p),
        verify: () => Promise.resolve(true),
      };
      const lax = harness(adapter, { hasher: permissive }).config;
      assertEquals((await login(lax, { email: "eve@x.test", password: "pw" })).res.status, 401);
    },
  );
});

Deno.test("default authorize: no password on file, or a missing field, is the same 401 with one verify each", async () => {
  const { adapter } = await seeded();
  await adapter.createUser({ email: "nopw@x.test" }); // a user with no credential row
  const spy = spyHasher();
  const { config } = harness(adapter, { hasher: spy.hasher });
  const baseline = await refusal((await login(config, { email: EMAIL, password: "nope" })).res);

  const bodies: Record<string, string>[] = [
    { email: "nopw@x.test", password: "pw" },
    { email: EMAIL },
    { password: "pw" },
    {},
  ];
  for (const body of bodies) {
    spy.verified.length = 0;
    const got = await refusal((await login(config, body)).res);
    assertEquals(got, baseline, JSON.stringify(body));
    assertEquals(spy.verified.length, 1, `${JSON.stringify(body)}: one verify`);
  }
});

Deno.test("default authorize: an adapter that throws is a refusal the logger hears about, never a 500", async () => {
  const { adapter } = await seeded();
  adapter.getCredential = () => {
    throw new Error("db went away");
  };
  const { config, log } = harness(adapter);
  const { res } = await login(config, { email: EMAIL, password: "pw" });
  assertEquals(await refusal(res), [
    401,
    "application/json; charset=utf-8",
    '{"error":"invalid credentials"}',
  ]);
  assert(
    log.errors.some((m) =>
      m.includes('"credentials" provider\'s adapter-backed credentials check threw')
    ),
    JSON.stringify(log.errors),
  );
});

// ---- the hasher seam + the limiter ---------------------------------------------

Deno.test("default authorize: a configured hasher is the one that verifies", async () => {
  const plain = spyHasher({
    hash: (p) => Promise.resolve(`plain$${p}`),
    verify: (p, stored) => Promise.resolve(stored === `plain$${p}`),
  });
  const { adapter } = await seeded("pw", plain.hasher);
  const { config } = harness(adapter, { hasher: plain.hasher });
  assertEquals((await login(config, { email: EMAIL, password: "pw" })).res.status, 200);
  assertEquals(plain.verified, ["plain$pw"]);
});

Deno.test("default authorize: its failures count in the limiter — a 429 once the budget is spent", async () => {
  const { adapter } = await seeded();
  const { config, log } = harness(adapter, { rateLimit: { max: 2, windowMs: 60_000 } });
  assertEquals((await login(config, { email: EMAIL, password: "a" })).res.status, 401);
  assertEquals((await login(config, { email: EMAIL, password: "b" })).res.status, 401);
  const locked = await login(config, { email: EMAIL, password: "pw" });
  assertEquals(locked.res.status, 429, "even the right password, once locked out");
  assertEquals(log.failed.at(-1), "rate_limited");

  // An unknown address is counted just the same (its own identifier bucket).
  for (const _ of [1, 2]) await login(config, { email: "eve@x.test", password: "x" });
  assertEquals((await login(config, { email: "eve@x.test", password: "x" })).res.status, 429);
});

// ---- config time ---------------------------------------------------------------

Deno.test("config: a provider without authorize and no adapter is refused at denextAuth(), naming it and both fixes", () => {
  const err = assertThrows(() =>
    denextAuth({
      secret: SECRET,
      canonicalOrigin: ORIGIN,
      trustForwardedHeaders: false,
      providers: [{ id: "password", type: "credentials" }],
    })
  );
  const message = (err as Error).message;
  assertStringIncludes(message, 'credentials provider "password" has no `authorize`');
  assertStringIncludes(message, "no `adapter` is configured");
  assertStringIncludes(message, "pass `authorize`");
  assertStringIncludes(message, "`getCredential`");
});

Deno.test("config: an adapter without the credentials group is refused at config time — and a 401 if it is bypassed", async (t) => {
  const adapter: AuthAdapter = { ...inMemoryAuthAdapter() };
  delete adapter.getCredential;
  delete adapter.setCredential;
  const spy = spyHasher();
  const { config } = harness(adapter, { hasher: spy.hasher });

  await t.step("denextAuth() throws", () => {
    const err = assertThrows(() => denextAuth(config));
    assertStringIncludes((err as Error).message, "lacks the credentials group");
  });
  await t.step(
    "the route itself (no validateConfig) answers the generic 401 after one verify",
    async () => {
      const { res } = await login(config, { email: EMAIL, password: "pw" });
      assertEquals(await refusal(res), [
        401,
        "application/json; charset=utf-8",
        '{"error":"invalid credentials"}',
      ]);
      assertEquals(spy.verified, [""]);
    },
  );
});

Deno.test("config: denextAuth() accepts a provider without authorize when the adapter has the credentials group", async () => {
  const { adapter } = await seeded();
  const plugin = denextAuth(harness(adapter).config);
  assertEquals(plugin.name, "denext-auth");
});

// ---- an app's own authorize wins ---------------------------------------------------

Deno.test("a provider WITH authorize keeps using it: the adapter default is never consulted", async () => {
  const { adapter } = await seeded();
  let credentialReads = 0;
  const read = adapter.getCredential!.bind(adapter);
  adapter.getCredential = (id) => {
    credentialReads++;
    return read(id);
  };
  const spy = spyHasher();
  const { config, log } = harness(adapter, {
    hasher: spy.hasher,
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          email === "new@x.test" && password === "app-pw"
            ? { id: "local-1", email, emailVerified: true }
            : null,
      }),
    ],
  });
  assertEquals((await login(config, { email: "new@x.test", password: "app-pw" })).res.status, 200);
  assertEquals((await login(config, { email: EMAIL, password: "pw" })).res.status, 401);
  assertEquals(credentialReads, 0);
  assertEquals(spy.verified, []);
  assertEquals(
    log.names.slice(0, 3),
    ["createUser", "linkAccount", "signIn"],
    "the linking path ran",
  );
});
