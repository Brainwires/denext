// A HEAD of a page answers the headers its GET would, its length included: up to 4.5.0 the body
// was dropped and the server sent `content-length: 0`.

import { assert, assertEquals } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

const page = (route: string) => ({
  kind: "page" as const,
  pattern: parsePattern(route),
  routePath: `/${route}`,
  filePath: "page.tsx",
  layoutChain: [],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
  templateChain: [],
});

const manifest = (): RouteManifest => ({
  pages: [page("x")],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
});

Deno.test("HEAD of a page (and of the 404 page) carries its GET's content-length, no body", async () => {
  const app = createApp({
    getManifest: () => Promise.resolve(manifest()),
    load: () => Promise.resolve({ default: () => h("p", null, "hello ".repeat(50)) }),
  });
  for (const path of ["/x", "/missing"]) {
    const get = await app(new Request(`http://localhost${path}`));
    const bytes = (await get.arrayBuffer()).byteLength;
    const head = await app(new Request(`http://localhost${path}`, { method: "HEAD" }));
    assertEquals(head.status, get.status, path);
    assertEquals(head.body, null, path);
    assert(bytes > 0);
    assertEquals(head.headers.get("content-length"), String(bytes), path);
  }
});
