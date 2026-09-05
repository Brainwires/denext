// Next.js-shaped routing surface (2.0): catch-all params as string[], private `_folders`,
// position-aware route ordering, awaitable params/searchParams, layout-fed
// generateStaticParams, segment config on route handlers, per-segment error boundaries, and
// a global-error.tsx that owns its document.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { compareSpecificity, matchSegments, parsePattern } from "../src/router/segments.ts";
import { isPrivateFolder, type PageRoute, scanRoutes } from "../src/router/manifest.ts";
import type { PageMatch } from "../src/router/match.ts";
import { renderGlobalError, renderPage } from "../src/server/render-page.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { asyncProps, isAsyncProps, searchParamsRecord } from "../src/runtime/async-props.ts";
import { enumerateStaticParams } from "../src/server/static-params.ts";
import { handleApi } from "../src/server/api.ts";
import { cookies } from "../src/server/request-context.ts";
import type { LayoutProps, PageProps } from "../src/server/types.ts";
import { serializeScalar } from "../src/jsx/flight-scalar.ts";

function route(over: Partial<PageRoute> = {}): PageRoute {
  return {
    kind: "page",
    pattern: parsePattern("x"),
    routePath: "/x",
    filePath: "page.tsx",
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
    ...over,
  };
}

Deno.test("catch-all params are string[] (Next.js shape); dynamic stays a string", () => {
  assertEquals(matchSegments(parsePattern("blog/[...slug]"), "/blog/a/b/c"), {
    slug: ["a", "b", "c"],
  });
  assertEquals(matchSegments(parsePattern("u/[id]"), "/u/7"), { id: "7" });
});

Deno.test("route ordering is position-aware: /a/[b] beats /[a]/b for /a/b", () => {
  const aDyn = parsePattern("a/[b]");
  const dynB = parsePattern("[a]/b");
  assert(compareSpecificity(aDyn, dynB) < 0, "static-first pattern is tried first");
  assert(compareSpecificity(dynB, aDyn) > 0);
  // A concrete segment beats a catch-all that swallowed the tail.
  assert(compareSpecificity(parsePattern("a/b/[c]"), parsePattern("a/[...rest]")) < 0);
  assertEquals(compareSpecificity(aDyn, parsePattern("a/[x]")), 0);
});

Deno.test("private `_folder` directories are not routable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "_components"), { recursive: true });
    await Deno.writeTextFile(join(dir, "_components", "page.tsx"), "export default () => null;");
    await Deno.mkdir(join(dir, "about"));
    await Deno.writeTextFile(join(dir, "about", "page.tsx"), "export default () => null;");
    const m = await scanRoutes(dir);
    assertEquals(m.pages.map((p) => p.routePath).sort(), ["/about"]);
    assert(isPrivateFolder("_lib") && !isPrivateFolder("lib"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("asyncProps: sync access, `await`, no enumerable `then`, Flight treats it as data", async () => {
  const p = asyncProps({ slug: "a" });
  assertEquals(p.slug, "a");
  assertEquals((await p).slug, "a");
  assertEquals(Object.keys(p), ["slug"]);
  assertEquals(JSON.stringify(p), '{"slug":"a"}');
  assert(isAsyncProps(p));
  assertEquals(asyncProps(p), p, "idempotent");
  assertEquals(serializeScalar(p).kind, "compound", "not a deferred thenable in Flight");
  const sp = searchParamsRecord(new URLSearchParams("a=1&a=2&b=x"));
  assertEquals(sp.a, ["1", "2"]);
  assertEquals(sp.b, "x");
  assertEquals(sp.raw.get("b"), "x");
  assertEquals(Object.keys(sp), ["a", "b"]);
});

Deno.test("page + layout receive awaitable params/searchParams (Next 15 style)", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": {
      default: async (p: LayoutProps) => {
        const { slug } = await p.params;
        return h("div", { "data-slug": String(slug) }, p.children as never);
      },
    },
    "page.tsx": {
      default: async (p: PageProps) => {
        const sp = await p.searchParams;
        const params = await p.params;
        return h(
          "h1",
          null,
          `${String(params.slug)}|${String(sp.q)}|${p.searchParams.raw.get("q")}`,
        );
      },
    },
  };
  const load = (fp: string) => Promise.resolve(modules[fp]);
  const req = new Request("http://x/x?q=hi");
  const match: PageMatch = {
    route: route({ pattern: parsePattern("[slug]"), layoutChain: ["layout.tsx"] }),
    params: { slug: "s" },
  };
  const out = await runWithContext(createRequestContext(req), () => renderPage(match, req, load));
  assertStringIncludes(out.html, 'data-slug="s"');
  assertStringIncludes(out.html, "s|hi|hi");
});

