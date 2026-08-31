// deno-lint-ignore-file no-explicit-any -- tests poke at Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { serverAction } from "../src/runtime/server-action.ts";
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
  assertEquals(island.p, { start: 3, __dnxIdPath: "0.0" });
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
