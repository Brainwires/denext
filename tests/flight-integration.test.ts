// deno-lint-ignore-file no-explicit-any -- tests poke Flight node internals + DOM shim.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { useId } from "../src/runtime/hooks.ts";
import { makeDom } from "./helpers/dom.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import { clientIdFor } from "../src/build/module-graph.ts";
import { toFileUrl } from "@std/path";
import type { Component, VNode } from "../src/jsx/types.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

// A server component that consumes a useId, then a client island that does too.
function ServerBadge(): VNode {
  return h("span", null, useId());
}
function Widget(): VNode {
  return h("span", { class: "w" }, useId());
}
const widgetMod = { Widget };
tagClientExports(widgetMod as Record<string, unknown>, "c_w");

Deno.test("unified renderer: server components expand, client islands become refs", async () => {
  const tree = h("div", null, h(ServerBadge, {}), h(Widget, {}));
  const { html, flight } = await renderToHtmlFlight(tree);

  // HTML has both ids in render order (server :d0:, island :d1:).
  assertStringIncludes(html, "<span>:d0:</span>");
  assertStringIncludes(html, `<span class="w">:d1:</span>`);

  // Flight: the server component is expanded; the island is a reference carrying
  // its useId base (1 — one id was consumed before it).
  const kids = (flight as any).c;
  assertEquals(kids[0], { $: "h", t: "span", p: {}, c: [":d0:"] });
  assertEquals(kids[1].$, "c");
  assertEquals(kids[1].i, "c_w#Widget");
  assertEquals(kids[1].p.__dnxIdBase, 1);
});

Deno.test("client reproduces the server's useId via base seeding (B3)", async () => {
  const { flight } = await renderToHtmlFlight(
    h("div", null, h(ServerBadge, {}), h(Widget, {})),
  );
  const island = (flight as any).c[1];

  const { doc, container } = makeDom();
  setDocument(doc as any);
  const registry = new Map<string, Component>([["c_w#Widget", Widget as Component]]);
  const root = createRoot(container as any);
  // Render ONLY the island. Without seeding it would produce :d0:; the recorded
  // base (1) makes the client reproduce the server's :d1:.
  root.render(parseFlight(island, registry) as VNode);
  assertStringIncludes(container.innerHTML, ":d1:");
  assert(!container.innerHTML.includes(":d0:"));
  root.unmount();
});

Deno.test("app embeds the #__denext_flight island for a client route", async () => {
  const appDir = "/app";
  const filePath = "/app/page.tsx";
  const base = {
    kind: "page" as const,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
  const manifest: RouteManifest = {
    pages: [{ ...base, pattern: parsePattern("flight"), routePath: "/flight", filePath }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map([[filePath, "client"]]),
  };
  // A fresh client component tagged by the app's tagging loader on demand.
  const Page = () => h("p", { id: "island" }, "hello from client");
  const modules: Record<string, unknown> = { [filePath]: { default: Page } };

  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir,
  });

  const res = await app(new Request("http://localhost/flight"));
  const body = await res.text();
  // First-paint SSR is present...
  assertStringIncludes(body, `<p id="island">hello from client</p>`);
  // ...alongside the Flight island the client entry hydrates from.
  assertStringIncludes(body, `id="__denext_flight"`);
  const clientId = clientIdFor(appDir, toFileUrl(filePath).href);
  assertStringIncludes(body, `${clientId}#default`);
});

Deno.test("app keeps the isomorphic path for routes with no boundary", async () => {
  const filePath = "/app/plain.tsx";
  const base = {
    kind: "page" as const,
    layoutChain: [],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  };
  const manifest: RouteManifest = {
    pages: [{ ...base, pattern: parsePattern("plain"), routePath: "/plain", filePath }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(), // no directives -> isomorphic
  };
  const modules: Record<string, unknown> = {
    [filePath]: { default: () => h("p", null, "plain") },
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
  });
  const body = await (await app(new Request("http://localhost/plain"))).text();
  assertStringIncludes(body, "<p>plain</p>");
  // No boundary -> no flight island.
  assert(!body.includes("__denext_flight"));
});

// Sanity: the unified renderer's HTML matches renderToString for a plain tree.
Deno.test("unified HTML matches renderToString for an isomorphic tree", async () => {
  const tree = h("section", null, h("h2", null, "Title"), h("p", null, "Body"));
  const { html } = await renderToHtmlFlight(tree);
  assertEquals(html, await renderToString(tree));
});
