// Packaging `desktop.sidecars` (src/build/desktop-sidecar-bundle.ts, desktop-sidecar-add.ts and the
// sidecar parts of desktop-capabilities.ts): a Node backend bundled with its npm imports inlined,
// native-addon and `external` packages copied whole (other OSes' prebuilds left out) and loaded
// with `require` — run for real in a worker — plus the baked permissions, the `--include`s, the
// `desktop add sidecar` config edit and the config validation.

import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { bundleDesktopSidecar, isNativePackage } from "../src/build/desktop-sidecar-bundle.ts";
import {
  desktopBuildFlags,
  desktopSidecarIncludeArgs,
  sidecarPermissionSet,
} from "../src/build/desktop-capabilities.ts";
import { addDesktopSidecar } from "../src/build/desktop-sidecar-add.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { SidecarDefinition } from "../src/desktop/sidecar.ts";
import { workerSidecarLauncher } from "../src/desktop/sidecar-launch.ts";

/** Write `files` (path → text) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** A Node backend: a pure dependency, a native one (with its own dependency), an external one. */
const BACKEND: Record<string, string> = {
  "server/main.mjs": `
import { isSea } from "node:sea";
import { greet } from "puredep";
import native from "nativepkg";
import ext from "extpkg";
console.log(JSON.stringify({ greet: greet(), native, ext: ext.readOwnFile(), sea: isSea() }));
globalThis.denextSidecar?.ready();
`,
  "server/node_modules/puredep/package.json":
    '{"name":"puredep","type":"module","exports":"./index.js"}',
  "server/node_modules/puredep/index.js": 'export const greet = () => "hi from puredep";\n',
  "server/node_modules/nativepkg/package.json":
    '{"name":"nativepkg","main":"index.js","dependencies":{"nativedep":"1"},"optionalDependencies":{"nativepkg-other-os":"1"}}',
  "server/node_modules/nativepkg/index.js":
    'module.exports = { native: true, dep: require("nativedep").id };\n',
  "server/node_modules/nativepkg/prebuilds/linux-x64/addon.node": "ELF",
  "server/node_modules/nativepkg/prebuilds/darwin-arm64/addon.node": "MACHO",
  "server/node_modules/nativepkg/prebuilds/win32-x64/addon.node": "PE",
  "server/node_modules/nativedep/package.json": '{"name":"nativedep","main":"index.js"}',
  "server/node_modules/nativedep/index.js": 'module.exports = { id: "nativedep" };\n',
  "server/node_modules/extpkg/package.json": '{"name":"extpkg","main":"index.js"}',
  "server/node_modules/extpkg/index.js":
    'const fs = require("fs"); const path = require("path");\n' +
    'module.exports = { readOwnFile: () => fs.readFileSync(path.join(__dirname, "data.txt"), "utf8").trim() };\n',
  "server/node_modules/extpkg/data.txt": "external data\n",
};

/** The backend's sidecar definition. */
const SIDECAR: SidecarDefinition = {
  name: "api",
  run: { module: "server/main.mjs", nodeModules: "server/node_modules", external: ["extpkg"] },
  permissions: { ffi: ["*"] },
};

