// The `cors()` and `csrf()` API middlewares (src/server/api-middleware.ts) through createApp:
// a per-endpoint CORS policy answering its preflight and decorating success AND error
// responses, and the same-origin / double-submit CSRF gate on cookie-authenticated writes.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import { apiDefinitionOf, createApi } from "../src/server/define-api.ts";
import { cors, csrf } from "../src/server/api-middleware.ts";
import { ApiError } from "../src/server/api-error.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { ApiModule } from "../src/server/types.ts";
import type { AppConfig } from "../src/server/app-config.ts";

const MANIFEST: RouteManifest = {
  pages: [],
  api: [{
    kind: "api",
    pattern: parsePattern("/api/thing"),
    routePath: "/api/thing",
    filePath: "thing.ts",
  }],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
};

function app(mod: ApiModule, extra: Partial<AppConfig> = {}) {
  return createApp({
    getManifest: () => MANIFEST,
    load: (fp: string) => Promise.resolve(fp === "thing.ts" ? mod : undefined),
    ...extra,
  });
}

const URL_ = "https://api.test/api/thing";

function req(method: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(URL_, { method, headers: { host: "api.test", ...headers }, body });
}

function preflight(origin: string, method = "POST"): Request {
  return req("OPTIONS", { origin, "access-control-request-method": method });
}

// ---- cors() ---------------------------------------------------------------------------

Deno.test("cors(): answers the preflight for the method it guards, before the chain runs", async () => {
  let ran = 0;
  const guarded = createApi().use(cors({ origins: ["https://web.test"], credentials: true }))
    .use(() => {
      ran++;
      throw new ApiError(401, "unauthorized");
    });
  const handler = app({ POST: guarded.define({}, () => ({ ok: true })) });
  const ok = await handler(preflight("https://web.test"));
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://web.test");
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");
  const evil = await handler(preflight("https://web.test.evil"));
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
  assertEquals(ran, 0, "a preflight never reaches the endpoint's middleware");
});

Deno.test("cors(): decorates the success and the error response for an allowed origin only", async () => {
  const handler = app({
    GET: createApi().use(cors({ origins: ["https://web.test"] })).define({}, () => ({ ok: 1 })),
    POST: createApi().use(cors({ origins: ["https://web.test"] })).define(
      { errors: { nope: 409 } },
      ({ fail }) => fail("nope"),
    ),
  });
  const ok = await handler(req("GET", { origin: "https://web.test" }));
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://web.test");
  assert(ok.headers.get("vary")?.includes("Origin"));
  const err = await handler(req("POST", { origin: "https://web.test" }));
  assertEquals(err.status, 409);
  assertEquals(err.headers.get("access-control-allow-origin"), "https://web.test");
  const other = await handler(req("GET", { origin: "https://other.test" }));
  assertEquals(other.headers.get("access-control-allow-origin"), null);
  await Promise.all([ok, err, other].map((r) => r.body?.cancel()));
});

Deno.test("cors(): replaces the app and route policy for its method only", async () => {
  const handler = app(
    {
      POST: createApi().use(cors({ origins: ["https://web.test"] })).define({}, () => ({})),
      PUT: createApi().define({}, () => ({})),
      cors: { origins: ["https://route.test"] },
    } as ApiModule,
    { cors: { origins: ["capacitor://localhost"] } },
  );
  const post = await handler(preflight("https://route.test", "POST"));
  assertEquals(post.headers.get("access-control-allow-origin"), null, "middleware replaced route");
  const postWeb = await handler(preflight("https://web.test", "POST"));
  assertEquals(postWeb.headers.get("access-control-allow-origin"), "https://web.test");
  const put = await handler(preflight("https://route.test", "PUT"));
  assertEquals(put.headers.get("access-control-allow-origin"), "https://route.test");
});

Deno.test("cors(): a policy that can't be applied safely throws at definition time", () => {
  assertThrows(() => cors({ origins: ["*"], credentials: true }), Error, "credentials");
  assertThrows(() => cors({ origins: ["https://evil.test/path"] }), Error, "path");
  assertThrows(() => cors(null as never), Error, "origins");
});

// ---- csrf() ---------------------------------------------------------------------------

function csrfApp(options?: Parameters<typeof csrf>[0], extra: Partial<AppConfig> = {}) {
  const chain = createApi().use(csrf(options));
  return app({
    GET: chain.define({}, () => ({ read: true })),
    POST: chain.define({}, () => ({ wrote: true })),
  }, extra);
}

async function status(res: Response): Promise<[number, string | undefined]> {
  const body = res.status === 204 ? null : await res.json();
  return [res.status, body?.error?.code];
}

Deno.test("csrf(): a cookie-carrying cross-site write is a 403 csrf_failed; same-origin passes", async () => {
  const handler = csrfApp();
  const cookie = "session=abc";
  assertEquals(
    await status(await handler(req("POST", { cookie, origin: "https://evil.test" }))),
    [403, "csrf_failed"],
  );
  assertEquals(await status(await handler(req("POST", { cookie }))), [403, "csrf_failed"]);
  assertEquals(
    await status(await handler(req("POST", { cookie, origin: "https://api.test.evil.test" }))),
    [403, "csrf_failed"],
  );
  assertEquals(
    await status(await handler(req("POST", { cookie, referer: "https://evil.test/x" }))),
    [403, "csrf_failed"],
  );
  const same = await handler(req("POST", { cookie, origin: "https://api.test" }));
  assertEquals(same.status, 200);
  assertEquals(await same.json(), { wrote: true });
  const viaReferer = await handler(req("POST", { cookie, referer: "https://api.test/page" }));
  assertEquals(viaReferer.status, 200);
  await viaReferer.body?.cancel();
});

