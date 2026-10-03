// Unbundled dev, compat mode: one npm package that fails to bundle for the browser must fail
// only the modules that import it. The dependency bundle used to build as one unit, so a single
// unresolvable import answered 500 for every `/_denext/@npm/*` module of the page.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import * as esbuild from "esbuild";
import { createUnbundledState, depSlug } from "../src/build/dev-unbundled/state.ts";
import { npmBuildIsolated, npmErrorModule } from "../src/build/dev-unbundled/deps.ts";

const FILES: Record<string, string> = {
  "deno.json": "{}",
  "node_modules/broken-dep/package.json": JSON.stringify({ name: "broken-dep", main: "index.js" }),
  "node_modules/broken-dep/index.js": 'export * from "does-not-exist-anywhere";',
  "node_modules/good-dep/package.json": JSON.stringify({ name: "good-dep", main: "index.js" }),
  "node_modules/good-dep/index.js": 'export const value = "good-dep-value";',
  "node_modules/other-dep/package.json": JSON.stringify({ name: "other-dep", main: "index.js" }),
  "node_modules/other-dep/index.js": 'export const other = "other-dep-value";',
};

Deno.test("compat dev: one package that fails to bundle fails only its own module", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-npm-isolation-" }));
  try {
    for (const [rel, text] of Object.entries(FILES)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    const st = createUnbundledState({
      projectDir: dir,
      appDir: join(dir, "src"),
      configPath: join(dir, "deno.json"),
      outDir: join(dir, "out"),
      compat: true,
    });
    await Deno.mkdir(st.npmDir, { recursive: true });
    const failures = await npmBuildIsolated(st, ["good-dep", "broken-dep", "other-dep"]);
    assertEquals([...failures.keys()], ["broken-dep"]);
    assertStringIncludes(failures.get("broken-dep")!, "does-not-exist-anywhere");
    const read = (spec: string) => Deno.readTextFileSync(join(st.npmDir, `${depSlug(spec)}.js`));
    assertStringIncludes(read("good-dep"), "good-dep-value");
    assertStringIncludes(read("other-dep"), "other-dep-value");
    const broken = read("broken-dep");
    assertEquals(broken, npmErrorModule("broken-dep", failures.get("broken-dep")!));
    assertStringIncludes(broken, 'the npm package \\"broken-dep\\" failed to bundle');
    assertStringIncludes(broken, "throw new Error(message)");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
