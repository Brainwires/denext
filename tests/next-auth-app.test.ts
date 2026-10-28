// A Next.js App Router app written for Auth.js v5 (`next-auth@5`), run on denext unchanged:
// `denext migrate` writes its deno.json (the `next-auth` aliases), and the app — its `auth.ts`,
// its `[...nextauth]` route, a Server Component, two route handlers and `middleware.ts` — serves
// through denext's test harness. It signs in with Credentials (the built-in sign-in page's form,
// no JavaScript) and with a custom OAuth provider whose endpoints a stubbed fetch answers, and
// reads the session in all three places. The app runs in a child process, under its own
// import map, as `denext dev` would run it.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("./fixtures/next-auth-app", import.meta.url));
const MARK = "\u0000next-auth-app:";

/** The child: build the app's handler, walk the flows, report what it saw. */
function childScript(appDir: string): string {
  const src = (rel: string) => toFileUrl(join(REPO, rel)).href;
  return `
import { createTestApp, createTestClient } from "${src("src/testing/mod.ts")}";
import { activeNextAuth } from "${src("packages/auth/next-auth/state.ts")}";

const out = {};
const app = await createTestApp(${JSON.stringify(appDir)});
const client = createTestClient(app, { origin: "https://app.test" });
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ");

out.anonymous = text((await client.get("/")).text);
const gated = await client.get("/dashboard");
out.gated = { status: gated.status, location: gated.location };

// Credentials, through the built-in sign-in page's form (the no-JavaScript path).
const page = await client.get("/api/auth/signin?callbackUrl=%2Fdashboard");
out.signinPage = page.status;
const wrong = await client.submit(
  client.form(page.text, { action: /callback.credentials$/ }),
  { email: "ada@example.com", password: "nope" },
);
out.wrong = { status: wrong.status, location: wrong.location };
const right = await client.submit(
  client.form(page.text, { action: /callback.credentials$/ }),
  { email: "ada@example.com", password: "correct horse" },
);
out.right = { status: right.status, location: right.location };
out.home = text((await client.get("/")).text);
out.me = (await client.get("/api/me")).json();
out.wrapped = (await client.get("/api/wrapped")).json();
out.dashboard = { status: (await client.get("/dashboard")).status };
out.session = (await client.get("/api/auth/session")).json();

// Sign out: refused without the CSRF token, then done through the sign-out page's form.
out.signoutNoToken = (await client.post("/api/auth/signout", { form: {} })).status;
const signout = await client.get("/api/auth/signout");
const left = await client.submit(client.form(signout.text, { action: /signout$/ }));
out.signedOut = { status: left.status, me: (await client.get("/api/me")).json() };

// The custom OAuth provider: its endpoints answered by a stub (the app is unchanged).
const active = activeNextAuth();
active.denext.dangerouslyAllowInsecureProviders = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://idp.mock.test/token")) {
    return Response.json({ access_token: "at-1", token_type: "bearer", expires_in: 3600 });
  }
  if (url.startsWith("https://idp.mock.test/userinfo")) {
    return Response.json({ id: 42, name: "Grace", email: "grace@example.com" });
  }
  return realFetch(input, init);
};
const start = await client.submit(
  client.form((await client.get("/api/auth/signin")).text, { action: /signin.mock$/ }),
);
const authorize = new URL(start.location ?? "");
out.authorize = {
  status: start.status,
  host: authorize.host,
  pkce: authorize.searchParams.get("code_challenge_method"),
  hasState: !!authorize.searchParams.get("state"),
};
const back = await client.get(
  "/api/auth/callback/mock?code=c-1&state=" + authorize.searchParams.get("state"),
);
out.callback = { status: back.status, location: back.location };
out.oauthMe = (await client.get("/api/me")).json();
out.oauthHome = text((await client.get("/")).text);
const replay = await client.get(
  "/api/auth/callback/mock?code=c-2&state=" + authorize.searchParams.get("state"),
);
out.replay = { status: replay.status, location: replay.location };
globalThis.fetch = realFetch;

console.log(${JSON.stringify(MARK)} + JSON.stringify(out));
`;
}

