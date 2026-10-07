// The fail-closed check every client bundle runs: a shipped module whose directive prologue says
// `"use server"` fails the bundle (src/build/server-module-guard.ts). Legitimate client code is
// not flagged: an action stub, an inline `"use server"` inside a function body, a string that
// mentions the directive.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import * as esbuild from "esbuild";
import { serverStubPlugin } from "../src/build/next-compat.ts";
import {
  findShippedServerModules,
  formatServerModuleLeaks,
} from "../src/build/server-module-guard.ts";
import { generateServerStub } from "../src/build/client-imports.ts";

Deno.test("findShippedServerModules: only a module-level directive counts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_guard_" });
  const files: Record<string, string> = {
    "action.ts": `"use server";\nexport async function act() { return 1; }\n`,
    "banner.ts": `/* license\n * banner */\n// more\n'use server'\nexport const x = 1;\n`,
    "strict.ts": `"use strict";\n"use server";\nexport const y = 1;\n`,
    "stub.ts": generateServerStub("m", ["act"]),
    "inline.tsx": `export default function Page() {\n  async function save() {\n` +
      `    "use server";\n    return 1;\n  }\n  return <form action={save} />;\n}\n`,
    "mention.ts": `export const DIRECTIVE = "use server";\n`,
    "expr.ts": `"use server".length;\nexport const z = 1;\n`,
    "late.ts": `import x from "y";\n"use server";\nexport const w = x;\n`,
    "client.tsx": `"use client";\nexport const C = () => <b />;\n`,
    "data.json": `"use server"`,
  };
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, name), text);
    }
    const found = await findShippedServerModules(Object.keys(files).map((n) => join(dir, n)));
    assertEquals(found, ["action.ts", "banner.ts", "strict.ts"].map((n) => join(dir, n)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatServerModuleLeaks: the module, its import chain, the entries and the fix", () => {
  const message = formatServerModuleLeaks(
    [{
      module: "/p/app/actions.ts",
      entries: [`the "use client" islands bundle`],
      chain: ["/p/components/Island.tsx", "/p/app/actions.ts"],
    }],
    "/p",
  );
  assertStringIncludes(message, `a "use server" module would ship to the browser`);
  assertStringIncludes(message, `  app/actions.ts\n    imported through components/Island.tsx`);
  assertStringIncludes(message, `shipped by the "use client" islands bundle`);
  assertStringIncludes(message, "Fix:");
});

// The esbuild (next-compat) client bundles: a known action is stubbed; an app `"use server"`
// module the boundary does not hold fails the bundle, named with the chain that reached it.
Deno.test("serverStubPlugin: stubs a known action, refuses an unknown one", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_guard_esb_" }));
  try {
    await Deno.writeTextFile(
      join(dir, "known.ts"),
      `"use server";\nexport const k = () => "K_SECRET";\n`,
    );
    await Deno.writeTextFile(
      join(dir, "other.ts"),
      `"use server";\nexport const o = () => "O_SECRET";\n`,
    );
    await Deno.writeTextFile(
      join(dir, "island.ts"),
      `import { k } from "./known.ts";\nimport { o } from "./other.ts";\nexport { k, o };\n`,
    );
    await Deno.writeTextFile(join(dir, "entry.ts"), `export * from "./island.ts";\n`);
    const build = (servers: Array<[string, { url: string; exports: string[] }]>) =>
      esbuild.build({
        entryPoints: [join(dir, "entry.ts")],
        bundle: true,
        write: false,
        format: "esm",
        absWorkingDir: dir,
        external: ["denext/*"],
        logLevel: "silent",
        plugins: [serverStubPlugin(servers, generateServerStub)],
      });
    const url = (n: string) => toFileUrl(join(dir, n)).href;
    const ok = await build([
      ["k1", { url: url("known.ts"), exports: ["k"] }],
      ["o1", { url: url("other.ts"), exports: ["o"] }],
    ]);
    const text = new TextDecoder().decode(ok.outputFiles[0].contents);
    assertEquals(text.includes("_SECRET"), false);
    const err = await assertRejects(() =>
      build([["k1", { url: url("known.ts"), exports: ["k"] }]])
    );
    const message = err instanceof Error ? err.message : String(err);
    assertStringIncludes(message, `a "use server" module would ship to the browser`);
    assertStringIncludes(message, "other.ts\n    imported through island.ts");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
