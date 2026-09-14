// The two DevTools data endpoints (`/_denext/dev-cache`, `/_denext/dev-routes`) and the
// panes that read them.
//
// The load-bearing assertion is the LAST server one: both endpoints sit inside the dev
// handler's gated switch, so a cross-origin `Sec-Fetch-Site` must get a 403 — the cache
// counters describe a developer's traffic and the route map describes their file layout,
// and neither may be readable by a page they happen to be visiting (cf. CVE-2025-48068).
//
// The route map is also asserted to be a LOSSLESS split of the MCP `routeMap` text: the
// golden strings below were captured from the pre-split implementation.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createDevHandler } from "../src/build/dev-server/handler.ts";
import { createDevState } from "../src/build/dev-server/state.ts";
import { DEV_CACHE_PATH, DEV_ROUTES_PATH } from "../src/build/dev-server/state.ts";
import { formatRouteMap, routeMapData } from "../src/mcp/inspect.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { resetCacheStats, revalidatePath, revalidateTag } from "../src/server/cache.ts";
import { FakeDocument, type FakeElement } from "./helpers/dom.ts";
import { initialState } from "../src/client/devtools-panel.ts";
import type { PanelCtx } from "../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import { refreshCacheTab, renderCacheTab } from "../src/client/devtools-panel/cache.ts";
import { refreshRoutesTab, renderRoutesTab } from "../src/client/devtools-panel/routes.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** A throwaway project with a layout, two boundaries, a dynamic page and an API route. */
async function tempApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_devtools_endpoints_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
  const write = async (rel: string, body: string) => {
    const file = join(dir, rel);
    await Deno.mkdir(join(file, ".."), { recursive: true });
    await Deno.writeTextFile(file, body);
  };
  await write(
    "app/layout.tsx",
    `export default function L(p:{children:unknown}){return p.children}\n`,
  );
  await write("app/page.tsx", `export default function Page(){return <p>hi</p>}\n`);
  await write("app/loading.tsx", `export default function Loading(){return <p>…</p>}\n`);
  await write("app/error.tsx", `"use client";\nexport default function E(){return <p>err</p>}\n`);
  await write("app/blog/[slug]/page.tsx", `export default function P(){return <p>post</p>}\n`);
  await write("app/api/ping/route.ts", `export function GET(){return Response.json({ok:true})}\n`);
  // The manifest scan emits `.denext/{routes,api}.ts` fire-and-forget; the directory has to
  // exist for that write to land (and for `settled` below to see it) instead of logging.
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  return dir;
}

/** A dev handler over `dir` whose app handler answers a plain body. */
async function devHandler(dir: string): Promise<(req: Request) => Promise<Response>> {
  const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
  st.load = defaultLoader;
  return createDevHandler(st, () => Promise.resolve(new Response("app")));
}

