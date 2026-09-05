import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  DEFAULT_SEGMENT_CONFIG,
  mergeSegmentConfig,
  readSegmentConfig,
} from "../src/server/segment-config.ts";
import { renderPage } from "../src/server/render-page.ts";
import {
  cookies,
  createRequestContext,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageMatch } from "../src/router/match.ts";
import type { PageProps } from "../src/server/types.ts";

/** A minimal page match for `page.tsx` with the given params + optional layout. */
function pageMatch(params: Record<string, string> = {}): PageMatch {
  return {
    route: {
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
    },
    params,
  };
}

Deno.test("readSegmentConfig falls back to defaults", () => {
  assertEquals(readSegmentConfig({}), DEFAULT_SEGMENT_CONFIG);
  assertEquals(readSegmentConfig(undefined), DEFAULT_SEGMENT_CONFIG);
});

Deno.test("readSegmentConfig reads valid fields and ignores invalid ones", () => {
  const cfg = readSegmentConfig({
    dynamic: "force-dynamic",
    revalidate: 60,
    dynamicParams: false,
    runtime: "edge",
    maxDuration: 10,
  });
  assertEquals(cfg.dynamic, "force-dynamic");
  assertEquals(cfg.revalidate, 60);
  assertEquals(cfg.dynamicParams, false);
  assertEquals(cfg.runtime, "edge");
  assertEquals(cfg.maxDuration, 10);

  // Invalid values are dropped in favor of defaults.
  const bad = readSegmentConfig({ dynamic: "nonsense", revalidate: -5 });
  assertEquals(bad.dynamic, "auto");
  assertEquals(bad.revalidate, false);
});

Deno.test("mergeSegmentConfig: child overrides, shortest revalidate wins", () => {
  const parent = readSegmentConfig({ revalidate: 100, dynamic: "force-static" });
  const child = readSegmentConfig({ revalidate: 30 });
  const merged = mergeSegmentConfig(parent, child);
  assertEquals(merged.revalidate, 30); // shortest wins
  assertEquals(merged.dynamic, "auto"); // child's default overrides parent

  // false means "infinite" — the numeric side wins.
  assertEquals(
    mergeSegmentConfig(
      readSegmentConfig({ revalidate: false }),
      readSegmentConfig({ revalidate: 15 }),
    ).revalidate,
    15,
  );
});

Deno.test("readSegmentConfig normalizes the three-state csp export", () => {
  assertEquals(readSegmentConfig({ csp: "off" }).csp, "off");
  assertEquals(readSegmentConfig({ csp: false }).csp, "off");
  assertEquals(readSegmentConfig({ csp: "strict" }).csp, "strict");
  assertEquals(readSegmentConfig({ csp: true }).csp, "strict");
  assertEquals(readSegmentConfig({ csp: { scriptSrc: ["https://x.io"] } }).csp, {
    scriptSrc: ["https://x.io"],
  });
  assertEquals(readSegmentConfig({}).csp, undefined); // unset ⇒ inherit
});

Deno.test("mergeSegmentConfig: csp child toggle overrides; opt-in objects union", () => {
  const csp = (v: unknown) => readSegmentConfig({ csp: v });
  // Child 'off' overrides a parent's opt-ins.
  assertEquals(mergeSegmentConfig(csp({ scriptSrc: ["https://a"] }), csp("off")).csp, "off");
  // Child 'strict' overrides a parent's opt-ins.
  assertEquals(mergeSegmentConfig(csp({ scriptSrc: ["https://a"] }), csp("strict")).csp, "strict");
  // Two opt-in objects UNION down the chain.
  assertEquals(
    mergeSegmentConfig(csp({ scriptSrc: ["https://a"] }), csp({ scriptSrc: ["https://b"] })).csp,
    { scriptSrc: ["https://a", "https://b"] },
  );
  // Child unset inherits the parent.
  assertEquals(mergeSegmentConfig(csp("off"), csp(undefined)).csp, "off");
  // A child opt-in object re-enables over a parent 'off'.
  assertEquals(mergeSegmentConfig(csp("off"), csp({ imgSrc: ["https://c"] })).csp, {
    imgSrc: ["https://c"],
  });
});

Deno.test("renderPage merges the layout chain config under the page config", async () => {
  const modules: Record<string, unknown> = {
    "layout.tsx": {
      default: (p: { children: unknown }) => h("div", null, p.children as never),
      revalidate: 300,
    },
    "page.tsx": {
      default: (_p: PageProps) => h("h1", null, "hi"),
      revalidate: 60,
      dynamic: "force-static",
    },
  };
  const match: PageMatch = {
    route: {
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
      layoutChain: ["layout.tsx"],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    },
    params: {},
  };
  const { config } = await renderPage(
    match,
    new Request("http://x/x"),
    (fp) => Promise.resolve(modules[fp]),
  );
  assertEquals(config.revalidate, 60); // min(300, 60)
  assertEquals(config.dynamic, "force-static"); // from the page
});

// ---- honored behaviors: dynamic="error", force-static, dynamicParams ----------

Deno.test('dynamic="error" makes a dynamic API throw during render', async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": {
      default: (_p: PageProps) => h("h1", null, headers().get("x") ?? "x"),
      dynamic: "error",
    },
  };
  const req = new Request("http://x/x");
  const ctx = createRequestContext(req);
  await runWithContext(ctx, async () => {
    const err = await assertRejects(() =>
      renderPage(pageMatch(), req, (fp) => Promise.resolve(modules[fp]))
    );
    assertStringIncludes(String(err), 'dynamic = "error"');
  });
});

Deno.test("force-static empties dynamic APIs and keeps the render cacheable", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": {
      // Reads cookies + headers; under force-static both are empty (no throw).
      default: (_p: PageProps) =>
        h("h1", null, `${cookies().get("u")?.value ?? "anon"}/${headers().get("x") ?? "none"}`),
      dynamic: "force-static",
    },
  };
  const req = new Request("http://x/x", { headers: { cookie: "u=alice", x: "hi" } });
  const ctx = createRequestContext(req);
  const rendered = await runWithContext(
    ctx,
    () => renderPage(pageMatch(), req, (fp) => Promise.resolve(modules[fp])),
  );
  assertStringIncludes(rendered.html, "anon/none"); // dynamic reads came back empty
  assertEquals(rendered.status, 200);
  // Crucially: the render did NOT mark itself dynamic, so the page still caches.
  assert(!ctx.usedDynamicApi, "force-static reads must not mark the render dynamic");
});

Deno.test("dynamicParams:false 404s a param outside generateStaticParams", async () => {
  const modules: Record<string, unknown> = {
    "page.tsx": {
      default: (p: PageProps) => h("h1", null, String(p.params.slug)),
      dynamicParams: false,
      generateStaticParams: () => [{ slug: "a" }],
    },
  };
  const load = (fp: string) => Promise.resolve(modules[fp]);
  const req = new Request("http://x/x");

  // An enumerated param renders normally.
  const ok = await runWithContext(
    createRequestContext(req),
    () => renderPage(pageMatch({ slug: "a" }), req, load),
  );
  assertEquals(ok.status, 200);
  assertStringIncludes(ok.html, "a");

  // A non-enumerated param 404s.
  const gone = await runWithContext(
    createRequestContext(req),
    () => renderPage(pageMatch({ slug: "b" }), req, load),
  );
  assertEquals(gone.status, 404);
});
