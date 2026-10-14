// `resolveIdentity()` (packages/backend/src/identity.ts): who a request is — a user's access
// token, the secret key, the denext session, or anon — in that order; a presented credential
// that is refused is a 401, never a downgrade; `db()` runs as that identity (the service role as
// the connecting role, with its claims); `auth()` reads a Supabase access token as a session,
// and a revoked session's tokens die at once. Also `backend({ supabase })`: the keys it installs,
// the JWKS route, the dev key file, and `denext backend keys`.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import { getPluginCommands } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { auth, denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import {
  generateSupabaseKeys,
  installedSupabaseKeys,
  installSupabaseKeys,
  resolveSupabaseKeys,
  signSupabaseJwt,
  type SupabaseKeys,
  verifySupabaseJwt,
} from "../src/server/auth/gotrue/keys.ts";
import { sessionFromClaims } from "../src/server/auth/gotrue/access.ts";
import { backend } from "../packages/backend/mod.ts";
import {
  ANON_IDENTITY,
  db,
  IdentityError,
  identityScope,
  isIdentityError,
  resolveIdentity,
} from "../packages/backend/server.ts";
import { installPostgres } from "../packages/backend/src/postgres.ts";
import {
  createBackendCommand,
  DEV_KEYS_FILE,
  tokenClaims,
} from "../packages/backend/src/supabase.ts";
import { fakeSqlClient } from "./helpers/fake-sql-client.ts";

const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const ORIGIN = "https://app.test";
const USER = "0b7c3c1e-1f1a-4a57-9c39-2d0a7f1a0001";
const adapter = inMemoryAuthAdapter();
const authConfig: AuthConfig = {
  secret: "identity-secret-at-least-32-characters!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
  adapter,
};
denextAuth(authConfig);

const now = () => Math.floor(Date.now() / 1000);

async function cookieFor(id: string): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/** Run `fn` inside a request carrying these headers. */
function inRequest<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const context = createRequestContext(new Request(`${ORIGIN}/rest/v1/x`, { headers }));
  return runWithContext(context, fn);
}

interface Fixture {
  keys: SupabaseKeys;
  publishable: string;
  secret: string;
  anonJwt: string;
  serviceJwt: string;
  user: (claims?: Record<string, unknown>) => Promise<string>;
}

async function withKeys(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const g = await generateSupabaseKeys({ legacy: true });
  const keys = await resolveSupabaseKeys({
    publishableKey: g.publishableKey,
    secretKey: g.secretKey,
    jwtSecret: g.jwtSecret,
    signingKeys: g.signingKey,
  });
  installSupabaseKeys(keys);
  try {
    await fn({
      keys,
      publishable: g.publishableKey,
      secret: g.secretKey,
      anonJwt: g.anonKey!,
      serviceJwt: g.serviceRoleKey!,
      user: (claims = {}) =>
        signSupabaseJwt(keys, {
          sub: USER,
          role: "authenticated",
          aud: "authenticated",
          email: "a@x.test",
          exp: now() + 600,
          iat: now(),
          ...claims,
        }),
    });
  } finally {
    installSupabaseKeys(undefined);
  }
}

Deno.test("no keys installed: the denext session or anon; requireApiKey refuses", async () => {
  assertEquals(installedSupabaseKeys(), undefined);
  assertEquals(await resolveIdentity(undefined), ANON_IDENTITY);
  assertEquals(await resolveIdentity(), ANON_IDENTITY, "no request current");
  assertEquals((await inRequest({}, () => resolveIdentity())).role, "anon");
  const cookie = await cookieFor(USER);
  const me = await inRequest({ cookie }, () => resolveIdentity());
  assertEquals(me.role, "authenticated");
  assertEquals(me.source, "session");
  assertEquals(me.userId, USER);
  assertEquals(me.claims.sub, USER);
  assertEquals(me.session?.user.id, USER);
  // rls.claims adds claims to a session.
  const custom = await inRequest(
    { cookie },
    () => resolveIdentity(undefined, { rls: { claims: () => ({ tenant: "t1" }) } }),
  );
  assertEquals(custom.claims.tenant, "t1");
  const refused = await assertRejects(
    () => inRequest({}, () => resolveIdentity(undefined, { requireApiKey: true })),
    IdentityError,
  );
  assertEquals(refused.code, "no_api_key");
  assertEquals(refused.status, 401);
});

