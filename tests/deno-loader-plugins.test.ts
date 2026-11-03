// The esbuild deno-loader on Windows (src/build/deno-loader-plugins.ts). The loader's WASM sees a
// POSIX filesystem and asks Deno for `/C:/app/package.json`, which Windows refuses; the app's
// package.json dependencies were then never seen, so a bare `ms` failed to resolve on Windows
// while macOS and Linux bundled it. The bundle cases run on every OS; CI runs this file on
// windows-latest (ci.yml → `windows-resolve`).

import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import {
  denoLoaderPlugins,
  packageJsonImports,
  windowsWasmPath,
  withLoaderMap,
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

Deno.test("withLoaderMap: a module the loader answers as js takes the build's loader map (.js → jsx)", async () => {
  // Metro parses JSX in every .js file (an Expo app's `index.js` entry renders <ExpoRoot />), so
  // React Native mode maps .js to jsx; the deno loader answered the app's own .js modules as
  // plain `js` anyway, and the build failed with "The JSX syntax extension is not currently
  // enabled". A stand-in for the loader answers the way it does.
  const files: Record<string, string> = {
    "/app/index.js": 'import { App } from "./App.js";\nApp();\n',
    "/app/App.js": "export const App = () => <p>JSX_IN_JS</p>;\n",
  };
  const loaderLike: esbuild.Plugin = {
    name: "deno-loader",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => ({
        path: args.path.startsWith("./") ? `/app/${args.path.slice(2)}` : args.path,
        namespace: "fake",
      }));
      build.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({
        contents: files[args.path],
        loader: "js",
      }));
    },
  };
  const build = (plugin: esbuild.Plugin) =>
    esbuild.build({
      entryPoints: ["/app/index.js"],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      jsx: "transform",
      jsxFactory: "h",
      loader: { ".js": "jsx" },
      plugins: [plugin],
    });
  try {
    await assertRejects(
      () => build(loaderLike),
      Error,
      "JSX syntax extension is not currently enabled",
    );
    const result = await build(withLoaderMap(loaderLike));
    assert(result.outputFiles[0].text.includes('h("p", null, "JSX_IN_JS")'));
  } finally {
    await esbuild.stop();
  }
});

