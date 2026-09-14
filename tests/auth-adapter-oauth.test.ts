// Adapter persistence at the ROUTE level: what a real `/auth/signin/:p` →
// `/auth/callback/:p` round-trip (and a credentials POST) writes through a configured
// `AuthAdapter`, and which identity the session then carries. The linking MATRIX itself is
// unit-tested in tests/auth-adapter.test.ts; what is asserted here is the wiring — the
// account row, the tokens on it, the adapter id in the session, the `?error=
// account_not_linked` refusal, the credentials path's generic 401, and the fact that an
// app with NO adapter still gets exactly the session it got before 2.5.

import { assert, assertEquals } from "@std/assert";
import type { AdapterAccount, AdapterUser, AuthAdapter } from "../src/server/auth/adapter.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import type {
  AuthConfig,
  AuthProvider,
  AuthUser,
  OAuthProvider,
} from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

// ---- harness ---------------------------------------------------------------

/** Run the auth handler inside a fresh request context. */
async function run(
  request: Request,
  config: AuthConfig,
): Promise<{ res: Response | null; ctx: RequestContext }> {
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res, ctx };
}

/** Everything the app's `events` + `logger` observed, in order. */
interface EventLog {
  /** Event names in the order they fired. */
  names: string[];
  /** Each `createUser` payload's record. */
  created: AdapterUser[];
  /** Each `linkAccount` payload. */
  linked: { user: AdapterUser; account: AdapterAccount }[];
  /** Each `signIn` payload. */
  signedIn: { user: AuthUser; provider: string }[];
  /** Each `signInFailed` payload. */
  failed: { provider?: string; reason: string }[];
  /** Messages the framework routed to `logger.error`. */
  errors: string[];
}

/**
 * An auth app wired to a recording `events` + `logger`.
 *
 * @param providers The providers to configure.
 * @param adapter The persistence adapter, or `undefined` for the pre-2.5 behaviour.
 * @returns The config to hand `run`, and the recorder.
 */
function harness(
  providers: AuthProvider[],
  adapter?: AuthAdapter,
): { config: AuthConfig; log: EventLog } {
  const log: EventLog = {
    names: [],
    created: [],
    linked: [],
    signedIn: [],
    failed: [],
    errors: [],
  };
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true, // route provider fetches through the stub
    providers,
    adapter,
    logger: { error: (message) => void log.errors.push(message) },
    events: {
      createUser: ({ user }) => {
        log.names.push("createUser");
        log.created.push(user);
      },
      linkAccount: ({ user, account }) => {
        log.names.push("linkAccount");
        log.linked.push({ user, account });
      },
      signIn: ({ user, provider }) => {
        log.names.push("signIn");
        log.signedIn.push({ user, provider });
      },
      signInFailed: ({ provider, reason }) => {
        log.names.push("signInFailed");
        log.failed.push({ provider, reason });
      },
    },
  };
  return { config, log };
}

// ---- a fake OAuth provider (no id_token: the linking wiring, not the crypto) ----

/** What the fake provider hands back on the next round-trip. */
interface IdpState {
  /** The token endpoint's response body. */
  tokens: Record<string, unknown>;
  /** The userinfo endpoint's response body. */
  userinfo: Record<string, unknown>;
}

/** The token set every provider below returns unless a test says otherwise. */
function tokenSet(): Record<string, unknown> {
  return {
    access_token: "at-1",
    refresh_token: "rt-1",
    id_token: "id-1",
    token_type: "bearer",
    expires_in: 3600,
    scope: "openid email",
  };
}

/**
 * A plain OAuth provider served from `https://<id>.test`, whose mapper exposes the
 * userinfo `sub` / `email` / `email_verified` — the three fields the linking rules read.
 *
 * @param id The provider id (and its host prefix).
 * @param extra Provider fields to override (e.g. `allowDangerousEmailAccountLinking`).
 * @returns The provider.
 */
function fakeProvider(id: string, extra: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id,
    type: "oauth",
    authorizationUrl: `https://${id}.test/authorize`,
    tokenUrl: `https://${id}.test/token`,
    userinfoUrl: `https://${id}.test/userinfo`,
    scopes: ["openid", "email"],
    clientId: `client-${id}`,
    clientSecret: "shh",
    profile: ({ userinfo }) => ({
      id: String(userinfo?.sub ?? ""),
      email: typeof userinfo?.email === "string" ? userinfo.email : undefined,
      emailVerified: userinfo?.email_verified === true,
      name: typeof userinfo?.name === "string" ? userinfo.name : undefined,
    }),
    ...extra,
  };
}

