// OIDC discovery + the JWKS cache: what denext fetches, what it refuses to believe, and
// how often it is willing to ask. The fake IdP below serves a discovery document, a token
// endpoint and a JWKS endpoint, and COUNTS every hit, so "fetched once then cached" and
// "exactly one refetch per kid miss" are assertions rather than hopes.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DiscoveryError,
  endpointHosts,
  type ProviderEndpoints,
  resolveProviderEndpoints,
} from "../src/server/auth/discovery.ts";
import { getJwks } from "../src/server/auth/jwks-cache.ts";
import type { ProviderFetch } from "../src/server/auth/flow.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import type {
  AuthConfig,
  AuthUser,
  OAuthProvider,
  ProfileInput,
} from "../src/server/auth/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ORIGIN = "https://app.test";

/** Run the auth handler inside a fresh request context. */
async function run(
  request: Request,
  config: AuthConfig,
): Promise<{ res: Response | null; ctx: RequestContext }> {
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res, ctx };
}

// ---- A fake IdP that counts what it serves ---------------------------------

/** A mock OIDC IdP: a discovery document, a token endpoint, JWKS, and hit counters. */
async function makeIdp(issuer: string) {
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
  /** The kid the JWKS currently publishes — flip it to simulate a key rotation. */
  let publishedKid = "k1";
  const hits = { discovery: 0, jwks: 0, token: 0 };
  /** Overrides for the discovery document body (a mismatched issuer, a foreign host, …). */
  let documentPatch: Record<string, unknown> = {};
  /** `Cache-Control` the discovery document is served with. */
  let discoveryCacheControl: string | undefined;
  /** Serve a broken (non-JSON) discovery document. */
  let malformed = false;

  const jwksBody = () => ({
    keys: [{ kty: "RSA", kid: publishedKid, n: pub.n, e: pub.e, alg: "RS256" }],
  });

  async function mintIdToken(claims: Record<string, unknown>, kid = publishedKid): Promise<string> {
    const seg = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const head = seg({ alg: "RS256", typ: "JWT", kid });
    const body = seg(claims);
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(sig))}`;
  }

  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...headers },
    });

  /** The responder to install as `globalThis.fetch` (or to hand in as a `ProviderFetch`). */
  function respond(url: string, idToken?: string): Response {
    if (url === `${issuer}/.well-known/openid-configuration`) {
      hits.discovery++;
      if (malformed) {
        return new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
      }
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        ...documentPatch,
      }, discoveryCacheControl ? { "cache-control": discoveryCacheControl } : {});
    }
    if (url === `${issuer}/jwks`) {
      hits.jwks++;
      return json(jwksBody());
    }
    if (url === `${issuer}/token`) {
      hits.token++;
      return json({ access_token: "at", id_token: idToken, token_type: "bearer" });
    }
    return new Response("not found", { status: 404 });
  }

  return {
    hits,
    mintIdToken,
    respond,
    /** The JWKS URL, as the document declares it. */
    jwksUrl: `${issuer}/jwks`,
    rotateKid: (kid: string) => publishedKid = kid,
    patchDocument: (patch: Record<string, unknown>) => documentPatch = patch,
    setCacheControl: (value: string | undefined) => discoveryCacheControl = value,
    breakDocument: () => malformed = true,
  };
}

/** A `ProviderFetch` served by the fake IdP (no network, no host pinning to fight). */
function idpFetch(idp: Awaited<ReturnType<typeof makeIdp>>, idToken?: string): ProviderFetch {
  return (url) => Promise.resolve(idp.respond(url, idToken));
}

/** A provider that knows only its issuer — the shape `oidc({ issuer })` produces. */
function discoveryProvider(issuer: string, extra: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: "idp",
    type: "oidc",
    authorizationUrl: "",
    tokenUrl: "",
    scopes: ["openid", "email"],
    clientId: "client-123",
    clientSecret: "shh",
    discovery: { issuer },
    profile: ({ claims }: ProfileInput): AuthUser => ({ id: String(claims?.sub ?? "") }),
    ...extra,
  };
}

/** Install a stub `globalThis.fetch` for the duration of `body`. */
async function withFetch(
  responder: (url: string) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Any) => Promise.resolve(responder(String(input)))) as Any;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** A unique issuer per test — the discovery cache is process-wide and keyed by issuer. */
let issuerSeq = 0;
function freshIssuer(): string {
  return `https://idp-${++issuerSeq}.test`;
}

