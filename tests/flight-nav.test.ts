// W6 — RSC/Flight-payload client navigation + per-<Link> useLinkStatus.
//
// Server half: a client (soft) navigation (`x-denext-nav`) to a Flight route
// answers with the JSON Flight payload — not a full HTML document — while a hard
// request and an isomorphic (non-Flight) route keep the HTML path.
//
// Client half: the retained root reconstructs the payload's tree in place, and
// useLinkStatus() reflects only the enclosing <Link>'s navigation.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { FlightNavPayload } from "../src/server/document.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import {
  Link,
  navigate,
  setFlightParser,
  startClient,
  useLinkStatus,
} from "../src/client/navigation.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import type { Component, VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Renders "P"/"-" from the enclosing <Link>'s status (module-scope for hooks). */
const Probe = (): VNode => {
  const { pending } = useLinkStatus();
  return h("i", null, pending ? "P" : "-");
};

const routeBase = {
  kind: "page" as const,
  layoutChain: [],
  templateChain: [],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
};

/** Build a one-route app (Flight or isomorphic) for the server tests. */
function makeFlightApp(directive: "client" | null) {
  const appDir = "/app";
  const filePath = "/app/page.tsx";
  const manifest: RouteManifest = {
    pages: [{ ...routeBase, pattern: parsePattern("flight"), routePath: "/flight", filePath }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: directive ? new Map([[filePath, directive]]) : new Map(),
  };
  const Page = () => h("p", { id: "island" }, "hello");
  const modules: Record<string, unknown> = { [filePath]: { default: Page } };
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(modules[fp]),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir,
  });
}

Deno.test("soft-nav to a Flight route returns the JSON payload, not HTML", async () => {
  const app = makeFlightApp("client");
  const res = await app(
    new Request("http://localhost/flight", { headers: { "x-denext-nav": "1" } }),
  );
  assertEquals(res.headers.get("x-denext-flight"), "1");
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
  // Must not be cacheable by a shared CDN (soft-nav variant).
  assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");

  const payload = await res.json() as FlightNavPayload;
  // A JSON envelope — not an HTML document.
  assert(!JSON.stringify(payload).includes("<!DOCTYPE"), "payload must not be HTML");
  // The page is a client boundary, so the Flight root is a client reference
  // ("$":"c") the browser resolves through the app-wide registry — not expanded
  // HTML. The route data rides alongside it.
  assertStringIncludes(JSON.stringify(payload.flight), `"$":"c"`);
  assertEquals(payload.data.pathname, "/flight");
});

Deno.test("hard request to a Flight route still returns a full HTML document", async () => {
  const app = makeFlightApp("client");
  const res = await app(new Request("http://localhost/flight"));
  assertEquals(res.headers.get("x-denext-flight"), null);
  const body = await res.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assertStringIncludes(body, `id="__denext_flight"`);
});

Deno.test("soft-nav to an isomorphic route falls through to HTML (dual-path)", async () => {
  const app = makeFlightApp(null); // no boundary -> isomorphic
  const res = await app(
    new Request("http://localhost/flight", { headers: { "x-denext-nav": "1" } }),
  );
  assertEquals(res.headers.get("x-denext-flight"), null);
  const body = await res.text();
  assertStringIncludes(body, "<!DOCTYPE html>");
  assert(!body.includes("__denext_flight"), "isomorphic route has no Flight island");
});

Deno.test("useLinkStatus is scoped per <Link>: clicking one link flips only its status", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const g = globalThis as Any;
  const origLoc = g.location, origFetch = g.fetch;
  g.location = { href: "http://x/", origin: "http://x", pathname: "/", search: "" };
  // fetch never settles, so the clicked link stays pending for the assertion.
  g.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
  try {
    createRoot(container as Any).render(
      h(
        "div",
        null,
        h(Link, { href: "/a", id: "la", children: h(Probe, null) }),
        h(Link, { href: "/b", id: "lb", children: h(Probe, null) }),
      ),
    );
    flushSync();
    assertEquals(
      container.innerHTML,
      `<div><a id="la" href="/a"><i>-</i></a><a id="lb" href="/b"><i>-</i></a></div>`,
      "both links idle initially",
    );

    // Click the first link's anchor.
    const first = container.childNodes[0].childNodes[0] as unknown as {
      dispatch: (t: string, e: Record<string, unknown>) => void;
    };
    first.dispatch("click", { button: 0, preventDefault: () => {} });
    flushSync();

    assertEquals(
      container.innerHTML,
      `<div><a id="la" href="/a"><i>P</i></a><a id="lb" href="/b"><i>-</i></a></div>`,
      "only the clicked link reports pending",
    );
  } finally {
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    g.fetch = origFetch;
  }
});

Deno.test("useLinkStatus outside any <Link> is always false", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  createRoot(container as Any).render(h(Probe, null));
  flushSync();
  assertEquals(container.innerHTML, "<i>-</i>");
});

Deno.test("Flight soft-nav reconstructs the payload tree in the retained root", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  // Give the fake document a <body> for the data island + a title slot.
  (doc as Any).body = (doc as Any).createElement("body");
  (doc as Any).title = "old";

  const g = globalThis as Any;
  const origLoc = g.location, origHist = g.history, origFetch = g.fetch, origDoc = g.document;
  const origNav = g.__denextNav;
  g.location = { href: "http://x/from", origin: "http://x", pathname: "/from", search: "" };
  g.history = { pushState: () => {}, replaceState: () => {} };
  g.document = doc;
  g.__denextNav = true; // skip installNavigation (no addEventListener on the fake doc)

  // The soft-nav payload: a host tree the client rebuilds (registry unused here).
  const payload: FlightNavPayload = {
    flight: { $: "h", t: "div", p: {}, c: ["B"] } as Any,
    title: "New Title",
    data: { params: { slug: "b" }, searchParams: "", pathname: "/to" },
  };
  g.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === "x-denext-flight" ? "1" : null) },
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as unknown as Response)) as typeof fetch;

  try {
    const registry = new Map<string, Component>();
    setFlightParser((flight) => parseFlight(flight as Any, registry));

    // Initial mount: server rendered <div>A</div>; hydrate + retain the root.
    const div = (doc as Any).createElement("div");
    div.appendChild((doc as Any).createTextNode("A"));
    container.appendChild(div);
    startClient(container as Any, h("div", null, "A"));
    flushSync();
    assertEquals(container.innerHTML, "<div>A</div>");

    // Soft navigate: the Flight payload replaces the tree in place.
    await navigate("/to");
    flushSync();

    assertEquals(container.innerHTML, "<div>B</div>", "retained root rendered the payload tree");
    assertEquals((doc as Any).title, "New Title", "document.title updated");
    // The #__denext_data island was refreshed so route hooks re-read. (The fake
    // getElementById only indexes registered ids, so read it off <body>.)
    const island = (doc as Any).body.childNodes.find((n: Any) => n.id === "__denext_data");
    assert(island, "data island written");
    assertEquals(JSON.parse(island.textContent).params.slug, "b");
  } finally {
    if (origLoc === undefined) delete g.location;
    else g.location = origLoc;
    if (origHist === undefined) delete g.history;
    else g.history = origHist;
    if (origDoc === undefined) delete g.document;
    else g.document = origDoc;
    if (origNav === undefined) delete g.__denextNav;
    else g.__denextNav = origNav;
    g.fetch = origFetch;
  }
});
