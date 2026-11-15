// The Fresh runtime on denext where it used to differ from Fresh: `new App({ basePath })` applied
// at run time (packages/fresh/src/app_test.tsx "… with basePath": every route mounted under it, a
// path outside it a 404, `ctx.url` the full URL), `csp({ useNonce: true })` (middlewares/csp.ts: a
// per-request nonce in `script-src` / `style-src`, and runtime/server/preact_hooks.ts: each
// `<script>` / `<style>` vnode without a nonce gets it), and a Vite app's `import.meta.env.PROD`
// build-output path pick, which `denext migrate` reduces to the source location denext runs from.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient } from "../src/testing/mod.ts";
import { rewriteEnvReads, rewriteModePathPicks } from "../src/build/migrate-fresh.ts";
import { belowBasePath } from "../src/compat/fresh/server.ts";

const u = (rel: string) => new URL(rel, import.meta.url).href;
const JSX = u("../src/jsx/jsx-runtime.ts");
const PREACT = u("../src/compat/preact/mod.ts");
const FRESH = u("../src/compat/fresh/mod.ts");
const SERVER = u("../src/compat/fresh/server.ts");

async function withApp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_fresh_superset_rt_" });
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

Deno.test("belowBasePath: Fresh's mergePath semantics", () => {
  assertEquals(belowBasePath("/foo/bar", "/foo/bar"), "/");
  assertEquals(belowBasePath("/foo/bar/", "/foo/bar"), "/");
  assertEquals(belowBasePath("/foo/bar/foo", "/foo/bar"), "/foo");
  assertEquals(belowBasePath("/foo", "/foo/bar"), null);
  assertEquals(belowBasePath("/foo/barbaz", "/foo/bar"), null);
  assertEquals(belowBasePath("/", "/foo/bar"), null);
});

/** A migrated app's files for routes at `/` and `/docs`, with `main.ts` setting a basePath. */
const BASE_APP: Record<string, string> = {
  "main.ts": `import { App } from "${FRESH}";
export const app = new App({ basePath: "/foo/bar" })
  .use((ctx) => { ctx.state.seen = ctx.url.pathname + " " + ctx.config.basePath; return ctx.next(); })
  .get("/api", (ctx) => new Response("api " + ctx.state.seen));
`,
  "routes/index.ts": `import { h } from "${JSX}";
export default function Home({ state }) { return h("p", null, "home " + state.seen); }`,
  "routes/docs.ts": `import { h } from "${JSX}";
export default function Docs() { return h("p", null, "docs"); }`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as main from "./main.ts";
import * as r0 from "./routes/docs.ts";
import * as r1 from "./routes/index.ts";
export default freshMiddleware({
  main,
  middlewares: [],
  layouts: [],
  routes: [
    { id: "docs", pattern: "/docs", mod: r0, page: true, middlewares: [], layouts: [] },
    { id: "index", pattern: "/", mod: r1, page: true, middlewares: [], layouts: [] },
  ],
});
export const config = { matcher: ["/((?!_denext/).*)"] };`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("html", null, h("body", null, children)); }`,
  "app/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../routes/index.ts";
export default freshPage(mod, { id: "index" });`,
  "app/docs/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../../routes/docs.ts";
export default freshPage(mod, { id: "docs" });`,
  "app/not-found.ts": `import { h } from "${JSX}";
export default function NotFound() { return h("p", null, "not found"); }`,
};

Deno.test("new App({ basePath }): routes are mounted under it; a path outside it is a 404", async () => {
  await withApp(BASE_APP, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const home = await client.get("/foo/bar");
    assertEquals(home.status, 200);
    assertStringIncludes(home.text, "home /foo/bar /foo/bar", "ctx.url is the full URL");
    const docs = await client.get("/foo/bar/docs?x=1");
    assertEquals(docs.status, 200);
    assertStringIncludes(docs.text, "<p>docs</p>");
    const api = await client.get("/foo/bar/api");
    assertEquals(api.text, "api /foo/bar/api /foo/bar");
    for (const outside of ["/", "/docs", "/foo", "/api"]) {
      const res = await client.get(outside);
      assertEquals(res.status, 404, outside);
      assertStringIncludes(res.text, "not found");
    }
  });
});

/** A page whose component renders an inline script and style through Preact's `h`. */
const NONCE_APP: Record<string, string> = {
  "main.ts": `import { App, csp } from "${FRESH}";
export const app = new App().use(csp({ useNonce: true }));
`,
  "routes/index.ts": `import { h } from "${PREACT}";
export default function Home() {
  return h("div", null, h("style", null, ".x{color:red}"), h("script", null, "window.ok = 1"),
    h("script", { nonce: "mine" }, "window.own = 1"), h("p", null, "page"));
}`,
  "middleware.ts": `import { freshMiddleware } from "${SERVER}";
import * as main from "./main.ts";
import * as r0 from "./routes/index.ts";
export default freshMiddleware({
  main,
  middlewares: [],
  layouts: [],
  routes: [{ id: "index", pattern: "/", mod: r0, page: true, middlewares: [], layouts: [] }],
});
export const config = { matcher: ["/((?!_denext/).*)"] };`,
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("html", null, h("body", null, children)); }`,
  "app/page.ts": `import { freshPage } from "${SERVER}";
import * as mod from "../routes/index.ts";
export default freshPage(mod, { id: "index" });`,
};

Deno.test("csp({ useNonce: true }): a per-request nonce in the policy and on the page's inline script and style", async () => {
  await withApp(NONCE_APP, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await client.get("/");
      const policy = res.headers.get("content-security-policy") ?? "";
      const nonce = /script-src [^;]*'nonce-([0-9a-f]{32})'/.exec(policy)?.[1];
      assert(nonce, policy);
      assertStringIncludes(
        policy.split("; ").find((d) => d.startsWith("style-src "))!,
        `'nonce-${nonce}'`,
      );
      assert(!/script-src [^;]*'unsafe-inline'/.test(policy), "no 'unsafe-inline'");
      assertStringIncludes(res.text, `<script nonce="${nonce}">window.ok = 1</script>`);
      assertStringIncludes(res.text, `<style nonce="${nonce}">`);
      assertStringIncludes(res.text, `<script nonce="mine">`, "an explicit nonce is kept");
      nonces.push(nonce);
    }
    assertNotEquals(nonces[0], nonces[1], "one nonce per request");
  });
});

Deno.test("rewriteModePathPicks: a PROD / DEV pick between module-relative locations keeps the source one", () => {
  const www = `const url = (import.meta as any).env.PROD
      ? new URL(\`../\${entry.file}\`, import.meta.url)
      : new URL(\`../../../\${entry.file}\`, import.meta.url);`;
  assertEquals(
    rewriteModePathPicks(www),
    "const url = new URL(`../../../${entry.file}`, import.meta.url);",
  );
  assertEquals(
    rewriteModePathPicks(
      `f(import.meta.env.DEV ? import.meta.resolve("./a") : import.meta.resolve("./b"), 1)`,
    ),
    `f(import.meta.resolve("./a"), 1)`,
  );
  assertEquals(
    rewriteModePathPicks(
      `const y = !import.meta.env.PROD ? a(import.meta.url) : b(import.meta.url);`,
    ),
    `const y = a(import.meta.url);`,
  );
  const other = `const z = import.meta.env.PROD ? "prod" : "dev";`;
  assertEquals(rewriteModePathPicks(other), other, "a value pick is left alone");
  assertEquals(
    rewriteEnvReads(other),
    `import { env as importMetaEnv } from "denext/fresh/env";\nconst z = importMetaEnv.PROD ? "prod" : "dev";`,
  );
});