// ---- Discovery -------------------------------------------------------------

Deno.test("discovery: the document is fetched once, then cached until its TTL expires", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  idp.setCacheControl("public, max-age=120");
  const provider = discoveryProvider(issuer);
  const opts = { fetchImpl: idpFetch(idp), now: 1_000_000 };

  const first = await resolveProviderEndpoints(provider, opts);
  assertEquals(first.issuer, issuer);
  assertEquals(first.authorizationUrl, `${issuer}/authorize`);
  assertEquals(first.tokenUrl, `${issuer}/token`);
  assertEquals(first.jwksUrl, `${issuer}/jwks`);
  assertEquals(first.userinfoUrl, `${issuer}/userinfo`);
  assertEquals(idp.hits.discovery, 1);

  // Inside the TTL: served from the cache.
  await resolveProviderEndpoints(provider, { ...opts, now: 1_000_000 + 119_000 });
  assertEquals(idp.hits.discovery, 1);

  // Past it: exactly one more fetch.
  await resolveProviderEndpoints(provider, { ...opts, now: 1_000_000 + 121_000 });
  assertEquals(idp.hits.discovery, 2);
});

Deno.test("discovery: a `max-age`-less document is cached for an hour, and a hostile max-age=0 is floored", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const provider = discoveryProvider(issuer);
  const opts = { fetchImpl: idpFetch(idp), now: 5_000_000 };
  await resolveProviderEndpoints(provider, opts);
  await resolveProviderEndpoints(provider, { ...opts, now: 5_000_000 + 59 * 60 * 1000 });
  assertEquals(idp.hits.discovery, 1, "default TTL is an hour");

  const other = freshIssuer();
  const zero = await makeIdp(other);
  zero.setCacheControl("max-age=0");
  const zeroOpts = { fetchImpl: idpFetch(zero), now: 0 };
  await resolveProviderEndpoints(discoveryProvider(other), zeroOpts);
  await resolveProviderEndpoints(discoveryProvider(other), { ...zeroOpts, now: 30_000 });
  assertEquals(zero.hits.discovery, 1, "max-age=0 is floored to a minute, not honoured");
});

Deno.test("discovery: a malformed document is refused", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  idp.breakDocument();
  const error = await assertRejects(
    () => resolveProviderEndpoints(discoveryProvider(issuer), { fetchImpl: idpFetch(idp) }),
    DiscoveryError,
  );
  assertEquals((error as DiscoveryError).code, "malformed");
});

Deno.test("discovery: a document declaring another issuer is refused (and not cached)", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  idp.patchDocument({ issuer: `${issuer}/` }); // a trailing slash is a DIFFERENT issuer
  const error = await assertRejects(
    () => resolveProviderEndpoints(discoveryProvider(issuer), { fetchImpl: idpFetch(idp) }),
    DiscoveryError,
  );
  assertEquals((error as DiscoveryError).code, "issuer_mismatch");

  // A failure is never cached: the next attempt asks again (and succeeds once fixed).
  idp.patchDocument({});
  await resolveProviderEndpoints(discoveryProvider(issuer), { fetchImpl: idpFetch(idp) });
  assertEquals(idp.hits.discovery, 2);
});

