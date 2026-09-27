// A page whose client parts are all carved `client:*` islands inlines NO root Flight tree: its
// `#__denext_flight` island is `null` and the only client payload is the islands' own Flight
// (O(island props), not O(page)). The soft-navigation payload keeps the full tree, and the
// client boots such a page root-less: a refresh of the same route adopts the markup and keeps
// the islands' state, another route mounts fresh. Island roots whose wrapper a navigation
// removes are unmounted (their effects clean up).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { flightNeedsRootHydration, inlinedRootFlight } from "../src/jsx/flight-inline.ts";
import { generateFlightEntry } from "../src/build/bundle.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import type { FlightNavPayload } from "../src/server/document.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import {
  discardRetainedRoot,
  navigate,
  setFlightParser,
  startClient,
} from "../src/client/navigation.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import { islandWrapper } from "../src/jsx/island-wrapper.ts";
import { bootResumability } from "../src/client/lazy-boot.ts";
import { makeDom } from "./helpers/dom.ts";
import type { Component, VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- The root-hydration predicate --------------------------------------------------------

const host = (t: string, p: Record<string, unknown>, ...c: FlightNode[]): FlightNode =>
  ({ $: "h", t, p, c }) as FlightNode;
const wrapper = host("div", { __dnxForeign: true, "data-dnx-island": true, "data-dnx-id": "0" });

Deno.test("flightNeedsRootHydration: static hosts, text and island wrappers need no root", () => {
  const tree = [
    host("ul", { className: "l", style: { color: "red" } }, host("li", {}, "a", 1)),
    [
      wrapper,
    ],
    null,
    "x",
  ] as FlightNode;
  assertEquals(flightNeedsRootHydration(tree), false);
  assertEquals(inlinedRootFlight(tree), null);
  // A client error boundary around static children is transparent.
  const boundary = { $: "b", f: "c_err#default", c: [tree] } as FlightNode;
  assertEquals(flightNeedsRootHydration(boundary), false);
  // Codec-tagged data (a Date) in a host prop is data, not something to wire up.
  assertEquals(flightNeedsRootHydration(host("time", { d: { $: "D", v: "2026" } })), false);
});

Deno.test("flightNeedsRootHydration: a client ref or a live host prop keeps the root", () => {
  const ref = { $: "c", i: "c_x#X", p: {}, c: [] } as FlightNode;
  assert(flightNeedsRootHydration(host("div", {}, "a", ref)));
  assert(flightNeedsRootHydration({ $: "b", f: "c_err#default", c: [ref] } as FlightNode));
  // A Server Action on a form, a resumable handler, a channel — even nested in a value.
  assert(flightNeedsRootHydration(host("form", { action: { $: "a", i: "act" } })));
  assert(flightNeedsRootHydration(host("button", { onClick: { $: "e", i: "q#h" } })));
  assert(flightNeedsRootHydration(host("div", { x: [{ y: { $: "ch", i: "c1" } }] })));
  const tree = host("main", {}, ref);
  assertEquals(inlinedRootFlight(tree), tree);
});

// ---- The document payload ------------------------------------------------------------------

/** The one island: a delegated handler with a small prop (its payload is what ships). */
function Delegate(_props: { label: string }): VNode | null {
  return null;
}
/** A client component rendered WITHOUT a directive (the root must hydrate it). */
function Counter(): VNode {
  return h("button", null, "0");
}
const clientMod = { Delegate, Counter };
tagClientExports(clientMod as Record<string, unknown>, "c_islands");

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

/** A one-route Flight app: `rows` static server rows plus `island` (or nothing). */
function makeApp(rows: number, island: () => VNode) {
  const filePath = "/app/page.tsx";
  const manifest: RouteManifest = {
    pages: [{ ...routeBase, pattern: parsePattern("list"), routePath: "/list", filePath }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const Page = () =>
    h(
      "main",
      null,
      island(),
      h(
        "ul",
        { className: "list" },
        Array.from({ length: rows }, (_, i) =>
          h(
            "li",
            { key: i, className: "row", "data-i": i },
            `Row number ${i}`,
            h("span", null, "♡"),
          )),
      ),
    );
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(fp === filePath ? { default: Page } : undefined),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    flightRoutes: new Set(["/list"]),
    appDir: "/app",
  });
}

/** The text of a `<script id>` JSON island in a document ("" when absent). */
function jsonIsland(body: string, id: string): string {
  const m = body.match(
    new RegExp(`<script id="${id}" type="application/json">(.*?)</script>`, "s"),
  );
  return m ? m[1] : "";
}

/** Bytes of every client data payload the page inlines for hydration. */
function inlinedPayloadBytes(body: string): number {
  return ["__denext_flight", "__denext_islands", "__denext_state"]
    .reduce((n, id) => n + new TextEncoder().encode(jsonIsland(body, id)).length, 0);
}

const delegateIsland = () => h(Delegate as Component, { "client:load": true, label: "like" });

Deno.test("an islands page inlines O(island props), not O(page): no root Flight tree", async () => {
  const sizes: number[] = [];
  for (const rows of [10, 2000]) {
    const body = await (await makeApp(rows, delegateIsland)(new Request("http://x/list"))).text();
    // Every row is still server HTML...
    assertStringIncludes(body, `Row number ${rows - 1}`);
    // ...but the root Flight island is `null`, and the island carries only its own props.
    assertEquals(jsonIsland(body, "__denext_flight"), "null");
    assertStringIncludes(jsonIsland(body, "__denext_islands"), `"label":"like"`);
    assertStringIncludes(body, 'data-dnx-strategy="load"');
    sizes.push(inlinedPayloadBytes(body));
  }
  // The same bytes at 10 and 2,000 rows, and small: the island's reference + props.
  assertEquals(sizes[0], sizes[1]);
  assert(sizes[1] < 200, `inlined payload ${sizes[1]} B`);
});

Deno.test("a page whose client component is not a carved island still inlines its tree", async () => {
  const body = await (await makeApp(200, () => h(Counter as Component, null))(
    new Request("http://x/list"),
  )).text();
  const flight = jsonIsland(body, "__denext_flight");
  assertStringIncludes(flight, `"c_islands#Counter"`);
  assertStringIncludes(flight, "Row number 199");
});

Deno.test("the soft-navigation payload of an islands page keeps the full tree", async () => {
  const res = await makeApp(5, delegateIsland)(
    new Request("http://x/list", { headers: { "x-denext-nav": "1" } }),
  );
  assertEquals(res.headers.get("x-denext-flight"), "1");
  const payload = await res.json() as FlightNavPayload;
  assertStringIncludes(JSON.stringify(payload.flight), "Row number 4");
  assertEquals(payload.islands?.length, 1);
});

Deno.test("the generated Flight entry boots a null tree root-less instead of bailing", () => {
  const entry = generateFlightEntry({ client: new Map(), server: new Map() });
  assertStringIncludes(entry, "flight == null ? null : parseFlight(flight, registry)");
  assert(!entry.includes("if (flight == null) return;"), "a null tree must still boot");
  // A page that never loaded the resumability runtime still mounts a soft-nav target's islands:
  // the entry's fallback re-boot hook loads it on demand.
  assertStringIncludes(entry, "setResumabilityReboot((islands, state) =>");
  assertStringIncludes(
    entry,
    "m.bootResumability(registry, true, islands?.length ? islands : undefined, state)",
  );
});

// ---- The client: root-less boot, refresh adoption, navigation, island cleanup --------------

/** A counter island: state + a document `ping` listener (its effect cleanup must run). */
function Pinger(): VNode {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((c) => c + 1);
    document.addEventListener("ping", on);
    return () => document.removeEventListener("ping", on);
  }, []);
  return h("button", null, `pings ${n}`);
}
const registry = new Map<string, Component>([["c_t#Pinger", Pinger as Component]]);
const pingerFlight = { $: "c", i: "c_t#Pinger", p: { __dnxIdPath: "0" }, c: [] } as FlightNode;
const pingerIsland = { id: "0", strategy: "load" as const, flight: pingerFlight };
/** The island's wrapper as the route Flight carries it (an empty foreign host). */
const wrapperFlight = islandWrapper("0", "load", undefined, "").flight;

