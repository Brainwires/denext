// Supabase-compatible keys and JWTs (src/server/auth/gotrue/keys.ts): ES256 / HS256 signing and
// verification, the refusals that matter (alg none, algorithm confusion, a wrong key, an expired
// or future token, a role Supabase doesn't define), API key roles in constant time, key rotation
// by `kid`, the JWKS, generated key sets, and the installed slot.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  apiKeyRole,
  canSign,
  generateSupabaseKeys,
  installedSupabaseKeys,
  installSupabaseKeys,
  looksLikeJwt,
  opaqueKeyRole,
  resolveSupabaseKeys,
  signSupabaseJwt,
  SUPABASE_KEY_ENV,
  supabaseJwks,
  SupabaseKeyError,
  verifySupabaseJwt,
} from "../src/server/auth/gotrue/keys.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";

const SECRET = "legacy-jwt-secret-at-least-32-characters!";
const now = () => Math.floor(Date.now() / 1000);
const enc = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function hs256(secret: string, header: unknown, claims: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}

Deno.test("ES256: sign and verify; the JWKS publishes only the public half", async () => {
  const generated = await generateSupabaseKeys();
  const keys = await resolveSupabaseKeys({ signingKeys: generated.signingKey });
  assert(canSign(keys));
  const token = await signSupabaseJwt(keys, {
    sub: "u1",
    role: "authenticated",
    exp: now() + 60,
    iat: now(),
  });
  const header = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
  assertEquals(header, { alg: "ES256", kid: generated.signingKey.kid, typ: "JWT" });
  const claims = await verifySupabaseJwt(keys, token);
  assertEquals(claims.sub, "u1");
  assertEquals(claims.role, "authenticated");
  const jwks = supabaseJwks(keys);
  assertEquals(jwks.keys.length, 1);
  assertEquals((jwks.keys[0] as { d?: string }).d, undefined);
  assertEquals(jwks.keys[0].alg, "ES256");
  // A tampered payload fails.
  const [h, , s] = token.split(".");
  const forged = `${h}.${enc({ sub: "u2", role: "authenticated", exp: now() + 60 })}.${s}`;
  await assertRejects(() => verifySupabaseJwt(keys, forged), SupabaseKeyError, "signature");
});

Deno.test("HS256 under the legacy secret; never `none`, never a public key as an HMAC secret", async () => {
  const generated = await generateSupabaseKeys();
  const hsOnly = await resolveSupabaseKeys({ jwtSecret: SECRET });
  const token = await signSupabaseJwt(hsOnly, { role: "anon", exp: now() + 60 });
  assertEquals((await verifySupabaseJwt(hsOnly, token)).role, "anon");

  const both = await resolveSupabaseKeys({ jwtSecret: SECRET, signingKeys: generated.signingKey });
  // ES256 signs when a signing key exists; HS256 tokens still verify.
  const signed = await signSupabaseJwt(both, { role: "anon", exp: now() + 60 });
  assert(signed.startsWith(enc({ alg: "ES256", kid: generated.signingKey.kid, typ: "JWT" })));
  assertEquals((await verifySupabaseJwt(both, token)).role, "anon");

  // alg none.
  const none = `${enc({ alg: "none", typ: "JWT" })}.${
    enc({ role: "service_role", exp: now() + 60 })
  }.`;
  await assertRejects(() => verifySupabaseJwt(both, none), SupabaseKeyError);
  // Algorithm confusion: an HS256 token keyed with the PUBLIC JWK's JSON.
  const ecOnly = await resolveSupabaseKeys({ signingKeys: generated.signingKey });
  const publicJson = JSON.stringify(supabaseJwks(ecOnly).keys[0]);
  const confused = await hs256(publicJson, { alg: "HS256", typ: "JWT" }, {
    role: "service_role",
    exp: now() + 60,
  });
  await assertRejects(() => verifySupabaseJwt(ecOnly, confused), SupabaseKeyError);
  // HS256 with the wrong secret.
  const wrong = await hs256("x".repeat(40), { alg: "HS256" }, { role: "anon", exp: now() + 60 });
  await assertRejects(() => verifySupabaseJwt(hsOnly, wrong), SupabaseKeyError);
  // An unexpected typ.
  const typed = await hs256(SECRET, { alg: "HS256", typ: "at+jwt" }, {
    role: "anon",
    exp: now() + 60,
  });
  await assertRejects(() => verifySupabaseJwt(hsOnly, typed), SupabaseKeyError, "typ");
});

