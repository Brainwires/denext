// Part C3: the PPR renderer — prerender produces a static shell + dynamic holes,
// resume renders those holes with the real request context, and boundary ids
// stay aligned across the two passes.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { prerenderToShell, resumeShellHoles } from "../src/jsx/render-to-ppr.ts";
import { withPrerender } from "../src/runtime/prerender.ts";
import { cookies, createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { withCacheScope } from "../src/server/cache.ts";

const req = (u: string) =>
  createRequestContext(new Request("http://x/", { headers: { cookie: `u=${u}` } }));

/** A static component (no request reads). */
function Static() {
  return h("p", null, "static");
}

/** A dynamic component: reads a cookie (postpones during prerender). */
async function Dyn({ k }: { k: string }) {
  const u = cookies().get("u") ?? "?";
  return await Promise.resolve(h("span", null, `${k}:${u}`));
}

/** A `use cache` component: its cookie read is suppressed (stays static). */
async function Cached() {
  const { value } = await withCacheScope(() => {
    const u = cookies().get("u") ?? "?";
    return h("em", null, `cached:${u}`);
  });
  return value as VNode;
}

const boundary = (child: VNode, label: string) =>
  h(Suspense, { fallback: h("i", null, label), children: child });

/** Run a prerender pass the way app.ts will: inside the request context + prerender scope. */
const prerender = (tree: VNode, u = "alice") =>
  runWithContext(req(u), () => withPrerender(() => prerenderToShell(tree)));

/** Run a resume pass: real request context, no prerender scope. */
const resume = (tree: VNode, ids: string[], u = "alice") =>
  runWithContext(req(u), () => resumeShellHoles(tree, new Set(ids)));

Deno.test("C3: a fully static page prerenders to a complete shell (no holes)", async () => {
  const r = await prerender(h("div", null, h(Static, null)));
  assertEquals(r.dynamic, false);
  assertEquals(r.postponedIds, []);
  assertEquals(r.shell, "<div><p>static</p></div>");
});

Deno.test("C3: a dynamic read under Suspense becomes a hole; resume fills it", async () => {
  const tree = h("div", null, boundary(h(Dyn, { k: "user" }), "loading"));
  const pre = await prerender(tree, "alice");
  assertEquals(pre.dynamic, false);
  assertEquals(pre.postponedIds, ["dnx0"]);
  assertEquals(pre.shell, `<div><div data-dnx-b="dnx0"><i>loading</i></div></div>`);

  const res = await resume(tree, pre.postponedIds, "alice");
  assertEquals(res.holes.length, 1);
  assertEquals(res.holes[0].id, "dnx0");
  assertEquals(await res.holes[0].html, "<span>user:alice</span>");
});

Deno.test("C3: a dynamic read with no Suspense above it makes the page fully dynamic", async () => {
  const r = await prerender(h("main", null, h(Dyn, { k: "x" })));
  assertEquals(r.dynamic, true);
  assertEquals(r.shell, "");
  assertEquals(r.postponedIds, []);
});

Deno.test("C3: a `use cache` read is suppressed, so its content stays in the static shell", async () => {
  const r = await prerender(h("div", null, h(Cached, null)), "bob");
  assertEquals(r.dynamic, false);
  assertEquals(r.postponedIds, []);
  assertEquals(r.shell, "<div><em>cached:bob</em></div>");
});

Deno.test("C3: a hole nested inside a static boundary keeps ids aligned across passes", async () => {
  const inner = boundary(h(Dyn, { k: "in" }), "L1");
  const tree = boundary(h("section", null, [h(Static, null), inner]), "L0");

  const pre = await prerender(tree, "carol");
  assertEquals(pre.dynamic, false);
  // The outer boundary is static (consumes id dnx0 but is transparent); only the
  // inner boundary (dnx1) is a hole.
  assertEquals(pre.postponedIds, ["dnx1"]);
  assertEquals(
    pre.shell,
    `<section><p>static</p><div data-dnx-b="dnx1"><i>L1</i></div></section>`,
  );

  const res = await resume(tree, pre.postponedIds, "carol");
  assertEquals(res.holes.length, 1);
  assertEquals(res.holes[0].id, "dnx1");
  assertEquals(await res.holes[0].html, "<span>in:carol</span>");
});

Deno.test("C3: sibling holes get distinct, ordered ids resolved independently on resume", async () => {
  const tree = h("div", null, [
    boundary(h(Dyn, { k: "a" }), "La"),
    boundary(h(Dyn, { k: "b" }), "Lb"),
  ]);
  const pre = await prerender(tree, "dave");
  assertEquals(pre.postponedIds, ["dnx0", "dnx1"]);
  assertEquals(
    pre.shell,
    `<div><div data-dnx-b="dnx0"><i>La</i></div><div data-dnx-b="dnx1"><i>Lb</i></div></div>`,
  );

  const res = await resume(tree, pre.postponedIds, "dave");
  const byId = new Map(
    await Promise.all(res.holes.map(async (x) => [x.id, await x.html] as const)),
  );
  assertEquals(byId.get("dnx0"), "<span>a:dave</span>");
  assertEquals(byId.get("dnx1"), "<span>b:dave</span>");
});

Deno.test("C3: the same shell serves different requests; only the holes differ", async () => {
  const tree = h("div", null, boundary(h(Dyn, { k: "user" }), "loading"));
  const a = await prerender(tree, "alice");
  const b = await prerender(tree, "bob");
  // The shell is request-independent — identical for both users.
  assertEquals(a.shell, b.shell);
  assertEquals(a.postponedIds, b.postponedIds);

  const ra = await resume(tree, a.postponedIds, "alice");
  const rb = await resume(tree, b.postponedIds, "bob");
  assertEquals(await ra.holes[0].html, "<span>user:alice</span>");
  assertEquals(await rb.holes[0].html, "<span>user:bob</span>");
});
