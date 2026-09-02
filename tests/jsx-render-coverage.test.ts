// Additional server-side render coverage for the jsx render pipeline:
// Flight (`renderToFlight`), the dual HTML+Flight renderer (`renderToHtmlFlight`),
// the streaming Flight renderer (`renderToFlightStream` / `flightTailScripts`),
// and the PPR shell/resume passes (HTML + Flight). These drive the branches around
// providers, Suspense retries, error boundaries, prop serialization, islands,
// signals, and value-holes — all browser-free.

// deno-lint-ignore-file no-explicit-any -- tests poke at Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { FRAGMENT, type VNode } from "../src/jsx/types.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { createContext } from "../src/runtime/context.ts";
import { useSignal } from "../src/runtime/signals.ts";
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "../src/runtime/hooks.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";

import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight, serializeFlight } from "../src/jsx/render-to-html-flight.ts";
import {
  flightTailScripts,
  renderFlightShell,
  renderToFlightStream,
} from "../src/jsx/render-to-flight-stream.ts";
import { streamToString } from "../src/jsx/render-to-stream.ts";
import type { HeadCollector } from "../src/jsx/render-to-string.ts";
import { prerenderToShell, resumeShellHoles, spliceShellHoles } from "../src/jsx/render-to-ppr.ts";
import {
  fillFlightHoles,
  prerenderToShellFlight,
  resumeShellHolesFlight,
} from "../src/jsx/render-to-ppr-flight.ts";
import { withPrerender } from "../src/runtime/prerender.ts";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";

// ── shared fixtures ──────────────────────────────────────────────────────────
function Island(): VNode {
  return h("button", { class: "isl" }, "island");
}
const islandMod = { Island };
tagClientExports(islandMod as Record<string, unknown>, "c_isl");

const emptyHead = (): HeadCollector => ({ tags: [] });

// ── renderToFlight: providers, arrays/objects, VNode props, non-serializables ──

Deno.test("flight: a context provider is transparent (children expand, no provider node)", async () => {
  const Ctx = createContext("default");
  function Reader() {
    return h("span", null, useContext(Ctx));
  }
  const tree = h("div", null, h(Ctx.Provider, { value: "ok" }, h(Reader, null)));
  const flight = await renderToFlight(tree) as any;
  // The provider fragment is transparent: it expands to just the reader's <span>.
  assertEquals(flight.$, "h");
  assertEquals(flight.t, "div");
  const inner = flight.c[0][0]; // provider child array → [span]
  assertEquals(inner.t, "span");
  assertEquals(inner.c, ["ok"]);
});

Deno.test("flight: a plain fragment expands to its children array", async () => {
  const flight = await renderToFlight(
    h(FRAGMENT, null, h("i", null, "a"), h("b", null, "c")),
  ) as any;
  assert(Array.isArray(flight));
  assertEquals(flight[0].t, "i");
  assertEquals(flight[1].t, "b");
});

Deno.test("flight: array + object props serialize; symbol/bigint props are dropped", async () => {
  const flight = await renderToFlight(
    h(Island, {
      list: [1, "two", Symbol("gone"), 3],
      obj: { a: 1, bad: Symbol("x"), nested: { keep: true } },
      big: 10n,
      keepStr: "y",
    } as never),
  ) as any;
  assertEquals(flight.$, "c");
  // Array drops the symbol, keeps the rest in order.
  assertEquals(flight.p.list, [1, "two", 3]);
  // Object drops the symbol-valued key.
  assertEquals(flight.p.obj, { a: 1, nested: { keep: true } });
  // Bigint is not serializable → dropped entirely.
  assert(!("big" in flight.p));
  assertEquals(flight.p.keepStr, "y");
});

Deno.test("flight: a VNode-valued prop serializes to a nested Flight host node", async () => {
  const flight = await renderToFlight(
    h(Island, { icon: h("svg", { width: 4 }, "x") } as never),
  ) as any;
  assertEquals(flight.p.icon.$, "h");
  assertEquals(flight.p.icon.t, "svg");
  assertEquals(flight.p.icon.p, { width: 4 });
});