for (const loader of ["portable", "native"] as const) {
  Deno.test(`denoLoaderPlugins (${loader}): an app inside a Deno workspace that doesn't list it builds`, async () => {
    // A monorepo's root deno.json with a `workspace` that doesn't name the app (examples/effect
    // in this repo): the loader's workspace discovery failed with
    // `WorkspaceDiscoverError(ConfigNotWorkspaceMember …)` where Deno itself only warns, and
    // next-compat's esbuild path fell over. The app's own config is what it builds with.
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-loader-ws-" }));
    try {
      await Deno.mkdir(join(root, "packages", "lib"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({ workspace: ["./packages/lib"] }),
      );
      await Deno.writeTextFile(
        join(root, "packages", "lib", "deno.json"),
        JSON.stringify({ name: "@x/lib", version: "0.0.0", exports: "./mod.ts" }),
      );
      await Deno.writeTextFile(join(root, "packages", "lib", "mod.ts"), "export const v = 1;\n");
      const app = join(root, "apps", "web");
      await Deno.mkdir(app, { recursive: true });
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ imports: { "#greet": "./greet.ts" } }),
      );
      await Deno.writeTextFile(join(app, "greet.ts"), 'export const greet = "NON_MEMBER_OK";\n');
      await Deno.writeTextFile(
        join(app, "main.ts"),
        'import { greet } from "#greet";\nconsole.log(greet);\n',
      );
      const result = await esbuild.build({
        entryPoints: [join(app, "main.ts")],
        absWorkingDir: app,
        bundle: true,
        write: false,
        format: "esm",
        logLevel: "silent",
        plugins: denoLoaderPlugins({ configPath: join(app, "deno.json"), loader }),
      });
      assert(result.outputFiles[0].text.includes("NON_MEMBER_OK"));
      // Whatever stand-in config the loader was handed is gone once the build is.
      await esbuild.stop();
      dispatchEvent(new Event("unload"));
      assertEquals(
        [...Deno.readDirSync(app)].map((e) => e.name).sort(),
        ["deno.json", "greet.ts", "main.ts"],
      );
    } finally {
      await esbuild.stop();
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const loader of ["portable", "native"] as const) {
  Deno.test(`denoLoaderPlugins (${loader}): an app a glob member names imports its siblings by name`, async () => {
    // `"workspace": ["./apps/*", "./packages/*"]`: the loader's discovery can't expand a glob, so
    // the app used to build on its own config alone and `@x/lib` was "not in import map".
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-loader-glob-" }));
    try {
      await Deno.mkdir(join(root, "packages", "lib"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({
          workspace: ["./apps/*", "./packages/*"],
          imports: { "#root": "./root.ts" },
        }),
      );
      await Deno.writeTextFile(join(root, "root.ts"), 'export const r = "ROOT_IMPORT";\n');
      await Deno.writeTextFile(
        join(root, "packages", "lib", "deno.json"),
        JSON.stringify({ name: "@x/lib", version: "0.0.0", exports: "./mod.ts" }),
      );
      await Deno.writeTextFile(
        join(root, "packages", "lib", "mod.ts"),
        'export const v = "GLOB_SIBLING";\n',
      );
      const app = join(root, "apps", "web");
      await Deno.mkdir(app, { recursive: true });
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ imports: { "#greet": "./greet.ts" } }),
      );
      await Deno.writeTextFile(join(app, "greet.ts"), 'export const g = "OWN_IMPORT";\n');
      await Deno.writeTextFile(
        join(app, "main.ts"),
        'import { v } from "@x/lib";\nimport { r } from "#root";\nimport { g } from "#greet";\n' +
          "console.log(v, r, g);\n",
      );
      const result = await esbuild.build({
        entryPoints: [join(app, "main.ts")],
        absWorkingDir: app,
        bundle: true,
        write: false,
        format: "esm",
        logLevel: "silent",
        plugins: denoLoaderPlugins({ configPath: join(app, "deno.json"), loader }),
      });
      const text = result.outputFiles[0].text;
      for (const marker of ["GLOB_SIBLING", "ROOT_IMPORT", "OWN_IMPORT"]) {
        assert(text.includes(marker), marker);
      }
      await esbuild.stop();
      dispatchEvent(new Event("unload"));
      assertEquals(
        [...Deno.readDirSync(app)].map((e) => e.name).sort(),
        ["deno.json", "greet.ts", "main.ts"],
      );
    } finally {
      await esbuild.stop();
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (const loader of ["portable", "native"] as const) {
  Deno.test(`denoLoaderPlugins (${loader}): a glob member's package.json dependency resolves from the root's node_modules`, async () => {
    // A root deno.json `{ "workspace": ["./apps/*"], "nodeModulesDir": "manual" }`, `ms` hoisted
    // into the root's node_modules, apps/web/package.json depending on it: Deno runs the app, but
    // the loader read package.json dependencies only beside a config named deno.json (not the
    // stand-in) and looked for packages only in the app's own node_modules, so a bare `ms` was
    // "not in import map".
    const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-loader-hoist-" }));
    try {
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({ workspace: ["./apps/*"], nodeModulesDir: "manual" }),
      );
      await Deno.writeTextFile(
        join(root, "package.json"),
        JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
      );
      const pkg = join(root, "node_modules", "ms");
      await Deno.mkdir(pkg, { recursive: true });
      await Deno.writeTextFile(
        join(pkg, "package.json"),
        JSON.stringify({ name: "ms", version: "2.1.3", main: "index.js" }),
      );
      await Deno.writeTextFile(join(pkg, "index.js"), "module.exports = () => 'HOISTED_MS';\n");
      const app = join(root, "apps", "web");
      await Deno.mkdir(app, { recursive: true });
      await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify({ imports: {} }));
      await Deno.writeTextFile(
        join(app, "package.json"),
        JSON.stringify({ name: "web", dependencies: { ms: "^2.1.3" } }),
      );
      await Deno.writeTextFile(join(app, "main.ts"), "import ms from 'ms';\nconsole.log(ms());\n");
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
      assert(result.outputFiles[0].text.includes("HOISTED_MS"), "ms was bundled");
      await esbuild.stop();
      dispatchEvent(new Event("unload"));
      assertEquals(
        [...Deno.readDirSync(app)].map((e) => e.name).sort(),
        ["deno.json", "main.ts", "package.json"],
      );
    } finally {
      await esbuild.stop();
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("packageJsonImports: registry dependencies as npm: imports; other protocols left alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-loader-pkg-" });
  try {
    assertEquals(packageJsonImports(dir), {}, "no package.json");
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: {
          ms: "^2.1.3",
          "@scope/pkg": "1.0.0",
          alias: "npm:real@^3",
          any: "",
          sibling: "workspace:*",
          local: "file:../x",
          gh: "user/repo",
          git: "git+https://example.com/x.git",
        },
        devDependencies: { ms: "9.9.9", dev: "latest" },
      }),
    );
    assertEquals(packageJsonImports(dir), {
      ms: "npm:ms@^2.1.3",
      "ms/": "npm:/ms@^2.1.3/",
      "@scope/pkg": "npm:@scope/pkg@1.0.0",
      "@scope/pkg/": "npm:/@scope/pkg@1.0.0/",
      alias: "npm:real@^3",
      "alias/": "npm:/real@^3/",
      any: "npm:any@*",
      "any/": "npm:/any@*/",
      dev: "npm:dev@latest",
      "dev/": "npm:/dev@latest/",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denoLoaderPlugins: a workspace member builds through its workspace, no stand-in", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-loader-member-" }));
  try {
    const app = join(root, "apps", "web");
    await Deno.mkdir(app, { recursive: true });
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify({ workspace: ["./apps/web/"] }),
    );
    await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify({ imports: {} }));
    await Deno.writeTextFile(join(app, "main.ts"), 'console.log("MEMBER_OK");\n');
    const result = await esbuild.build({
      entryPoints: [join(app, "main.ts")],
      absWorkingDir: app,
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      plugins: denoLoaderPlugins({ configPath: join(app, "deno.json"), loader: "portable" }),
    });
    assert(result.outputFiles[0].text.includes("MEMBER_OK"));
    assertEquals([...Deno.readDirSync(app)].map((e) => e.name).sort(), ["deno.json", "main.ts"]);
  } finally {
    await esbuild.stop();
    await Deno.remove(root, { recursive: true });
  }
});
