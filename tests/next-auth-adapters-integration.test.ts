// The `next-auth` shim backed end to end by a real Auth.js adapter from npm —
// `@auth/drizzle-adapter` over `drizzle-orm` — on SQLite (denext's better-sqlite3 compat over
// Deno's built-in `node:sqlite`, through drizzle's `sqlite-proxy` driver) and on Postgres
// (`drizzle-orm/postgres-js` over `npm:postgres`). Through the Auth.js handlers, with
// `session: { strategy: "database" }`: a Credentials sign-in writes a `session` row and sign-out
// deletes it; an OAuth sign-in (a mock identity provider) creates the user and links an `account`
// row with the provider's tokens, and signing in again reuses both; an email link stores a hashed
// `verificationToken` row that its sign-in spends exactly once; and v4's
// `getServerSession(authOptions)` reads the database session.
//
// The SQLite half always runs. The Postgres half needs a server:
//
//   docker run --rm -d --name dnx-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55433/postgres \
//     deno test -A tests/next-auth-adapters-integration.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import NextAuth, {
  getServerSession,
  type NextAuthConfig,
} from "../packages/auth/next-auth/index.ts";
import type { AuthJsAdapter } from "../packages/auth/next-auth/adapter.ts";
import { instanceFor } from "../packages/auth/next-auth/instance.ts";
import Credentials from "../packages/auth/next-auth/providers/credentials.ts";
import Resend from "../packages/auth/next-auth/providers/resend.ts";
import Database from "../src/compat/better-sqlite3.ts";
import { type CallInit, inRequest, Jar, request } from "./helpers/next-auth-harness.ts";

const SECRET = "next-auth-adapters-test-secret-at-least-32-chars";
const PG_URL = Deno.env.get("DENEXT_TEST_POSTGRES_URL") || undefined;

/** An npm specifier built at run time, so type checking never downloads the package. */
const npm = (name: string, version: string, sub = "") => `npm:${name}@${version}${sub}`;
const DRIZZLE = "0.45.3";
const ADAPTER = "1.11.3";

