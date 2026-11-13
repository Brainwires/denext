// Worker probe for tests/error-boundary-fallback-throw.test.ts: renders one scenario on the
// client reconciler and posts what it rendered. Run in a Worker so a render that loops forever
// (a boundary re-catching its own fallback's throw) can be terminated by the test's timeout.
// It posts `{ type: "ready" }` once this module (and the reconciler graph it imports, which the
// Worker type-checks) has loaded, so the test's render limit counts only the render.

import "../../helpers/class-runtime.ts";
import { h } from "../../../src/jsx/jsx-runtime.ts";
import { Component } from "../../../src/compat/react.ts";
import { createRoot, setDocument } from "../../../src/client/reconciler.ts";
import { ErrorBoundary } from "../../../src/runtime/error-boundary.ts";
import { makeDom } from "../../helpers/dom.ts";
import type { VNode } from "../../../src/jsx/types.ts";

type Scenario = "outer" | "root" | "class-outer" | "class-root";

function Boom(): VNode {
  throw new Error("child boom");
}

let fallbackRenders = 0;
function ThrowingFallback(_props: { error: Error }): VNode {
  fallbackRenders++;
  throw new Error("fallback boom");
}

function OuterFallback(props: { error: Error }): VNode {
  return h("p", null, `outer: ${props.error.message}`);
}

/** A class boundary whose error UI renders a child that throws. */
class ClassBoundary extends Component<{ children?: unknown }, { err: Error | null }> {
  override state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  override render(): VNode {
    return this.state.err
      ? h(ThrowingFallback, { error: this.state.err })
      : (this.props.children as VNode);
  }
}

function run(scenario: Scenario): Record<string, unknown> {
  const { doc, container } = makeDom();
  // deno-lint-ignore no-explicit-any
  setDocument(doc as any);
  const caught: string[] = [];
  const uncaught: string[] = [];
  // deno-lint-ignore no-explicit-any
  const root = createRoot(container as any, {
    onCaughtError: (e) => caught.push((e as Error).message),
    onUncaughtError: (e) => uncaught.push((e as Error).message),
  });
  const isClass = scenario.startsWith("class-");
  const inner = isClass
    // deno-lint-ignore no-explicit-any
    ? h(ClassBoundary as any, null, h(Boom, null))
    : h(ErrorBoundary, { fallback: ThrowingFallback, children: h(Boom, null) });
  let thrown: string | null = null;
  try {
    root.render(
      scenario.endsWith("outer")
        ? h(ErrorBoundary, { fallback: OuterFallback, children: inner })
        : inner,
    );
  } catch (e) {
    thrown = (e as Error).message;
  }
  return { html: container.innerHTML, caught, uncaught, thrown, fallbackRenders };
}

self.onmessage = (e: MessageEvent<Scenario>) => {
  self.postMessage({ type: "result", data: run(e.data) });
};
self.postMessage({ type: "ready" });
