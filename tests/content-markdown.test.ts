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

Deno.test("renderMarkdown nests a list indented under an item", () => {
  const html = renderMarkdown(
    ["- one", "  - one.a", "  - one.b", "    1. deep", "- two", "  wrapped"].join("\n"),
  );
  assertEquals(
    html,
    "<ul><li>one<ul><li>one.a</li><li>one.b<ol><li>deep</li></ol></li></ul></li>" +
      "<li>two wrapped</li></ul>",
  );
  // A blank line before a nested item keeps it in the parent item.
  assertEquals(
    renderMarkdown("1. a\n\n   - b\n2. c"),
    "<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>",
  );
});

Deno.test("renderMarkdown renders footnotes with back-links, numbered by first reference", () => {
  const html = renderMarkdown(
    [
      "Second[^b] then first[^a] and again[^b]; undefined[^zz] stays text.",
      "",
      "[^a]: The *a* note.",
      "[^b]: The b note.",
      "[^unused]: Never referenced.",
    ].join("\n"),
  );
  assertStringIncludes(
    html,
    `Second<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>`,
  );
  assertStringIncludes(html, `first<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a>`);
  assertStringIncludes(html, `again<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-2">1</a>`);
  assertStringIncludes(html, "undefined[^zz] stays text.");
  assertStringIncludes(
    html,
    `<section class="footnotes"><ol><li id="fn-1">The b note. ` +
      `<a href="#fnref-1" class="footnote-backref">↩</a> ` +
      `<a href="#fnref-1-2" class="footnote-backref">↩</a></li>` +
      `<li id="fn-2">The <em>a</em> note. <a href="#fnref-2" class="footnote-backref">↩</a></li>` +
      `</ol></section>`,
  );
  assert(!html.includes("Never referenced"), "an unreferenced definition renders nothing");
  assert(!html.includes("[^a]:"), "definitions are not paragraphs");
});

Deno.test("renderMarkdown renders images with an escaped alt and a sanitized src", () => {
  assertEquals(
    renderMarkdown(`![A "cat" <pic>](/img/cat.png "Its 'title'")`),
    `<p><img src="/img/cat.png" alt="A &quot;cat&quot; &lt;pic&gt;" ` +
      `title="Its &#39;title&#39;" /></p>`,
  );
  assertEquals(
    renderMarkdown("[![logo](/l_a_b.png)](/home) ![r][logo]\n\n[logo]: /ref.png"),
    `<p><a href="/home"><img src="/l_a_b.png" alt="logo" /></a> <img src="/ref.png" alt="r" /></p>`,
  );
  // Script-bearing sources are refused exactly as link targets are: the alt text stays.
  const bad = renderMarkdown(
    "![x](javascript:alert(1)) ![y](JAVA\tSCRIPT:x) ![z](data:image/svg+xml,<svg>) " +
      `![q" onerror="alert(1)](/ok.png) ![w](/ok.png "t\\" onload=\\"x")`,
  );
  // Every emitted <img> is exactly src + alt (+ title), each a closed, quoted attribute.
  const imgs = bad.match(/<img[^>]*>/g) ?? [];
  assertEquals(imgs.length, 1, bad);
  for (const tag of imgs) {
    assert(/^<img src="[^"]*" alt="[^"]*"(?: title="[^"]*")? \/>$/.test(tag), tag);
    assert(!/src="[^"]*(javascript|data:)/i.test(tag), tag);
  }
  assertStringIncludes(bad, `alt="q&quot; onerror=&quot;alert(1)"`);
});

Deno.test("renderMarkdown renders indented code blocks", () => {
  assertEquals(
    renderMarkdown("Para.\n\n    const a = 1 < 2;\n\n    b();\n\tc();\n\nAfter."),
    `<p>Para.</p>\n<pre class="code"><code>const a = 1 &lt; 2;\n\nb();\nc();</code></pre>\n` +
      "<p>After.</p>",
  );
  // An indented line can't interrupt a paragraph (CommonMark): it is a continuation.
  assertEquals(renderMarkdown("Para\n    more"), "<p>Para more</p>");
});

Deno.test("renderMarkdown takes code spans of any backtick-run length", () => {
  assertEquals(
    renderMarkdown("Use `` a ` b `` or ``` `` ``` or `` `x` `` then ``a``."),
    "<p>Use <code>a ` b</code> or <code>``</code> or <code>`x`</code> then <code>a</code>.</p>",
  );
  // An unmatched run stays literal; a one-space pad is stripped only when both sides have one.
  assertEquals(renderMarkdown("``open and `` x`"), "<p><code>open and </code> x`</p>");
  assertEquals(renderMarkdown("`` `a``"), "<p><code> `a</code></p>");
  assertEquals(renderMarkdown("``a *b* _c_``"), "<p><code>a *b* _c_</code></p>");
});

Deno.test("renderMarkdown keeps a code span inside an image's alt or title out of the markup", () => {
  const html = renderMarkdown('![a `"><x` b](/i.png "t `"q"`")');
  assertEquals(
    html,
    `<p><img src="/i.png" alt="a &quot;&gt;&lt;x b" title="t &quot;q&quot;" /></p>`,
  );
});