Deno.test("discovery: an endpoint on a foreign host is refused unless allow-listed (SSRF)", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  idp.patchDocument({ token_endpoint: "https://evil.test/token" });
  const error = await assertRejects(
    () => resolveProviderEndpoints(discoveryProvider(issuer), { fetchImpl: idpFetch(idp) }),
    DiscoveryError,
  );
  assertEquals((error as DiscoveryError).code, "foreign_endpoint");
  assertStringIncludes((error as DiscoveryError).message, "evil.test");

  // The conservative rule has one escape hatch: the app says so explicitly.
  const allowed = await resolveProviderEndpoints(
    discoveryProvider(issuer, { allowedHosts: ["evil.test"] }),
    { fetchImpl: idpFetch(idp) },
  );
  assertEquals(allowed.tokenUrl, "https://evil.test/token");
});

Deno.test("discovery: a non-https endpoint, an endpoint with credentials, and a missing one are refused", async () => {
  const insecure = freshIssuer();
  const a = await makeIdp(insecure);
  a.patchDocument({ jwks_uri: `${insecure.replace("https:", "http:")}/jwks` });
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(discoveryProvider(insecure), { fetchImpl: idpFetch(a) }),
      DiscoveryError,
    )) as DiscoveryError).code,
    "insecure_endpoint",
  );

  const creds = freshIssuer();
  const b = await makeIdp(creds);
  b.patchDocument({ token_endpoint: `https://user:pw@${new URL(creds).host}/token` });
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(discoveryProvider(creds), { fetchImpl: idpFetch(b) }),
      DiscoveryError,
    )) as DiscoveryError).code,
    "malformed",
  );

  const bare = freshIssuer();
  const c = await makeIdp(bare);
  c.patchDocument({ jwks_uri: undefined });
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(discoveryProvider(bare), { fetchImpl: idpFetch(c) }),
      DiscoveryError,
    )) as DiscoveryError).code,
    "missing_endpoint",
  );
});

Deno.test("discovery: an unreachable document is a DiscoveryError, never a raw fetch error", async () => {
  const issuer = freshIssuer();
  const boom: ProviderFetch = () => Promise.reject(new Error("connection refused"));
  const error = await assertRejects(
    () => resolveProviderEndpoints(discoveryProvider(issuer), { fetchImpl: boom }),
    DiscoveryError,
  );
  assertEquals((error as DiscoveryError).code, "unreachable");

  const notFound: ProviderFetch = () => Promise.resolve(new Response("no", { status: 404 }));
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(discoveryProvider(freshIssuer()), { fetchImpl: notFound }),
      DiscoveryError,
    )) as DiscoveryError).code,
    "unreachable",
  );
});

Deno.test("discovery: a provider with explicit endpoints and no issuer never fetches", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const explicit: OAuthProvider = {
    ...discoveryProvider(issuer),
    authorizationUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    issuer,
    jwksUrl: `${issuer}/jwks`,
    discovery: undefined,
  };
  const endpoints = await resolveProviderEndpoints(explicit, { fetchImpl: idpFetch(idp) });
  assertEquals(endpoints.tokenUrl, `${issuer}/token`);
  assertEquals(idp.hits.discovery, 0);
  assertEquals(endpointHosts(endpoints), [new URL(issuer).host]);
});

Deno.test("discovery: the document wins over pinned endpoints, which are the fallback when it fails", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  idp.patchDocument({ token_endpoint: `${issuer}/token/v2` });
  // Every built-in OIDC preset looks like this: pinned URLs AND `discovery: { issuer }`.
  const pinned: OAuthProvider = {
    ...discoveryProvider(issuer),
    authorizationUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    issuer,
    jwksUrl: `${issuer}/jwks`,
  };
  const discovered = await resolveProviderEndpoints(pinned, { fetchImpl: idpFetch(idp) });
  assertEquals(discovered.tokenUrl, `${issuer}/token/v2`, "the document moved the endpoint");

  // …and when the document can't be had, the pinned URLs keep the provider working.
  const seen: DiscoveryError[] = [];
  const fallback = await resolveProviderEndpoints(pinned, {
    fetchImpl: () => Promise.reject(new Error("idp down")),
    now: Date.now() + 3 * 60 * 60 * 1000, // past the cached document's TTL
    onDiscoveryError: (error) => seen.push(error),
  });
  assertEquals(fallback.tokenUrl, `${issuer}/token`);
  assertEquals(seen.map((e) => e.code), ["unreachable"]);
});

