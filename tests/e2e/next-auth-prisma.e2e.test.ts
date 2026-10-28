// Headless e2e: a Next.js app on Auth.js v5 with `@auth/prisma-adapter` and database sessions,
// migrated by `denext migrate` and run unchanged on real Prisma (the ESM/Deno client over Deno's
// built-in `node:sqlite`, which migrate wires). Its `prisma:setup` task installs the app's own
// dependencies (`@auth/prisma-adapter` among them), generates the client and creates the Auth.js
// tables; the app then serves on denext's dev server and is driven over HTTP: an OAuth sign-in
// against a mock identity provider creates the `User`, links the `Account` and writes a `Session`
// row; sign-out deletes it; a Resend magic link stores a `VerificationToken` row that its sign-in
// (through the confirmation page) spends; and signing in again with the provider reuses the
// linked account.
//
// Opt-in + NETWORK + CODEGEN (installs the app's npm dependencies and runs the prisma CLI):
// `deno task test:e2e`. Skipped automatically if setup can't complete (offline).

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { migrateProject } from "../../src/build/migrate.ts";
import { runDeno } from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const FIXTURE = fromFileUrl(new URL("../fixtures/next-auth-prisma-app", import.meta.url));
const MARK = "\u0000next-auth-prisma-app:";
const SETUP_TIMEOUT_MS = 600_000;
const ENV = {
  DATABASE_URL: "file:./data.db",
  AUTH_SECRET: "next-auth-prisma-app-test-secret-at-least-32",
  AUTH_MOCK_ID: "mock-client",
  AUTH_MOCK_SECRET: "mock-secret",
};

/** The child: a mock IdP, the app on the dev server, the flows, and the rows they left. */
function childScript(appDir: string): string {
  const src = (rel: string) => toFileUrl(join(REPO, rel)).href;
  return `
import { createTestClient } from "${src("src/testing/mod.ts")}";
import { startDevServer } from "${src("src/build/dev-server.ts")}";
import { resolveProject } from "${src("src/build/paths.ts")}";
import { activeNextAuth } from "${src("packages/auth/next-auth/state.ts")}";
import { DatabaseSync } from "node:sqlite";

const out = {};
const idp = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/token") {
    return Response.json({ access_token: "at-1", token_type: "bearer", expires_in: 3600 });
  }
  if (url.pathname === "/userinfo") {
    return Response.json({ id: 42, name: "Grace", email: "grace@example.com" });
  }
  return new Response("not found", { status: 404 });
});
Deno.env.set("MOCK_IDP_URL", "http://127.0.0.1:" + idp.addr.port);

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
Deno.env.set("AUTH_URL", origin + "/api/auth");
const client = createTestClient(
  (req) => fetch(new Request(req, { redirect: "manual" })),
  { origin },
);
const db = new DatabaseSync(${JSON.stringify(join(appDir, "prisma", "data.db"))});
const rows = () => Object.fromEntries(
  ["User", "Account", "Session", "VerificationToken"].map((t) =>
    [t, db.prepare('SELECT count(*) AS n FROM "' + t + '"').get().n]
  ),
);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ");
const me = async () => (await client.get("/api/me")).json();
const signOut = async () => {
  const page = await client.get("/api/auth/signout");
  return (await client.submit(client.form(page.text, { action: /signout$/ }))).status;
};
const oauth = async () => {
  const page = await client.get("/api/auth/signin");
  activeNextAuth().denext.dangerouslyAllowInsecureProviders = true;
  const start = await client.submit(client.form(page.text, { action: /signin.mock$/ }));
  const state = new URL(start.location).searchParams.get("state");
  return await client.get("/api/auth/callback/mock?code=c-1&state=" + state);
};

out.anonymous = text((await client.get("/")).text);
out.empty = rows();

const first = await oauth();
out.oauth = { status: first.status, me: await me(), rows: rows() };
out.home = text((await client.get("/")).text);
out.signOut = { status: await signOut(), me: await me(), rows: rows() };

// A Resend magic link, through the built-in page's form and the confirmation page.
const signin = await client.get("/api/auth/signin");
const sent = await client.submit(
  client.form(signin.text, { action: /signin.resend$/ }),
  { email: "ada@example.com" },
);
const link = new URL(globalThis.devMailbox.at(-1));
out.email = { sent: sent.status, rows: rows() };
const confirm = await client.get(link.pathname + link.search);
const done = await client.submit(client.form(confirm.text));
out.emailSignIn = { status: done.status, me: await me(), rows: rows() };
// A spent link: its confirmation page still renders, but confirming it fails.
await signOut();
const spent = await client.get(link.pathname + link.search);
const replay = await client.submit(client.form(spent.text));
out.replay = { status: replay.status, location: replay.location, me: await me() };

const again = await oauth();
out.again = { status: again.status, me: await me(), rows: rows() };

db.close();
controller.abort();
await server.finished;
await idp.shutdown();
console.log(${JSON.stringify(MARK)} + JSON.stringify(out));
`;
}

