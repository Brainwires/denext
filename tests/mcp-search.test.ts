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

Deno.test("searchDocs: 'session' surfaces the server session API", async () => {
  const hits = await searchDocs("read a session cookie", { limit: 8 });
  assert(hits.length > 0);
  assert(
    hits.some((h) => /session/i.test(h.title) || h.module === "denext/server"),
    "expected a session/server hit",
  );
});

Deno.test("searchDocs: 'server action' surfaces defineAction / actions", async () => {
  const hits = await searchDocs("typed server action form", { limit: 8 });
  assert(hits.some((h) => /action/i.test(h.title) || /action/i.test(h.snippet)));
});

Deno.test("searchDocs: a guide question lands on the guide section", async () => {
  const notif = await searchDocs("desktop notifications scheduled", { limit: 5 });
  // Guide sections lead; the desktop guide's section is among the top two (the runtime page's
  // own notifications entry is an equally fair first answer).
  assertEquals(notif[0].kind, "guide");
  const guide = notif.slice(0, 2).find((h) => h.ref === "desktop#desktop-notifications");
  assertEquals(guide?.url, "/docs/desktop#desktop-notifications");

  const fly = await searchDocs("deploy to fly", { limit: 5 });
  assertEquals(fly[0].ref, "deployment-targets#flyio");
});

Deno.test("searchDocs: an exact symbol name ranks the symbol first", async () => {
  const hits = await searchDocs("getSession", { limit: 5 });
  assertEquals(hits[0].ref, "api:denext-server/getSession");
  assertEquals(hits[0].url, "/docs/api/denext-server/getSession");
});

Deno.test("searchDocs: kind filters to guide sections or API symbols", async () => {
  const guide = await searchDocs("revalidateTag", { kind: "guide", limit: 6 });
  assert(guide.length > 0 && guide.every((h) => h.kind === "guide"));
  const api = await searchDocs("revalidateTag", { kind: "api", limit: 6 });
  assert(api.length > 0 && api.every((h) => h.kind !== "guide"));
  assertEquals(api[0].title, "revalidateTag");
});

Deno.test("searchDocs: at most three sections of one page per result list", async () => {
  const hits = await searchDocs("desktop window tray menu dock badge", {
    kind: "guide",
    limit: 10,
  });
  const perPage = new Map<string, number>();
  for (const h of hits) perPage.set(h.module, (perPage.get(h.module) ?? 0) + 1);
  assert([...perPage.values()].every((n) => n <= 3), JSON.stringify([...perPage]));
});

// ── the MCP tool ──

Deno.test("denext_search_docs: returns ranked hits with doc links and read refs", async () => {
  const res = await runTool("denext_search_docs", { query: "read a cookie or session" });
  assert(!res.isError);
  assertStringIncludes(res.content[0].text, "/docs/");
  assertStringIncludes(res.content[0].text, "read: ");
});

Deno.test("denext_search_docs: kind=api returns only symbols; a bad kind is an error", async () => {
  const res = await runTool("denext_search_docs", { query: "useApi", kind: "api", limit: 3 });
  assert(!res.isError);
  assertStringIncludes(res.content[0].text, "api:denext/useApi");
  const bad = await runTool("denext_search_docs", { query: "x", kind: "pages" });
  assert(bad.isError);
});

Deno.test("denext_search_docs: empty query is an error result", async () => {
  const res = await runTool("denext_search_docs", {});
  assert(res.isError);
  assertStringIncludes(res.content[0].text, "query");
});
