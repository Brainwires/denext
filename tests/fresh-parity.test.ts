// Fresh parity for a migrated app: `<Partial>` regions updated in place (replace / append /
// prepend) and the partial request's server side (`ctx.isPartial`, a redirect keeping
// `fresh-partial`); `main.ts`'s app builder run as Fresh runs it (`appWrapper`, `layout`,
// `route`, `onError`, `notFound`, `mountApp`, path-scoped `use`, a handler's `ctx.render()`);
// `csp()` merged into denext's policy; `import.meta.env` from `denext/fresh/env`, which never
// holds a server-only variable.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { applyPartialTree, Partial } from "../src/compat/fresh/partial.ts";
import { csp, mergeCsp } from "../src/compat/fresh/middlewares.ts";
import { underPattern } from "../src/compat/fresh/app.ts";
import { createFreshRequest } from "../src/compat/fresh/context.ts";
import { env } from "../src/compat/fresh/env.ts";
import { rewriteEnvReads } from "../packages/migrate/src/migrate-fresh.ts";

const u = (rel: string) => new URL(rel, import.meta.url).href;
const JSX = u("../src/jsx/jsx-runtime.ts");
const FRESH = u("../src/compat/fresh/mod.ts");
const SERVER = u("../src/compat/fresh/server.ts");
const PARTIAL = u("../src/compat/fresh/partial.ts");
const RUNTIME = u("../src/compat/fresh/runtime.ts");
const ENV = u("../src/compat/fresh/env.ts");

