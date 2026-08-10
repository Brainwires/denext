// e2e: a next-compat **browser** bundle stubs Node built-ins (fs/path/…) that appear
// in npm libraries' Node-only code paths, so browser-capable libs like
// @techstark/opencv-js and scribe.js-ocr (which `require("fs")`) bundle without
// esbuild's "Could not resolve" error. The SSR (deno) bundle keeps the real
// built-ins. Excluded from CI (tests/e2e/ is ignored) — it runs esbuild.
//
// Run manually:  deno test -A --unstable-kv tests/e2e/next-compat-node-stub.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

const PAGE = `import { createElement as h } from "react";
import path from "node:path";        // Node-only import reaching a browser bundle.
import { readFileSync } from "fs";   // named import from a built-in.
// Reference them so esbuild keeps the imports (guarded so SSR never calls them).
const marker = typeof readFileSync + ":" + typeof path;
export default function Page() {
  return h("p", null, "ok");
}
export const __marker = marker;
`;

Deno.test("next-compat: browser bundle stubs Node built-ins (fs/path)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nodestub_" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    await Deno.writeTextFile(`${dir}/page.tsx`, PAGE);

    // Must not throw — the browser bundle would previously fail on `fs`/`node:path`.
    const [page] = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
    });

    const client = await Deno.readTextFile(page.clientBundle);
    assert(client.length > 0, "client bundle built");
    // The built-ins were stubbed to an empty CommonJS module, not real node fs.
    assert(!/require\(["']fs["']\)/.test(client), "no live require('fs') in the browser bundle");

    // SSR (deno platform) keeps the real built-ins and still renders.
    const html = await renderNextCompatPage(page, {}, "/c.js");
    assertStringIncludes(html, "<p>ok</p>");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
