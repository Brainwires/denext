// The docs site's Markdown helpers: frontmatter-less root guides (leading H1 → page heading,
// leading raw-HTML banner dropped) and the relative-link rewriting that turns a repo document's
// GitHub-shaped links into docs routes / GitHub URLs.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderDoc, renderMarkdown, rewriteDocLinks } from "../apps/web/lib/markdown.ts";
import { GITHUB_BLOB, GITHUB_TREE } from "../apps/web/lib/docs-map.ts";
import { tocFromVNodes } from "../apps/web/lib/toc.ts";
import type { VNodeChildren } from "denext";

Deno.test("renderDoc: a body with no frontmatter title takes its first H1 as the title", () => {
  const { frontmatter, html } = renderDoc("# Contributing to denext\n\nHello.\n");
  assertEquals(frontmatter.title, "Contributing to denext");
  assert(!html.includes("<h1"), `the H1 should be gone from the body: ${html}`);
  assertStringIncludes(html, "Hello.");
});

Deno.test("renderDoc: a frontmatter title wins and the H1 stays in the body", () => {
  const { frontmatter, html } = renderDoc("---\ntitle: Shell\n---\n\n# Body H1\n\nHi.\n");
  assertEquals(frontmatter.title, "Shell");
  assertStringIncludes(html, "<h1");
  assertStringIncludes(html, "Body H1");
});

Deno.test("renderDoc: a leading raw-HTML block is dropped", () => {
  const src = '<p align="center">\n  <img src="logo.svg" />\n</p>\n\n# Title\n\nBody.\n';
  const { frontmatter, html } = renderDoc(src);
  assertEquals(frontmatter.title, "Title");
  assert(!html.includes("&lt;p align="), `the banner should be gone: ${html}`);
  assertStringIncludes(html, "Body.");
});

Deno.test("rewriteDocLinks: a mapped guide link becomes its docs URL", () => {
  const html = rewriteDocLinks('<a href="./FEATURES.md">Features</a>', "CONTRIBUTING.md");
  assertStringIncludes(html, 'href="/docs/features"');
});

Deno.test("rewriteDocLinks: an anchor survives the rewrite", () => {
  const html = rewriteDocLinks('<a href="./PLUGINS.md#seams">Seams</a>', "CONTRIBUTING.md");
  assertStringIncludes(html, 'href="/docs/plugins#seams"');
});

Deno.test("rewriteDocLinks: an unmapped source path becomes a GitHub blob URL", () => {
  const html = rewriteDocLinks(
    '<a href="./src/lint/denext-plugin.ts">plugin</a>',
    "CONTRIBUTING.md",
  );
  assertStringIncludes(html, `href="${GITHUB_BLOB}/src/lint/denext-plugin.ts"`);
});

Deno.test("rewriteDocLinks: a directory link becomes a GitHub tree URL", () => {
  const html = rewriteDocLinks(
    '<a href="./examples/notes">notes</a> <a href="./.githooks">hooks</a>',
    "CONTRIBUTING.md",
  );
  assertStringIncludes(html, `href="${GITHUB_TREE}/examples/notes"`);
  assertStringIncludes(html, `href="${GITHUB_TREE}/.githooks"`);
});

Deno.test("rewriteDocLinks: absolute, mailto, site-absolute and in-page hrefs are untouched", () => {
  const src = [
    '<a href="https://denext.dev/docs">site</a>',
    '<a href="mailto:security@denext.dev">mail</a>',
    '<a href="//cdn.example.com/x.js">proto</a>',
    '<a href="/docs/plugins">route</a>',
    '<a href="#the-fallow-gate">anchor</a>',
    '<a href="">empty</a>',
  ].join("\n");
  assertEquals(rewriteDocLinks(src, "CONTRIBUTING.md"), src);
});

Deno.test("rewriteDocLinks: a nested source path resolves links against its own directory", () => {
  const html = rewriteDocLinks(
    '<a href="../../../../../src/x.ts">x</a>',
    "apps/web/app/docs/deploy/content.md",
  );
  assertStringIncludes(html, `href="${GITHUB_BLOB}/src/x.ts"`);
});

Deno.test("rewriteDocLinks: a relative path inside a code span is not rewritten", () => {
  const html = rewriteDocLinks(
    renderMarkdown("See `./x.md` and [a](./FEATURES.md).\n"),
    "CONTRIBUTING.md",
  );
  assertStringIncludes(html, "./x.md");
  assertStringIncludes(html, 'href="/docs/features"');
  assert(!html.includes('href="./'), html);
});

Deno.test("toc: heading ids match the renderer's GitHub-parity slugs", () => {
  const text = "Known Gaps & Residual Risk";
  const toc = tocFromVNodes(
    { type: "h2", props: { children: text } } as unknown as VNodeChildren,
  );
  assertEquals(toc.length, 1);
  assertEquals(toc[0].id, "known-gaps--residual-risk");
  assertStringIncludes(renderMarkdown(`## ${text}\n`), 'id="known-gaps--residual-risk"');
});
