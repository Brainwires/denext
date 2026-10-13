// `/auth/v1` happy paths over raw HTTP (the unit suite; supabase-js runs the same flows in
// tests/backend-supabase-auth.test.ts): confirmation codes, refresh rotation with the grace
// window and replay revocation, resend and recovery, the pre-account-hijacking password rule,
// a phone change, OAuth through a fake provider (implicit, PKCE without the cookie, linking) and
// a native id_token sign-in.

import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig, OAuthProvider } from "../src/server/auth/types.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  query?: Record<string, string>;
  cookie?: string;
}

async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const url = new URL(path.startsWith("http") ? path : `${ORIGIN}/auth/v1${path}`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { apikey: app.publishableKey };
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.cookie) headers.cookie = call.cookie;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(url, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    redirect: "manual",
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    // deno-lint-ignore no-explicit-any
    json: (text ? JSON.parse(text) : {}) as Record<string, any>,
  };
}

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  auth: GoTrueOptions = {},
  authConfig: Partial<AuthConfig> = {},
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth,
    authConfig,
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const code = (app: SupabaseAuthApp) => app.emails.at(-1)!.token;
const password = (app: SupabaseAuthApp, email: string, pw: string) =>
  api(app, "/token", { query: { grant_type: "password" }, body: { email, password: pw } });

Deno.test("email sign-up → code → password → refresh rotation, grace and replay", async () => {
  await withApp(async (app) => {
    const signup = await api(app, "/signup", {
      body: { email: "ada@example.com", password: "first password" },
    });
    assertEquals(signup.status, 200);
    assertExists(signup.json.confirmation_sent_at);
    const verified = await api(app, "/verify", {
      body: { type: "signup", email: "ada@example.com", token: code(app) },
    });
    assertEquals(verified.status, 200);
    assertExists(verified.json.user.email_confirmed_at);
    assertEquals(verified.json.user.identities[0].identity_data.email_verified, true);
    const again = await api(app, "/signup", {
      body: { email: "ada@example.com", password: "first password" },
    });
    assertEquals(again.json.identities, [], "an obfuscated user for a confirmed address");
    const session = (await password(app, "ada@example.com", "first password")).json;
    const first = session.refresh_token;
    const rotate = (refresh_token: string) =>
      api(app, "/token", { query: { grant_type: "refresh_token" }, body: { refresh_token } });
    const second = (await rotate(first)).json;
    assertNotEquals(second.refresh_token, first);
    const grace = await rotate(first);
    assertEquals(grace.json.refresh_token, second.refresh_token, "the same pair, again");
    const third = (await rotate(second.refresh_token)).json;
    const replay = await rotate(first);
    assertEquals(replay.json.error_code, "refresh_token_already_used");
    assertEquals((await rotate(third.refresh_token)).json.error_code, "refresh_token_already_used");
    assertEquals(
      (await api(app, "/user", { token: third.access_token })).json.error_code,
      "session_not_found",
    );
    assertEquals((await rotate("garbage")).json.error_code, "refresh_token_not_found");
  });
});

Deno.test("a password set by someone else before the address is confirmed does not survive", async () => {
  await withApp(async (app) => {
    // The owner signs up; their confirmation code binds their password.
    await api(app, "/signup", { body: { email: "own@example.com", password: "owner password" } });
    const ownerCode = code(app);
    // A retry with the same password keeps it (and replaces the code).
    await api(app, "/signup", { body: { email: "own@example.com", password: "owner password" } });
    const retryCode = code(app);
    assertEquals(
      (await api(app, "/verify", {
        body: { type: "signup", email: "own@example.com", token: ownerCode },
      })).status,
      403,
      "the reissue retired the older code",
    );
    // An attacker signs up for the same (unconfirmed) address with their own password: a
    // different password clears the account's, and the new code (in the owner's inbox) binds none.
    await api(app, "/signup", { body: { email: "own@example.com", password: "attacker pass" } });
    assert(retryCode !== code(app));
    const confirmed = await api(app, "/verify", {
      body: { type: "signup", email: "own@example.com", token: code(app) },
    });
    assertEquals(confirmed.status, 200);
    assert(confirmed.json.access_token, "confirming signs the owner in");
    for (const guess of ["attacker pass", "owner password"]) {
      assertEquals(
        (await password(app, "own@example.com", guess)).json.error_code,
        "invalid_credentials",
      );
    }
  });
});