Deno.test("flight: a Suspense boundary resolves its async child inline (retry path)", async () => {
  let attempts = 0;
  async function Slow() {
    attempts++;
    await Promise.resolve();
    return h("p", null, "done");
  }
  const flight = await renderToFlight(
    h("div", null, h(Suspense, { fallback: h("i", null, "loading"), children: h(Slow, null) })),
  ) as any;
  // Inline-resolved: the async child is expanded, not left as a hole.
  assertEquals(flight.$, "h");
  assertEquals(flight.t, "div");
  const inner = flight.c[0][0]; // boundary child array → [p]
  assertEquals(inner.t, "p");
  assertEquals(inner.c, ["done"]);
  assert(attempts >= 1);
});

Deno.test("flight: an error boundary renders its fallback on a child throw", async () => {
  function Boom(): VNode {
    throw new Error("kaboom");
  }
  const flight = await renderToFlight(
    h(ErrorBoundary, {
      fallback: ({ error }: { error: Error }) => h("div", null, `caught: ${error.message}`),
      children: h(Boom, null),
    } as never),
  ) as any;
  // The fallback replaces the throwing subtree (message may be redacted in prod).
  assertEquals(flight.$, "h");
  assertEquals(flight.t, "div");
  assertStringIncludes(flight.c[0], "caught:");
});

// ── renderToHtmlFlight: dual output, islands, signals, serializeFlight ─────────

Deno.test("htmlFlight: dual render emits HTML and a matching Flight tree + island ref", async () => {
  async function Page() {
    await Promise.resolve();
    return h("main", null, h("h1", null, "title"), h(Island, { start: 1 } as never));
  }
  const out = await renderToHtmlFlight(h(Page, null));
  assertStringIncludes(out.html, "<h1>title</h1>");
  // The island is present as HTML (server-rendered) AND as a client ref in flight.
  const flightJson = JSON.stringify(out.flight);
  assertStringIncludes(flightJson, "c_isl#Island");
  // serializeFlight escapes `<` so the JSON is safe to inline in a <script>.
  const serialized = serializeFlight(out.flight);
  assert(!serialized.includes("</script"), "no raw </script in serialized flight");
});

Deno.test("htmlFlight: useSignal state is captured into signalState", async () => {
  function Counter() {
    const n = useSignal(7);
    return h("span", null, `n=${n.value}`);
  }
  const out = await renderToHtmlFlight(h(Counter, null));
  assertStringIncludes(out.html, "n=7");
  // A signal was recorded (its position-derived id → value 7).
  assertEquals(Object.values(out.signalState).includes(7), true);
});

Deno.test("htmlFlight: a Suspense boundary resolves inline in the buffered dual render", async () => {
  async function Slow() {
    await Promise.resolve();
    return h("p", null, "slow");
  }
  const out = await renderToHtmlFlight(
    h("div", null, h(Suspense, { fallback: h("i", null, "L"), children: h(Slow, null) })),
  );
  assertStringIncludes(out.html, "slow");
});

Deno.test("serializeFlight round-trips a plain host tree to JSON", () => {
  const node = { $: "h", t: "p", p: { id: "x" }, c: ["hi"] } as any;
  const s = serializeFlight(node);
  assertEquals(JSON.parse(s), node);
});

Deno.test("htmlFlight: the SSR dispatcher services the full hook surface", async () => {
  const Ctx = createContext("ctx-default");
  function HookZoo() {
    const [count] = useReducer((s: number, a: number) => s + a, 5);
    const memo = useMemo(() => "memoized", []);
    const ref = useRef("refval");
    const ctxVal = useContext(Ctx);
    const store = useSyncExternalStore(
      () => () => {},
      () => "snap",
      () => "server-snap",
    );
    useLayoutEffect(() => {}, []);
    return h(
      "p",
      null,
      `${count}|${memo}|${ref.current}|${ctxVal}|${store}`,
    );
  }
  const out = await renderToHtmlFlight(h(HookZoo, null));
  // useReducer seeds to 5; useSyncExternalStore takes the server snapshot.
  assertStringIncludes(out.html, "5|memoized|refval|ctx-default|server-snap");
});

