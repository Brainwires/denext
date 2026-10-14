// `@denext/backend` + denext auth against a REAL Postgres: `backendAuthAdapter()` behind
// `denextAuth`, through the request pipeline — a password user registered the documented way
// (`createUser` + `setCredential`) signs in with `credentials()`, an unknown address signs up with
// a one-time code (`emailOtp()`), and a native app's bearer token is minted from the adapter's
// grant tables — and each identity then reaches the app's own tables as itself: `db()` under the
// session's `auth.uid()`, auto-REST reads and writes under row-level security, the bearer write
// cross-site with no cookie (the CSRF exemption is the bearer's).
//
// The app connects as a NON-superuser role in a database of its own (both dropped afterwards).
// Opt-in, on denext's Deno runtime (the built-in `Deno.SQL`), with a superuser URL:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/backend-auth-integration.test.ts
//
// Ignored without DENEXT_TEST_POSTGRES_URL or Deno.SQL; the adapter meets the AuthAdapter contract
// against a fake client in tests/backend-postgres.test.ts.

import { assert, assertEquals } from "@std/assert";
import { builtinSql } from "../src/server/postgres.ts";
import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { emailOtp } from "../src/server/auth/providers-email.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { resolveNative, startNativeSession } from "../src/server/auth/native.ts";
import type { AuthConfig, VerificationRequestParams } from "../src/server/auth/types.ts";
import { backend, backendAuthAdapter } from "../packages/backend/mod.ts";
import { db } from "../packages/backend/server.ts";
import { installPostgres, rlsReady } from "../packages/backend/src/postgres.ts";
import { postgresEnvironment as environment } from "./helpers/postgres-env.ts";

const URL_ = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;
const SQL = builtinSql();
const reason = !URL_
  ? "set DENEXT_TEST_POSTGRES_URL"
  : !SQL
  ? "needs denext's Deno runtime (Deno.SQL)"
  : undefined;
const label = reason ? ` (skipped: ${reason})` : "";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;
const ORIGIN = "https://app.test";
const SESSION_COOKIE = "__Host-denext_auth=";
const PASSWORD = "correct horse battery staple";

/** The app's table: each user reads and writes their own rows. */
const NOTES = `
  create table notes (id serial primary key, owner uuid not null, body text not null);
  alter table notes enable row level security;
  create policy "read own" on notes for select to authenticated using (owner = auth.uid());
  create policy "insert own" on notes for insert to authenticated with check (owner = auth.uid());
  grant select, insert on notes to authenticated;
  grant select on notes to anon;
  grant usage on sequence notes_id_seq to authenticated;
`;

