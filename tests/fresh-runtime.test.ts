// `denext/fresh/server`: a migrated Fresh app's routes, run through the generated files —
// `main.ts` middleware and code routes, `_middleware` state and response headers, page data
// from `page()`, a POST that re-renders the page, route handlers, `HttpError` → the not-found
// and error pages, `_app` / `_layout` wrapping and their skip configs, a `routeOverride`, and a
// Fresh 1.x app's `(req, ctx)` handlers with `ctx.render(data)`.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient } from "../src/testing/mod.ts";
import { watchTests } from "./helpers/watchdog.ts";

// createTestApp crawls and builds the app in this process: a stalled one fails its test instead of holding the CI job.
watchTests();

const u = (rel: string) => new URL(rel, import.meta.url).href;
const JSX = u("../src/jsx/jsx-runtime.ts");
const FRESH = u("../src/compat/fresh/mod.ts");
const SERVER = u("../src/compat/fresh/server.ts");

async function withApp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_fresh_rt_" });
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

const FRESH2: Record<string, string> = {
  "main.ts": `import { App, staticFiles } from "${FRESH}";
export const app = new App();
app.use(staticFiles());
app.use((ctx) => { ctx.state.shared = "hello"; return ctx.next(); });
app.get("/api2/:name", (ctx) => new Response("code route " + ctx.params.name + " " + ctx.state.shared));
app.fsRoutes();
`,
  "routes/_app.ts": `import { h } from "${JSX}";
export default function App({ Component, state }) {
  return h("html", { lang: "en" }, h("head", null, h("title", null, state.title ?? "app")),
    h("body", null, h("main", { id: "app" }, h(Component, null))));
}`,
  "routes/_middleware.ts": `export async function handler(ctx) {
  ctx.state.title = "From middleware";
  const res = await ctx.next();
  res.headers.set("x-fresh-mw", ctx.url.pathname);
  return res;
}`,
  "routes/_error.ts": `import { h } from "${JSX}";
import { HttpError } from "${FRESH}";
export default function ErrorPage({ error }) {
  const status = error instanceof HttpError ? error.status : 500;
  return h("p", null, "error page " + status);
}`,
  "routes/index.ts": `import { h } from "${JSX}";
import { page } from "${FRESH}";
export const handler = {
  GET(ctx) { return page({ n: 1 + Number(ctx.url.searchParams.get("n") ?? 0) }, { headers: { "x-page": "1" } }); },
  async POST(ctx) {
    const form = await ctx.req.formData();
    return page({ n: "posted " + form.get("v") }, { status: 201 });
  },
};
export default function Home({ data, state }) {
  return h("p", null, "home " + data.n + " " + state.shared + " " + state.title);
}`,
  "routes/api/[name].ts": `import { HttpError } from "${FRESH}";
export const handler = {
  GET(ctx) {
    if (ctx.params.name === "nope") throw new HttpError(404);
    return new Response("Hello " + ctx.params.name + " " + ctx.state.shared);
  },
  POST(ctx) { return Response.json({ posted: ctx.params.name }); },
};`,
  "routes/old.ts":
    `export const handler = { GET(ctx) { return ctx.redirect("//evil.example/x", 307); } };`,
  "routes/missing.ts": `import { h } from "${JSX}";
import { HttpError } from "${FRESH}";
export const handler = { GET() { throw new HttpError(404); } };
export default function Missing() { return h("p", null, "never"); }`,
  "routes/boom.ts": `import { h } from "${JSX}";
export const handler = { GET() { throw new Error("boom"); } };
export default function Boom() { return h("p", null, "never"); }`,
  "routes/raw.ts": `export const config = { routeOverride: "/@:version/:path*" };
export const handler = { GET(ctx) { return new Response("raw " + ctx.params.version + " " + ctx.params.path); } };`,
  "routes/bare.ts": `import { h } from "${JSX}";
export const config = { skipAppWrapper: true, skipInheritedLayouts: true };
export default function Bare() { return h("p", { id: "bare" }, "bare page"); }`,
  "routes/blog/_layout.ts": `import { h } from "${JSX}";
export default function BlogLayout({ Component }) { return h("section", { id: "blog" }, h(Component, null)); }`,
  "routes/blog/[slug].ts": `import { h } from "${JSX}";
export default async function Post(props) {
  await Promise.resolve();
  if (props.params.slug === "home") return new Response(null, { status: 303, headers: { location: "/" } });
  return h("article", null, "post " + props.params.slug);
}`,
  "routes/render.ts": `import { h } from "${JSX}";
export const handler = { GET(ctx) { return ctx.render(h("b", null, "rendered jsx")); } };
export default function Unused() { return null; }`,
  // The generated files.
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as main from "./main.ts";
import * as mw0 from "./routes/_middleware.ts";
import * as blogLayout from "./routes/blog/_layout.ts";
import * as r0 from "./routes/index.ts";
import * as r1 from "./routes/api/[name].ts";
import * as r2 from "./routes/old.ts";
import * as r3 from "./routes/missing.ts";
import * as r4 from "./routes/boom.ts";
import * as r5 from "./routes/raw.ts";
import * as r6 from "./routes/bare.ts";
import * as r7 from "./routes/blog/[slug].ts";
import * as r8 from "./routes/render.ts";
export default freshMiddleware({
  main,
  middlewares: [{ id: "", prefix: "/", mod: mw0 }],
  layouts: [{ id: "blog", mod: blogLayout }],
  routes: [
    { id: "index", pattern: "/", mod: r0, page: true, middlewares: [0], layouts: [] },
    { id: "api/[name]", pattern: "/api/:name", mod: r1, page: false, middlewares: [0], layouts: [] },
    { id: "old", pattern: "/old", mod: r2, page: false, middlewares: [0], layouts: [] },
    { id: "missing", pattern: "/missing", mod: r3, page: true, middlewares: [0], layouts: [] },
    { id: "boom", pattern: "/boom", mod: r4, page: true, middlewares: [0], layouts: [] },
    { id: "raw", pattern: "/@:version/:path*", mod: r5, page: false, middlewares: [0], layouts: [], inMiddleware: true },
    { id: "bare", pattern: "/bare", mod: r6, page: true, middlewares: [0], layouts: [] },
    { id: "blog/[slug]", pattern: "/blog/:slug", mod: r7, page: true, middlewares: [0], layouts: ["blog"] },
    { id: "render", pattern: "/render", mod: r8, page: true, middlewares: [0], layouts: [] },
  ],
});
export const config = { matcher: ["/((?!_denext/).*)"] };
`,
  "app/layout.ts": `import { freshLayout } from "${SERVER}";
import * as mod from "../routes/_app.ts";
export default freshLayout(mod, { id: "_app", app: true });`,
  "app/not-found.ts": `import { freshNotFound } from "${SERVER}";
import * as mod from "../routes/_error.ts";
export default freshNotFound(mod, { id: "_error" });`,
  "app/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../routes/index.ts";
import * as error from "../routes/_error.ts";
export default freshPage(mod, { id: "index", error });`,
  "app/api/[name]/route.ts": `import { freshRouteHandler } from "${SERVER}";
import * as mod from "../../../routes/api/[name].ts";
const handle = freshRouteHandler(mod, { id: "api/[name]" });
export { handle as GET, handle as POST };`,
  "app/old/route.ts": `import { freshRouteHandler } from "${SERVER}";
import * as mod from "../../routes/old.ts";
export const GET = freshRouteHandler(mod, { id: "old" });`,
  "app/missing/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/missing.ts";
import * as error from "../../routes/_error.ts";
export default freshPage(mod, { id: "missing", error });`,
  "app/boom/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/boom.ts";
import * as error from "../../routes/_error.ts";
export default freshPage(mod, { id: "boom", error });`,
  "app/bare/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/bare.ts";
export default freshPage(mod, { id: "bare" });`,
  "app/blog/layout.ts": `import { freshLayout } from "${SERVER}";
import * as mod from "../../routes/blog/_layout.ts";
export default freshLayout(mod, { id: "blog" });`,
  "app/blog/[slug]/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/blog/[slug].ts";
export default freshPage(mod, { id: "blog/[slug]" });`,
  "app/render/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/render.ts";
export default freshPage(mod, { id: "render" });`,
};

Deno.test("Fresh 2: middleware state, page data, layouts, code routes, route handlers", async () => {
  await withApp(FRESH2, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const home = await client.get("/?n=4");
    assertEquals(home.status, 200);
    assertStringIncludes(home.text, "home 5 hello From middleware");
    assertStringIncludes(home.text, "<title>From middleware</title>");
    assertStringIncludes(home.text, '<main id="app">');
    assertEquals(home.headers.get("x-page"), "1");
    assertEquals(home.headers.get("x-fresh-mw"), "/");

    const api = await client.get("/api/fresh");
    assertEquals(api.text, "Hello fresh hello");
    assertEquals(api.headers.get("x-fresh-mw"), "/api/fresh");
    assertEquals((await client.post("/api/x", { json: {} })).text, '{"posted":"x"}');
    assertEquals((await client.get("/api2/code")).text, "code route code hello");
    const raw = await client.get("/@1.2.3/a/b.ts");
    assertEquals(raw.text, "raw 1.2.3 a/b.ts");

    const old = await client.get("/old");
    assertEquals(old.status, 307);
    assertEquals(old.headers.get("location"), "/evil.example/x");

    const blog = await client.get("/blog/hi");
    assertStringIncludes(blog.text, '<section id="blog"><article>post hi</article></section>');
    const toHome = await client.get("/blog/home");
    assertEquals(toHome.status, 303);

    const bare = await client.get("/bare");
    assertStringIncludes(bare.text, '<p id="bare">bare page</p>');
    assertEquals(bare.text.includes('<main id="app">'), false);

    assertStringIncludes((await client.get("/render")).text, "<b>rendered jsx</b>");
  });
});

Deno.test("Fresh 2: a POST re-renders the page; HttpError and errors render the error pages", async () => {
  await withApp(FRESH2, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const posted = await client.post("/", { form: { v: "42" } });
    assertEquals(posted.status, 201);
    assertStringIncludes(posted.text, "home posted 42");

    const missing = await client.get("/missing");
    assertEquals(missing.status, 404);
    assertStringIncludes(missing.text, "error page 404");
    const unknown = await client.get("/no/such/page");
    assertEquals(unknown.status, 404);
    assertStringIncludes(unknown.text, "error page 404");
    const boom = await client.get("/boom");
    assertEquals(boom.status, 500);
    assertStringIncludes(boom.text, "error page 500");
    const apiMissing = await client.get("/api/nope");
    assertEquals(apiMissing.status, 404);
  });
});

const FRESH1: Record<string, string> = {
  "routes/_middleware.ts": `export async function handler(req, ctx) {
  ctx.state.user = req.headers.get("x-user") ?? "anon";
  return await ctx.next();
}`,
  "routes/_404.ts": `import { h } from "${JSX}";
export default function NotFound({ url }) { return h("p", null, "nothing at " + url.pathname); }`,
  "routes/index.ts": `import { h } from "${JSX}";
export const handler = {
  async GET(req, ctx) {
    if (new URL(req.url).searchParams.has("gone")) return ctx.renderNotFound();
    return ctx.render({ greeting: "hi " + ctx.state.user });
  },
};
export default function Home(props) { return h("p", null, props.data.greeting + " on " + props.route); }`,
  "routes/greet/[name].ts": `import { h } from "${JSX}";
import { defineRoute } from "${FRESH}";
export default defineRoute((req, ctx) => h("p", null, "greet " + ctx.params.name + " " + ctx.state.user));`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as mw0 from "./routes/_middleware.ts";
import * as r0 from "./routes/index.ts";
import * as r1 from "./routes/greet/[name].ts";
export default freshMiddleware({
  v1: true,
  middlewares: [{ id: "", prefix: "/", mod: mw0 }],
  layouts: [],
  routes: [
    { id: "index", pattern: "/", mod: r0, page: true, middlewares: [0], layouts: [] },
    { id: "greet/[name]", pattern: "/greet/:name", mod: r1, page: true, middlewares: [0], layouts: [] },
  ],
});`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("div", null, children); }`,
  "app/not-found.ts": `import { freshNotFound } from "${SERVER}";
