// The offline docs corpus behind `denext_search_docs` / `denext_read_docs`: the generator's
// chunking (Markdown + JSX pages), the reader, the `denext://docs` resources, and the staleness
// guard that keeps the committed src/mcp/docs-corpus.json in step with its sources.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  changelogSlice,
  chunkMarkdown,
  contentMdPage,
  fingerprint,
  pageChunks,
  rewriteRootLinks,
  VNodeMarkdown,
} from "../scripts/lib/docs-corpus.ts";
import { CORPUS_OUT, corpusInputs } from "../scripts/gen-docs-corpus.ts";
import { READ_PAGE_MAX, readDocs } from "../src/mcp/rag/read.ts";
import { runTool, TOOL_GROUPS } from "../src/mcp/tools.ts";
import { dispatch } from "../src/mcp/server.ts";

// ── staleness guard ──

Deno.test("docs corpus: the committed corpus matches its sources (run `deno task docs:corpus`)", async () => {
  // Every docs page, root guide, AGENTS.md, README.md, the API reference and the generator
  // itself are fingerprinted; editing any of them without regenerating fails here.
  const committed = JSON.parse(await Deno.readTextFile(CORPUS_OUT)) as { sourceHash: string };
  assertEquals(
    committed.sourceHash,
    await fingerprint(await corpusInputs()),
    "src/mcp/docs-corpus.json is stale — run `deno task docs:corpus` (or `deno task docs:build`) and commit it",
  );
});

Deno.test("docs corpus: fingerprint is order-independent and CRLF-insensitive", async () => {
  const a = await fingerprint([{ path: "a.md", text: "x\n" }, { path: "b.md", text: "y\n" }]);
  const b = await fingerprint([{ path: "b.md", text: "y\r\n" }, { path: "a.md", text: "x\n" }]);
  assertEquals(a, b);
  assert(a !== await fingerprint([{ path: "a.md", text: "x!\n" }, { path: "b.md", text: "y\n" }]));
});

// ── Markdown chunking ──

Deno.test("chunkMarkdown: intro + one section per h2/h3, with the site's anchors", () => {
  const md = [
    "Intro text.",
    "",
    "## Deploy to Fly.io",
    "Body one.",
    "### Known Gaps & Risk",
    "Body two.",
    "#### deeper stays in the body",
    "```md",
    "## not a heading (inside a fence)",
    "```",
    "## Explicit {#custom-id}",
    "Body three.",
  ].join("\n");
  const s = chunkMarkdown(md);
  assertEquals(s.map((x) => [x.level, x.title, x.anchor]), [
    [1, "", ""],
    [2, "Deploy to Fly.io", "deploy-to-flyio"],
    [3, "Known Gaps & Risk", "known-gaps--risk"],
    [2, "Explicit", "custom-id"],
  ]);
  assertStringIncludes(s[2].text, "## not a heading (inside a fence)");
  assertStringIncludes(s[2].text, "#### deeper stays in the body");
  assertEquals(s[3].text, "## Explicit\nBody three.");
});

Deno.test("pageChunks: ids are slug#anchor, duplicates de-duplicated in the id only", () => {
  const chunks = pageChunks("changelog", chunkMarkdown("## Added\na\n## Added\nb\n"));
  assertEquals(chunks.map((c) => c.id), ["doc:changelog#added", "doc:changelog#added-2"]);
  assertEquals(chunks.map((c) => c.anchor), ["added", "added"]);
});

Deno.test("contentMdPage: frontmatter title/lead; rewriteRootLinks maps root guides to routes", () => {
  const { page, md } = contentMdPage("x", "---\ntitle: X page\nlead: The lead.\n---\n\nBody\n");
  assertEquals(page, { slug: "x", title: "X page", lead: "The lead." });
  assertEquals(md.trim(), "Body");
  assertEquals(
    rewriteRootLinks("see [limits](./KNOWN-LIMITATIONS.md#ssr) and [x](src/a.md)"),
    "see [limits](/docs/limitations#ssr) and [x](https://github.com/Brainwires/denext/blob/main/src/a.md)",
  );
});

Deno.test("changelogSlice: drops [Unreleased], keeps released versions newest first", () => {
  const src = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- wip\n\n## [2.0.0] - d\n\n- two\n\n" +
    "## [1.0.0] - d\n\n- one\n";
  const out = changelogSlice(src);
  assert(!out.includes("wip"));
  assert(out.indexOf("[2.0.0]") < out.indexOf("[1.0.0]"));
  assertStringIncludes(out, "Intro.");
});

// ── JSX pages → Markdown ──

Deno.test("VNodeMarkdown: renders a JSX page tree (components called, shell/code/callout)", async () => {
  const Shell = (p: { children?: unknown }) => p.children;
  const Code = () => null;
  const Callout = () => null;
  const Rows = async () => {
    await Promise.resolve();
    return ["a", "b"].map((x) => h("li", { key: x }, h("code", null, x)));
  };
  // The docs components return arbitrary children; cast them to the factory's component type.
  const c = (f: unknown) => f as Parameters<typeof h>[0];
  const tree = h(
    c(Shell),
    { title: "Page", lead: "Lead." },
    h(
      "p",
      null,
      "Hello ",
      h("strong", null, "world"),
      " and ",
      h("a", { href: "/x" }, "a link"),
      ".",
    ),
    h("h2", null, "Fly.io setup"),
    h("ul", null, h(c(Rows), null)),
    h("h3", { id: "explicit" }, "Sub ", h("code", null, "x")),
    h(c(Code), { lang: "ts" }, "const a = 1;"),
    h(c(Callout), { kind: "warn" }, h("p", null, "Careful.")),
    h(
      "table",
      null,
      h("thead", null, h("tr", null, h("th", null, "K"), h("th", null, "V"))),
      h("tbody", null, h("tr", null, h("td", null, "a|b"), h("td", null, "1"))),
    ),
  );
  const res = await new VNodeMarkdown({ shell: Shell, code: Code, callout: Callout }).page(tree);
  assertEquals(res.title, "Page");
  assertEquals(res.lead, "Lead.");
  assertStringIncludes(res.md, "Hello **world** and [a link](/x).");
  assertStringIncludes(res.md, "## Fly.io setup {#flyio-setup}");
  assertStringIncludes(res.md, "- `a`\n- `b`");
  assertStringIncludes(res.md, "### Sub `x` {#explicit}");
  assertStringIncludes(res.md, "```ts\nconst a = 1;\n```");
  assertStringIncludes(res.md, "> **Warning:** Careful.");
  assertStringIncludes(res.md, "| K | V |\n| --- | --- |\n| a\\|b | 1 |");
  // ...and the chunker honours the walker's explicit anchors.
  const sections = chunkMarkdown(res.md);
  assertEquals(sections.map((s) => s.anchor), ["", "flyio-setup", "explicit"]);
});

