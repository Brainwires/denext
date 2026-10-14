// `microsoftEntra({ tenant: "common" | "organizations" | "consumers" })`: a multi-tenant app's
// `id_token` carries its tenant's own issuer (`https://login.microsoftonline.com/{tid}/v2.0`), so
// the issuer is checked against the token's OWN `tid` claim — the template issuer Microsoft's
// discovery document declares — with the signature checked against the common key set. A token
// whose `iss` names another tenant than its `tid`, a missing or malformed `tid`, the literal
// template, a tenant outside `allowedTenants`, and (for `organizations`) a personal account are
// all refused.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { type Jwk, verifyIdToken } from "../src/server/auth/jwt.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import { microsoftEntra } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const CRED = { clientId: "cid", clientSecret: "csecret" };
const TENANT_A = "11111111-2222-4333-8444-555555555555";
const TENANT_B = "99999999-8888-4777-8666-555555555555";
const MSA = "9188040d-6c67-4c5b-b112-36a304b66dad";
const iss = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const JWKS: Jwk[] = [{ kty: "RSA", kid: "k1", n: publicJwk.n, e: publicJwk.e, alg: "RS256" }];

const seg = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** An RS256 id_token signed with the test key (the "common" key set). */
async function token(claims: Record<string, unknown>): Promise<string> {
  const input = `${seg({ alg: "RS256", typ: "JWT", kid: "k1" })}.${seg(claims)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function claims(tid: string | undefined, issuer: string, extra: Record<string, unknown> = {}) {
  return {
    iss: issuer,
    aud: "cid",
    sub: "pairwise-sub",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...(tid === undefined ? {} : { tid }),
    ...extra,
  };
}

/** Verify a token the way the callback does for this provider. */
async function verifyFor(
  provider: ReturnType<typeof microsoftEntra>,
  claimSet: Record<string, unknown>,
) {
  return await verifyIdToken({
    idToken: await token(claimSet),
    jwks: JWKS,
    issuer: provider.issuer!,
    audience: "cid",
    ...(provider.tenantIssuer ? { tenantIssuer: provider.tenantIssuer } : {}),
  });
}

// ---- the preset ------------------------------------------------------------------------------

Deno.test("microsoftEntra: common / organizations take the template issuer and the alias keys", () => {
  for (const tenant of ["common", "organizations"]) {
    const p = microsoftEntra({ ...CRED, tenant });
    assertEquals(p.issuer, "https://login.microsoftonline.com/{tenantid}/v2.0");
    assertEquals(p.jwksUrl, `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`);
    assertEquals(
      p.authorizationUrl,
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    );
    assertEquals(p.discovery, undefined, "the alias document is not at the issuer");
    assertEquals(p.tenantIssuer?.claim, "tid");
  }
  assertEquals(microsoftEntra({ ...CRED, tenant: "organizations" }).tenantIssuer?.excludedTenants, [
    MSA,
  ]);
  assertEquals(
    microsoftEntra({ ...CRED, tenant: "common" }).tenantIssuer?.excludedTenants,
    undefined,
  );
});

Deno.test("microsoftEntra: consumers is the personal-account tenant's fixed issuer", () => {
  const p = microsoftEntra({ ...CRED, tenant: "consumers" });
  assertEquals(p.issuer, iss(MSA));
  assertEquals(p.tenantIssuer, undefined);
  assertEquals(p.jwksUrl, "https://login.microsoftonline.com/consumers/discovery/v2.0/keys");
});

Deno.test("microsoftEntra: allowedTenants is validated and only for common / organizations", () => {
  const p = microsoftEntra({ ...CRED, tenant: "common", allowedTenants: [TENANT_A.toUpperCase()] });
  assertEquals(p.tenantIssuer?.allowedTenants, [TENANT_A], "normalized to lower case");
  assertThrows(
    () => microsoftEntra({ ...CRED, tenant: TENANT_A, allowedTenants: [TENANT_A] }),
    TypeError,
    "common",
  );
  assertThrows(
    () => microsoftEntra({ ...CRED, tenant: "consumers", allowedTenants: [MSA] }),
    TypeError,
  );
  for (const bad of [[], ["contoso.com"], ["{tenantid}"], [`${TENANT_A}/x`]]) {
    assertThrows(
      () => microsoftEntra({ ...CRED, tenant: "common", allowedTenants: bad }),
      TypeError,
      "GUID",
    );
  }
  assertThrows(
    () => microsoftEntra({ ...CRED, tenant: "organizations", allowedTenants: [MSA] }),
    TypeError,
    "personal-account",
  );
  assertThrows(() => microsoftEntra({ ...CRED, tenant: "contoso.com/evil" }), TypeError);
});

// ---- the issuer check ------------------------------------------------------------------------

Deno.test("common: a token whose iss matches its own tid verifies, from any tenant", async () => {
  const p = microsoftEntra({ ...CRED, tenant: "common" });
  for (const tid of [TENANT_A, TENANT_B, MSA]) {
    assertEquals((await verifyFor(p, claims(tid, iss(tid)))).tid, tid);
  }
});

Deno.test("common: a forged iss / tid mismatch is refused, both ways", async () => {
  const p = microsoftEntra({ ...CRED, tenant: "common" });
  await assertRejects(() => verifyFor(p, claims(TENANT_A, iss(TENANT_B))), Error, "issuer");
  await assertRejects(() => verifyFor(p, claims(TENANT_B, iss(TENANT_A))), Error, "issuer");
  // The literal template, and an issuer on another host, never match.
  await assertRejects(() => verifyFor(p, claims(TENANT_A, p.issuer!)), Error, "issuer");
  await assertRejects(
    () => verifyFor(p, claims(TENANT_A, `https://evil.test/${TENANT_A}/v2.0`)),
    Error,
    "issuer",
  );
});