Deno.test("keys: publishable → anon, secret → service_role, a bad key → 401", async () => {
  await withKeys(async (f) => {
    const anon = await inRequest({ apikey: f.publishable }, () => resolveIdentity());
    assertEquals(anon, { role: "anon", claims: { role: "anon" }, source: "api_key" });
    const service = await inRequest({ apikey: f.secret }, () => resolveIdentity());
    assertEquals(service.role, "service_role");
    assertEquals(service.claims, { role: "service_role" });
    // Legacy JWT keys, in the header or as the bearer (supabase-js sends both).
    for (
      const headers of [
        { apikey: f.serviceJwt },
        { authorization: `Bearer ${f.serviceJwt}` },
      ] as Record<string, string>[]
    ) {
      assertEquals((await inRequest(headers, () => resolveIdentity())).role, "service_role");
    }
    assertEquals(
      (await inRequest(
        { apikey: f.publishable, authorization: `Bearer ${f.publishable}` },
        () => resolveIdentity(),
      )).role,
      "anon",
    );
    for (const bad of ["sb_publishable_forged", "nope", f.anonJwt.slice(0, -2) + "xx"]) {
      const error = await assertRejects(
        () => inRequest({ apikey: bad }, () => resolveIdentity()),
        IdentityError,
      );
      assertEquals(error.code, "invalid_api_key");
      assert(isIdentityError(error));
    }
    const forgedBearer = await assertRejects(
      () => inRequest({ authorization: "Bearer sb_secret_forged" }, () => resolveIdentity()),
      IdentityError,
    );
    assertEquals(forgedBearer.code, "invalid_api_key");
    // requireApiKey: a keyless request is refused; a keyed one passes.
    await assertRejects(
      () => inRequest({}, () => resolveIdentity(undefined, { requireApiKey: true })),
      IdentityError,
      "No API key",
    );
    assertEquals(
      (await inRequest(
        { apikey: f.publishable },
        () => resolveIdentity(undefined, { requireApiKey: true }),
      )).role,
      "anon",
    );
  });
});

Deno.test("a user's access token wins; an expired or forged one is a 401", async () => {
  await withKeys(async (f) => {
    const token = await f.user({ user_metadata: { name: "A" } });
    const me = await inRequest(
      { apikey: f.secret, authorization: `Bearer ${token}` },
      () => resolveIdentity(),
    );
    assertEquals(me.role, "authenticated", "the user's token beats the secret apikey");
    assertEquals(me.source, "jwt");
    assertEquals(me.userId, USER);
    assertEquals(me.claims.user_metadata, { name: "A" });
    const expired = await f.user({ exp: now() - 600 });
    const error = await assertRejects(
      () => inRequest({ authorization: `Bearer ${expired}` }, () => resolveIdentity()),
      IdentityError,
    );
    assertEquals(error.code, "jwt_expired");
    const forged = token.slice(0, token.lastIndexOf(".") + 1) + "AAAA";
    assertEquals(
      (await assertRejects(
        () => inRequest({ authorization: `Bearer ${forged}` }, () => resolveIdentity()),
        IdentityError,
      )).code,
      "bad_jwt",
    );
    // Another bearer scheme / an opaque denext token is left to auth() (no cookie: anon).
    assertEquals(
      (await inRequest({ authorization: "Bearer tok_abc" }, () => resolveIdentity())).role,
      "anon",
    );
    assertEquals(
      (await inRequest({ authorization: "Basic abc" }, () => resolveIdentity())).role,
      "anon",
    );
  });
});

