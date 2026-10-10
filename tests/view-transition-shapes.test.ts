// `<ViewTransition>` marks its NEAREST HOST NODES, whatever shape its children take (React's
// `applyViewTransitionToHostInstances`): a host child; every host in a Fragment or a list (the
// first keeps `name`, the others `name_<i>`); the hosts a component child renders (a plain
// function, `memo`, `forwardRef`, an async Server Component); text can't be named. A child the
// server can't expand (a class, a `lazy`, a client reference) carries the config as a prop, and
// the client's marking runtime resolves it to that component's nearest hosts. These assert the
// server output (SSR + Flight), where the marks must already be on the DOM nodes.

import { assert, assertEquals } from "@std/assert";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import { renderToStringSync } from "../src/jsx/render-to-string.ts";
import { type FlightNode, renderToFlight } from "../src/jsx/render-to-flight.ts";
import { DNX_VT_ATTR, ViewTransition } from "../src/runtime/react-extras.ts";
import { forwardRef } from "../src/runtime/react-core.ts";
import { memo } from "../src/runtime/memo.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Each marked element's `id` → the `name` in its config (`-` when it has none). */
function names(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, id, raw] of html.matchAll(/id="([^"]+)" data-dnx-vt="([^"]*)"/g)) {
    const m = JSON.parse(raw.replaceAll("&quot;", '"'));
    out[id] = m.name ?? "-";
  }
  return out;
}

const vt = (children: unknown, name = "x") =>
  h(ViewTransition, { name, enter: "in" }, children as never) as VNode;
const el = (id: string) => h("div", { id }, id);
const Two = () => h(Fragment, null, el("c1"), el("c2"));

Deno.test("a single host child: marked with the bare name, no wrapper", () => {
  assertEquals(names(renderToStringSync(vt(el("a")))), { a: "x" });
});

Deno.test("a Fragment / a list of hosts: each is marked, the first keeps the name (React's name_<i>)", () => {
  assertEquals(names(renderToStringSync(vt(h(Fragment, null, el("a"), el("b"))))), {
    a: "x",
    b: "x_1",
  });
  assertEquals(names(renderToStringSync(vt([el("a"), [el("b"), el("c")]]))), {
    a: "x",
    b: "x_1",
    c: "x_2",
  });
});

Deno.test("text directly inside is left alone (it can't be named); only the hosts are marked", () => {
  const html = renderToStringSync(vt(["lead ", el("a"), " tail"]));
  assert(html.startsWith("lead "), html);
  assertEquals(names(html), { a: "x" });
  assertEquals(renderToStringSync(h(ViewTransition, null, "just text")), "just text");
});

Deno.test("a component child: the host it renders is marked (no forwarding needed)", () => {
  const Card = ({ id }: { id: string }) => el(id);
  assertEquals(names(renderToStringSync(vt(h(Card, { id: "card" })))), { card: "x" });
  // Through memo and forwardRef too (the ref still reaches the render function).
  let seen: unknown = "none";
  const Fwd = forwardRef((p: { id: string }, ref) => ((seen = ref), el(p.id)));
  const ref = { current: null };
  const Memo = memo(({ id }: { id: string }) => el(id));
  assertEquals(names(renderToStringSync(vt(h(Fwd as Any, { id: "f", ref })))), { f: "x" });
  assertEquals(seen, ref, "forwardRef gets its ref");
  assertEquals(names(renderToStringSync(vt(h(Memo as Any, { id: "m" })))), { m: "x" });
});

Deno.test("a component rendering several hosts: unique names, flat when it is the last child", () => {
  assertEquals(names(renderToStringSync(vt(h(Two, null)))), { c1: "x", c2: "x_1" });
  assertEquals(names(renderToStringSync(vt([el("a"), h(Two, null)]))), {
    a: "x",
    c1: "x_1",
    c2: "x_2",
  });
  // Not last: its hosts take a nested suffix so the hosts after it can't collide.
  assertEquals(names(renderToStringSync(vt([h(Two, null), el("b")]))), {
    c1: "x",
    c2: "x_0_1",
    b: "x_1",
  });
});

Deno.test("an unnamed boundary marks every host with the bare config (auto names are per element)", () => {
  const html = renderToStringSync(h(ViewTransition, null, h(Two, null)));
  assertEquals(names(html), { c1: "-", c2: "-" });
});

Deno.test("a nested <ViewTransition> marks its own hosts; Suspense content and fallback are looked through", () => {
  const html = renderToStringSync(vt([el("a"), vt(el("inner"), "y")]));
  assertEquals(names(html), { a: "x", inner: "y" });
  const fallback = renderToStringSync(
    vt(h(Suspense, { fallback: el("fb") }, el("content"))),
  );
  assertEquals(names(fallback), { content: "x" });
});

Deno.test("the component keeps its hooks (one fiber per component type)", () => {
  function Counter() {
    const [n] = useState(7);
    return h("p", { id: "n" }, String(n));
  }
  const html = renderToStringSync(vt(h(Counter, null)));
  assertEquals(names(html), { n: "x" });
  assert(html.includes(">7<"), html);
});

Deno.test("a class / lazy / client-reference child is not invoked: it carries the config as a prop", () => {
  const Island = (p: Record<string, unknown>) =>
    h("b", { id: "island", "data-got": p[DNX_VT_ATTR] ? "1" : "0" });
  (Island as Any)[Symbol.for("denext.clientRef")] = {
    id: "c_1#Island",
    clientId: "c_1",
    name: "Island",
  };
  const out = ViewTransition({ name: "x", children: h(Island, null) }) as Any;
  assertEquals(
    out.type,
    Island,
    "the client reference stays itself (Flight emits it as a reference)",
  );
  assertEquals(JSON.parse(out.props[DNX_VT_ATTR]), { name: "x" });
});

/** The `data-dnx-vt` configs of every host in a Flight tree, by element id. */
function flightNames(node: FlightNode, out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(node)) { for (const c of node) flightNames(c, out); }
  else if (node && typeof node === "object" && (node as Any).$ === "h") {
    const p = (node as Any).p;
    if (p[DNX_VT_ATTR]) out[p.id] = JSON.parse(p[DNX_VT_ATTR]).name ?? "-";
    for (const c of (node as Any).c) flightNames(c, out);
  }
  return out;
}

Deno.test("Flight: an async Server Component child's hosts carry the marks across the boundary", async () => {
  const Post = async ({ id }: { id: string }) => {
    await Promise.resolve();
    return h(Fragment, null, el(`${id}-title`), el(`${id}-body`));
  };
  const tree = await renderToFlight(vt(h(Post as Any, { id: "p" }), "post"));
  assertEquals(flightNames(tree), { "p-title": "post", "p-body": "post_1" });
});
