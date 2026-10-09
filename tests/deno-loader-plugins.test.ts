// The esbuild deno-loader on Windows (src/build/deno-loader-plugins.ts). The loader's WASM sees a
// POSIX filesystem and asks Deno for `/C:/app/package.json`, which Windows refuses; the app's
// package.json dependencies were then never seen, so a bare `ms` failed to resolve on Windows
// while macOS and Linux bundled it. The bundle cases run on every OS; CI runs this file on
// windows-latest (ci.yml → `windows-resolve`).

import { assert, assertEquals, assertNotStrictEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import {
  denoLoaderPlugins,
  windowsWasmPath,
  withWindowsWasmPaths,
} from "../src/build/deno-loader-plugins.ts";

Deno.test("windowsWasmPath: a /C:/ drive path loses its leading slash; nothing else changes", () => {
  assertEquals(windowsWasmPath("/C:/app/package.json"), "C:/app/package.json");
  assertEquals(windowsWasmPath("/d:\\app\\deno.json"), "d:\\app\\deno.json");
  assertEquals(windowsWasmPath("C:/app/deno.json"), "C:/app/deno.json");
  assertEquals(windowsWasmPath("/app/deno.json"), "/app/deno.json");
  assertEquals(windowsWasmPath("/C:"), "/C:");
  const url = new URL("file:///C:/app/deno.json");
  assertStrictEquals(windowsWasmPath(url), url);
});

Deno.test("withWindowsWasmPaths: the WASM's file calls are rewritten inside a callback, restored after", async () => {
  const original = Deno.readTextFileSync;
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "x.txt");
    await Deno.writeTextFile(file, "hello");
    let inside: typeof Deno.readTextFileSync | undefined;
    let read: string | undefined;
    const plugin = withWindowsWasmPaths({
      name: "probe",
      setup(build) {
        build.onStart(() => {
          inside = Deno.readTextFileSync;
          read = Deno.readTextFileSync(file); // a native path passes through untouched
        });
      },
    });
    const starts: Array<() => unknown> = [];
    await plugin.setup({
      onStart: (cb: () => unknown) => starts.push(cb),
    } as unknown as esbuild.PluginBuild);
    assertEquals(starts.length, 1);
    assertStrictEquals(Deno.readTextFileSync, original); // not patched outside a callback
    await starts[0]();
    assertNotStrictEquals(inside, original);
    assertEquals(read, "hello");
    assertStrictEquals(Deno.readTextFileSync, original); // restored after it
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** An app with a package.json dependency `ms` in node_modules and `nodeModulesDir: "manual"`. */
async function msApp(): Promise<string> {
  const app = await Deno.makeTempDir({ prefix: "denext-loader-ms-" });
  await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify({ nodeModulesDir: "manual" }));
  await Deno.writeTextFile(
    join(app, "package.json"),
    JSON.stringify({ name: "app", dependencies: { ms: "^2.1.3" } }),
  );
  const pkg = join(app, "node_modules", "ms");
  await Deno.mkdir(pkg, { recursive: true });
  await Deno.writeTextFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "ms", version: "2.1.3", main: "index.js" }),
  );
  await Deno.writeTextFile(join(pkg, "index.js"), "module.exports = () => 'MS_RESOLVED';\n");
  await Deno.writeTextFile(join(app, "main.ts"), "import ms from 'ms';\nconsole.log(ms());\n");
  return app;
}

for (const loader of ["portable", "native"] as const) {
  Deno.test(`denoLoaderPlugins (${loader}): a bare package.json dependency resolves with nodeModulesDir "manual"`, async () => {
    const app = await msApp();
    try {
      const result = await esbuild.build({
        entryPoints: [join(app, "main.ts")],
        absWorkingDir: app,
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        logLevel: "silent",
        plugins: denoLoaderPlugins({ configPath: join(app, "deno.json"), loader }),
      });
      assert(result.outputFiles[0].text.includes("MS_RESOLVED"), "ms was bundled");
    } finally {
      await esbuild.stop();
      await Deno.remove(app, { recursive: true });
    }
  });
}
