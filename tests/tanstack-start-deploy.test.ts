// @denext/tanstack-start in the deploy manifest (`.denext/deploy-manifest.json`): a Start app's
// server routes and server functions are `"route-handler"`s (a server function at the URL Start's
// RPC calls), and its pages are classified as `denext export` classifies them — `"dynamic"` when
// the route chain reaches a server function in the browser or has a dynamic segment, else
// `"static"` — through the plugin-kit's `addDeployRoutes` seam. The manifest of the example app
// after `denext build` is checked in tests/e2e/tanstack-start.e2e.test.ts.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { deployPattern, deployRoutes } from "../packages/tanstack-start/src/deploy.ts";
import type { RouteInfo } from "../packages/tanstack-start/src/prerender.ts";
import type { ClientGraph } from "../packages/tanstack-start/src/compile.ts";
import { tanstackStart } from "../packages/tanstack-start/mod.ts";
import type { PluginContext } from "../src/plugin/mod.ts";

const DIR = "/app";

/** A route tree like the example's. */
function routes(): RouteInfo[] {
  const root: RouteInfo = {
    id: "__root__",
    path: "/",
    file: join(DIR, "src/routes/__root.tsx"),
    layout: true,
    options: ["component"],
  };
  const route = (id: string, file: string, options: string[], parent = root): RouteInfo => ({
    id,
    path: id.replace(/\/_[^/]+/g, "") || "/",
    file: join(DIR, "src/routes", file),
    layout: /\/_[^/]+$/.test(id),
    options,
    parent,
  });
  const posts = route("/posts", "posts/route.tsx", ["component"]);
  const docs = route("/docs", "docs/route.tsx", ["component"]);
  return [
    root,
    route("/", "index.tsx", ["component", "loader"]),
    route("/notes", "notes.tsx", ["component", "loader"]),
    route("/api/hello", "api/hello.ts", ["server"]),
    route("/feed", "feed.tsx", ["server", "component"]),
    posts,
    route("/posts/$postId", "posts/$postId.tsx", ["component", "loader"], posts),
    route("/files/$", "files/$.tsx", ["component"]),
    docs,
    // The index renders `/docs`: the layout route above it is not listed again.
    route("/docs/", "docs/index.tsx", ["component"], docs),
    route("/_auth", "_auth.tsx", ["component"]),
  ];
}

/** A browser build in which `notes.tsx` reaches a server function. */
const client: ClientGraph = {
  graph: {
    imports: new Map([
      [join(DIR, "src/routes/notes.tsx"), [{ to: join(DIR, "src/fns.ts"), specifier: "./fns" }]],
    ]),
    importers: new Map(),
    kept: new Set(),
  },
  serverFnModules: new Set([join(DIR, "src/fns.ts")]),
};

const sources: Record<string, string> = {
  [join(DIR, "src/routes/api/hello.ts")]:
    "export const Route = createFileRoute('/api/hello')({ server: { handlers: { GET: () => " +
    "new Response('hi'), POST: async ({ request }) => new Response(await request.text()) } } });",
  [join(DIR, "src/routes/feed.tsx")]: "export const Route = createFileRoute('/feed')({ " +
    "server: { handlers: ({ createHandlers }) => createHandlers({ GET: { handler: () => " +
    "new Response('') } }) }, component: Feed });",
};

Deno.test("tanstack-start deploy: route paths in the manifest's pattern syntax", () => {
  assertEquals(deployPattern("/"), "/");
  assertEquals(deployPattern("/posts/"), "/posts");
  assertEquals(deployPattern("/posts/$postId"), "/posts/[postId]");
  assertEquals(deployPattern("/files/$"), "/files/[..._splat]");
  assertEquals(deployPattern("/{-$locale}/about"), "/[[locale]]/about");
});

Deno.test("tanstack-start deploy: server routes, server functions and pages, classified", async () => {
  const listed = await deployRoutes({
    routes: routes(),
    serverFns: {
      abc123: {
        functionName: "getNotes_createServerFn_handler",
        functionId: "abc123",
        filename: join(DIR, "src/fns.ts"),
        extractedFilename: join(DIR, "src/fns.ts"),
      },
    },
    client,
    projectRoot: DIR,
    readSource: (file) => Promise.resolve(sources[file] ?? ""),
  });
  assertEquals(listed, [
    { path: "/", kind: "static", source: "src/routes/index.tsx" },
    {
      path: "/notes",
      kind: "dynamic",
      source: "src/routes/notes.tsx",
      reason: "calls a server function (createServerFn): its RPC answers only from a server",
    },
    {
      path: "/api/hello",
      kind: "route-handler",
      source: "src/routes/api/hello.ts",
      reason: "a server route (server.handlers)",
      methods: ["GET", "POST"],
    },
    {
      path: "/feed",
      kind: "route-handler",
      source: "src/routes/feed.tsx",
      reason: "a server route (server.handlers)",
      methods: ["GET"],
    },
    // A server route with a component renders a page too, which needs the server (as the export
    // refuses it).
    {
      path: "/feed",
      kind: "dynamic",
      source: "src/routes/feed.tsx",
      reason: "a server route (server.handlers): it answers requests",
    },
    { path: "/posts", kind: "static", source: "src/routes/posts/route.tsx" },
    {
      path: "/posts/[postId]",
      kind: "dynamic",
      source: "src/routes/posts/$postId.tsx",
      reason: "a dynamic route, rendered per request (`denext export` writes the paths it " +
        "prerenders)",
    },
    {
      path: "/files/[..._splat]",
      kind: "dynamic",
      source: "src/routes/files/$.tsx",
      reason: "a dynamic route, rendered per request (`denext export` writes the paths it " +
        "prerenders)",
    },
    { path: "/docs", kind: "static", source: "src/routes/docs/index.tsx" },
    {
      path: "/_serverFn/abc123",
      kind: "route-handler",
      source: "src/fns.ts",
      reason: "a server function (createServerFn `getNotes`), called over Start's RPC",
    },
  ]);
  // No route tree (generateRouteTree: false): only the server functions.
  assertEquals(
    await deployRoutes({
      routes: null,
      serverFns: {},
      client: null,
      projectRoot: DIR,
      readSource: () => Promise.resolve(""),
    }),
    [],
  );
});

Deno.test("tanstack-start deploy: the plugin lists its routes through addDeployRoutes", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_tss_deploy_" }));
  const sourcesAdded: Array<() => unknown> = [];
  const ctx = {
    projectRoot: dir,
    appDir: join(dir, "app"),
    config: {},
    mode: "build",
    load: () => Promise.resolve({}),
    addRequestHandler: () => {},
    addBuildStep: () => {},
    addPrepareStep: () => {},
    addDeployRoutes: (source: () => unknown) => sourcesAdded.push(source),
  } as unknown as PluginContext;
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "src", "router.tsx"), "export function getRouter() {}\n");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await tanstackStart({ generateRouteTree: false }).setup(ctx);
    assertEquals(sourcesAdded.length, 1);
    // A host from before the seam: the plugin still sets up.
    const { addDeployRoutes: _, ...older } = ctx as unknown as Record<string, unknown>;
    await tanstackStart({ generateRouteTree: false }).setup(older as unknown as PluginContext);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