Deno.test("claims: exp required and enforced; nbf / iat in the future; only Supabase's roles", async () => {
  const keys = await resolveSupabaseKeys({ jwtSecret: SECRET });
  const sign = (claims: Record<string, unknown>) => signSupabaseJwt(keys, claims);
  const expired = await sign({ role: "anon", exp: now() - 120 });
  const error = await assertRejects(() => verifySupabaseJwt(keys, expired), SupabaseKeyError);
  assertEquals(error.code, "jwt_expired");
  await assertRejects(() => verifySupabaseJwt(keys, "x.y"), SupabaseKeyError, "malformed");
  await assertRejects(
    async () => verifySupabaseJwt(keys, await sign({ role: "anon" })),
    SupabaseKeyError,
    "exp",
  );
  await assertRejects(
    async () =>
      verifySupabaseJwt(keys, await sign({ role: "anon", exp: now() + 60, nbf: now() + 600 })),
    SupabaseKeyError,
    "not valid yet",
  );
  await assertRejects(
    async () =>
      verifySupabaseJwt(keys, await sign({ role: "anon", exp: now() + 900, iat: now() + 600 })),
    SupabaseKeyError,
    "before issued",
  );
  await assertRejects(
    async () => verifySupabaseJwt(keys, await sign({ role: "postgres", exp: now() + 60 })),
    SupabaseKeyError,
    "role",
  );
  await assertRejects(
    async () => verifySupabaseJwt(keys, await sign({ role: "authenticated", exp: now() + 60 })),
    SupabaseKeyError,
    "sub",
  );
  // A clock passed in.
  const later = await sign({ role: "anon", exp: 2000 });
  assertEquals((await verifySupabaseJwt(keys, later, { now: 1_000_000 })).exp, 2000);
  // A JSON array payload is malformed.
  const array = await hs256(SECRET, { alg: "HS256" }, [1]);
  await assertRejects(() => verifySupabaseJwt(keys, array), SupabaseKeyError, "malformed");
});

Deno.test("rotation: every configured key verifies by kid, the first signs", async () => {
  const [a, b] = await Promise.all([generateSupabaseKeys(), generateSupabaseKeys()]);
  const old = await resolveSupabaseKeys({ signingKeys: a.signingKey });
  const token = await signSupabaseJwt(old, { role: "anon", exp: now() + 60 });
  const rotated = await resolveSupabaseKeys({ signingKeys: [b.signingKey, a.signingKey] });
  assertEquals((await verifySupabaseJwt(rotated, token)).role, "anon");
  assertEquals(supabaseJwks(rotated).keys.map((k) => (k as { kid: string }).kid), [
    b.signingKey.kid,
    a.signingKey.kid,
  ]);
  const dropped = await resolveSupabaseKeys({ signingKeys: b.signingKey });
  await assertRejects(() => verifySupabaseJwt(dropped, token), SupabaseKeyError);
  // A key without a kid gets its RFC 7638 thumbprint.
  const { kid: _kid, ...anonymous } = a.signingKey;
  const thumb = await resolveSupabaseKeys({ signingKeys: anonymous });
  assertEquals((supabaseJwks(thumb).keys[0] as { kid: string }).kid, a.signingKey.kid);
});

