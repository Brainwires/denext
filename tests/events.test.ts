// Event-system fidelity: React event props map to the correct DOM event types
// (onChange -> input, onDoubleClick -> dblclick) and `on*Capture` registers a
// capture-phase listener that runs before the bubble-phase handler.

import { assert, assertEquals } from "@std/assert";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("onChange maps to the DOM `input` event (per-keystroke semantics)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let fired = 0;
  function App() {
    return h("input", { onChange: () => fired++ });
  }
  createRoot(container as Any).render(h(App, null));
  const input = container.childNodes[0] as Any;
  // A DOM `change` must NOT trigger React's onChange; `input` must.
  input.dispatch("change");
  assertEquals(fired, 0, "onChange should not be wired to the DOM change event");
  input.dispatch("input");
  assertEquals(fired, 1, "onChange should be wired to the DOM input event");
});

Deno.test("onDoubleClick maps to the DOM `dblclick` event", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let fired = 0;
  function App() {
    return h("button", { onDoubleClick: () => fired++ }, "x");
  }
  createRoot(container as Any).render(h(App, null));
  const btn = container.childNodes[0] as Any;
  btn.dispatch("dblclick");
  assertEquals(fired, 1);
});

Deno.test("on*Capture registers a capture-phase listener (runs before bubble)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const order: string[] = [];
  function App() {
    return h("button", {
      onClick: () => order.push("bubble"),
      onClickCapture: () => order.push("capture"),
    }, "x");
  }
  createRoot(container as Any).render(h(App, null));
  const btn = container.childNodes[0] as Any;
  // Both handlers live on the DOM `click` type — the old code produced a
  // broken `clickcapture` type. Capture must fire first.
  assert(btn.captureListeners.has("click"), "capture handler must be on `click`");
  assert(!btn.listeners.has("clickcapture"), "must not create a `clickcapture` type");
  btn.dispatch("click");
  assertEquals(order, ["capture", "bubble"]);
});

Deno.test("onChange and onInput coexist (no listener-key collision) (M1)", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let change = 0, input = 0;
  function App() {
    return h("input", { onChange: () => change++, onInput: () => input++ });
  }
  createRoot(container as Any).render(h(App, null));
  // Both map to the DOM "input" event; both handlers must fire (React allows both).
  (container.childNodes[0] as Any).dispatch("input");
  assertEquals(change, 1, "onChange fired");
  assertEquals(input, 1, "onInput fired");
});

Deno.test("removing an on*Capture prop detaches the capture listener", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let fired = 0;
  function App(props: { withCapture: boolean }) {
    return h(
      "button",
      props.withCapture ? { onClickCapture: () => fired++ } : {},
      "x",
    );
  }
  const root = createRoot(container as Any);
  root.render(h(App, { withCapture: true }));
  const btn = container.childNodes[0] as Any;
  btn.dispatch("click");
  assertEquals(fired, 1);
  root.render(h(App, { withCapture: false }));
  btn.dispatch("click");
  assertEquals(fired, 1, "capture listener should be gone after prop removal");
});
