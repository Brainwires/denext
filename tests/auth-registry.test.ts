// `auth()`, `requireAuth()` and `requireSession()` stay in denext/server as thin wrappers over a
// registry `denextAuth()` (@denext/auth) fills in (src/server/auth-registry.ts). Without the
// plugin they throw an error that names the package and the fix.

import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  auth,
  AuthPluginMissingError,
  type AuthRuntime,
  hasRole,
  peekAuthRuntime,
  registerAuthRuntime,
  requireAuth,
  resetAuthRuntimeForTesting,
  updatedSession,
} from "../src/server/auth-registry.ts";
import { requireSession } from "../src/server/api-middleware.ts";
import type { AuthSession } from "../src/server/auth-session.ts";
import { ApiError } from "../src/server/api-error.ts";
import { denextAuth } from "../packages/auth/mod.ts";
import { credentials } from "../packages/auth/mod.ts";

const SESSION: AuthSession = {
  user: { id: "u1", roles: ["admin"] },
  provider: "credentials",
  expiresAt: Date.now() + 60_000,
};

/** Run `fn` with nothing registered, restoring whatever was registered before. */
async function withoutRuntime(fn: () => Promise<void>): Promise<void> {
  const before = peekAuthRuntime();
  resetAuthRuntimeForTesting();
  try {
    await fn();
  } finally {
    if (before) registerAuthRuntime(before);
  }
}

Deno.test("auth registry: without the plugin auth(), requireAuth() and requireSession() name @denext/auth", async () => {
  await withoutRuntime(async () => {
    for (
      const [caller, call] of [
        ["auth()", () => auth()],
        ["requireAuth()", () => requireAuth(new Request("http://x/"))],
        ["requireSession()", () => updatedSession()],
      ] as const
    ) {
      const err = await assertRejects(call as () => Promise<unknown>, AuthPluginMissingError);
      assert(err.message.startsWith(`${caller}: no auth plugin is registered`), err.message);
      assert(err.message.includes("@denext/auth"), err.message);
      assert(err.message.includes("denextAuth("), err.message);
    }
    const guard = requireSession();
    await assertRejects(() => Promise.resolve(guard({} as never)), Error, "@denext/auth");
  });
});

Deno.test("auth registry: the wrappers call through the registered runtime", async () => {
  await withoutRuntime(async () => {
    const calls: string[] = [];
    const runtime: AuthRuntime = {
      auth: () => (calls.push("auth"), Promise.resolve(SESSION)),
      requireAuth: (_req, opts) => (calls.push(`requireAuth:${opts.role}`), Promise.resolve(null)),
      updateAuthSession: () => (calls.push("update"), Promise.resolve(SESSION)),
    };
    registerAuthRuntime(runtime);
    assertStrictEquals(peekAuthRuntime(), runtime);
    assertStrictEquals(await auth(), SESSION);
    assertEquals(await requireAuth(new Request("http://x/"), { role: "admin" }), null);
    const ctx = await requireSession({ role: "admin" })({} as never);
    assertStrictEquals((ctx as { session: AuthSession }).session, SESSION);
    await assertRejects(
      () => Promise.resolve(requireSession({ role: "owner" })({} as never)),
      ApiError,
    );
    assertEquals(calls, ["auth", "requireAuth:admin", "update", "update"]);
  });
});

Deno.test("auth registry: denextAuth() registers its runtime when it is created", async () => {
  await withoutRuntime(() => {
    assertEquals(peekAuthRuntime(), undefined);
    denextAuth({
      secret: "a-test-secret-that-is-long-enough-1234567890",
      providers: [credentials({ authorize: () => null })],
    });
    const runtime = peekAuthRuntime();
    assert(runtime, "denextAuth() filled the registry");
    assertEquals(typeof runtime.auth, "function");
    return Promise.resolve();
  });
});

Deno.test("hasRole: any-of, an empty list refuses, no requirement allows", () => {
  assert(hasRole(SESSION, undefined));
  assert(hasRole(SESSION, "admin"));
  assert(hasRole(SESSION, ["owner", "admin"]));
  assertEquals(hasRole(SESSION, []), false);
  assertEquals(hasRole({ ...SESSION, user: { id: "u2" } }, "admin"), false);
});
