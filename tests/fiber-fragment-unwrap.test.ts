// A component that returns an UNKEYED top-level Fragment is transparent: its children
// reconcile directly against the component's children (React's `isUnkeyedTopLevelFragment`).
// This lets a KEYED element inside the returned fragment be matched by key — and its DOM
// node/state preserved — even when the surrounding structure changes between renders.
//
// Base UI's MenuTrigger relies on exactly this: it wraps its <button> in
// `<Fragment key={triggerId}>` and, when the menu opens, returns that keyed wrapper
// alongside focus-guard siblings inside an OUTER unkeyed fragment. Without unwrapping, the
// new outer unkeyed fragment can't match the old keyed one, so the whole subtree — the
// trigger's DOM node — is remounted, detaching floating-ui's positioning anchor (the popup
// then renders unpositioned at opacity:0). See reconciler `isPlainUnkeyedFragment`.
//
// A fragment that carries a marker prop (context Provider, StrictMode, SuspenseList,
// Profiler) is NOT plain and must keep its own fiber — the last test guards that a
// Provider whose element happens to be an unkeyed fragment still reaches its consumers.

import { assert, assertEquals } from "@std/assert";
import { Fragment, h } from "../src/jsx/jsx-runtime.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { useContext, useRef, useState } from "../src/runtime/hooks.ts";
import { createContext } from "../src/compat/react.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

Deno.test("unkeyed-fragment unwrap: a keyed child survives a surrounding structural change (MenuTrigger pattern)", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  let nextId = 1;
  let buttonMounts = 0;
  let buttonId = 0;
  // A fresh useRef cell (id 0) means this instance just mounted; a preserved cell means
  // the SAME instance was reused across the re-render.
  function Button(): VNode {
    const r = useRef(0);
    if (!r.current) {
      r.current = nextId++;
      buttonMounts++;
    }
    buttonId = r.current;
    return h("button", { "data-t": "trigger" });
  }

  let setOpen: ((v: boolean) => void) | null = null;
  function Trigger(): VNode {
    const [open, s] = useState(false);
    setOpen = s;
    // The trigger is always wrapped in a KEYED fragment (stable key), so it can be matched
    // regardless of whether the focus guards are present — this is Base UI's actual design.
    const keyed = h(Fragment, { key: "trig" }, h(Button, null));
    if (open) {
      return h(
        Fragment,
        null,
        h("i", { "data-t": "guard-pre" }),
        keyed,
        h("i", { "data-t": "guard-post" }),
      );
    }
    return keyed;
  }

  createRoot(asEl(container)).render(h(Trigger, null));
  flushSync();
  assertEquals(buttonMounts, 1, "button mounts once");
  const firstId = buttonId;

  // Open: the outer unkeyed fragment appears with guard siblings. The keyed inner fragment
  // must still be matched → the button is NOT remounted.
  setOpen!(true);
  flushSync();
  assertEquals(
    buttonMounts,
    1,
    "open: button preserved (unkeyed fragment unwrapped, keyed child matched)",
  );
  assertEquals(buttonId, firstId, "same button instance across open");

  // Close again: back to the bare keyed fragment; still the same instance.
  setOpen!(false);
  flushSync();
  assertEquals(buttonMounts, 1, "close: button still preserved");
  assertEquals(buttonId, firstId, "same button instance across close");
});

Deno.test("unkeyed-fragment unwrap: a context Provider (marker-prop fragment) is NOT unwrapped — value still reaches consumers", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  const Ctx = createContext<string>("default");
  let seen = "";
  function Consumer(): VNode {
    seen = useContext(Ctx);
    return h("span", { "data-t": "consumer" }, seen);
  }
  // A component whose rendered output is a Provider. denext encodes providers as fragments
  // carrying a (symbol-keyed) marker prop; the unwrap must skip these or the value is lost.
  function Provide(): VNode {
    return h(Ctx.Provider, { value: "provided" }, h(Consumer, null));
  }

  createRoot(asEl(container)).render(h(Provide, null));
  flushSync();
  assertEquals(seen, "provided", "provider fragment kept its fiber — consumer sees the value");
  assert(container.outerHTML.includes("provided"), "provided value rendered");
});