/** Wait until `done()` (bounded), polling every 10 ms. */
async function until(done: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test({
  name:
    `backendAuthAdapter on a real Postgres: password, one-time-code sign-up and a native bearer act as themselves${label}`,
  ignore: reason !== undefined,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const env = await environment();
    const root = await Deno.makeTempDir({ prefix: "dnx-auth-pg-" });
    try {
      await Deno.mkdir(`${root}/app`);
      resetPlugins();
      installPostgres(undefined);
      const sent: VerificationRequestParams[] = [];
      const adapter = backendAuthAdapter();
      const authConfig: AuthConfig = {
        secret: "auth-pg-secret-at-least-32-characters!",
        canonicalOrigin: ORIGIN,
        providers: [credentials(), emailOtp()],
        adapter,
        native: { redirectUris: ["com.example.app://auth/callback"] },
        sendVerificationRequest: (params) => void sent.push(params),
        logger: { warn: () => {} },
      };
      const config = {
        plugins: [denextAuth(authConfig), backend({ postgres: { sql: env.app }, rest: {} })],
      } as DenextConfig;
      await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode: "build", load });
      await rlsReady();
      await db.service().unsafe(NOTES).simple!();
      const manifest = await scanRoutes(`${root}/app`);
      const handler = createApp({
        getManifest: () => manifest,
        load,
        matchExternal: getPluginRequestHandler(),
      });
      const call = (
        path: string,
        init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
      ) => {
        const headers = new Headers({ host: "app.test", ...init.headers });
        if (init.method && init.method !== "GET" && !headers.has("origin")) {
          headers.set("origin", ORIGIN);
        }
        if (init.body !== undefined) headers.set("content-type", "application/json");
        return handler(
          new Request(new URL(path, ORIGIN), {
            method: init.method ?? "GET",
            headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
          }),
        );
      };
      const cookieOf = (res: Response) =>
        res.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE))?.split(";")[0];
      /** `auth.uid()` as the request carrying `cookie` sees it through `db()`. */
      const uidIn = async (cookie: string) => {
        const request = new Request(`${ORIGIN}/`, { headers: { cookie } });
        const [row] = await runWithContext(
          createRequestContext(request),
          () => db()<{ uid: string | null }>`select auth.uid()::text as uid`,
        );
        return row.uid;
      };

      // 1. Registration as the docs write it, on the Postgres adapter; then a password sign-in.
      const ada = await adapter.createUser({ email: "ada@x.test", name: "Ada" });
      await adapter.setCredential!(ada.id, await hashPassword(PASSWORD));
      const [stored] = await db.service()<{ id: string }>`
        select id::text as id from auth_users where email = 'ada@x.test'`;
      assertEquals(stored?.id, ada.id, "the user row is in the backend's database");
      const wrong = await call("/auth/callback/credentials", {
        method: "POST",
        body: { email: "ada@x.test", password: "not it" },
        headers: { accept: "application/json" },
      });
      assertEquals(wrong.status, 401);
      await wrong.body?.cancel();
      const signedIn = await call("/auth/callback/credentials", {
        method: "POST",
        body: { email: "ADA@x.test ", password: PASSWORD },
        headers: { accept: "application/json" },
      });
      assertEquals([signedIn.status, (await signedIn.json()).ok], [200, true]);
      const adaCookie = cookieOf(signedIn);
      assert(adaCookie, "a session cookie was issued");
      assertEquals(await uidIn(adaCookie), ada.id, "db() acts as the signed-in user");

      // Her writes and reads go through auto-REST under her identity.
      const posted = await call("/rest/v1/notes", {
        method: "POST",
        body: { owner: ada.id, body: "ada's" },
        headers: { cookie: adaCookie },
      });
      assertEquals(posted.status, 201);
      await posted.body?.cancel();

      // 2. Sign-up by one-time code: an unknown address becomes a user in Postgres.
      const asked = await call("/auth/callback/email-otp", {
        method: "POST",
        body: { email: "grace@x.test" },
        headers: { accept: "application/json" },
      });
      assertEquals(asked.status, 200);
      await asked.body?.cancel();
      await until(() => sent.length === 1, "the code mail");
      assertEquals(
        await adapter.getUserByEmail("grace@x.test"),
        undefined,
        "no user before the code",
      );
      const redeemed = await call("/auth/callback/email-otp", {
        method: "POST",
        body: { email: "grace@x.test", code: sent[0].token },
        headers: { accept: "application/json" },
      });
      assertEquals([redeemed.status, (await redeemed.json()).ok], [200, true]);
      const grace = await adapter.getUserByEmail("grace@x.test");
      assert(grace?.emailVerified, "the new user is created verified");
      const graceCookie = cookieOf(redeemed)!;
      assertEquals(await uidIn(graceCookie), grace.id);
      const graceNotes = await call("/rest/v1/notes?select=body", {
        headers: { cookie: graceCookie },
      });
      assertEquals(await graceNotes.json(), [], "Grace cannot read Ada's rows");

      // 3. A native app's bearer token, from the adapter's grant tables: a cross-site write with
      // no cookie is exempt from CSRF and runs as that user; a forged token is signed out.
      const native = resolveNative(authConfig)!;
      const pair = await startNativeSession(authConfig, native, {
        user: { id: ada.id },
        provider: "credentials",
        amr: ["pwd"],
        authTime: Math.floor(Date.now() / 1000),
      });
      const bearer = { authorization: `Bearer ${pair.access_token}`, origin: "https://evil.test" };
      const viaBearer = await call("/rest/v1/notes", {
        method: "POST",
        body: { owner: ada.id, body: "from the phone" },
        headers: bearer,
      });
      assertEquals(viaBearer.status, 201, await viaBearer.clone().text());
      await viaBearer.body?.cancel();
      const read = await call("/rest/v1/notes?select=body&order=id", {
        headers: { authorization: `Bearer ${pair.access_token}` },
      });
      assertEquals(await read.json(), [{ body: "ada's" }, { body: "from the phone" }]);
      const forged = await call("/rest/v1/notes", {
        method: "POST",
        body: { owner: ada.id, body: "forged" },
        headers: { ...bearer, authorization: `${bearer.authorization.slice(0, -2)}xx` },
      });
      assertEquals([forged.status, (await forged.json()).code], [403, "42501"], "anon is refused");
      assertEquals(
        (await db.service()`select count(*)::int as n from notes`)[0].n,
        2,
        "nothing else landed",
      );
    } finally {
      resetPlugins();
      installPostgres(undefined);
      await env.drop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
