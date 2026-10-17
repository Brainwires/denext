// `createTestApp` sets up the `plugins` of the project's `denext.config.ts` the way `denext dev`
// does: prepare steps once, route synthesizers over the scan, request handlers for what the App
// Router does not match, and the teardowns on `close()`. Each app gets its own plugin set, so a
// Pages Router app and a plugin-served route are testable in process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient, probeApp } from "../src/testing/mod.ts";

const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
const PAGES_ROUTER = new URL("../packages/pages-router/mod.ts", import.meta.url).href;

/** A temp project holding `files`; removed after `fn`. */
async function withProject<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "denext_test_app_plugins_" });
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

/** A Pages Router project: `pages/` only (no `app/`), wired through `denext.config.ts`. */
const PAGES_APP: Record<string, string> = {
  "denext.config.ts": `import { pagesRouter } from "${PAGES_ROUTER}";
export default { plugins: [pagesRouter()] };
`,
  "pages/index.ts": `import { h } from "${JSX}";
export default function Home() { return h("h1", null, "Pages home"); }
`,
  "pages/posts/[id].ts": `import { h } from "${JSX}";
export function getServerSideProps({ params }) { return { props: { id: params.id } }; }
export default function Post({ id }) { return h("article", null, "Post " + id); }
`,
  "pages/api/hello.ts": `export default function handler(req, res) {
  res.status(200).json({ hello: req.query.name ?? "world", method: req.method });
}
`,
};

Deno.test("createTestApp: a Pages Router app renders its pages and answers its API routes", async () => {
  await withProject(PAGES_APP, async (dir) => {
    await using app = await createTestApp(dir);
    const client = createTestClient(app);
    const home = await client.get("/");
    assertEquals(home.status, 200);
    assertStringIncludes(home.text, "<h1>Pages home</h1>");
    const post = await client.get("/posts/7");
    assertEquals(post.status, 200);
    assertStringIncludes(post.text, "<article>Post 7</article>");
    const api = await client.get("/api/hello?name=deno");
    assertEquals(api.status, 200);
    assertEquals(JSON.parse(api.text), { hello: "deno", method: "GET" });
    assertEquals((await client.get("/nope")).status, 404);
  });
});

/**
 * A project whose config carries a hand-written plugin using every seam a running app has:
 * a request handler, a route synthesizer (an extra API route), a prepare step (codegen the app
 * reads) and a teardown. `tag` tells two projects apart; the plugin NAME is the same in both.
 */
function pluginProject(tag: string): Record<string, string> {
  return {
    "denext.config.ts": `import { join } from "node:path";
const log = (globalThis.__testAppPluginLog ??= []);
export default {
  plugins: [{
    name: "test-app-probe",
    setup(ctx) {
      log.push("setup:${tag}:" + ctx.mode);
      ctx.addRequestHandler((req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/plugin/ping") return null;
        return Response.json({ from: "${tag}", method: req.method });
      });
      ctx.addRouteSynthesizer((manifest) => {
        const route = manifest.api.find((r) => r.routePath === "/api/real");
        if (route) manifest.api.push({ ...route, routePath: "/api/alias", pattern: [
          { kind: "static", value: "api" }, { kind: "static", value: "alias" },
        ] });
      });
      ctx.addPrepareStep(async ({ outDir }) => {
        await Deno.mkdir(outDir, { recursive: true });
        await Deno.writeTextFile(join(outDir, "generated.txt"), "${tag}");
        log.push("prepare:${tag}");
      });
      ctx.addTeardown(() => { log.push("teardown:${tag}"); });
    },
  }],
};
`,
    "app/layout.ts": `import { h } from "${JSX}";
export const metadata = { title: "Plugins" };
export default function Root({ children }) { return h("main", null, children); }
`,
    "app/page.ts": `import { h } from "${JSX}";
export default function Home() { return h("p", null, "app home ${tag}"); }
`,
    "app/api/real/route.ts": `export function GET() { return Response.json({ real: "${tag}" }); }
`,
  };
}

function pluginLog(): string[] {
  return ((globalThis as { __testAppPluginLog?: string[] }).__testAppPluginLog ??= []);
}