/** Wait (≤ 3 s) until `file` exists — the typed-module emit is fire-and-forget. */
async function settled(file: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await Deno.stat(file);
      await new Promise((r) => setTimeout(r, 50));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

Deno.test({
  name: "dev-cache: reports the stat keys, and the counters move with an invalidation",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const handle = await devHandler(dir);
    resetCacheStats();
    const before = await handle(new Request(`http://localhost${DEV_CACHE_PATH}`));
    assertEquals(before.status, 200);
    assertEquals(before.headers.get("cache-control"), "no-store");
    const stats = await before.json();
    assertEquals(Object.keys(stats).sort(), [
      "invalidations",
      "pageHits",
      "pageMisses",
      "pageSets",
      "recentInvalidations",
    ]);
    assertEquals(stats.invalidations, 0);
    assertEquals(stats.recentInvalidations, []);

    await revalidateTag("orders");
    await revalidatePath("/blog");
    const after = await (await handle(new Request(`http://localhost${DEV_CACHE_PATH}`))).json();
    assertEquals(after.invalidations, 2);
    assertEquals(after.recentInvalidations.length, 2);
    // Newest LAST on the wire (the Cache pane is what flips them).
    assertEquals(after.recentInvalidations[0].kind, "tag");
    assertEquals(after.recentInvalidations[0].value, "orders");
    assertEquals(after.recentInvalidations[1].kind, "path");
    assertEquals(after.recentInvalidations[1].value, "/blog");
    assert(typeof after.recentInvalidations[1].at === "number");
  } finally {
    resetCacheStats();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-routes: maps the matched page, layout chain, boundaries and API route",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const handle = await devHandler(dir);
    const res = await handle(new Request(`http://localhost${DEV_ROUTES_PATH}?path=/`));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const map = await res.json();
    assertEquals(map.path, "/");
    assertEquals(map.matched, true);
    assertEquals(map.page.routePath, "/");
    assertEquals(map.page.file, "page.tsx");
    assertEquals(map.page.boundary, "server");
    assertEquals(map.page.layouts, [{ file: "layout.tsx", boundary: "server" }]);
    assertEquals(map.page.boundaries.loading, "loading.tsx");
    // `error.tsx` declares "use client" — the boundary map records the file either way.
    assertEquals(map.page.boundaries.error, "error.tsx");
    assertEquals(map.page.slots, []);
    // The manifest carries no segment config, so the field is omitted (not `null`).
    assertEquals("segmentConfig" in map.page, false);
    assertStringIncludes(map.appDir, "app");

    const dynamic = await (await handle(
      new Request(`http://localhost${DEV_ROUTES_PATH}?path=/blog/hello`),
    )).json();
    assertEquals(dynamic.page.routePath, "/blog/[slug]");
    assertEquals(dynamic.page.params, { slug: "hello" });

    const api = await (await handle(
      new Request(`http://localhost${DEV_ROUTES_PATH}?path=/api/ping`),
    )).json();
    assertEquals(api.matched, true);
    assertEquals(api.api, { routePath: "/api/ping", file: "api/ping/route.ts" });

    // No `?path=` at all defaults to "/".
    const dflt = await (await handle(new Request(`http://localhost${DEV_ROUTES_PATH}`))).json();
    assertEquals(dflt.path, "/");
    assertEquals(dflt.matched, true);
    await settled(join(dir, ".denext", "api.ts"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-routes: an unmatched path is matched:false with a 200, never a 404",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const handle = await devHandler(dir);
    const res = await handle(
      new Request(`http://localhost${DEV_ROUTES_PATH}?path=/does/not/exist`),
    );
    assertEquals(res.status, 200, "a 404 would read as 'no such endpoint' to the panel");
    const map = await res.json();
    assertEquals(map.matched, false);
    assertEquals(map.path, "/does/not/exist");
    assertEquals(map.page, undefined);
    assertEquals(map.api, undefined);
    await settled(join(dir, ".denext", "api.ts"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-cache + dev-routes: a cross-origin Sec-Fetch-Site is refused (403)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const handle = await devHandler(dir);
    for (const path of [DEV_CACHE_PATH, `${DEV_ROUTES_PATH}?path=/`]) {
      for (const site of ["cross-site", "same-site", "none"]) {
        const res = await handle(
          new Request(`http://localhost${path}`, { headers: { "sec-fetch-site": site } }),
        );
        assertEquals(res.status, 403, `${path} must refuse Sec-Fetch-Site: ${site}`);
        assertEquals(await res.text(), "forbidden");
      }
      // A hostile page's Origin does not get in either, even without Sec-Fetch-Site.
      const origin = await handle(
        new Request(`http://localhost${path}`, { headers: { origin: "http://evil.example" } }),
      );
      assertEquals(origin.status, 403);
      // The legitimate same-origin panel fetch is served.
      const ok = await handle(
        new Request(`http://localhost${path}`, { headers: { "sec-fetch-site": "same-origin" } }),
      );
      assertEquals(ok.status, 200);
    }
    await settled(join(dir, ".denext", "api.ts"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("routeMap split: formatRouteMap(routeMapData(…)) is byte-identical to the old text", async () => {
  // Captured from the pre-split `routeMap()` over examples/hello.
  const golden: Record<string, string> = {
    "/": "Page: /   params: {}\n  page: page.tsx [server]\n  layout: layout.tsx [server]\n" +
      "  error: error.tsx\n  not-found: not-found.tsx",
    "/blog/deno-rocks":
      'Page: /blog/[slug]   params: {"slug":"deno-rocks"}\n  page: blog/[slug]/page.tsx [server]\n' +
      "  layout: layout.tsx [server]\n  error: error.tsx\n  not-found: not-found.tsx",
    "/does/not/exist": 'No route matches "/does/not/exist". Try denext_list_routes.',
  };
  const hello = new URL("../examples/hello", import.meta.url).pathname;
  const paths = await resolveProject(hello);
  const manifest = await scanRoutes(paths.appDir);
  for (const [path, text] of Object.entries(golden)) {
    assertEquals(formatRouteMap(routeMapData(manifest, paths.appDir, path)), text, path);
  }
});

/** A bare panel context over the in-memory DOM (the ./devtools-panel.test.ts precedent). */
function dataTabCtx(): { ctx: PanelCtx; detailPane: FakeElement } {
  const doc = new FakeDocument();
  const { S, S_BADGE } = buildStyles();
  const detailPane = doc.createElement("div");
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny({}),
    S,
    S_BADGE,
    state: initialState(),
    treePane: asAny(doc.createElement("div")),
    detailPane: asAny(detailPane),
    render: () => {},
    selectNode: () => {},
    highlight: () => {},
    hideHighlight: () => {},
  };
  return { ctx, detailPane };
}

/** Run `fn` with `fetch` replaced by a stub answering `payload` as JSON. */
async function withJson(payload: unknown, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(payload));
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("Cache pane: stat tiles, hit rate, and the invalidation list newest first", async () => {
  const { ctx, detailPane } = dataTabCtx();
  const now = Date.now();
  await withJson({
    pageHits: 3,
    pageMisses: 1,
    pageSets: 2,
    invalidations: 2,
    recentInvalidations: [
      { kind: "tag", value: "orders", at: now - 120_000 },
      { kind: "path", value: "/blog", at: now - 2000 },
    ],
  }, async () => {
    refreshCacheTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  renderCacheTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "3hits");
  assertStringIncludes(text, "1misses");
  assertStringIncludes(text, "2sets");
  assertStringIncludes(text, "75%hit rate"); // 3 of 4 reads
  // Newest first: the path invalidation was recorded last, so it leads.
  const rows = detailPane.outerHTML.indexOf("/blog") < detailPane.outerHTML.indexOf("orders");
  assert(rows, "the newest invalidation is listed first");
  assertStringIncludes(text, "2s ago");
  assertStringIncludes(text, "2m ago");
});

Deno.test("Cache pane: no invalidations yet, and an unreadable payload reads as zeroes", async () => {
  const { ctx, detailPane } = dataTabCtx();
  await withJson({ pageHits: 0, pageMisses: 0, recentInvalidations: [] }, async () => {
    refreshCacheTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  renderCacheTab(ctx);
  assertStringIncludes(detailPane.textContent, "no invalidations yet");
  assertStringIncludes(detailPane.textContent, "—hit rate"); // no reads → no rate
  assertStringIncludes(detailPane.textContent, "0sets");
});

Deno.test("Routes pane: the layout chain is indented and badged, files open in the editor", async () => {
  const { ctx, detailPane } = dataTabCtx();
  await withJson({
    path: "/blog/hello",
    matched: true,
    appDir: "/proj/app",
    api: { routePath: "/api/ping", file: "api/ping/route.ts" },
    page: {
      routePath: "/blog/[slug]",
      params: { slug: "hello" },
      file: "blog/[slug]/page.tsx",
      boundary: "client",
      layouts: [
        { file: "layout.tsx", boundary: "server" },
        { file: "blog/layout.tsx", boundary: "client" },
      ],
      templates: [],
      boundaries: { loading: "loading.tsx", error: "error.tsx" },
      slots: [{ name: "modal", pages: 2 }],
    },
  }, async () => {
    refreshRoutesTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  renderRoutesTab(ctx);
  const html = detailPane.outerHTML;
  assertStringIncludes(html, "/blog/[slug]");
  assertStringIncludes(detailPane.textContent, "slughello");
  // The chain indents one step per level: root layout 0, nested 11 px, page 22 px.
  assertStringIncludes(html, "padding-left:0px");
  assertStringIncludes(html, "padding-left:11px");
  assertStringIncludes(html, "padding-left:22px");
  // Both badges are present (root layout server, the page client).
  assertStringIncludes(detailPane.textContent, "server");
  assertStringIncludes(detailPane.textContent, "client");
  assertStringIncludes(detailPane.textContent, "@modal");
  assertStringIncludes(detailPane.textContent, "2 page(s)");
  assertStringIncludes(detailPane.textContent, "/api/ping");

  // Clicking a file asks the dev server to open the ABSOLUTE path.
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    asked.push(String(input));
    return Promise.resolve(new Response("ok"));
  };
  try {
    fileButtons(detailPane)[1].dispatch("click");
  } finally {
    globalThis.fetch = real;
  }
  assertEquals(asked.length, 1);
  assertStringIncludes(asked[0], "file=%2Fproj%2Fapp%2Flayout.tsx");
});

Deno.test("Routes pane: an unmatched probe says so, and the endpoint's absence is named", async () => {
  const { ctx, detailPane } = dataTabCtx();
  await withJson({ path: "/nope", matched: false, appDir: "/proj/app" }, async () => {
    refreshRoutesTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  renderRoutesTab(ctx);
  assertStringIncludes(detailPane.textContent, "nothing renders at /nope");

  // SPA dev serves no such endpoint: the shared placeholder owns the pane (no toolbar).
  const spa = dataTabCtx();
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("no", { status: 404 }));
  try {
    refreshRoutesTab(spa.ctx);
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = real;
  }
  spa.detailPane.replaceChildren();
  renderRoutesTab(spa.ctx);
  assertEquals(
    spa.detailPane.textContent,
    "Routes is not available in SPA dev (App Router only)",
  );
  assertEquals(spa.ctx.state.dataUnavailable, true);
});

/** Every `<button>` the Routes pane rendered for a file path (in document order). */
function fileButtons(pane: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: { childNodes: unknown[] }) => {
    for (const child of node.childNodes as FakeElement[]) {
      if (child.tagName === "BUTTON" && child.getAttribute("title") === "Open in your editor") {
        out.push(child);
      }
      walk(child as unknown as { childNodes: unknown[] });
    }
  };
  walk(pane as unknown as { childNodes: unknown[] });
  return out;
}