Deno.test("resend, recovery and the resend of an SMS sign-up", async () => {
  await withApp(async (app) => {
    await api(app, "/signup", { body: { email: "re@example.com", password: "a password!" } });
    const before = app.emails.length;
    assertEquals(
      (await api(app, "/resend", { body: { type: "signup", email: "re@example.com" } })).status,
      200,
    );
    assertEquals(app.emails.length, before + 1);
    assertEquals(
      (await api(app, "/resend", { body: { type: "bogus", email: "re@example.com" } })).json
        .error_code,
      "validation_failed",
    );
    assertEquals(
      (await api(app, "/resend", { body: { type: "signup" } })).json.error_code,
      "validation_failed",
    );
    await api(app, "/verify", {
      body: { type: "signup", email: "re@example.com", token: code(app) },
    });
    // A confirmed address: resend sends nothing, and answers the same.
    const sent = app.emails.length;
    assertEquals(
      (await api(app, "/resend", { body: { type: "signup", email: "re@example.com" } })).status,
      200,
    );
    assertEquals(app.emails.length, sent);
    // Recovery by code.
    assertEquals((await api(app, "/recover", { body: { email: "re@example.com" } })).status, 200);
    const recovered = await api(app, "/verify", {
      body: { type: "recovery", email: "re@example.com", token: code(app) },
    });
    assertEquals(recovered.json.user.email, "re@example.com");
    assertEquals((await api(app, "/recover", { body: {} })).json.error_code, "validation_failed");
    // SMS sign-up resend.
    await api(app, "/signup", { body: { phone: "+15555550150", password: "a password!" } });
    const sms = app.sms.length;
    await api(app, "/resend", { body: { type: "sms", phone: "+15555550150" } });
    assertEquals(app.sms.length, sms + 1);
  });
});

Deno.test("a phone change is confirmed by an SMS code", async () => {
  await withApp(async (app) => {
    await app.fetch(`${ORIGIN}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: app.secretKey, "content-type": "application/json" },
      body: JSON.stringify({
        email: "p@example.com",
        password: "a password!",
        email_confirm: true,
      }),
    });
    const { access_token } = (await password(app, "p@example.com", "a password!")).json;
    const put = await api(app, "/user", {
      token: access_token,
      method: "PUT",
      body: { phone: "+15555550160" },
    });
    assertEquals(put.status, 200);
    assertEquals(app.sms.at(-1)!.type, "phone_change");
    const done = await api(app, "/verify", {
      body: { type: "phone_change", phone: "+15555550160", token: app.sms.at(-1)!.otp },
    });
    assertEquals(done.json.user.phone, "+15555550160");
    assertExists(done.json.user.phone_confirmed_at);
  });
});

// ---- OAuth through a fake provider ----------------------------------------------------------

function fakeProvider(): OAuthProvider {
  return {
    id: "acme",
    type: "oauth",
    authorizationUrl: "https://acme.test/authorize",
    tokenUrl: "https://acme.test/token",
    userinfoUrl: "https://acme.test/userinfo",
    scopes: ["email"],
    clientId: "client",
    clientSecret: "shh",
    profile: ({ userinfo }) => ({
      id: String(userinfo?.sub ?? ""),
      email: typeof userinfo?.email === "string" ? userinfo.email : undefined,
      emailVerified: userinfo?.email_verified === true,
      name: typeof userinfo?.name === "string" ? userinfo.name : undefined,
    }),
  };
}

async function withProvider<T>(
  userinfo: Record<string, unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "acme.test") return original(input);
    if (url.pathname === "/token") {
      return Promise.resolve(Response.json({ access_token: "provider-at", token_type: "bearer" }));
    }
    return Promise.resolve(Response.json(userinfo));
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const OAUTH_CONFIG = {
  providers: [fakeProvider()],
  dangerouslyAllowInsecureProviders: true,
} as Partial<AuthConfig>;

/** Run /authorize, then the provider's callback, as a browser would. */
async function oauthRound(
  app: SupabaseAuthApp,
  start: string,
  query: Record<string, string>,
  userinfo: Record<string, unknown>,
  opts: { token?: string; withCookie?: boolean } = {},
) {
  const started = await api(app, start, {
    query: { provider: "acme", ...query },
    token: opts.token,
  });
  const providerUrl = new URL(
    started.headers.get("location") ?? started.json.url,
  );
  const state = providerUrl.searchParams.get("state")!;
  const cookie = started.headers.get("set-cookie")?.split(";")[0];
  return await withProvider(
    userinfo,
    () =>
      api(app, `${ORIGIN}/auth/callback/acme?code=c&state=${state}`, {
        cookie: opts.withCookie === false ? undefined : cookie,
      }),
  );
}

Deno.test("OAuth: implicit sign-in lands with tokens; a refusal lands with an error", async () => {
  await withApp(
    async (app) => {
      const res = await oauthRound(app, "/authorize", { redirect_to: `${ORIGIN}/after` }, {
        sub: "gh-1",
        email: "oa@example.com",
        email_verified: true,
        name: "Oa",
      });
      assertEquals(res.status, 303);
      const landing = new URL(res.headers.get("location")!);
      assertEquals(landing.pathname, "/after");
      const fragment = new URLSearchParams(landing.hash.slice(1));
      assertEquals(fragment.get("provider_token"), "provider-at");
      const user = (await api(app, "/user", { token: fragment.get("access_token")! })).json;
      assertEquals(user.app_metadata.provider, "acme");
      assert(user.identities.some((i: { provider: string }) => i.provider === "acme"));
      // A provider error lands on redirect_to with the error.
      const started = await api(app, "/authorize", {
        query: { provider: "acme", redirect_to: `${ORIGIN}/after` },
      });
      const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
      const denied = await api(
        app,
        `${ORIGIN}/auth/callback/acme?error=access_denied&state=${state}`,
        {
          cookie: started.headers.get("set-cookie")!.split(";")[0],
        },
      );
      assertEquals(
        new URLSearchParams(new URL(denied.headers.get("location")!).hash.slice(1)).get("error"),
        "access_denied",
      );
    },
    {},
    OAUTH_CONFIG,
  );
});

Deno.test("OAuth: a PKCE flow finishes without the cookie; linkIdentity links on the exchange", async () => {
  await withApp(
    async (app) => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      const pkce = {
        code_challenge: challenge,
        code_challenge_method: "s256",
        redirect_to: `${ORIGIN}/cb`,
      };
      const res = await oauthRound(app, "/authorize", pkce, {
        sub: "gh-2",
        email: "pk@example.com",
        email_verified: true,
      }, {
        withCookie: false,
      });
      const authCode = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const exchanged = await api(app, "/token", {
        query: { grant_type: "pkce" },
        body: { auth_code: authCode, code_verifier: verifier },
      });
      assertEquals(exchanged.status, 200);
      assertEquals(exchanged.json.provider_token, "provider-at");
      // Linking: a second identity for an email user, deferred to the exchange.
      await app.fetch(`${ORIGIN}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: app.secretKey, "content-type": "application/json" },
        body: JSON.stringify({
          email: "link@example.com",
          password: "a password!",
          email_confirm: true,
        }),
      });
      const session = (await password(app, "link@example.com", "a password!")).json;
      const linked = await oauthRound(app, "/user/identities/authorize", pkce, {
        sub: "gh-3",
        email: "other@example.com",
      }, {
        token: session.access_token,
        withCookie: false,
      });
      const linkCode = new URL(linked.headers.get("location")!).searchParams.get("code")!;
      const before = (await api(app, "/user", { token: session.access_token })).json;
      assertEquals(before.identities.length, 1, "nothing linked before the exchange");
      const done = await api(app, "/token", {
        query: { grant_type: "pkce" },
        body: { auth_code: linkCode, code_verifier: verifier },
      });
      assertEquals(done.status, 200);
      const after = (await api(app, "/user", { token: done.json.access_token })).json;
      assertEquals(after.identities.length, 2);
      const acme = after.identities.find((i: { provider: string }) => i.provider === "acme");
      // Unlink it again.
      const unlinked = await api(app, `/user/identities/${acme.identity_id}`, {
        method: "DELETE",
        token: done.json.access_token,
      });
      assertEquals(unlinked.status, 200);
      // A wrong verifier.
      const res2 = await oauthRound(app, "/authorize", pkce, {
        sub: "gh-2",
        email: "pk@example.com",
        email_verified: true,
      }, {
        withCookie: false,
      });
      const code2 = new URL(res2.headers.get("location")!).searchParams.get("code")!;
      const bad = await api(app, "/token", {
        query: { grant_type: "pkce" },
        body: { auth_code: code2, code_verifier: "x".repeat(43) },
      });
      assertEquals(bad.json.error_code, "bad_code_verifier");
    },
    {},
    OAUTH_CONFIG,
  );
});

