// The live-view Flight diff (`diffFlight`) and its copy-on-write application (`applyFlightOps`).

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { FlightNode } from "../src/jsx/render-to-flight.ts";
import {
  applyFlightOps,
  diffFlight,
  FlightPatchError,
  jsonEqual,
} from "../src/runtime/flight-patch.ts";

const el = (t: string, p: Record<string, unknown>, ...c: FlightNode[]): FlightNode =>
  ({ $: "h", t, p, c }) as FlightNode;

Deno.test("diffFlight: a text change is one replace at its path", () => {
  const a = [el("div", {}, el("p", {}, "n=1"), el("button", { type: "button" }, "+"))];
  const b = [el("div", {}, el("p", {}, "n=2"), el("button", { type: "button" }, "+"))];
  const ops = diffFlight(a, b);
  assertEquals(ops, [["r", [0, 0, 0], "n=2"]]);
  assertEquals(applyFlightOps(a, ops), b);
});

Deno.test("diffFlight: changed and removed props are one props op", () => {
  const a = [el("input", { value: "a", disabled: true, onInput: { __dnxlv: 0 } })];
  const b = [el("input", { value: "ab", onInput: { __dnxlv: 0 } })];
  const ops = diffFlight(a, b);
  assertEquals(ops, [["p", [0], { value: "ab" }, ["disabled"]]]);
  assertEquals(applyFlightOps(a, ops), b);
});

Deno.test("diffFlight: an item appended to a list is one splice, not the whole list", () => {
  const item = (s: string) => el("li", {}, s);
  const a = [el("ul", {}, item("a"), item("b"))];
  const b = [el("ul", {}, item("a"), item("b"), item("c"))];
  const ops = diffFlight(a, b);
  assertEquals(ops, [["s", [0], 2, 0, [item("c")]]]);
  assertEquals(applyFlightOps(a, ops), b);
  // Removing the first of differently-tagged siblings splices it out and keeps the rest.
  const c = [el("h1", {}, "t"), el("p", {}, "x"), el("footer", {}, "f")];
  const d = [el("p", {}, "x"), el("footer", {}, "f")];
  assertEquals(applyFlightOps(c, diffFlight(c, d)), d);
});

Deno.test("diffFlight: a changed tag swaps the node; equal trees give no ops", () => {
  const a = [el("p", {}, "x")];
  const b = [el("span", {}, "x")];
  assertEquals(diffFlight(a, b), [["s", [], 0, 1, [b[0]]]]);
  const nested = [el("div", {}, el("p", {}, "x"))];
  const swapped = [el("div", {}, el("p", {}, el("b", {}, "x")))];
  assertEquals(diffFlight(nested, swapped), [["s", [0, 0], 0, 1, [el("b", {}, "x")]]]);
  assertEquals(diffFlight(a, structuredClone(a)), []);
});

Deno.test("applyFlightOps never mutates the tree it patches", () => {
  const a = [el("div", { id: "x" }, el("p", {}, "1"), el("p", {}, "2"))];
  const frozen = structuredClone(a);
  const b = [el("div", { id: "y" }, el("p", {}, "1"), el("p", {}, "3"), el("p", {}, "4"))];
  const out = applyFlightOps(a, diffFlight(a, b));
  assertEquals(out, b);
  assertEquals(a, frozen, "the previous render's props objects stay as they were");
  // Untouched subtrees are shared, not copied.
  assert((out[0] as { c: FlightNode[] }).c[0] === (a[0] as { c: FlightNode[] }).c[0]);
});

Deno.test("applyFlightOps refuses ops that do not fit (a stale base)", () => {
  const a = [el("p", {}, "x")];
  assertThrows(() => applyFlightOps(a, [["r", [3], "y"]]), FlightPatchError);
  assertThrows(() => applyFlightOps(a, [["r", [0, 0, 0], "y"]]), FlightPatchError);
  assertThrows(() => applyFlightOps(a, [["s", [], 5, 0, []]]), FlightPatchError);
  assertThrows(() => applyFlightOps(a, [["p", [0, 0], {}, []]]), FlightPatchError);
  assertThrows(() => applyFlightOps(a, [["r", [], "y"]]), FlightPatchError);
  assertThrows(
    () => applyFlightOps(a, [["x", [0]] as unknown as ["r", number[], FlightNode]]),
    FlightPatchError,
  );
});

/** A seeded PRNG (mulberry32), so a failing case replays. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTree(r: () => number, depth: number): FlightNode[] {
  const n = Math.floor(r() * 5);
  const out: FlightNode[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    if (depth === 0 || roll < 0.3) out.push(roll < 0.15 ? String(Math.floor(r() * 4)) : null);
    else if (roll < 0.4) out.push(randomTree(r, depth - 1) as FlightNode);
    else {
      const p: Record<string, unknown> = {};
      if (r() < 0.5) p.className = `c${Math.floor(r() * 3)}`;
      if (r() < 0.3) p.onClick = { __dnxlv: Math.floor(r() * 3) };
      out.push(el(["div", "p", "li"][Math.floor(r() * 3)], p, ...randomTree(r, depth - 1)));
    }
  }
  return out;
}

Deno.test("diffFlight + applyFlightOps round-trip 2000 random tree pairs", () => {
  const r = rng(0xdeed);
  for (let i = 0; i < 2000; i++) {
    const a = randomTree(r, 4);
    const b = randomTree(r, 4);
    const ops = diffFlight(a, b);
    const out = applyFlightOps(a, ops);
    assert(jsonEqual(out, b), `case ${i}: ${JSON.stringify({ a, b, ops })}`);
  }
});
