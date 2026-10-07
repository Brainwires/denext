// OAuth 2.0 Form Post Response Mode (`responseMode: "form_post"`, the mode Sign in with Apple
// needs for a user's name and email): the authorization request asks for it, the transaction
// cookie becomes `SameSite=None; Secure` so the provider's cross-site POST carries it, the POST
// callback completes the flow with `state` + PKCE + `nonce` checked exactly as the GET does — and
// the refusals: a wrong / missing / replayed / other-provider state, the GET downgrade, a POST to
// a query-mode provider, a non-form body, an oversized one, and the provider's own `error`.

import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { apple, oidc } from "../src/server/auth/providers.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig, OAuthProvider } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const TX = "__Host-denext_auth_tx";
const SESSION = "__Host-denext_auth";

// ---- harness ---------------------------------------------------------------

/** Run the auth handler inside a fresh request context. */
async function run(
  request: Request,
  config: AuthConfig,
): Promise<{ res: Response; ctx: RequestContext }> {
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  assert(res, `${request.method} ${request.url} was claimed`);
  return { res, ctx };
}

/** Every `Set-Cookie` a response produced. */
function setCookies(ctx: RequestContext): string[] {
  return ctx.outgoingHeaders.getSetCookie();
}

/** The full `Set-Cookie` line that set (not cleared) `name`. */
function cookieLine(ctx: RequestContext, name: string): string | undefined {
  return setCookies(ctx).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
}

/** The `name=value` pair of a cookie a response set. */
function cookiePair(ctx: RequestContext, name: string): string | undefined {
  return cookieLine(ctx, name)?.split(";")[0];
}

/** Decode the signed tx cookie's payload (to read the nonce the server stored). */
function txData(pair: string): { nonce?: string; state: string } {
  const b64 = pair.split("=")[1].split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0)),
  );
  return JSON.parse(json).d;
}

/**
 * An RS256 identity provider: its JWKS and an id_token minter. Each gets its own `kid`, so the
 * process-wide JWKS cache never serves one test's key to another.
 */
