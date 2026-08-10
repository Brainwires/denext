// Regression tests for two bugs found in the fiber production-readiness audit:
//  1. A class shouldComponentUpdate/PureComponent bailout dropped a function
//     descendant's pending state update (beginWork returned null instead of
//     descending where childLanes had work).
//  2. Effects of a sibling that completed *before* a suspension/error unwind were
//     run at commit even though that content was discarded for the fallback.

import { assert, assertEquals } from "@std/assert";
import { Component } from "../src/compat/react.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { useEffect, useLayoutEffect, useState } from "../src/runtime/hooks.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("a descendant's update is not dropped when a class ancestor SCU-bails", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let setChild: (v: string) => void = () => {};
  function Child(): VNode {
    const [v, set] = useState("a");
    setChild = (x) => set(() => x);
    return h("span", null, v);
  }
  // A class parent whose shouldComponentUpdate always returns false: it never
  // re-renders itself, but its subtree must still update when a child does.
  class Frozen extends Component<Record<string, never>> {
    shouldComponentUpdate() {
      return false;
    }
    override render() {
      return h("div", null, h(Child as Any, null));
    }
  }

  createRoot(container as Any).render(h(Frozen as Any, null));
  assertEquals(container.innerHTML, "<div><span>a</span></div>");

  setChild("b");
  flushSync();
  assertEquals(
    container.innerHTML,
    "<div><span>b</span></div>",
    "child update must land through a SCU-bailed class ancestor",
  );
});

Deno.test("effects of content discarded by a suspension do not run", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let sideEffectRan = false;
  function WithEffect(): VNode {
    useLayoutEffect(() => {
      sideEffectRan = true;
    }, []);
    return h("p", null, "a");
  }
  function Suspender(): VNode {
    throw new Promise<void>(() => {}); // suspends and never settles (no retry)
  }

  createRoot(container as Any).render(
    h(Suspense, {
      fallback: h("span", null, "loading"),
      children: [h(WithEffect, null), h(Suspender, null)],
    }),
  );
  flushSync();

  // The subtree suspended → fallback is shown; WithEffect was discarded and never
  // placed in the DOM, so its layout effect must not have run.
  assertEquals(container.innerHTML, "<span>loading</span>");
  assert(!sideEffectRan, "a discarded sibling's effect must not run");
});

Deno.test("effects of content discarded by an error boundary do not run", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);

  let sideEffectRan = false;
  function WithEffect(): VNode {
    useEffect(() => {
      sideEffectRan = true;
    }, []);
    return h("p", null, "ok");
  }
  function Boom(): VNode {
    throw new Error("boom");
  }
  function Fallback(): VNode {
    return h("span", null, "caught");
  }

  createRoot(container as Any).render(
    h(ErrorBoundary, {
      fallback: Fallback as Any,
      children: [h(WithEffect, null), h(Boom, null)],
    }),
  );
  flushSync();

  assertEquals(container.innerHTML, "<span>caught</span>");
  assert(!sideEffectRan, "a discarded sibling's effect must not run under an error boundary");
});
