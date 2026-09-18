// The inline formatting of documentation prose, and the escaping that makes it safe.
//
// The panel shows the config schema's JSDoc and a project's own verb help. Both are prose with
// markdown markers in them, and one of them comes from the user's `denext.config.ts` — so the
// property that matters most here is that formatting prose can never introduce markup.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { inlineMarkdown } from "../src/ui/markdown.ts";
import { renderView } from "../src/ui/view.ts";
import { toHtml } from "../src/ui/html.ts";

/** The prose as it reaches the page. */
function render(text: string): string {
  return toHtml(renderView(h("p", null, inlineMarkdown(text))));
}

Deno.test("the two markers the schema actually uses are formatted", () => {
  assertEquals(render("set `false` to opt out"), "<p>set <code>false</code> to opt out</p>");
  assertEquals(render("**on by default**"), "<p><strong>on by default</strong></p>");
  assertStringIncludes(
    render("Incremental streaming, **on by default**; set `false` to opt out."),
    "<strong>on by default</strong>; set <code>false</code>",
  );
});

Deno.test("prose with no markers is the string it went in as", () => {
  assertEquals(render("Serve the app under a sub-path."), "<p>Serve the app under a sub-path.</p>");
});

Deno.test("angle brackets inside a code span are text, not markup", () => {
  // 16 of the schema's descriptions mention a tag this way — `<title>`, `<Image>`, `<Live>`.
  assertEquals(
    render("`<title>` for the shell"),
    "<p><code>&lt;title&gt;</code> for the shell</p>",
  );
});

Deno.test("prose can never introduce markup, wherever it came from", () => {
  // A project's own denext.config.ts supplies verb help, so this text is not always the
  // framework's own. Children are rendered, never concatenated, so the escape is the renderer's.
  const hostile = "<script>alert(1)</script> and <img src=x onerror=alert(1)>";
  const out = render(hostile);
  assert(!out.includes("<script>"), "no script element");
  assert(!out.includes("<img"), "no image element");
  assertStringIncludes(out, "&lt;script&gt;");

  // The same held inside a code span, which is where a tag usually appears.
  assert(!render("`<script>alert(1)</script>`").includes("<script>"), "escaped inside code too");
});

Deno.test("an unpaired marker stays literal instead of eating the paragraph", () => {
  // Conservative on purpose: a stray backtick or asterisk in prose is far likelier than an
  // intentional multi-line span, and swallowing the rest of a description would be worse.
  assertEquals(render("a ` lone backtick"), "<p>a ` lone backtick</p>");
  assertEquals(render("50% * 2 things"), "<p>50% * 2 things</p>");
  assertEquals(render("**unclosed bold"), "<p>**unclosed bold</p>");
  assertEquals(render("`spans\nno newline`"), "<p>`spans\nno newline`</p>");
});
