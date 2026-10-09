// A fiber carries only the fields every kind of fiber uses; booleans share one bit field and
// rarely used state lives on an extension allocated on first write (`fiberExt`). Plain host,
// text and function-component fibers — the bulk of any tree — never allocate one, nor an
// event-listener map unless they have a handler. Run `deno task bench:fiber-memory` for bytes.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useState } from "../src/runtime/hooks.ts";
import { currentFiber } from "../src/client/fiber/hooks-dispatcher.ts";
import { fiberForNode } from "../src/client/dom-fiber-map.ts";
import {
  createFiber,
  createWorkInProgress,
  type Fiber,
  fiberExt,
  HiddenBit,
  ProfilerMountedBit,
  ShowingFallbackBit,
  StrictBit,
  UnmountedBit,
} from "../src/client/fiber/fiber.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("a fresh fiber declares a small fixed field set and no extension", () => {
  const f = createFiber("host", h("div", null) as VNode);
  // Growing this set grows EVERY fiber: rarely used state belongs on FiberExt instead.
  assertEquals(Object.keys(f).length, 28);
  assertEquals(f.ext, undefined);
  assertEquals(f.bits, 0);
});

Deno.test("plain rows allocate no extension and no listener map, across both buffers", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const rows: Fiber[] = [];
  let bump: () => void = () => {};
  function Row({ id }: { id: number }): VNode {
    rows[id] = currentFiber!;
    return h("li", { className: "row" }, h("span", null, "r" + id), "text") as VNode;
  }
  function App(): VNode {
    const [n, setN] = useState(0);
    bump = () => setN((x) => x + 1);
    return h("ul", { "data-n": n }, h(Row, { id: 0 }), h(Row, { id: 1 })) as VNode;
  }
  createRoot(container as Any).render(h(App, null));
  flushSync();
  bump(); // a re-render builds the second buffer of every fiber (createWorkInProgress)
  flushSync();
  const ul = container.childNodes[0] as Any;
  const fibers: Fiber[] = [fiberForNode(ul)!, ...rows];
  for (const li of ul.childNodes) fibers.push(fiberForNode(li)!, fiberForNode(li.childNodes[0])!);
  for (const f of fibers) {
    assert(f, "every fiber resolved");
    for (const buf of [f, f.alternate]) {
      if (buf === null) continue;
      assertEquals(buf.ext, undefined, `${String(buf.vnode.type)}: no extension`);
      assertEquals(buf.listeners, undefined, `${String(buf.vnode.type)}: no listener map`);
    }
  }
});

Deno.test("a handler added on update gets a listener map shared by both buffers", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const clicks: number[] = [];
  let setStage: (n: number) => void = () => {};
  function App(): VNode {
    const [stage, set] = useState(0);
    setStage = set;
    const props = stage === 0 ? {} : { onClick: () => clicks.push(stage) };
    return h("button", props, "b") as VNode;
  }
  createRoot(container as Any).render(h(App, null));
  flushSync();
  const button = container.childNodes[0] as Any;
  assertEquals(fiberForNode(button)!.listeners, undefined, "no handler, no map");
  setStage(1);
  flushSync();
  button.dispatch("click");
  setStage(2); // the handler swaps through the other buffer, which must see the same map
  flushSync();
  button.dispatch("click");
  setStage(0); // removed again: the old listener is detached, not orphaned
  flushSync();
  button.dispatch("click");
  assertEquals(clicks, [1, 2]);
  const f = fiberForNode(button)!;
  assert(f.listeners !== undefined && f.listeners === f.alternate?.listeners, "one shared map");
});

Deno.test("createWorkInProgress carries the extension by copy and the persistent bits", () => {
  const current = createFiber("suspense", h("div", null) as VNode);
  const x = fiberExt(current);
  x.primaryCount = 2;
  x.__error = "boom";
  x.lastImpl = "not carried";
  current.bits = ShowingFallbackBit | HiddenBit | StrictBit | ProfilerMountedBit | UnmountedBit;
  const wip = createWorkInProgress(current, null);
  assert(wip.ext !== undefined && wip.ext !== current.ext, "copied, never shared");
  assertEquals(wip.ext.primaryCount, 2);
  assertEquals(wip.ext.__error, "boom");
  assertEquals(wip.ext.lastImpl, undefined, "a twin keeps its own lastImpl");
  assertEquals(
    wip.bits,
    ShowingFallbackBit | HiddenBit | StrictBit | ProfilerMountedBit,
    "UnmountedBit is the twin's own",
  );
  // A write to the twin's extension never reaches the committed buffer.
  wip.ext.primaryCount = 5;
  assertEquals(current.ext!.primaryCount, 2);
  // A current fiber that dropped its extension state resets the twin's carried fields.
  current.ext = undefined;
  current.bits = 0;
  const again = createWorkInProgress(current, null);
  assertEquals(again.ext!.primaryCount, undefined);
  assertEquals(again.ext!.__error, undefined);
  assertEquals(again.bits, 0);
});
