// A discrete DOM event (click/keydown) enqueues an URGENT update that must keep its
// priority even while an async transition is pending — it is not demoted to
// transition priority by the coarse async-window entanglement (React's lane model:
// SyncLane for discrete events is never demoted by a transition). Only updates
// OUTSIDE any event handler — the transition's own post-await continuations — stay
// entangled. See src/client/event-priority.ts + reconciler.scheduleUpdate.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { useState, useTransition } from "../mod.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const micro = () => Promise.resolve();
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Find the nth (0-based) element of `tag` under `root`. */
function findAll(root: FakeElement, tag: string): FakeElement[] {
  const up = tag.toUpperCase();
  const out: FakeElement[] = [];
  // deno-lint-ignore no-explicit-any
  const stack: any[] = [...root.childNodes];
  while (stack.length) {
    const n = stack.shift();
    if (n && n.tagName === up) out.push(n as FakeElement);
    if (n && n.childNodes) stack.unshift(...n.childNodes);
  }
  return out;
}

Deno.test("a discrete click stays urgent while an async transition is pending", async () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => (resolveGate = r));

  function App(): VNode {
    const [n, setN] = useState(0); // urgent counter (bumped by a click)
    const [label, setLabel] = useState("idle"); // transition target
    const [, start] = useTransition();
    const startSlow = () =>
      start(async () => {
        await gate;
        setLabel("done");
      });
    return h(
      "div",
      null,
      h("button", { onClick: startSlow }, "start"),
      h("button", { onClick: () => setN((x) => x + 1) }, String(n)),
      h("span", null, label),
    );
  }

  createRoot(container as Any).render(h(App, null));
  flushSync();
  const [startBtn, urgentBtn] = findAll(container, "button");

  // Begin the slow async transition (its post-await setLabel is gated).
  startBtn.dispatch("click");
  await micro();
  assertEquals(
    container.innerHTML.includes("<span>idle</span>"),
    true,
    "transition still pending (gate not resolved)",
  );

  // Click the urgent button WHILE the async transition is pending. The counter must
  // update on the urgent path (flushed on the sync microtask), not be deferred.
  urgentBtn.dispatch("click");
  await micro();
  await micro();
  assertEquals(
    container.innerHTML,
    "<div><button>start</button><button>1</button><span>idle</span></div>",
    "the discrete click applied urgently; the transition is still pending",
  );

  // Resolve the transition: its own post-await update lands on the transition flush.
  resolveGate();
  await tick();
  await tick();
  assertEquals(
    container.innerHTML,
    "<div><button>start</button><button>1</button><span>done</span></div>",
    "the settled async transition applies its own update",
  );
});
