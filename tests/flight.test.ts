// deno-lint-ignore-file no-explicit-any -- tests poke at Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { serverAction } from "../src/runtime/server-action.ts";
import { createChannel } from "../src/runtime/channel.ts";
import type { Component } from "../src/jsx/types.ts";

// A "client" component, tagged as if discovered by the boundary manifest.
function Counter(props: { start: number }) {
  return h("button", null, `count: ${props.start}`);
}
const clientMod = { Counter };
tagClientExports(clientMod as Record<string, unknown>, "c_counter");

// A server component that renders host markup AND embeds the client island.
async function Page(props: { title: string }) {
  await Promise.resolve();
  return h(
    "main",
    null,
    h("h1", null, props.title),
    h(Counter, { start: 3 }),
  );
}

Deno.test("renderToFlight expands server components and references client ones", async () => {
  const flight = await renderToFlight(h(Page, { title: "Hi" }));
  // Server component expanded to a host tree.
  assertEquals((flight as any).$, "h");
  assertEquals((flight as any).t, "main");
  const [h1, island] = (flight as any).c;
  assertEquals(h1.$, "h");
  assertEquals(h1.t, "h1");
  assertEquals(h1.c, ["Hi"]);
  // The client component is a REFERENCE, not invoked (no "count:" text present).
  // It carries its tree-path prefix so the client can root its useId scope there.
  assertEquals(island.$, "c");
  assertEquals(island.i, "c_counter#Counter");
  assertEquals(island.p, { start: 3, __dnxIdPath: "0-0" });
});

Deno.test("client component code is NOT executed during flight render", async () => {
  let invoked = false;
  function Interactive() {
    invoked = true;
    return h("div", null, "interactive");
  }
  const mod = { Interactive };
  tagClientExports(mod as Record<string, unknown>, "c_x");
  const flight = await renderToFlight(h(Interactive, {}));
  assertEquals(invoked, false); // reference only
  assertEquals((flight as any).$, "c");
  assertEquals((flight as any).i, "c_x#Interactive");
});

Deno.test("parseFlight reconstructs the tree, resolving client refs via registry", async () => {
  const flight = await renderToFlight(h(Page, { title: "Hi" }));
  const registry = new Map<string, Component>([["c_counter#Counter", Counter as Component]]);
  const tree = parseFlight(flight, registry);
  // Rendering the reconstructed tree runs the client component -> "count: 3".
  const html = await renderToString(tree as never);
  assertStringIncludes(html, "<h1>Hi</h1>");
  assertStringIncludes(html, "count: 3");
});

Deno.test("flight round-trips server-action props and Date values", async () => {
  const save = serverAction("act1", (_x: number) => 1);
  const when = new Date("2020-01-02T03:04:05.000Z");
  const flight = await renderToFlight(
    h("form", { action: save, "data-when": when } as never),
  );
  assertEquals((flight as any).p.action, { $: "a", i: "act1" });
  assertEquals((flight as any).p["data-when"], { $: "D", v: "2020-01-02T03:04:05.000Z" });

  const tree = parseFlight(flight, new Map()) as any;
  // The action prop rehydrates to a callable tagged with its id.
  assert(typeof tree.props.action === "function");
  assertEquals(tree.props.action.denextActionId, "act1");
  assert(tree.props["data-when"] instanceof Date);
});

Deno.test("flight resolves a thenable (Remix defer) prop to its value", async () => {
  // A promise passed as a client-component prop (a Remix `defer()` field) is awaited
  // server-side and serialized as its resolved value — so deferred data crosses the
  // boundary instead of collapsing to `{}`. Resolution recurses into nested promises.
  const flight = await renderToFlight(
    h(Counter, {
      start: 1,
      deferred: Promise.resolve({ items: [1, 2, 3] }),
      nested: { later: Promise.resolve("ok") },
    } as never),
  );
  assertEquals((flight as any).p.deferred, { items: [1, 2, 3] });
  assertEquals((flight as any).p.nested, { later: "ok" });

  // It round-trips through the client parser as plain resolved data.
  const tree = parseFlight(flight, new Map([["c_counter#Counter", Counter as Component]])) as any;
  assertEquals(tree.props.deferred, { items: [1, 2, 3] });
});

Deno.test("flight drops non-serializable function props (event handlers)", async () => {
  const flight = await renderToFlight(
    h("button", { onClick: () => {}, id: "b" } as never),
  );
  assertEquals((flight as any).p, { id: "b" }); // onClick dropped
});

// ---- Client error boundaries (a segment's "use client" error.tsx) ---------------------

import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { flightClientIds } from "../src/client/flight-client.ts";

function ErrTsx(props: { error: Error }) {
  return h("p", null, "err:" + props.error.message);
}
const errMod = { ErrTsx };
tagClientExports(errMod as Record<string, unknown>, "c_err");