async function withApp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_fresh_parity_" });
  try {
    for (const [rel, src] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, src);
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ── Partials ─────────────────────────────────────────────────────────────────

const li = (text: string) => h("li", null, text);

Deno.test("Partial: an update replaces, appends or prepends by its mode; others are untouched", async () => {
  const screen = await render(
    h("div", null, [
      h("ul", { id: "list", key: "l" }, h(Partial, { name: "list" }, li("one"))),
      h("p", { id: "side", key: "s" }, h(Partial, { name: "side" }, "side")),
      h("p", { id: "keep", key: "k" }, "outside"),
    ]),
  );
  const text = () => screen.container.textContent;
  assertEquals(text(), "onesideoutside");

  const append = h(Partial, { name: "list", mode: "append", key: "p2" }, li("two"));
  await screen.act(() => void applyPartialTree(h("main", null, append)));
  assertEquals(text(), "onetwosideoutside");
  const prepend = h(Partial, { name: "list", mode: "prepend" }, li("zero"));
  await screen.act(() => void applyPartialTree([prepend]));
  assertEquals(text(), "zeroonetwosideoutside");

  // A replace swaps the whole region; a region the answer leaves out keeps its content.
  const replace = h(Partial, { name: "side" }, "new side");
  await screen.act(() => void applyPartialTree(h("div", null, [replace])));
  assertEquals(text(), "zeroonetwonew sideoutside");
  await screen.act(() => void applyPartialTree(h(Partial, { name: "list" }, li("only"))));
  assertEquals(text(), "onlynew sideoutside");
  assertEquals(screen.html().match(/<li>/g)?.length, 1);
});

Deno.test("Partial: a nested partial travels with its outer one; an unknown one is skipped", async () => {
  const screen = await render(h("section", null, h(Partial, { name: "outer" }, "start")));
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => void warned.push(args[0]);
  try {
    let n = 0;
    const tree = h("div", null, [
      h(Partial, { name: "outer", key: "o" }, ["a", h(Partial, { name: "inner" }, "b")]),
      h(Partial, { name: "missing", key: "m" }, "x"),
    ]);
    await screen.act(() => void (n = applyPartialTree(tree)));
    assertEquals(n, 2, "two outermost partials; the nested one is not counted");
    assertEquals(screen.container.textContent, "ab");
    assertStringIncludes(String(warned[0]), `partial "missing" is not on this page`);
    assertEquals(applyPartialTree(h("div", null, "no partials")), 0);
  } finally {
    console.warn = warn;
  }
});

Deno.test("Partial: a page re-render with new children resets the region to them", async () => {
  const page = (body: string) => h("div", null, h(Partial, { name: "p" }, body));
  const screen = await render(page("first"));
  await screen.act(() =>
    void applyPartialTree(h(Partial, { name: "p", mode: "append", key: "a" }, "+more"))
  );
  assertEquals(screen.container.textContent, "first+more");
  await screen.rerender(page("second"));
  assertEquals(screen.container.textContent, "second");
});

Deno.test("ctx.isPartial reads fresh-partial; a partial request's redirect keeps it", () => {
  const full = createFreshRequest(new Request("http://x/recipes/a"), false).ctx;
  assertEquals(full.isPartial, false);
  assertEquals(full.redirect("/b").headers.get("location"), "/b");
  const partial = createFreshRequest(new Request("http://x/a?fresh-partial=true"), false).ctx;
  assertEquals(partial.isPartial, true);
  assertEquals(partial.redirect("/b").headers.get("location"), "/b?fresh-partial=true");
  assertEquals(
    partial.redirect("/b?x=1#top", 303).headers.get("location"),
    "/b?x=1&fresh-partial=true#top",
  );
});

// ── Path patterns ────────────────────────────────────────────────────────────

Deno.test("underPattern: Fresh's use() / layout() / onError() path scopes", () => {
  for (const all of ["*", "/", "/*", ""]) assert(underPattern("/any/path", all), all);
  assert(underPattern("/admin", "/admin/*"));
  assert(underPattern("/admin/x/y", "/admin/*"));
  assert(underPattern("/admin/x", "/admin"));
  assert(!underPattern("/administrator", "/admin/*"));
  assert(underPattern("/blog/7/edit", "/blog/:id/*"));
  assert(!underPattern("/news/7", "/blog/:id/*"));
});

// ── main.ts ──────────────────────────────────────────────────────────────────

const HOOKS: Record<string, string> = {
  "main.ts": `import { App, HttpError, page } from "${FRESH}";
import { h } from "${JSX}";
const sub = new App().get("/ping", (ctx) => new Response("pong " + ctx.url.pathname));
export const app = new App()
  .use("/api/*", (ctx) => { ctx.state.api = "yes"; return ctx.next(); })
  .use("/other/*", () => new Response("other middleware"))
  .appWrapper(({ Component }) => h("html", null, h("body", null, h("div", { id: "wrap" }, h(Component, null)))))
  .layout("*", ({ Component }) => h("section", { id: "outer" }, h(Component, null)))
  .layout("/admin/*", ({ Component }) => h("aside", { id: "admin" }, h(Component, null)))
  .layout("/landing", ({ Component }) => h("article", { id: "landing" }, h(Component, null)), { skipInheritedLayouts: true })
  .get("/hello", (ctx) => ctx.render(h("h1", null, "hello " + ctx.url.pathname)))
  .get("/admin/dash", (ctx) => ctx.render(h("h1", null, "dash")))
  .get("/landing", (ctx) => ctx.render(h("h1", null, "landing")))
  .get("/api/state", (ctx) => new Response("api " + ctx.state.api))
  .get("/other/x", () => new Response("never"))
  .route("/code/:id", {
    handler: (ctx) => page({ id: ctx.params.id }),
    component: ({ data }) => h("p", null, "code page " + data.id),
  })
  .get("/throw", () => { throw new Error("boom"); })
  .get("/cmp/throw", () => { throw new HttpError(418); })
  .onError("*", (ctx) => new Response("oops " + ctx.error.message, { status: 500 }))
  .onError("/cmp/*", { component: ({ error }) => h("p", null, "error page " + error.status) })
  .notFound((ctx) => new Response("nothing at " + ctx.url.pathname, { status: 404 }))
  .mountApp("/sub", sub)
  .fsRoutes();
`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as main from "./main.ts";
export default freshMiddleware({ main, appRoute: "/fresh-app-route", middlewares: [], layouts: [], routes: [] });
export const config = { matcher: ["/((?!_denext/).*)"] };
`,
  "app/layout.ts": `import { freshLayout } from "${SERVER}";
import * as main from "../main.ts";
export default freshLayout({}, { id: "_app", app: true, main });`,
  "app/fresh-app-route/page.ts": `import { freshAppPage } from "${SERVER}";
export default freshAppPage();`,
  "app/not-found.ts": `import { freshNotFound } from "${SERVER}";
import * as main from "../main.ts";
export default freshNotFound(undefined, { id: "_404", main });`,
};

Deno.test("main.ts: app wrapper, code layouts, ctx.render() and app.route() pages", async () => {
  await withApp(HOOKS, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const hello = await client.get("/hello");
    assertEquals(hello.status, 200);
    assertStringIncludes(
      hello.text,
      '<div id="wrap"><section id="outer"><h1>hello /hello</h1></section></div>',
    );
    assertStringIncludes(
      (await client.get("/admin/dash")).text,
      '<section id="outer"><aside id="admin"><h1>dash</h1></aside></section>',
    );
    const landing = (await client.get("/landing")).text;
    assertStringIncludes(landing, '<div id="wrap"><article id="landing"><h1>landing</h1>');
    assertEquals(landing.includes('id="outer"'), false, "skipInheritedLayouts drops the outer");
    assertStringIncludes((await client.get("/code/7")).text, "<p>code page 7</p>");
    // The page code routes render at is not reachable by itself.
    assertEquals((await client.get("/fresh-app-route")).status, 404);
  });
});

Deno.test("main.ts: path-scoped use(), mountApp(), onError() and notFound()", async () => {
  await withApp(HOOKS, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    assertEquals((await client.get("/api/state")).text, "api yes");
    assertEquals((await client.get("/other/x")).text, "other middleware");
    assertEquals((await client.get("/sub/ping")).text, "pong /sub/ping");

    const thrown = await client.get("/throw");
    assertEquals([thrown.status, thrown.text], [500, "oops boom"]);
    const cmp = await client.get("/cmp/throw");
    assertEquals(cmp.status, 418);
    assertStringIncludes(cmp.text, '<div id="wrap"><section id="outer"><p>error page 418</p>');

    const missing = await client.get("/no/such/page");
    assertEquals(missing.status, 404);
    assertStringIncludes(missing.text, "nothing at /no/such/page");
  });
});

// ── Partial requests on the server ──────────────────────────────────────────

const PARTIALS: Record<string, string> = {
  "routes/recipe.ts": `import { h } from "${JSX}";
import { page } from "${FRESH}";
import { Partial } from "../app/_fresh/runtime.ts";
export const config = { skipAppWrapper: true };
export const handler = {
  GET(ctx) { return ctx.isPartial ? page() : ctx.redirect("/#partials"); },
};
export default function Recipe() { return h(Partial, { name: "recipe" }, h("h2", null, "Lemonade")); }`,
  "routes/go.ts": `export const handler = { GET(ctx) { return ctx.redirect("/recipe"); } };`,
  "app/_fresh/runtime.ts": `export * from "${RUNTIME}";
export { Partial } from "./partial.ts";`,
  "app/_fresh/partial.ts": `"use client";
export { Partial } from "${PARTIAL}";`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as r0 from "./routes/recipe.ts";
import * as r1 from "./routes/go.ts";
export default freshMiddleware({
  middlewares: [],
  layouts: [],
  routes: [
    { id: "recipe", pattern: "/recipe", mod: r0, page: true, middlewares: [], layouts: [] },
    { id: "go", pattern: "/go", mod: r1, page: false, middlewares: [], layouts: [] },
  ],
});
export const config = { matcher: ["/((?!_denext/).*)"] };`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("html", null, h("body", null, children)); }`,
  "app/recipe/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/recipe.ts";
export default freshPage(mod, { id: "recipe" });`,
  "app/go/route.ts": `import { freshRouteHandler } from "${SERVER}";
import * as mod from "../../routes/go.ts";
export const GET = freshRouteHandler(mod, { id: "go" });`,
};

