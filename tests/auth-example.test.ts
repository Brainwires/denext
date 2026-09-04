// examples/auth end-to-end through the JavaScript-DISABLED path: the denextAuth
// plugin's /auth/* endpoints (mounted the way the servers mount plugin handlers), the
// requireAuth middleware gate, scrypt-hashed registration + login, the login rate
// limit, and revocation via the sqlite session store ("sign out everywhere").

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createTestApp, createTestClient, type TestClient, type TestHandler } from "denext/testing";
import type { DenextPlugin, PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

// An ephemeral database + a fixed secret — set before the app loads any module.
Deno.env.set("AUTH_DB", ":memory:");
Deno.env.set("AUTH_SECRET", "auth-example-test-secret-at-least-32-chars");

const APP = new URL("../examples/auth", import.meta.url).pathname;

/**
 * The example's `denext.config.ts` plugin, set up the way `applyPlugins` does it, and
 * composed with the test app: `/auth/*` goes to the plugin (inside a request context,
 * with its Set-Cookie headers merged like the pipeline's `finalize`), everything else
 * to the app (pages, Server Actions, middleware).
 */
async function appWithAuth(): Promise<TestHandler> {
  const config = (await import(`${APP}/denext.config.ts`)).default as {
    plugins: DenextPlugin[];
  };
  const handlers: PluginRequestHandler[] = [];
  const ctx = {
    addRequestHandler: (h: PluginRequestHandler) => void handlers.push(h),
    addTeardown: () => {},
  } as unknown as PluginContext;
  for (const plugin of config.plugins) await plugin.setup(ctx);
  const app = await createTestApp(APP);
  return async (request: Request): Promise<Response> => {
    if (!new URL(request.url).pathname.startsWith("/auth/")) {
      return app(request);
    }
    const rc = createRequestContext(request);
    const res = await runWithContext(rc, () => handlers[0](request));
    const headers = new Headers(res!.headers);
    for (const c of rc.outgoingHeaders.getSetCookie()) {
      headers.append("set-cookie", c);
    }
    return new Response(res!.body, { status: res!.status, headers });
  };
}

const AUTH_COOKIE = "__Host-denext_auth";
type AuthJson = { error?: string; user?: { email: string } };
const login = (email: string, password: string) => ({
  json: { email, password },
  headers: { accept: "application/json" },
});
/** The JSON-client sign-in request against the credentials callback. */
const postCredentials = (client: TestClient, email: string, password: string) =>
  client.post("/auth/callback/credentials", login(email, password));

type Ctx = { handler: TestHandler; client: TestClient };

async function homeRendersAndDashboardIsGated({ client }: Ctx) {
  const home = await client.get("/");
  assertEquals(home.status, 200);
  assertStringIncludes(home.text, "First-party auth");
  const gated = await client.get("/dashboard");
  assertEquals(gated.status, 302);
  assertStringIncludes(
    gated.location ?? "",
    "/login?callbackUrl=%2Fdashboard",
  );
}

async function wrongPasswordIsGeneric401({ client }: Ctx) {
  const res = await postCredentials(client, "demo@denext.dev", "nope");
  assertEquals(res.status, 401);
  assertEquals((res.json() as AuthJson).error, "invalid credentials");
  assertEquals(client.cookies.get(AUTH_COOKIE), undefined);
}

async function registerThroughForm({ client }: Ctx) {
  const page = await client.get("/register");
  const res = await client.submit(client.form(page.text), {
    name: "Ada",
    email: "ada@denext.dev",
    password: "correct horse",
  });
  assertEquals(res.status, 303);
  assertStringIncludes(res.location ?? "", "/login?registered=1");
  const { findUserByEmail } = await import(`${APP}/lib/db.ts`);
  assertStringIncludes(
    findUserByEmail("ada@denext.dev")!.password_hash,
    "scrypt$N=",
  );
}

async function signInOpensDashboard({ client }: Ctx) {
  const res = await postCredentials(client, "ada@denext.dev", "correct horse");
  assertEquals(res.status, 200);
  assertEquals((res.json() as AuthJson).user?.email, "ada@denext.dev");
  assert(
    client.cookies.get(AUTH_COOKIE),
    "the __Host- session cookie is in the jar",
  );
  const dash = await client.get("/dashboard");
  assertEquals(dash.status, 200);
  assertStringIncludes(dash.text, "ada@denext.dev");
  assertStringIncludes(dash.text, "Session id:");
}

async function signOutEverywhereRevokes({ handler, client }: Ctx) {
  const other = createTestClient(handler); // a second device, same account
  await postCredentials(other, "ada@denext.dev", "correct horse");
  assertEquals((await other.get("/dashboard")).status, 200);

  const dash = await client.get("/dashboard");
  // Forms on the page: [0] /auth/signout, [1] signOutEverywhere, [2] changePassword.
  const res = await client.submit(client.form(dash.text, { index: 1 }));
  assertEquals(res.status, 303);
  assertStringIncludes(res.location ?? "", "/?everywhere=1");

  assert(
    other.cookies.get(AUTH_COOKIE),
    "the other device still holds its cookie…",
  );
  assertEquals(
    (await other.get("/dashboard")).status,
    302,
    "…but it is revoked",
  );
  assertEquals((await client.get("/dashboard")).status, 302);
}

async function changePasswordRehashesAndRevokes({ client }: Ctx) {
  await postCredentials(client, "ada@denext.dev", "correct horse");
  const dash = await client.get("/dashboard");
  assertEquals(dash.status, 200);
  const form = () => client.form(dash.text, { has: "current" });
  const wrong = await client.submit(form(), {
    current: "nope",
    next: "new password 1",
  });
  assertEquals(wrong.status, 303);
  assertStringIncludes(wrong.location ?? "", "/dashboard?error=current");
  const weak = await client.submit(form(), {
    current: "correct horse",
    next: "short",
  });
  assertStringIncludes(weak.location ?? "", "/dashboard?error=weak");

  const ok = await client.submit(form(), {
    current: "correct horse",
    next: "new password 1",
  });
  assertStringIncludes(ok.location ?? "", "/login?changed=1");
  assertEquals(
    (await client.get("/dashboard")).status,
    302,
    "the old session was revoked",
  );
  const old = await postCredentials(client, "ada@denext.dev", "correct horse");
  assertEquals(old.status, 401, "the old password no longer works");
  const fresh = await postCredentials(client, "ada@denext.dev", "new password 1");
  assertEquals(fresh.status, 200, "the new password does");
}

async function sixthFailedAttemptIs429({ handler }: Ctx) {
  // A fresh client + an identifier no earlier step failed on (the key is IP + email).
  const fresh = createTestClient(handler);
  for (let i = 0; i < 5; i++) {
    const res = await postCredentials(fresh, "mallory@denext.dev", "x");
    assertEquals(res.status, 401, `attempt ${i + 1}`);
  }
  const locked = await postCredentials(fresh, "mallory@denext.dev", "password");
  assertEquals(locked.status, 429);
  assertEquals((locked.json() as AuthJson).error, "too many attempts");
  assert(Number(locked.headers.get("retry-after")) > 0);
}

const STEPS: Array<[string, (ctx: Ctx) => Promise<void>]> = [
  ["home renders; /dashboard is gated by requireAuth", homeRendersAndDashboardIsGated],
  ["a wrong password is a generic 401 and sets no cookie", wrongPasswordIsGeneric401],
  ["register through the rendered form (password stored as scrypt)", registerThroughForm],
  ["sign in (JSON client) → session cookie → the dashboard opens", signInOpensDashboard],
  [
    "'sign out everywhere' revokes the session: the same cookie no longer authenticates",
    signOutEverywhereRevokes,
  ],
  [
    "change password: wrong current → error; success rehashes + signs out everywhere",
    changePasswordRehashesAndRevokes,
  ],
  ["brute force: the 6th failed attempt is a generic 429", sixthFailedAttemptIs429],
];

Deno.test("examples/auth: the full app works with JavaScript disabled", async (t) => {
  const handler = await appWithAuth();
  const ctx: Ctx = { handler, client: createTestClient(handler) };
  for (const [name, fn] of STEPS) await t.step(name, () => fn(ctx));
});