/** One account at the fake provider: what its userinfo will say. */
function idp(sub: string, email: string, emailVerified: boolean): IdpState {
  return { tokens: tokenSet(), userinfo: { sub, email, email_verified: emailVerified } };
}

/** Serve the fake providers' token + userinfo endpoints through the platform `fetch`. */
async function withIdps<T>(idps: Record<string, IdpState>, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const reply = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any) => {
    const url = new URL(String(input));
    const state = idps[url.host.split(".")[0]];
    if (!state) return Promise.resolve(new Response("no such provider", { status: 404 }));
    if (url.pathname === "/token") return Promise.resolve(reply(state.tokens));
    if (url.pathname === "/userinfo") return Promise.resolve(reply(state.userinfo));
    return Promise.resolve(new Response("not found", { status: 404 }));
    // deno-lint-ignore no-explicit-any
  }) as any;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** The `Set-Cookie` values a response produced. */
function setCookies(ctx: RequestContext): string[] {
  return ctx.outgoingHeaders.getSetCookie();
}

/** The `name=value` pair of a cookie this response set, if it set one. */
function cookiePair(ctx: RequestContext, name: string): string | undefined {
  const set = setCookies(ctx).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
  return set?.split(";")[0];
}

/**
 * A full OAuth round-trip through the real routes: `/signin/:p` for the transaction
 * cookie, then `/callback/:p` carrying it with the `state` the first leg minted.
 *
 * @param config The auth config.
 * @param providerId Which provider to sign in with.
 * @param idps What each fake provider should answer.
 * @returns The callback's response and context.
 */
async function oauthLogin(
  config: AuthConfig,
  providerId: string,
  idps: Record<string, IdpState>,
): Promise<{ res: Response | null; ctx: RequestContext }> {
  const start = await run(new Request(`${ORIGIN}/auth/signin/${providerId}`), config);
  const location = new URL(start.res!.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const tx = cookiePair(start.ctx, "__Host-denext_auth_tx")!;
  return await withIdps(idps, () =>
    run(
      new Request(`${ORIGIN}/auth/callback/${providerId}?code=abc&state=${state}`, {
        headers: { cookie: tx },
      }),
      config,
    ));
}

/**
 * The user `GET /auth/session` reports for the session cookie a response set — i.e. the
 * identity the app will actually see, read back through a real request.
 *
 * @param config The auth config.
 * @param ctx The context of the response that issued the session.
 * @returns The session user, or `null` when no session was issued.
 */
async function sessionUser(config: AuthConfig, ctx: RequestContext): Promise<AuthUser | null> {
  const pair = cookiePair(ctx, "__Host-denext_auth");
  if (!pair) return null;
  const { res } = await run(
    new Request(`${ORIGIN}/auth/session`, {
      headers: { cookie: pair, accept: "application/json" },
    }),
    config,
  );
  return (await res!.json()).user;
}

/** A credentials POST as an API client makes it. */
function credentialsPost(body: Record<string, string>): Request {
  return new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

// ---- OAuth: create, reuse, link --------------------------------------------

Deno.test("adapter + OAuth: the first login creates the user, links the account, and the session carries the ADAPTER id", async (t) => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness([fakeProvider("acme")], adapter);
  const idps = { acme: idp("sub-1", "ada@x.test", true) };

  const login = await oauthLogin(config, "acme", idps);
  assertEquals(login.res!.status, 303);
  assertEquals(login.res!.headers.get("location"), "/");

  const stored = await adapter.getUserByEmail("ada@x.test");
  assert(stored, "the sign-in created an adapter user");

  await t.step("the session is the adapter's identity, not the provider's `sub`", async () => {
    const user = await sessionUser(config, login.ctx);
    assertEquals(user?.id, stored!.id);
    assert(user!.id !== "sub-1", "`session.user.id` is the adapter id, not the provider sub");
    assertEquals(user?.email, "ada@x.test");
  });

  await t.step("the account row names the provider account and carries its tokens", async () => {
    const accounts = await adapter.listAccounts!(stored!.id);
    assertEquals(accounts.length, 1);
    const [account] = accounts;
    assertEquals(account.userId, stored!.id);
    assertEquals(account.provider, "acme");
    assertEquals(account.providerAccountId, "sub-1");
    assertEquals(account.type, "oauth");
    assertEquals(account.accessToken, "at-1");
    assertEquals(account.refreshToken, "rt-1");
    assertEquals(account.idToken, "id-1");
    assertEquals(account.tokenType, "bearer");
    assertEquals(account.scope, "openid email");
    const now = Math.floor(Date.now() / 1000);
    assert(
      account.expiresAt! > now + 3500 && account.expiresAt! <= now + 3600,
      `expires_in became an absolute expiry; got ${account.expiresAt}`,
    );
  });

  await t.step("createUser → linkAccount → signIn fired, with the documented payloads", () => {
    assertEquals(log.names, ["createUser", "linkAccount", "signIn"]);
    assertEquals(log.created[0].id, stored!.id);
    assertEquals(log.created[0].email, "ada@x.test");
    assertEquals(log.linked[0].user.id, stored!.id);
    assertEquals(log.linked[0].account.providerAccountId, "sub-1");
    assertEquals(log.linked[0].account.userId, stored!.id);
    assertEquals(log.signedIn[0].provider, "acme");
    assertEquals(log.signedIn[0].user.id, stored!.id);
  });
});

Deno.test("adapter + OAuth: a second login with the same account reuses the user (no second record)", async () => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness([fakeProvider("acme")], adapter);
  const idps = { acme: idp("sub-1", "ada@x.test", true) };

  const first = await oauthLogin(config, "acme", idps);
  const second = await oauthLogin(config, "acme", idps);
  assertEquals(second.res!.status, 303);

  const stored = (await adapter.getUserByEmail("ada@x.test"))!;
  assertEquals((await sessionUser(config, first.ctx))?.id, stored.id);
  assertEquals((await sessionUser(config, second.ctx))?.id, stored.id, "the same identity");
  assertEquals(log.created.length, 1, "the account fast path created nothing the second time");
  assertEquals(log.linked.length, 1, "and linked nothing the second time");
  assertEquals((await adapter.listAccounts!(stored.id)).length, 1);
});

