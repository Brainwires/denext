// The docs site's Markdown helpers: frontmatter-less root guides (leading H1 → page heading,
// leading raw-HTML banner dropped) and the relative-link rewriting that turns a repo document's
// GitHub-shaped links into docs routes / GitHub URLs.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderDoc,
  renderMarkdown,
  rewriteDocLinks,
  rewriteMdLinks,
} from "../site/lib/markdown.ts";
import { GITHUB_BLOB, GITHUB_TREE } from "../site/lib/docs-map.ts";
import { tocFromVNodes } from "../site/lib/toc.ts";
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
    '<a href="./packages/htmx">htmx</a> <a href="./.githooks">hooks</a>',
    "CONTRIBUTING.md",
  );
  assertStringIncludes(html, `href="${GITHUB_TREE}/packages/htmx"`);
  assertStringIncludes(html, `href="${GITHUB_TREE}/.githooks"`);
});

Deno.test("rewriteDocLinks: an example's directory or README becomes its docs page", () => {
  const html = rewriteDocLinks(
    '<a href="./examples/notes">notes</a> <a href="./examples/spa/README.md#run-it">spa</a> ' +
      '<a href="./examples/_shared">shared</a>',
    "CONTRIBUTING.md",
  );
  assertStringIncludes(html, 'href="/docs/examples/notes"');
  assertStringIncludes(html, 'href="/docs/examples/spa#run-it"');
  // `_shared` is a helper directory, not an example: it stays a GitHub link.
  assertStringIncludes(html, `href="${GITHUB_TREE}/examples/_shared"`);
});

Deno.test("rewriteDocLinks: inside an example, files go to GitHub and siblings to their page", () => {
  const html = rewriteDocLinks(
    '<a href="./lib/db.ts">db</a> <a href="../notes">notes</a> <a href="../../">repo</a> ' +
      '<a href="../../KNOWN-LIMITATIONS.md#x">limits</a> <a href="fastlane/README.md">lanes</a>',
    "examples/native/README.md",
  );
  assertStringIncludes(html, `href="${GITHUB_BLOB}/examples/native/lib/db.ts"`);
  assertStringIncludes(html, 'href="/docs/examples/notes"');
  assertStringIncludes(html, 'href="https://github.com/Brainwires/denext"');
  assertStringIncludes(html, 'href="/docs/limitations#x"');
  assertStringIncludes(html, `href="${GITHUB_BLOB}/examples/native/fastlane/README.md"`);
});

Deno.test("rewriteMdLinks: Markdown links resolve like rendered ones; fenced code is left alone", () => {
  const md = [
    'See [db](./lib/db.ts "the db") and [notes](../notes).',
    "```md",
    "[kept](./lib/db.ts)",
    "```",
    "[abs](https://x.dev) [in-page](#run)",
  ].join("\n");
  assertEquals(
    rewriteMdLinks(md, "examples/drizzle/README.md"),
    [
      `See [db](${GITHUB_BLOB}/examples/drizzle/lib/db.ts "the db") and [notes](/docs/examples/notes).`,
      "```md",
      "[kept](./lib/db.ts)",
      "```",
      "[abs](https://x.dev) [in-page](#run)",
    ].join("\n"),
  );
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
    '<a href="../../../../src/x.ts">x</a>',
    "site/app/docs/deploy/content.md",
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
