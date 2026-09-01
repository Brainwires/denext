// Auth endpoints: a full mocked OIDC round-trip through the request handler, the
// Credentials path, signout CSRF, and the session/providers/requireAuth surfaces.
// The provider network calls are stubbed via `dangerouslyAllowInsecureProviders`
// (which routes provider fetches through the platform `fetch`) + a fetch stub.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { auth, denextAuth, requireAuth } from "../src/server/auth/mod.ts";
import { credentials, oidc } from "../src/server/auth/providers.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ORIGIN = "https://app.test";

/** Run a handler inside a fresh request context; return the response + the context. */
async function run(
  request: Request,
  config: AuthConfig,
): Promise<{ res: Response | null; ctx: RequestContext }> {
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res, ctx };
}

function setCookies(ctx: RequestContext): string[] {
  return ctx.outgoingHeaders.getSetCookie();
}

// ---- Mock OIDC provider + RS256 id_token -----------------------------------

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
  const jwks = { keys: [{ kty: "RSA", kid: "k1", n: pub.n, e: pub.e, alg: "RS256" }] };

  async function mintIdToken(claims: Record<string, unknown>): Promise<string> {
    const seg = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const head = seg({ alg: "RS256", typ: "JWT", kid: "k1" });
    const body = seg(claims);
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
  }
  return { jwks, mintIdToken };
}

function oidcProvider(): ReturnType<typeof oidc> {
  return oidc({
    id: "testidp",
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/authorize",
    tokenUrl: "https://idp.test/token",
    jwksUrl: "https://idp.test/jwks",
    clientId: "client-123",
    clientSecret: "shh",
  });
}

async function withFetch(
  responder: (url: string, init: Any) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((input: Any, init: Any) => Promise.resolve(responder(String(input), init))) as Any;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("OIDC round-trip: signin sets a tx cookie; callback verifies id_token and issues a session", async () => {
  const idp = await makeIdp();
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true, // route provider fetches via stub `fetch`
    providers: [oidcProvider()],
  };

  // 1) Sign-in → redirect to the IdP with a state, and a tx cookie set.
  const signin = await run(new Request(`${ORIGIN}/auth/signin/testidp`), config);
  assertEquals(signin.res!.status, 303);
  const authUrl = new URL(signin.res!.headers.get("location")!);
  assertEquals(authUrl.host, "idp.test");
  const state = authUrl.searchParams.get("state")!;
  assert(state, "state present");
  assertEquals(authUrl.searchParams.get("code_challenge_method"), "S256");
  assertEquals(
    authUrl.searchParams.get("redirect_uri"),
    `${ORIGIN}/auth/callback/testidp`,
    "redirect_uri is pinned to canonicalOrigin",
  );
  const txCookie = setCookies(signin.ctx).find((c) => c.startsWith("__Host-denext_auth_tx="))!;
  assert(txCookie, "tx cookie set (origin-locked via __Host-)");
  const txPair = txCookie.split(";")[0];

  // 2) Callback with the tx cookie + matching state → session issued. The tx cookie
  // is now a signed session token (`base64url({d,e}).signature`); decode the payload
  // to read the nonce the server stored, so we can mint a matching id_token.
  const payloadB64 = txPair.split("=")[1].split(".")[0];
  const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const tx = (JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0))),
  ) as { d: { nonce?: string } }).d;
  const idToken = await idp.mintIdToken({
    iss: "https://idp.test",
    aud: "client-123",
    sub: "user-42",
    email: "u@idp.test",
    name: "Test User",
    nonce: tx.nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  let issued: string[] = [];
  await withFetch((url) => {
    if (url === "https://idp.test/token") {
      return new Response(
        JSON.stringify({ access_token: "at", id_token: idToken, token_type: "bearer" }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url === "https://idp.test/jwks") {
      return new Response(JSON.stringify(idp.jwks), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }, async () => {
    const cb = await run(
      new Request(`${ORIGIN}/auth/callback/testidp?code=abc&state=${state}`, {
        headers: { cookie: txPair },
      }),
      config,
    );
    assertEquals(cb.res!.status, 303);
    issued = setCookies(cb.ctx);
  });
  assert(
    issued.some((c) =>
      c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;")
    ),
    `a session cookie was issued; got: ${issued.join(" | ")}`,
  );
});

Deno.test("OIDC callback rejects a mismatched state (CSRF)", async () => {
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [oidcProvider()],
  };
  // Mint a real, signed tx cookie via the signin step (state chosen by the server).
  const signin = await run(new Request(`${ORIGIN}/auth/signin/testidp`), config);
  const txPair = setCookies(signin.ctx)
    .find((c) => c.startsWith("__Host-denext_auth_tx="))!
    .split(";")[0];
  // Callback whose `state` does not match the one inside the valid tx cookie.
  const cb = await run(
    new Request(`${ORIGIN}/auth/callback/testidp?code=abc&state=WRONG`, {
      headers: { cookie: txPair },
    }),
    config,
  );
  assertEquals(cb.res!.status, 303);
  assertStringIncludes(cb.res!.headers.get("location")!, "error=invalid_state");
});

// ---- Credentials -----------------------------------------------------------

function credConfig(): AuthConfig {
  return {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email, password }) =>
          email === "a@b.co" && password === "pw" ? { id: "1", email } : null,
      }),
    ],
  };
}