Deno.test("adapter + OAuth: a second provider with the same VERIFIED email links to the one user", async () => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness([fakeProvider("acme"), fakeProvider("beta")], adapter);
  const idps = {
    acme: idp("sub-1", "ada@x.test", true),
    beta: idp("beta-9", "ada@x.test", true),
  };

  await oauthLogin(config, "acme", idps);
  const second = await oauthLogin(config, "beta", idps);
  assertEquals(second.res!.status, 303);

  const stored = (await adapter.getUserByEmail("ada@x.test"))!;
  assertEquals((await sessionUser(config, second.ctx))?.id, stored.id);
  assertEquals(log.created.length, 1, "one user");
  const accounts = await adapter.listAccounts!(stored.id);
  assertEquals(accounts.length, 2, "two linked accounts");
  assertEquals(accounts.map((a) => a.provider).sort(), ["acme", "beta"]);
});

// ---- OAuth: the refusal ----------------------------------------------------

Deno.test("adapter + OAuth: an email match that rests on an UNVERIFIED address is refused", async (t) => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness([fakeProvider("acme"), fakeProvider("beta")], adapter);
  const idps = {
    acme: idp("sub-1", "ada@x.test", true),
    beta: idp("beta-9", "ada@x.test", false), // the second provider never checked it
  };

  await oauthLogin(config, "acme", idps);
  const refused = await oauthLogin(config, "beta", idps);

  await t.step("the callback redirects with ?error=account_not_linked (never a 500)", () => {
    assertEquals(refused.res!.status, 303);
    assertEquals(refused.res!.headers.get("location"), "/?error=account_not_linked");
  });

  await t.step("no session is issued and nothing is linked", async () => {
    assertEquals(await sessionUser(config, refused.ctx), null);
    const stored = (await adapter.getUserByEmail("ada@x.test"))!;
    assertEquals((await adapter.listAccounts!(stored.id)).length, 1);
    assertEquals(
      await adapter.getUserByAccount({ provider: "beta", providerAccountId: "beta-9" }),
      undefined,
    );
  });

  await t.step("the app hears about it through signInFailed + the logger", () => {
    assertEquals(log.failed.at(-1), { provider: "beta", reason: "account_not_linked" });
    assertEquals(log.signedIn.length, 1, "only the first provider signed in");
    assert(
      log.errors.some((m) => m.includes('refused to link the "beta" sign-in')),
      `the refusal reached logger.error; got ${JSON.stringify(log.errors)}`,
    );
  });
});

