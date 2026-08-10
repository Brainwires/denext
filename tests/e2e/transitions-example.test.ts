// e2e: the useTransition example (denext-native, no npm) builds and server-renders.
// The transition-lane behavior itself is unit-tested in tests/transition.test.ts;
// this locks in that the example page builds + SSRs. CI-excluded (runs esbuild).
//
// Run manually:  deno test -A --unstable-kv tests/e2e/transitions-example.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

const exampleDir = fromFileUrl(
  new URL("../../examples/transitions/", import.meta.url),
)
  .replace(/\/$/, "");

Deno.test("transitions example: builds + SSRs on denext's single React", async () => {
  const [page] = await buildNextCompatPages({
    projectDir: exampleDir,
    configPath: `${exampleDir}/deno.json`,
    outDir: `${exampleDir}/.denext`,
    pages: [{ routePath: "/", filePath: `${exampleDir}/app/page.tsx` }],
  });

  const html = await renderNextCompatPage(page, {}, "/_client/index.js");
  assertStringIncludes(html, "useTransition");
  assertStringIncludes(html, "<input");
  assert(
    (html.match(/<li>/g) ?? []).length > 0,
    "the filtered list SSRs some items",
  );

  const client = await Deno.readTextFile(page.clientBundle);
  assert(
    !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(
      client,
    ),
    "client bundle must be single-React",
  );
});
