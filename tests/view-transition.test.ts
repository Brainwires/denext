// `<ViewTransition>` per-element marking. Around a view transition the marking runtime
// stamps `view-transition-name` (and `view-transition-class`) on the wrapper's host child —
// the OUTGOING tree before `startViewTransition` (so the browser's old-state capture sees the
// name) and the INCOMING tree inside the callback after the commit — then clears when the
// transition finishes, so a shared `name` morphs between routes. The runtime is import-gated;
// these unbundled tests install it (see ./helpers/view-transition-runtime.ts), which the
// generated entry does in a real build. The browser animation itself can't be exercised
// without a browser, so these assert the DOM marking the browser then acts on.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "./helpers/view-transition-runtime.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { ViewTransition } from "../src/runtime/react-extras.ts";
import {
  addTransitionType,
  getViewTransitionSupport,
} from "../src/client/fiber/view-transition-support.ts";
import { render } from "../src/testing/mod.ts";
import { withViewTransition } from "../src/client/navigation.ts";

function style(el: { getAttribute(n: string): string | null }): string {
  return el.getAttribute("style") ?? "";
}

Deno.test("markOutgoing/markIncoming stamp view-transition-name on the host child, clear restores", async () => {
  const screen = await render(
    h("div", null, h(ViewTransition, { name: "hero" }, h("span", { "data-testid": "a" }, "x"))),
  );
  const el = screen.getByTestId("a");
  const vt = getViewTransitionSupport()!;
  assert(vt, "the marking runtime is installed");

  vt.markOutgoing();
  assertStringIncludes(style(el), "view-transition-name:hero", "outgoing host is named");
  vt.markIncoming();
  assertStringIncludes(style(el), "view-transition-name:hero", "incoming host is named");
  vt.clear();
  assert(!style(el).includes("view-transition-name"), "clear restores the original style");
});

Deno.test("exit classes on the outgoing side, enter classes on the incoming side", async () => {
  const screen = await render(
    h(
      ViewTransition,
      { name: "card", enter: "fx-enter", exit: "fx-exit" },
      h("span", { "data-testid": "b" }, "y"),
    ),
  );
  const el = screen.getByTestId("b");
  const vt = getViewTransitionSupport()!;

  vt.markOutgoing();
  assertStringIncludes(style(el), "view-transition-class:fx-exit", "old side carries exit");
  vt.markIncoming(); // re-stamped from the original, so the incoming class replaces the outgoing
  assertStringIncludes(style(el), "view-transition-class:fx-enter", "new side carries enter");
  assert(!style(el).includes("fx-exit"), "the outgoing class does not linger on the new side");
  vt.clear();
  assert(!style(el).includes("view-transition-class"), "clear restores the original style");
});

Deno.test("markOutgoing preserves the element's own inline style", async () => {
  const screen = await render(
    h(
      ViewTransition,
      { name: "kept" },
      h("span", { "data-testid": "c", style: { color: "red" } }, "z"),
    ),
  );
  const el = screen.getByTestId("c");
  const vt = getViewTransitionSupport()!;
  vt.markOutgoing();
  assertStringIncludes(style(el), "color:red", "author style survives");
  assertStringIncludes(style(el), "view-transition-name:kept");
  vt.clear();
  assertStringIncludes(style(el), "color:red", "author style is restored");
  assert(!style(el).includes("view-transition-name"));
});

Deno.test("withViewTransition drives the marking around startViewTransition and passes addTransitionType types", async () => {
  const screen = await render(
    h(
      ViewTransition,
      { name: "hero", enter: { "nav-forward": "slide", default: "fade" } },
      h("span", { "data-testid": "d" }, "w"),
    ),
  );
  const el = screen.getByTestId("d");

  const g = globalThis as { document?: unknown };
  const origDoc = g.document;
  let capturedTypes: string[] = [];
  let styleAtStart = "";
  let updateClass = "";
  try {
    // `finished` resolves only AFTER we've captured the mid-transition style — mirroring a
    // real browser, where `finished` (and thus `clear`) fires only once the animation ends.
    let endTransition: () => void = () => {};
    const finished = new Promise<void>((r) => (endTransition = r));
    g.document = {
      startViewTransition(arg: unknown) {
        const cb = typeof arg === "function" ? arg : (arg as { update: () => void }).update;
        capturedTypes = (arg && typeof arg === "object" && "types" in arg)
          ? (arg as { types: string[] }).types
          : [];
        // markOutgoing ran BEFORE startViewTransition — the old host is already named.
        styleAtStart = style(el);
        Promise.resolve(cb()).then(() => {
          updateClass = style(el); // after markIncoming, inside the transition
          endTransition(); // now let `finished` resolve → clear
        });
        return { ready: Promise.resolve(), finished };
      },
    };
    addTransitionType("nav-forward");
    withViewTransition(() => {});
    await new Promise((r) => setTimeout(r, 0));

    assertEquals(capturedTypes, ["nav-forward"], "buffered transition types are passed through");
    assertStringIncludes(
      styleAtStart,
      "view-transition-name:hero",
      "outgoing named before capture",
    );
    assertStringIncludes(
      updateClass,
      "view-transition-class:slide",
      "enter type-map resolved by type",
    );
    assert(!style(el).includes("view-transition-name"), "cleared after the transition finished");
  } finally {
    if (origDoc === undefined) delete g.document;
    else g.document = origDoc;
  }
});

Deno.test("SSR renders a ViewTransition's children (id-transparent)", async () => {
  const { renderToStringSync } = await import("../src/jsx/render-to-string.ts");
  const html = renderToStringSync(
    h(ViewTransition, { name: "hero" }, h("span", null, "content")),
  );
  assertEquals(html, "<span>content</span>");
});
