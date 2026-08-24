import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseFrontmatter, renderDoc, renderMarkdown } from "../examples/docs/lib/markdown.ts";

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
