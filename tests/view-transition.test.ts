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

Deno.test("begin() stamps outgoing names, markIncoming stamps the incoming side, clear restores", async () => {
  const screen = await render(
    h("div", null, h(ViewTransition, { name: "hero" }, h("span", { "data-testid": "a" }, "x"))),
  );
  const el = screen.getByTestId("a");
  const vt = getViewTransitionSupport()!;
  assert(vt, "the marking runtime is installed");

  const tx = vt.begin([]); // stamps the outgoing hosts now
  assertStringIncludes(style(el), "view-transition-name:hero", "outgoing host is named");
  tx.markIncoming();
  assertStringIncludes(style(el), "view-transition-name:hero", "incoming host is named");
  tx.clear();
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

  const tx = vt.begin([]);
  assertStringIncludes(style(el), "view-transition-class:fx-exit", "old side carries exit");
  tx.markIncoming(); // re-stamped from the original, so the incoming class replaces the outgoing
  assertStringIncludes(style(el), "view-transition-class:fx-enter", "new side carries enter");
  assert(!style(el).includes("fx-exit"), "the outgoing class does not linger on the new side");
  tx.clear();
  assert(!style(el).includes("view-transition-class"), "clear restores the original style");
});

Deno.test("begin() preserves the element's own inline style", async () => {
  const screen = await render(
    h(
      ViewTransition,
      { name: "kept" },
      h("span", { "data-testid": "c", style: { color: "red" } }, "z"),
    ),
  );
  const el = screen.getByTestId("c");
  const vt = getViewTransitionSupport()!;
  const tx = vt.begin([]);
  assertStringIncludes(style(el), "color:red", "author style survives");
  assertStringIncludes(style(el), "view-transition-name:kept");
  tx.clear();
  assertStringIncludes(style(el), "color:red", "author style is restored");
  assert(!style(el).includes("view-transition-name"));
});

Deno.test("an unsafe name/class is dropped, never injected into the style attribute (CSS-injection guard)", async () => {
  const screen = await render(
    h("div", null, [
      h(
        ViewTransition,
        { name: "x;position:fixed;inset:0", enter: "ok-enter" },
        h("span", { "data-testid": "bad" }, "1"),
      ),
      h(
        ViewTransition,
        { name: "safe-1", enter: "evil;background:url(//x)" },
        h("span", { "data-testid": "good" }, "2"),
      ),
    ]),
  );
  const vt = getViewTransitionSupport()!;
  const tx = vt.begin([]);
  const bad = screen.getByTestId("bad");
  const good = screen.getByTestId("good");
  // The injected name is not a valid CSS ident → dropped entirely (no position:fixed leaks in).
  assert(!style(bad).includes("position:fixed"), "no CSS declaration injection via name");
  assert(!style(bad).includes("view-transition-name"), "an unsafe name is not stamped at all");
  // The valid name IS stamped; the unsafe class token is dropped.
  tx.markIncoming();
  assertStringIncludes(style(good), "view-transition-name:safe-1", "a valid name is stamped");
  assert(!style(good).includes("background:url"), "no CSS declaration injection via class");
  tx.clear();
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

Deno.test("SSR stamps the config attribute on the child (survives SSR + Flight), no wrapper", async () => {
  const { renderToStringSync } = await import("../src/jsx/render-to-string.ts");
  // The config rides a DOM attribute on the child element — the only carrier that survives
  // server rendering AND the Flight boundary (a VNode/Fragment marker would be dropped). No
  // wrapper element is added; the child stays the child.
  const html = renderToStringSync(
    h(ViewTransition, { name: "hero" }, h("span", { id: "x" }, "content")),
  );
  assertStringIncludes(html, "content");
  assertStringIncludes(html, "<span");
  assertStringIncludes(html, "data-dnx-vt=");
  assertStringIncludes(html, "hero"); // the JSON-encoded name is present in the attribute
  // A wrapper with no single element child (or no name/class) is a transparent passthrough.
  assertEquals(
    renderToStringSync(h(ViewTransition, null, "just text")),
    "just text",
  );
});
