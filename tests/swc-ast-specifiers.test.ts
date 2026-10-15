// The specifier rewriting every module copy shares (src/build/swc-ast.ts): a copy's literal
// `import()` specifiers are absolutized like its static ones, and a server copy's non-literal
// `import(expr)` resolves a relative value against the module it stands in for.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  absolutizeSpecifiers,
  applyEdits,
  type Edit,
  literalSpecifiers,
  parseModule,
  pinImportMeta,
  relativeSpecifier,
  relativizeFileSpecifiers,
} from "../src/build/swc-ast.ts";

const SOURCE = `import { a } from "./a.ts";
export { b } from "@/b.ts";
export const lazy = () => import("./lazy.ts");
export const tpl = () => import(\`./tpl.ts\`);
export const aliased = () => import("@/c.ts");
export const computed = (n: string) => import(\`./\${n}.ts\`);
export const spread = (args: [string]) => import(...args);
export const named = (n: string) => import(n);
`;

Deno.test("literalSpecifiers: static sources and literal import() calls, in source order", async () => {
  const parsed = await parseModule(SOURCE);
  assertEquals(literalSpecifiers(parsed!.body).map((s) => s.value), [
    "./a.ts",
    "@/b.ts",
    "./lazy.ts",
    "./tpl.ts",
    "@/c.ts",
  ]);
});

Deno.test("absolutizeSpecifiers: a literal import() is rewritten like a static import", async () => {
  const parsed = await parseModule(SOURCE);
  const edits: Edit[] = [];
  const bare = (spec: string) => spec === "@/c.ts" ? "file:///proj/c.web.ts" : null;
  assert(
    absolutizeSpecifiers(parsed!.ctx, parsed!.body, "file:///proj/m.ts", edits, (u) => u, bare),
  );
  const code = applyEdits(parsed!.ctx.bytes, edits);
  assertStringIncludes(code, `from "file:///proj/a.ts"`);
  assertStringIncludes(code, `import("file:///proj/lazy.ts")`);
  assertStringIncludes(code, `import("file:///proj/tpl.ts")`);
  assertStringIncludes(code, `import("file:///proj/c.web.ts")`);
  assertStringIncludes(code, `from "@/b.ts"`, "an alias with no replacement is kept");
  assertStringIncludes(code, "import(`./${n}.ts`)", "a computed specifier is not a literal");
});

Deno.test("pinImportMeta: dynamicImports re-roots a non-literal import() on the original", async () => {
  const src = `export const named = (n: string) => import(n);\n` +
    `export const meta = () => import(new URL("./x.ts", import.meta.url).href);\n` +
    `export const lit = () => import("file:///proj/lit.ts");\n`;
  const pinned = await pinImportMeta(src, "file:///proj/dir/m.ts", { dynamicImports: true });
  const helper = `((s) => /^\\.\\.?\\//.test(s) ? new URL(s, "file:///proj/dir/m.ts").href : s)`;
  assertStringIncludes(pinned, `import(${helper}(n))`);
  assertStringIncludes(
    pinned,
    `import(${helper}(new URL("./x.ts", "file:///proj/dir/m.ts").href))`,
    "import.meta inside the argument is pinned too",
  );
  assertStringIncludes(pinned, `import("file:///proj/lit.ts")`, "a literal is left alone");
  // A client copy (no option) keeps the call as written.
  const client = await pinImportMeta(
    `export const f = (n: string) => import(n);\n`,
    "file:///p/m.ts",
  );
  assertEquals(client, `export const f = (n: string) => import(n);\n`);
  // The helper resolves a relative value against the original and passes anything else through.
  const resolve = new Function("return " + helper)() as (s: string) => string;
  assertEquals(resolve("./y.ts"), "file:///proj/dir/y.ts");
  assertEquals(resolve("../z.ts"), "file:///proj/z.ts");
  assertEquals(resolve("npm:left-pad"), "npm:left-pad");
});

Deno.test("relativeSpecifier: the path between two file URLs, keeping their encoding", () => {
  assertEquals(
    relativeSpecifier("file:///p/.denext/c/m.ts", "file:///p/app/x.tsx"),
    "../../app/x.tsx",
  );
  assertEquals(relativeSpecifier("file:///p/app/m.ts", "file:///p/app/x.ts"), "./x.ts");
  assertEquals(
    relativeSpecifier("file:///p/m.ts", "file:///p/app/%5Bid%5D/x.ts?v=1"),
    "./app/%5Bid%5D/x.ts?v=1",
  );
  assertEquals(relativeSpecifier("file:///C:/p/m.ts", "file:///D:/q/x.ts"), null);
  assertEquals(relativeSpecifier("file:///p/m.ts", "jsr:@std/path"), null);
});

Deno.test("relativizeFileSpecifiers: every literal file: specifier becomes relative to the copy", async () => {
  const src = `import { a } from "file:///p/app/a.ts";\n` +
    `export * from "jsr:@std/path";\n` +
    `export const lazy = () => import("file:///p/lib/lazy.ts");\n`;
  const out = await relativizeFileSpecifiers(src, "file:///p/.denext/server-copies/uc_1.ts");
  assertStringIncludes(out, `from "../../app/a.ts"`);
  assertStringIncludes(out, `import("../../lib/lazy.ts")`);
  assertStringIncludes(out, `from "jsr:@std/path"`);
  assertEquals(await relativizeFileSpecifiers("export {};\n", "file:///p/c.ts"), "export {};\n");
});

Deno.test("pinImportMeta: with copyUrl the pins are computed from the copy's own URL", async () => {
  const src =
    `"use server";\nexport const u = import.meta.url;\nexport const d = import.meta.dirname;\n`;
  const pinned = await pinImportMeta(src, "file:///p/app/m.ts", {
    copyUrl: "file:///p/.denext/server-copies/uc_1.ts",
  });
  assert(pinned.startsWith(`"use server";`), "the prologue stays first");
  assertStringIncludes(pinned, `new URL("../../app/m.ts", import.meta.url).href`);
  assertStringIncludes(pinned, "__dnxDirname(__dnxFileUrlToPath(");
  assertStringIncludes(pinned, `from "node:url"`);
  assert(!pinned.includes(`"file:///p/app/m.ts"`), pinned);
});
