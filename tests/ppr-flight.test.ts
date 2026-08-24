// Stage 4b: the postpone-aware dual HTML+Flight PPR renderer. Prerender produces a
// static shell carrying its Flight tree + islands + signal state; resume renders
// each dynamic hole to HTML + a Flight subtree (plus any islands/signals inside it);
// filling the shell's holes with the resume subtrees yields the complete tree the
// client hydrates — identical to a non-PPR streamed Flight route.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import {
  fillFlightHoles,
  prerenderToShellFlight,
  resumeShellHolesFlight,
} from "../src/jsx/render-to-ppr-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { useSignal } from "../src/runtime/signals.ts";
import { useId } from "../src/runtime/hooks.ts";
import { withPrerender } from "../src/runtime/prerender.ts";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";

const req = (u: string) =>
  createRequestContext(new Request("http://x/", { headers: { cookie: `u=${u}` } }));

/** Run a prerender pass the way app.ts will: request context + prerender scope. */
const prerender = (tree: VNode, u = "alice") =>
  runWithContext(req(u), () => withPrerender(() => prerenderToShellFlight(tree)));

/** Run a resume pass: real request context, no prerender scope. */
const resume = (tree: VNode, ids: string[], u = "alice") =>
  runWithContext(req(u), () => resumeShellHolesFlight(tree, new Set(ids)));

/** Drain a resume result the way the document assembler does: await holes → tail. */
async function drain(
  res: Awaited<ReturnType<typeof resume>>,
  shellFlight: FlightNode,
  shellIslands: { id: string; flight: FlightNode }[],
  shellSignal: Record<string, unknown>,
) {
  const holeFlights = new Map<string, FlightNode>();
  const holeHtml = new Map<string, string>();
  for (const hole of res.holes) {
    holeHtml.set(hole.id, await hole.html);
    holeFlights.set(hole.id, await hole.flight); // pushes the hole's islands
  }
  const flight = fillFlightHoles(shellFlight, holeFlights);
  const islands = [...shellIslands, ...res.islands];
  const signalState = { ...shellSignal, ...res.finishSignals() };
  return { flight, islands, signalState, holeHtml };
}

// A static server component (no request reads).
function Static() {
  return h("p", null, "static");
}

// A dynamic server component: reads a cookie (postpones during prerender).
async function Dyn({ k }: { k: string }) {
  const u = cookies().get("u") ?? "?";
  return await Promise.resolve(h("span", null, `${k}:${u}`));
}

const boundary = (child: VNode, label: string) =>
  h(Suspense, { fallback: h("i", null, label), children: child });

// ---- client islands ---------------------------------------------------------

function Widget(props: { label?: string }): VNode {
  return h("button", { class: "w" }, props.label ?? "widget");
}
const widgetMod = { Widget };
tagClientExports(widgetMod as Record<string, unknown>, "c_widget");

Deno.test("4b: a fully static Flight page prerenders to a shell with no holes", async () => {
  const r = await prerender(h("div", null, h(Static, null)));
  assertEquals(r.dynamic, false);
  assertEquals(r.postponedIds, []);
  assertEquals(r.shell, "<div><p>static</p></div>");
  // Its Flight tree is complete (no `{$:"$"}` holes).
  assert(!JSON.stringify(r.flight).includes(`"$":"$"`), "no unfilled holes in a static shell");
});

Deno.test("4b: a dynamic read under Suspense becomes a hole in BOTH HTML and Flight", async () => {
  const tree = h("div", null, boundary(h(Dyn, { k: "user" }), "loading"));
  const pre = await prerender(tree, "alice");
  assertEquals(pre.dynamic, false);
  assertEquals(pre.postponedIds, ["dnx0"]);
  assertStringIncludes(pre.shell, `<div data-dnx-b="dnx0">`);
  assertStringIncludes(pre.shell, "loading"); // fallback in the shell
  // The Flight tree marks the boundary as an unfilled hole.
  assertStringIncludes(JSON.stringify(pre.flight), `{"$":"$","r":"dnx0"}`);

  const res = await resume(tree, pre.postponedIds, "alice");
  const tail = await drain(res, pre.flight, pre.islands, pre.signalState);
  assertEquals(tail.holeHtml.get("dnx0"), "<span>user:alice</span>");
  // Filling the hole yields a complete tree — no `{$:"$"}` remains, real content in.
  const json = JSON.stringify(tail.flight);
  assert(!json.includes(`"$":"$"`), "hole filled: no placeholder remains");
  assertStringIncludes(json, "user:alice");
});

