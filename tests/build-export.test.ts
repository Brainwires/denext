// Static export (SSG) integration: run `staticExport` on a real App Router example
// and on the SPA example, asserting the emitted `out/` tree. Exercises the main
// pre-render path of src/build/export.ts (route scan, client bundles, per-page
// render, public copy, dynamic-route static params) plus the SPA dispatch into
// src/build/spa.ts's `exportSpa`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";

const REPO = new URL("../", import.meta.url).pathname;
const HELLO = join(REPO, "examples", "hello");
const SPA = join(REPO, "examples", "spa");

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

Deno.test({
  name: "staticExport: App Router example pre-renders every route to out/",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const outName = `out-test-${crypto.randomUUID().slice(0, 8)}`;
  const outDir = join(HELLO, outName);
  try {
    const result = await staticExport(HELLO, { outDir: outName });

    await t.step("result reports the pages it wrote and its outDir", () => {
      assertEquals(result.outDir, outDir);
      // /, /about, /blog/hello-world, /blog/static-generation → 4 static pages.
      assert(result.pages >= 4, `expected >=4 pages, got ${result.pages}`);
    });

    await t.step("home + nested + dynamic-param pages are emitted as clean URLs", async () => {
      assert(await exists(join(outDir, "index.html")), "index.html");
      assert(await exists(join(outDir, "about", "index.html")), "about/index.html");
      // generateStaticParams enumerated both slugs.
      assert(
        await exists(join(outDir, "blog", "hello-world", "index.html")),
        "blog/hello-world/index.html",
      );
      assert(
        await exists(join(outDir, "blog", "static-generation", "index.html")),
        "blog/static-generation/index.html",
      );
    });

    await t.step("rendered HTML is a full document with the page content", async () => {
      const home = await Deno.readTextFile(join(outDir, "index.html"));
      assertStringIncludes(home, "<!DOCTYPE html>");
      assertStringIncludes(home, "Hello from denext");
      // The home route hydrates (it uses hooks) → a client entry script is linked.
      assertStringIncludes(home, "/_denext/client/");
      const post = await Deno.readTextFile(join(outDir, "blog", "hello-world", "index.html"));
      // The async server component rendered the slug-derived title.
      assertStringIncludes(post, "Hello World");
    });

    await t.step("public/ assets are copied to the site root", async () => {
      assert(await exists(join(outDir, "styles.css")), "public styles.css copied to root");
    });

    await t.step("client bundles land under _denext/client", async () => {
      const clientDir = join(outDir, "_denext", "client");
      assert(await exists(clientDir), "_denext/client exists");
      let hasJs = false;
      for await (const e of Deno.readDir(clientDir)) {
        if (e.name.endsWith(".js")) hasJs = true;
      }
      assert(hasJs, "at least one client .js bundle emitted");
    });
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "staticExport: SPA-mode example emits a single shell + client bundle",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const outName = `out-test-${crypto.randomUUID().slice(0, 8)}`;
  const outDir = join(SPA, outName);
  try {
    const result = await staticExport(SPA, { outDir: outName });
    // exportSpa reports exactly one "page" (the shell) and skips nothing.
    assertEquals(result.pages, 1);
    assertEquals(result.skipped.length, 0);

    const shell = await readIfPresent(join(outDir, "index.html"));
    assert(shell !== null, "out/index.html shell written");
    assertStringIncludes(shell!, '<div id="root"></div>');
    assertStringIncludes(shell!, "/_denext/client/index.js");
    // No SSR content — a client-only shell.
    assert(!shell!.includes("Hello from a denext SPA"), "shell must not contain rendered app");

    assert(
      await exists(join(outDir, "_denext", "client", "index.js")),
      "the SPA entry bundle is emitted",
    );
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
  }
});

/** Every `.js` file under `dir`, recursively. */
async function jsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...await jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

Deno.test({
  name: "staticExport: instrumentation-client is bundled into the exported client entries",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_instr_" });
  const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": abs("mod.ts"),
          "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/server": abs("src/server/mod.ts"),
          "denext/client": abs("src/client/mod.ts"),
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "instrumentation-client.ts"),
      `console.log("INSTR_CLIENT_MARKER_7f3a");\n`,
    );
    // An interactive page, so the export emits a client bundle for the route.
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `"use client";
import { useState } from "denext";
export default function Page() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>;
}
`,
    );
    const result = await staticExport(dir, { outDir: "out" });
    const bundles = await jsFiles(result.outDir);
    assert(bundles.length > 0, "the export emitted client JavaScript");
    let found = false;
    for (const f of bundles) {
      if ((await Deno.readTextFile(f)).includes("INSTR_CLIENT_MARKER_7f3a")) found = true;
    }
    assert(found, "instrumentation-client runs in the exported app (bundled into the entry)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