Deno.test("bundleDesktopSidecar: npm imports inlined, native and external packages copied and required", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-bundle-" });
  try {
    await writeTree(root, BACKEND);
    const report = await bundleDesktopSidecar({
      projectDir: root,
      definition: SIDECAR,
      os: "linux",
      ffiGranted: true,
    });
    assertEquals(report.dir, ".deno-desktop/sidecars/api");
    assertEquals(report.natives, ["nativepkg"]);
    assertEquals([...report.copied].sort(), ["extpkg", "nativedep", "nativepkg"]);
    assertEquals(report.warnings, []);
    const out = join(root, ".deno-desktop", "sidecars", "api");
    const main = await Deno.readTextFile(join(out, "main.mjs"));
    assert(main.includes("hi from puredep"), "the pure dependency is inlined");
    assert(!main.includes("external data"), "the external package is not");
    const prebuilds = [...Deno.readDirSync(join(out, "node_modules", "nativepkg", "prebuilds"))]
      .map((e) => e.name);
    assertEquals(prebuilds, ["linux-x64"], "other OSes' prebuilt addons are left out");
    assertEquals(
      await Deno.stat(join(out, "node_modules", "puredep")).then(() => true, () => false),
      false,
    );

    // The bundle runs in a worker with nothing but its own folder.
    await Deno.rename(join(root, "server"), join(root, "server.moved"));
    const lines: string[] = [];
    let ready = 0;
    const inst = await workerSidecarLauncher({ entry: toFileUrl(join(out, "main.mjs")).href })({
      definition: SIDECAR,
      bootstrap: null,
      secrets: {},
      onLine: (_s, l) => lines.push(l),
      onReadySignal: () => ready++,
    });
    const end = Date.now() + 10_000;
    while (ready === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await inst.stop(0);
    assertEquals(JSON.parse(lines[0]), {
      greet: "hi from puredep",
      native: { native: true, dep: "nativedep" },
      ext: "external data",
      sea: false,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bundleDesktopSidecar: windows keeps win32 prebuilds; a missing ffi grant is warned about", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-bundle-" });
  try {
    await writeTree(root, BACKEND);
    const report = await bundleDesktopSidecar({
      projectDir: root,
      definition: { ...SIDECAR, permissions: {} },
      os: "windows",
    });
    const prebuilds = join(root, ".deno-desktop/sidecars/api/node_modules/nativepkg/prebuilds");
    assertEquals([...Deno.readDirSync(prebuilds)].map((e) => e.name), ["win32-x64"]);
    assertEquals(report.warnings.length, 1);
    assertMatch(report.warnings[0], /native addons \(nativepkg\).*ffi/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bundleDesktopSidecar: an unresolvable import fails with the sidecar's name", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-bundle-" });
  try {
    await writeTree(root, {
      "server/main.mjs": 'import "not-installed";\n',
      "server/node_modules/.keep": "",
    });
    let message = "";
    try {
      await bundleDesktopSidecar({ projectDir: root, definition: SIDECAR });
    } catch (err) {
      message = (err as Error).message;
    }
    assertMatch(message, /cannot bundle sidecar "api" \(server\/main\.mjs\):[\s\S]*not-installed/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("isNativePackage: a manifest field, binding.gyp or a .node file", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-native-" });
  try {
    await writeTree(root, {
      "napi/package.json": '{"name":"napi","napi":{"binaryName":"x"}}',
      "gyp/package.json": '{"name":"gyp"}',
      "gyp/binding.gyp": "{}",
      "deep/package.json": '{"name":"deep"}',
      "deep/a/b/c/x.node": "",
      "plain/package.json": '{"name":"plain"}',
      "plain/node_modules/inner/x.node": "",
    });
    for (const [name, want] of [["napi", true], ["gyp", true], ["deep", true], ["plain", false]]) {
      assertEquals(await isNativePackage(join(root, name as string)), want, name as string);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("desktopSidecarIncludeArgs: bundles, modules and the project's programs are embedded", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-include-" });
  try {
    await writeTree(root, { ...BACKEND, "stale/.keep": "" });
    await Deno.mkdir(join(root, ".deno-desktop/sidecars/old"), { recursive: true });
    const config = {
      desktop: {
        sidecars: [
          SIDECAR,
          { name: "deno", run: { module: "./server/deno.ts" } },
          { name: "go", run: { exec: "./bin/go-server" } },
          { name: "git", run: { exec: "git" } },
        ],
      },
    };
    const args = await desktopSidecarIncludeArgs(root, config, "linux");
    assertEquals(args, [
      "--include",
      ".deno-desktop/sidecars/api",
      "--include",
      "./server/deno.ts",
      "--include",
      "./bin/go-server",
    ]);
    assertEquals(await Deno.readTextFile(join(root, ".deno-desktop/sidecars/.gitignore")), "*\n");
    assertEquals(
      await Deno.stat(join(root, ".deno-desktop/sidecars/old")).then(() => true, () => false),
      false,
      "a bundle of a sidecar no longer configured is removed",
    );
    assertEquals(await desktopSidecarIncludeArgs(root, {}, "linux"), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("desktopBuildFlags: sidecar permissions are baked like extraPermissions", () => {
  const flags = desktopBuildFlags({
    desktop: {
      extraPermissions: { net: ["api.example.com"] },
      sidecars: [
        { name: "a", run: { module: "./a.ts" }, permissions: { ffi: ["*"], net: ["openai.com"] } },
        { name: "b", run: { exec: "git" }, logs: "file" },
      ],
    },
  }, "linux");
  assertEquals(flags, [
    "--allow-net=127.0.0.1,api.example.com,localhost,openai.com",
    "--allow-read",
    "--allow-env",
    "--allow-write",
    "--allow-run=git",
    "--allow-ffi",
  ]);
  const embedded = desktopBuildFlags(
    { desktop: { sidecars: [{ name: "c", run: { exec: "./bin/server" } }] } },
    "linux",
  );
  assert(embedded.includes("--allow-run"), "a program copied out of the app runs unscoped");
  assert(embedded.includes("--allow-write"));
  assertEquals(sidecarPermissionSet([]), {});
});

Deno.test("addDesktopSidecar: appends to desktop.sidecars, asks for ffi when node_modules is native", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-add-" });
  try {
    await writeTree(root, {
      ...BACKEND,
      "denext.config.ts": '// my app\nexport default {\n  desktop: { app: { name: "X" } },\n};\n',
    });
    const report = await addDesktopSidecar({
      dir: root,
      name: "api",
      entry: "server/main.mjs",
      nodeModules: "server/node_modules",
      ready: "/health",
    });
    assertEquals(report.natives, ["nativepkg"]);
    const source = await Deno.readTextFile(join(root, "denext.config.ts"));
    assert(source.startsWith("// my app\n"), "the rest of the file keeps its bytes");
    const config = (await import(`${toFileUrl(join(root, "denext.config.ts")).href}?1`)).default;
    assertEquals(config.desktop.sidecars, [{
      name: "api",
      run: { module: "server/main.mjs", nodeModules: "server/node_modules" },
      port: "auto",
      ready: { http: "/health" },
      permissions: { ffi: ["*"] },
    }]);
    await addDesktopSidecar({ dir: root, name: "go", exec: "./bin/go" });
    let message = "";
    try {
      await addDesktopSidecar({ dir: root, name: "go", exec: "./bin/go" });
    } catch (err) {
      message = (err as Error).message;
    }
    assertMatch(message, /name "go" is used twice/);
    const after = (await import(`${toFileUrl(join(root, "denext.config.ts")).href}?2`)).default;
    assertEquals(after.desktop.sidecars.map((s: { name: string }) => s.name), ["api", "go"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("config validation: desktop.sidecars is checked, and proxy needs spa.proxy", () => {
  const config = (sidecars: unknown, spa?: unknown) =>
    ({ desktop: { sidecars }, ...(spa ? { spa } : {}) }) as unknown as DenextConfig;
  validateDenextConfig(config([{ name: "a", run: { module: "./a.ts" } }]));
  assertThrows(
    () =>
      validateDenextConfig(
        config([{ name: "a", run: { module: "./a.ts" }, ready: { http: "/" } }]),
      ),
    Error,
    "desktop.sidecars[0]",
  );
  assertThrows(
    () =>
      validateDenextConfig(
        config([{ name: "a", run: { module: "./a.ts" }, port: "auto", proxy: true }]),
      ),
    Error,
    "needs spa.proxy",
  );
  validateDenextConfig(
    config([{ name: "a", run: { module: "./a.ts" }, port: "auto", proxy: true }], {
      proxy: { target: "http://127.0.0.1:3773", prefixes: ["/api"] },
    }),
  );
});
