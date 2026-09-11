// @denext/content-collections/markdown — the first-party Markdown renderer behind
// `renderContent` for `.md` entries (and the docs site): block/inline coverage + the escaping
// and link-hardening that make raw content safe to emit as HTML.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderMarkdown } from "../packages/content-collections/markdown.ts";

Deno.test("renderMarkdown covers headings (with ids), lists, fences, quotes, callouts, rules", () => {
  const html = renderMarkdown(
    [
      "# Title here",
      "",
      "Para with *em*, **strong**, `code` and a [link](/docs).",
      "",
      "- one",
      "- two",
      "  wrapped",
      "",
      "1. first",
      "2. second",
      "",
      "```ts",
      "const x = 1 < 2;",
      "```",
      "",
      "> quoted",
      "",
      "> [!NOTE]",
      "> heads up",
      "",
      "---",
    ].join("\n"),
  );
  assertStringIncludes(html, `<h1 id="title-here">Title here</h1>`);
  assertStringIncludes(html, "<em>em</em>");
  assertStringIncludes(html, "<strong>strong</strong>");
  assertStringIncludes(html, "<code>code</code>");
  assertStringIncludes(html, `<a href="/docs">link</a>`);
  assertStringIncludes(html, "<ul><li>one</li><li>two wrapped</li></ul>");
  assertStringIncludes(html, "<ol><li>first</li><li>second</li></ol>");
  assertStringIncludes(
    html,
    `<pre class="code" data-lang="ts"><code>const x = 1 &lt; 2;</code></pre>`,
  );
  assertStringIncludes(html, "<blockquote>quoted</blockquote>");
  assertStringIncludes(html, `<aside class="callout note">heads up</aside>`);
  assertStringIncludes(html, "<hr />");
});

Deno.test("renderMarkdown escapes raw HTML and never emits a script-bearing link", () => {
  const html = renderMarkdown(
    "Raw <script>alert(1)</script> & [x](javascript:alert(1)) [y](JAVA\tSCRIPT:x) " +
      '[z](https://ok.example/?a=1&b="q") [d](data:text/html,hi)',
  );
  assert(!html.includes("<script>"), "raw HTML is escaped, not passed through");
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt; &amp;");
  assert(!/href="[^"]*javascript/i.test(html), "javascript: links are dropped");
  assert(!/href="[^"]*data:/i.test(html), "data: links are dropped");
  assert(!html.includes("JAVA\tSCRIPT"), "control characters can't smuggle a scheme");
  // The safe link survives with its href attribute-escaped (quotes + ampersands).
  assertStringIncludes(
    html,
    `<a href="https://ok.example/?a=1&amp;b=&quot;q&quot;" rel="noopener noreferrer" target="_blank">z</a>`,
  );
  // Dropped links keep their text.
  assertStringIncludes(html, "x");
});

Deno.test("renderMarkdown is deterministic and handles CRLF + empty input", () => {
  assertEquals(renderMarkdown(""), "");
  assertEquals(renderMarkdown("a\r\n\r\nb"), "<p>a</p>\n<p>b</p>");
  assertEquals(renderMarkdown("# H"), renderMarkdown("# H"));
});