Deno.test("renderToFlight emits a client boundary node when the fallback is a client component", async () => {
  const flight = await renderToFlight(
    h(ErrorBoundary, { fallback: ErrTsx, children: h("span", null, "ok") }),
  );
  assertEquals((flight as any).$, "b");
  assertEquals((flight as any).f, "c_err#ErrTsx");
  assertEquals((flight as any).c[0].t, "span");
  // The lazy island loader must fetch the fallback's module too.
  assert(flightClientIds(flight).has("c_err"));

  // A server-side catch still renders the fallback on the server, inside the boundary.
  const caught = await renderToFlight(
    h(ErrorBoundary, {
      fallback: ErrTsx,
      children: h(() => {
        throw new Error("boom");
      }, null),
    }),
  );
  assertEquals((caught as any).$, "b");
  assertEquals(JSON.stringify(caught).includes("err:"), true);

  // A server-only fallback (no client reference) stays transparent.
  const plain = await renderToFlight(
    h(ErrorBoundary, { fallback: () => h("p", null, "x"), children: h("span", null, "ok") }),
  );
  assertEquals((plain as any)[0].$, "h"); // the children array itself, no wrapper
});

Deno.test("parseFlight turns a boundary node into an ErrorBoundary (transparent without the fallback)", () => {
  const node = { $: "b", f: "c_err#ErrTsx", c: [{ $: "h", t: "span", p: {}, c: ["ok"] }] };
  const registry = new Map<string, Component>([["c_err#ErrTsx", ErrTsx as Component]]);
  const vnode = parseFlight(node as any, registry) as any;
  assertEquals(vnode.props.fallback, ErrTsx);
  assertEquals(vnode.props.children.type, "span");

  const bare = parseFlight(node as any, new Map()) as any;
  assertEquals(Array.isArray(bare), true);
  assertEquals(bare[0].type, "span");
});

Deno.test("flight round-trips Map/Set/BigInt/URL/non-finite props through the wire codec tags", async () => {
  const when = new Date(0);
  const props = {
    "data-map": new Map<unknown, unknown>([["k", 1], [2, when]]),
    "data-set": new Set([1, "a", h(Counter, { start: 9 })]),
    "data-big": 12345678901234567890n,
    "data-url": new URL("https://denext.dev/x?y=1"),
    "data-nan": NaN,
    "data-nzero": -0,
    "data-inf": -Infinity,
  };
  const flight = await renderToFlight(h("div", props as never));
  const p = (flight as any).p;
  assertEquals(p["data-map"], { $: "M", v: [["k", 1], [2, { $: "D", v: when.toISOString() }]] });
  assertEquals(p["data-set"].$, "S");
  assertEquals(p["data-set"].v.slice(0, 2), [1, "a"]);
  assertEquals(p["data-set"].v[2].$, "c"); // a VNode inside a Set is still a client ref
  assertEquals(p["data-big"], { $: "n", v: "12345678901234567890" });
  assertEquals(p["data-url"], { $: "U", v: "https://denext.dev/x?y=1" });
  assertEquals(p["data-nan"], { $: "N", v: "NaN" });
  assertEquals(p["data-nzero"], { $: "N", v: "-0" });
  assertEquals(p["data-inf"], { $: "N", v: "-Infinity" });

  const registry = new Map<string, Component>([["c_counter#Counter", Counter as Component]]);
  const tree = parseFlight(flight, registry) as any;
  const map = tree.props["data-map"] as Map<unknown, unknown>;
  assert(map instanceof Map && map.get("k") === 1 && (map.get(2) as Date).getTime() === 0);
  const set = tree.props["data-set"] as Set<unknown>;
  assert(set instanceof Set && set.size === 3);
  const inner = [...set][2] as any;
  assertEquals(inner.type, Counter); // the VNode rehydrated through the registry
  assertEquals(tree.props["data-big"], 12345678901234567890n);
  assert(tree.props["data-url"] instanceof URL);
  assert(Number.isNaN(tree.props["data-nan"]));
  assert(Object.is(tree.props["data-nzero"], -0));
  assertEquals(tree.props["data-inf"], -Infinity);
});

Deno.test("flight: a `$`-keyed user object inside a Map value round-trips as data, never a tag", async () => {
  const flight = await renderToFlight(
    h("div", { "data-m": new Map([["k", { $: "M", v: [] }]]) } as never),
  );
  const tree = parseFlight(flight, new Map()) as any;
  const m = tree.props["data-m"] as Map<string, unknown>;
  assertEquals(m.get("k"), { $: "M", v: [] });
});

Deno.test('flight: a channel prop crosses as {$:"ch"} and rehydrates to a subscribable ref', async () => {
  const ch = createChannel<number>({ id: "flight#ch", authorize: () => true });
  const flight = await renderToFlight(h(Counter, { start: 1, events: ch } as never));
  assertEquals((flight as any).p.events, { $: "ch", i: "flight#ch" });
  const tree = parseFlight(flight, new Map([["c_counter#Counter", Counter as Component]])) as any;
  assertEquals(tree.props.events, { denextChannelId: "flight#ch" });
  // A channel with no id (not exported from a "use server" module) is a guided error.
  const anon = createChannel<number>({ authorize: () => true });
  let msg = "";
  try {
    await renderToFlight(h(Counter, { start: 1, events: anon } as never));
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "use server");
});
