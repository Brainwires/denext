// A plugin prepare step that throws stops `denext build` / `export` with its error. Up to 4.5.0 it
// was only logged and the build went on, failing later with a misleading "Module ./ticker.mjs not
// found" when the step was the Gleam compiler that should have written that module. In `dev` a
// failing step is still logged and the server keeps running.

import { assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { buildWithoutAppRouter } from "../src/build/build-pipeline/prepare.ts";
import { resetPlugins } from "../src/plugin/mod.ts";

Deno.test("a throwing plugin prepare step fails the build with its error", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_prepare_fail_" }));
  resetPlugins();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default {
  plugins: [{
    name: "codegen",
    setup(c: { addPrepareStep(step: () => void): void }) {
      c.addPrepareStep(() => { throw new Error("the Gleam build failed: HTTP error"); });
    },
  }],
};
`,
    );
    const paths = await resolveProject(dir);
    const err = await assertRejects(() => buildWithoutAppRouter(paths));
    assertStringIncludes(String(err), "the Gleam build failed: HTTP error");
    assertStringIncludes(String(err), "codegen");
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});