Deno.test("4b: a client island in the static shell is carved into shell islands", async () => {
  const tree = h(
    "div",
    null,
    h(Static, null),
    h(Widget, { "client:visible": true, label: "hi" } as never),
  );
  const pre = await prerender(tree);
  assertEquals(pre.postponedIds, []);
  // The island wrapper (foreign host) is in the shell HTML with its strategy.
  assertStringIncludes(pre.shell, `data-dnx-island`);
  assertStringIncludes(pre.shell, `data-dnx-strategy="visible"`);
  // It is recorded as a shell island whose Flight references the client component.
  assertEquals(pre.islands.length, 1);
  assertStringIncludes(JSON.stringify(pre.islands[0].flight), "c_widget#Widget");
  // The island id is its tree-path prefix (a `data-dnx-id` in the wrapper).
  assertStringIncludes(pre.shell, `data-dnx-id="${pre.islands[0].id}"`);
});

Deno.test("4b: a client:only island in the shell carves an empty wrapper (no SSR)", async () => {
  const tree = h("div", null, h(Static, null), h(Widget, { "client:only": true } as never));
  const pre = await prerender(tree);
  assertEquals(pre.postponedIds, []);
  assertStringIncludes(pre.shell, `data-dnx-strategy="only"`);
  // No SSR body for the island — the button never renders on the server.
  assert(!pre.shell.includes(`<button class="w">`), "client:only must not SSR");
  assertEquals(pre.islands.length, 1);
  assertEquals(pre.islands[0].strategy, "only");
  assertStringIncludes(JSON.stringify(pre.islands[0].flight), "c_widget#Widget");
});

Deno.test("4b: a client:media island in the shell stamps the query on the wrapper", async () => {
  const tree = h(
    "div",
    null,
    h(Widget, { "client:media": "(min-width:600px)", label: "m" } as never),
  );
  const pre = await prerender(tree);
  assertStringIncludes(pre.shell, `data-dnx-strategy="media"`);
  assertStringIncludes(pre.shell, `data-dnx-strategy-param="(min-width:600px)"`);
  assertStringIncludes(pre.shell, `<button class="w">m</button>`); // SSRs for first paint
  assertEquals(pre.islands[0].strategy, "media");
  assertEquals(pre.islands[0].param, "(min-width:600px)");
});

Deno.test("4b: a client island discovered INSIDE a hole surfaces in resume islands", async () => {
  async function SlowWithIsland({ k }: { k: string }) {
    cookies().get("u"); // postpones during prerender
    return await Promise.resolve(
      h("section", null, h(Widget, { "client:load": true, label: k } as never)),
    );
  }
  const tree = h("div", null, boundary(h(SlowWithIsland, { k: "z" }), "loading"));
  const pre = await prerender(tree, "alice");
  assertEquals(pre.postponedIds, ["dnx0"]);
  // The island is inside the hole, so it is NOT a shell island.
  assertEquals(pre.islands.length, 0);

  const res = await resume(tree, pre.postponedIds, "alice");
  const tail = await drain(res, pre.flight, pre.islands, pre.signalState);
  // The hole HTML carries the island wrapper; the island is in the merged islands.
  assertStringIncludes(tail.holeHtml.get("dnx0")!, `data-dnx-strategy="load"`);
  assertEquals(tail.islands.length, 1);
  assertStringIncludes(JSON.stringify(tail.islands[0].flight), "c_widget#Widget");
});