Deno.test("cookie session vs keys: anon key + cookie is the user, the secret key is service", async () => {
  await withKeys(async (f) => {
    const cookie = await cookieFor(USER);
    const viaAnon = await inRequest(
      { cookie, apikey: f.publishable, authorization: `Bearer ${f.anonJwt}` },
      () => resolveIdentity(),
    );
    assertEquals(viaAnon.role, "authenticated");
    assertEquals(viaAnon.source, "session");
    const viaSecret = await inRequest({ cookie, apikey: f.secret }, () => resolveIdentity());
    assertEquals(viaSecret.role, "service_role");
  });
});

Deno.test("auth() reads an access token as a session; revoking its session kills it", async () => {
  await withKeys(async (f) => {
    // A live session family for the token's session_id.
    await adapter.createNativeSession!({
      id: "fam-1",
      userId: USER,
      generation: 0,
      salt: "s",
      session: "{}",
      createdAt: now(),
      expiresAt: now() + 3600,
    });
    const token = await f.user({
      session_id: "fam-1",
      app_metadata: { provider: "email", roles: ["editor"] },
      user_metadata: { full_name: "Ada", avatar_url: "https://x.test/a.png", email_verified: true },
      amr: [{ method: "password", timestamp: 1000 }],
    });
    const session = await inRequest({ authorization: `Bearer ${token}` }, () => auth());
    assertEquals(session?.user, {
      id: USER,
      email: "a@x.test",
      name: "Ada",
      image: "https://x.test/a.png",
      emailVerified: true,
      roles: ["editor"],
    });
    assertEquals(session?.provider, "email");
    assertEquals(session?.amr, ["password"]);
    assertEquals(session?.authTime, 1000);
    assertEquals(session?.nativeSessionId, "fam-1");
    // The anon key as the bearer is not a user: the cookie decides.
    const cookie = await cookieFor(USER);
    const viaCookie = await inRequest(
      { cookie, authorization: `Bearer ${f.anonJwt}` },
      () => auth(),
    );
    assertEquals(viaCookie?.provider, "credentials");
    // An invalid JWT bearer is signed out — never "fall back to the cookie".
    assertEquals(await inRequest({ cookie, authorization: "Bearer a.b.c" }, () => auth()), null);
    await adapter.revokeNativeSession!("fam-1");
    assertEquals(await inRequest({ authorization: `Bearer ${token}` }, () => auth()), null);
    await assertRejects(
      () => inRequest({ authorization: `Bearer ${token}` }, () => resolveIdentity()),
      IdentityError,
      "session not found",
    );
    // An unknown session id, and a family owned by someone else.
    const ghost = await f.user({ session_id: "nope" });
    assertEquals(await inRequest({ authorization: `Bearer ${ghost}` }, () => auth()), null);
    // Without a session_id there is nothing to check.
    const bare = await f.user();
    assertEquals(
      (await inRequest({ authorization: `Bearer ${bare}` }, () => auth()))?.user.id,
      USER,
    );
  });
  // Keys gone: a JWT bearer is not ours, and the cookie decides.
  assertEquals(await inRequest({ authorization: "Bearer a.b.c" }, () => auth()), null);
});

Deno.test("sessionFromClaims: minimal claims", () => {
  const session = sessionFromClaims({ sub: "u", role: "authenticated", exp: 10, amr: ["otp"] });
  assertEquals(session.user, { id: "u" });
  assertEquals(session.provider, "supabase");
  assertEquals(session.amr, ["otp"]);
  assertEquals(session.nativeSessionId, "jwt:u");
});

