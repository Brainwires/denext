// Coverage for `src/cli/commands/analyze.ts`: run the production build of a minimal
// app, then break the client bundle down by chunk. Exercises the JSON path and the
// human-readable chunk table, plus `readClientChunks` against a real `.denext/client`
// output.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { analyzeCommand } from "../src/cli/commands/analyze.ts";
import { capture, makeCtx } from "./_cli-coverage-helpers.ts";

async function minimalApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_analyze_" });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app/layout.tsx"),
    `export default function Root({ children }: { children: unknown }) {\n` +
      `  return <html><head><title>App</title></head><body>{children}</body></html>;\n}\n`,
  );
  await Deno.writeTextFile(
    join(dir, "app/page.tsx"),
    `export default function Page() {\n  return <main>hello</main>;\n}\n`,
  );
  return dir;
}

Deno.test("analyze builds and reports chunk sizes as JSON", async () => {
  const dir = await minimalApp();
  const cap = capture();
  try {
    await analyzeCommand.run(makeCtx({ positionals: [dir], global: { json: true } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  // JSON is the last thing logged; the header lines precede it.
  const jsonLine = cap.logs.find((l) => l.trimStart().startsWith("["));
  assert(jsonLine, "analyze --json prints a JSON array of chunks");
  const chunks = JSON.parse(jsonLine!);
  assert(Array.isArray(chunks), "chunks is an array");
  for (const c of chunks) assert(typeof c.name === "string" && typeof c.bytes === "number");
});

Deno.test("analyze prints a human-readable chunk breakdown", async () => {
  const dir = await minimalApp();
  const cap = capture();
  try {
    await analyzeCommand.run(makeCtx({ positionals: [dir] }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  assertStringIncludes(cap.logs.join("\n"), "denext analyze");
});

Deno.test("analyze --md restores DENEXT_ANALYZE afterwards", async () => {
  const dir = await minimalApp();
  const cap = capture();
  const prior = Deno.env.get("DENEXT_ANALYZE");
  Deno.env.delete("DENEXT_ANALYZE");
  try {
    await analyzeCommand.run(makeCtx({ positionals: [dir], flags: { md: true } }));
    assertEquals(Deno.env.get("DENEXT_ANALYZE"), undefined, "--md leaves no DENEXT_ANALYZE behind");
  } finally {
    cap.restore();
    if (prior === undefined) Deno.env.delete("DENEXT_ANALYZE");
    else Deno.env.set("DENEXT_ANALYZE", prior);
    await Deno.remove(dir, { recursive: true });
  }
});

// The native `deno bundle` path writes no esbuild metafile: `--md` attributes each chunk to its
// modules from the bundle's source maps (sourcemap-attribution.ts), so the report still names them.
Deno.test("analyze --md breaks native chunks down by module", async () => {
  const dir = await minimalApp();
  const repo = new URL("../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${repo}mod.ts`,
        "denext/": `${repo}`,
        "denext/jsx-runtime": `${repo}src/jsx/jsx-runtime.ts`,
        "denext/client": `${repo}src/client/mod.ts`,
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "app/page.tsx"),
    `"use client";\nimport { useState } from "denext";\n` +
      `export default function Page() {\n  const [n, setN] = useState(0);\n` +
      `  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>;\n}\n`,
  );
  const cap = capture();
  try {
    await analyzeCommand.run(makeCtx({ positionals: [dir], flags: { md: true } }));
  } finally {
    cap.restore();
    await Deno.remove(dir, { recursive: true });
  }
  const report = cap.logs.join("\n");
  assertStringIncludes(report, "## Top modules per chunk");
  assertStringIncludes(report, "denext/src/client/");
});
