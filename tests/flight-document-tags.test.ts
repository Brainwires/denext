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
import { inMemoryCacheStore, PageCache, pageStoreKey, setCacheStore } from "../src/server/cache.ts";
import { cookies } from "../src/server/request-context.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { createRoot, flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import type { HeadCollector } from "../src/jsx/render-to-string.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import type { Component, VNode, VNodeChildren } from "../src/jsx/types.ts";
import { makeDom } from "./helpers/dom.ts";
import { useState } from "../src/runtime/hooks.ts";
import { hydratedFlight } from "./helpers/streamed-flight.ts";

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

  // The unpeeled tree (what the server emitted before the peel, and what a root layout rendered
  // by client code still renders) adopts it too: its <html>/<body> are the page's own (singletons).
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
  assertEquals(unpeeledMismatches, 0, "the unpeeled tree adopts the parsed DOM too");
  assert((again as Any).childNodes[1] === moved.get("nav"), "…keeping the server <nav>");
});

// ---- A root layout rendered by CLIENT code (a "use client" layout) -------------------------

/** A client root layout: its <html>/<body> attributes follow state, its body hosts the page. */
function clientLayout(theme: string, children: VNodeChildren): VNode {
  return h(
    "html",
    { lang: "fr", className: theme, suppressHydrationWarning: true },
    h("head", null, h("style", null, "p{color:red}")),
    h(
      "body",
      { className: "b", "data-theme": theme },
      h("nav", null, h("button", { type: "button" }, "0")),
      children,
    ),
  );
}

Deno.test("a client-rendered root layout hydrates in place: same nodes, no mismatch, attributes on the real tags", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  (doc.body as Any).appendChild(container);
  (doc.documentElement as Any).setAttribute("lang", "en"); // denext's own, before the client runs
  // The parsed server DOM: the browser dropped the nested <html>/<head>/<body>, kept the rest.
  createRoot(container as Any).render(
    [
      h("style", null, "p{color:red}"),
      h("nav", null, h("button", { type: "button" }, "0")),
      h("p", null, "hi"),
    ] as unknown as VNode,
  );
  flushSync();
  const before = [...(container as Any).childNodes];
  const live = doc.createElement("div"); // a fresh page container in the SAME document
  (doc.body as Any).appendChild(live);
  for (const n of before) (live as Any).appendChild(n);
  (doc.body as Any).removeChild(container);

  let setTheme: (t: string) => void = () => {};
  function Layout(): VNode {
    const [theme, set] = useState("dark");
    setTheme = set;
    return clientLayout(theme, h("p", null, "hi"));
  }
  let mismatches = 0;
  hydrateRoot(live as Any, h(Layout as Component, null), {
    onRecoverableError: () => mismatches++,
  });
  flushSync();
  assertEquals(mismatches, 0, "the client layout's tree matched the parsed DOM");
  assertEquals(
    [...(live as Any).childNodes],
    before,
    "every server node was adopted, none re-created",
  );
  assertEquals(
    (live as Any).innerHTML,
    '<style>p{color:red}</style><nav><button type="button">0</button></nav><p>hi</p>',
    "no <html>/<head>/<body> element was created inside the page container",
  );
  const html = doc.documentElement as Any;
  const body = doc.body as Any;
  assertEquals(html.getAttribute("lang"), "fr", "the layout's attributes land on the real <html>");
  assertEquals(html.getAttribute("class"), "dark");
  assertEquals(body.getAttribute("class"), "b");
  assertEquals((html.childNodes as Any[]).filter((n) => n.tagName === "BODY").length, 1);

  setTheme("light"); // a state change re-renders the layout: the real tags are updated in place
  flushSync();
  assertEquals(html.getAttribute("class"), "light");
  assertEquals(body.getAttribute("data-theme"), "light");
  assertEquals([...(live as Any).childNodes], before, "and the page content is untouched");
});