Deno.test("generateStaticParams: a layout enumerates its segment; the page gets { params }", async () => {
  const seen: unknown[] = [];
  const modules: Record<string, unknown> = {
    "[cat]/layout.tsx": { generateStaticParams: () => [{ cat: "a" }, { cat: "b" }] },
    "[cat]/[id]/page.tsx": {
      generateStaticParams: ({ params }: { params: Record<string, unknown> }) => {
        seen.push(params);
        return [{ id: `${params.cat}1` }, { id: `${params.cat}2` }];
      },
    },
  };
  const load = (fp: string) => Promise.resolve(modules[fp]);
  const r = route({
    pattern: parsePattern("[cat]/[id]"),
    filePath: "[cat]/[id]/page.tsx",
    layoutChain: ["[cat]/layout.tsx"],
  });
  const sets = await enumerateStaticParams(r, load);
  assertEquals(sets, [
    { cat: "a", id: "a1" },
    { cat: "a", id: "a2" },
    { cat: "b", id: "b1" },
    { cat: "b", id: "b2" },
  ]);
  assertEquals(seen, [{ cat: "a" }, { cat: "b" }]);
  assertEquals(
    await enumerateStaticParams(route({ pattern: parsePattern("[x]") }), () => Promise.resolve({})),
    null,
  );
});

Deno.test("route handlers honor segment config: dynamic = 'error' makes cookies() throw", async () => {
  const mod = {
    dynamic: "error",
    GET: (_req: Request, ctx: { params: Record<string, unknown> }) => {
      cookies();
      return Response.json({ ok: true, id: ctx.params.id });
    },
  };
  const req = new Request("http://x/api/1");
  const ctx = createRequestContext(req);
  const res = await runWithContext(ctx, async () => {
    try {
      return await handleApi(
        {
          route: {
            kind: "api",
            pattern: parsePattern("api/[id]"),
            routePath: "/api/[id]",
            filePath: "r.ts",
          },
          params: { id: "1" },
        },
        req,
        () => Promise.resolve(mod),
      );
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
  assertEquals(res.status, 500);
  assertStringIncludes(await res.text(), 'dynamic = "error"');
});

Deno.test("route handler params are awaitable", async () => {
  const mod = {
    GET: async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ id: (await ctx.params).id }),
  };
  const res = await handleApi(
    {
      route: {
        kind: "api",
        pattern: parsePattern("api/[id]"),
        routePath: "/api/[id]",
        filePath: "r.ts",
      },
      params: { id: "9" },
    },
    new Request("http://x/api/9"),
    () => Promise.resolve(mod),
  );
  assertEquals(await res.json(), { id: "9" });
});

Deno.test("per-segment boundaries: a nested layout's throw is caught by the parent segment's error.tsx", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": { default: (p: LayoutProps) => h("main", null, p.children as never) },
    "error.tsx": { default: () => h("p", null, "ROOT_ERROR_UI") },
    "a/layout.tsx": {
      default: () => {
        throw new Error("nested layout boom");
      },
    },
    "a/page.tsx": { default: () => h("h1", null, "page") },
  };
  const load = (fp: string) => Promise.resolve(modules[fp]);
  const req = new Request("http://x/a");
  const match: PageMatch = {
    route: route({
      pattern: parsePattern("a"),
      routePath: "/a",
      filePath: "a/page.tsx",
      layoutChain: ["layout.tsx", "a/layout.tsx"],
      layoutDepths: [0, 1],
      error: "error.tsx",
      levels: [
        { depth: 0, layout: "layout.tsx", template: null, loading: null, error: "error.tsx" },
        { depth: 1, layout: "a/layout.tsx", template: null, loading: null, error: null },
      ],
    }),
    params: {},
  };
  const out = await runWithContext(createRequestContext(req), () => renderPage(match, req, load));
  assertStringIncludes(out.html, "<main>", "root layout still renders");
  assertStringIncludes(
    out.html,
    "ROOT_ERROR_UI",
    "parent segment's error.tsx caught the nested layout",
  );
});

Deno.test("global-error.tsx owns the document: no nested <html>/<body>", async () => {
  const load = () =>
    Promise.resolve({
      default: (p: { error: Error }) =>
        h("html", { lang: "en" }, h("body", null, h("h2", null, `GE:${p.error.message}`))),
    });
  const manifest = {
    pages: [],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: "global-error.tsx",
  };
  const ge = await runWithContext(
    createRequestContext(new Request("http://x/")),
    () => renderGlobalError(manifest, load, new Error("boom")),
  );
  assert(ge && ge.ownsDocument, "renders its own document");
  assertEquals(ge!.status, 500);
  assert(ge!.html.startsWith("<!DOCTYPE html><html"), ge!.html.slice(0, 40));
  assertEquals((ge!.html.match(/<html/g) ?? []).length, 1);
});
