// Supabase's Custom Access Token Hook on a denext session: `resolveIdentity()` hands the cookie
// session's claims to `hooks.customAccessToken` (the auth config's, else the installed
// `/auth/v1` options'), keeps the fixed claims, caches the result per session, and fails the
// request when the hook throws or answers without claims.

import { assertEquals, assertRejects } from "@std/assert";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import type { GoTrueAccessTokenHookInput, GoTrueHooks } from "../src/server/auth/gotrue/options.ts";
import type { AuthConfig, AuthUser } from "../src/server/auth/types.ts";
import { resolveIdentity } from "../packages/backend/server.ts";
import { installSupabaseAuthHooks } from "../packages/backend/src/identity.ts";

const ORIGIN = "https://app.test";

function configWith(hooks?: GoTrueHooks): AuthConfig {
  const config: AuthConfig = {
    secret: "hook-secret-value-at-least-32-characters!",
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: () => null })],
    adapter: inMemoryAuthAdapter(),
    hooks,
  };
  denextAuth(config);
  return config;
}

async function cookieFor(config: AuthConfig, user: AuthUser): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(
    issuing,
    () => issueAuthSession(config, user, "credentials", { amr: ["otp"] }),
  );
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

function claimsWith(cookie: string): Promise<Record<string, unknown>> {
  const request = new Request(`${ORIGIN}/rest/v1/x`, { headers: { cookie } });
  return runWithContext(
    createRequestContext(request),
    async () => (await resolveIdentity(request)).claims,
  );
}

Deno.test("customAccessToken shapes a cookie session's claims; the fixed claims can't change; it is cached", async () => {
  const calls: GoTrueAccessTokenHookInput[] = [];
  const config = configWith({
    customAccessToken: (input) => {
      calls.push(input);
      return {
        claims: {
          ...input.claims,
          tier: "gold",
          sub: "someone-else",
          role: "service_role",
          aud: "elsewhere",
          aal: "aal2",
          is_anonymous: true,
          email: "attacker@x.test",
          session_id: "forged",
        },
      };
    },
  });
  const cookie = await cookieFor(config, { id: "hook-user-1", email: "u1@x.test" });
  const claims = await claimsWith(cookie);
  assertEquals(claims.tier, "gold");
  assertEquals(
    [claims.sub, claims.role, claims.aud, claims.aal, claims.is_anonymous, claims.email],
    ["hook-user-1", "authenticated", "authenticated", "aal1", false, "u1@x.test"],
  );
  assertEquals("session_id" in claims, false, "a stateless session has none, and gets none");
  assertEquals(calls.length, 1);
  assertEquals([calls[0].user_id, calls[0].authentication_method], ["hook-user-1", "otp"]);
  assertEquals(calls[0].claims.sub, "hook-user-1");

  assertEquals((await claimsWith(cookie)).tier, "gold");
  assertEquals(calls.length, 1, "the second request reused the cached claims");
});

Deno.test("a throwing or malformed hook fails the request", async () => {
  const throwing = configWith({
    customAccessToken: () => {
      throw new Error("hook down");
    },
  });
  const a = await cookieFor(throwing, { id: "hook-user-2" });
  await assertRejects(() => claimsWith(a), Error, "hook down");

  const malformed = configWith({
    customAccessToken: () => ({ claims: null as unknown as Record<string, unknown> }),
  });
  const b = await cookieFor(malformed, { id: "hook-user-3" });
  await assertRejects(() => claimsWith(b), Error, "customAccessToken hook failed");
});

Deno.test("without a hook on the auth config, the installed /auth/v1 hook applies", async () => {
  const config = configWith();
  const cookie = await cookieFor(config, { id: "hook-user-4" });
  assertEquals((await claimsWith(cookie)).tier, undefined);
  installSupabaseAuthHooks({
    customAccessToken: ({ claims }) => ({ claims: { ...claims, tier: "installed" } }),
  });
  try {
    assertEquals((await claimsWith(cookie)).tier, "installed");
  } finally {
    installSupabaseAuthHooks(undefined);
  }
});
