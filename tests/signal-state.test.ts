// Signal state transport: the server records signal values keyed by useId into
// #__denext_state, and the client adopts them instead of recomputing.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useSignal, useStore } from "../src/runtime/signals.ts";
import { setAdoptedSignalState } from "../src/runtime/signal-state.ts";
import { renderBodyScripts } from "../src/server/document.ts";
import { makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("the server records signal values into signalState keyed by useId", async () => {
  function Counter(): VNode {
    const n = useSignal(7);
    return h("span", null, `n:${n.value}`);
  }
  const { html, signalState } = await renderToHtmlFlight(h(Counter, {}));
  assert(html.includes("n:7"));
  const ids = Object.keys(signalState);
  assertEquals(ids.length, 1);
  assertEquals(signalState[ids[0]], 7);
});

Deno.test("useStore records a plain snapshot", async () => {
  function C(): VNode {
    const s = useStore({ a: 1, b: 2 });
    return h("span", null, `${s.a}-${s.b}`);
  }
  const { signalState } = await renderToHtmlFlight(h(C, {}));
  const val = signalState[Object.keys(signalState)[0]];
  assertEquals(val, { a: 1, b: 2 });
});

Deno.test("the client adopts the transported value instead of the initializer", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  function Counter() {
    const n = useSignal(0); // would be 0 without adoption
    return h("span", null, `n:${n.value}`);
  }
  // The signal's id is the component's first useId — ":d0_0:" (root slot 0).
  setAdoptedSignalState({ ":d0_0:": 42 });
  const root = createRoot(container as Any);
  root.render(h(Counter as Any, null));
  flushSync();
  setAdoptedSignalState(null);

  assertEquals((container.childNodes[0] as Any).textContent, "n:42"); // adopted, not 0
});

Deno.test("renderBodyScripts emits #__denext_state when signal state is present", () => {
  const scripts = renderBodyScripts({
    bodyHtml: "",
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname: "/" },
    clientEntry: "/entry.js",
    flight: { $: "h", t: "main", p: {}, c: [] },
    signalState: { ":d0_0:": 7 },
  });
  assert(scripts.includes('id="__denext_state"'));
  assert(scripts.includes('":d0_0:":7'));
});
