// A soft navigation streams its deferred values per boundary, as a document load does. A browser
// navigation (`x-denext-defer: 1`) to a Flight route gets its payload at once, each deferred
// value (a Remix `defer()` field, promise data) left as a `{$:"vh"}` hole, then one line per
// value as it settles; the client commits at the payload and resolves each hole's promise as its
// line arrives. Any other soft-nav request (a prefetch, Live's re-render) still gets the complete
// payload with the values resolved.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { openNavStream } from "../src/client/flight-nav-stream.ts";
import type { Component, VNode } from "../src/jsx/types.ts";
import { Suspense, use } from "../src/runtime/suspense.ts";
import { navigate, startClient } from "../src/client/navigation.ts";
import { setFlightParser } from "../src/client/flight-nav.ts";
import { flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** The client component the page hands deferred data to: it suspends on each, as `<Await>` does. */
const Show = ({ v }: { v: unknown }): VNode =>
  h("b", null, String(v instanceof Promise ? use(v) : v));
const Panel = (p: { fast: unknown; slow: unknown }): VNode =>
  h(
    "p",
    null,
    h(Suspense, { fallback: "…", children: h(Show, { v: p.fast }) }),
    h(Suspense, { fallback: "…", children: h(Show, { v: p.slow }) }),
  );
const mod: Record<string, unknown> = { Panel };
tagClientExports(mod, "c_panel");
const registry = new Map<string, Component>([["c_panel#Panel", Panel as Component]]);

/** A deferred value the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => (resolve = a, reject = b));
  return { promise, resolve, reject };
}

function makeApp(props: Record<string, unknown>) {
  const filePath = "/app/page.tsx";
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("d"),
      routePath: "/d",
      filePath,
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
  const Page = () => h("main", null, h(mod.Panel as Component, props));
  return createApp({
    getManifest: () => manifest,
    load: (fp) => Promise.resolve(fp === filePath ? { default: Page } : undefined),
    clientEntryFor: () => "/_denext/entry.js",
    flight: true,
    appDir: "/app",
    flightRoutes: new Set(["/d"]),
  });
}

const navHeaders = { "x-denext-nav": "1", "x-denext-defer": "1" };

Deno.test("a browser soft navigation gets its payload first, then each deferred value as it settles", async () => {
  const fast = deferred<string>();
  const slow = deferred<{ rows: number[] }>();
  const app = makeApp({ fast: fast.promise, slow: slow.promise });
  const res = await app(new Request("http://x/d", { headers: navHeaders }));
  assertEquals(res.headers.get("x-denext-flight"), "1");
  assertEquals(res.headers.get("x-denext-defer"), "1", "the response says it streams values");
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const first = (await reader.read()).value!;
  // Nothing has settled yet, and the payload is already here, holes in place of the values.
  const payload = JSON.parse(first);
  assertStringIncludes(JSON.stringify(payload.flight), `"fast":{"$":"vh","r":"dnxv0"}`);
  assertStringIncludes(JSON.stringify(payload.flight), `"slow":{"$":"vh","r":"dnxv1"}`);
  assertEquals(payload.data.pathname, "/d");

  slow.resolve({ rows: [1, 2] }); // the slow one settles first here: lines follow settle order
  assertEquals((await reader.read()).value, '{"v":"dnxv1","x":{"rows":[1,2]}}\n');
  fast.reject(new Error("gone"));
  assertEquals(
    (await reader.read()).value,
    '{"v":"dnxv0","x":{"__dnxAwaitError":true,"message":"gone"}}\n',
    "a rejection arrives as <Await>'s error marker",
  );
  assert((await reader.read()).done);
});

Deno.test("a soft navigation without x-denext-defer (a prefetch, Live) still gets the values resolved", async () => {
  const app = makeApp({ fast: Promise.resolve("f"), slow: Promise.resolve([3]) });
  const res = await app(new Request("http://x/d", { headers: { "x-denext-nav": "1" } }));
  assertEquals(res.headers.get("x-denext-defer"), null);
  const flight = JSON.stringify((await res.json()).flight);
  assertStringIncludes(flight, `"fast":"f"`);
  assertStringIncludes(flight, `"slow":[3]`);
});

Deno.test("a navigation with nothing deferred is answered as before (one JSON payload)", async () => {
  const app = makeApp({ fast: "now", slow: 1 });
  const res = await app(new Request("http://x/d", { headers: navHeaders }));
  assertEquals(res.headers.get("x-denext-defer"), null);
  assertStringIncludes(JSON.stringify((await res.json()).flight), `"fast":"now"`);
});

// ---- The client half ---------------------------------------------------------------------

/** A navigation response whose body the test writes line by line. */
function streamedResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { headers: { "x-denext-defer": "1" } }),
    write: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
  };
}