Deno.test("htmlFlight: an error boundary renders its fallback (dual path)", async () => {
  function Boom(): VNode {
    throw new Error("dual-boom");
  }
  const out = await renderToHtmlFlight(
    h(ErrorBoundary, {
      fallback: () => h("div", { class: "fb" }, "recovered"),
      children: h(Boom, null),
    } as never),
  );
  assertStringIncludes(out.html, `class="fb"`);
  assertStringIncludes(out.html, "recovered");
});

Deno.test("htmlFlight: void elements, dangerouslySetInnerHTML, and title-hoist", async () => {
  const head: HeadCollector = { tags: [] };
  const tree = h(
    "div",
    null,
    h("title", null, "Doc Title"),
    h("br", null),
    h("span", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
  );
  const out = await renderToHtmlFlight(tree, { head });
  assertEquals(head.title, "Doc Title");
  assertStringIncludes(out.html, "<br>");
  assertStringIncludes(out.html, "<b>raw</b>");
});

// ── renderToHtmlFlight: client-island hydration strategies ────────────────────

function Widget(): VNode {
  return h("button", { class: "w" }, "widget");
}
const widgetMod = { Widget };
tagClientExports(widgetMod as Record<string, unknown>, "c_widget");

Deno.test("htmlFlight: client:only emits an empty wrapper + island, no server HTML", async () => {
  const out = await renderToHtmlFlight(
    h("div", null, h(Widget, { "client:only": true } as never)),
  );
  // No server-rendered widget button, but an island entry with strategy "only".
  assert(!out.html.includes(">widget<"), "client:only renders no server HTML for the widget");
  const only = out.islands.find((i) => i.strategy === "only");
  assert(only, "an island with strategy 'only' is recorded");
  assertStringIncludes(out.html, "data-dnx-island");
});

Deno.test("htmlFlight: client:visible carves a lazy island (server HTML + deferred)", async () => {
  const out = await renderToHtmlFlight(
    h("div", null, h(Widget, { "client:visible": true } as never)),
  );
  // The island IS server-rendered (first paint) and recorded with strategy "visible".
  assertStringIncludes(out.html, "widget");
  assertStringIncludes(out.html, `data-dnx-strategy="visible"`);
  const vis = out.islands.find((i) => i.strategy === "visible");
  assert(vis, "an island with strategy 'visible' is recorded");
});

Deno.test("htmlFlight: client:media carries its query as the island param", async () => {
  const out = await renderToHtmlFlight(
    h("div", null, h(Widget, { "client:media": "(min-width: 600px)" } as never)),
  );
  const media = out.islands.find((i) => i.strategy === "media");
  assert(media, "a media island is recorded");
  assertEquals(media!.param, "(min-width: 600px)");
});

Deno.test("htmlFlight: a plain (directive-free) island SSRs and becomes a client ref", async () => {
  const out = await renderToHtmlFlight(h("div", null, h(Widget, {} as never)));
  // Rendered to HTML for first paint...
  assertStringIncludes(out.html, "widget");
  // ...and present as a client reference in the Flight tree.
  assertStringIncludes(JSON.stringify(out.flight), "c_widget#Widget");
});

Deno.test("htmlFlight: resumable mode auto-defers a handler-only island to 'interaction'", async () => {
  function Btn(): VNode {
    return h("button", { onClick: () => {} } as never, "click");
  }
  const btnMod = { Btn };
  tagClientExports(btnMod as Record<string, unknown>, "c_btn");
  const out = await renderToHtmlFlight(h("div", null, h(Btn, {} as never)), {
    resumable: true,
  });
  // With no directive, resumable mode picks a strategy for the island automatically.
  assert(out.islands.length >= 1, "resumable mode auto-defers the island");
});

// ── renderToFlightStream: streaming holes, failed hole, tail scripts ───────────

Deno.test("flightStream: streams the shell then fills a Suspense hole", async () => {
  async function Slow(): Promise<VNode> {
    await Promise.resolve();
    return h("p", null, "streamed", h(Island, {}));
  }
  const tree = h(
    "main",
    null,
    h("h1", null, "shell"),
    h(Suspense, { fallback: h("span", null, "loading"), children: h(Slow, {}) }),
  );
  const html = await streamToString(renderToFlightStream(tree));
  assertStringIncludes(html, "<h1>shell</h1>");
  assertStringIncludes(html, `data-dnx-b="dnx0"`);
  assertStringIncludes(html, `<template data-dnx-r="dnx0">`);
  assertStringIncludes(html, "streamed");
  assertStringIncludes(html, `id="__denext_flight"`);
});

Deno.test("flightStream: a hole that throws leaves its shell fallback (no template)", async () => {
  async function Broken(): Promise<VNode> {
    await Promise.resolve();
    throw new Error("hole failed");
  }
  const tree = h(
    "main",
    null,
    h(Suspense, { fallback: h("span", null, "fallback-shown"), children: h(Broken, {}) }),
  );
  const html = await streamToString(renderToFlightStream(tree));
  // The fallback stays; no resolved template is emitted for the failed hole.
  assertStringIncludes(html, "fallback-shown");
  assert(!html.includes(`<template data-dnx-r="dnx0">`), "failed hole has no template");
});

Deno.test("flightStream: shellPrefix/suffix wrap the streamed output", async () => {
  const tree = h("main", null, h("h1", null, "x"));
  const html = await streamToString(
    renderToFlightStream(tree, { shellPrefix: "<!doctype html>", shellSuffix: "<!--end-->" }),
  );
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "<!--end-->");
});