/** Run the child under the migrated app's config (its manual node_modules included). */
async function runApp(appDir: string): Promise<Record<string, unknown>> {
  const main = join(appDir, ".denext-test-main.ts");
  await Deno.writeTextFile(main, childScript(appDir));
  const env = Deno.env.toObject();
  delete env.NODE_ENV;
  delete env.DENEXT_ENV;
  const res = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(appDir, "deno.json"), main],
    cwd: appDir,
    clearEnv: true,
    env: { ...env, ...ENV },
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
  name: "e2e: an Auth.js v5 app on @auth/prisma-adapter with database sessions runs unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_nextauth_prisma_" }));
    try {
      await copy(FIXTURE, dir, { overwrite: true });
      const migrated = await migrateProject(dir, { denextLocalPath: REPO });
      assertEquals(migrated.nextAuth?.adapters, ["@auth/prisma-adapter"]);
      assertEquals(migrated.prisma?.clientModules, ["lib/prisma.ts"]);
      assertEquals(
        await Deno.readTextFile(join(dir, "auth.ts")),
        await Deno.readTextFile(join(FIXTURE, "auth.ts")),
        "auth.ts unchanged",
      );
      const setup = await runDeno(["task", "prisma:setup"], dir, SETUP_TIMEOUT_MS);
      if (!setup.ok) {
        console.warn("e2e: `prisma:setup` failed (offline?) — skipping.\n" + setup.out);
        return;
      }

      const out = await runApp(dir);
      assert(String(out.anonymous).includes("signed in as anonymous"));
      assertEquals(out.empty, { User: 0, Account: 0, Session: 0, VerificationToken: 0 });
      const oauth = out.oauth as { status: number; me: { email: string; userId: string } };
      assertEquals(oauth.status, 303);
      assertEquals(oauth.me.email, "grace@example.com");
      assert(oauth.me.userId, "callbacks.session gets the adapter's user");
      assertEquals((out.oauth as { rows: unknown }).rows, {
        User: 1,
        Account: 1,
        Session: 1,
        VerificationToken: 0,
      });
      assert(String(out.home).includes("signed in as grace@example.com"), "auth() in a page");
      assertEquals(out.signOut, {
        status: 302,
        me: { email: null, userId: null },
        rows: { User: 1, Account: 1, Session: 0, VerificationToken: 0 },
      });
      assertEquals((out.email as { rows: unknown }).rows, {
        User: 1,
        Account: 1,
        Session: 0,
        VerificationToken: 1,
      });
      const email = out.emailSignIn as { me: { email: string }; rows: unknown };
      assertEquals(email.me.email, "ada@example.com");
      assertEquals(email.rows, { User: 2, Account: 1, Session: 1, VerificationToken: 0 });
      const replay = out.replay as { location: string; me: { email: string | null } };
      assert(replay.location.includes("error="), "a spent link can't sign in again");
      assertEquals(replay.me.email, null);
      const again = out.again as { me: { userId: string }; rows: unknown };
      assertEquals(again.me.userId, oauth.me.userId, "the linked account signs in its user");
      assertEquals(again.rows, { User: 2, Account: 1, Session: 1, VerificationToken: 0 });
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