Deno.test("csrf(): safe methods and cookieless callers pass unless checkCookieless", async () => {
  const handler = csrfApp();
  const read = await handler(req("GET", { cookie: "s=1", origin: "https://evil.test" }));
  assertEquals(read.status, 200);
  await read.body?.cancel();
  const bearer = await handler(req("POST", { authorization: "Bearer t" }));
  assertEquals(bearer.status, 200, "no cookie → no ambient credential to abuse");
  await bearer.body?.cancel();
  const strict = csrfApp({ checkCookieless: true });
  assertEquals(
    await status(await strict(req("POST", { authorization: "Bearer t" }))),
    [403, "csrf_failed"],
  );
});

Deno.test("csrf(): app allowedOrigins, option allowedOrigins and the desktop origin are honored", async () => {
  const cookie = "s=1";
  const fromConfig = csrfApp({}, { allowedOrigins: ["https://admin.test"] });
  const a = await fromConfig(req("POST", { cookie, origin: "https://admin.test" }));
  assertEquals(a.status, 200);
  await a.body?.cancel();
  const fromOption = csrfApp({ allowedOrigins: ["capacitor://localhost"] });
  const b = await fromOption(req("POST", { cookie, origin: "capacitor://localhost" }));
  assertEquals(b.status, 200);
  await b.body?.cancel();
  assertEquals(
    await status(await fromOption(req("POST", { cookie, origin: "capacitor://localhost.evil" }))),
    [403, "csrf_failed"],
  );
  const desktop = csrfApp({}, { desktopAppOrigin: "myapp://app" });
  const c = await desktop(req("POST", { cookie, origin: "myapp://app" }));
  assertEquals(c.status, 200);
  await c.body?.cancel();
});

Deno.test("csrf(): canonicalOrigin makes the own-origin check scheme-strict", async () => {
  const handler = csrfApp({}, { canonicalOrigin: "https://api.test" });
  assertEquals(
    await status(await handler(req("POST", { cookie: "s=1", origin: "http://api.test" }))),
    [403, "csrf_failed"],
  );
});

Deno.test("csrf({ doubleSubmit }): issues the token cookie and requires the header to echo it", async () => {
  const handler = csrfApp({ doubleSubmit: true });
  const first = await handler(req("GET", { origin: "https://api.test" }));
  await first.body?.cancel();
  const setCookie = first.headers.getSetCookie().find((c) => c.startsWith("denext-csrf="));
  assert(setCookie, "a GET without the cookie is issued one");
  assert(/SameSite=Strict/i.test(setCookie));
  assert(!/HttpOnly/i.test(setCookie), "the page's script must be able to read it");
  const token = setCookie.slice("denext-csrf=".length).split(";")[0];
  assert(token.length >= 32);

  const cookie = `session=abc; denext-csrf=${token}`;
  const origin = "https://api.test";
  assertEquals(
    await status(await handler(req("POST", { cookie, origin }))),
    [403, "csrf_failed"],
    "same origin but no echoed token",
  );
  assertEquals(
    await status(await handler(req("POST", { cookie, origin, "x-csrf-token": token + "x" }))),
    [403, "csrf_failed"],
  );
  assertEquals(
    await status(
      await handler(req("POST", { cookie, origin: "https://evil.test", "x-csrf-token": token })),
    ),
    [403, "csrf_failed"],
    "the token never replaces the origin check",
  );
  const ok = await handler(req("POST", { cookie, origin, "x-csrf-token": token }));
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.getSetCookie().length, 0, "an existing token is not re-issued");
  await ok.body?.cancel();
  const noToken = await handler(req("POST", { cookie: "session=abc", origin, "x-csrf-token": "" }));
  assertEquals((await status(noToken))[0], 403, "an empty cookie never matches an empty header");
});

Deno.test("csrf({ doubleSubmit }): custom cookie and header names", async () => {
  const handler = csrfApp({ doubleSubmit: { cookie: "xsrf", header: "x-xsrf" } });
  const ok = await handler(
    req("POST", { cookie: "xsrf=tok123", origin: "https://api.test", "x-xsrf": "tok123" }),
  );
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

Deno.test("csrf(): documents csrf_failed on the endpoint (for @denext/openapi); own spec wins", () => {
  const h = createApi().use(csrf()).define({}, () => ({}));
  assertEquals(apiDefinitionOf(h)?.def.errors, { csrf_failed: 403 });
  const own = createApi().use(csrf()).define(
    { errors: { csrf_failed: { status: 403, message: "mine" }, other: 409 } },
    () => ({}),
  );
  assertEquals(apiDefinitionOf(own)?.def.errors, {
    csrf_failed: { status: 403, message: "mine" },
    other: 409,
  });
  const plainDef = { errors: { x: 400 } };
  const plain = createApi().define(plainDef, () => ({}));
  assert(apiDefinitionOf(plain)?.def === plainDef, "an undocumented chain keeps the definition");
});
