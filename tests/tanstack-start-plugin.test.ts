// @denext/tanstack-start: the request handler (the client bundle under /_tss/, every other page
// request rendered by the generated server entry with the client entry in the router manifest),
// the generated entries, the route tree from TanStack's own generator, and a project without a
// Start router left alone. The browser half is tests/e2e/tanstack-start.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  CLIENT_ENTRY,
  createHandler,
  routerManifest,
} from "../packages/tanstack-start/src/handler.ts";
import {
  clientBootSource,
  clientEntrySource,
  serverEntrySource,
} from "../packages/tanstack-start/src/entries.ts";
import { generateRouteTree } from "../packages/tanstack-start/src/route-tree.ts";
import { tanstackStart } from "../packages/tanstack-start/mod.ts";
import type { PluginContext } from "../src/plugin/mod.ts";

async function handlerWithClient(basePath = "") {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_client_" });
  await Deno.writeTextFile(join(dir, CLIENT_ENTRY), "console.log('entry')");
  await Deno.writeTextFile(join(dir, "chunk-ABC.js"), "export const x = 1;");
  const rendered: Array<{ url: string; manifest: unknown }> = [];
  const handle = createHandler({
    basePath,
    client: () => Promise.resolve(dir),
    loadServerEntry: () =>
      Promise.resolve({
        render: (request: Request, manifest: unknown) => {
          rendered.push({ url: request.url, manifest });
          return Promise.resolve(new Response("<!DOCTYPE html><html></html>"));
        },
      }),
  });
  return { dir, handle, rendered };
}

Deno.test("tanstack-start handler: pages render through the server entry; the bundle is served", async () => {
  const { dir, handle, rendered } = await handlerWithClient();
  try {
    const page = await handle(new Request("http://x/posts/1"));
    assertEquals(await page!.text(), "<!DOCTYPE html><html></html>");
    assertEquals(rendered, [{
      url: "http://x/posts/1",
      manifest: routerManifest("/_tss/client.js"),
    }]);
    const entry = await handle(new Request("http://x/_tss/client.js"));
    assertEquals(await entry!.text(), "console.log('entry')");
    assertEquals(entry!.headers.get("cache-control"), "no-cache");
    const chunk = await handle(new Request("http://x/_tss/chunk-ABC.js"));
    assertStringIncludes(chunk!.headers.get("cache-control")!, "immutable");
    assertEquals((await handle(new Request("http://x/_tss/..%2Fdeno.json")))!.status, 404);
    assertEquals((await handle(new Request("http://x/_tss/nope.js")))!.status, 404);
    assertEquals(await handle(new Request("http://x/favicon.ico")), null, "files fall through");
    assertEquals(await handle(new Request("http://x/", { method: "POST" })), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start handler: the manifest names the entry under basePath", async () => {
  const { dir, handle, rendered } = await handlerWithClient("/app");
  try {
    await handle(new Request("http://x/app/about"));
    assertEquals(rendered[0].manifest, routerManifest("/app/_tss/client.js"));
    const entry = await handle(new Request("http://x/app/_tss/client.js"));
    assertEquals(entry!.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start entries: TanStack's SSR on the server, RouterClient in the browser", () => {
  const server = serverEntrySource("/p/.denext/tanstack-start", "/p/src/router.tsx");
  assertStringIncludes(server, `from "@tanstack/react-router/ssr/server"`);
  assertStringIncludes(server, `import * as app from "../../src/router.tsx"`);
  assertStringIncludes(server, "createRequestHandler({");
  const boot = clientBootSource("/p/.denext/tanstack-start", "/p/src/router.tsx");
  assertStringIncludes(boot, `import { RouterClient } from "@tanstack/react-router/ssr/client"`);
  assertStringIncludes(boot, "hydrateRoot(document, createElement(RouterClient");
  assertEquals(
    clientEntrySource("/p/.denext/tanstack-start/client-boot.ts"),
    `import "/p/.denext/tanstack-start/client-boot.ts";\n`,
  );
});

Deno.test("tanstack-start: a project without a Start router registers nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_none_" });
  const added: string[] = [];
  const ctx = {
    projectRoot: dir,
    appDir: join(dir, "app"),
    config: {},
    mode: "build",
    load: () => Promise.resolve({}),
    addRequestHandler: () => added.push("handler"),
    addBuildStep: () => added.push("build"),
    addPrepareStep: () => added.push("prepare"),
  } as unknown as PluginContext;
  try {
    await tanstackStart().setup(ctx);
    assertEquals(added, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tanstack-start route tree: TanStack's generator, imports with extensions", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_tss_tree_" });
  try {
    await Deno.mkdir(join(dir, "src", "routes", "posts"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src", "routes", "__root.tsx"),
      `import { createRootRoute } from "@tanstack/react-router";\nexport const Route = createRootRoute({});\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "routes", "posts", "$postId.tsx"),
      `import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/posts/$postId")({});\n`,
    );
    await generateRouteTree(dir, join(dir, "src"));
    const tree = await Deno.readTextFile(join(dir, "src", "routeTree.gen.ts"));
    assertStringIncludes(tree, `from './routes/__root.tsx'`);
    assertStringIncludes(tree, `from './routes/posts/$postId.tsx'`);
    assert(tree.includes("'/posts/$postId'"), "the file route is in the tree");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
