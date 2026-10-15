// `denext/ui-kit` (src/ui/kit.ts): the form components `denext ui` builds its panels from, exported
// for plugin authors. They compose as components (no string round-trips), render escaped
// server-side HTML, and the renderer's old string API (`control`, `field`, `opButton`,
// `renderWidget`, `renderWidgets`) is gone.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import * as kit from "../src/ui/kit.ts";
import * as controlModule from "../src/ui/form/control.ts";
import * as renderModule from "../src/ui/form/render.ts";

const { Control, decode, encode, Field, FormField, FormFields, OpButton, renderView, Widget } = kit;

Deno.test("denext/ui-kit is a public entry point of the package", async () => {
  const denoJson = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  assertEquals(denoJson.exports["./ui-kit"], "./src/ui/kit.ts");
  for (const name of ["Control", "Field", "OpButton", "FormField", "FormFields", "Widget"]) {
    assertEquals(typeof (kit as Record<string, unknown>)[name], "function", name);
  }
});

Deno.test("the string API is retired: the form modules export components only", () => {
  for (const gone of ["control", "field", "opButton"]) {
    assert(!(gone in controlModule), `form/control.ts still exports ${gone}`);
  }
  for (const gone of ["renderWidget", "renderWidgets"]) {
    assert(!(gone in renderModule), `form/render.ts still exports ${gone}`);
  }
});

Deno.test("a schema field renders through FormField, with the form's one CSRF field", () => {
  const spec = kit.widgetFor(
    { type: "string", description: "Where the app lives." },
    ["basePath"],
    false,
  );
  const html = renderView(h(FormField, { spec, value: "/app", ctx: { csrf: "tok" } })).__html;
  assertStringIncludes(html, '<input name="_csrf" type="hidden" value="tok">');
  assertStringIncludes(html, 'name="basePath"');
  assertStringIncludes(html, 'value="/app"');
  assertStringIncludes(html, "Where the app lives.");
  // The value posts back to what it stands for.
  assertEquals(decode(spec, encode(spec, "/app")), "/app");
});

Deno.test("FormFields emits one CSRF field for several widgets; Widget emits none", () => {
  const a = kit.widgetFor({ type: "string" }, ["a"], false);
  const b = kit.widgetFor({ type: "boolean" }, ["b"], false);
  const ctx = { csrf: "tok" };
  const many = renderView(
    h(FormFields, { fields: [{ spec: a, value: "x" }, { spec: b, value: true }], ctx }),
  ).__html;
  assertEquals(many.split('name="_csrf"').length - 1, 1);
  assertStringIncludes(many, 'name="a"');
  assertStringIncludes(many, 'name="b"');
  const one = renderView(h(Widget, { spec: a, value: "x", ctx })).__html;
  assert(!one.includes("_csrf"));
});

Deno.test("the primitives compose as components and escape what they render", () => {
  const html = renderView(
    h(
      Field,
      { id: "n", label: "Name <b>", help: "Shown in the header.", error: "`n` is required" },
      h(Control, { tag: "input", name: "n", id: "n", value: '<"x">' }),
      h(OpButton, { op: "remove", at: 0, list: "l", label: "✕", title: "Remove" }),
    ),
  ).__html;
  assertStringIncludes(html, '<label for="n">Name &lt;b&gt;</label>');
  assertStringIncludes(html, 'value="&lt;&quot;x&quot;&gt;"');
  assertStringIncludes(html, 'value="remove:0:l"');
  assertStringIncludes(html, "<code>n</code> is required");
  assert(!html.includes("denext-ui-raw"), "no Raw wrapper: nothing went through a string");
});