Deno.test("db() runs as the request's identity: user token, service role, anon key", async () => {
  const sql = fakeSqlClient();
  resetPlugins();
  installPostgres(undefined);
  await applyPlugins({
    projectRoot: "/tmp/x",
    appDir: "/tmp/x/app",
    config: { plugins: [backend({ postgres: { sql, rls: { migrate: false } } })] } as DenextConfig,
    mode: "prod",
    load,
  });
  const WHO =
    "select current_setting('role') as role, current_setting('request.jwt.claims') as claims";
  const who = async () => {
    const [row] = await db().unsafe<{ role: string; claims: string }>(WHO);
    return { role: row.role, claims: JSON.parse(row.claims) };
  };
  try {
    await withKeys(async (f) => {
      const token = await f.user();
      const user = await inRequest({ authorization: `Bearer ${token}` }, who);
      assertEquals(user.role, "authenticated");
      assertEquals(user.claims.sub, USER);
      assertEquals(user.claims.email, "a@x.test");
      const service = await inRequest({ apikey: f.secret }, who);
      assertEquals(service.role, "none", "the connecting role: no row-level security");
      assertEquals(service.claims, { role: "service_role" });
      assertEquals((await inRequest({ apikey: f.publishable }, who)).role, "anon");
      await assertRejects(() => inRequest({ apikey: "bad" }, who), IdentityError);
      // An explicit identity, outside any request.
      const identity = await inRequest({ apikey: f.secret }, () => resolveIdentity());
      const [row] = await db({ as: identity }).unsafe<{ role: string }>(WHO);
      assertEquals(row.role, "none");
    });
  } finally {
    resetPlugins();
    installPostgres(undefined);
  }
});

