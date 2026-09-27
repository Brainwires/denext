// A root layout's <html>/<head>/<body> are rendered nested inside the page container, where
// the browser's HTML parser drops the three tags and keeps their content in place. Every Flight
// tree the server emits (the document's inlined tree, the soft-navigation / refresh payload, a
// streamed page's tail and a PPR shell) mirrors that parsed DOM: the three tags are peeled to
// their children, so the client hydrates the server markup instead of re-creating the page.
// The HTML itself is unchanged.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import type { HeadCollector } from "../src/jsx/render-to-string.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import type { Component, VNode, VNodeChildren } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A client component with no directive: the page ROOT hydrates the whole tree. */
function Counter(): VNode {
  return h("button", { type: "button" }, "0");
}
tagClientExports({ Counter } as Record<string, unknown>, "c_doc");

/** A Next-convention root layout around `children`. */
const nextLayout = (children: VNodeChildren) =>
  h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("title", null, "Doc"),
      h("meta", { name: "description", content: "d" }),
      h("style", null, "p{color:red}"),
    ),
    h("body", { className: "b" }, h("nav", null, h(Counter as Component, null)), children),
  );

const DOCUMENT_TAG = /"t":"(html|head|body)"/;

Deno.test("the Flight tree peels <html>/<head>/<body>; the HTML keeps them", async () => {
  const head = { tags: [] } as unknown as HeadCollector;
  const { html, flight } = await renderToHtmlFlight(nextLayout(h("p", null, "hi")), { head });
  // The HTML is what the server always sent: the tags nested in the page container.
  assertStringIncludes(html, '<html lang="en"><head><style>p{color:red}</style></head>');
  assertStringIncludes(html, '<body class="b"><nav>');
  // The Flight tree is the parsed DOM: no document tags; <title>/<meta> were hoisted into the
  // document head (null here), the <style> stays where it was.
  const json = JSON.stringify(flight);
  assert(!DOCUMENT_TAG.test(json), json);
  assertStringIncludes(json, '{"$":"h","t":"style","p":{},"c":["p{color:red}"]}');
  assertStringIncludes(json, '"t":"nav"');
});

Deno.test("hydrating the peeled tree adopts the parsed DOM (no mismatch, same nodes)", async () => {
  const { flight } = await renderToHtmlFlight(nextLayout(h("p", null, "hi")), {
    head: { tags: [] } as unknown as HeadCollector,
  });
  const registry = new Map<string, Component>([["c_doc#Counter", Counter as Component]]);
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  // The parsed DOM: the server HTML minus the three tags (what the browser's parser builds).
  createRoot(container as Any).render(
    [
      h("style", null, "p{color:red}"),
      h("nav", null, h("button", { type: "button" }, "0")),
      h(
        "p",
        null,
        "hi",
      ),
    ] as unknown as VNode,
  );
  flushSync();
  const before = [...(container as Any).childNodes];
  const moved = new Map<string, Any>(); // a moved container of the same nodes
  const { container: live } = makeDom();
  for (const n of before) (live as Any).appendChild(n);
  moved.set("nav", before[1]);
  let mismatches = 0;
  hydrateRoot(live as Any, parseFlight(flight, registry) as VNode, {
    onRecoverableError: () => mismatches++,
  });
  flushSync();
  assertEquals(mismatches, 0, "the tree matched the parsed DOM");
  assert((live as Any).childNodes[1] === moved.get("nav"), "the server <nav> was adopted");
  assertEquals(
    (live as Any).innerHTML,
    '<style>p{color:red}</style><nav><button type="button">0</button></nav><p>hi</p>',
  );

  // The unpeeled tree (what the server emitted before) cannot adopt it.
  const unpeeled: FlightNode = {
    $: "h",
    t: "html",
    p: {},
    c: [{ $: "h", t: "body", p: {}, c: [flight] }],
  };
  const { container: again } = makeDom();
  for (const n of [...(live as Any).childNodes]) (again as Any).appendChild(n);
  let unpeeledMismatches = 0;
  hydrateRoot(again as Any, parseFlight(unpeeled, registry) as VNode, {
    onRecoverableError: () => unpeeledMismatches++,
  });
  flushSync();
  assert(unpeeledMismatches > 0, "the unpeeled tree mismatched at <html>");
});

// ---- Every document path the server emits a Flight tree on ---------------------------------

const layoutFile = "/app/layout.tsx";
const pageFile = "/app/page.tsx";
const manifest = (): RouteManifest => ({
  pages: [{
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: pageFile,
    layoutChain: [layoutFile],
    templateChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
  }],
  api: [],
  rootLayout: layoutFile,
  rootNotFound: null,
  rootGlobalError: null,
  directives: new Map(),
});

/** A dynamic hole (reads a cookie), so a streamed / PPR page has a tail to fill. */
async function Who(): Promise<VNode> {
  return await Promise.resolve(h("i", null, `hi ${cookies().get("u")?.value ?? "anon"}`));
}

function makeApp(extra: Record<string, unknown>, page: () => VNode) {
  const layout = ({ children }: { children: VNodeChildren }) => nextLayout(children);
  return createApp({
    getManifest: manifest,
    load: (fp) =>
      Promise.resolve(
        fp === layoutFile
          ? { default: layout }
          : fp === pageFile
          ? { default: page, revalidate: 60 }
          : undefined,
      ),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    flightRoutes: new Set(["/"]),
    ...extra,
  });
}

/** The `#__denext_flight` JSON of a document. */
function inlined(body: string): string {
  return /<script id="__denext_flight" type="application\/json">(.*?)<\/script>/s.exec(body)![1];
}

const plainPage = () => h("p", null, "page");
const holePage = () =>
  h("p", null, "page", h(Suspense, { fallback: h("b", null, "…"), children: h(Who, null) }));

Deno.test("buffered document + soft-nav payload: no document tags in the Flight tree", async () => {
  const app = makeApp({}, plainPage);
  const body = await (await app(new Request("http://x/"))).text();
  assertStringIncludes(body, '<html lang="en">'); // the HTML still nests them
  const flight = inlined(body);
  assert(!DOCUMENT_TAG.test(flight), flight);
  assertStringIncludes(flight, "c_doc#Counter");
  const nav = await (await app(new Request("http://x/", { headers: { "x-denext-nav": "1" } })))
    .text();
  assert(!DOCUMENT_TAG.test(nav), nav);
  assertStringIncludes(nav, "c_doc#Counter");
});

Deno.test("streamed document: the tail's Flight tree has no document tags", async () => {
  const app = makeApp({ streaming: true, csp: "off" }, holePage);
  const body = await (await app(new Request("http://x/", { headers: { cookie: "u=ann" } })))
    .text();
  const flight = inlined(body);
  assert(!DOCUMENT_TAG.test(flight), flight);
  assertStringIncludes(flight, "hi ann");
});

Deno.test("PPR shell (MISS and cached HIT): no document tags in the Flight tree", async () => {
  setCacheStore(inMemoryCacheStore());
  const app = makeApp({ pageCache: new PageCache(), cacheComponents: true }, holePage);
  for (const [user, cache] of [["ann", "MISS"], ["bo", "HIT"]]) {
    const res = await app(new Request("http://x/", { headers: { cookie: `u=${user}` } }));
    const body = await res.text();
    assertEquals(res.headers.get("x-denext-cache"), cache);
    const flight = inlined(body);
    assert(!DOCUMENT_TAG.test(flight), flight);
    assertStringIncludes(flight, `hi ${user}`);
  }
});
