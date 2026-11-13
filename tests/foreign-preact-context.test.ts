// A package that brings its own copy of Preact (a JSR icon set importing `npm:preact`, as Deno
// SaaSKit's `@preact-icons` does) renders on denext: real Preact calls a component whose
// `contextType` is one of its contexts as `(props, value)` — its `Context.Consumer` is
// `(props, value) => props.children(value)` (preact/src/create-context.js) — so denext passes
// such a component the context's default value. Before, the consumer got `undefined` and the
// page failed with "Cannot read properties of undefined".

import { assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";

/** A context the way Preact 10's production build makes one (mangled `__c` id, `__` default). */
function preactContext<T>(defaultValue: T) {
  const Context = { __c: "__cC0", __: defaultValue } as Record<string, unknown>;
  const Consumer = (props: { children: (v: T) => unknown }, value: T) => props.children(value);
  (Consumer as unknown as { contextType: unknown }).contextType = Context;
  return { Consumer };
}

Deno.test("a foreign Preact context's consumer gets the context's default value", async () => {
  const IconContext = preactContext({ size: "1em", color: "currentColor" });
  const Icon = () =>
    h(IconContext.Consumer as never, {
      children: ((ctx: { size: string }) => h("svg", { width: ctx.size })) as never,
    });
  assertEquals(await renderToString(h(Icon, null)), '<svg width="1em"></svg>');
  // A component with a denext-style (or no) contextType is called with its props only.
  const Plain = (_props: unknown, second?: unknown) => h("i", null, String(second));
  (Plain as unknown as { contextType: unknown }).contextType = { _id: Symbol("ctx") };
  assertEquals(await renderToString(h(Plain as never, null)), "<i>undefined</i>");
});
