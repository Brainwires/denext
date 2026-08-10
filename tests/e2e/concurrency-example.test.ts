// e2e: the concurrency example (denext-native, no npm) builds and server-renders.
// The fiber concurrency behavior itself (time-slicing, interruption) is unit-tested
// in tests/fiber-slicing.test.ts and tests/fiber-interrupt.test.ts; this locks in
// that the example page builds + SSRs on denext's single React. CI-excluded (esbuild).
//
// Run manually:  deno test -A --unstable-kv tests/e2e/concurrency-example.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

const exampleDir = fromFileUrl(
  new URL("../../examples/concurrency/", import.meta.url),
)
  .replace(/\/$/, "");

Deno.test("concurrency example: builds + SSRs on denext's single React", async () => {
  const [page] = await buildNextCompatPages({
    projectDir: exampleDir,
    configPath: `${exampleDir}/deno.json`,
    outDir: `${exampleDir}/.denext`,
    pages: [{ routePath: "/", filePath: `${exampleDir}/app/page.tsx` }],
  });

  const html = await renderNextCompatPage(page, {}, "/_client/index.js");
  assertStringIncludes(html, "concurrent rendering");
  assertStringIncludes(html, 'type="range"');
  // The initial grid (6,000 cells) server-renders.
  assert(
    (html.match(/hsl\(/g) ?? []).length > 1000,
    "the heavy grid SSRs its cells",
  );

  const client = await Deno.readTextFile(page.clientBundle);
  assert(
    !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(
      client,
    ),
    "client bundle must be single-React",
  );
  // The concurrency APIs the demo relies on are present in the client bundle.
  assertStringIncludes(client, "requestAnimationFrame");
});
