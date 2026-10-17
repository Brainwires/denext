// `denext migrate --from remix`: an Express `getLoadContext` → `load-context.ts`. The values the
// server read from the Express request / response become per-request denext expressions (the
// Fetch Request, cookies, client address, auth, the signed session, a middleware's own
// expression), and what can't be carried over is a located `TODO(denext migrate)` note. The
// second half RUNS the generated module in a request context, so the wiring is proven, not
// just printed.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { loadContextModule } from "../src/build/remix-load-context.ts";
import { transformRemixApp } from "../src/build/remix-migrate.ts";
import { clearLoadContext, loadContext } from "../src/compat/remix/load-context.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { getSession } from "../src/server/session.ts";

const SECRET = "a-session-secret-of-at-least-32-chars!";

/** An Express server in the shape Remix apps ship (`server/index.ts`). */
const SERVER = `import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import { createRequestHandler } from "@remix-run/express";
import { prisma, unused } from "./db.ts";

const app = express();
const LIMIT = 10;
app.use(session({ secret: process.env.LC_TEST_SECRET!, resave: false }));
app.use((req, res, next) => {
  res.locals.requestId = crypto.randomUUID();
  res.locals.locale = req.headers["accept-language"]?.split(",")[0] ?? "en";
  req.tenant = req.get("X-Tenant") ?? "default";
  next();
});
app.use((_req, res, next) => {
  const local = 1;
  res.locals.fromLocal = local;
  next();
});
app.all(
  "*",
  createRequestHandler({
    getLoadContext(req, res) {
      return {
        cspNonce: res.locals.cspNonce,
        serverBuild: getBuild(),
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        host: req.get("host"),
        session: req.session,
        userId: req.session.userId,
        user: req.user,
        path: req.path,
        url: req.originalUrl,
        page: req.query.page,
        theme: req.cookies.theme,
        requestId: res.locals.requestId,
        locale: res.locals.locale,
        tenant: req.tenant,
        db: prisma,
        env: process.env.LC_TEST_MODE,
        limit: LIMIT,
        missing: res.locals.never,
        fromLocal: res.locals.fromLocal,
        raw: req,
        ...res.locals,
      };
    },
  }),
);
app.listen(3000);
`;

/** Write the server (+ the module it imports) into a fresh app dir. */
async function scaffold(server = SERVER): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-load-context-" });
  await Deno.mkdir(join(dir, "server"));
  await Deno.writeTextFile(join(dir, "server", "index.ts"), server);
  await Deno.writeTextFile(
    join(dir, "server", "db.ts"),
    `export const prisma = { kind: "db" };\nexport const unused = 1;\n`,
  );
  return dir;
}