import * as mod from "../routes/_404.ts";
export default freshNotFound(mod, { id: "_404", v1: true });`,
  "app/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../routes/index.ts";
export default freshPage(mod, { id: "index", v1: true });`,
  "app/greet/[name]/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/greet/[name].ts";
export default freshPage(mod, { id: "greet/[name]", v1: true });`,
};

Deno.test("Fresh 1.x: (req, ctx) handlers, ctx.render(data), defineRoute, _404", async () => {
  await withApp(FRESH1, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const home = await client.get("/", { headers: { "x-user": "ada" } });
    assertStringIncludes(home.text, "hi ada on /");
    assertStringIncludes((await client.get("/greet/bob")).text, "greet bob anon");
    const gone = await client.get("/?gone");
    assertEquals(gone.status, 404);
    assertStringIncludes(gone.text, "nothing at /");
    assertStringIncludes((await client.get("/nope")).text, "nothing at /nope");
  });
});

const NO_MIDDLEWARE: Record<string, string> = {
  "routes/data.ts": `import { h } from "${JSX}";
import { HttpError, page } from "${FRESH}";
export const handler = {
  GET(ctx) {
    const mode = ctx.url.searchParams.get("mode");
    if (mode === "redirect") return ctx.redirect("/elsewhere", 307);
    if (mode === "missing") throw new HttpError(404);
    if (mode === "teapot") throw new HttpError(418);
    if (mode === "plain") return { raw: true };
    return page({ id: ctx.params.id });
  },
};
export default function Data({ data }) {
  return h("p", null, "data " + Object.entries(data).map(([k, v]) => k + "=" + v).join(","));
}`,
  "routes/_error.ts": `import { h } from "${JSX}";
