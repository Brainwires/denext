// `denext/fresh` and `denext/preact` units: the recording `App`, Fresh's middleware (`csrf`,
// `cors`, `trailingSlashes`, `ipFilter`, `csp`, `staticFiles`), the context helpers, the
// define helpers, and the Preact shims.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  App,
  cors,
  createDefine,
  csp,
  csrf,
  defineApp,
  defineConfig,
  defineLayout,
  defineRoute,
  HttpError,
  ipFilter,
  page,
  start,
  staticFiles,
  STATUS_CODE,
  trailingSlashes,
} from "../src/compat/fresh/mod.ts";
import {
  asset,
  assetSrcSet,
  Head,
  IS_BROWSER,
  nonce,
  Partial,
  useCSP,
} from "../src/compat/fresh/runtime.ts";
import { type Context, createFreshRequest } from "../src/compat/fresh/context.ts";
import { constructedApps } from "../src/compat/fresh/app.ts";
import { env } from "../src/compat/fresh/env.ts";
import * as preact from "../src/compat/preact/mod.ts";
import { useErrorBoundary } from "../src/compat/preact/hooks.ts";
import * as compat from "../src/compat/preact/compat.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";

/** A Fresh context for `url` whose `next()` answers `next`. */
function ctxFor(url: string, init: RequestInit = {}, next = () => new Response("next")): Context {
  const ctx = createFreshRequest(new Request(url, init), false).ctx;
  ctx.next = () => Promise.resolve(next());
  return ctx;
}

Deno.test("App records middleware, code routes, layouts and handlers; islands() is reported", async () => {
  const mw = () => new Response("mw");
  const app = new App({ basePath: "/x" })
    .use(mw)
    .use("/api", [mw, mw])
    .get("/a", mw)
    .post("/a", mw)
    .put("/a", mw)
    .patch("/a", mw)
    .delete("/a", mw)
    .head("/a", mw)
    .all("/b", mw)
    .fsRoutes()
    .appWrapper(mw)
    .layout("/", mw)
    .onError("/", mw)
    .notFound(mw)
    .route("/r", {})
    .mountApp("/m", {})
    .islands({});
  assertEquals(app.config.basePath, "/x");
  assertEquals(app._middlewares.map((m) => [m.path, m.fns.length]), [["*", 1], ["/api", 2]]);
  assertEquals(app._routes.map((r) => r.method), [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "ALL",
  ]);
  assertEquals(app._appWrapper, mw);
  assertEquals(app._layouts, [{ path: "/", component: mw, config: undefined }]);
  assertEquals(app._errors, [{ path: "/", route: { handler: mw } }]);
  assertEquals(app._notFound, { handler: mw });
  assertEquals(app._pages, [{ pattern: "/r", route: {}, config: undefined }]);
  // A mountApp() of something that is not an App adds nothing.
  assertEquals(app._ignored.map((i) => i.call), ["islands"]);
  assertEquals(constructedApps().at(-1), app as never);
  await app.listen();
  assertThrows(() => app.handler(), Error, "denext serves the app");
});

Deno.test("App: mountApp prefixes a sub-app's middleware, routes, pages, layouts and errors", () => {
  const h = () => new Response("x");
  const load = () => Promise.resolve({ handler: h });
  const sub = new App()
    .use(h)
    .use("/inner", h)
    .get("/", h)
    .get("users/:id", h)
    .route("/p", load)
    .route("/q")
    .layout("/", h)
    .onError("/e", h)
    .appWrapper(h)
    .notFound(h);
  const host = new App().mountApp("/api/", sub);
  assertEquals(host._middlewares.map((m) => m.path), ["/api/*", "/api/inner"]);
  assertEquals(host._routes.map((r) => r.pattern), ["/api", "/api/users/:id"]);
  assertEquals(host._pages, [
    { pattern: "/api/p", route: load, config: undefined },
    { pattern: "/api/q", route: {}, config: undefined },
  ]);
  assertEquals(host._layouts.map((l) => l.path), ["/api"]);
  assertEquals(host._errors.map((e) => e.path), ["/api/e"]);
  // The sub-app's wrapper and not-found route replace the host's.
  assertEquals([host._appWrapper, host._notFound], [h, { handler: h }]);
  // Mounted at the root, "/" stays "/"; a sub-app without a wrapper keeps the host's.
  const own = () => new Response("own");
  const root = new App().appWrapper(own).notFound(own).mountApp("", new App().get("/", h));
  assertEquals(root._routes.map((r) => r.pattern), ["/"]);
  assertEquals([root._appWrapper, root._notFound], [own, { handler: own }]);
});

