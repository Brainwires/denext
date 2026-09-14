import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseFrontmatter, renderDoc, renderMarkdown } from "../apps/web/lib/markdown.ts";

Deno.test("parseFrontmatter: splits frontmatter from body and strips quotes", () => {
  const { frontmatter, body } = parseFrontmatter(
    `---\ntitle: Styling\nslug: styling\nlead: "A quoted lead."\n---\n\n## Hi\n`,
  );
  assertEquals(frontmatter.title, "Styling");
  assertEquals(frontmatter.slug, "styling");
  assertEquals(frontmatter.lead, "A quoted lead.");
  assertEquals(body.trim(), "## Hi");
});

Deno.test("parseFrontmatter: no frontmatter passes the source through untouched", () => {
  const { frontmatter, body } = parseFrontmatter("# Just a doc\n\ntext");
  assertEquals(frontmatter, {});
  assertEquals(body, "# Just a doc\n\ntext");
});

Deno.test("renderMarkdown: headings get slug ids", () => {
  assertEquals(
    renderMarkdown("## Global CSS"),
    `<h2 id="global-css">Global CSS</h2>`,
  );
});

Deno.test("renderMarkdown: paragraphs join wrapped lines and render inline", () => {
  const html = renderMarkdown(
    "Use `class` and **bold** and *em* text.\non the next line.",
  );
  assertEquals(
    html,
    `<p>Use <code>class</code> and <strong>bold</strong> and <em>em</em> text. on the next line.</p>`,
  );
});

Deno.test("renderMarkdown: fenced code is escaped and carries data-lang", () => {
  const html = renderMarkdown("```tsx\nconst x = <div/>;\n```");
  assertEquals(
    html,
    `<pre class="code" data-lang="tsx"><code>const x = &lt;div/&gt;;</code></pre>`,
  );
});

Deno.test("renderMarkdown: emphasis inside code spans is not reinterpreted", () => {
  const html = renderMarkdown("Call `a*b*c` verbatim.");
  assertStringIncludes(html, "<code>a*b*c</code>");
  assert(!html.includes("<em>"));
});

Deno.test("renderMarkdown: GitHub-style alert becomes a callout", () => {
  assertEquals(
    renderMarkdown("> [!WARNING]\n> Be careful here."),
    `<aside class="callout warn">Be careful here.</aside>`,
  );
  assertEquals(
    renderMarkdown("> [!NOTE]\n> Just a note."),
    `<aside class="callout note">Just a note.</aside>`,
  );
});

Deno.test("renderMarkdown: plain blockquote stays a blockquote", () => {
  assertEquals(
    renderMarkdown("> just a quote"),
    `<blockquote>just a quote</blockquote>`,
  );
});

Deno.test("renderMarkdown: unordered and ordered lists", () => {
  assertEquals(renderMarkdown("- a\n- b"), `<ul><li>a</li><li>b</li></ul>`);
  assertEquals(
    renderMarkdown("1. one\n2. two"),
    `<ol><li>one</li><li>two</li></ol>`,
  );
});

Deno.test("renderMarkdown: links get href, external ones get rel/target", () => {
  assertEquals(
    renderMarkdown("See [the guide](/docs/routing)."),
    `<p>See <a href="/docs/routing">the guide</a>.</p>`,
  );
  assertStringIncludes(
    renderMarkdown("See [MDN](https://developer.mozilla.org)."),
    `<a href="https://developer.mozilla.org" rel="noopener noreferrer" target="_blank">MDN</a>`,
  );
});

Deno.test("renderMarkdown: horizontal rule", () => {
  assertEquals(renderMarkdown("---"), "<hr />");
});

Deno.test("renderMarkdown: raw HTML in text is escaped", () => {
  assertEquals(
    renderMarkdown("A <script>alert(1)</script> tag."),
    `<p>A &lt;script&gt;alert(1)&lt;/script&gt; tag.</p>`,
  );
});

Deno.test("renderDoc: end to end frontmatter + body", () => {
  const { frontmatter, html } = renderDoc(
    `---\ntitle: T\nslug: s\n---\n\n## Head\n\nBody text.`,
  );
  assertEquals(frontmatter.title, "T");
  assertStringIncludes(html, `<h2 id="head">Head</h2>`);
  assertStringIncludes(html, "<p>Body text.</p>");
});

