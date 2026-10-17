// Lustre components as custom elements in denext JSX (`lustreElement`): the server render with the
// shadow root prerendered as Declarative Shadow DOM (`component.prerender`), the browser render
// without it (the parser already attached it), registration once per tag from the island, and the
// `LustreElementAttributes` typing for the tag itself. Fake Lustre functions record the calls;
// tests/e2e/lustre.e2e.test.ts runs the real thing in a browser.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { JSX } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { render } from "../src/testing/mod.ts";
import { useState } from "../src/runtime/hooks.ts";
import { lustreElement, type LustreElementAttributes, lustreKit } from "../src/gleam.ts";
import type { LustreApp, LustreModules } from "../src/lustre/kit.ts";

declare module "denext/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "x-counter": LustreElementAttributes<{ start: `${number}` }>;
    }
  }
}

const ok = <T>(value: T) => Object.assign([value], { isOk: () => true });

/** Fake Lustre: `prerender` folds the attributes into `<p>`, `register` records each tag. */
function fake(browser = false) {
  const registered: string[] = [];
  const prerendered: Array<{ tag: string; attributes: unknown[] }> = [];
  const modules: LustreModules = {
    version: "5.7.1",
    start: () => ok(null),
    register(_app, name) {
      registered.push(name);
      return ok(undefined);
    },
    send: () => undefined,
    shutdown: () => null,
    is_browser: () => browser,
    to_string: (element) => String(element),
    prerender(_app, tag, attributes) {
      prerendered.push({ tag, attributes: attributes as unknown[] });
      const attrs = (attributes as string[]).join("");
      return `<${tag}${attrs}><template shadowrootmode="closed" shadowrootdelegatesfocus>` +
        `<p>${attrs.trim()}</p></template></${tag}>`;
    },
    attribute: (name, value) => ` ${name}="${value}"`,
    toList: (items) => items,
  };
  return { kit: lustreKit(modules), registered, prerendered };
}

const component: LustreApp<undefined> = {
  init: () => [0, null],
  update: (m) => [m, null],
  view: () => "",
  config: {},
};

Deno.test("lustreElement: the server renders the tag with its shadow root as Declarative Shadow DOM", async () => {
  const { kit, prerendered } = fake();
  const Counter = lustreElement<{ start: string }>(kit, "x-counter", component);
  const html = await renderToString(
    h(Counter, { start: "3", class: "big", hidden: false, children: h("span", null, "slot") }),
  );
  assertEquals(
    html,
    '<x-counter start="3" class="big">' +
      '<template shadowrootmode="closed" shadowrootdelegatesfocus="">' +
      '<p>start="3" class="big"</p></template><span>slot</span></x-counter>',
  );
  assertEquals(prerendered, [{ tag: "x-counter", attributes: [' start="3"', ' class="big"'] }]);
});

Deno.test("lustreElement: in the browser it renders the bare host and registers the tag once", async () => {
  // A browser: the parser already turned the template into the shadow root.
  const { kit, registered, prerendered } = fake(true);
  const Counter = lustreElement(kit, "x-counter", component);
  let setStart: (s: string) => void = () => {};
  function Page() {
    const [start, set] = useState("1");
    setStart = set;
    return h("div", null, h(Counter, { start }), h(Counter, { start: "9" }));
  }
  const screen = await render(h(Page, null));
  assertEquals(
    screen.html(),
    '<div><x-counter start="1"></x-counter><x-counter start="9"></x-counter></div>',
  );
  assertEquals(prerendered, [], "no prerender in the browser");
  assertEquals(registered, ["x-counter"], "registered once, however many instances");
  await screen.act(() => setStart("2"));
  assertEquals(
    screen.html(),
    '<div><x-counter start="2"></x-counter><x-counter start="9"></x-counter></div>',
  );
  await screen.unmount();
});

Deno.test("lustreElement: an invalid custom element name is refused; an unexpected prerender renders the bare host", async () => {
  const { kit } = fake();
  assertThrows(() => lustreElement(kit, "counter", component), TypeError, "custom element name");
  assertThrows(() => lustreElement(kit, "Bad-Tag", component), TypeError);
  const odd = lustreKit({
    ...({} as LustreModules),
    to_string: () => "<x-odd>no template</x-odd>",
    is_browser: () => false,
    prerender: () => null,
    attribute: () => null,
    toList: (items) => items,
    version: "0",
  } as LustreModules);
  const Odd = lustreElement(odd, "x-odd", component);
  assertEquals(await renderToString(h(Odd, { a: "1" })), '<x-odd a="1"></x-odd>');
});

Deno.test("LustreElementAttributes types a declared tag's attributes", () => {
  const ok: JSX.IntrinsicElements["x-counter"] = { start: "3", class: "c" };
  // @ts-expect-error a number is not the element's (numeric text) attribute
  const bad: JSX.IntrinsicElements["x-counter"] = { start: 3 };
  assert(ok && bad);
});
