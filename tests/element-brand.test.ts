// An object is an element only when `createElement` / `jsx` made it: a host element carries the
// `$$typeof` symbol, which JSON cannot express. Data shaped like an element (a stored document,
// a request body, an API response) is refused as a child and stays data as a prop, on every
// server renderer and in the client reconciler; a host tag must be a valid tag name.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import { renderToString, renderToStringSync } from "../src/jsx/render-to-string.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { renderToReadableStream } from "../src/jsx/render-to-stream.ts";
import { renderToFlightStream } from "../src/jsx/render-to-flight-stream.ts";
import { cloneElement } from "../src/runtime/react-core.ts";
import { createContext } from "../src/runtime/context.ts";
import { Suspense } from "../src/runtime/suspense.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { normalizeChildren, normalizeChildrenScoped } from "../src/client/vnode-utils.ts";
import { createFiberFromVNode } from "../src/client/fiber/fiber-utils.ts";
import { hostTagOf, isRenderableElement } from "../src/jsx/host-tag.ts";
import { render } from "../src/testing/mod.ts";
import { installErrorTexts } from "../src/client/fiber/error-texts.ts";

// The client's full error texts (a production bundle throws the code alone).
installErrorTexts();

/** What a JSON source can produce: an element's shape with no brand. */
function fromJson(type: unknown = "div"): VNodeChild {
  return JSON.parse(JSON.stringify({
    type,
    props: { dangerouslySetInnerHTML: { __html: "<i>marker</i>" } },
    key: null,
  })) as VNodeChild;
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const NOT_A_CHILD = "objects are not valid as a child";

Deno.test("element brand: an unbranded host object is refused as a child by every server renderer", async () => {
  const tree = () => h("p", null, "hello ", fromJson());
  await assertRejects(() => renderToString(tree()), Error, NOT_A_CHILD);
  let threw: unknown = null;
  try {
    renderToStringSync(tree());
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && threw.message.includes(NOT_A_CHILD));
  await assertRejects(() => renderToFlight(tree()), Error, NOT_A_CHILD);
  await assertRejects(() => renderToHtmlFlight(tree()), Error, NOT_A_CHILD);
  for (
    const html of [
      await streamText(renderToReadableStream(tree())).catch((err) => String(err)),
      await streamText(renderToFlightStream(tree())).catch((err) => String(err)),
    ]
  ) {
    assert(!html.includes("<i>marker</i>"), "the object's markup is never written");
  }
});

Deno.test("element brand: a brand JSON can spell is not the brand", async () => {
  const forged = { ...(fromJson() as VNode), $$typeof: "Symbol(react.transitional.element)" };
  await assertRejects(
    () => renderToString(h("p", null, forged as unknown as VNode)),
    Error,
    NOT_A_CHILD,
  );
});

Deno.test("element brand: a non-string host type is refused, never coerced into markup", async () => {
  for (const type of [["b"], { toString: "b" }, 7, null]) {
    await assertRejects(
      () => renderToString(h("p", null, { ...h("b", null), type } as unknown as VNode)),
      Error,
      NOT_A_CHILD,
    );
  }
});

Deno.test("element brand: element-shaped data in a prop serializes as data, not as a Flight node", async () => {
  const mod = { Island: (_p: Record<string, unknown>): VNode => h("i", null) };
  tagClientExports(mod as Record<string, unknown>, "c_brand");
  const { Island } = mod;
  const flight = await renderToFlight(h(Island, { record: fromJson() })) as unknown as {
    p: { record: Record<string, unknown> };
  };
  assertEquals(flight.p.record.$, undefined, "no Flight host tag");
  assertEquals(flight.p.record.type, "div");
  // A real element in a prop is still a Flight node.
  const real = await renderToFlight(h(Island, { icon: h("b", null, "x") })) as unknown as {
    p: { icon: { $: string; t: string } };
  };
  assertEquals([real.p.icon.$, real.p.icon.t], ["h", "b"]);
});

Deno.test("element brand: elements the app and the runtime create still render", async () => {
  const Ctx = createContext("d");
  const Row = (p: { n: number }) => h("li", null, p.n);
  const tree = h(
    Ctx.Provider,
    { value: "v" },
    h(
      Suspense,
      { fallback: null },
      h("ul", { id: "l" }, [1, 2].map((n) => h(Row, { key: n, n }))),
      cloneElement(h("my-element", { "data-a": "1" }), { "data-b": "2" }),
      h("svg", null, h("foreignObject", null), h("xlink:thing" as never, null)),
      // React's legacy brand: an element a bundled copy of an older React created.
      { $$typeof: Symbol.for("react.element"), type: "em", props: { children: "old" }, key: null },
    ),
  );
  const html = await renderToString(tree);
  assertStringIncludes(html, '<ul id="l"><li>1</li><li>2</li></ul>');
  assertStringIncludes(html, '<my-element data-a="1" data-b="2"></my-element>');
  assertStringIncludes(html, "<foreignObject></foreignObject>");
  assertStringIncludes(html, "<em>old</em>");
});

Deno.test("host tag: a tag that is not a tag name is refused by every server renderer", async () => {
  for (const tag of ["div><i>marker</i", "a b", "", "1a", "x\ny", 'p title="']) {
    const tree = () => h(tag as never, null, "x");
    await assertRejects(() => renderToString(tree()), Error, "invalid tag");
    await assertRejects(() => renderToFlight(tree()), Error, "invalid tag");
    await assertRejects(() => renderToHtmlFlight(tree()), Error, "invalid tag");
    const streamed = await streamText(renderToReadableStream(tree())).catch((err) => String(err));
    assert(!streamed.includes("<i>marker</i>"));
  }
  assertEquals(hostTagOf(h("font-face", null)), "font-face");
  assertEquals(hostTagOf(h("h1", null)), "h1");
});

Deno.test("isRenderableElement: branded hosts and component elements, never element-shaped data", () => {
  assert(isRenderableElement(h("div", null)));
  assert(isRenderableElement({ type: () => null, props: {}, key: null }));
  assert(isRenderableElement({ type: Symbol.for("react.fragment"), props: {}, key: null }));
  assert(!isRenderableElement(fromJson()));
  assert(!isRenderableElement({ type: {}, props: {} }));
  assert(!isRenderableElement({ type: "div" }));
  assert(!isRenderableElement(null));
  assert(!isRenderableElement("div"));
});

Deno.test("client: an unbranded host object is refused as a child on every normalization path", () => {
  const forged = fromJson();
  const paths: Array<() => unknown> = [
    () => normalizeChildren(forged),
    () => normalizeChildren(["text", [forged]] as VNodeChild[]),
    () => normalizeChildrenScoped(forged), // a single child
    () => normalizeChildrenScoped([h("b", null), forged]), // the flat element list
    () => normalizeChildrenScoped(["text", [forged]] as VNodeChild[]), // the flattening walk
  ];
  for (const run of paths) {
    let threw: unknown = null;
    try {
      run();
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && threw.message.includes(NOT_A_CHILD));
  }
  // A data object with no element shape, and an element-shaped one with a non-string type,
  // are refused where the fiber is created.
  for (const value of [{ a: 1 }, fromJson(["b"]), fromJson({})]) {
    let threw: unknown = null;
    try {
      createFiberFromVNode(normalizeChildrenScoped(value as VNodeChild)[0]);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof Error && threw.message.includes(NOT_A_CHILD));
  }
});

Deno.test("client: real elements, text and numbers normalize as before", () => {
  const b = h("b", null);
  assertEquals(normalizeChildrenScoped([b, h("i", null)]).length, 2);
  const mixed = normalizeChildrenScoped(["a", 1, null, [b]] as VNodeChild[]);
  assertEquals(mixed.map((v) => v.type), ["#text", "#text", "b"]);
  // An already-normalized list (text vnodes included) passes through again.
  assertEquals(normalizeChildrenScoped(mixed as VNode[]).length, 3);
  assertEquals(normalizeChildren([b, "t", 3]).map((v) => v.type), ["b", "#text", "#text"]);
});

Deno.test("client: a component that renders fetched element-shaped data throws instead of mounting it", async () => {
  const Leaky = () => h("p", null, fromJson());
  let threw: unknown = null;
  try {
    const screen = await render(h(Leaky, null));
    assert(!screen.html().includes("marker"));
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error && threw.message.includes(NOT_A_CHILD));
});