/** A page's route Flight: a titled paragraph, the island (optional) and a list of rows. */
function pageFlight(
  v: { cls: string; title: string; rows: string[]; island: boolean; footer?: string },
): FlightNode {
  return host(
    "main",
    {},
    host("p", { className: v.cls }, v.title),
    ...(v.island ? [wrapperFlight] : []),
    host("ul", {}, ...v.rows.map((r) => host("li", {}, r))),
    ...(v.footer ? [host("footer", {}, v.footer)] : []),
  );
}

/** A fake browser on `/from` with the page container registered and a Flight-nav fetch stub. */
function fakeBrowser() {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const d = doc as Any;
  d.body.appendChild(container); // in the document: `isConnected` holds
  d.register("__denext", container);
  // `[attr]` queries over the document (the island scan); the fake only knows stylesheets.
  d.querySelectorAll = (sel: string) => {
    const attr = /^\[([\w-]+)\]$/.exec(sel)?.[1];
    const out: Any[] = [];
    const walk = (n: Any) => {
      for (const c of n.childNodes ?? []) {
        if (c.nodeType === 1 && attr && c.hasAttribute(attr)) out.push(c);
        walk(c);
      }
    };
    walk(d.body);
    return out;
  };
  const g = globalThis as Any;
  const keys = ["location", "history", "fetch", "document", "__denextNav", "__dnxRoot"];
  const saved = keys.map((k) => [k, g[k]] as const);
  g.location = { href: "http://x/from", origin: "http://x", pathname: "/from", search: "" };
  g.history = { pushState: () => {}, replaceState: () => {} };
  g.document = doc;
  g.__denextNav = true; // skip installNavigation (no click interception needed)
  discardRetainedRoot();
  let next: FlightNavPayload | null = null;
  g.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === "x-denext-flight" ? "1" : null) },
      text: () => Promise.resolve(JSON.stringify(next)),
    });
  setFlightParser((flight) => parseFlight(flight as Any, registry));
  return {
    d,
    container: container as Any,
    /** Serve `flight` (+ its islands) as the next Flight-nav response. */
    serve(flight: FlightNode, islands = [pingerIsland]) {
      next = {
        flight: flight as Any,
        data: { params: {}, searchParams: "", pathname: "/" },
        islands,
      };
    },
    pings: () => d.docListeners.get("ping")?.size ?? 0,
    restore() {
      discardRetainedRoot(); // a fresh page load has none: the next test boots root-less
      for (const [k, v] of saved) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

/** Server-render `flight` into the container as the page's markup (the island SSR'd inside). */
function serverMarkup(container: Any, flight: FlightNode): void {
  const scratch = createRoot(container);
  scratch.render(parseFlight(flight, new Map()) as VNode);
  flushSync();
  const w = container.childNodes[0].childNodes.find((n: Any) => n.hasAttribute?.("data-dnx-id"));
  if (w) {
    const b = container.ownerDocument.createElement("button");
    b.appendChild(container.ownerDocument.createTextNode("pings 0"));
    w.appendChild(b);
  }
}

/** Let the island chunks resolve (hydration awaits them) and commit. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** Boot a root-less islands page the way the generated entry does. */
async function bootRootless(env: ReturnType<typeof fakeBrowser>, flight: FlightNode) {
  serverMarkup(env.container, flight);
  const map = env.d.createElement("script");
  map.textContent = JSON.stringify({ "0": pingerFlight });
  env.d.register("__denext_islands", map);
  startClient(env.container, null);
  bootResumability(registry);
  await settle();
}

const v1 = { cls: "a", title: "v1", rows: ["r1", "r2", "r3"], island: true };

Deno.test("a root-less page: a same-route refresh adopts the markup and keeps island state", async () => {
  const env = fakeBrowser();
  try {
    await bootRootless(env, pageFlight(v1));
    assertEquals((globalThis as Any).__dnxRoot, null, "no root hydrated for an islands page");
    env.d.dispatch("ping");
    flushSync();
    assertStringIncludes(env.container.innerHTML, "pings 1");
    // A static attribute the refreshed output drops must go (server markup had data-x).
    env.container.childNodes[0].childNodes[0].setAttribute("data-x", "stale");

    // A Server Action's refresh(): the same route, with CHANGED server output.
    const v2 = { cls: "b", title: "v2", rows: ["r1", "r2*"], island: true, footer: "f" };
    env.serve(pageFlight(v2));
    await navigate("/from", { history: false });
    await settle();
    const html = env.container.innerHTML;
    assertStringIncludes(html, '<p class="b">v2</p>', "text + attributes patched, stale removed");
    assertStringIncludes(html, "<ul><li>r1</li><li>r2*</li></ul>", "rows patched and pruned");
    assertStringIncludes(html, "<footer>f</footer>", "a new node was added");
    assertStringIncludes(html, "pings 1", "the island kept its state (not remounted)");
    assertEquals(env.pings(), 1, "one live listener: the island was neither dropped nor doubled");
    env.d.dispatch("ping");
    flushSync();
    assertStringIncludes(env.container.innerHTML, "pings 2", "the island is still live");
    // A later refresh (through the retained root) reconciles in place: still the same island.
    env.serve(pageFlight({ ...v2, title: "v3" }));
    await navigate("/from", { history: false });
    await settle();
    assertStringIncludes(env.container.innerHTML, '<p class="b">v3</p>');
    assertStringIncludes(env.container.innerHTML, "pings 2", "island state kept again");
    assert((globalThis as Any).__dnxRoot, "the adopted root is retained");
  } finally {
    env.restore();
  }
});

Deno.test("a retained root that removes an island's wrapper unmounts the island (listener gone)", async () => {
  const env = fakeBrowser();
  try {
    await bootRootless(env, pageFlight(v1));
    env.serve(pageFlight({ ...v1, title: "same" })); // adopt: now a retained root
    await navigate("/from", { history: false });
    await settle();
    assertEquals(env.pings(), 1);
    // A refresh whose output no longer renders the island: the retained root deletes its
    // wrapper; the island's root must unmount, running its effect cleanup.
    env.serve(pageFlight({ ...v1, island: false }), []);
    await navigate("/from", { history: false });
    await settle();
    assert(!env.container.innerHTML.includes("pings"), "the wrapper is gone");
    assertEquals(env.pings(), 0, "the island's document listener was removed");
  } finally {
    env.restore();
  }
});

Deno.test("a retained root that re-keys an island's wrapper remounts the new island", async () => {
  const env = fakeBrowser();
  try {
    await bootRootless(env, pageFlight(v1));
    env.serve(pageFlight(v1)); // adopt: now a retained root
    await navigate("/from", { history: false });
    await settle();
    env.d.dispatch("ping");
    flushSync();
    assertStringIncludes(env.container.innerHTML, "pings 1");
    // The same wrapper element now carries ANOTHER island (id "9"): the old island unmounts
    // (its listener goes) and the new one mounts in the wrapper, from its own Flight.
    const other = { $: "c", i: "c_t#Pinger", p: { __dnxIdPath: "9" }, c: [] } as FlightNode;
    const rekeyed = islandWrapper("9", "load", undefined, "").flight;
    env.serve(host("main", {}, host("p", { className: "a" }, "v1"), rekeyed), [
      { id: "9", strategy: "load", flight: other },
    ]);
    await navigate("/from", { history: false });
    await settle();
    assertStringIncludes(env.container.innerHTML, 'data-dnx-id="9"');
    assertStringIncludes(env.container.innerHTML, "pings 0", "a fresh island, not the old one");
    assertEquals(env.pings(), 1, "exactly one live listener: the old island's was removed");
  } finally {
    env.restore();
  }
});

Deno.test("an HTML nav whose re-run entry drops the island (target has none) unmounts it", async () => {
  const env = fakeBrowser();
  const g = globalThis as Any;
  const saveParser = g.DOMParser;
  const saveAppend = env.d.body.appendChild;
  try {
    await bootRootless(env, pageFlight(v1));
    env.serve(pageFlight(v1)); // adopt: now a retained root with a live island
    await navigate("/from", { history: false });
    await settle();
    assertEquals(env.pings(), 1);
    // A plain-HTML soft nav (static export) to a Flight page with NO islands: the retained root
    // stays, and the page's re-run entry reconciles it — dropping the island's wrapper.
    g.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve("<html></html>"),
      });
    const found: Record<string, unknown> = {
      __denext: { innerHTML: "<main><p>next</p></main>" },
      __denext_flight: { textContent: "[]" }, // a root that hydrates (not root-less)
    };
    g.DOMParser = class {
      parseFromString() {
        return {
          getElementById: (id: string) => found[id] ?? null,
          querySelector: (sel: string) =>
            sel.startsWith("script") ? { getAttribute: () => "/entry.js" } : null,
        };
      }
    };
    // The injected entry "runs": it renders the new route through the retained root.
    env.d.body.appendChild = function (node: Any) {
      const out = saveAppend.call(this, node);
      if (node.tagName === "SCRIPT") {
        startClient(env.container, h("main", null, h("p", null, "next")));
        node.dispatch("load");
      }
      return out;
    };
    await navigate("/next");
    await settle();
    assertEquals(env.container.innerHTML, "<main><p>next</p></main>");
    assertEquals(env.pings(), 0, "the dropped island's listener was removed");
  } finally {
    env.d.body.appendChild = saveAppend;
    if (saveParser === undefined) delete g.DOMParser;
    else g.DOMParser = saveParser;
    env.restore();
  }
});

Deno.test("a root-less page's navigation to ANOTHER route mounts fresh (islands torn down)", async () => {
  const env = fakeBrowser();
  try {
    await bootRootless(env, pageFlight(v1));
    assertEquals(env.pings(), 1);
    env.serve(host("div", {}, "B"), []);
    await navigate("/to");
    await settle();
    assertEquals(env.container.innerHTML, "<div>B</div>", "a fresh root rendered the payload");
    assertEquals(env.pings(), 0, "the old page's island was unmounted");
    assert((globalThis as Any).__dnxRoot, "the fresh root is retained for later navigations");
  } finally {
    env.restore();
  }
});
