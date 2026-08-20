// Stage 4 core: dispatch a serialized handler WITHOUT running its component.
// The server stamps data-dnx-h; dispatchQrl resolves an event to the qrl and runs it.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { qrl } from "../src/runtime/qrl.ts";
import { dispatchQrl } from "../src/client/qrl-dispatch.ts";
import { makeDom } from "./helpers/dom.ts";

Deno.test("the server stamps data-dnx-h for a qrl handler", async () => {
  const onClick = qrl(() => Promise.resolve(() => {}), "btn#click");
  const html = await renderToString(h("button", { onClick }, "go"));
  assert(html.includes(`data-dnx-h="click:btn#click"`), html);
  // A plain function handler is still dropped (no data-dnx-h).
  const plain = await renderToString(h("button", { onClick: () => {} }, "x"));
  assert(!plain.includes("data-dnx-h"), plain);
});

Deno.test("onChange maps to the input event type in data-dnx-h", async () => {
  const onChange = qrl(() => Promise.resolve(() => {}), "f#change");
  const html = await renderToString(h("input", { onChange }));
  assert(html.includes(`data-dnx-h="input:f#change"`), html);
});

Deno.test("multiple handlers are all stamped", async () => {
  const html = await renderToString(
    h("button", {
      onClick: qrl(() => Promise.resolve(() => {}), "a"),
      onPointerDown: qrl(() => Promise.resolve(() => {}), "b"),
    }, "x"),
  );
  assert(html.includes("click:a"), html);
  assert(html.includes("pointerdown:b"), html);
});

Deno.test("dispatchQrl runs the handler for a stamped node without rendering", async () => {
  let ran = 0;
  qrl(() => Promise.resolve(() => ran++), "z#go"); // registers the loader (module-scope)
  const { doc } = makeDom();
  const button = doc.createElement("button");
  button.setAttribute("data-dnx-h", "click:z#go");

  assert(dispatchQrl(button as any, "click", {}), "expected a handler dispatch");
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(ran, 1);
  // No handler for a different event type.
  assertEquals(dispatchQrl(button as any, "input", {}), false);
});

Deno.test("dispatchQrl walks ancestors to the nearest handler host", async () => {
  let ran = 0;
  qrl(() => Promise.resolve(() => ran++), "outer#go");
  const { doc } = makeDom();
  const outer = doc.createElement("div");
  outer.setAttribute("data-dnx-h", "click:outer#go");
  const inner = doc.createElement("span");
  outer.appendChild(inner);

  assert(dispatchQrl(inner as any, "click", {}), "a descendant event must resolve upward");
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(ran, 1);
});

Deno.test("dispatchQrl returns false when no ancestor carries the handler", () => {
  const { doc } = makeDom();
  const stray = doc.createElement("div");
  assertEquals(dispatchQrl(stray as any, "click", {}), false);
  assertEquals(dispatchQrl(null, "click", {}), false);
});
