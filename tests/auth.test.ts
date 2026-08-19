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
  const txCookie = setCookies(signin.ctx).find((c) => c.startsWith("denext_auth_tx="))!;
  assert(txCookie, "tx cookie set");
  const txPair = txCookie.split(";")[0];

  // 2) Callback with the tx cookie + matching state → session issued. The nonce
  // lives inside the (base64url JSON) tx cookie; decode it to mint a matching token.
  const tx = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(txPair.split("=")[1].replace(/-/g, "+").replace(/_/g, "/") + "=="),
        (c) => c.charCodeAt(0),
      ),
    ),
  );
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
  const cb = await run(
    new Request(`${ORIGIN}/auth/callback/testidp?code=abc&state=WRONG`, {
      headers: {
        cookie: `denext_auth_tx=${
          base64UrlEncode(
            new TextEncoder().encode(
              JSON.stringify({ provider: "testidp", state: "REAL", verifier: "v" }),
            ),
          )
        }`,
      },
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