Deno.test("flightStream: renderFlightShell reports no holes for a fully static tree", async () => {
  const shell = await renderFlightShell(h("div", null, h("p", null, "static")));
  assertEquals(shell.hasHoles, false);
  assertStringIncludes(shell.shellHtml, "<p>static</p>");
});

Deno.test("flightTailScripts: emits flight always, islands + state only when present", () => {
  const bare = flightTailScripts({ flight: { $: "h", t: "p", p: {}, c: [] } as any });
  assertStringIncludes(bare, `id="__denext_flight"`);
  assert(!bare.includes("__denext_islands"));
  assert(!bare.includes("__denext_state"));

  const full = flightTailScripts({
    flight: { $: "h", t: "p", p: {}, c: [] } as any,
    islands: [
      {
        id: "c_isl#Island",
        strategy: "load",
        flight: { $: "h", t: "button", p: {}, c: [] },
      } as any,
    ],
    signalState: { ":r0:": 3 },
  });
  assertStringIncludes(full, "__denext_islands");
  assertStringIncludes(full, "__denext_state");
  // `<` in payloads is escaped so it can't break out of the <script>.
  assert(!full.includes("<button"), "island html must be escaped in the json island");
});

// ── PPR (HTML): prerender shell + resume holes ────────────────────────────────

const req = (u: string) =>
  createRequestContext(new Request("http://x/", { headers: { cookie: `u=${u}` } }));

function StaticC() {
  return h("p", null, "static");
}
async function DynC({ k }: { k: string }) {
  const u = cookies().get("u") ?? "?";
  return await Promise.resolve(h("span", null, `${k}:${u}`));
}
const boundary = (child: VNode, label: string) =>
  h(Suspense, { fallback: h("i", null, label), children: child });

Deno.test("ppr(html): a head collector gathers a hoisted <title> during prerender", async () => {
  const head = emptyHead();
  function TitledPage() {
    return h("div", null, h("title", null, "Hoisted"), h(StaticC, null));
  }
  const r = await runWithContext(
    req("x"),
    () => withPrerender(() => prerenderToShell(h(TitledPage, null), { head })),
  );
  assertEquals(r.dynamic, false);
  assertEquals(head.title, "Hoisted");
  assertStringIncludes(r.shell, "<p>static</p>");
});