Deno.test("a client root layout rendered fresh (no server markup) puts its content in the container", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  (doc.body as Any).appendChild(container);
  createRoot(container as Any).render(clientLayout("dark", h("p", null, "page")));
  flushSync();
  assertEquals(
    (container as Any).innerHTML,
    '<style>p{color:red}</style><nav><button type="button">0</button></nav><p>page</p>',
  );
  assertEquals((doc.documentElement as Any).getAttribute("class"), "dark");
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

function makeApp(
  extra: Record<string, unknown>,
  page: () => VNode,
  shell: (children: VNodeChildren) => VNode = nextLayout,
) {
  const layout = ({ children }: { children: VNodeChildren }) => shell(children);
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
/** The Flight tree the browser hydrates from `body`, as JSON (streamed chunks put back). */
function inlined(body: string): string {
  return JSON.stringify(hydratedFlight(body));
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

Deno.test("a page cached before the Flight format change is never served after the upgrade", async () => {
  // The durable store is not keyed per build: a shell cached by an older denext (its Flight
  // tree still wrapped in <html>/<body>) sits under the old, unversioned key. The page-cache
  // format version keeps it from being read — the upgrade renders (and caches) afresh.
  const store = inMemoryCacheStore();
  setCacheStore(store);
  await store.setPage("/", {
    body: "<!DOCTYPE html><html><body>OLD SHELL</body></html>",
    status: 200,
    path: "/",
    expiresAt: Infinity,
    tags: [],
    flightShell: { $: "h", t: "html", p: {}, c: [] },
  });
  const app = makeApp({ pageCache: new PageCache(), cacheComponents: true }, holePage);
  const res = await app(new Request("http://x/", { headers: { cookie: "u=cy" } }));
  const body = await res.text();
  assertEquals(res.headers.get("x-denext-cache"), "MISS");
  assert(!body.includes("OLD SHELL"), "the pre-upgrade entry was not served");
  assert(!DOCUMENT_TAG.test(inlined(body)));
  assert(await store.getPage(pageStoreKey("/")), "the fresh shell is cached under the new format");
});

// ---- The layout's <html>/<body> attributes reach the real document tags ---------------------

/** A root layout whose document tags carry attributes (and a React-only prop). */
const frLayout = (children: VNodeChildren) =>
  h(
    "html",
    { lang: "fr", dir: "rtl", className: "dark", suppressHydrationWarning: true },
    h("body", { className: "b", "data-theme": "night" }, h(Counter as Component, null), children),
  );

/** The document's real (first) `<html …>` and `<body …>` open tags. */
function documentTags(body: string): { html: string; body: string } {
  return { html: /<html[^>]*>/.exec(body)![0], body: /<body[^>]*>/.exec(body)![0] };
}

function assertFrenchDocument(body: string): void {
  const tags = documentTags(body);
  assertEquals(tags.html, '<html lang="fr" dir="rtl" class="dark">');
  assertEquals(tags.body, '<body class="b" data-theme="night">');
}

Deno.test("a root layout's <html>/<body> attributes land on the real tags (buffered)", async () => {
  const app = makeApp({}, plainPage, frLayout);
  assertFrenchDocument(await (await app(new Request("http://x/"))).text());
});

Deno.test("a root layout's <html>/<body> attributes land on the real tags (streamed)", async () => {
  const app = makeApp({ streaming: true, csp: "off" }, holePage, frLayout);
  const res = await app(new Request("http://x/", { headers: { cookie: "u=ann" } }));
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  // The first flushed chunk already carries them: streaming is not held back.
  assertFrenchDocument(first);
  await reader.cancel();
});

Deno.test("a root layout's <html>/<body> attributes survive a PPR cache hit", async () => {
  setCacheStore(inMemoryCacheStore());
  const app = makeApp({ pageCache: new PageCache(), cacheComponents: true }, holePage, frLayout);
  for (const cache of ["MISS", "HIT"]) {
    const res = await app(new Request("http://x/", { headers: { cookie: "u=ann" } }));
    assertEquals(res.headers.get("x-denext-cache"), cache);
    assertFrenchDocument(await res.text());
  }
});

Deno.test("a non-Flight page's root layout attributes land on the real tags too", async () => {
  const app = makeApp(
    { flight: false, flightRoutes: undefined },
    plainPage,
    (children) => h("html", { lang: "de" }, h("body", { className: "plain" }, children)),
  );
  const body = await (await app(new Request("http://x/"))).text();
  assertEquals(documentTags(body).html, '<html lang="de">');
  assertEquals(documentTags(body).body, '<body class="plain">');
});