async function makeIdp() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = crypto.randomUUID();
  const jwks = { keys: [{ kty: "RSA", kid, n: pub.n, e: pub.e, alg: "RS256" }] };
  const mint = async (claims: Record<string, unknown>): Promise<string> => {
    const seg = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const signing = `${seg({ alg: "RS256", typ: "JWT", kid })}.${seg(claims)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signing),
    );
    return `${signing}.${base64UrlEncode(new Uint8Array(sig))}`;
  };
  return { jwks, mint };
}

/** What the stubbed provider saw: the token-endpoint bodies. */
interface Seen {
  tokenRequests: URLSearchParams[];
}

/**
 * Stub the provider's token, JWKS and discovery endpoints (`host`), answering the token
 * endpoint with `idToken()`.
 */
async function withProvider<T>(
  host: string,
  idp: Awaited<ReturnType<typeof makeIdp>>,
  idToken: () => Promise<string>,
  body: (seen: Seen) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const seen: Seen = { tokenRequests: [] };
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== host) return new Response("unknown host", { status: 404 });
    if (url.pathname.endsWith("/token")) {
      seen.tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
      return json({ access_token: "at", id_token: await idToken(), token_type: "bearer" });
    }
    if (url.pathname.endsWith("/keys") || url.pathname.endsWith("/jwks")) return json(idp.jwks);
    return new Response("not found", { status: 404 }); // discovery falls back to the pins
  }) as typeof fetch;
  try {
    return await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

/** A generic OIDC provider that asks for `response_mode=form_post`. */
function formPostOidc(extra: Partial<Parameters<typeof oidc>[0]> = {}): OAuthProvider {
  return oidc({
    id: "fp",
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/authorize",
    tokenUrl: "https://idp.test/token",
    jwksUrl: "https://idp.test/jwks",
    clientId: "client-fp",
    clientSecret: "shh",
    responseMode: "form_post",
    ...extra,
  });
}

/** The app config around `providers`, recording `signInFailed` reasons. */
function appConfig(providers: OAuthProvider[]): { config: AuthConfig; failures: string[] } {
  const failures: string[] = [];
  return {
    failures,
    config: {
      secret: SECRET,
      canonicalOrigin: ORIGIN,
      dangerouslyAllowInsecureProviders: true, // provider fetches go through the stub
      providers,
      pages: { signIn: "/login" },
      events: { signInFailed: ({ reason }) => void failures.push(reason) },
    },
  };
}

/** `GET /auth/signin/:id`: the authorization URL, the tx cookie line and its pair. */
async function startSignIn(config: AuthConfig, id: string) {
  const { res, ctx } = await run(new Request(`${ORIGIN}/auth/signin/${id}`), config);
  assertEquals(res.status, 303);
  const authorize = new URL(res.headers.get("location")!);
  const line = cookieLine(ctx, TX)!;
  const pair = cookiePair(ctx, TX)!;
  return { authorize, line, pair, state: authorize.searchParams.get("state")! };
}

/** The provider's cross-site form POST to the callback, as a browser sends it. */
function formPost(
  id: string,
  fields: Record<string, string>,
  cookie?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}/auth/callback/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://idp.test",
      "sec-fetch-site": "cross-site",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

/** Where a refused callback lands: the sign-in page with `?error=`. */
function errorOf(res: Response): string | null {
  const location = res.headers.get("location");
  return location ? new URL(location, ORIGIN).searchParams.get("error") : null;
}

/** Claims an id_token for `state`'s transaction must carry. */
function claims(pair: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://idp.test",
    aud: "client-fp",
    sub: "user-1",
    email: "ada@example.com",
    email_verified: true,
    nonce: txData(pair).nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...extra,
  };
}

// ---- the authorization request + the transaction cookie --------------------

Deno.test("form_post: the authorization request asks for response_mode=form_post", async () => {
  const { config } = appConfig([formPostOidc()]);
  const { authorize } = await startSignIn(config, "fp");
  assertEquals(authorize.searchParams.get("response_mode"), "form_post");
  assertEquals(authorize.searchParams.get("response_type"), "code");
  assertEquals(authorize.searchParams.get("code_challenge_method"), "S256");
  assert(authorize.searchParams.get("nonce"), "OIDC nonce");
});

Deno.test("form_post: the transaction cookie is SameSite=None; Secure; HttpOnly; __Host-", async () => {
  const { config } = appConfig([formPostOidc()]);
  const { line } = await startSignIn(config, "fp");
  assertMatch(line, /;\s*SameSite=None/i);
  assertMatch(line, /;\s*Secure/i);
  assertMatch(line, /;\s*HttpOnly/i);
  assertMatch(line, /;\s*Path=\//i);
  assert(!/;\s*Domain=/i.test(line), "no Domain under __Host-");
  assertMatch(line, /Max-Age=600/i, "short-lived");
});

Deno.test("form_post: a query-mode provider keeps a SameSite=Lax transaction cookie", async () => {
  const { config } = appConfig([formPostOidc({ id: "q", responseMode: undefined })]);
  const { line, authorize } = await startSignIn(config, "q");
  assertMatch(line, /;\s*SameSite=Lax/i);
  assertEquals(authorize.searchParams.get("response_mode"), null);
});

Deno.test("form_post: SameSite=None forces Secure even without the __Host- prefix", async () => {
  const { config } = appConfig([formPostOidc()]);
  config.cookies = { transaction: { hostPrefix: false } };
  const start = await run(new Request(`http://app.test/auth/signin/fp`), config);
  const line = cookieLine(start.ctx, "denext_auth_tx")!;
  assertMatch(line, /;\s*SameSite=None/i);
  assertMatch(line, /;\s*Secure/i, "a browser drops SameSite=None without Secure");
});

// ---- the POST callback -------------------------------------------------------

Deno.test("form_post: the cross-site POST completes the sign-in with state, PKCE and nonce", async () => {
  const idp = await makeIdp();
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  await withProvider("idp.test", idp, () => idp.mint(claims(start.pair)), async (seen) => {
    const { res, ctx } = await run(
      formPost("fp", { code: "the-code", state: start.state }, start.pair),
      config,
    );
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), "/");
    assert(cookiePair(ctx, SESSION), "a session was issued");
    assert(setCookies(ctx).some((c) => c.startsWith(`${TX}=;`)), "the transaction is spent");
    // The token request carries the code, the PKCE verifier and the exact redirect URI.
    const token = seen.tokenRequests[0];
    assertEquals(token.get("code"), "the-code");
    assertEquals(token.get("redirect_uri"), `${ORIGIN}/auth/callback/fp`);
    assertEquals(token.get("code_verifier")?.length, 43);
  });
  assertEquals(failures, []);
});