Deno.test("renderMarkdown: reference-style links resolve from `[label]: url` definitions", () => {
  const html = renderMarkdown(
    [
      "## [2.4.1] - 2026-09-11",
      "",
      "See [the docs][docs], [Keep a Changelog][] and [undefined thing].",
      "",
      "[2.4.1]: https://jsr.io/@denext/denext@2.4.1",
      "[docs]: /docs/routing",
      '[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/ "title"',
      "[evil]: javascript:alert(1)",
      "",
      "Nope: [evil].",
    ].join("\n"),
  );
  // The definition lines render nothing; the heading's shortcut link resolves.
  assertEquals((html.match(/\]: /g) ?? []).length, 0, "definitions are consumed");
  assertStringIncludes(
    html,
    '<h2 id="241---2026-09-11"><a href="https://jsr.io/@denext/denext@2.4.1"',
  );
  assertStringIncludes(html, '<a href="/docs/routing">the docs</a>');
  assertStringIncludes(html, '<a href="https://keepachangelog.com/en/1.1.0/"');
  assertStringIncludes(html, ">Keep a Changelog</a>");
  // An undefined label stays literal; a script-URL definition renders its label as text.
  assertStringIncludes(html, "[undefined thing]");
  assertStringIncludes(html, "Nope: evil.");
  assert(!html.includes("javascript:"), "no script URL reaches the output");
});

Deno.test("renderMarkdown: digit runs in text survive code-span extraction", () => {
  // The code-span placeholder used to be ` N `, so any ` 1 ` in prose was swallowed (and the
  // wrong span restored when spans were present): rendering CHANGELOG.md produced 120 `undefined`s.
  assertEquals(
    renderMarkdown("I have 1 apple and `x` 2 pears and `y`"),
    "<p>I have 1 apple and <code>x</code> 2 pears and <code>y</code></p>",
  );
  assertEquals(renderMarkdown("ships 0 KB of JS"), "<p>ships 0 KB of JS</p>");
});

Deno.test("renderMarkdown: a code span cannot be smuggled into a link href", () => {
  // A destination with whitespace is not a link (CommonMark) — and it was the way a placeholder
  // got restored INSIDE the attribute after escaping, re-injecting a raw quote.
  const html = renderMarkdown(
    '`" onmouseover="alert(1)` [a](x 0 y) and [b](x `c` y) and [ok](/ok)',
  );
  assert(!/<a [^>]*onmouseover/.test(html), "no attribute breakout");
  assert(!html.includes('href="x'), "whitespace destinations are not links");
  assertStringIncludes(html, '<a href="/ok">ok</a>');
  assertStringIncludes(html, '<code>" onmouseover="alert(1)</code> a and b and'); // text, not markup
});

Deno.test("renderMarkdown: a `[label]: url` line inside a fence is code, not a definition", () => {
  const html = renderMarkdown("```\n[a]: /ok\ncode line\n```\n\n[a]");
  assertStringIncludes(html, "<code>[a]: /ok\ncode line</code>");
  assertStringIncludes(html, "<p>[a]</p>");
});

Deno.test("renderMarkdown: a pipe table becomes a wrapped table with thead and tbody", () => {
  assertEquals(
    renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"),
    `<div class="table-wrap"><table><thead><tr><th>A</th><th>B</th></tr></thead>` +
      `<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>`,
  );
});

Deno.test("renderMarkdown: the delimiter row sets per-cell alignment classes", () => {
  const html = renderMarkdown("| l | c | r | n |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |");
  assertStringIncludes(html, `<th class="align-left">l</th>`);
  assertStringIncludes(html, `<th class="align-center">c</th>`);
  assertStringIncludes(html, `<th class="align-right">r</th>`);
  assertStringIncludes(html, `<th>n</th>`); // no alignment: no class
  assertStringIncludes(html, `<td class="align-left">1</td>`);
  assertStringIncludes(html, `<td class="align-right">3</td>`);
  assertStringIncludes(html, `<td>4</td>`);
  assert(!html.includes("style="), "alignment is a class, not an inline style (CSP)");
});

Deno.test("renderMarkdown: leading and trailing pipes are optional", () => {
  assertEquals(
    renderMarkdown("A | B\n--- | ---\n1 | 2"),
    renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |"),
  );
});

