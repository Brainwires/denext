// Dev-only per-Suspense-boundary server timing: `renderToReadableStream` with
// `collectBoundaryTiming` records each boundary's server resolve duration and emits a
// `#__denext_boundary_timing` JSON island at the end of the stream (a CSP-safe data
// block, not executed) for the DevTools per-boundary timeline. Off by default.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToReadableStream } from "../src/jsx/render-to-stream.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode } from "../src/jsx/types.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

function suspenseTree(): VNode {
  const read = createResource(() => Promise.resolve("done"));
  const Slow = (): VNode => h("p", null, read());
  return h("div", null, h(Suspense, { fallback: h("p", null, "…"), children: h(Slow, null) }));
}

Deno.test("collectBoundaryTiming emits a #__denext_boundary_timing island", async () => {
  const html = await collect(
    renderToReadableStream(suspenseTree(), { collectBoundaryTiming: true }),
  );
  assertStringIncludes(html, 'id="__denext_boundary_timing"');
  const m = html.match(/id="__denext_boundary_timing">(\[.*?\])<\/script>/);
  assert(m, "timing island present");
  const timings = JSON.parse(m![1]) as Array<{ id: string; ms: number }>;
  assertEquals(timings.length, 1);
  assertEquals(timings[0].id, "dnx0");
  assert(typeof timings[0].ms === "number" && timings[0].ms >= 0, "numeric ms");
});

Deno.test("no timing island without the flag (production default)", async () => {
  const html = await collect(renderToReadableStream(suspenseTree()));
  assert(!html.includes("__denext_boundary_timing"), "no island when the flag is off");
  // The boundary still streamed normally.
  assertStringIncludes(html, "data-dnx-r=");
});

function manifest(): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [{ ...base, pattern: parsePattern("/"), routePath: "/", filePath: "home.tsx" }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("a dev streamed page emits the boundary-timing island end-to-end", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    const read = createResource(() => Promise.resolve("done"));
    const Slow = (): VNode => h("strong", null, read());
    const Page = (): VNode =>
      h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
    const app = createApp({
      getManifest: manifest,
      load: (fp: string) => Promise.resolve(fp === "home.tsx" ? { default: Page } : undefined),
    });
    const res = await app(new Request("http://localhost/"));
    const html = await res.text();
    assertStringIncludes(html, "__denext_boundary_timing");
    assertStringIncludes(html, '"id":"dnx0"');
  } finally {
    g.__denextDev = prev;
  }
});