Deno.test("form_post: a wrong state is refused before any token request (CSRF)", async () => {
  const idp = await makeIdp();
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  await withProvider("idp.test", idp, () => idp.mint(claims(start.pair)), async (seen) => {
    const { res, ctx } = await run(
      formPost("fp", { code: "c", state: "forged" }, start.pair),
      config,
    );
    assertEquals(errorOf(res), "invalid_state");
    assertEquals(cookiePair(ctx, SESSION), undefined);
    assertEquals(seen.tokenRequests.length, 0);
  });
  assertEquals(failures, ["invalid_state"]);
});

Deno.test("form_post: no transaction cookie (a forged cross-site POST) is refused", async () => {
  const idp = await makeIdp();
  const { config } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  await withProvider("idp.test", idp, () => idp.mint(claims(start.pair)), async (seen) => {
    const { res } = await run(formPost("fp", { code: "c", state: start.state }), config);
    assertEquals(errorOf(res), "invalid_state");
    assertEquals(seen.tokenRequests.length, 0);
  });
});

Deno.test("form_post: a tampered transaction cookie is refused", async () => {
  const { config } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  const [name, value] = start.pair.split("=");
  const tampered = `${name}=${value.slice(0, -2)}xx`;
  const { res } = await run(formPost("fp", { code: "c", state: start.state }, tampered), config);
  assertEquals(errorOf(res), "invalid_state");
});

Deno.test("form_post: a transaction is single-use — replaying the POST is refused", async () => {
  const idp = await makeIdp();
  const { config } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  await withProvider("idp.test", idp, () => idp.mint(claims(start.pair)), async (seen) => {
    const first = await run(formPost("fp", { code: "c", state: start.state }, start.pair), config);
    assert(cookiePair(first.ctx, SESSION));
    // The response cleared the transaction cookie: the browser's replay carries none.
    const replay = await run(formPost("fp", { code: "c", state: start.state }), config);
    assertEquals(errorOf(replay.res), "invalid_state");
    assertEquals(seen.tokenRequests.length, 1);
  });
});

Deno.test("form_post: a transaction started for another provider is refused", async () => {
  const { config } = appConfig([formPostOidc(), formPostOidc({ id: "fp2" })]);
  const start = await startSignIn(config, "fp2");
  const { res } = await run(formPost("fp", { code: "c", state: start.state }, start.pair), config);
  assertEquals(errorOf(res), "invalid_state");
});

Deno.test("form_post: an id_token with another transaction's nonce is refused", async () => {
  const idp = await makeIdp();
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  const minted = () => idp.mint(claims(start.pair, { nonce: "someone-elses-nonce" }));
  await withProvider("idp.test", idp, minted, async () => {
    const { res, ctx } = await run(
      formPost("fp", { code: "c", state: start.state }, start.pair),
      config,
    );
    assertEquals(errorOf(res), "oauth_failed");
    assertEquals(cookiePair(ctx, SESSION), undefined);
  });
  assertEquals(failures, ["oauth_failed"]);
});

Deno.test("form_post: the provider's error arrives in the POST body", async () => {
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  const { res } = await run(
    formPost("fp", { error: "user_cancelled_authorize", state: start.state }, start.pair),
    config,
  );
  assertEquals(errorOf(res), "user_cancelled_authorize");
  assertEquals(failures, ["user_cancelled_authorize"]);
});

Deno.test("form_post: a GET carrying a code is refused (no downgrade to the query mode)", async () => {
  const idp = await makeIdp();
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  await withProvider("idp.test", idp, () => idp.mint(claims(start.pair)), async (seen) => {
    const { res, ctx } = await run(
      new Request(`${ORIGIN}/auth/callback/fp?code=c&state=${start.state}`, {
        headers: { cookie: start.pair },
      }),
      config,
    );
    assertEquals(errorOf(res), "invalid_request");
    assertEquals(cookiePair(ctx, SESSION), undefined);
    assertEquals(seen.tokenRequests.length, 0);
  });
  assertEquals(failures, ["invalid_request"]);
});

Deno.test("form_post: a POST to a query-mode provider's callback is a 405", async () => {
  const { config } = appConfig([formPostOidc({ id: "q", responseMode: undefined })]);
  const start = await startSignIn(config, "q");
  const { res } = await run(formPost("q", { code: "c", state: start.state }, start.pair), config);
  assertEquals(res.status, 405);
});