Deno.test("discovery: an issuer with a trailing slash (Auth0) is not double-slashed and matches exactly", async () => {
  const issuer = `${freshIssuer()}/`;
  const idp = await makeIdp(issuer.replace(/\/$/, ""));
  // The tenant declares the issuer WITH its trailing slash.
  idp.patchDocument({ issuer });
  const asked: string[] = [];
  const endpoints = await resolveProviderEndpoints(discoveryProvider(issuer), {
    fetchImpl: (url) => {
      asked.push(url);
      return Promise.resolve(idp.respond(url));
    },
  });
  assertEquals(asked, [`${issuer}.well-known/openid-configuration`]);
  assertEquals(asked[0].includes("//.well-known"), false, "no doubled slash");
  assertEquals(endpoints.issuer, issuer);
});

Deno.test("discovery: a provider with neither endpoints nor an issuer is a config error", async () => {
  const orphan = { ...discoveryProvider(freshIssuer()), discovery: undefined };
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(orphan),
      DiscoveryError,
    )) as DiscoveryError)
      .code,
    "missing_issuer",
  );
  const httpIssuer = discoveryProvider("http://idp.internal");
  assertEquals(
    ((await assertRejects(
      () => resolveProviderEndpoints(httpIssuer),
      DiscoveryError,
    )) as DiscoveryError).code,
    "insecure_endpoint",
  );
});

// ---- The JWKS cache --------------------------------------------------------

Deno.test("jwks cache: keys are fetched once and reused, and honour the document's max-age", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const doFetch = idpFetch(idp);
  const first = await getJwks(idp.jwksUrl, doFetch, { kid: "k1", now: 0 });
  assertEquals(first.length, 1);
  assertEquals(idp.hits.jwks, 1);
  await getJwks(idp.jwksUrl, doFetch, { kid: "k1", now: 59 * 60 * 1000 });
  assertEquals(idp.hits.jwks, 1, "still inside the default hour");
  await getJwks(idp.jwksUrl, doFetch, { kid: "k1", now: 61 * 60 * 1000 });
  assertEquals(idp.hits.jwks, 2, "refetched once the TTL lapsed");
});

Deno.test("jwks cache: an unknown kid refetches exactly once, then is throttled for a minute", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const doFetch = idpFetch(idp);
  await getJwks(idp.jwksUrl, doFetch, { kid: "k1", now: 0 });
  assertEquals(idp.hits.jwks, 1);

  // An attacker-chosen kid: one refetch (that is how a real rotation is picked up)…
  const missed = await getJwks(idp.jwksUrl, doFetch, { kid: "attacker", now: 1_000 });
  assertEquals(idp.hits.jwks, 2);
  assert(!missed.some((k) => k.kid === "attacker"), "the key still isn't there");

  // …and then nothing, however hard the attacker leans on it.
  for (let i = 0; i < 25; i++) {
    await getJwks(idp.jwksUrl, doFetch, { kid: "attacker", now: 1_000 + i * 1_000 });
  }
  assertEquals(idp.hits.jwks, 2, "refetches are throttled to one a minute per URL");

  // A minute later one more attempt is allowed — and a genuine rotation is picked up.
  idp.rotateKid("k2");
  const rotated = await getJwks(idp.jwksUrl, doFetch, { kid: "k2", now: 70_000 });
  assertEquals(idp.hits.jwks, 3);
  assert(rotated.some((k) => k.kid === "k2"));
});

