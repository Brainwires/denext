// End-to-end resumability: one client component, authored with the resumability
// primitives (client:interaction + qrl handler + useSignal), emits a complete
// resumable payload — deferred island, a serialized handler dispatchable without
// hydration, and adopted signal state — and the client dispatches the handler with
// no component ever rendering.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { qrl } from "../src/runtime/qrl.ts";
import { useSignal } from "../src/runtime/signals.ts";
import { dispatchQrl } from "../src/client/qrl-dispatch.ts";
import { ISLAND_MARKER_ATTR } from "../src/runtime/lazy-directive.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// A resumable counter: a module-scope qrl handler (so it registers on import,
// without rendering) and a signal for state.
let renderCount = 0;
const inc = qrl(
  () => Promise.resolve((_e: unknown) => {/* would bump the signal */}),
  "counter#inc",
);
function Counter(): VNode {
  renderCount++;
  const n = useSignal(0);
  return h("button", { onClick: inc }, `count:${n.value}`);
}
const mod = { Counter };
tagClientExports(mod as Record<string, unknown>, "c_counter");

Deno.test("a client:interaction counter emits island + data-dnx-h + signal state", async () => {
  renderCount = 0;
  const { html, islands, signalState } = await renderToHtmlFlight(
    h("main", null, h(Counter, { "client:interaction": true })),
  );

  // Deferred island: wrapped, not hydrated up front.
  assert(html.includes(ISLAND_MARKER_ATTR), html);
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "interaction");
  // The handler survived serialization as a delegated-dispatch descriptor.
  assert(html.includes(`data-dnx-h="click:counter#inc"`), html);
  // The signal's value was captured for adoption.
  assertEquals(Object.values(signalState)[0], 0);
});

Deno.test("the handler dispatches on the server DOM with no component render", async () => {
  renderCount = 0;
  let ran = 0;
  // Re-register inc's loader to observe invocation (module-scope registration).
  qrl(() => Promise.resolve(() => ran++), "counter#inc");

  // Simulate the server DOM the client receives (a button carrying data-dnx-h).
  const { doc } = makeDom();
  const button = doc.createElement("button");
  button.setAttribute("data-dnx-h", "click:counter#inc");

  const rendersBefore = renderCount;
  // A click resolves the qrl and runs it — the component is never invoked.
  assert(dispatchQrl(button as any, "click", {}), "handler must dispatch");
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(ran, 1);
  assertEquals(renderCount, rendersBefore, "no component render happened on interaction");
});
