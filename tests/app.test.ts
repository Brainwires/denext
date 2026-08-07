import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";

// An in-memory module registry so we don't touch the filesystem.
function makeApp(modules: Record<string, unknown>, manifest: RouteManifest) {
  return createApp({
    getManifest: () => manifest,
    load: (filePath) => {
      if (!(filePath in modules)) {
        throw new Error(`no module ${filePath}`);
      }
      return Promise.resolve(modules[filePath]);
    },
  });
}

Deno.test("renders a page to a full HTML document", async () => {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "home.tsx",
      layoutChain: ["root-layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
    }],
    api: [],
    rootLayout: "root-layout.tsx",
  };
  const modules = {
    "home.tsx": {
      default: (props: PageProps) => h("h1", null, `Home ${props.params.x ?? ""}`),
      metadata: { title: "Home Page", description: "welcome" },
    },
    "root-layout.tsx": {
      default: (props: { children: never }) =>
        h("main", null, props.children),
    },
  };
  const app = makeApp(modules, manifest);

  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, "<title>Home Page</title>");
  assertStringIncludes(body, '<meta name="description" content="welcome">');
  assertStringIncludes(body, "<main><h1>Home </h1></main>");
  assertStringIncludes(body, 'id="__denext"');
});

Deno.test("passes dynamic params and search params to the page", async () => {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("user/[id]"),
      routePath: "/user/[id]",
      filePath: "user.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
    }],
    api: [],
    rootLayout: null,
  };
  const modules = {
    "user.tsx": {
      default: (props: PageProps) =>
        h("p", null, `${props.params.id}:${props.searchParams.get("tab")}`),
    },
  };
  const app = makeApp(modules, manifest);
  const res = await app(new Request("http://localhost/user/42?tab=posts"));
  const body = await res.text();
  assertStringIncludes(body, "<p>42:posts</p>");
});

Deno.test("dispatches API routes by method", async () => {
  const manifest: RouteManifest = {
    pages: [],
    api: [{
      kind: "api",
      pattern: parsePattern("api/echo"),
      routePath: "/api/echo",
      filePath: "echo.ts",
    }],
    rootLayout: null,
  };
  const modules = {
    "echo.ts": {
      GET: () => Response.json({ ok: true }),
      POST: async (req: Request) => Response.json(await req.json()),
    },
  };
  const app = makeApp(modules, manifest);

  const get = await app(new Request("http://localhost/api/echo"));
  assertEquals(await get.json(), { ok: true });

  const post = await app(
    new Request("http://localhost/api/echo", {
      method: "POST",
      body: JSON.stringify({ hi: 1 }),
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(await post.json(), { hi: 1 });
});

Deno.test("returns 405 for unsupported API methods with Allow header", async () => {
  const manifest: RouteManifest = {
    pages: [],
    api: [{
      kind: "api",
      pattern: parsePattern("api/only-get"),
      routePath: "/api/only-get",
      filePath: "og.ts",
    }],
    rootLayout: null,
  };
  const app = makeApp({ "og.ts": { GET: () => new Response("ok") } }, manifest);
  const res = await app(
    new Request("http://localhost/api/only-get", { method: "DELETE" }),
  );
  await res.body?.cancel();
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
});

Deno.test("returns 404 for unmatched routes", async () => {
  const manifest: RouteManifest = {
    pages: [],
    api: [],
    rootLayout: null,
  };
  const app = makeApp({}, manifest);
  const res = await app(new Request("http://localhost/nope"));
  assertEquals(res.status, 404);
  assertStringIncludes(await res.text(), "404");
});

Deno.test("emits hydration data when a client entry is configured", async () => {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("about"),
      routePath: "/about",
      filePath: "/abs/about.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
    }],
    api: [],
    rootLayout: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: () => h("h1", null, "About") }),
    clientEntryFor: (route) =>
      `/_denext/routes${route.routePath === "/" ? "/index" : route.routePath}.js`,
  });
  const res = await app(new Request("http://localhost/about"));
  const body = await res.text();
  assertStringIncludes(body, 'id="__denext_data"');
  assertStringIncludes(body, '<script type="module" src="/_denext/routes/about.js">');
});