Deno.test("jwks cache: a failed refetch keeps the cached keys and is throttled too", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  let fail = false;
  let attempts = 0;
  const doFetch: ProviderFetch = (url) => {
    attempts++;
    if (fail) return Promise.reject(new Error("idp down"));
    return Promise.resolve(idp.respond(url));
  };
  await getJwks(idp.jwksUrl, doFetch, { kid: "k1", now: 0 });
  assertEquals(attempts, 1);

  fail = true;
  const stale = await getJwks(idp.jwksUrl, doFetch, { kid: "gone", now: 1_000 });
  assertEquals(attempts, 2);
  assertEquals(stale[0].kid, "k1", "the cached keys survive an IdP outage");
  await getJwks(idp.jwksUrl, doFetch, { kid: "gone", now: 2_000 });
  assertEquals(attempts, 2, "a failure is throttled like any other attempt");

  // With nothing cached at all, the failure surfaces to the caller.
  await assertRejects(
    () => getJwks(`${freshIssuer()}/jwks`, () => Promise.reject(new Error("idp down"))),
    Error,
    "idp down",
  );
});

// ---- End to end through the routes -----------------------------------------

/** The id_token the stub token endpoint currently serves. */
let pendingIdToken: string | undefined;

Deno.test("routes: a discovery-only provider signs in, and the events + logger see it", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const signIns: { user: AuthUser; provider: string }[] = [];
  const failures: { provider?: string; reason: string }[] = [];
  const errors: string[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true, // route provider fetches via the stub `fetch`
    providers: [discoveryProvider(issuer)],
    events: {
      signIn: (payload) => {
        signIns.push({ user: payload.user, provider: payload.provider });
      },
      signInFailed: (payload) => {
        failures.push({ provider: payload.provider, reason: payload.reason });
      },
    },
    logger: { error: (message) => errors.push(message) },
  };

  // Two sign-ins: the discovery document and the JWKS are each fetched once.
  await withFetch((url) => idp.respond(url, pendingIdToken), async () => {
    for (let i = 0; i < 2; i++) {
      const signin = await run(new Request(`${ORIGIN}/auth/signin/idp`), config);
      assertEquals(signin.res!.status, 303);
      const authUrl = new URL(signin.res!.headers.get("location")!);
      assertEquals(authUrl.origin, issuer);
      assertEquals(authUrl.pathname, "/authorize");
      const state = authUrl.searchParams.get("state")!;
      const nonce = authUrl.searchParams.get("nonce")!;
      const txPair = signin.ctx.outgoingHeaders.getSetCookie()
        .find((c) => c.startsWith("__Host-denext_auth_tx="))!.split(";")[0];
      pendingIdToken = await idp.mintIdToken({
        iss: issuer,
        aud: "client-123",
        sub: "user-9",
        nonce,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const callback = await run(
        new Request(`${ORIGIN}/auth/callback/idp?code=c0de&state=${state}`, {
          headers: { cookie: txPair },
        }),
        config,
      );
      assertEquals(callback.res!.status, 303);
      assertEquals(callback.res!.headers.get("location"), "/");
      assert(
        callback.ctx.outgoingHeaders.getSetCookie().some((c) =>
          c.startsWith("__Host-denext_auth=")
        ),
        "a session cookie was issued",
      );
    }
  });

  assertEquals(idp.hits.discovery, 1, "the discovery document is fetched once for both logins");
  assertEquals(idp.hits.jwks, 1, "so is the JWKS");
  assertEquals(signIns.length, 2);
  assertEquals(signIns[0].provider, "idp");
  assertEquals(signIns[0].user.id, "user-9");
  assertEquals(failures.length, 0);
  assertEquals(errors.length, 0);
});

Deno.test("routes: a discovery failure is a ?error=config redirect, not a 500", async () => {
  const issuer = freshIssuer();
  const failures: { provider?: string; reason: string }[] = [];
  const errors: { message: string; error: unknown }[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true,
    providers: [discoveryProvider(issuer)],
    pages: { signIn: "/login" },
    events: {
      signInFailed: (payload) => {
        failures.push({ provider: payload.provider, reason: payload.reason });
      },
    },
    logger: { error: (message, error) => errors.push({ message, error }) },
  };

  await withFetch(() => new Response("boom", { status: 503 }), async () => {
    const signin = await run(new Request(`${ORIGIN}/auth/signin/idp`), config);
    assertEquals(signin.res!.status, 303);
    assertEquals(signin.res!.headers.get("location"), "/login?error=config");
  });

  assertEquals(failures, [{ provider: "idp", reason: "config" }]);
  assertEquals(errors.length, 1);
  assert(errors[0].error instanceof DiscoveryError, "the cause reaches the logger");
  assertEquals((errors[0].error as DiscoveryError).code, "unreachable");
});

Deno.test("routes: a failed token exchange reaches logger.error and fires signInFailed", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const failures: { provider?: string; reason: string }[] = [];
  const errors: { message: string; error: unknown }[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true,
    providers: [discoveryProvider(issuer)],
    events: {
      signInFailed: (payload) => {
        failures.push({ provider: payload.provider, reason: payload.reason });
      },
    },
    logger: { error: (message, error) => errors.push({ message, error }) },
  };

  await withFetch((url) => {
    if (url.endsWith("/token")) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return idp.respond(url);
  }, async () => {
    const signin = await run(new Request(`${ORIGIN}/auth/signin/idp`), config);
    const state = new URL(signin.res!.headers.get("location")!).searchParams.get("state")!;
    const txPair = signin.ctx.outgoingHeaders.getSetCookie()
      .find((c) => c.startsWith("__Host-denext_auth_tx="))!.split(";")[0];
    const callback = await run(
      new Request(`${ORIGIN}/auth/callback/idp?code=c0de&state=${state}`, {
        headers: { cookie: txPair },
      }),
      config,
    );
    assertEquals(callback.res!.status, 303);
    assertEquals(callback.res!.headers.get("location"), "/?error=oauth_failed");
  });

  assertEquals(failures, [{ provider: "idp", reason: "oauth_failed" }]);
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0].message, "callback failed");
  assertStringIncludes(String((errors[0].error as Error).message), "token exchange failed");
});

