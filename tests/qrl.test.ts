// qrl: a lazily-loaded, code-split event handler with a stable identity, and its
// {$:"e"} Flight round-trip.

// deno-lint-ignore-file no-explicit-any -- pokes Flight node internals.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { capturedScope, getQrlLoader, isQrl, qrl, qrlStub } from "../src/runtime/qrl.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import type { VNode } from "../src/jsx/types.ts";

Deno.test("qrl is a callable tagged with a stable id, loaded lazily", async () => {
  let loaded = 0;
  const onTap = qrl(() => {
    loaded++;
    return Promise.resolve((e: { v: number }) => e.v * 2);
  }, "t#tap");
  assert(isQrl(onTap));
  assertEquals(onTap.denextQrlId, "t#tap");
  assertEquals(loaded, 0); // the impl is not imported until first invocation
  await onTap({ v: 21 } as any);
  assertEquals(loaded, 1);
});

Deno.test('a qrl handler serializes to {$:"e"} instead of being dropped', async () => {
  const onClick = qrl(() => Promise.resolve(() => {}), "btn#click");
  const flight = await renderToFlight(h("button", { onClick }, "x")) as any;
  assertEquals(flight.$, "h");
  assertEquals(flight.p.onClick, { $: "e", i: "btn#click" });
});

Deno.test("a qrl passed as a prop to a client island serializes in its props", async () => {
  function Widget(_p: { onTap?: unknown }): VNode {
    return h("button", null, "go");
  }
  const mod = { Widget };
  tagClientExports(mod as Record<string, unknown>, "c_w");
  const onTap = qrl(() => Promise.resolve(() => {}), "w#tap");
  const { flight } = await renderToHtmlFlight(h("main", null, h(Widget, { onTap })));
  const island = (flight as any).c[0];
  assertEquals(island.$, "c");
  assertEquals(island.p.onTap, { $: "e", i: "w#tap" });
});

Deno.test('parseFlight rehydrates {$:"e"} into a working qrl stub', async () => {
  let ran = 0;
  // Register a loader for the id (as the owning component's qrl(...) would).
  qrl(() => Promise.resolve(() => ran++), "z#go");
  const node: any = { $: "h", t: "button", p: { onClick: { $: "e", i: "z#go" } }, c: [] };
  const vnode = parseFlight(node, new Map()) as any;
  const handler = vnode.props.onClick;
  assert(isQrl(handler));
  assertEquals(handler.denextQrlId, "z#go");
  await handler({} as any);
  assertEquals(ran, 1);
});

Deno.test("qrlStub warns and no-ops for an unregistered id", async () => {
  const stub = qrlStub("never#registered");
  assertEquals(getQrlLoader("never#registered"), undefined);
  await stub({} as any); // must not throw
});

Deno.test("captures are made available to the segment via capturedScope", async () => {
  let seen: readonly unknown[] | null = null;
  // The extracted segment shape: read the captured scope at handler entry.
  const segment = (_e: unknown) => {
    const [count, label] = capturedScope<[{ value: number }, string]>();
    seen = [count, label];
    count.value += 1;
  };
  const count = { value: 0 };
  const onClick = qrl(() => Promise.resolve(segment), "cap#click", [count, "hi"]);
  assertEquals(onClick.denextCapture, [count, "hi"]);
  await onClick({} as any);
  assertEquals(seen, [count, "hi"]);
  assertEquals(count.value, 1); // the live capture was mutated
});

Deno.test("capturedScope throws outside a running qrl handler", () => {
  assertThrows(() => capturedScope(), Error, "outside a qrl handler");
});

Deno.test("nested qrl handlers restore each other's captured scope", async () => {
  const outerSeen: string[] = [];
  const inner = qrl(
    () =>
      Promise.resolve(() => {
        outerSeen.push(capturedScope<[string]>()[0]);
      }),
    "n#inner",
    ["inner"],
  );
  const outer = qrl(
    () =>
      Promise.resolve(async () => {
        outerSeen.push(capturedScope<[string]>()[0]);
        await inner({} as any); // runs with its own scope…
        outerSeen.push(capturedScope<[string]>()[0]); // …then ours is restored
      }),
    "n#outer",
    ["outer"],
  );
  await outer({} as any);
  assertEquals(outerSeen, ["outer", "inner", "outer"]);
});

Deno.test("qrl rejects an id containing the data-dnx-h delimiters (space or colon)", () => {
  assertThrows(() => qrl(() => Promise.resolve(() => {}), "has space"), Error, "must not contain");
  assertThrows(() => qrl(() => Promise.resolve(() => {}), "has:colon"), Error, "must not contain");
  // A normal `module#export` id is fine (no space, no bare colon).
  const ok = qrl(() => Promise.resolve(() => {}), "toolbar#export");
  assertEquals(ok.denextQrlId, "toolbar#export");
});