Deno.test("OAuth: an implicit flow without its cookie is refused", async () => {
  await withApp(
    async (app) => {
      const res = await oauthRound(
        app,
        "/authorize",
        { redirect_to: `${ORIGIN}/x` },
        { sub: "s" },
        {
          withCookie: false,
        },
      );
      // Not a GoTrue flow the server knows of: denext's own callback refuses the state.
      assertEquals(res.status, 303);
      assert(!res.headers.get("location")!.includes("access_token"));
    },
    {},
    OAUTH_CONFIG,
  );
});

// ---- native id_token --------------------------------------------------------------------------

const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

Deno.test("id_token grant: a Google id token signs in (and creates the user)", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const now = Math.floor(Date.now() / 1000);
  const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${
    enc({
      iss: "https://accounts.google.com",
      aud: "web-client",
      sub: "g-123",
      email: "goog@example.com",
      email_verified: true,
      name: "Goog",
      iat: now,
      exp: now + 600,
    })
  }`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  const idToken = `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
  await withApp(
    async (app) => {
      const res = await api(app, "/token", {
        query: { grant_type: "id_token" },
        body: { provider: "google", id_token: idToken },
      });
      assertEquals(res.status, 200, JSON.stringify(res.json));
      assertEquals(res.json.user.email, "goog@example.com");
      const again = await api(app, "/token", {
        query: { grant_type: "id_token" },
        body: { provider: "google", id_token: idToken },
      });
      assertEquals(again.json.user.id, res.json.user.id, "the linked identity signs in again");
      const bad = await api(app, "/token", {
        query: { grant_type: "id_token" },
        body: { provider: "google", id_token: idToken.slice(0, -4) + "AAAA" },
      });
      assertEquals(bad.json.error_code, "bad_oauth_callback");
    },
    { idTokenProviders: { google: { clientIds: ["web-client"] } } },
    {
      native: {
        redirectUris: ["myapp://cb"],
        fetch: () => Promise.resolve(Response.json({ keys: [jwk] })),
      },
    } as Partial<AuthConfig>,
  );
});