Deno.test("renderMarkdown: an escaped \\| is a literal pipe in a cell, not a column break", () => {
  const html = renderMarkdown("| a | b |\n| --- | --- |\n| x \\| y | z |");
  assertStringIncludes(html, "<td>x | y</td>");
  assertStringIncludes(html, "<td>z</td>");
  assertEquals((html.match(/<td/g) ?? []).length, 2, "still two columns");
});

Deno.test("renderMarkdown: a code span containing an escaped pipe survives cell splitting", () => {
  // README-NEXT-MIGRATION.md:85 has exactly this cell.
  const html = renderMarkdown(
    '| API | Notes |\n| --- | --- |\n| `redirect(url, "push"\\|"replace")` | ok |',
  );
  assertStringIncludes(
    html,
    `<td><code>redirect(url, "push"|"replace")</code></td>`,
  );
  assertEquals((html.match(/<td/g) ?? []).length, 2);
});

Deno.test("renderMarkdown: inline markup renders inside table cells", () => {
  const html = renderMarkdown(
    "| Name | Link |\n| --- | --- |\n| **bold** `code` | [docs](/docs/routing) |",
  );
  assertStringIncludes(html, "<strong>bold</strong> <code>code</code>");
  assertStringIncludes(html, `<a href="/docs/routing">docs</a>`);
});

Deno.test("renderMarkdown: a short row is padded and a long row truncated to the header width", () => {
  const html = renderMarkdown("| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |");
  assertStringIncludes(html, "<tr><td>1</td><td></td><td></td></tr>");
  assertStringIncludes(html, "<tr><td>1</td><td>2</td><td>3</td></tr>");
  assert(!html.includes("<td>4</td>"), "the extra cell is dropped");
});

Deno.test("renderMarkdown: a table directly after a paragraph line is its own block", () => {
  const html = renderMarkdown("Some prose.\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assertStringIncludes(html, "<p>Some prose.</p>");
  assertStringIncludes(html, `<div class="table-wrap">`);
  assert(!html.includes("<p>Some prose. |"), "the table did not join the paragraph");
});

Deno.test("renderMarkdown: a table directly after a list item ends the list", () => {
  const html = renderMarkdown("- item\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assertStringIncludes(html, "<ul><li>item</li></ul>");
  assertStringIncludes(html, "<thead><tr><th>A</th><th>B</th></tr></thead>");
});

Deno.test("renderMarkdown: a paragraph containing a pipe is not a table", () => {
  assertEquals(
    renderMarkdown("this | that is prose\nand more"),
    "<p>this | that is prose and more</p>",
  );
  // A `---` rule under a pipe line is still a rule: a delimiter row needs a pipe of its own.
  assertStringIncludes(renderMarkdown("a | b\n---"), "<hr />");
});

Deno.test("renderMarkdown: a pipe table inside a fenced block stays code", () => {
  assertEquals(
    renderMarkdown("```\n| A | B |\n| --- | --- |\n```"),
    `<pre class="code"><code>| A | B |\n| --- | --- |</code></pre>`,
  );
});

Deno.test("renderMarkdown: a blank > line splits a quote into paragraphs", () => {
  assertEquals(
    renderMarkdown("> one\n>\n> two"),
    "<blockquote><p>one</p><p>two</p></blockquote>",
  );
});

Deno.test("renderMarkdown: a callout keeps its paragraphs", () => {
  assertEquals(
    renderMarkdown("> [!WARNING]\n> first\n>\n> second"),
    `<aside class="callout warn"><p>first</p><p>second</p></aside>`,
  );
});

Deno.test("renderMarkdown: a single-paragraph quote renders exactly as before", () => {
  assertEquals(renderMarkdown("> just a quote"), "<blockquote>just a quote</blockquote>");
  assertEquals(
    renderMarkdown("> wrapped\n> over two lines"),
    "<blockquote>wrapped over two lines</blockquote>",
  );
  assertEquals(
    renderMarkdown("> [!NOTE]\n> Just a note."),
    `<aside class="callout note">Just a note.</aside>`,
  );
});

Deno.test("renderMarkdown: heading ids match GitHub for punctuation between spaces", () => {
  assertEquals(
    renderMarkdown("## Known Gaps & Residual Risk"),
    `<h2 id="known-gaps--residual-risk">Known Gaps &amp; Residual Risk</h2>`,
  );
});