Deno.test("routes: the provider's own ?error= and a bad state both fire signInFailed", async () => {
  const issuer = freshIssuer();
  const failures: { provider?: string; reason: string }[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true,
    providers: [discoveryProvider(issuer)],
    events: {
      signInFailed: (payload) => {
        failures.push({ provider: payload.provider, reason: payload.reason });
      },
    },
  };
  const denied = await run(
    new Request(`${ORIGIN}/auth/callback/idp?error=access_denied`),
    config,
  );
  assertEquals(denied.res!.headers.get("location"), "/?error=access_denied");
  const bad = await run(new Request(`${ORIGIN}/auth/callback/idp?code=c&state=nope`), config);
  assertEquals(bad.res!.headers.get("location"), "/?error=invalid_state");
  assertEquals(failures, [
    { provider: "idp", reason: "access_denied" },
    { provider: "idp", reason: "invalid_state" },
  ]);
});

// The pinned host set is what `makeProviderFetch` is given after discovery: only the
// hosts the resolved endpoints actually name (an `allowedHosts` entry nothing points at
// widens nothing).
Deno.test("endpointHosts: the pinned host set follows the resolved endpoints", async () => {
  const issuer = freshIssuer();
  const idp = await makeIdp(issuer);
  const endpoints: ProviderEndpoints = await resolveProviderEndpoints(
    discoveryProvider(issuer, { allowedHosts: ["extra.test"] }),
    { fetchImpl: idpFetch(idp) },
  );
  assertEquals(endpointHosts(endpoints), [new URL(issuer).host]);
});
