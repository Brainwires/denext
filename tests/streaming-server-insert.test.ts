import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderShell } from "../src/jsx/render-to-stream.ts";
import { renderFlightShell } from "../src/jsx/render-to-flight-stream.ts";
import { prerenderToShellFlight } from "../src/jsx/render-to-ppr-flight.ts";
import { useServerInsertedHTML } from "../src/runtime/server-inserted-html.ts";
import type { VNode } from "../src/jsx/types.ts";

// Regression: `useServerInsertedHTML` (the CSS-in-JS SSR primitive used by
// styled-components/emotion registries) must hoist its <style> markup into the document
// <head> on the DEFAULT streaming paths — not only the buffered `renderToString` /
// `renderToHtmlFlight` paths. Before the fix, `renderShell`/`renderFlightShell`/the PPR
// shell never installed the sink, so streamed apps silently lost their server styles.

/** The registry pattern: register a callback returning collected <style> markup. */
function StyleRegistry({ children }: { children: VNode }): VNode {
  useServerInsertedHTML(() => h("style", { "data-denext": "sc" }, ".x{color:red}"));
  return children;
}

const newHead = () => ({ tags: [] as string[] }) as { tags: string[]; serverInserted?: string[] };

Deno.test("renderShell (streaming HTML) flushes useServerInsertedHTML into the head", async () => {
  const head = newHead();
  const { shell } = await renderShell(
    h(StyleRegistry, null, h("div", { className: "x" }, "hi")),
    head,
  );
  assertStringIncludes(shell, '<div class="x">hi</div>');
  assertEquals(head.serverInserted?.length, 1);
  assertStringIncludes(
    head.serverInserted![0],
    '<style data-denext="sc">.x{color:red}</style>',
  );
  assertEquals(
    shell.includes("<style"),
    false,
    "inserted markup goes to <head>, not the body",
  );
});

Deno.test("renderFlightShell (streaming Flight) flushes useServerInsertedHTML into the head", async () => {
  const head = newHead();
  const { shellHtml } = await renderFlightShell(
    h(StyleRegistry, null, h("div", { className: "x" }, "hi")),
    false,
    head,
  );
  assertStringIncludes(shellHtml, '<div class="x">hi</div>');
  assertEquals(head.serverInserted?.length, 1);
  assertStringIncludes(
    head.serverInserted![0],
    '<style data-denext="sc">.x{color:red}</style>',
  );
});

Deno.test("prerenderToShellFlight (PPR) flushes useServerInsertedHTML into the head", async () => {
  const head = newHead();
  const res = await prerenderToShellFlight(
    h(StyleRegistry, null, h("div", { className: "x" }, "hi")),
    { head },
  );
  assert(!res.dynamic, "a static shell was produced");
  assertEquals(head.serverInserted?.length, 1);
  assertStringIncludes(
    head.serverInserted![0],
    '<style data-denext="sc">.x{color:red}</style>',
  );
});
