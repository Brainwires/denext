// The plugin `addPrepareStep` seam: a codegen step that runs at build AND dev startup, and re-runs
// during dev when a file under its `watch` globs changes. Exercised through the public plugin API.
import { assert, assertEquals } from "@std/assert";
import {
  applyPlugins,
  getPluginPrepareWatchDirs,
  type PluginBuildContext,
  resetPlugins,
  runMatchingPrepareSteps,
  runPluginPrepareSteps,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { DenextPlugin } from "../src/plugin/mod.ts";

const ROOT = "/proj";
const ctx: PluginBuildContext = {
  projectRoot: ROOT,
  appDir: "/proj/app",
  outDir: "/proj/.denext",
  config: {},
};

/** Set up a config whose single plugin registers one prepare step; returns a run counter. */
async function setup(
  watch: string[] | undefined,
  onRun: () => void,
): Promise<void> {
  const plugin: DenextPlugin = {
    name: "test-prepare",
    setup(c) {
      c.addPrepareStep(() => onRun(), watch ? { watch } : undefined);
    },
  };
  const config = { plugins: [plugin] } as unknown as DenextConfig;
  await applyPlugins({
    projectRoot: ROOT,
    appDir: "/proj/app",
    config,
    mode: "build",
    load: () => Promise.resolve({}),
  });
}

Deno.test("addPrepareStep: runPluginPrepareSteps runs every registered step", async () => {
  resetPlugins();
  let runs = 0;
  await setup(["content/**/*.md"], () => runs++);
  await runPluginPrepareSteps(ctx);
  assertEquals(runs, 1);
  await runPluginPrepareSteps(ctx);
  assertEquals(runs, 2);
  resetPlugins();
});

Deno.test("addPrepareStep: watch dirs are the globs' literal prefix directories", async () => {
  resetPlugins();
  await setup(["content/**/*.md", "content.config.ts"], () => {});
  const dirs = getPluginPrepareWatchDirs(ROOT).sort();
  assertEquals(dirs, ["/proj/content", "/proj/content.config.ts"]);
  resetPlugins();
});

Deno.test("addPrepareStep: runMatchingPrepareSteps runs only when a changed path matches a watch glob", async () => {
  resetPlugins();
  let runs = 0;
  await setup(["content/**/*.md"], () => runs++);
  // A non-matching change does nothing.
  assertEquals(await runMatchingPrepareSteps(ctx, ["/proj/app/page.tsx"]), false);
  assertEquals(runs, 0);
  // A matching change re-runs the step.
  assertEquals(await runMatchingPrepareSteps(ctx, ["/proj/content/blog/hello.md"]), true);
  assertEquals(runs, 1);
  resetPlugins();
});

Deno.test("addPrepareStep: a step with no watch globs never re-runs on change (only at startup)", async () => {
  resetPlugins();
  let runs = 0;
  await setup(undefined, () => runs++);
  assertEquals(getPluginPrepareWatchDirs(ROOT), []);
  assertEquals(await runMatchingPrepareSteps(ctx, ["/proj/content/x.md"]), false);
  assertEquals(runs, 0);
  // …but the startup/build run still fires it.
  await runPluginPrepareSteps(ctx);
  assertEquals(runs, 1);
  resetPlugins();
});

Deno.test("addPrepareStep: a throwing step is caught, not fatal", async () => {
  resetPlugins();
  const plugin: DenextPlugin = {
    name: "boom",
    setup(c) {
      c.addPrepareStep(() => {
        throw new Error("kaboom");
      });
    },
  };
  const config = { plugins: [plugin] } as unknown as DenextConfig;
  await applyPlugins({
    projectRoot: ROOT,
    appDir: "/proj/app",
    config,
    mode: "build",
    load: () => Promise.resolve({}),
  });
  // Must resolve (error swallowed + logged), not reject.
  await runPluginPrepareSteps(ctx);
  assert(true);
  resetPlugins();
});
