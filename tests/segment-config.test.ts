import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  DEFAULT_SEGMENT_CONFIG,
  mergeSegmentConfig,
  readSegmentConfig,
} from "../src/server/segment-config.ts";
import { renderPage } from "../src/server/render-page.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageMatch } from "../src/router/match.ts";
import type { PageProps } from "../src/server/types.ts";

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
