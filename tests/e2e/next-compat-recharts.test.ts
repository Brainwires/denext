// e2e: prove the REAL npm `recharts` package — a charting library built on React
// **class components** — SSRs a full chart on denext via the next-compat build with
// `classComponents: true`. Also guards the React-compat details recharts needs:
// defaultProps resolution, createRef, and arbitrarily-nested children arrays.
// Excluded from CI (tests/e2e/ is ignored) because it installs npm + runs esbuild.
//
// Run manually:  deno test -A --unstable-kv tests/e2e/next-compat-recharts.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildNextCompatPages, renderNextCompatPage } from "../../src/build/next-compat-build.ts";

const exampleDir = fromFileUrl(new URL("../../examples/next-compat-recharts/", import.meta.url))
  .replace(/\/$/, "");

Deno.test("next-compat: real recharts SSRs a full chart on denext (classComponents)", async () => {
  // Ensure recharts is installed (esbuild resolves it from node_modules).
  const install = await new Deno.Command(Deno.execPath(), {
    args: ["cache", "--allow-scripts", "--node-modules-dir=auto", "npm:recharts@2.15.0"],
    cwd: exampleDir,
  }).output();
  assert(install.success, "recharts install failed");

  const [page] = await buildNextCompatPages({
    projectDir: exampleDir,
    configPath: `${exampleDir}/deno.json`,
    outDir: `${exampleDir}/.denext`,
    pages: [{ routePath: "/", filePath: `${exampleDir}/app/page.tsx` }],
    classComponents: true, // recharts is built on class components
  });

  const html = await renderNextCompatPage(page, {}, "/_client/index.js");
  // A full chart rendered server-side: surface, axes, grid, the line, and ticks.
  assertStringIncludes(html, "recharts-surface");
  assertStringIncludes(html, "recharts-cartesian-axis");
  assertStringIncludes(html, "recharts-cartesian-grid");
  assertStringIncludes(html, "#6d28d9"); // the <Line> stroke color
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    assertStringIncludes(html, day, "x-axis tick labels present");
  }
  // Regression guard: nested-array children + defaultProps must resolve fully.
  assert(!html.includes("<undefined>"), "no unresolved nodes (nested arrays / defaultProps)");

  // The client bundle must be single-React (no npm React) and include recharts.
  const client = await Deno.readTextFile(page.clientBundle);
  assert(
    !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
    "client bundle must not contain npm React",
  );
  assertStringIncludes(client, "recharts-surface", "client bundle includes real recharts");
});