Deno.test("partial requests: ctx.isPartial, the redirect keeps fresh-partial, the Flight payload", async () => {
  await withApp(PARTIALS, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const full = await client.get("/recipe");
    assertEquals([full.status, full.location], [302, "/#partials"]);
    const partial = await client.get("/recipe?fresh-partial=true");
    assertEquals(partial.status, 200);
    assertStringIncludes(partial.text, "<h2>Lemonade</h2>");
    const go = await client.get("/go?fresh-partial=true");
    assertEquals(go.location, "/recipe?fresh-partial=true");

    // What partial navigation fetches: the page's Flight payload, the region a client component.
    const nav = await client.get("/recipe?fresh-partial=true", {
      headers: { "x-denext-nav": "1" },
    });
    assertEquals(nav.headers.get("x-denext-flight"), "1");
    const payload = JSON.stringify(JSON.parse(nav.text).flight);
    assertStringIncludes(payload, "#Partial", "the region is a client reference");
    assertStringIncludes(payload, '"recipe"');
    assertStringIncludes(payload, "Lemonade");
  });
});

// ── csp() ────────────────────────────────────────────────────────────────────

const DENEXT_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-abc'; " +
  "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; " +
  "form-action 'self'";

/** A policy's directives by name. */
const directives = (policy: string) =>
  Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d]));