Deno.test("identityScope: claims carry the role; an authenticated identity needs a sub", () => {
  assertEquals(identityScope(ANON_IDENTITY), { role: "anon", claims: '{"role":"anon"}' });
  assertEquals(
    identityScope({ role: "authenticated", claims: { sub: "u", role: "x" }, source: "jwt" }),
    { role: "authenticated", claims: '{"sub":"u","role":"authenticated"}' },
  );
  let threw = false;
  try {
    identityScope({ role: "authenticated", claims: {}, source: "jwt" });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("backend({ supabase }): installs the keys, serves the JWKS, dev keys persist", async () => {
  const root = await Deno.makeTempDir({ prefix: "dnx-supabase-" });
  const g = await generateSupabaseKeys();
  try {
    resetPlugins();
    await applyPlugins({
      projectRoot: root,
      appDir: `${root}/app`,
      config: {
        plugins: [
          backend({ supabase: { publishableKey: g.publishableKey, signingKeys: g.signingKey } }),
        ],
      } as DenextConfig,
      mode: "prod",
      load,
    });
    assert(installedSupabaseKeys());
    const handler = getPluginRequestHandler()!;
    const jwks = await handler(new Request(`${ORIGIN}/auth/v1/.well-known/jwks.json`));
    assertEquals(jwks?.status, 200);
    const body = await jwks!.json();
    assertEquals(body.keys[0].kid, g.signingKey.kid);
    assertEquals(body.keys[0].d, undefined);
    const post = await handler(
      new Request(`${ORIGIN}/auth/v1/.well-known/jwks.json`, { method: "POST" }),
    );
    assertEquals(post?.status, 405);
    assertEquals(await handler(new Request(`${ORIGIN}/elsewhere`)), null);
    assert(getPluginCommands().some((c) => c.name === "backend"));

    // `denext dev` with nothing configured: a key set is generated once and reused.
    resetPlugins();
    installSupabaseKeys(undefined);
    const devConfig = { plugins: [backend({ supabase: true })] } as DenextConfig;
    const log = console.log;
    console.log = () => {};
    try {
      await applyPlugins({
        projectRoot: root,
        appDir: `${root}/app`,
        config: devConfig,
        mode: "dev",
        load,
      });
      const first = await Deno.readTextFile(join(root, DEV_KEYS_FILE));
      resetPlugins();
      await applyPlugins({
        projectRoot: root,
        appDir: `${root}/app`,
        config: devConfig,
        mode: "dev",
        load,
      });
      assertEquals(await Deno.readTextFile(join(root, DEV_KEYS_FILE)), first);
      assertStringIncludes(first, "sb_publishable_");
    } finally {
      console.log = log;
    }
    // Production with nothing configured warns, and refuses every key.
    resetPlugins();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (line: string) => warnings.push(line);
    try {
      await applyPlugins({
        projectRoot: `${root}/empty`,
        appDir: `${root}/app`,
        config: devConfig,
        mode: "prod",
        load,
      });
    } finally {
      console.warn = warn;
    }
    assertStringIncludes(warnings.join("\n"), "denext backend keys");
    await assertRejects(
      () => inRequest({ apikey: "sb_publishable_x" }, () => resolveIdentity()),
      IdentityError,
    );
  } finally {
    resetPlugins();
    installSupabaseKeys(undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("denext backend keys prints env lines, JSON, and the legacy keys", async () => {
  const lines: string[] = [];
  const command = createBackendCommand({ log: (line) => lines.push(line) });
  const ctx = (flags: Record<string, boolean>, positionals = ["keys"]) =>
    ({ positionals, flags, global: {}, rest: [] }) as unknown as Parameters<typeof command.run>[0];
  await command.run(ctx({}));
  assertEquals(lines.length, 3);
  assert(lines[0].startsWith("DENEXT_PUBLISHABLE_KEY=sb_publishable_"));
  assert(lines[2].startsWith("DENEXT_JWT_SIGNING_KEYS='[{"));
  lines.length = 0;
  await command.run(ctx({ legacy: true }));
  assertEquals(lines.length, 6);
  assert(lines[3].startsWith("DENEXT_JWT_SECRET="));
  lines.length = 0;
  await command.run(ctx({ json: true }));
  assert(JSON.parse(lines.join("\n")).signingKey.d);
  await assertRejects(async () => await command.run(ctx({}, ["nope"])), Error, "unknown action");
});

Deno.test("denext backend token: a signed access token for a role, never the key", async () => {
  const lines: string[] = [];
  const command = createBackendCommand({ log: (line) => lines.push(line) });
  const ctx = (flags: Record<string, string | number | boolean>) =>
    ({ positionals: ["token"], flags, global: {}, rest: [] }) as unknown as Parameters<
      typeof command.run
    >[0];
  const previous = installedSupabaseKeys();
  try {
    installSupabaseKeys(undefined);
    await assertRejects(async () => await command.run(ctx({})), Error, "no Supabase keys");
    const generated = await generateSupabaseKeys({ legacy: false });
    const keys = await resolveSupabaseKeys({
      publishableKey: generated.publishableKey,
      secretKey: generated.secretKey,
      signingKeys: [generated.signingKey],
    });
    installSupabaseKeys(keys);
    await command.run(ctx({ sub: USER, email: "a@b.test", claims: '{"team":"x"}' }));
    assertEquals(lines.length, 1);
    assert(!lines[0].includes(generated.signingKey.d!), "the key is never printed");
    const claims = await verifySupabaseJwt(keys, lines[0]);
    assertEquals([claims.role, claims.sub, claims.email, claims.aud], [
      "authenticated",
      USER,
      "a@b.test",
      "authenticated",
    ]);
    assertEquals((claims as Record<string, unknown>).team, "x");
    await command.run(ctx({ role: "service_role", exp: 60 }));
    const service = await verifySupabaseJwt(keys, lines[1]);
    assertEquals(service.role, "service_role");
    assertEquals(service.exp! - service.iat!, 60);
  } finally {
    installSupabaseKeys(previous);
  }
  assertEquals(tokenClaims({ role: "anon" }, 100).exp, 3700);
  for (
    const [flags, message] of [
      [{ role: "root" }, "--role"],
      [{}, "--sub"],
      [{ role: "anon", exp: -1 }, "--exp"],
      [{ role: "anon", claims: "[1]" }, "JSON object"],
    ] as const
  ) {
    try {
      tokenClaims(flags as Record<string, string | number>);
      throw new Error("expected a refusal");
    } catch (error) {
      assertStringIncludes((error as Error).message, message);
    }
  }
});