Deno.test("App: ws() is a GET route that upgrades; constructedApps() is empty before any app", () => {
  const handlers = { message: () => {} };
  const app = new App().ws("/sock", handlers, { idleTimeout: 5 });
  assertEquals(app._routes.map((r) => [r.method, r.pattern]), [["GET", "/sock"]]);
  const calls: unknown[] = [];
  const upgraded = new Response("up");
  const ctx = { upgrade: (...args: unknown[]) => (calls.push(args), upgraded) };
  assertEquals((app._routes[0].fns[0] as (c: unknown) => Response)(ctx), upgraded);
  assertEquals(calls, [[handlers, { idleTimeout: 5 }]]);
  const key = Symbol.for("denext.fresh.apps");
  const g = globalThis as { [key: symbol]: unknown };
  const saved = g[key];
  delete g[key];
  try {
    assertEquals(constructedApps(), []);
  } finally {
    g[key] = saved;
  }
});

Deno.test("denext/fresh/env: in the browser the page's variables and the dev flags", () => {
  const g = globalThis as { document?: unknown; __denextDev?: boolean };
  g.document = {
    getElementById: () => ({ textContent: JSON.stringify({ FRESH_PUBLIC_UNIT: "page" }) }),
  };
  g.__denextDev = true;
  try {
    assertEquals([env.FRESH_PUBLIC_UNIT, env.MODE, env.DEV, env.PROD, env.SSR], [
      "page",
      "development",
      true,
      false,
      false,
    ]);
    // Read once: a later change to the page is not picked up.
    g.document = { getElementById: () => null };
    assertEquals(env.FRESH_PUBLIC_UNIT, "page");
    // Symbols and unknown names read as absent.
    const sym = Symbol("x");
    assertEquals((env as unknown as Record<symbol, unknown>)[sym], undefined);
    assertEquals(sym in env, false);
    assertEquals(["MODE" in env, "NOPE" in env], [true, false]);
    assertEquals(Object.getOwnPropertyDescriptor(env, "NOPE"), undefined);
    assertEquals(Object.getOwnPropertyDescriptor(env, sym), undefined);
    assertEquals(Object.getOwnPropertyDescriptor(env, "MODE")?.value, "development");
  } finally {
    delete g.document;
    delete g.__denextDev;
  }
});

Deno.test("Fresh middleware: staticFiles, trailingSlashes, csp continue or redirect", async () => {
  assertEquals(await (await staticFiles()(ctxFor("http://x/a"))).text(), "next");
  assertEquals(await (await csp()(ctxFor("http://x/a"))).text(), "next");
  const never = trailingSlashes("never");
  assertEquals((await never(ctxFor("http://x/a/?q=1"))).headers.get("location"), "/a?q=1");
  assertEquals(await (await never(ctxFor("http://x/"))).text(), "next");
  const always = trailingSlashes("always");
  assertEquals((await always(ctxFor("http://x/a"))).headers.get("location"), "/a/");
  assertEquals(await (await always(ctxFor("http://x/a/"))).text(), "next");
});

Deno.test("csrf: same-origin and safe requests pass, cross-site writes are 403", async () => {
  const post = (headers: Record<string, string>) => ({ method: "POST", headers });
  const mw = csrf();
  assertEquals(await (await mw(ctxFor("http://x/", { method: "GET" }))).text(), "next");
  assertEquals(
    await (await mw(ctxFor("http://x/", post({ "sec-fetch-site": "same-origin" })))).text(),
    "next",
  );
  assertEquals(await (await mw(ctxFor("http://x/", post({ origin: "http://x" })))).text(), "next");
  assertEquals(await (await mw(ctxFor("http://x/", post({})))).text(), "next");
  await assertRejects(
    async () =>
      await mw(
        ctxFor("http://x/", post({ "sec-fetch-site": "cross-site", origin: "http://evil" })),
      ),
    HttpError,
  );
  await assertRejects(
    async () => await mw(ctxFor("http://x/", post({ origin: "http://evil" }))),
    HttpError,
  );
  const list = csrf({ origin: ["http://ok"] });
  assertEquals(
    await (await list(ctxFor("http://x/", post({ origin: "http://ok" })))).text(),
    "next",
  );
  const one = csrf({ origin: "http://ok" });
  assertEquals(
    await (await one(ctxFor("http://x/", post({ origin: "http://ok" })))).text(),
    "next",
  );
  const fn = csrf({ origin: (o) => o.endsWith(".ok") });
  assertEquals(
    await (await fn(
      ctxFor("http://x/", post({ "sec-fetch-site": "cross-site", origin: "http://a.ok" })),
    )).text(),
    "next",
  );
});

Deno.test("cors: preflight answers, responses carry the CORS headers", async () => {
  const any = cors();
  const res = await any(ctxFor("http://x/", { headers: { origin: "http://o" } }));
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const strict = cors({
    origin: ["http://o"],
    credentials: true,
    exposeHeaders: ["x-a"],
    maxAge: 60,
  });
  const pre = await strict(ctxFor("http://x/", {
    method: "OPTIONS",
    headers: { origin: "http://o", "access-control-request-headers": "x-b, x-c" },
  }));
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), "http://o");
  assertEquals(pre.headers.get("access-control-allow-headers"), "x-b,x-c");
  assertEquals(pre.headers.get("access-control-max-age"), "60");
  assertStringIncludes(pre.headers.get("vary") ?? "", "Origin");
  const fn = cors({ origin: (o) => o === "http://o" ? o : null, allowHeaders: ["x-d"] });
  const pre2 = await fn(
    ctxFor("http://x/", { method: "OPTIONS", headers: { origin: "http://o" } }),
  );
  assertEquals(pre2.headers.get("access-control-allow-headers"), "x-d");
  const one = cors({ origin: "http://p" });
  const r = await one(ctxFor("http://x/", { headers: { origin: "http://o" } }));
  assertEquals(r.headers.get("access-control-allow-origin"), null);
});