const parse = (f: unknown) => parseFlight(f as never, registry);
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

Deno.test("openNavStream: the payload line at once; each hole's promise resolves as its line arrives", async () => {
  const s = streamedResponse();
  const payload = {
    flight: {
      $: "c",
      i: "c_panel#Panel",
      p: { fast: { $: "vh", r: "dnxv0" }, slow: { $: "vh", r: "dnxv1" } },
      c: [],
    },
  };
  s.write(JSON.stringify(payload) + "\n");
  const nav = await openNavStream(s.res, parse);
  assertEquals(JSON.parse(nav.body), payload, "the payload line, before any value");
  const tree = parse(nav.fill(payload.flight)) as Any;
  const { fast, slow } = tree.props as { fast: Promise<unknown>; slow: Promise<unknown> };
  assert(fast instanceof Promise && slow instanceof Promise, "each hole is a promise");
  let fastValue: unknown = "pending";
  fast.then((v) => (fastValue = v));
  await tick();
  assertEquals(fastValue, "pending");
  // A value may hold a Date (and elements, client references): it revives through the parser.
  s.write('{"v":"dnxv0","x":{"at":{"$":"D","v":"2020-01-02T00:00:00.000Z"}}}\n');
  await tick();
  assert((fastValue as { at: Date }).at instanceof Date, "resolved, revived");
  s.write('{"v":"dnxv1","x":{"__dnxAwaitError":true,"message":"gone"}}');
  s.close();
  await assertRejects(() => slow, Error, "gone");
});

Deno.test("openNavStream: a value the stream never sends rejects when it ends", async () => {
  const s = streamedResponse();
  s.write(JSON.stringify({ flight: null }) + "\n");
  const nav = await openNavStream(s.res, parse);
  const lost = nav.fill({ $: "vh", r: "dnxv7" }) as Promise<unknown>;
  s.close();
  await assertRejects(() => lost, Error, "never arrived");
});

// ---- A navigation end to end -------------------------------------------------------------

/** A client component that suspends on its deferred value (what `<Await>` does). */
const Value = ({ v }: { v: Promise<string> }): VNode => h("b", null, use(v));
const Waiter = ({ v }: { v: Promise<string> }): VNode =>
  h(Suspense, { fallback: h("i", null, "…"), children: h(Value, { v }) });
const waiterMod: Record<string, unknown> = { Waiter };
tagClientExports(waiterMod, "c_wait");

Deno.test("a navigation commits at its payload and reveals each boundary as its value arrives", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const d = doc as Any;
  d.body = d.createElement("body");
  d.title = "old";
  const g = globalThis as Any;
  const save = {
    loc: g.location,
    hist: g.history,
    fetch: g.fetch,
    doc: g.document,
    nav: g.__denextNav,
  };
  g.location = { href: "http://x/from", origin: "http://x", pathname: "/from", search: "" };
  g.history = { pushState: () => {}, replaceState: () => {} };
  g.document = doc;
  g.__denextNav = true;
  const s = streamedResponse();
  let asked: Record<string, string> = {};
  g.fetch = ((_u: string, init: { headers: Record<string, string> }) => {
    asked = init.headers;
    return Promise.resolve(
      new Response(s.res.body, {
        headers: { "x-denext-flight": "1", "x-denext-defer": "1" },
      }),
    );
  }) as typeof fetch;
  try {
    const reg = new Map<string, Component>([["c_wait#Waiter", Waiter as Component]]);
    setFlightParser((flight) => parseFlight(flight as Any, reg));
    const div = d.createElement("div");
    div.appendChild(d.createTextNode("A"));
    container.appendChild(div);
    startClient(container as Any, h("div", null, "A"));
    flushSync();
    s.write(
      JSON.stringify({
        flight: {
          $: "h",
          t: "div",
          p: {},
          c: [{ $: "c", i: "c_wait#Waiter", p: { v: { $: "vh", r: "dnxv0" } }, c: [] }],
        },
        title: "To",
        data: { params: {}, searchParams: "", pathname: "/to" },
      }) + "\n",
    );
    await navigate("/to");
    flushSync();
    assertEquals(asked["x-denext-defer"], "1", "a navigation asks for the values streamed");
    assertEquals(container.innerHTML, "<div><i>…</i></div>", "committed at the payload");
    s.write('{"v":"dnxv0","x":"ready"}\n');
    s.close();
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    flushSync();
    assertEquals(container.innerHTML, "<div><b>ready</b></div>", "revealed when its value came");
  } finally {
    for (
      const [k, v] of Object.entries({
        location: save.loc,
        history: save.hist,
        document: save.doc,
        __denextNav: save.nav,
      })
    ) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
    g.fetch = save.fetch;
  }
});
