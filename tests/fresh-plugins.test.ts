// Fresh 1.x plugins on denext (`fresh.config.ts`'s `plugins`), checked against Fresh 1.7's own
// handling (src/server/fs_extract.ts: a plugin route is `./routes<path>.ts`, a plugin middleware
// `./routes<path>/_middleware.ts`, sorted with the file routes; src/server/render.ts: `render` /
// `renderAsync` wrap the page render, and their `styles` / `links` / `scripts` go into the page):
// routes answer, middleware runs under its path, the render hooks see the page's HTML and add
// to its head, and `freshPlugins()` bundles the plugins' client entrypoints.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient } from "../src/testing/mod.ts";
import {
  isSpecialPluginRoute,
  pluginMiddlewarePrefix,
  pluginRoutePattern,
} from "../src/compat/fresh/plugins.ts";
import { bundlePluginEntrypoints, entrypointRunner } from "../src/compat/fresh/plugin-build.ts";

const u = (rel: string) => new URL(rel, import.meta.url).href;
const JSX = u("../src/jsx/jsx-runtime.ts");
const SERVER = u("../src/compat/fresh/server.ts");

async function withApp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_fresh_plugins_" });
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

Deno.test("plugin paths: Fresh's routes/<path> mapping", () => {
  assertEquals(pluginRoutePattern("/oauth/signin"), "/oauth/signin");
  assertEquals(pluginRoutePattern("blog/[slug]"), "/blog/:slug");
  assertEquals(pluginRoutePattern("/docs/[...rest]"), "/docs/:rest*");
  assertEquals(pluginRoutePattern("/admin/index"), "/admin");
  assertEquals(pluginRoutePattern("/(group)/x"), "/x");
  assertEquals([isSpecialPluginRoute("_app"), isSpecialPluginRoute("/a/_middleware")], [
    true,
    true,
  ]);
  assertEquals(isSpecialPluginRoute("/oauth/signin"), false);
  assertEquals([pluginMiddlewarePrefix("/"), pluginMiddlewarePrefix("admin/")], ["/", "/admin"]);
});

