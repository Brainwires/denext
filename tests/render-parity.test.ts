// Parity across the streaming / flight SSR renderers with render-to-string, for the
// three cases that previously only render-to-string handled: arbitrarily-nested
// children arrays, null element `props`, and class-component `contextType`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { Component, createContext } from "../src/compat/react.ts";
import { renderToReadableStream, streamToString } from "../src/jsx/render-to-stream.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import type { VNode } from "../src/jsx/types.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("stream: renders arbitrarily-nested children arrays (no <undefined>)", async () => {
  // A component returning arrays-in-arrays (the recharts renderByOrder shape).
  function Nested() {
    return [[h("i", null, "a"), h("i", null, "b")], h("i", null, "c")] as never;
  }
  const html = await streamToString(renderToReadableStream(h(Nested as Any, null)));
  assertStringIncludes(html, "<i>a</i><i>b</i><i>c</i>");
  assert(!html.includes("<undefined>"), "no unresolved nested-array node");
});

Deno.test("stream: class component resolves contextType under a provider", async () => {
  const Theme = createContext("light");
  class Themed extends Component {
    override render() {
      return h("p", null, String(this.context));
    }
  }
  (Themed as Any).contextType = Theme;
  const html = await streamToString(
    renderToReadableStream(h(Theme.Provider as Any, { value: "dark" }, h(Themed as Any, null))),
  );
  assertStringIncludes(html, "<p>dark</p>");
});

Deno.test("flight + html-flight: tolerate a null-props element", async () => {
  // Some npm libraries construct raw elements with a null props object.
  const raw = { type: "div", props: null, key: null } as unknown as VNode;
  // Neither renderer should throw (React treats null props as {}).
  const flight = await renderToFlight(raw);
  assert(flight != null, "flight rendered a null-props element");
  const { html } = await renderToHtmlFlight(raw);
  assertEquals(html, "<div></div>");
});
