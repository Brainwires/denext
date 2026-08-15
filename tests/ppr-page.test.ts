// Part C4: PPR wired through renderPage — prerenderPage composes the real page
// tree (layouts, loading boundary, metadata) into a cacheable shell + holes, and
// resumePageHoles fills the holes per request for splicing into that shell.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageMatch } from "../src/router/match.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { prerenderPage, resumePageHoles } from "../src/server/render-page.ts";
import { spliceShellHoles } from "../src/jsx/render-to-ppr.ts";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";

/** A dynamic page component: reads a cookie (postpones during prerender). */
async function UserPage() {
  const u = cookies().get("u") ?? "?";
  return await Promise.resolve(h("span", null, `user:${u}`));
}

const modules: Record<string, unknown> = {
  "layout.tsx": {
    default: (p: { children: unknown }) =>
      h("div", { id: "l" }, [
        h("title", null, "PPR Page"),
        h("h1", null, "Site"),
        p.children as never,
      ]),
  },
  "loading.tsx": { default: () => h("p", null, "loading…") },
  "page.tsx": { default: UserPage },
  "static-page.tsx": { default: () => h("span", null, "hello") },
};

const loader: ModuleLoader = (fp) => Promise.resolve(modules[fp] as never);

function match(over: Partial<PageMatch["route"]> = {}): PageMatch {
  return {
    route: {
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: ["layout.tsx"],
      loading: "loading.tsx",
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
      ...over,
    },
    params: {},
  };
}

const run = <T>(u: string, fn: (req: Request) => Promise<T>): Promise<T> => {
  const req = new Request("http://x/x", { headers: { cookie: `u=${u}` } });
  return runWithContext(createRequestContext(req), () => fn(req));
};

Deno.test("C4: prerenderPage yields a static shell with a dynamic hole; head is hoisted", async () => {
  const m = match();
  const pre = await run("alice", (req) => prerenderPage(m, req, loader));

  assertEquals(pre.dynamic, false);
  assertEquals(pre.holeIds, ["dnx0"]);
  // In-tree <title> from the (static) layout is hoisted into metadata.
  assertEquals(pre.metadata.title, "PPR Page");
  // The shell has the static chrome + the fallback placeholder, NOT alice's data.
  assertStringIncludes(pre.shellBody, `<div id="l">`);
  assertStringIncludes(pre.shellBody, "<h1>Site</h1>");
  assertStringIncludes(pre.shellBody, `<div data-dnx-b="dnx0">`);
  assertStringIncludes(pre.shellBody, "loading…");
  assert(!pre.shellBody.includes("user:alice"), "shell must be request-independent");
  assert(!pre.shellBody.includes("<title>"), "title is hoisted out of the body");
});

Deno.test("C4: the shell is identical across users; resumed holes differ; splice composes", async () => {
  const m = match();
  const a = await run("alice", (req) => prerenderPage(m, req, loader));
  const b = await run("bob", (req) => prerenderPage(m, req, loader));
  assertEquals(a.shellBody, b.shellBody, "shell is request-independent");
  assertEquals(a.holeIds, b.holeIds);

  const fill = (u: string) =>
    run(u, async (req) => {
      const holes = await resumePageHoles(m, req, loader, a.holeIds);
      return spliceShellHoles(a.shellBody, holes);
    });

  const docA = await fill("alice");
  const docB = await fill("bob");
  assertStringIncludes(docA, `<div data-dnx-b="dnx0"><span>user:alice</span></div>`);
  assertStringIncludes(docB, `<div data-dnx-b="dnx0"><span>user:bob</span></div>`);
  // Same static chrome in both.
  assertStringIncludes(docA, "<h1>Site</h1>");
  assertStringIncludes(docB, "<h1>Site</h1>");
  assert(!docA.includes("loading…"), "the fallback is replaced by real content");
});

Deno.test("C4: a fully static page prerenders with no holes", async () => {
  const m = match({ filePath: "static-page.tsx" });
  const pre = await run("alice", (req) => prerenderPage(m, req, loader));
  assertEquals(pre.dynamic, false);
  assertEquals(pre.holeIds, []);
  assertStringIncludes(pre.shellBody, "<span>hello</span>");
  assert(!pre.shellBody.includes("loading…"), "a static Suspense resolves inline");
});

Deno.test("C4: a dynamic read with no Suspense boundary falls back to a normal render", async () => {
  // No loading.tsx → the page's cookie read has no Suspense above it.
  const m = match({ loading: null });
  const pre = await run("alice", (req) => prerenderPage(m, req, loader));
  assertEquals(pre.dynamic, true, "fully dynamic → caller uses renderPage");
});
