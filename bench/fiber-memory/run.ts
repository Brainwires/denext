// Client fiber memory: the shallow size of one fiber, and the heap a mounted list costs per row
// (after the first mount, and after a re-render has built every fiber's second buffer).
// Runs the real reconciler over the in-memory test DOM, so the per-row figure includes that
// DOM's nodes; compare runs of this script, not against a browser.
//
//   deno task bench:fiber-memory
//
// Deno runs V8 without pointer compression, so a field costs 8 bytes here and 4 bytes in a
// browser: a browser fiber is (shallow bytes here − 24) / 2 + 12.

import { h } from "../../src/jsx/jsx-runtime.ts";
import { createFiber } from "../../src/client/fiber/fiber.ts";
import { createRoot, flushSync, setDocument } from "../../src/client/reconciler.ts";
import { useState } from "../../src/runtime/hooks.ts";
import { makeDom } from "../../tests/helpers/dom.ts";
import type { VNode } from "../../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc (deno task bench:fiber-memory does)");

function heapUsed(): number {
  gc!();
  gc!();
  return Deno.memoryUsage().heapUsed;
}

/** Bytes one fresh fiber occupies (its own object, nothing it points at). */
function shallowFiberBytes(n: number): number {
  const vnode = h("div", null) as VNode;
  const keep: unknown[] = new Array(n);
  const before = heapUsed();
  for (let i = 0; i < n; i++) keep[i] = createFiber("host", vnode);
  const bytes = (heapUsed() - before) / n;
  keep.length = 0;
  return bytes;
}

/** Heap per row of a mounted list, after the mount and after one full re-render. */
function listBytes(rows: number, withHandler: boolean): { mount: number; update: number } {
  const setters: Array<(n: number) => void> = [];
  function Row({ id }: { id: number }): VNode {
    const [n, setN] = useState(0);
    setters[id] = setN;
    const props = withHandler
      ? { className: "row", onClick: () => setN(n + 1) }
      : { className: "row" };
    return h("div", props, h("span", null, "r" + id), String(n)) as VNode;
  }
  function App(): VNode {
    return h("main", null, ...Array.from({ length: rows }, (_, i) => h(Row, { key: i, id: i })));
  }
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const before = heapUsed();
  const root = createRoot(container as Any);
  root.render(h(App, null));
  flushSync();
  const mount = (heapUsed() - before) / rows;
  for (const set of setters) set(1);
  flushSync();
  const update = (heapUsed() - before) / rows;
  root.unmount();
  return { mount: Math.round(mount), update: Math.round(update) };
}

const ROWS = 10_000;
const shallow = shallowFiberBytes(200_000);
console.log(JSON.stringify(
  {
    fiberShallowBytes: Math.round(shallow),
    fiberBrowserBytesEstimate: Math.round((shallow - 24) / 2 + 12),
    rows: ROWS,
    perRowWithHandler: listBytes(ROWS, true),
    perRowStatic: listBytes(ROWS, false),
  },
  null,
  2,
));
