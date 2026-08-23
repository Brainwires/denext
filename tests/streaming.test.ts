// Incremental (Suspense) streaming for non-PPR routes (experimental.streaming).
// Streamed responses now carry the same strict hash-based CSP as buffered ones (the
// swap runtime is a hashed constant), so streaming is no longer gated by CSP. Covers:
// the head-collecting shell render, end-to-end streaming through createApp, the
// single swap runtime + streaming CSP, and a control signal thrown in the shell
// falling back to a buffered response.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type HeadCollector, renderShell } from "../src/jsx/render-to-stream.ts";
import { swapRuntimeHash } from "../src/server/swap-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { notFound } from "../src/runtime/error-boundary.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";
import type { VNode } from "../src/jsx/types.ts";

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

function appWith(homeModule: unknown, extra: Record<string, unknown> = {}) {
  return createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? homeModule : undefined),
    ...extra,
  });
}

// ---- head-collecting shell render ------------------------------------------

Deno.test("renderShell hoists in-tree <title>/<meta> out of the shell", async () => {
  const head: HeadCollector = { tags: [] };
  const sr = await renderShell(
    h(
      "div",
      null,
      h("title", null, "Hello"),
      h("meta", { name: "description", content: "d" }),
      h("p", null, "body"),
    ),
    head,
  );
  assertEquals(head.title, "Hello");
  assert(head.tags.some((t) => t.includes('name="description"')), "meta collected");
  assert(!sr.shell.includes("<title>"), "title hoisted out of the shell body");
  assertStringIncludes(sr.shell, "<p>body</p>");
});

// ---- end-to-end streaming --------------------------------------------------

Deno.test("streaming + csp:'off': a Suspense route streams shell then swaps in content", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));

  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-security-policy"), null, "streamed → no CSP");
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");

  queueMicrotask(() => resolveData("streamed!"));
  const html = await res.text();
  assertStringIncludes(html, 'data-dnx-b="dnx0"'); // shell placeholder
  assertStringIncludes(html, "Loading…"); // fallback in shell
  assertStringIncludes(html, "<strong>streamed!</strong>"); // streamed hole content
  assertStringIncludes(html, '<template data-dnx-r="dnx0">'); // hole streamed as a template
  // One swap runtime for the whole document; no per-hole inline script.
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
  assertEquals(html.split("MutationObserver").length - 1, 1, "exactly one swap runtime");
  assert(html.indexOf("Loading") < html.indexOf("streamed!"), "shell precedes hole");
});

Deno.test("streaming hoists a shell <title> into the streamed <head>", async () => {
  const Page = (_p: PageProps): VNode => h("div", null, h("title", null, "Streamed Title"), "hi");
  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  const html = await res.text();
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  assertStringIncludes(head, "<title>Streamed Title</title>"); // hoisted into <head>
  assert(!html.slice(html.indexOf("<body>")).includes("<title>"), "not left in the body");
});

// ---- the streaming CSP -----------------------------------------------------

Deno.test("streaming under a strict CSP: streams AND carries the hash-based CSP", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));

  // Default global csp is "strict" — the route is still streamed, and the response
  // carries a strict CSP whose script-src includes the swap runtime's hash.
  const app = appWith({ default: Page }, { streaming: true });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert(csp, "streamed route keeps a CSP");
  assertStringIncludes(csp!, `script-src 'self' ${await swapRuntimeHash()}`);
  assertStringIncludes(csp!, "object-src 'none'");

  queueMicrotask(() => resolveData("streamed!"));
  const html = await res.text();
  assertStringIncludes(html, '<template data-dnx-r="dnx0">'); // still streamed
  assertStringIncludes(html, "<strong>streamed!</strong>");
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
});

// ---- control signal in the shell -------------------------------------------

Deno.test("notFound() during a streamed shell falls back to a buffered 404", async () => {
  const app = appWith(
    { default: () => notFound(), notFound: "nf.tsx" },
    { streaming: true, csp: "off" },
  );
  // The route has no nf.tsx module registered → default 404 UI, but crucially a 404
  // status (not a 200 stream): the control signal was caught before any flush.
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 404);
  const html = await res.text();
  // A control-signal page is buffered (renderDocument), not streamed: no swap
  // runtime and no streamed-hole template.
  assert(!html.includes("data-dnx-r"), "a control-signal page is buffered, not streamed");
  assert(!html.includes("MutationObserver"), "no swap runtime on a buffered page");
});
