// Tests for the `denext_search_docs` MCP tool + its BM25 engine.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Bm25, tokenize } from "../src/mcp/rag/bm25.ts";
import { searchDocs } from "../src/mcp/rag/search.ts";
import { runTool } from "../src/mcp/tools.ts";

// ── tokenizer ──

Deno.test("tokenize: splits camelCase and keeps whole + parts", () => {
  const t = tokenize("getSession");
  assert(t.includes("getsession"));
  assert(t.includes("get"));
  assert(t.includes("session"));
});

Deno.test("tokenize: splits snake_case and drops stopwords", () => {
  const t = tokenize("read_the cookies");
  assert(t.includes("read"));
  assert(t.includes("cookies"));
  assert(!t.includes("the"), "stopword 'the' should be dropped");
});

// ── BM25 ranking ──

Deno.test("Bm25: a title match outranks a body-only match", () => {
  const idx = new Bm25();
  idx.add("a", [{ text: "getSession", weight: 3 }, { text: "read the session", weight: 1 }]);
  idx.add("b", [{ text: "cache", weight: 3 }, { text: "mentions session once", weight: 1 }]);
  const hits = idx.search("session", 2);
  assertEquals(hits[0].id, "a");
});

Deno.test("Bm25: 'get session' matches a getSession title (camelCase)", () => {
  const idx = new Bm25();
  idx.add("gs", [{ text: "getSession", weight: 3 }, { text: "", weight: 1 }]);
  idx.add("other", [{ text: "createApp", weight: 3 }, { text: "", weight: 1 }]);
  const hits = idx.search("get session", 2);
  assertEquals(hits[0].id, "gs");
});

// ── searchDocs over the real corpus ──

Deno.test("searchDocs: 'session' surfaces the server session API", () => {
  const hits = searchDocs("read a session cookie", 8);
  assert(hits.length > 0);
  assert(
    hits.some((h) => /session/i.test(h.title) || h.module === "denext/server"),
    "expected a session/server hit",
  );
});

Deno.test("searchDocs: 'server action' surfaces defineAction / actions", () => {
  const hits = searchDocs("typed server action form", 8);
  assert(hits.some((h) => /action/i.test(h.title) || /action/i.test(h.snippet)));
});

// ── the MCP tool ──

Deno.test("denext_search_docs: returns ranked hits with doc links", async () => {
  const res = await runTool("denext_search_docs", { query: "read a cookie or session" });
  assert(!res.isError);
  assertStringIncludes(res.content[0].text, "/docs/api/");
});

Deno.test("denext_search_docs: empty query is an error result", async () => {
  const res = await runTool("denext_search_docs", {});
  assert(res.isError);
  assertStringIncludes(res.content[0].text, "query");
});