Deno.test("createTestApp: a config plugin's handler, synthesizer, prepare step and teardown all run", async () => {
  pluginLog().length = 0;
  await withProject(pluginProject("a"), async (dir) => {
    const app = await createTestApp(dir);
    const client = createTestClient(app);
    // The prepare step ran once, before the first request, in dev mode.
    assertEquals(pluginLog(), ["setup:a:dev", "prepare:a"]);
    assertEquals(await Deno.readTextFile(join(dir, ".denext", "generated.txt")), "a");
    // The plugin's request handler claims its path; the App Router keeps its own.
    const ping = await client.post("/plugin/ping");
    assertEquals(JSON.parse(ping.text), { from: "a", method: "POST" });
    assertStringIncludes((await client.get("/")).text, "app home a");
    // The synthesized route is in the manifest the app serves.
    assertEquals(JSON.parse((await client.get("/api/alias")).text), { real: "a" });
    await app.close();
    await app.close(); // idempotent
    assertEquals(pluginLog(), ["setup:a:dev", "prepare:a", "teardown:a"]);
  });
});

Deno.test("createTestApp: two apps in one process each get their own plugin set", async () => {
  pluginLog().length = 0;
  await withProject(
    pluginProject("one"),
    (one) =>
      withProject(pluginProject("two"), async (two) => {
        // Same plugin name in both configs: the second must still be set up, and must not see
        // the first app's handler (the process-wide registry de-duplicates by name).
        await using a = await createTestApp(one);
        await using b = await createTestApp(two);
        const pa = await createTestClient(a).get("/plugin/ping");
        const pb = await createTestClient(b).get("/plugin/ping");
        assertEquals(JSON.parse(pa.text).from, "one");
        assertEquals(JSON.parse(pb.text).from, "two");
      }),
  );
  // `await using` closed both, most recent first.
  assertEquals(pluginLog().filter((l) => l.startsWith("teardown")), [
    "teardown:two",
    "teardown:one",
  ]);
});

Deno.test("createTestApp: an app without plugins is unchanged (a plain handler; close() is a no-op)", async () => {
  await withProject(
    {
      "app/page.ts": `import { h } from "${JSX}";
export default function Home() { return h("p", null, "plain"); }
`,
    },
    async (dir) => {
      const app = await createTestApp(dir);
      assertEquals(typeof app, "function");
      const res = await app(new Request("http://localhost/"));
      assertStringIncludes(await res.text(), "plain");
      assertEquals((await app(new Request("http://localhost/plugin/ping"))).status, 404);
      await app.close();
      let exists = true;
      await Deno.stat(join(dir, ".denext")).catch(() => (exists = false));
      assert(!exists, "no plugins → no prepare step → no .denext written");
    },
  );
});

Deno.test("probeApp: sets the config plugins up and runs their teardowns when done", async () => {
  pluginLog().length = 0;
  await withProject(pluginProject("probe"), async (dir) => {
    const report = await probeApp(dir);
    assert(report.ok, JSON.stringify(report.routes));
    assertEquals(pluginLog(), ["setup:probe:dev", "prepare:probe", "teardown:probe"]);
  });
});

const API_CLIENT = new URL("../src/runtime/api-client.ts", import.meta.url).href;

Deno.test("createTestApp: an App Router route calls a Pages API route in process (no network, no 404)", async () => {
  await withProject(
    {
      ...PAGES_APP,
      // A hybrid app: an App Router route handler calls the Pages API route through the typed
      // client. In process, that is a sub-request the pages plugin must answer.
      "app/api/proxy/route.ts": `import { createApiClient } from "${API_CLIENT}";
const noNetwork = () => { throw new Error("the in-process call must not touch the network"); };
export async function GET() {
  const api = createApiClient({ fetch: noNetwork });
  return Response.json({ via: "proxy", inner: await api("/api/hello", "GET", { query: { name: "sub" } }) });
}
`,
    },
    async (dir) => {
      await using app = await createTestApp(dir);
      const res = await createTestClient(app).get("/api/proxy");
      assertEquals(res.status, 200, res.text);
      assertEquals(JSON.parse(res.text), {
        via: "proxy",
        inner: { hello: "sub", method: "GET" },
      });
    },
  );
});