Deno.test("Credentials: valid login issues a session; invalid returns a generic 401", async () => {
  const config = credConfig();
  const ok = await run(
    new Request(`${ORIGIN}/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "a@b.co", password: "pw" }),
    }),
    config,
  );
  assertEquals(ok.res!.status, 200);
  assertEquals((await ok.res!.json()).ok, true);
  assert(setCookies(ok.ctx).some((c) => c.startsWith("__Host-denext_auth=")), "session issued");

  const bad = await run(
    new Request(`${ORIGIN}/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "a@b.co", password: "wrong" }),
    }),
    config,
  );
  assertEquals(bad.res!.status, 401);
});

Deno.test("Credentials: post-login redirect is coerced to a same-origin path (open-redirect fix)", async () => {
  const config = credConfig();
  // A non-JSON POST takes the redirect path (not the { ok } JSON path).
  async function loginWithCallback(callbackUrl: string): Promise<string> {
    const { res } = await run(
      new Request(`${ORIGIN}/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: "a@b.co", password: "pw", callbackUrl }),
      }),
      config,
    );
    assertEquals(res!.status, 303);
    return res!.headers.get("location")!;
  }
  // A foreign absolute URL is dropped to the default — never followed.
  assertEquals(await loginWithCallback("https://evil.example/phish"), "/");
  // A protocol-relative foreign target is pinned to a same-origin path.
  assertEquals(await loginWithCallback("//evil.example/x"), "/evil.example/x");
  // A same-origin absolute URL keeps only its path + query.
  assertEquals(await loginWithCallback(`${ORIGIN}/dashboard?t=1`), "/dashboard?t=1");
  // A relative path is preserved.
  assertEquals(await loginWithCallback("/account"), "/account");
});

Deno.test("Credentials + signout reject a cross-origin POST (CSRF)", async () => {
  const config = credConfig();
  for (const path of ["callback/credentials", "signout"]) {
    const { res } = await run(
      new Request(`${ORIGIN}/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: "https://evil.test",
        },
        body: "{}",
      }),
      config,
    );
    assertEquals(res!.status, 403, `${path} must reject cross-origin`);
  }
});

// ---- session / providers / requireAuth -------------------------------------

Deno.test("/auth/session is null when signed out; /auth/providers lists providers", async () => {
  const config = credConfig();
  const session = await run(
    new Request(`${ORIGIN}/auth/session`, { headers: { accept: "application/json" } }),
    config,
  );
  assertEquals((await session.res!.json()).user, null);

  const providers = await run(new Request(`${ORIGIN}/auth/providers`), config);
  assertEquals(await providers.res!.json(), [{ id: "credentials", type: "credentials" }]);
});

Deno.test("handleAuthRequest passes (null) for non-auth paths", async () => {
  const { res } = await run(new Request(`${ORIGIN}/dashboard`), credConfig());
  assertEquals(res, null);
});

Deno.test("requireAuth redirects an unauthenticated request with a callbackUrl", async () => {
  denextAuth({ ...credConfig(), pages: { signIn: "/login" } }); // sets active config
  const request = new Request(`${ORIGIN}/dashboard/reports?tab=1`);
  const res = await runWithContext(createRequestContext(request), () => requireAuth(request));
  assert(res, "returns a redirect response when unauthenticated");
  assertEquals(res!.status, 302);
  const loc = res!.headers.get("location")!;
  assertStringIncludes(loc, "/login");
  assertStringIncludes(loc, "callbackUrl=");
  assertStringIncludes(decodeURIComponent(loc), "/dashboard/reports?tab=1");
});