Deno.test("common: a missing, non-string or malformed tid is refused before any comparison", async () => {
  const p = microsoftEntra({ ...CRED, tenant: "common" });
  for (const tid of [undefined, "", "contoso.com", MSA.toUpperCase(), `${TENANT_A}/v2.0#`]) {
    await assertRejects(() => verifyFor(p, claims(tid, iss(TENANT_A))), Error, "tenant");
  }
  await assertRejects(
    () => verifyFor(p, { ...claims(undefined, iss(TENANT_A)), tid: 42 }),
    Error,
    "tenant",
  );
  // A tid crafted to rewrite the template into another issuer is not a GUID.
  await assertRejects(
    () => verifyFor(p, claims("x/v2.0", "https://login.microsoftonline.com/x/v2.0/v2.0")),
    Error,
    "tenant",
  );
});

Deno.test("allowedTenants: a tenant outside the list is refused even with a matching iss", async () => {
  const p = microsoftEntra({ ...CRED, tenant: "common", allowedTenants: [TENANT_A] });
  assertEquals((await verifyFor(p, claims(TENANT_A, iss(TENANT_A)))).tid, TENANT_A);
  await assertRejects(() => verifyFor(p, claims(TENANT_B, iss(TENANT_B))), Error, "not allowed");
});

Deno.test("organizations: a personal account is refused; consumers accepts only it", async () => {
  const orgs = microsoftEntra({ ...CRED, tenant: "organizations" });
  await assertRejects(() => verifyFor(orgs, claims(MSA, iss(MSA))), Error, "not allowed");
  assertEquals((await verifyFor(orgs, claims(TENANT_A, iss(TENANT_A)))).tid, TENANT_A);
  const consumers = microsoftEntra({ ...CRED, tenant: "consumers" });
  assertEquals((await verifyFor(consumers, claims(MSA, iss(MSA)))).tid, MSA);
  await assertRejects(() => verifyFor(consumers, claims(TENANT_A, iss(TENANT_A))), Error, "issuer");
});

Deno.test("a single tenant still compares its fixed issuer exactly", async () => {
  const p = microsoftEntra({ ...CRED, tenant: TENANT_A });
  assertEquals(p.tenantIssuer, undefined);
  assertEquals((await verifyFor(p, claims(TENANT_A, iss(TENANT_A)))).tid, TENANT_A);
  await assertRejects(() => verifyFor(p, claims(TENANT_B, iss(TENANT_B))), Error, "issuer");
});

// ---- the whole callback ------------------------------------------------------------------------

/** Sign in through `/auth/signin` → `/auth/callback` with Microsoft stubbed; the id_token's claims from `make`. */
async function login(
  config: AuthConfig,
  make: (nonce: string) => Record<string, unknown>,
): Promise<{ location: string; session: string | undefined }> {
  const signinReq = new Request(`${ORIGIN}/auth/signin/microsoft-entra`);
  const signinCtx = createRequestContext(signinReq);
  const signin = (await runWithContext(signinCtx, () => handleAuthRequest(signinReq, config)))!;
  const authorize = new URL(signin.headers.get("location")!);
  assertEquals(authorize.host, "login.microsoftonline.com");
  const state = authorize.searchParams.get("state")!;
  const nonce = authorize.searchParams.get("nonce")!;
  const tx = signinCtx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth_tx="))!.split(";")[0];
  const idToken = await token(make(nonce));
  const cbReq = new Request(`${ORIGIN}/auth/callback/microsoft-entra?code=c0de&state=${state}`, {
    headers: { cookie: tx },
  });
  const cbCtx = createRequestContext(cbReq);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/oauth2/v2.0/token")) {
      return Promise.resolve(
        Response.json({ access_token: "at", token_type: "bearer", id_token: idToken }),
      );
    }
    if (url === "https://login.microsoftonline.com/common/discovery/v2.0/keys") {
      return Promise.resolve(Response.json({ keys: JWKS }));
    }
    return Promise.resolve(new Response("unexpected", { status: 404 }));
  }) as typeof fetch;
  try {
    const cb = (await runWithContext(cbCtx, () => handleAuthRequest(cbReq, config)))!;
    const session = cbCtx.outgoingHeaders.getSetCookie()
      .find((c) => c.startsWith("__Host-denext_auth=") && !c.startsWith("__Host-denext_auth=;"));
    return { location: cb.headers.get("location") ?? "", session };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function entraConfig(allowedTenants?: string[]): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true, // route provider calls through the stubbed fetch
    providers: [
      microsoftEntra({ ...CRED, tenant: "common", ...(allowedTenants ? { allowedTenants } : {}) }),
    ],
    pages: { signIn: "/login", afterSignIn: "/home" },
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
  };
}

Deno.test("callback: tenant common signs in a token whose iss matches its tid", async () => {
  const result = await login(
    entraConfig(),
    (nonce) => ({ ...claims(TENANT_A, iss(TENANT_A)), nonce }),
  );
  assert(result.session, `no session (landed on ${result.location})`);
  assertEquals(new URL(result.location, ORIGIN).pathname, "/home");
});

Deno.test("callback: a forged iss/tid mismatch, or a tenant outside allowedTenants, gets no session", async () => {
  const forged = await login(
    entraConfig(),
    (nonce) => ({ ...claims(TENANT_A, iss(TENANT_B)), nonce }),
  );
  assertEquals(forged.session, undefined);
  assertStringIncludes(forged.location, "error=");
  const outside = await login(
    entraConfig([TENANT_A]),
    (nonce) => ({ ...claims(TENANT_B, iss(TENANT_B)), nonce }),
  );
  assertEquals(outside.session, undefined);
  assertStringIncludes(outside.location, "error=");
});