Deno.test("4b: an island's id matches the same island rendered by the non-PPR Flight path", async () => {
  // Path-based useId/island ids must agree between PPR and a normal Flight render so
  // the client (which doesn't know PPR happened) roots each island identically.
  const tree = h(
    "main",
    null,
    h("h1", null, "t"),
    h(Widget, { "client:idle": true } as never),
  );
  const ref = await renderToHtmlFlight(tree);
  const pre = await prerender(tree);
  assertEquals(ref.islands.length, 1);
  assertEquals(pre.islands.length, 1);
  assertEquals(pre.islands[0].id, ref.islands[0].id);
});

Deno.test("4b: useId inside a hole reproduces the in-place id (aligned across passes)", async () => {
  function DynId() {
    cookies().get("u"); // postpones during prerender, before useId
    return h("input", { id: useId() });
  }
  const tree = h("div", null, h(Static, null), boundary(h(DynId, null), "loading"));
  // Reference: a full (non-PPR) Flight render resolves the content in place.
  const full = await runWithContext(req("alice"), () => renderToHtmlFlight(tree));
  const refId = full.html.match(/id="(:d[^"]+:)"/)?.[1];
  assert(refId, "reference render should contain an input id");

  const pre = await prerender(tree, "alice");
  const res = await resume(tree, pre.postponedIds, "alice");
  const tail = await drain(res, pre.flight, pre.islands, pre.signalState);
  assertStringIncludes(tail.holeHtml.get("dnx0")!, `id="${refId}"`);
});

Deno.test("4b: signal state is captured in the shell and in resumed holes", async () => {
  function ShellSignal() {
    const s = useSignal("shell-value");
    return h("p", null, s.value);
  }
  // A sync signal component gated behind an async dynamic reader: the gate postpones
  // during prerender (making the whole boundary a hole), so the signal is captured
  // only on resume — a hook in a sync component (async components can't hydrate).
  function HoleSignal() {
    const s = useSignal("hole-value");
    return h("span", null, s.value);
  }
  async function DynGate({ children }: { children: VNode }) {
    cookies().get("u"); // postpones during prerender, before children render
    return await Promise.resolve(children);
  }
  const tree = h(
    "div",
    null,
    h(ShellSignal, null),
    boundary(h(DynGate, null, h(HoleSignal, null)), "loading"),
  );
  const pre = await prerender(tree, "alice");
  // The shell signal is captured up front (request-independent).
  assert(
    Object.values(pre.signalState).includes("shell-value"),
    "shell signal captured in prerender",
  );

  const res = await resume(tree, pre.postponedIds, "alice");
  const tail = await drain(res, pre.flight, pre.islands, pre.signalState);
  // The merged state carries BOTH the shell signal and the hole signal.
  const values = Object.values(tail.signalState);
  assert(values.includes("shell-value"), "shell signal in merged state");
  assert(values.includes("hole-value"), "hole signal in merged state");
});

Deno.test("4b: the same shell serves different requests; only the holes differ", async () => {
  const tree = h("div", null, boundary(h(Dyn, { k: "user" }), "loading"));
  const a = await prerender(tree, "alice");
  const b = await prerender(tree, "bob");
  assertEquals(a.shell, b.shell); // request-independent
  assertEquals(JSON.stringify(a.flight), JSON.stringify(b.flight));

  const ra = await resume(tree, a.postponedIds, "alice");
  const rb = await resume(tree, b.postponedIds, "bob");
  assertEquals(await ra.holes[0].html, "<span>user:alice</span>");
  assertEquals(await rb.holes[0].html, "<span>user:bob</span>");
});

Deno.test("4b: a dynamic read with no Suspense above it makes the page fully dynamic", async () => {
  const r = await prerender(h("main", null, h(Dyn, { k: "x" })));
  assertEquals(r.dynamic, true);
  assertEquals(r.shell, "");
  assertEquals(r.flight, null);
  assertEquals(r.postponedIds, []);
});