/** A Fresh 1.x app with one local plugin: routes, middleware, an async and a sync render hook. */
const APP: Record<string, string> = {
  "plugins/demo.ts": `import { h } from "${JSX}";
let renders = 0;
export function demoPlugin() {
  return {
    name: "demo",
    entrypoints: { main: "./demo-client.ts" },
    routes: [
      { path: "/plugin/hello", component: ({ data }) => h("p", null, "plugin page " + data), handler: { GET: (_req, ctx) => ctx.render("ok") } },
      { path: "/plugin/api", handler: () => new Response("plugin api") },
      { path: "_app", component: () => null },
    ],
    middlewares: [
      { path: "/", middleware: { handler: async (_req, ctx) => { ctx.state.mw = "root"; const res = await ctx.next(); res.headers.set("x-plugin", "on"); return res; } } },
      { path: "admin", middleware: { handler: (_req, ctx) => new Response("admin blocked " + ctx.state.mw, { status: 403 }) } },
    ],
    async renderAsync(ctx) {
      const before = ++renders;
      const { htmlText } = await ctx.renderAsync();
      return {
        styles: [{ cssText: ".demo{color:red}", id: "demo-style" }],
        links: [{ rel: "preconnect", href: "https://cdn.example" }],
        scripts: [{ entrypoint: "main", state: { saw: htmlText.includes("home page"), before } }],
      };
    },
  };
}
export function syncPlugin() {
  return { name: "sync", render(ctx) { const { htmlText } = ctx.render(); return { styles: [{ cssText: "/* " + htmlText.length + " */" }] }; } };
}
`,
  "plugins/demo-client.ts":
    `export default function run(state) { globalThis.demoState = state; }\n`,
  "fresh.config.ts": `import { demoPlugin, syncPlugin } from "./plugins/demo.ts";
export default { plugins: [demoPlugin(), syncPlugin()] };
`,
  "routes/index.ts": `import { h } from "${JSX}";
export default function Home({ state }) { return h("p", null, "home page " + state.mw); }`,
  "routes/admin/x.ts": `import { h } from "${JSX}";
export default function X() { return h("p", null, "admin"); }`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as freshConfig from "./fresh.config.ts";
import * as r0 from "./routes/admin/x.ts";
import * as r1 from "./routes/index.ts";
export default freshMiddleware({
  v1: true,
  plugins: freshConfig.default?.plugins,
  appRoute: "/fresh-app-route",
  middlewares: [],
  layouts: [],
  routes: [
    { id: "admin/x", pattern: "/admin/x", mod: r0, page: true, middlewares: [], layouts: [] },
    { id: "index", pattern: "/", mod: r1, page: true, middlewares: [], layouts: [] },
  ],
});
export const config = { matcher: ["/((?!_denext/).*)"] };`,
  "app/layout.ts": `import { h } from "${JSX}";
import { freshLayout } from "${SERVER}";
import * as freshConfig from "../fresh.config.ts";
const App = freshLayout({ default: ({ Component }) => h("html", null, h("head", null), h("body", null, h(Component, null))) }, { id: "_app", app: true, v1: true, plugins: freshConfig.default?.plugins });
export default App;`,
  "app/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../routes/index.ts";
export default freshPage(mod, { id: "index", v1: true });`,
  "app/admin/x/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../../routes/admin/x.ts";
export default freshPage(mod, { id: "admin/x", v1: true });`,
  "app/fresh-app-route/page.ts": `import { freshAppPage } from "${SERVER}";
export default freshAppPage({ v1: true });`,
};

Deno.test("Fresh plugins: routes, middleware under its path, and render hooks around the page render", async () => {
  await withApp(APP, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const home = await client.get("/");
    assertEquals(home.status, 200, home.text.slice(0, 3000));
    assertStringIncludes(home.text, "home page root", "the plugin middleware set ctx.state");
    assertEquals(home.headers.get("x-plugin"), "on", "and changed the response");
    // The async hook: its styles and links in the head, its script state from the page's HTML.
    const head = home.text.slice(0, home.text.indexOf("</head>"));
    assertStringIncludes(head, `<style id="demo-style">.demo{color:red}</style>`);
    assertStringIncludes(head, `<link rel="preconnect" href="https://cdn.example"`);
    assertStringIncludes(home.text, `data-fresh-plugin-state="demo:main"`);
    assertStringIncludes(home.text, `{"saw":true,"before":1}`);
    assertStringIncludes(home.text, `<script type="module" src="/_fresh-plugins/demo-main.js">`);
    // The sync hook saw the rendered HTML too.
    assert(/<style>\/\* [1-9]\d* \*\/<\/style>/.test(head), head);

    const page = await client.get("/plugin/hello");
    assertEquals(page.status, 200);
    assertStringIncludes(page.text, "plugin page ok");
    assertEquals((await client.get("/plugin/api")).text, "plugin api");
    // The admin middleware covers /admin and below only, inside the root one.
    const admin = await client.get("/admin/x");
    assertEquals([admin.status, admin.text], [403, "admin blocked root"]);
  });
});

Deno.test("freshPlugins: each plugin entrypoint is bundled into public/_fresh-plugins/", async () => {
  await withApp({
    "plugins/client.ts":
      `import { tag } from "./util.ts";\nexport default function (s) { globalThis.out = tag + s.n; }\n`,
    "plugins/util.ts": `export const tag = "t";\n`,
    "fresh.config.ts":
      `export default { plugins: [{ name: "p", entrypoints: { main: "./plugins/client.ts" } }, { name: "none" }] };\n`,
  }, async (dir) => {
    const files = await bundlePluginEntrypoints(dir, join(dir, "fresh.config.ts"));
    assertEquals(files, [join(dir, "public", "_fresh-plugins", "p-main.js")]);
    const js = await Deno.readTextFile(files[0]);
    assertStringIncludes(js, `"t"`, "the entrypoint's imports are bundled in");
    assertStringIncludes(js, "data-fresh-plugin-state");
  });
  assertStringIncludes(entrypointRunner("./x.ts", "a", "b"), `JSON.stringify("a:b")`);
});