Deno.test("API keys: opaque publishable / secret, legacy JWTs, constant-time, refusals", async () => {
  const g = await generateSupabaseKeys({ legacy: true });
  assert(g.anonKey && g.serviceRoleKey && g.jwtSecret);
  const keys = await resolveSupabaseKeys({
    publishableKey: g.publishableKey,
    secretKey: [g.secretKey, "sb_secret_old"],
    jwtSecret: g.jwtSecret,
  });
  assertEquals(await apiKeyRole(keys, g.publishableKey), "anon");
  assertEquals(await apiKeyRole(keys, g.secretKey), "service_role");
  assertEquals(await apiKeyRole(keys, "sb_secret_old"), "service_role");
  assertEquals(await apiKeyRole(keys, g.anonKey), "anon");
  assertEquals(await apiKeyRole(keys, g.serviceRoleKey), "service_role");
  assertEquals(await opaqueKeyRole(keys, "nope"), null);
  const err = await assertRejects(() => apiKeyRole(keys, "sb_publishable_nope"), SupabaseKeyError);
  assertEquals(err.code, "invalid_api_key");
  assert(!err.message.includes("nope"), "the key is never echoed");
  // A user's access token is not an API key.
  const user = await signSupabaseJwt(keys, { sub: "u", role: "authenticated", exp: now() + 60 });
  await assertRejects(() => apiKeyRole(keys, user), SupabaseKeyError, "Invalid API key");
  await assertRejects(() => apiKeyRole(keys, "a.b.c"), SupabaseKeyError, "Invalid API key");
  assert(g.publishableKey.startsWith("sb_publishable_") && g.secretKey.startsWith("sb_secret_"));
  assert(looksLikeJwt(g.anonKey) && !looksLikeJwt(g.publishableKey));
});

Deno.test("resolve: env fallbacks, and the misconfigurations refused", async () => {
  const g = await generateSupabaseKeys();
  const env: Record<string, string> = {
    [SUPABASE_KEY_ENV.publishableKey]: `${g.publishableKey}, sb_publishable_two`,
    [SUPABASE_KEY_ENV.secretKey]: g.secretKey,
    [SUPABASE_KEY_ENV.signingKeys]: JSON.stringify([g.signingKey]),
  };
  const keys = await resolveSupabaseKeys({}, (name) => env[name]);
  assertEquals(keys.publishable.length, 2);
  assertEquals(await apiKeyRole(keys, "sb_publishable_two"), "anon");
  assertEquals(keys.ec.length, 1);
  const single = await resolveSupabaseKeys(
    {},
    (name) => name === SUPABASE_KEY_ENV.signingKeys ? JSON.stringify(g.signingKey) : undefined,
  );
  assertEquals(single.ec.length, 1);
  await assertRejects(
    () => resolveSupabaseKeys({}, (n) => n === SUPABASE_KEY_ENV.signingKeys ? "{" : undefined),
    TypeError,
    "not valid JSON",
  );
  await assertRejects(() => resolveSupabaseKeys({ jwtSecret: "short" }), TypeError, "32");
  await assertRejects(
    () => resolveSupabaseKeys({ publishableKey: "k", secretKey: "k" }),
    TypeError,
    "both",
  );
  await assertRejects(
    () => resolveSupabaseKeys({ signingKeys: { kty: "RSA", n: "x", e: "AQAB" } }),
    TypeError,
    "P-256",
  );
  const { d: _d, ...publicOnly } = g.signingKey;
  await assertRejects(() => resolveSupabaseKeys({ signingKeys: publicOnly }), TypeError, "private");
  // A public key AFTER the signing key only verifies.
  const verifyOnly = await resolveSupabaseKeys({
    signingKeys: [(await generateSupabaseKeys()).signingKey, publicOnly],
  });
  assertEquals(verifyOnly.ec.length, 2);
  const empty = await resolveSupabaseKeys();
  assert(!canSign(empty));
  await assertRejects(() => signSupabaseJwt(empty, { role: "anon" }), Error, "no signing key");
  assertThrows(() => {
    throw new SupabaseKeyError("bad_jwt", "x");
  }, SupabaseKeyError);
});

Deno.test("the installed slot is process-global", async () => {
  const keys = await resolveSupabaseKeys({ jwtSecret: SECRET });
  installSupabaseKeys(keys);
  try {
    assertEquals(installedSupabaseKeys(), keys);
  } finally {
    installSupabaseKeys(undefined);
  }
  assertEquals(installedSupabaseKeys(), undefined);
});
