// Render-phase updates: a component that calls its own setState WHILE rendering
// itself (React's "adjust state during render" idiom — used by Base UI's Dialog /
// transition-status hooks, `usePrevious`-style prop tracking, etc.). React re-renders
// just that component in place, reading the updated state, until it converges — no
// commit in between. denext must do the same rather than scheduling a whole-tree
// re-render + commit per pass (which for the transition idiom feeds the state back on
// itself, never converges, and trips the render-pass guard — leaving Base UI dialogs
// mounted but stuck at opacity:0, i.e. invisible). Regression test for that class.

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("render-phase update converges and commits in the same pass (no throw)", () => {
  // The canonical Base-UI-shaped idiom: derive `status` from the `open` prop by
  // adjusting state during render when the prop changed since the last render.
  function Dialog({ open }: { open: boolean }): VNode {
    const [prevOpen, setPrevOpen] = useState(open);
    const [status, setStatus] = useState(open ? "open" : "closed");
    if (open !== prevOpen) {
      setPrevOpen(open);
      setStatus(open ? "open" : "closed");
    }
    return h("div", { "data-status": status });
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));

  root.render(h(Dialog, { open: false }));
  flushSync();
  assertEquals(
    (container.childNodes[0] as unknown as FakeElement).getAttribute("data-status"),
    "closed",
  );

  // Re-render with open=true: the render-phase updates must converge to "open" within
  // the SAME commit — no async second pass, no "Maximum update depth" throw.
  root.render(h(Dialog, { open: true }));
  flushSync();
  assertEquals(
    (container.childNodes[0] as unknown as FakeElement).getAttribute("data-status"),
    "open",
  );
});

Deno.test("render-phase update at mount converges to a fixed point", () => {
  // Count up during render until a threshold — a stress form of the idiom that must
  // settle at the fixed point in one commit rather than looping forever.
  function Counter(): VNode {
    const [n, setN] = useState(0);
    if (n < 5) setN(n + 1);
    return h("span", { "data-n": String(n) });
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(Counter, null));
  flushSync();
  assertEquals((container.childNodes[0] as unknown as FakeElement).getAttribute("data-n"), "5");
});

Deno.test("effects run once with the CONVERGED state, not the intermediate one", () => {
  // The render-phase re-invocation must not drop or duplicate effects: the effect
  // keyed on `status` fires exactly once, and with the final value.
  const effectValues: string[] = [];
  function Dialog({ open }: { open: boolean }): VNode {
    const [prevOpen, setPrevOpen] = useState(open);
    const [status, setStatus] = useState(open ? "open" : "closed");
    if (open !== prevOpen) {
      setPrevOpen(open);
      setStatus(open ? "open" : "closed");
    }
    useEffect(() => {
      effectValues.push(status);
    }, [status]);
    return h("div", { "data-status": status });
  }

  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  const root = createRoot(asEl(container));

  root.render(h(Dialog, { open: false }));
  flushSync();
  assertEquals(effectValues, ["closed"]); // mount effect ran once

  root.render(h(Dialog, { open: true }));
  flushSync();
  // The status effect re-ran exactly once, with the converged "open" — not the
  // discarded intermediate render, and not dropped.
  assertEquals(effectValues, ["closed", "open"]);
});

Deno.test("a mount whose render-phase update also mounts an effect still runs it", () => {
  // Regression for the deps-in-place hazard: an effect first queued during a discarded
  // sub-render must still commit on the final pass (not be suppressed as "unchanged").
  const ran: number[] = [];
  function Widget(): VNode {
    const [n, setN] = useState(0);
    if (n < 3) setN(n + 1);
    useEffect(() => {
      ran.push(n);
    }, [n]);
    return h("i", { "data-n": String(n) });
  }
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  createRoot(asEl(container)).render(h(Widget, null));
  flushSync();
  assertEquals((container.childNodes[0] as unknown as FakeElement).getAttribute("data-n"), "3");
  assertEquals(ran, [3]); // exactly one mount effect, with the converged value
});
