// SPA mode `denext dev` runs the plugin seams the App Router dev server does: it sets the
// config's plugins up and runs their prepare steps (codegen the app imports) at startup, and
// re-runs a step when a file under its `watch` globs changes. Before, only `buildSpa` /
// `exportSpa` set plugins up, so a SPA app's generated inputs (content-collections' types and
// store) never existed under `denext dev`.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { startSpaDevServer } from "../src/build/spa/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import type { DenextPlugin } from "../src/plugin/mod.ts";
import { resetPlugins } from "../src/plugin/mod.ts";

/** Poll `cond` every 50 ms for at most `ms`. */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

Deno.test({
  name: "SPA dev: plugins are set up, prepare steps run at startup and re-run on their watch globs",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_dev_plugins_" }));
  const ac = new AbortController();
  resetPlugins();
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "content"));
    await Deno.writeTextFile(join(dir, "src", "main.tsx"), "export {};\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      'export default { mode: "spa", spa: { entry: "./src/main.tsx" } };\n',
    );
    const runs: string[] = [];
    const modes: string[] = [];
    const plugin: DenextPlugin = {
      name: "test-spa-dev-prepare",
      setup(ctx) {
        modes.push(ctx.mode);
        ctx.addPrepareStep(async ({ outDir }) => {
          runs.push("run");
          await Deno.mkdir(outDir, { recursive: true });
          await Deno.writeTextFile(
            join(outDir, "generated.ts"),
            `export const n = ${runs.length};`,
          );
        }, { watch: ["content/**"] });
      },
    };
    const paths = await resolveProject(dir);
    paths.config = { ...paths.config, plugins: [plugin] };
    const server = startSpaDevServer({ paths, port: 0, signal: ac.signal, onListen() {} });
    assert(await waitFor(() => runs.length >= 1, 10_000), "the prepare step ran at startup");
    assertEquals(modes, ["dev"]);
    assertEquals(
      await Deno.readTextFile(join(paths.outDir, "generated.ts")),
      "export const n = 1;",
    );
    // An edit under the step's watch glob regenerates its output.
    await new Promise((r) => setTimeout(r, 200)); // let the watcher start
    await Deno.writeTextFile(join(dir, "content", "post.md"), "# hi\n");
    assert(await waitFor(() => runs.length >= 2, 10_000), "the step re-ran on a watched edit");
    ac.abort();
    await server.finished;
  } finally {
    ac.abort();
    resetPlugins();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