Deno.test("auth() returns null when signed out", async () => {
  denextAuth(credConfig());
  const request = new Request(`${ORIGIN}/`);
  const session = await runWithContext(createRequestContext(request), () => auth());
  assertEquals(session, null);
});

// ===========================================================================
// next-auth / Auth.js CVE parity. denext ships its OWN auth (not next-auth), so
// these fire the exact next-auth exploit shapes at denext's equivalent surface.
// ===========================================================================

// CVE-2023-27490 — next-auth accepted an OAuth callback WITHOUT verifying the
// state/nonce/PKCE it issued, so an attacker who could plant a code/callback could
// log the victim in as the attacker (login CSRF). denext binds `state` to a signed
// __Host- tx cookie and refuses any callback whose state/provider/code doesn't
// match it (routes.ts:268) — no session is issued.
Deno.test("CVE-2023-27490: an OAuth callback with a bad/absent/foreign state issues no session", async () => {
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      oidcProvider(),
      oidc({
        id: "otheridp",
        issuer: "https://other.test",
        authorizationUrl: "https://other.test/authorize",
        tokenUrl: "https://other.test/token",
        jwksUrl: "https://other.test/jwks",
        clientId: "client-xyz",
        clientSecret: "shh2",
      }),
    ],
  };
  // A valid, server-signed tx cookie + its state (from a real signin to testidp).
  const signin = await run(new Request(`${ORIGIN}/auth/signin/testidp`), config);
  const authUrl = new URL(signin.res!.headers.get("location")!);
  const state = authUrl.searchParams.get("state")!;
  const txPair = setCookies(signin.ctx)
    .find((c) => c.startsWith("__Host-denext_auth_tx="))!
    .split(";")[0];

  const bypasses: Array<{ label: string; url: string; cookie?: string }> = [
    // No tx cookie at all — nothing to compare the state against.
    { label: "no tx cookie", url: `${ORIGIN}/auth/callback/testidp?code=abc&state=${state}` },
    // Valid tx, but the returned state doesn't match it (classic CSRF).
    {
      label: "mismatched state",
      url: `${ORIGIN}/auth/callback/testidp?code=abc&state=WRONG`,
      cookie: txPair,
    },
    // Valid tx, but no state at all.
    {
      label: "empty state",
      url: `${ORIGIN}/auth/callback/testidp?code=abc&state=`,
      cookie: txPair,
    },
    // Valid tx, but no authorization code.
    {
      label: "missing code",
      url: `${ORIGIN}/auth/callback/testidp?state=${state}`,
      cookie: txPair,
    },
    // A tx minted for testidp replayed against ANOTHER provider's callback.
    {
      label: "foreign-provider tx",
      url: `${ORIGIN}/auth/callback/otheridp?code=abc&state=${state}`,
      cookie: txPair,
    },
  ];
  for (const b of bypasses) {
    const { res, ctx } = await run(
      new Request(b.url, b.cookie ? { headers: { cookie: b.cookie } } : undefined),
      config,
    );
    assertEquals(res!.status, 303, `${b.label}: redirects`);
    assertStringIncludes(res!.headers.get("location")!, "error=invalid_state", b.label);
    assert(
      !setCookies(ctx).some((c) =>
        c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;")
      ),
      `${b.label}: no session cookie must be issued`,
    );
  }
});

// CVE-2023-48309 — next-auth's default middleware treated ANY next-auth-issued JWT
// (e.g. one grabbed from an interrupted OAuth flow) as a logged-in session when
// injected as the session cookie, minting a mock user. denext's session is its own
// HMAC-signed `{user,provider,expiresAt}` token; a foreign or self-shaped-but-
// unsigned JWT fails verification and reads as signed-out.
Deno.test("CVE-2023-48309: a foreign/forged JWT injected as the session cookie is not a session", async () => {
  const config = credConfig();
  const idp = await makeIdp();
  const foreignJwt = await idp.mintIdToken({
    iss: "https://idp.test",
    aud: "client-123",
    sub: "admin",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  // A denext-SHAPED payload (base64url(JSON).sig) with a bogus signature.
  const shaped = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        d: { user: { id: "admin" }, provider: "x", expiresAt: Date.now() + 1e7 },
        e: Date.now() + 1e7,
      }),
    ),
  ) + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  for (const forged of [foreignJwt, shaped, "not-a-token", ""]) {
    const { res } = await run(
      new Request(`${ORIGIN}/auth/session`, {
        headers: { accept: "application/json", cookie: `__Host-denext_auth=${forged}` },
      }),
      config,
    );
    assertEquals((await res!.json()).user, null, "a forged session cookie is not honored");
  }
});

