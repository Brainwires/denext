// A Flight PPR response merges the cached shell's signal state with the state this request's
// resume recorded. The resume re-walks the static shell to find the holes, so it may record a
// fresher value under a shell component's id than the one the cached shell HTML was rendered
// from; hydration must adopt the value the HTML shows, so the shell's state wins on an id both
// recorded (as on an HTML route).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { json } from "../src/server/typed-response.ts";
import { useApi } from "../src/client/use-api.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { cookies } from "../src/server/request-context.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import type { VNode } from "../src/jsx/types.ts";

/** A client component in the static shell: its `useApi` answer changes on every call. */
function Count(): VNode {
  const { data } = useApi("/api/count" as never, "GET" as never, undefined, { suspense: true });
  return h("p", { class: "count" }, `count ${(data as unknown as { n: number }).n}`);
}
const clientMod = { Count };
tagClientExports(clientMod as Record<string, unknown>, "c_count");

/** A dynamic server component: reads a cookie, so its boundary is a per-request hole. */
async function Who(): Promise<VNode> {
  return await Promise.resolve(h("i", null, `hi ${cookies().get("u")?.value ?? "anon"}`));
}

const manifest: RouteManifest = {
  pages: [{
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: "/app/page.tsx",
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  }],
  api: [{
    kind: "api",
    pattern: parsePattern("/api/count"),
    routePath: "/api/count",
    filePath: "/app/api/count/route.ts",
  }],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
  directives: new Map(),
};

Deno.test("Flight PPR: the cached shell's signal state wins over the resume's re-walk", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const Page = () =>
    h(
      "main",
      null,
      h(Suspense, { fallback: h("b", null, "…"), children: h(Count, {}) }),
      h(Suspense, { fallback: h("b", null, "who…"), children: h(Who, {}) }),
    );
  const modules: Record<string, unknown> = {
    "/app/page.tsx": { default: Page, revalidate: 60 },
    "/app/api/count/route.ts": { GET: () => json({ n: ++n }) },
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    flightRoutes: new Set(["/"]),
    pageCache: new PageCache(),
    cacheComponents: true,
  });
  await (await app(new Request("http://localhost/", { headers: { cookie: "u=a" } }))).text();
  const hit = await app(new Request("http://localhost/", { headers: { cookie: "u=b" } }));
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  const html = await hit.text();
  assertStringIncludes(html, "hi b");
  const shown = /count (\d+)/.exec(html)?.[1];
  assert(shown, "the shell shows the count");
  const state = /<script id="__denext_state"[^>]*>(.*?)<\/script>/s.exec(html)?.[1];
  assert(state, "the page carries its signal state");
  const seeds = Object.values(JSON.parse(state)) as { v: { n: number } }[];
  assertEquals(seeds.map((s) => s.v.n), [Number(shown)], "the seed is the value the HTML shows");
});
