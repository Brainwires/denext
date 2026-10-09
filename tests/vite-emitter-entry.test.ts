// `viteEmitterPlugin` has a light entry, `denext/plugin-kit/vite-emitter`, for denext.config.ts.
// The config is imported by more than the build: a Deno Desktop app's `desktop.ts` imports it at
// runtime (for `resolveDesktopCapabilities`), and the macOS package script loads it too. Through
// `denext/plugin-kit` it dragged the whole build toolchain into those graphs: esbuild, sass and
// @mdx-js/mdx as npm imports (T3 Code's desktop packaging then failed under
// `nodeModulesDir: "manual"`: "Could not find a matching package for 'npm:esbuild@^0.24.0'").
// The entry keeps the config's graph free of npm and of the bundler.

import { assert, assertEquals } from "@std/assert";

const root = new URL("../", import.meta.url);

Deno.test("plugin-kit/vite-emitter: exported, and the same function plugin-kit re-exports", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  assertEquals(cfg.exports["./plugin-kit/vite-emitter"], "./src/plugin/vite-emitter.ts");
  const light = await import(new URL(cfg.exports["./plugin-kit/vite-emitter"], root).href);
  const kit = await import(new URL("src/plugin/kit.ts", root).href);
  assertEquals(light.viteEmitterPlugin, kit.viteEmitterPlugin);
});

Deno.test("plugin-kit/vite-emitter: its module graph has no npm package and no bundler", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const entry = new URL(cfg.exports["./plugin-kit/vite-emitter"] ?? "./src/plugin/kit.ts", root);
  const { stdout, success } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", entry.href],
    cwd: root,
    stdout: "piped",
    stderr: "null",
  }).output();
  assert(success, "deno info failed");
  const graph = JSON.parse(new TextDecoder().decode(stdout)) as {
    modules: { specifier: string }[];
  };
  const npm = graph.modules.map((m) => m.specifier).filter((s) => s.startsWith("npm:"));
  assertEquals(npm, [], `npm packages in the graph: ${npm.join(", ")}`);
  const build = graph.modules.map((m) => m.specifier).filter((s) =>
    /\/src\/build\/next-compat/.test(s)
  );
  assertEquals(build, []);
});