Deno.test("mergeCsp: Fresh's directives join denext's policy; its own scripts keep working", () => {
  const merged = directives(mergeCsp(DENEXT_POLICY, {
    csp: ["img-src 'self' https://img.example", "connect-src 'none'"],
    reportTo: "/csp",
  }));
  assertEquals(merged["script-src"], "script-src 'self'", "no 'unsafe-inline' from the defaults");
  assertEquals(merged["style-src"], "style-src 'self' 'sha256-abc'");
  assertEquals(merged["img-src"], "img-src 'self' data: https://img.example");
  assertEquals(merged["connect-src"], "connect-src 'none'", "'none' replaces");
  assertEquals(merged["frame-ancestors"], "frame-ancestors 'none'", "Fresh's default replaces");
  assertEquals(merged["media-src"], "media-src 'self' data: blob:");
  assertEquals(merged["upgrade-insecure-requests"], "upgrade-insecure-requests");
  assertEquals(merged["report-uri"], "report-uri /csp");
  assertEquals(merged["report-to"], "report-to csp-endpoint");

  // An explicit 'unsafe-inline' is kept, and drops the hashes that would switch it off.
  const inline = directives(mergeCsp(DENEXT_POLICY, { csp: ["style-src 'self' 'unsafe-inline'"] }));
  assertEquals(inline["style-src"], "style-src 'self' 'unsafe-inline'");
  const nonce = directives(mergeCsp(DENEXT_POLICY, {
    csp: ["script-src 'self' 'unsafe-inline' https://cdn.example"],
    useNonce: true,
  }));
  assertEquals(nonce["script-src"], "script-src 'self' https://cdn.example");

  // No denext policy (csp: "off", or a handler's own response): Fresh's policy as Fresh sends it.
  const own = directives(mergeCsp(undefined));
  assertEquals(own["script-src"], "script-src 'self' 'unsafe-inline'");
  assertEquals(
    directives(mergeCsp(undefined, { useNonce: true }))["script-src"],
    "script-src 'self'",
  );
});

Deno.test("csp(): the caller's directive array is never changed; the header stays one size", async () => {
  const own = ["img-src 'self' https://img.example"];
  const mw = csp({ csp: own, reportTo: "/csp" });
  const headers: string[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await mw({ next: () => Promise.resolve(new Response("x")) } as never);
    headers.push(res.headers.get("content-security-policy") ?? "");
  }
  assertEquals(own, ["img-src 'self' https://img.example"], "the caller's array is untouched");
  assertEquals(new Set(headers).size, 1, "every response gets the same policy");
  assertEquals(headers[0].split("report-uri").length, 2, "one report-uri");
  // mergeCsp on its own doesn't grow the array either.
  mergeCsp(undefined, { csp: own, reportTo: "/csp" });
  mergeCsp(DENEXT_POLICY, { csp: own, reportTo: "/csp" });
  assertEquals(own.length, 1);
});

const CSP_APP: Record<string, string> = {
  "main.ts": `import { App, csp } from "${FRESH}";
export const app = new App()
  .use("/strict/*", csp({ csp: ["img-src 'self' https://img.example"], reportTo: "/csp-report" }))
  .use("/ro/*", csp({ reportOnly: true }))
  .get("/strict/api", () => new Response("api"));
`,
  "routes/page.ts": `import { h } from "${JSX}";
export default function P() { return h("p", null, "page"); }`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as main from "./main.ts";
import * as r0 from "./routes/page.ts";
export default freshMiddleware({
  main,
  middlewares: [],
  layouts: [],
  routes: [
    { id: "strict/page", pattern: "/strict/page", mod: r0, page: true, middlewares: [], layouts: [] },
    { id: "ro/page", pattern: "/ro/page", mod: r0, page: true, middlewares: [], layouts: [] },
  ],
});
export const config = { matcher: ["/((?!_denext/).*)"] };`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("html", null, h("body", null, children)); }`,
  "app/strict/page/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/page.ts";
export default freshPage(mod, { id: "strict/page" });`,
  "app/ro/page/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/page.ts";
export default freshPage(mod, { id: "ro/page" });`,
};

Deno.test("csp(): a page's denext policy carries the directives; a handler's response gets Fresh's", async () => {
  await withApp(CSP_APP, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const page = await client.get("/strict/page");
    assertStringIncludes(page.text, "<p>page</p>");
    const policy = directives(page.headers.get("content-security-policy") ?? "");
    assertEquals(policy["script-src"], "script-src 'self'");
    assertEquals(policy["img-src"], "img-src 'self' data: https://img.example");
    assertEquals(policy["frame-ancestors"], "frame-ancestors 'none'");
    assertEquals(policy["report-uri"], "report-uri /csp-report");
    assertEquals(page.headers.get("reporting-endpoints"), `csp-endpoint="/csp-report"`);

    const api = await client.get("/strict/api");
    assertStringIncludes(
      api.headers.get("content-security-policy") ?? "",
      "script-src 'self' 'unsafe-inline'",
    );

    const ro = await client.get("/ro/page");
    const enforced = directives(ro.headers.get("content-security-policy") ?? "");
    assertEquals(enforced["script-src"], "script-src 'self'", "denext's own policy stays enforced");
    assertEquals(
      enforced["frame-ancestors"],
      "frame-ancestors 'self'",
      "denext's own, not Fresh's 'none': Fresh's directives are only reported",
    );
    assertStringIncludes(
      ro.headers.get("content-security-policy-report-only") ?? "",
      "frame-ancestors 'none'",
    );
  });
});