// CVE-2022-35924 — next-auth's EmailProvider split a comma-separated `email` and
// sent magic links to every address, letting an attacker log in as a combined
// address. denext ships NO email/magic-link provider (only OAuth/OIDC + Credentials),
// and a Credentials identifier is passed to `authorize` verbatim — never split.
Deno.test("CVE-2022-35924: no email provider exists; a Credentials identifier is never comma-split", async () => {
  let seen: string | undefined;
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: ({ email }) => {
          seen = String(email);
          return null; // never authorizes the combined address
        },
      }),
    ],
  };
  const list = await run(new Request(`${ORIGIN}/auth/providers`), config);
  const providers = (await list.res!.json()) as Array<{ type: string }>;
  assert(!providers.some((p) => p.type === "email"), "denext exposes no email provider");

  const { res } = await run(
    new Request(`${ORIGIN}/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: "attacker@evil.com,victim@good.com", password: "x" }),
    }),
    config,
  );
  assertEquals(res!.status, 401, "the combined address does not authenticate");
  assertEquals(
    seen,
    "attacker@evil.com,victim@good.com",
    "identifier reached authorize verbatim, unsplit",
  );
});

// Auth-callback open redirect (next-auth `callbackUrl` open-redirect class). A
// hostile `callbackUrl` on the OAuth signin path is coerced to a same-origin path
// (sameOriginRedirect, routes.ts:124) before it is stored in the tx and used as the
// post-login redirect — so the OAuth login flow can't be turned into an open redirect.
Deno.test("auth open-redirect: a hostile OAuth callbackUrl is coerced to a same-origin path", async () => {
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [oidcProvider()],
  };
  // Decode a signed tx cookie's payload to read the stored returnTo.
  function txReturnTo(cookiePair: string): string | undefined {
    const payloadB64 = cookiePair.split("=")[1].split(".")[0];
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return (JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0))),
    ) as { d: { returnTo?: string } }).d.returnTo;
  }
  const cases: Array<[string, (v: string | undefined) => boolean]> = [
    ["https://evil.example/phish", (v) => v === "/" || v === undefined],
    ["//evil.example/x", (v) => v === "/evil.example/x"],
    ["/\\evil.example/x", (v) => !!v && v.startsWith("/") && !v.startsWith("//")],
    [`${ORIGIN}/dashboard?t=1`, (v) => v === "/dashboard?t=1"],
  ];
  for (const [callbackUrl, ok] of cases) {
    const signin = await run(
      new Request(`${ORIGIN}/auth/signin/testidp?callbackUrl=${encodeURIComponent(callbackUrl)}`),
      config,
    );
    const txPair = setCookies(signin.ctx)
      .find((c) => c.startsWith("__Host-denext_auth_tx="))!
      .split(";")[0];
    const returnTo = txReturnTo(txPair);
    assert(
      ok(returnTo),
      `callbackUrl ${callbackUrl} stored a non-same-origin returnTo: ${returnTo}`,
    );
  }
});

// Session fixation (CWE-384). denext's session is a fresh stateless signed token
// minted at login; there is no pre-login session id to fixate, and a login ignores
// any inbound session cookie and always issues its own (__Host-, Secure, Path=/).
Deno.test("session-fixation: login mints a fresh session and ignores a planted cookie", async () => {
  const config = credConfig();
  const { res, ctx } = await run(
    new Request(`${ORIGIN}/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ORIGIN,
        cookie: "__Host-denext_auth=attacker-planted-value", // pre-set by the attacker
      },
      body: JSON.stringify({ email: "a@b.co", password: "pw" }),
    }),
    config,
  );
  assertEquals(res!.status, 200);
  const set = setCookies(ctx).find((c) => c.startsWith("__Host-denext_auth="))!;
  assert(set, "login issues its own session cookie");
  const value = set.split(";")[0].split("=")[1];
  assert(value !== "attacker-planted-value", "the planted cookie value is NOT adopted");
  assert(value.includes("."), "the issued session is a signed token, not the planted value");
  // __Host- guarantees Secure + Path=/ + no Domain (blocks subdomain fixation).
  assertStringIncludes(set, "Secure");
  assertStringIncludes(set, "Path=/");
  assert(!/;\s*Domain=/i.test(set), "no Domain attribute on a __Host- cookie");
});
