// e2e: two real npm animation libraries — `motion` (motion.dev) and
// `@react-spring/web` — co-existing in one denext page, both building + SSRing on
// denext's single React. Exercises useInsertionEffect (motion) and Context.Consumer
// (react-spring's makeContext). CI-excluded (installs npm + runs esbuild).
//
// Run manually:  deno test -A --unstable-kv tests/e2e/next-compat-animation.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  buildNextCompatPages,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

const exampleDir = fromFileUrl(
  new URL("../../examples/animation/", import.meta.url),
)
  .replace(/\/$/, "");

Deno.test("next-compat: motion + react-spring co-exist and SSR on denext", async () => {
  const install = await new Deno.Command(Deno.execPath(), {
    args: [
      "cache",
      "--allow-scripts",
      "--node-modules-dir=auto",
      "npm:motion@12.23.12",
      "npm:@react-spring/web@9.7.5",
    ],
    cwd: exampleDir,
  }).output();
  assert(install.success, "npm install failed");

  const [page] = await buildNextCompatPages({
    projectDir: exampleDir,
    configPath: `${exampleDir}/deno.json`,
    outDir: `${exampleDir}/.denext`,
    pages: [{ routePath: "/", filePath: `${exampleDir}/app/page.tsx` }],
  });

  const html = await renderNextCompatPage(page, {}, "/_client/index.js");
  // Both libraries rendered their card server-side (initial state).
  assertStringIncludes(html, "Animated by motion");
  assertStringIncludes(html, "Press me — react-spring");

  const client = await Deno.readTextFile(page.clientBundle);
  assert(
    !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(
      client,
    ),
    "client bundle must be single-React",
  );
});