/** Run the child under the migrated app's own config. */
async function runApp(appDir: string): Promise<Record<string, unknown>> {
  const main = join(appDir, ".denext-test-main.ts");
  await Deno.writeTextFile(main, childScript(appDir));
  const env = Deno.env.toObject();
  delete env.NODE_ENV;
  delete env.DENEXT_ENV;
  const res = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--node-modules-dir=none", "--config", join(appDir, "deno.json"), main],
    cwd: appDir,
    clearEnv: true,
    env: {
      ...env,
      AUTH_SECRET: "next-auth-app-test-secret-at-least-32-chars",
      AUTH_URL: "https://app.test/api/auth",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(res.stdout);
  const line = stdout.split("\n").find((l) => l.startsWith(MARK));
  if (!res.success || !line) {
    throw new Error(
      `app run failed (${res.code}):\n${stdout}\n${new TextDecoder().decode(res.stderr)}`,
    );
  }
  return JSON.parse(line.slice(MARK.length));
}

Deno.test({
  name: "next-auth app: a Next.js app on Auth.js v5 runs unchanged on denext",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-next-auth-app-" });
    try {
      await copy(FIXTURE, dir, { overwrite: true });
      await migrateProject(dir, { denextLocalPath: REPO });
      const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
      assert(String(imports["next-auth"]).endsWith("/packages/auth/next-auth/index.ts"));
      assert(String(imports["next-auth/react"]).endsWith("/packages/auth/next-auth/react.ts"));
      const original = await Deno.readTextFile(join(FIXTURE, "auth.ts"));
      assertEquals(await Deno.readTextFile(join(dir, "auth.ts")), original, "source unchanged");

      const out = await runApp(dir);
      assert(String(out.anonymous).includes("signed in as anonymous"));
      assertEquals((out.gated as { status: number }).status, 307, "middleware gates /dashboard");
      assert(
        String((out.gated as { location: string }).location).includes(
          "/api/auth/signin?callbackUrl=%2Fdashboard",
        ),
      );
      assertEquals(out.signinPage, 200);
      assertEquals((out.wrong as { status: number }).status, 302);
      assert(
        String((out.wrong as { location: string }).location).includes("error=CredentialsSignin"),
      );
      assertEquals(out.right, { status: 302, location: "/dashboard" });
      assert(String(out.home).includes("signed in as ada@example.com"), "Server Component");
      assert(String(out.home).includes("role admin"), "jwt + session callbacks");
      assertEquals(out.me, { email: "ada@example.com", provider: "credentials" }, "route handler");
      assertEquals(out.wrapped, { email: "ada@example.com" }, "auth(handler)");
      assertEquals(out.dashboard, { status: 200 }, "middleware lets a session through");
      const session = out.session as { user: Record<string, unknown>; expires: string };
      assertEquals(session.user.email, "ada@example.com");
      assertEquals(session.user.role, "admin");
      assert(!Number.isNaN(Date.parse(session.expires)), "expires is an ISO date");
      assertEquals(out.signoutNoToken, 403, "sign-out needs the CSRF token");
      assertEquals(out.signedOut, { status: 302, me: { email: null, provider: null } });

      assertEquals(out.authorize, {
        status: 302,
        host: "idp.mock.test",
        pkce: "S256",
        hasState: true,
      });
      assertEquals((out.callback as { status: number }).status, 303);
      assertEquals(out.oauthMe, { email: "grace@example.com", provider: "mock" });
      assert(String(out.oauthHome).includes("role reader"), "the provider's profile() result");
      assert(
        String((out.replay as { location: string }).location).includes("error="),
        "a replayed state is refused",
      );
    } finally {
      removeTempDirSync(dir);
    }
  },
});
