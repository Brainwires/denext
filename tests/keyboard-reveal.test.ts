// Keeping the focused text field above the keyboard (src/mobile/keyboard-reveal.ts). Found on
// the iPhone run of examples/expo-app: with the shell's `resize: "native"` the WebView shrank
// around the keyboard after WebKit's focus scroll, and a note field low on the Lab screen stayed
// under the keyboard inside its ScrollView.

import { assertEquals } from "@std/assert";
import { joinFocusedFieldReveal, revealFocusedField } from "../src/mobile/keyboard-reveal.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** A scroll container holding one field at `fieldTop` (content coordinates) of `height` px. */
function scene(opts: { viewport: number; fieldTop: number; height?: number; tag?: string }) {
  const scroller: Any = {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: opts.viewport,
    parentElement: null,
    style: { overflowY: "auto" },
  };
  const h = opts.height ?? 40;
  const field: Any = {
    tagName: opts.tag ?? "INPUT",
    type: "text",
    parentElement: scroller,
    getBoundingClientRect: () => ({
      top: opts.fieldTop - scroller.scrollTop,
      bottom: opts.fieldTop - scroller.scrollTop + h,
    }),
  };
  const listeners = new Map<string, () => void>();
  const target = (name: string) => ({
    addEventListener: (t: string, fn: () => void) => listeners.set(`${name}:${t}`, fn),
    removeEventListener: (t: string) => listeners.delete(`${name}:${t}`),
  });
  const globals: Record<string, unknown> = {
    document: { activeElement: field, scrollingElement: null, ...target("document") },
    innerHeight: opts.viewport,
    visualViewport: { height: opts.viewport, offsetTop: 0, ...target("vv") },
    getComputedStyle: (el: Any) => el.style ?? { overflowY: "visible" },
    requestAnimationFrame: (fn: () => void) => (fn(), 0),
    ...target("window"),
  };
  return { scroller, field, globals, listeners };
}

/** Run `fn` with `globals` installed on globalThis (until its promise settles, when async). */
async function withGlobals<T>(globals: Record<string, unknown>, fn: () => T): Promise<Awaited<T>> {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.keys(globals).map((k) =>
    [k, Object.getOwnPropertyDescriptor(g, k)] as const
  );
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

Deno.test("revealFocusedField: a field below the resized viewport scrolls into view", async () => {
  // The WebView shrank to 508 px around the keyboard; the field sits at 784–824.
  const s = scene({ viewport: 508, fieldTop: 784 });
  await withGlobals(s.globals, () => {
    assertEquals(revealFocusedField(0), true);
    // Its bottom lands 12 px above the new bottom edge: 824 + 12 - 508.
    assertEquals(s.scroller.scrollTop, 328);
    assertEquals(revealFocusedField(0), false, "already visible: nothing more");
  });
});

Deno.test("revealFocusedField: the covered height counts when the keyboard overlays the page", async () => {
  // resize: "none": an 844 px page, 336 px of it under the keyboard.
  const s = scene({ viewport: 844, fieldTop: 700 });
  await withGlobals(s.globals, () => {
    assertEquals(revealFocusedField(336), true);
    assertEquals(s.scroller.scrollTop, 700 + 40 + 12 - (844 - 336));
  });
});

Deno.test("revealFocusedField: only text fields; a tall field keeps its top visible", async () => {
  const button = scene({ viewport: 508, fieldTop: 784, tag: "BUTTON" });
  await withGlobals(button.globals, () => assertEquals(revealFocusedField(0), false));
  const checkbox = scene({ viewport: 508, fieldTop: 784 });
  checkbox.field.type = "checkbox";
  await withGlobals(checkbox.globals, () => assertEquals(revealFocusedField(0), false));
  // A 600 px textarea at 100: its bottom cannot fit, so it moves only until its top is at 12.
  const tall = scene({ viewport: 508, fieldTop: 100, height: 600, tag: "TEXTAREA" });
  await withGlobals(tall.globals, () => {
    revealFocusedField(0);
    assertEquals(tall.scroller.scrollTop, 88);
  });
});

Deno.test("joinFocusedFieldReveal: shared listeners, a covered-height change re-checks, the last leave stops", async () => {
  const s = scene({ viewport: 508, fieldTop: 784 });
  await withGlobals(s.globals, async () => {
    const a = joinFocusedFieldReveal();
    const b = joinFocusedFieldReveal();
    assertEquals(
      [...s.listeners.keys()].sort(),
      ["document:focusin", "vv:resize", "window:resize"],
    );
    a.covered(0); // unchanged: no check
    s.listeners.get("window:resize")!();
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(s.scroller.scrollTop, 328, "the resize re-check revealed the field");
    a.leave();
    assertEquals(s.listeners.size, 3, "still one user");
    b.leave();
    assertEquals(s.listeners.size, 0, "the last leave removes the listeners");
  });
});