// ── import.meta.env ──────────────────────────────────────────────────────────

Deno.test("rewriteEnvReads: import.meta.env and FRESH_PUBLIC_ reads point at denext/fresh/env", () => {
  const island = `"use client";
import { useState } from "preact/hooks";
export default function I() {
  return [import.meta.env.MODE, (import.meta as any).env.PROD, Deno.env.get("FRESH_PUBLIC_A"),
    process.env.FRESH_PUBLIC_B, Deno.env.get("SECRET")];
}
`;
  assertEquals(
    rewriteEnvReads(island),
    `"use client";
import { env as importMetaEnv } from "denext/fresh/env";
import { useState } from "preact/hooks";
export default function I() {
  return [importMetaEnv.MODE, importMetaEnv.PROD, importMetaEnv.FRESH_PUBLIC_A,
    importMetaEnv.FRESH_PUBLIC_B, Deno.env.get("SECRET")];
}
`,
  );
  assertEquals(rewriteEnvReads(`// a comment\nconst x = 1;\n`), null);
  assertEquals(
    rewriteEnvReads(`// header\nexport const m = import.meta.env.DEV;\n`),
    `// header\nimport { env as importMetaEnv } from "denext/fresh/env";\nexport const m = importMetaEnv.DEV;\n`,
  );
});

Deno.test("denext/fresh/env: mode flags and public variables only, never a server secret", () => {
  Deno.env.set("FRESH_PUBLIC_PARITY_GREETING", "hi");
  Deno.env.set("PARITY_SECRET_TOKEN", "s3cr3t-parity");
  try {
    assertEquals(env.FRESH_PUBLIC_PARITY_GREETING, "hi");
    assertEquals(env.PARITY_SECRET_TOKEN, undefined);
    assertEquals([env.MODE, env.DEV, env.PROD, env.SSR, env.BASE_URL], [
      "production",
      false,
      true,
      true,
      "/",
    ]);
    const all = JSON.stringify({ ...env });
    assertStringIncludes(all, `"FRESH_PUBLIC_PARITY_GREETING":"hi"`);
    assertEquals(all.includes("s3cr3t-parity"), false);
    assert("MODE" in env && !("PARITY_SECRET_TOKEN" in env));
  } finally {
    Deno.env.delete("FRESH_PUBLIC_PARITY_GREETING");
    Deno.env.delete("PARITY_SECRET_TOKEN");
  }
});

const ENV_APP: Record<string, string> = {
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("html", null, h("body", null, children)); }`,
  "app/page.ts": `import { h } from "${JSX}";
import { env as importMetaEnv } from "${ENV}";
export default function P() {
  return h("pre", null, JSON.stringify(importMetaEnv) + " " + importMetaEnv.PARITY_SECRET_TOKEN);
}`,
};

Deno.test("denext/fresh/env: a page renders the public variables, the island ships no secret", async () => {
  Deno.env.set("FRESH_PUBLIC_PARITY_GREETING", "hello");
  Deno.env.set("PARITY_SECRET_TOKEN", "s3cr3t-parity");
  try {
    await withApp(ENV_APP, async (dir) => {
      const client = createTestClient(await createTestApp(dir));
      const res = await client.get("/");
      assertStringIncludes(res.text, "&quot;FRESH_PUBLIC_PARITY_GREETING&quot;:&quot;hello&quot;");
      assertStringIncludes(res.text, " undefined</pre>");
      assertEquals(res.text.includes("s3cr3t-parity"), false, "the secret never reaches the page");
      // The browser's copy comes from the page's public-env island: public names only.
      const island = /id="__denext_public_env"[^>]*>([^<]*)</.exec(res.text)?.[1] ?? "{}";
      assertEquals(JSON.parse(island).FRESH_PUBLIC_PARITY_GREETING, "hello");
      assertEquals(island.includes("PARITY_SECRET_TOKEN"), false);
    });
  } finally {
    Deno.env.delete("FRESH_PUBLIC_PARITY_GREETING");
    Deno.env.delete("PARITY_SECRET_TOKEN");
  }
});