Deno.test("form_post: a body that isn't a urlencoded form is refused", async () => {
  const { config, failures } = appConfig([formPostOidc()]);
  const start = await startSignIn(config, "fp");
  const json = new Request(`${ORIGIN}/auth/callback/fp`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: start.pair },
    body: JSON.stringify({ code: "c", state: start.state }),
  });
  assertEquals(errorOf((await run(json, config)).res), "invalid_request");
  const huge = formPost(
    "fp",
    { code: "c", state: start.state, pad: "x".repeat(64 * 1024) },
    start.pair,
  );
  assertEquals(errorOf((await run(huge, config)).res), "invalid_request");
  assertEquals(failures, ["invalid_request", "invalid_request"]);
});

// ---- Sign in with Apple ------------------------------------------------------

Deno.test("apple(): openid name email over form_post by default", () => {
  const provider = apple({ clientId: "com.example.web", clientSecret: "jwt" });
  assertEquals(provider.scopes, ["openid", "name", "email"]);
  assertEquals(provider.responseMode, "form_post");
});

Deno.test("apple(): the name comes from the posted `user`, the email only from the id_token", async () => {
  const idp = await makeIdp();
  const provider = apple({ clientId: "com.example.web", clientSecret: "jwt" });
  const { config } = appConfig([provider]);
  const start = await startSignIn(config, "apple");
  assertEquals(start.authorize.host, "appleid.apple.com");
  assertEquals(start.authorize.searchParams.get("response_mode"), "form_post");
  assertEquals(start.authorize.searchParams.get("scope"), "openid name email");
  const token = () =>
    idp.mint({
      iss: "https://appleid.apple.com",
      aud: "com.example.web",
      sub: "001234.abcd",
      email: "x7@privaterelay.appleid.com",
      email_verified: "true", // Apple sends a string
      nonce: txData(start.pair).nonce,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  // The posted `user` is first-sign-in data from the browser: its name is used, its email
  // never (an unsigned field could name anyone).
  const user = JSON.stringify({
    name: { firstName: "Ada", lastName: "Lovelace" },
    email: "attacker@example.com",
  });
  let session: Record<string, unknown> | undefined;
  config.callbacks = {
    session: (s) => (session = s.user as unknown as Record<string, unknown>, s),
  };
  await withProvider("appleid.apple.com", idp, token, async () => {
    const { res } = await run(
      formPost("apple", { code: "c", state: start.state, user }, start.pair, {
        origin: "https://appleid.apple.com",
      }),
      config,
    );
    assertEquals(res.status, 303);
  });
  assertEquals(session?.id, "001234.abcd");
  assertEquals(session?.name, "Ada Lovelace");
  assertEquals(session?.email, "x7@privaterelay.appleid.com");
  assertEquals(session?.emailVerified, true);
});

Deno.test("apple(): a malformed or hostile `user` field is ignored, never a failure", async () => {
  const idp = await makeIdp();
  const { config } = appConfig([apple({ clientId: "com.example.web", clientSecret: "jwt" })]);
  for (const user of ["{not json", JSON.stringify({ name: { firstName: 1 } }), "x".repeat(5000)]) {
    const start = await startSignIn(config, "apple");
    const token = () =>
      idp.mint({
        iss: "https://appleid.apple.com",
        aud: "com.example.web",
        sub: "s",
        nonce: txData(start.pair).nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
    await withProvider("appleid.apple.com", idp, token, async () => {
      const { res, ctx } = await run(
        formPost("apple", { code: "c", state: start.state, user }, start.pair),
        config,
      );
      assertEquals(res.status, 303);
      assert(cookiePair(ctx, SESSION));
    });
  }
});

// ---- configuration -------------------------------------------------------------

Deno.test("form_post: response_mode smuggled through authorizationParams is a config error", () => {
  const provider = formPostOidc({ responseMode: undefined });
  provider.authorizationParams = { response_mode: "form_post" };
  assertThrows(
    () => denextAuth({ secret: SECRET, canonicalOrigin: ORIGIN, providers: [provider] }),
    Error,
    "responseMode",
  );
  const bogus = formPostOidc();
  (bogus as { responseMode?: string }).responseMode = "fragment";
  assertThrows(
    () => denextAuth({ secret: SECRET, canonicalOrigin: ORIGIN, providers: [bogus] }),
    Error,
    "responseMode",
  );
  assertStringIncludes(String(formPostOidc().responseMode), "form_post");
});