Deno.test("ppr(html): resume + splice reproduces a full document from the cached shell", async () => {
  const tree = h("div", null, [
    h("h1", null, "hdr"),
    boundary(h(DynC, { k: "u" }), "loading"),
  ]);
  const pre = await runWithContext(
    req("amy"),
    () => withPrerender(() => prerenderToShell(tree)),
  );
  assertEquals(pre.postponedIds, ["dnx0"]);
  const res = await runWithContext(
    req("amy"),
    () => resumeShellHoles(tree, new Set(pre.postponedIds)),
  );
  const map = new Map(await Promise.all(res.holes.map(async (x) => [x.id, await x.html] as const)));
  const doc = spliceShellHoles(pre.shell, map);
  assertStringIncludes(doc, "<h1>hdr</h1>");
  assertStringIncludes(doc, "<span>u:amy</span>");
});

Deno.test("ppr(html): spliceShellHoles leaves fallbacks for ids with no resolved html", () => {
  const shell = `<div data-dnx-b="dnx0"><!--dnx-h:dnx0--><i>fb</i><!--/dnx-h:dnx0--></div>`;
  // An empty map (no resolved holes) returns the shell unchanged.
  assertEquals(spliceShellHoles(shell, new Map()), shell);
  // An unrelated id is ignored (marker not found).
  assertEquals(spliceShellHoles(shell, new Map([["missing", "X"]])), shell);
});

// ── PPR (Flight): prerender + resume + fill, with islands & signals ───────────

Deno.test("ppr(flight): a fully static tree prerenders with no holes and a Flight shell", async () => {
  const r = await runWithContext(
    req("x"),
    () => withPrerender(() => prerenderToShellFlight(h("div", null, h(StaticC, null)))),
  );
  assertEquals(r.dynamic, false);
  assertEquals(r.postponedIds, []);
  assertStringIncludes(r.shell, "<p>static</p>");
  assert(r.flight, "a static tree still produces a flight shell");
});

Deno.test("ppr(flight): a dynamic read with no Suspense above makes the page fully dynamic", async () => {
  const r = await runWithContext(
    req("x"),
    () => withPrerender(() => prerenderToShellFlight(h("main", null, h(DynC, { k: "z" })))),
  );
  assertEquals(r.dynamic, true);
  assertEquals(r.shell, "");
  assertEquals(r.flight, null);
});

Deno.test("ppr(flight): prerender→resume→fillFlightHoles yields a spliced Flight tree", async () => {
  const tree = h("div", null, boundary(h(DynC, { k: "user" }), "loading"));
  const pre = await runWithContext(
    req("bea"),
    () => withPrerender(() => prerenderToShellFlight(tree)),
  );
  assertEquals(pre.postponedIds, ["dnx0"]);

  const res = await runWithContext(
    req("bea"),
    () => resumeShellHolesFlight(tree, new Set(pre.postponedIds)),
  );
  const holeFlights = new Map<string, any>();
  for (const hole of res.holes) {
    await hole.html;
    holeFlights.set(hole.id, await hole.flight);
  }
  const filled = fillFlightHoles(pre.flight as any, holeFlights);
  // The dynamic span crossed into the filled Flight tree.
  assertStringIncludes(JSON.stringify(filled), "user:bea");
  // Signal collection can be finished without error.
  const signals = res.finishSignals();
  assertEquals(typeof signals, "object");
});

Deno.test("ppr(flight): resumable mode auto-defers an island inside a hole", async () => {
  async function SlowIsland(): Promise<VNode> {
    const u = cookies().get("u") ?? "?";
    await Promise.resolve();
    return h("section", null, `u=${u}`, h(Island, {}));
  }
  const tree = h(
    "div",
    null,
    boundary(h(SlowIsland, {}), "loading"),
  );
  const pre = await runWithContext(
    req("cid"),
    () => withPrerender(() => prerenderToShellFlight(tree, { resumable: true })),
  );
  assertEquals(pre.postponedIds.length, 1);
  const res = await runWithContext(
    req("cid"),
    () => resumeShellHolesFlight(tree, new Set(pre.postponedIds), { resumable: true }),
  );
  for (const hole of res.holes) {
    await hole.html;
    await hole.flight;
  }
  // The island discovered inside the resumed hole is reported.
  assert(res.islands.length >= 1, "island inside the hole is collected on resume");
});
