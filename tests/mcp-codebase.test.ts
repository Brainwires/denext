// Tests for the per-project codebase index + its MCP tools.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureCodeIndex } from "../src/mcp/rag/codebase.ts";
import { findDefinition, findReferences, queryCodebase } from "../src/mcp/rag/code-search.ts";
import { runTool } from "../src/mcp/tools.ts";

/** Build a throwaway project with a .gitignore and a few source files. */
async function makeProject(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-cb-" });
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${dir}/.gitignore`, "generated/\n*.gen.ts\n!keep.gen.ts\n");
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/lib/session.ts`,
    `export function getSession(id: string) {\n  // read the session cookie\n  return { id };\n}\n`,
  );
  await Deno.writeTextFile(
    `${dir}/lib/app.ts`,
    `import { getSession } from "./session.ts";\n\nexport function handler() {\n  return getSession("x");\n}\n`,
  );
  // Ignored / vendored — must not be indexed:
  await Deno.mkdir(`${dir}/generated`, { recursive: true });
  await Deno.writeTextFile(`${dir}/generated/out.ts`, `export const SECRET = 1;\n`);
  await Deno.writeTextFile(`${dir}/foo.gen.ts`, `export const GEN = 2;\n`);
  await Deno.writeTextFile(`${dir}/keep.gen.ts`, `export const KEPT = 3;\n`); // negated → included
  await Deno.mkdir(`${dir}/node_modules/pkg`, { recursive: true });
  await Deno.writeTextFile(`${dir}/node_modules/pkg/index.ts`, `export const VENDOR = 4;\n`);
  return dir;
}

Deno.test("codebase: indexes source files and writes the cache", async () => {
  const dir = await makeProject();
  try {
    const idx = await ensureCodeIndex(dir);
    assert(idx.chunks.length > 0);
    const cached = await Deno.stat(`${dir}/.denext/rag/codebase.json`);
    assert(cached.isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codebase: honors .gitignore + the SKIP_DIRS floor (incl. negation)", async () => {
  const dir = await makeProject();
  try {
    const files = Object.keys((await ensureCodeIndex(dir)).files);
    assert(files.includes("lib/session.ts"));
    assert(files.includes("keep.gen.ts"), "negated pattern re-includes keep.gen.ts");
    assert(!files.includes("generated/out.ts"), "gitignored dir excluded");
    assert(!files.includes("foo.gen.ts"), "gitignored glob excluded");
    assert(!files.some((f) => f.startsWith("node_modules/")), "SKIP_DIRS floor excludes vendored");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codebase: queryCodebase ranks the relevant file first", async () => {
  const dir = await makeProject();
  try {
    const hits = await queryCodebase(dir, "read a session cookie", 5);
    assert(hits.length > 0);
    assertEquals(hits[0].file, "lib/session.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codebase: findDefinition + findReferences locate a symbol", async () => {
  const dir = await makeProject();
  try {
    const defs = await findDefinition(dir, "getSession");
    assert(defs.some((d) => d.file === "lib/session.ts"), "definition in session.ts");

    const refs = await findReferences(dir, "getSession");
    assert(refs.total >= 2);
    assert(refs.sites.some((s) => s.file === "lib/app.ts"), "call site in app.ts");

    // An identifier that doesn't exist → no definition.
    assertEquals((await findDefinition(dir, "nope")).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codebase: incremental refresh reflects edits", async () => {
  const dir = await makeProject();
  try {
    await ensureCodeIndex(dir);
    await new Promise((r) => setTimeout(r, 15)); // ensure a distinct mtime
    await Deno.writeTextFile(
      `${dir}/lib/session.ts`,
      `export function renamed() {\n  return 1;\n}\n`,
    );
    const defs = await findDefinition(dir, "renamed");
    assert(defs.some((d) => d.file === "lib/session.ts"), "edit is reflected after refresh");
    assertEquals((await findDefinition(dir, "getSession")).length, 0, "old symbol is gone");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("codebase tools: runTool wrappers behave", async () => {
  const dir = await makeProject();
  try {
    const idx = await runTool("denext_index_codebase", { dir });
    assert(!idx.isError);
    assertStringIncludes(idx.content[0].text, "Indexed");

    const q = await runTool("denext_query_codebase", { dir, query: "session cookie" });
    assert(!q.isError);
    assertStringIncludes(q.content[0].text, "lib/session.ts");

    const def = await runTool("denext_find_definition", { dir, symbol: "getSession" });
    assert(!def.isError);
    assertStringIncludes(def.content[0].text, "session.ts");

    // Missing required args → isError.
    assert((await runTool("denext_query_codebase", {})).isError);
    assert((await runTool("denext_find_definition", {})).isError);
    assert((await runTool("denext_find_references", {})).isError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
