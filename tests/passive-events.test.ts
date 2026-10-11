// React DOM listens to `touchstart`, `touchmove` and `wheel` PASSIVE (React 17+'s
// `addTrappedEventListener`), so a component with `onTouchMove` / `onWheel` never holds a scroll
// on the main thread; `touchend` / `touchcancel` stay non-passive. denext registers the same
// options wherever it listens for a handler prop or an interaction: the root / portal container
// listeners of event delegation (fiber/events.ts), the resumability dispatcher on the document
// and `useClickOutside`.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { isPassiveEvent } from "../src/runtime/passive-events.ts";
import { installQrlDispatch } from "../src/client/qrl-dispatch.ts";
import { useClickOutside } from "../src/utils/use-dom-events.ts";
import { useRef } from "../src/runtime/hooks.ts";
import { FakeDocument, FakeElement, makeDom } from "./helpers/dom.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** One `addEventListener` call as the fake DOM saw it. */
interface Registration {
  target: unknown;
  type: string;
  options: unknown;
}

/** Record every `addEventListener` on `proto` while `fn` runs (the listener still registers). */
function recording<T>(proto: Any, fn: (calls: Registration[]) => T): T {
  const calls: Registration[] = [];
  const original = proto.addEventListener;
  proto.addEventListener = function (this: unknown, type: string, l: unknown, options: unknown) {
    calls.push({ target: this, type, options });
    return original.call(this, type, l, options);
  };
  try {
    return fn(calls);
  } finally {
    proto.addEventListener = original;
  }
}

const passive = (options: unknown): boolean =>
  typeof options === "object" && options !== null && (options as Any).passive === true;
const capture = (options: unknown): boolean =>
  typeof options === "boolean" ? options : (options as Any)?.capture === true;

Deno.test("isPassiveEvent: React DOM's passive list — touchstart, touchmove, wheel only", () => {
  for (const type of ["touchstart", "touchmove", "wheel"]) assert(isPassiveEvent(type), type);
  for (
    const type of ["touchend", "touchcancel", "scroll", "click", "pointermove", "mousewheel"]
  ) assert(!isPassiveEvent(type), type);
});

Deno.test("the root listens to touchstart / touchmove / wheel passive; the element registers nothing", () => {
  const noop = () => {};
  recording(FakeElement.prototype, (calls) => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const root = createRoot(container as Any);
    root.render(
      h("div", {
        onTouchStart: noop,
        onTouchMove: noop,
        onWheel: noop,
        onTouchStartCapture: noop,
        onTouchMoveCapture: noop,
        onWheelCapture: noop,
        onTouchEnd: noop,
        onTouchCancel: noop,
      }) as VNode,
    );
    flushSync();
    const viewport = container.childNodes[0];
    assertEquals(calls.filter((c) => c.target === viewport), [], "no element listener");
    const touchWheel = ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"];
    const seen = calls.filter((c) => c.target === container && touchWheel.includes(c.type))
      .map((c) => `${c.type}${capture(c.options) ? "!" : ""}:${passive(c.options)}`);
    assertEquals(seen.sort(), [
      "touchcancel!:false",
      "touchcancel:false",
      "touchend!:false",
      "touchend:false",
      "touchmove!:true",
      "touchmove:true",
      "touchstart!:true",
      "touchstart:true",
      "wheel!:true",
      "wheel:true",
    ]);
    // Every other delegated type keeps a plain (non-passive) listener.
    const rest = calls.filter((c) => c.target === container && !touchWheel.includes(c.type));
    assert(rest.length > 0 && rest.every((c) => !passive(c.options)));
    root.unmount();
  });
});

Deno.test("a passive handler still runs, and a changed or removed one stops firing", () => {
  const seen: string[] = [];
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h("div", { onTouchMove: () => seen.push("a"), onWheel: () => seen.push("w") }));
  flushSync();
  const el = container.childNodes[0] as FakeElement;
  el.dispatch("touchmove");
  el.dispatch("wheel");
  assertEquals(seen, ["a", "w"]);
  root.render(h("div", { onTouchMove: () => seen.push("b") }));
  flushSync();
  el.dispatch("touchmove");
  el.dispatch("wheel");
  assertEquals(seen, ["a", "w", "b"], "the new touchmove handler runs, the wheel one is gone");
  assertEquals(el.listeners.size + el.captureListeners.size, 0, "nothing on the element");
  assertEquals(container.listeners.get("touchmove")?.size, 1, "one root touchmove listener");
  root.unmount();
});

Deno.test("the resumability dispatcher listens to touchstart / touchmove / wheel passive", () => {
  const g = globalThis as Any;
  const saved = { document: g.document, types: g.__dnxQrlTypes };
  const doc = new FakeDocument() as Any;
  doc.querySelectorAll = () => [{ getAttribute: () => "touchmove:q1 wheel:q2 click:q3" }];
  g.document = doc;
  delete g.__dnxQrlTypes;
  try {
    recording(FakeDocument.prototype, (calls) => {
      installQrlDispatch();
      const byType = new Map(calls.map((c) => [c.type, c.options]));
      for (const type of ["touchstart", "touchmove", "wheel"]) {
        assert(passive(byType.get(type)), `${type} passive`);
      }
      for (const type of ["click", "pointerdown", "keydown", "focusin"]) {
        assertEquals(byType.get(type), false, `${type} keeps the plain bubble listener`);
      }
    });
  } finally {
    g.document = saved.document;
    g.__dnxQrlTypes = saved.types;
  }
});

Deno.test("useClickOutside listens to touchstart passive, mousedown as before", () => {
  const g = globalThis as Any;
  const saved = g.document;
  recording(FakeDocument.prototype, (calls) => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    g.document = doc;
    try {
      const root = createRoot(container as Any);
      root.render(h(function Probe() {
        const r = useRef<Any>(null);
        useClickOutside(r, () => {});
        return h("div", { ref: r });
      } as Any, null));
      flushSync();
      const byType = new Map(calls.filter((c) => c.target === doc).map((c) => [c.type, c.options]));
      assertEquals(byType.get("touchstart"), { capture: true, passive: true });
      assertEquals(byType.get("mousedown"), true);
      root.unmount();
      assertEquals(doc.captureListeners.get("touchstart")?.size ?? 0, 0, "removed on unmount");
    } finally {
      g.document = saved;
    }
  });
});
