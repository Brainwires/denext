// examples/auth end-to-end through the JavaScript-DISABLED path: the denextAuth
// plugin's /auth/* endpoints (mounted the way the servers mount plugin handlers), the
// requireAuth middleware gate, scrypt-hashed registration + login through the sqlite
// AUTH ADAPTER, roles gating /admin, bearer API tokens, the login rate limit, and
// revocation via the adapter's session store ("sign out everywhere").

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createTestApp, createTestClient, type TestClient, type TestHandler } from "denext/testing";
import type { DenextPlugin, PluginContext, PluginRequestHandler } from "../src/plugin/mod.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

// A throwaway database file + a fixed secret — set before the app loads any module. It is a
// real file, not ":memory:", because the admin page opens a second read handle onto it.
const TMP = Deno.makeTempDirSync({ prefix: "denext-auth-example-" });
Deno.env.set("AUTH_DB", `${TMP}/auth.db`);
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
  // The account went into the ADAPTER: a user record, its scrypt credential, and the
  // `credentials` account row registration linked to it.
  const { adapter, findUser } = await import(`${APP}/lib/users.ts`);
  const ada = await findUser("ada@denext.dev");
  assert(ada, "the adapter holds the registered user");
  assertStringIncludes(await adapter.getCredential(ada.id), "scrypt$N=");
  const accounts = await adapter.listAccounts(ada.id);
  assertEquals(accounts.map((a: { provider: string }) => a.provider), ["credentials"]);
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

async function sessionIsTheAdapterIdentity({ client }: Ctx) {
  const { findUser } = await import(`${APP}/lib/users.ts`);
  const ada = await findUser("ada@denext.dev");
  assertEquals(
    ada.roles,
    ["user"],
    "the seeded demo account registered first, so Ada is not admin",
  );

  const res = await client.get("/auth/session");
  assertEquals(res.status, 200);
  const body = res.json() as { user?: { id: string; roles?: string[] } };
  assertEquals(body.user?.id, ada.id, "session.user.id IS the adapter id");
  assertEquals(body.user?.roles, ["user"], "roles travel in the session");
  // Sliding expiry is configured with `updateAge: 3600` and this session is seconds old,
  // so the canonical refresh path re-issues nothing.
  assertEquals(res.headers.get("set-cookie"), null, "a fresh session is not slid forward");
}

async function adminPageIsRoleGated({ handler, client }: Ctx) {
  const refused = await client.get("/admin");
  assertEquals(refused.status, 302, "a signed-in non-admin is refused");
  assertStringIncludes(refused.location ?? "", "/login?error=forbidden");
  assertStringIncludes(refused.location ?? "", "callbackUrl=%2Fadmin");

  const admin = createTestClient(handler);
  assertEquals((await postCredentials(admin, "demo@denext.dev", "password")).status, 200);
  const page = await admin.get("/admin");
  assertEquals(page.status, 200);
  assertStringIncludes(page.text, "demo@denext.dev");
  assertStringIncludes(page.text, "ada@denext.dev");
  assertStringIncludes(page.text, ">admin<");
}

/** The `tok_…` plaintext rendered on the page, or "" when none is shown. */
function renderedToken(html: string): string {
  return /tok_[A-Za-z0-9_-]+/.exec(html)?.[0] ?? "";
}

/** A GET carrying an `Authorization: Bearer` header (the API-token path, no cookie needed). */
const withBearer = (client: TestClient, token: string) =>
  client.request("/api/me", { headers: { authorization: `Bearer ${token}` } });

/** Sign in, mint a token through the page's form, and return the plaintext shown once. */
async function mintToken(client: TestClient): Promise<string> {
  assertEquals((await postCredentials(client, "demo@denext.dev", "password")).status, 200);
  const page = await client.get("/account/tokens");
  assertEquals(page.status, 200);
  const created = await client.submit(client.form(page.text, { has: "label" }), { label: "ci" });
  assertEquals(created.status, 303);
  const shown = await client.get(created.location ?? "");
  const token = renderedToken(shown.text);
  assert(
    token.startsWith("tok_"),
    `the plaintext is rendered once; got ${shown.text.slice(0, 200)}`,
  );
  const again = await client.get("/account/tokens?created=1");
  assertEquals(renderedToken(again.text), "", "and never a second time");
  return token;
}

async function apiTokensAuthenticateAndRevoke({ handler }: Ctx) {
  const owner = createTestClient(handler);
  const token = await mintToken(owner);

  const me = await withBearer(owner, token);
  assertEquals(me.status, 200);
  const profile = me.json() as { email: string; roles: string[] };
  assertEquals(profile.email, "demo@denext.dev");
  assertEquals(profile.roles, ["admin", "user"]);
  assertEquals((await withBearer(owner, "tok_not-a-real-token")).status, 401);

  const list = await owner.get("/account/tokens");
  const revoked = await owner.submit(owner.form(list.text, { has: "tokenId" }));
  assertEquals(revoked.status, 303);
  assertStringIncludes(revoked.location ?? "", "revoked=1");
  assertEquals((await withBearer(owner, token)).status, 401, "a revoked token is dead at once");
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
  [
    "the adapter is the identity: session.user.id is its id, with roles, and no idle refresh",
    sessionIsTheAdapterIdentity,
  ],
  [
    "/admin is role-gated: a plain user gets ?error=forbidden, the admin sees the list",
    adminPageIsRoleGated,
  ],
  [
    "API tokens: created once, authenticate `Authorization: Bearer`, dead when revoked",
    apiTokensAuthenticateAndRevoke,
  ],
];

Deno.test("examples/auth: the full app works with JavaScript disabled", async (t) => {
  const handler = await appWithAuth();
  const ctx: Ctx = { handler, client: createTestClient(handler) };
  try {
    for (const [name, fn] of STEPS) await t.step(name, () => fn(ctx));
  } finally {
    Deno.removeSync(TMP, { recursive: true });
  }
});