Deno.test("adapter + OAuth: allowDangerousEmailAccountLinking links the unverified match anyway", async () => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness(
    [fakeProvider("acme"), fakeProvider("beta", { allowDangerousEmailAccountLinking: true })],
    adapter,
  );
  const idps = {
    acme: idp("sub-1", "ada@x.test", true),
    beta: idp("beta-9", "ada@x.test", false),
  };

  await oauthLogin(config, "acme", idps);
  const second = await oauthLogin(config, "beta", idps);
  assertEquals(second.res!.status, 303);
  assertEquals(second.res!.headers.get("location"), "/");

  const stored = (await adapter.getUserByEmail("ada@x.test"))!;
  assertEquals((await sessionUser(config, second.ctx))?.id, stored.id);
  assertEquals((await adapter.listAccounts!(stored.id)).length, 2);
  assertEquals(log.failed.length, 0);
});

// ---- credentials -----------------------------------------------------------

Deno.test("adapter + credentials: the session carries the adapter id and a credentials account row exists", async () => {
  const adapter = inMemoryAuthAdapter();
  const { config, log } = harness([
    credentials({
      authorize: ({ email, password }) =>
        email === "ada@x.test" && password === "pw"
          ? { id: "local-1", email, emailVerified: true }
          : null,
    }),
  ], adapter);

  const { res, ctx } = await run(
    credentialsPost({ email: "ada@x.test", password: "pw" }),
    config,
  );
  assertEquals(res!.status, 200);

  const stored = (await adapter.getUserByEmail("ada@x.test"))!;
  assert(stored.id !== "local-1", "the adapter minted the id, not `authorize()`");
  assertEquals((await res!.json()).user.id, stored.id);
  assertEquals((await sessionUser(config, ctx))?.id, stored.id);

  const accounts = await adapter.listAccounts!(stored.id);
  assertEquals(accounts.length, 1);
  assertEquals(accounts[0].provider, "credentials");
  assertEquals(accounts[0].providerAccountId, "local-1");
  assertEquals(accounts[0].type, "credentials");
  assertEquals(accounts[0].accessToken, undefined, "a credentials login carries no tokens");
  assertEquals(log.names, ["createUser", "linkAccount", "signIn"]);
});

Deno.test("adapter + credentials: a linking refusal is the SAME generic 401 a wrong password gets", async (t) => {
  const adapter = inMemoryAuthAdapter();
  // An existing local account with an address nobody ever verified.
  await adapter.createUser({ email: "ada@x.test" });
  const { config, log } = harness([
    credentials({
      authorize: ({ email, password }) =>
        email === "ada@x.test" && password === "pw"
          ? { id: "local-1", email, emailVerified: true }
          : null,
    }),
  ], adapter);

  const refused = await run(credentialsPost({ email: "ada@x.test", password: "pw" }), config);
  const wrongPassword = await run(credentialsPost({ email: "ada@x.test", password: "no" }), config);

  await t.step("the two refusals are indistinguishable to the client", async () => {
    assertEquals(refused.res!.status, 401);
    assertEquals(wrongPassword.res!.status, 401);
    assertEquals(await refused.res!.json(), await wrongPassword.res!.json());
    assertEquals(await sessionUser(config, refused.ctx), null);
  });

  await t.step("but the APP is told the real reason", () => {
    assertEquals(log.failed[0], { provider: "credentials", reason: "account_not_linked" });
    assert(
      log.errors.some((m) => m.includes('refused to link the "credentials" sign-in')),
      `the refusal reached logger.error; got ${JSON.stringify(log.errors)}`,
    );
    assertEquals(log.signedIn.length, 0);
  });
});

// ---- no adapter: byte-for-byte the pre-2.5 behaviour ------------------------

Deno.test("no adapter: the session id is the provider's own id, exactly as before", async (t) => {
  await t.step("OAuth — `session.user.id` is the provider `sub`", async () => {
    const { config, log } = harness([fakeProvider("acme")]);
    const login = await oauthLogin(config, "acme", { acme: idp("sub-1", "ada@x.test", true) });
    assertEquals(login.res!.status, 303);
    assertEquals((await sessionUser(config, login.ctx))?.id, "sub-1");
    assertEquals(log.names, ["signIn"], "no adapter, so no createUser/linkAccount");
  });

  await t.step("credentials — `session.user.id` is whatever `authorize()` returned", async () => {
    const { config, log } = harness([
      credentials({
        authorize: ({ email, password }) =>
          email === "ada@x.test" && password === "pw" ? { id: "local-1", email } : null,
      }),
    ]);
    const { res, ctx } = await run(
      credentialsPost({ email: "ada@x.test", password: "pw" }),
      config,
    );
    assertEquals(res!.status, 200);
    assertEquals((await res!.json()).user.id, "local-1");
    assertEquals((await sessionUser(config, ctx))?.id, "local-1");
    assertEquals(log.names, ["signIn"]);
  });
});
