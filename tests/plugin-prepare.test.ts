// The plugin `addPrepareStep` seam: a codegen step that runs at build AND dev startup, and re-runs
// during dev when a file under its `watch` globs changes. Exercised through the public plugin API.
import { assert, assertEquals } from "@std/assert";
import {
  applyPlugins,
  getPluginPrepareWatchDirs,
  type PluginPrepareContext,
  resetPlugins,
  runMatchingPrepareSteps,
  runPluginPrepareSteps,
} from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { DenextPlugin, PluginContext } from "../src/plugin/mod.ts";
import { join } from "@std/path";

const ROOT = "/proj";
const ctx: PluginPrepareContext = {
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
  // Local paths: the platform separator (`\proj\content` on Windows).
  assertEquals(dirs, [join(ROOT, "content"), join(ROOT, "content.config.ts")]);
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

Deno.test("addPrepareStep: a re-run is told the changed paths its globs matched; a startup run none", async () => {
  resetPlugins();
  const seen: (readonly string[] | undefined)[] = [];
  await applyPlugins({
    projectRoot: ROOT,
    appDir: "/proj/app",
    config: {
      plugins: [{
        name: "test-changed",
        setup(c) {
          c.addPrepareStep((p) => void seen.push(p.changed), { watch: ["content/**/*.md"] });
        },
      }],
    } as DenextConfig,
    mode: "dev",
    load: () => Promise.resolve({}),
  });
  await runPluginPrepareSteps(ctx);
  await runMatchingPrepareSteps(ctx, [
    "/proj/app/page.tsx",
    "/proj/content/a.md",
    "/proj/content/b/c.md",
  ]);
  assertEquals(seen, [undefined, ["/proj/content/a.md", "/proj/content/b/c.md"]]);
  resetPlugins();
});

Deno.test("applyPlugins: reportDevError reaches a plugin only where the pipeline provides it", async () => {
  resetPlugins();
  const contexts: PluginContext[] = [];
  const reported: string[] = [];
  const plugin: DenextPlugin = { name: "test-report", setup: (c) => void contexts.push(c) };
  const base = {
    projectRoot: ROOT,
    appDir: "/proj/app",
    config: { plugins: [plugin] } as DenextConfig,
    load: () => Promise.resolve({}),
  };
  await applyPlugins({ ...base, mode: "build" });
  assertEquals(contexts[0].reportDevError, undefined);
  resetPlugins();
  await applyPlugins({
    ...base,
    mode: "dev",
    reportDevError: (title) => void reported.push(title),
  });
  contexts[1].reportDevError?.("boom", new Error("x"));
  assertEquals(reported, ["boom"]);
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