Deno.test("ipFilter: deny and allow lists, IPv4 ranges, a custom refusal", async () => {
  // The test context's client address is 127.0.0.1 (no socket peer).
  const denied = ipFilter({ denyList: ["127.0.0.0/8"] });
  assertEquals((await denied(ctxFor("http://x/"))).status, 403);
  const allowed = ipFilter({ allowList: ["127.0.0.1", "10.0.0.0/33", "bad/8"] });
  assertEquals(await (await allowed(ctxFor("http://x/"))).text(), "next");
  const custom = ipFilter({ allowList: ["10.0.0.0/8"] }, {
    onBlocked: (remote) => new Response(remote.type, { status: 401 }),
  });
  const res = await custom(ctxFor("http://x/"));
  assertEquals([res.status, await res.text()], [401, "IPv4"]);
});

Deno.test("Context helpers: redirect, text / html / json, addresses, render, renderNotFound", async () => {
  const ctx = ctxFor("http://x:8000/p");
  assertEquals(ctx.redirect("//evil.com/a?x=1").headers.get("location"), "/evil.com/a?x=1");
  assertEquals(ctx.redirect("/a#h", 301).status, 301);
  assertEquals(ctx.redirect("https://e.com").headers.get("location"), "https://e.com");
  assertEquals(ctx.text("t").headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(
    ctx.html("<b>", { headers: { "content-type": "text/x" } }).headers.get("content-type"),
    "text/x",
  );
  assertEquals(await ctx.json({ a: 1 }).json(), { a: 1 });
  assertEquals(ctx.remoteAddr.hostname, "127.0.0.1");
  assertEquals(ctx.localAddr.port, 8000);
  assertEquals((await ctx.render(null)).status, 200);
  assertEquals((await ctx.renderNotFound()).status, 404);
  assertEquals(typeof ctx.Component, "function");
  assertEquals(
    await (await createFreshRequest(new Request("http://x/"), true).ctx.next()).status,
    404,
  );
  assertThrows(() => ctx.upgrade({}), TypeError);
});

Deno.test("define helpers, page(), 1.x defines, start(), STATUS_CODE, HttpError", async () => {
  const define = createDefine<{ a: number }>();
  const h = { GET: () => new Response("x") };
  assertEquals(define.handlers(h), h);
  const c = () => null;
  assertEquals(define.page(c), c);
  assertEquals(define.layout(c), c);
  assertEquals(define.middleware(c as never), c);
  assertEquals(page(1, { status: 201 }), { data: 1, headers: undefined, status: 201 });
  assertEquals(page().data, undefined);
  const sync = (_r: Request, _c: unknown) => "x";
  const route = defineRoute(sync);
  assertEquals(route.constructor.name, "AsyncFunction");
  assertEquals(await route(new Request("http://x/"), {} as never), "x");
  const asyncFn = async () => await Promise.resolve("y");
  assertEquals(defineLayout(asyncFn), asyncFn);
  assertEquals(await defineApp(sync)(new Request("http://x/"), {} as never), "x");
  assertEquals(defineConfig({ a: 1 }), { a: 1 });
  await assertRejects(() => start(), Error, "denext start");
  assertEquals(STATUS_CODE.NotFound, 404);
  assertEquals(new HttpError(404).message, "Not Found");
  assertEquals(new HttpError(599).message, "HTTP 599");
  assertEquals(new HttpError(400, "bad").status, 400);
});

Deno.test("fresh/runtime: asset, Head, Partial, CSP helpers; preact shims", async () => {
  assertEquals([asset("/a.png"), assetSrcSet("/a.png 1x"), IS_BROWSER], [
    "/a.png",
    "/a.png 1x",
    false,
  ]);
  assertEquals(nonce("n"), "'nonce-n'");
  const UseCsp = () => (useCSP(() => {}), null);
  assertEquals(UseCsp(), null);
  assertEquals(await renderToString(Head({ children: "t" }) as never), "t");
  assertEquals(await renderToString(preact.h(Partial as never, { name: "p" }, "c")), "c");
  assertEquals(preact.toChildArray([["a", null], "b", false] as never).length, 2);
  assertEquals(typeof preact.options, "object");
  assertEquals(typeof preact.h, "function");
  // A server render never catches: `[undefined, reset]`, and reset is a no-op there.
  const Boundary = () => {
    const [error, reset] = useErrorBoundary();
    reset();
    return String(error) as never;
  };
  assertEquals(await renderToString(preact.h(Boundary as never, null)), "undefined");
  assertEquals(typeof compat.createPortal, "function");
  assertEquals(typeof compat.default.createElement, "function");
});
