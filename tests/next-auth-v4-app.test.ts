// A Next.js app written for NextAuth.js v4 (`next-auth@4`), migrated by `denext migrate` and run
// unchanged on denext's dev server: `pages/api/auth/[...nextauth].ts` (`export default NextAuth(authOptions)`, served by
// @denext/pages-router), `getServerSession(req, res, authOptions)` in `getServerSideProps` and an
// API route, `getSession(ctx)` / `getCsrfToken(ctx)` from `next-auth/react` on the server,
// `getServerSession(authOptions)` in an App Router Server Component and route handler, and
// `export { default } from "next-auth/middleware"` with a `config.matcher`. It signs in with
// Credentials through the built-in page's form (no JavaScript) and with an OAuth provider against
// a mock identity provider served over HTTP. The app runs in a child process, under its migrated
// import map, on `denext dev`'s server, driven over real HTTP.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { migrateProject } from "../packages/migrate/src/migrate.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("./fixtures/next-auth-v4-app", import.meta.url));
const MARK = "\u0000next-auth-v4-app:";

/** The child: a mock IdP, the app's handler, the flows, and a report of what it saw. */
function childScript(appDir: string): string {
  const src = (rel: string) => toFileUrl(join(REPO, rel)).href;
  return `
import { createTestClient } from "${src("src/testing/mod.ts")}";
import { startDevServer } from "${src("src/build/dev-server.ts")}";
import { resolveProject } from "${src("src/build/paths.ts")}";
import { activeNextAuth } from "${src("src/compat/next-auth/state.ts")}";

const out = {};
const idpSeen = {};
const idp = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await req.text());
    idpSeen.token = {
      code: form.get("code"),
      verifier: !!form.get("code_verifier"),
      redirect: form.get("redirect_uri"),
    };
    return Response.json({ access_token: "at-1", token_type: "bearer", expires_in: 3600 });
  }
  if (url.pathname === "/userinfo") {
    idpSeen.bearer = req.headers.get("authorization");
    return Response.json({ id: 42, name: "Grace", email: "grace@example.com" });
  }
  return new Response("not found", { status: 404 });
});
Deno.env.set("MOCK_IDP_URL", "http://127.0.0.1:" + idp.addr.port);

// The real dev server (plugins included: @denext/pages-router serves pages/), on a loopback port.
const controller = new AbortController();
const listening = Promise.withResolvers();
const server = startDevServer({
  paths: await resolveProject(${JSON.stringify(appDir)}),
  port: 0,
  hostname: "127.0.0.1",
  signal: controller.signal,
  onListen: (info) => listening.resolve(info),
});
const origin = "http://127.0.0.1:" + (await listening.promise).port;
Deno.env.set("NEXTAUTH_URL", origin);
out.origin = origin;
const client = createTestClient(
  (req) => fetch(new Request(req, { redirect: "manual" })),
  { origin },
);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ");
const brief = (res) => ({ status: res.status, location: res.location });

out.anonymous = text((await client.get("/")).text);
out.gated = brief(await client.get("/dashboard?tab=1"));
out.accountAnon = brief(await client.get("/account"));
out.meAnon = { status: (await client.get("/api/me")).status };

// Credentials, through the built-in sign-in page's form (served by the Pages API route).
const page = await client.get("/api/auth/signin?callbackUrl=%2Fdashboard");
out.signinPage = page.status;
const credentialsForm = () => client.form(page.text, { action: /callback.credentials$/ });
out.wrong = brief(await client.submit(credentialsForm(), { username: "ada", password: "nope" }));
out.right = brief(
  await client.submit(credentialsForm(), { username: "ada", password: "correct horse" }),
);
out.home = text((await client.get("/")).text);
out.whoami = (await client.get("/api/whoami")).json();
out.me = (await client.get("/api/me")).json();
out.account = text((await client.get("/account")).text);
out.legacy = text((await client.get("/legacy")).text);
out.dashboard = { status: (await client.get("/dashboard")).status };
out.session = (await client.get("/api/auth/session")).json();

// Sign out: refused without the CSRF token, then done through the sign-out page's form.
out.signoutNoToken = (await client.post("/api/auth/signout", { form: {} })).status;
const signout = await client.get("/api/auth/signout");
const left = await client.submit(client.form(signout.text, { action: /signout$/ }));
out.signedOut = { status: left.status, me: (await client.get("/api/me")).status };

// The OAuth provider against the mock IdP (the app is unchanged; only its endpoints are local).
activeNextAuth().denext.dangerouslyAllowInsecureProviders = true;
const start = await client.submit(
  client.form((await client.get("/api/auth/signin")).text, { action: /signin.mock$/ }),
);
const authorize = new URL(start.location ?? "");
out.authorize = {
  status: start.status,
  host: authorize.host === "127.0.0.1:" + idp.addr.port,
  pkce: authorize.searchParams.get("code_challenge_method"),
  hasState: !!authorize.searchParams.get("state"),
  redirect: authorize.searchParams.get("redirect_uri"),
};
const back = await client.get(
  "/api/auth/callback/mock?code=c-1&state=" + authorize.searchParams.get("state"),
);
out.callback = brief(back);
out.idp = idpSeen;
out.oauthMe = (await client.get("/api/me")).json();
out.oauthHome = text((await client.get("/")).text);
await idp.shutdown();
controller.abort();
await server.finished;

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
  delete env.AUTH_SECRET;
  delete env.AUTH_URL;
  const res = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--node-modules-dir=none", "--config", join(appDir, "deno.json"), main],
    cwd: appDir,
    clearEnv: true,
    env: {
      ...env,
      // NextAuth.js v4's variable names.
      // (NEXTAUTH_URL is set once the dev server has its port.)
      NEXTAUTH_SECRET: "next-auth-v4-app-test-secret-at-least-32-chars",
      MOCK_CLIENT_ID: "mock-client",
      MOCK_CLIENT_SECRET: "mock-secret",
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

/** The source files `denext migrate` must leave byte-identical. */
const SOURCES = [
  "lib/auth.ts",
  "middleware.ts",
  "pages/api/auth/[...nextauth].ts",
  "pages/api/me.ts",
  "pages/account.tsx",
  "pages/legacy.tsx",
  "app/page.tsx",
  "app/api/whoami/route.ts",
];

Deno.test({
  name: "next-auth v4 app: a Next.js app on NextAuth.js v4 migrates and runs unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-next-auth-v4-app-" });
    try {
      await copy(FIXTURE, dir, { overwrite: true });
      const migrated = await migrateProject(dir, { denextLocalPath: REPO });
      assertEquals(migrated.nextAuth?.version, "v4");
      assertEquals(migrated.nextAuth?.v4Apis, [
        "pages/api/auth/[...nextauth].ts",
        "next-auth/next",
        "getServerSession",
        "next-auth/middleware",
      ]);
      const imports = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).imports;
      for (
        const [spec, file] of [
          ["next-auth", "index.ts"],
          ["next-auth/next", "next.ts"],
          ["next-auth/middleware", "middleware.ts"],
          ["next-auth/react", "react.ts"],
        ]
      ) {
        assert(String(imports[spec]).endsWith(`/src/compat/next-auth/${file}`), spec);
      }
      for (const file of SOURCES) {
        assertEquals(
          await Deno.readTextFile(join(dir, file)),
          await Deno.readTextFile(join(FIXTURE, file)),
          `${file} unchanged`,
        );
      }

      const out = await runApp(dir);
      const origin = String(out.origin);
      assert(String(out.anonymous).includes("signed in as anonymous"));
      assertEquals(out.gated, {
        status: 307,
        location: `${origin}/api/auth/signin?callbackUrl=%2Fdashboard%3Ftab%3D1`,
      }, "next-auth/middleware's default export gates the matcher");
      assertEquals((out.accountAnon as { status: number }).status, 307, "gSSP redirect");
      assertEquals(out.meAnon, { status: 401 });
      assertEquals(out.signinPage, 200);
      assertEquals((out.wrong as { status: number }).status, 302);
      assert(String((out.wrong as { location: string }).location).includes("CredentialsSignin"));
      assertEquals(out.right, { status: 302, location: "/dashboard" });
      assert(String(out.home).includes("signed in as ada@example.com"), "Server Component");
      assert(String(out.home).includes("role admin"), "jwt + session callbacks");
      assertEquals(out.whoami, { email: "ada@example.com" }, "App Router route handler");
      assertEquals(out.me, { email: "ada@example.com", provider: "credentials" }, "API route");
      assert(String(out.account).includes("account of ada@example.com"), "getServerSideProps");
      assert(String(out.legacy).includes("legacy Ada csrf true"), `getSession(ctx): ${out.legacy}`);
      assertEquals(out.dashboard, { status: 200 }, "the middleware lets a session through");
      const session = out.session as { user: Record<string, unknown>; role: string };
      assertEquals(session.user.email, "ada@example.com");
      assertEquals(session.role, "admin");
      assertEquals(out.signoutNoToken, 403, "sign-out needs the CSRF token");
      assertEquals(out.signedOut, { status: 302, me: 401 });

      assertEquals(out.authorize, {
        status: 302,
        host: true,
        pkce: "S256",
        hasState: true,
        redirect: `${origin}/api/auth/callback/mock`,
      });
      assertEquals((out.callback as { status: number }).status, 303);
      assertEquals(out.idp, {
        token: {
          code: "c-1",
          verifier: true,
          redirect: `${origin}/api/auth/callback/mock`,
        },
        bearer: "Bearer at-1",
      });
      assertEquals(out.oauthMe, { email: "grace@example.com", provider: "mock" });
      assert(String(out.oauthHome).includes("role reader"), "the provider's profile() result");
    } finally {
      removeTempDirSync(dir);
    }
  },
});
