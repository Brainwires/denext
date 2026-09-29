// React SyntheticEvent compat on the native event denext hands a handler: `persist()` (a
// no-op since React 17; react-native-web's ScrollView calls it on every scroll),
// `isPersistent()`, `isDefaultPrevented()`, `isPropagationStopped()` and `nativeEvent`.

import { assert, assertEquals } from "@std/assert";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Fire a REAL `Event` at a fake-DOM element's bubble listeners. */
function fire(el: Any, event: Event): void {
  el.listeners.get(event.type)?.forEach((fn: (e: Event) => void) => fn(event));
}

Deno.test("a handler's event has React's SyntheticEvent members", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const seen: Record<string, unknown> = {};
  function App() {
    return h("div", {
      onScroll: (e: Any) => {
        e.persist(); // must not throw (react-native-web's ScrollViewBase)
        seen.persistent = e.isPersistent();
        seen.native = e.nativeEvent === e;
        seen.preventedBefore = e.isDefaultPrevented();
        seen.stoppedBefore = e.isPropagationStopped();
        e.preventDefault();
        e.stopPropagation();
        seen.preventedAfter = e.isDefaultPrevented();
        seen.stoppedAfter = e.isPropagationStopped();
      },
    });
  }
  createRoot(container as Any).render(h(App, null));
  const ev = new Event("scroll", { cancelable: true });
  fire(container.childNodes[0], ev);
  assertEquals(seen, {
    persistent: true,
    native: true,
    preventedBefore: false,
    stoppedBefore: false,
    preventedAfter: true,
    stoppedAfter: true,
  });
  // Own properties on the dispatched event only: Event.prototype is untouched.
  assert(!("persist" in Event.prototype));
  assert(Object.hasOwn(ev, "persist"));
});

Deno.test("an event's own persist (a library's synthetic event) is left alone", () => {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  let called = 0;
  function App() {
    return h("button", { onClick: (e: Any) => e.persist() }, "x");
  }
  createRoot(container as Any).render(h(App, null));
  (container.childNodes[0] as Any).dispatch("click", { persist: () => called++ });
  assertEquals(called, 1);
});