export default function E({ error }) { return h("p", null, "error " + error.status); }`,
  "routes/api.ts": `import { HttpError, page } from "${FRESH}";
export const handler = {
  GET(ctx) { return new Response("api " + ctx.params.id); },
  PUT() { throw new HttpError(409, "conflict"); },
  PATCH() { return page({}); },
};`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("main", null, children); }`,
  "app/not-found.ts": `import { h } from "${JSX}";
export default function NotFound() { return h("p", null, "not found page"); }`,
  "app/d/[id]/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/data.ts";
import * as error from "../../../routes/_error.ts";
export default freshPage(mod, { id: "data", error });`,
  "app/api/[id]/route.ts": `import { freshRouteHandler } from "${SERVER}";
import * as mod from "../../../routes/api.ts";
const h = freshRouteHandler(mod, { id: "api" });
export { h as GET, h as PUT, h as PATCH, h as DELETE };`,
};

Deno.test("without middleware.ts the page and route handler run the handler themselves", async () => {
  await withApp(NO_MIDDLEWARE, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    assertStringIncludes((await client.get("/d/7")).text, "data id=7");
    const redirected = await client.get("/d/7?mode=redirect");
    assertEquals([redirected.status, redirected.location], [307, "/elsewhere"]);
    const missing = await client.get("/d/7?mode=missing");
    assertEquals(missing.status, 404);
    assertStringIncludes(missing.text, "not found page");
    const teapot = await client.get("/d/7?mode=teapot");
    assertEquals(teapot.status, 418);
    assertStringIncludes(teapot.text, "error 418");
    assertStringIncludes((await client.get("/d/7?mode=plain")).text, "data raw=true");
    assertEquals((await client.get("/api/3")).text, "api 3");
    const conflict = await client.request("/api/3", { method: "PUT" });
    assertEquals([conflict.status, conflict.text], [409, "conflict"]);
    assertEquals((await client.request("/api/3", { method: "DELETE" })).status, 405);
    assertEquals((await client.request("/api/3", { method: "PATCH" })).status, 500);
  });
});