/** A database under test: the adapter over it, a row count per table, and a teardown. */
interface Backend {
  adapter: AuthJsAdapter;
  rows: (table: string, where?: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

/** The Auth.js tables `@auth/drizzle-adapter`'s default SQLite schema reads. */
const SQLITE_DDL = `
  CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, emailVerified INTEGER,
    image TEXT);
  CREATE TABLE "account" (userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type TEXT NOT NULL, provider TEXT NOT NULL, providerAccountId TEXT NOT NULL,
    refresh_token TEXT, access_token TEXT, expires_at INTEGER, token_type TEXT, scope TEXT,
    id_token TEXT, session_state TEXT, PRIMARY KEY (provider, providerAccountId));
  CREATE TABLE "session" (sessionToken TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
  CREATE TABLE "verificationToken" (identifier TEXT NOT NULL, token TEXT NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY (identifier, token));
`;

/** The same tables in Postgres (`@auth/drizzle-adapter`'s default pg schema). */
const PG_DDL = `
  CREATE TABLE "user" (id text PRIMARY KEY, name text, email text UNIQUE,
    "emailVerified" timestamp, image text);
  CREATE TABLE "account" ("userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type text NOT NULL, provider text NOT NULL, "providerAccountId" text NOT NULL,
    refresh_token text, access_token text, expires_at integer, token_type text, scope text,
    id_token text, session_state text, PRIMARY KEY (provider, "providerAccountId"));
  CREATE TABLE "session" ("sessionToken" text PRIMARY KEY,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, expires timestamp NOT NULL);
  CREATE TABLE "verificationToken" (identifier text NOT NULL, token text NOT NULL,
    expires timestamp NOT NULL, PRIMARY KEY (identifier, token));
`;

/** `@auth/drizzle-adapter` on SQLite: drizzle's sqlite-proxy over the better-sqlite3 compat. */
async function sqliteBackend(): Promise<Backend> {
  const { drizzle } = await import(npm("drizzle-orm", DRIZZLE, "/sqlite-proxy"));
  const { DrizzleAdapter } = await import(npm("@auth/drizzle-adapter", ADAPTER));
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;" + SQLITE_DDL);
  const db = drizzle((sql: string, params: unknown[], method: string) => {
    const statement = sqlite.prepare(sql);
    if (method === "run") {
      statement.run(...params);
      return Promise.resolve({ rows: [] });
    }
    const rows = statement.raw().all(...params) as unknown[][];
    return Promise.resolve({ rows: method === "get" ? rows[0] : rows });
  });
  return {
    adapter: DrizzleAdapter(db),
    rows: (table, where = "1 = 1") =>
      Promise.resolve(
        sqlite.prepare(`SELECT * FROM "${table}" WHERE ${where}`).all() as Record<
          string,
          unknown
        >[],
      ),
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

/** A minimal postgres.js client, as far as this test uses it. */
interface PostgresJs {
  unsafe(text: string): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

/** `@auth/drizzle-adapter` on Postgres, in a database of its own (dropped by `close`). */
async function postgresBackend(adminUrl: string): Promise<Backend> {
  const postgres = (await import(npm("postgres", "3.4.7"))).default as (
    url: string,
    options?: Record<string, unknown>,
  ) => PostgresJs;
  const { drizzle } = await import(npm("drizzle-orm", DRIZZLE, "/postgres-js"));
  const { DrizzleAdapter } = await import(npm("@auth/drizzle-adapter", ADAPTER));
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const name = `dnx_nextauth_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await client.unsafe(PG_DDL);
  return {
    adapter: DrizzleAdapter(drizzle(client)),
    rows: (table, where = "1 = 1") => client.unsafe(`SELECT * FROM "${table}" WHERE ${where}`),
    close: async () => {
      await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** The mock identity provider's endpoints, answered by a stubbed `fetch`. */
function mockIdp(): { restore: () => void } {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://idp.mock.test/token")) {
      return Promise.resolve(Response.json({
        access_token: "at-grace",
        refresh_token: "rt-grace",
        token_type: "bearer",
        expires_in: 3600,
        scope: "profile email",
      }));
    }
    if (url.startsWith("https://idp.mock.test/userinfo")) {
      return Promise.resolve(Response.json({ id: 42, name: "Grace", email: "grace@example.com" }));
    }
    return real(input, init);
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = real) };
}

/** An app over `adapter` with database sessions: Credentials, the mock IdP and an email link. */
function appOver(adapter: AuthJsAdapter, knownUserId: string) {
  const links: string[] = [];
  const config: NextAuthConfig = {
    secret: SECRET,
    adapter,
    session: { strategy: "database" },
    providers: [
      Credentials({
        authorize: (
          c,
        ) => (c.email === "ada@example.com" && c.password === "pw" ? { id: knownUserId } : null),
      }),
      {
        id: "mock",
        name: "Mock IdP",
        type: "oauth",
        authorization: {
          url: "https://idp.mock.test/authorize",
          params: { scope: "profile email" },
        },
        token: "https://idp.mock.test/token",
        userinfo: "https://idp.mock.test/userinfo",
        clientId: "mock-client",
        clientSecret: "mock-secret",
        profile: (p: Record<string, unknown>) => ({
          id: String(p.id),
          name: String(p.name),
          email: String(p.email),
        }),
      },
      Resend({ confirm: false, sendVerificationRequest: ({ url }) => void links.push(url) }),
    ],
  };
  const { handlers } = NextAuth(config);
  instanceFor(config).denext.dangerouslyAllowInsecureProviders = true;
  const jar = new Jar();
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, init);
    const handler = req.method === "GET" ? handlers.GET : handlers.POST;
    const { value, error } = await inRequest(req, jar, () => handler(req));
    if (error) throw error;
    jar.take(value!.headers);
    return value!;
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  const session = async () =>
    (await (await call("/api/auth/session")).json()) as { user?: { email?: string } } | null;
  const signOut = async () =>
    await call("/api/auth/signout", { form: { csrfToken: await csrf() } });
  return { config, jar, call, csrf, session, signOut, links };
}

/** The OAuth round trip against the mock IdP; returns the callback's answer. */
async function oauthSignIn(a: ReturnType<typeof appOver>): Promise<Response> {
  const start = await a.call("/api/auth/signin/mock", {
    form: { csrfToken: await a.csrf(), callbackUrl: "/after" },
  });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  return await a.call(`/api/auth/callback/mock?code=c-1&state=${state}`);
}

/** Every flow, against one backend. */
async function suite(t: Deno.TestContext, backend: Backend): Promise<void> {
  const { adapter, rows } = backend;
  const ada = await adapter.createUser!({
    id: crypto.randomUUID(),
    name: "Ada",
    email: "ada@example.com",
    emailVerified: null,
  });
  const a = appOver(adapter, ada.id);

  await t.step("Credentials: a database session row, deleted at sign-out", async () => {
    const res = await a.call("/api/auth/callback/credentials", {
      form: { csrfToken: await a.csrf(), email: "ada@example.com", password: "pw" },
    });
    assertEquals(res.status, 302);
    const stored = await rows("session");
    assertEquals(stored.length, 1);
    assertEquals(stored[0].userId, ada.id);
    assertEquals((await a.session())?.user?.email, "ada@example.com");
    // v4's getServerSession reads the same database session.
    const read = await inRequest(request(a.jar, "/page"), a.jar, () => getServerSession(a.config));
    assertEquals(read.value?.user?.email, "ada@example.com");
    await a.signOut();
    assertEquals((await rows("session")).length, 0);
    assertEquals(await a.session(), null);
  });

  await t.step("OAuth: the user is created and the account linked, then reused", async () => {
    const idp = mockIdp();
    try {
      const back = await oauthSignIn(a);
      assertEquals(back.status, 303);
      assertEquals((await a.session())?.user?.email, "grace@example.com");
      const accounts = await rows("account");
      assertEquals(accounts.length, 1);
      assertEquals(accounts[0].provider, "mock");
      assertEquals(accounts[0].providerAccountId, "42");
      assertEquals(accounts[0].access_token, "at-grace");
      assertEquals(accounts[0].refresh_token, "rt-grace");
      const graceId = accounts[0].userId;
      const users = await rows("user", `email = 'grace@example.com'`);
      assertEquals(users.map((u) => u.id), [graceId]);
      await a.signOut();
      await oauthSignIn(a);
      assertEquals((await rows("account")).length, 1, "no second account row");
      assertEquals((await rows("user", `email = 'grace@example.com'`)).length, 1);
      assertEquals((await rows("session"))[0].userId, graceId);
      await a.signOut();
    } finally {
      idp.restore();
    }
  });

  await t.step("Email: a hashed verification token, spent exactly once", async () => {
    await a.call("/api/auth/signin/resend", {
      form: { csrfToken: await a.csrf(), email: "new@example.com", callbackUrl: "/dash" },
    });
    const link = new URL(a.links.at(-1)!);
    const raw = link.searchParams.get("token")!;
    const tokens = await rows("verificationToken");
    assertEquals(tokens.length, 1);
    assertEquals(tokens[0].identifier, "magic:new@example.com");
    assertNotEquals(tokens[0].token, raw, "the token is stored hashed");
    const first = await a.call(link.pathname + link.search);
    assertEquals(first.headers.get("location"), "/dash");
    assertEquals((await a.session())?.user?.email, "new@example.com");
    assertEquals((await rows("verificationToken")).length, 0, "spent");
    const verified = await rows("user", `email = 'new@example.com'`);
    assert(verified[0].emailVerified, "the address is verified");
    await a.signOut();
    const replay = await a.call(link.pathname + link.search);
    assert(String(replay.headers.get("location")).includes("error="), "a spent link fails");
    assertEquals(await a.session(), null);
  });
}

Deno.test({
  name: "next-auth adapters: @auth/drizzle-adapter on SQLite (node:sqlite) backs the shim",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const backend = await sqliteBackend();
    try {
      await suite(t, backend);
    } finally {
      await backend.close();
    }
  },
});

Deno.test({
  name: "next-auth adapters: @auth/drizzle-adapter on Postgres backs the shim" +
    (PG_URL ? "" : " (skipped: set DENEXT_TEST_POSTGRES_URL)"),
  ignore: !PG_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const backend = await postgresBackend(PG_URL!);
    try {
      await suite(t, backend);
    } finally {
      await backend.close();
    }
  },
});
