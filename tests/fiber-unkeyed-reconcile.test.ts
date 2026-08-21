// Unkeyed child reconciliation must reuse same-type siblings when a differently-typed
// child is inserted/removed around them — not remount the whole tail. A single forward
// cursor that consumed candidates on a type mismatch would, on a front-insert, burn past
// every reusable candidate and remount all trailing siblings (fresh hooks / lost DOM),
// which snowballed into a render↔effect storm running heavy component libraries (Base UI
// dialogs) on denext. The matcher buckets unkeyed old children by type and pops the next
// same-type one, so inserts/removes of other types don't strand the reusable siblings.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useRef, useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function domOrder(container: FakeElement): string {
  const div = (container as unknown as { childNodes: FakeElement[] }).childNodes[0];
  return (div as unknown as { childNodes: FakeElement[] }).childNodes
    .map((n) => n.getAttribute("data-t") + (n.getAttribute("data-v") ?? ""))
    .join(",");
}

Deno.test("front-insert of an unkeyed child reuses (does not remount) the trailing siblings", () => {
  // Each component mints a stable id into a ref on first render; a remount resets it.
  let nextId = 1;
  let aFirst = 0, aSecond = 0, bFirst = 0, bSecond = 0;
  function A(): VNode {
    const r = useRef(0);
    if (!r.current) r.current = nextId++;
    if (!aFirst) aFirst = r.current;
    else aSecond = r.current;
    return h("i", { "data-t": "A" });
  }
  function B(): VNode {
    const r = useRef(0);
    if (!r.current) r.current = nextId++;
    if (!bFirst) bFirst = r.current;
    else bSecond = r.current;
    return h("b", { "data-t": "B" });
  }
  function X(): VNode {
    return h("u", { "data-t": "X" });
  }

  let setInserted: ((v: boolean) => void) | null = null;
  function App(): VNode {
    const [inserted, s] = useState(false);
    setInserted = s;
    return h(
      "div",
      null,
      ...(inserted ? [h(X, null), h(A, null), h(B, null)] : [h(A, null), h(B, null)]),
    );
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(App, null));
  flushSync();
  setInserted!(true);
  flushSync();

  // A and B rendered a SECOND time reading their SAME ref (no fresh id) => reused.
  assertEquals(aSecond, 0, "A was remounted on front-insert");
  assertEquals(bSecond, 0, "B was remounted on front-insert");
  // And the DOM ends up in the right order with X first.
  assertEquals(domOrder(container), "X,A,B");
});

Deno.test("unkeyed list ops keep correct DOM order (insert / remove / swap / same-type)", () => {
  const A = (p: { v: number }): VNode => h("i", { "data-t": "A", "data-v": String(p.v) });
  const B = (p: { v: number }): VNode => h("b", { "data-t": "B", "data-v": String(p.v) });
  const C = (p: { v: number }): VNode => h("u", { "data-t": "C", "data-v": String(p.v) });

  const run = (first: VNode[], second: VNode[], expect: string) => {
    let flip: ((v: boolean) => void) | null = null;
    function App(): VNode {
      const [x, s] = useState(false);
      flip = s;
      return h("div", null, ...(x ? second : first));
    }
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    createRoot(asEl(container)).render(h(App, null));
    flushSync();
    flip!(true);
    flushSync();
    assertEquals(domOrder(container), expect);
  };

  run(
    [h(B, { v: 1 }), h(C, { v: 1 })],
    [h(A, { v: 1 }), h(B, { v: 1 }), h(C, { v: 1 })],
    "A1,B1,C1",
  ); // front-insert
  run(
    [h(A, { v: 1 }), h(B, { v: 1 })],
    [h(A, { v: 1 }), h(B, { v: 1 }), h(C, { v: 1 })],
    "A1,B1,C1",
  ); // append
  run([h(A, { v: 1 }), h(B, { v: 1 }), h(C, { v: 1 })], [h(A, { v: 1 }), h(C, { v: 1 })], "A1,C1"); // middle remove
  run([h(A, { v: 1 }), h(B, { v: 1 })], [h(B, { v: 1 }), h(A, { v: 1 })], "B1,A1"); // swap different types
  run([h(A, { v: 1 }), h(A, { v: 2 }), h(A, { v: 3 })], [h(A, { v: 1 }), h(A, { v: 3 })], "A1,A3"); // same-type drop middle
  run([h(A, { v: 1 }), h(B, { v: 1 }), h(A, { v: 2 })], [
    h(B, { v: 1 }),
    h(A, { v: 1 }),
    h(A, { v: 2 }),
  ], "B1,A1,A2"); // interleave
});