Deno.test("load context: Express reads become denext expressions", async () => {
  const dir = await scaffold();
  try {
    const result = await loadContextModule(dir);
    const code = result!.module!.code;
    const has = (s: string) => assertStringIncludes(code, s);
    // The provider is async (auth, the session) and reads the request, its URL and nothing else.
    has("export default defineLoadContext(async ({ request }) => {");
    has("const requestUrl = new URL(request.url);");
    has('import { auth, clientIp, cookies, getSession } from "denext/server";');
    has("ip: clientIp(),");
    has('userAgent: (request.headers.get("user-agent") ?? undefined),');
    has("host: requestUrl.host,");
    has("session: (await requestSession()),");
    has("userId: (await requestSession()).userId,");
    has("user: (await auth())?.user,");
    has("path: requestUrl.pathname,");
    has("url: (requestUrl.pathname + requestUrl.search),");
    has('page: (requestUrl.searchParams.get("page") ?? undefined),');
    has('theme: cookies().get("theme")?.value,');
    // A middleware's result, recomputed from its own expression (with its own reads mapped).
    has("requestId: (crypto.randomUUID()),");
    has(
      'locale: ((request.headers.get("accept-language") ?? undefined)?.split(",")[0] ?? "en"),',
    );
    has('tenant: ((request.headers.get("x-tenant") ?? undefined) ?? "default"),');
    // Imports and globals carry over (an import pruned to the bindings used).
    has('import crypto from "node:crypto";');
    has('import { prisma } from "./db.ts";');
    assert(!code.includes("unused"), "an import binding no value uses is dropped");
    assert(!/from "express(-session)?"/.test(code), "the server framework is not imported");
    has("db: prisma,");
    has("env: process.env.LC_TEST_MODE,");
    // The session helper signs with the secret the server gave express-session.
    has("secret: process.env.LC_TEST_SECRET!");
    // Known keys keep their mapping.
    has("cspNonce: undefined,");
    has("get serverBuild() {");
    // What can't be carried over: an undefined value under a located note.
    has(
      "// TODO(denext migrate): `LIMIT` (server/index.ts:43) uses `LIMIT`, declared in " +
        "server/index.ts:8 — move it to a module both can import\n    limit: undefined,",
    );
    has(
      "// TODO(denext migrate): `res.locals.never` (server/index.ts:44) is never set in " +
        "server/index.ts\n    missing: undefined,",
    );
    has(
      "`res.locals.fromLocal` (server/index.ts:45) is set at server/index.ts:18, which uses " +
        "`local`, which only exists inside the server's own code",
    );
    has("// TODO(denext migrate): `req` (server/index.ts:46) passes `req` itself on");
    has(
      "// TODO(denext migrate): `...res.locals` (server/index.ts:47) has no denext equivalent " +
        "as a whole",
    );
    assertEquals(result!.module!.srcDir, join(dir, "server"));
    assertMatch(result!.warnings[0], /^server\/index\.ts: getLoadContext → load-context\.ts \(/);
    assertStringIncludes(result!.warnings[0], "ip → wired");
    assertStringIncludes(result!.warnings[0], "limit → TODO");
    assertStringIncludes(
      result!.warnings[1],
      "load-context.ts: 5 value(s) need porting by hand — see its TODO(denext migrate) notes",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("load context: without request reads the provider stays a plain arrow", async () => {
  const dir = await scaffold(
    `import { prisma } from "./db.ts";\nexport const handler = createRequestHandler({\n` +
      `  getLoadContext: () => ({ db: prisma, mode: process.env.NODE_ENV }),\n});\n`,
  );
  try {
    const code = (await loadContextModule(dir))!.module!.code;
    assertStringIncludes(code, "export default defineLoadContext(() => ({\n  db: prisma,\n");
    assert(!code.includes('from "denext/server"'), "nothing from denext/server is needed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("load context: a value left as a TODO leaves no import or helper behind", async () => {
  const dir = await scaffold(
    `import { prisma } from "./db.ts";\nconst LIMIT = 1;\nexport const handler = createRequestHandler({\n` +
      `  getLoadContext: (req) => ({ capped: [req.user, req.session, prisma, LIMIT] }),\n});\n`,
  );
  try {
    const code = (await loadContextModule(dir))!.module!.code;
    assertStringIncludes(code, "capped: undefined,");
    assert(!code.includes('from "denext/server"'), "no auth/getSession import for a TODO");
    assert(!code.includes("requestSession"), "no session helper for a TODO");
    assert(!code.includes('from "./db.ts"'), "no carried import for a TODO");
    assert(!code.includes("async"), "the provider stays synchronous");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("load context: the migrated module runs and yields the request's values", async () => {
  const dir = await scaffold();
  Deno.env.set("LC_TEST_SECRET", SECRET);
  Deno.env.set("LC_TEST_MODE", "staging");
  try {
    await Deno.mkdir(join(dir, "app", "routes"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "root.tsx"),
      `import { Outlet } from "@remix-run/react";\nexport default function Root() { return <Outlet />; }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "app", "routes", "_index.tsx"),
      `export default function Home() { return <p>home</p>; }\n`,
    );
    await transformRemixApp(dir);
    const path = join(dir, "load-context.ts");
    assertStringIncludes(await Deno.readTextFile(path), 'from "./server/db.ts"', "re-based");
    await import(toFileUrl(path).href); // registers the provider

    // A signed session cookie, as denext's getSession writes it.
    const issuing = createRequestContext(new Request("http://localhost/"));
    await runWithContext(issuing, async () => {
      await (await getSession({ secret: SECRET })).set({ userId: "u1" });
    });
    const sessionCookie = issuing.outgoingHeaders.get("set-cookie")!.split(";")[0];

    const request = new Request("http://example.test/notes/1?page=2", {
      headers: {
        "user-agent": "test-agent",
        "accept-language": "fr-CA,fr;q=0.9",
        "x-tenant": "acme",
        cookie: `theme=dark; ${sessionCookie}`,
      },
    });
    const context = await runWithContext(
      createRequestContext(request),
      () => loadContext(request, {}),
    );
    assertEquals(context.userAgent, "test-agent");
    assertEquals(context.host, "example.test");
    assertEquals(context.path, "/notes/1");
    assertEquals(context.url, "/notes/1?page=2");
    assertEquals(context.page, "2");
    assertEquals(context.theme, "dark");
    assertEquals(context.locale, "fr-CA");
    assertEquals(context.tenant, "acme");
    assertEquals(context.userId, "u1");
    assertEquals(context.session, { userId: "u1" });
    assertEquals(context.user, undefined, "no denextAuth session: signed out");
    assertEquals(context.db, { kind: "db" });
    assertEquals(context.env, "staging");
    assertMatch(String(context.requestId), /^[0-9a-f-]{36}$/);
    assertEquals(context.limit, undefined);
    assertEquals(context.cspNonce, undefined);
  } finally {
    clearLoadContext();
    Deno.env.delete("LC_TEST_SECRET");
    Deno.env.delete("LC_TEST_MODE");
    await Deno.remove(dir, { recursive: true });
  }
});