// ── the shipped corpus covers the docs site ──

Deno.test("docs corpus: every docs-site page is in the corpus", async () => {
  const corpus = JSON.parse(await Deno.readTextFile(CORPUS_OUT)) as {
    pages: { slug: string }[];
  };
  const slugs = new Set(corpus.pages.map((p) => p.slug));
  const docs = new URL("../apps/web/app/docs/", import.meta.url);
  for await (const e of Deno.readDir(docs)) {
    if (e.isDirectory && !e.name.includes("[")) assert(slugs.has(e.name), `missing page ${e.name}`);
  }
  for (const s of ["agents", "readme", "features", "limitations", "changelog"]) {
    assert(slugs.has(s));
  }
});

// ── read_docs ──

Deno.test("readDocs: a whole page by slug or URL", async () => {
  for (
    const ref of [
      "desktop-runtime",
      "/docs/desktop-runtime",
      "https://denext.dev/docs/desktop-runtime/",
    ]
  ) {
    const res = await readDocs(ref);
    assert(!res.isError, ref);
    assert(res.text.startsWith("# The Deno Desktop runtime"), ref);
    assertStringIncludes(res.text, "Source: https://denext.dev/docs/desktop-runtime");
  }
});

Deno.test("readDocs: one section by anchor (an h2 includes its h3s)", async () => {
  const res = await readDocs("desktop#desktop-notifications");
  assert(!res.isError);
  assertStringIncludes(res.text, "Source: https://denext.dev/docs/desktop#desktop-notifications");
  assertStringIncludes(res.text, "scheduleNotification");
  assert(!res.text.includes("## Native capabilities"), "only the requested section");
  const withSubs = await readDocs("desktop#desktop-sign-in");
  assertStringIncludes(withSubs.text, "## Clerk on Deno Desktop");
});

Deno.test("readDocs: an unknown section lists the page's sections", async () => {
  const res = await readDocs("desktop#nope");
  assert(res.isError);
  assertStringIncludes(res.text, "desktop#desktop-notifications");
});

Deno.test("readDocs: API symbols by id, module path, or bare name", async () => {
  const a = await readDocs("api:denext/useApi");
  assert(!a.isError);
  assert(a.text.startsWith("# useApi (function, `denext`)"));
  assertStringIncludes(a.text, "```ts\nuseApi<");
  for (
    const ref of ["api:denext/server/getSession", "api:denext-server/getSession", "getSession"]
  ) {
    const res = await readDocs(ref);
    assert(!res.isError, ref);
    assertStringIncludes(res.text, "# getSession (function, `denext/server`)");
  }
  const missing = await readDocs("api:denext/noSuchThing");
  assert(missing.isError);
});

Deno.test("readDocs: an unknown slug suggests the closest pages and lists them all", async () => {
  const res = await readDocs("desktp");
  assert(res.isError);
  assertStringIncludes(res.text, "Did you mean: `desktop`");
  assertStringIncludes(res.text, "- deployment-targets — Deployment targets");
});

Deno.test("readDocs: a long page is cut at a section boundary with the rest listed", async () => {
  const res = await readDocs("mobile", 5_000);
  assertStringIncludes(res.text, "Page truncated at 5000 characters");
  assertStringIncludes(res.text, "- mobile#");
  assert(READ_PAGE_MAX > 5_000);
});

// ── the MCP surface ──

Deno.test("denext_read_docs: tool reads a section; missing ref is an error; in the docs group", async () => {
  const res = await runTool("denext_read_docs", { ref: "deployment-targets#flyio" });
  assert(!res.isError);
  assertStringIncludes(res.content[0].text, "fly");
  const bad = await runTool("denext_read_docs", {});
  assert(bad.isError);
  assertEquals(TOOL_GROUPS.docs, ["denext_search_docs", "denext_read_docs"]);
});

Deno.test("resources: denext://docs lists pages; denext://docs/<slug> reads one", async () => {
  const list = await dispatch({ jsonrpc: "2.0", id: 1, method: "resources/list" });
  assert(list?.result.resources.some((r: { uri: string }) => r.uri === "denext://docs"));
  const index = await dispatch({
    jsonrpc: "2.0",
    id: 2,
    method: "resources/read",
    params: { uri: "denext://docs" },
  });
  assertStringIncludes(index?.result.contents[0].text, "`denext://docs/desktop-runtime`");
  const page = await dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "denext://docs/desktop#desktop-notifications" },
  });
  assertStringIncludes(page?.result.contents[0].text, "scheduleNotification");
  const bad = await dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "denext://docs/nope" },
  });
  assertEquals(bad?.error?.code, -32602);
});
