// `run.exclude` of a bundled Node backend sidecar (src/build/desktop-sidecar-bundle.ts): matching
// packages are neither inlined nor copied (nor resolved: they need not be installed), a copied
// package's dependency that matches stays behind, and at run time `require()` / `import()` of one
// throws MODULE_NOT_FOUND while a static import binds a stand-in that throws only when used — run
// for real in a sidecar worker. Plus the config validation and the glob matching.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { bundleDesktopSidecar } from "../src/build/desktop-sidecar-bundle.ts";
import {
  packageExcluded,
  type SidecarDefinition,
  sidecarDefinitionError,
} from "../src/desktop/sidecar.ts";
import { workerSidecarLauncher } from "../src/desktop/sidecar-launch.ts";
import { prepareSidecarModules } from "../src/desktop/sidecar-modules.ts";

/** Write `files` (path → text) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/**
 * A backend whose SDK pulls a per-platform binary package (the shape of an agent SDK and its
 * `claude` binary), plus excluded packages imported statically, dynamically and with `require`.
 */
const BACKEND: Record<string, string> = {
  "server/main.mjs": `
import { createRequire } from "node:module";
import * as heavy from "@vendor/heavy";
import heavyDefault from "@vendor/heavy";
import { sdkName } from "sdk";
import ext from "extpkg";
const out = { sdk: sdkName(), ext: ext.id, loaded: true };
const code = (fn) => { try { fn(); return "no error"; } catch (e) { return e.code + ": " + e.message; } };
out.named = code(() => heavy.run());
out.call = code(() => heavyDefault());
out.prop = code(() => heavyDefault.version);
out.require = code(() => require("@vendor/opt"));
out.dynamic = await import("@vendor/bin-linux-x64").then(() => "no error", (e) => e.code);
// A copied package's own require() of an excluded dependency: the package is not there.
out.extDep = ext.binary();
console.log(JSON.stringify(out));
globalThis.denextSidecar?.ready();
`,
  "server/package.json": JSON.stringify({
    name: "server",
    dependencies: { sdk: "1", extpkg: "1", "@vendor/bin-linux-x64": "1" },
  }),
  // Pure: inlined. Its per-platform binaries are optional dependencies.
  "server/node_modules/sdk/package.json": JSON.stringify({
    name: "sdk",
    type: "module",
    exports: "./index.js",
    optionalDependencies: { "@vendor/bin-linux-x64": "1", "@vendor/bin-darwin-arm64": "1" },
  }),
  "server/node_modules/sdk/index.js": 'export const sdkName = () => "sdk";\n',
  // External (copied whole): its optional binary dependency must stay behind.
  "server/node_modules/extpkg/package.json": JSON.stringify({
    name: "extpkg",
    main: "index.js",
    optionalDependencies: { "@vendor/bin-linux-x64": "1" },
  }),
  "server/node_modules/extpkg/index.js": `module.exports = {
  id: "extpkg",
  binary: () => { try { require("@vendor/bin-linux-x64"); return "found"; } catch (e) { return e.code; } },
};
`,
  // The "binary" package: installed, native-looking (a .node file), and a direct dependency of the
  // backend — the seed would copy it but for run.exclude.
  "server/node_modules/@vendor/bin-linux-x64/package.json": JSON.stringify({
    name: "@vendor/bin-linux-x64",
    os: ["linux"],
    main: "index.js",
  }),
  "server/node_modules/@vendor/bin-linux-x64/index.js": "module.exports = {};\n",
  "server/node_modules/@vendor/bin-linux-x64/bin.node": "ELF".repeat(1000),
  // @vendor/heavy and @vendor/opt are not installed at all.
};

const SIDECAR: SidecarDefinition = {
  name: "agent",
  run: {
    module: "server/main.mjs",
    nodeModules: "server/node_modules",
    external: ["extpkg"],
    exclude: ["@vendor/bin-*", "@vendor/heavy", "@vendor/opt"],
  },
};

Deno.test("run.exclude: excluded packages are neither bundled, copied nor resolved, and fail only when reached", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-exclude-" });
  try {
    await writeTree(root, BACKEND);
    const report = await bundleDesktopSidecar({
      projectDir: root,
      definition: SIDECAR,
      os: "linux",
    });
    assertEquals(report.copied, ["extpkg"]);
    assertEquals(report.natives, []);
    assertEquals(report.excluded, ["@vendor/bin-linux-x64", "@vendor/heavy", "@vendor/opt"]);
    assertEquals(report.warnings, []);
    const out = join(root, ".deno-desktop", "sidecars", "agent");
    const main = await Deno.readTextFile(join(out, "main.mjs"));
    assert(main.includes("excludes @vendor/heavy (run.exclude)"), "the stand-in names the package");
    const mods = await prepareSidecarModules(out, "agent", join(root, ".test-cache"));
    assert(mods);
    const copied = [...Deno.readDirSync(join(mods, "node_modules"))].map((e) => e.name);
    assertEquals(copied, ["extpkg"], "no @vendor folder was copied");

    const lines: string[] = [];
    let ready = 0;
    const inst = await workerSidecarLauncher({
      entry: toFileUrl(join(out, "main.mjs")).href,
      requireBase: join(mods, "sidecar.cjs"),
    })({
      definition: SIDECAR,
      bootstrap: null,
      secrets: {},
      onLine: (_s, l) => lines.push(l),
      onReadySignal: () => ready++,
    });
    const end = Date.now() + 10_000;
    while (ready === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await inst.stop(0);
    const result = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}");
    assertEquals(result.sdk, "sdk");
    assertEquals(result.ext, "extpkg");
    assertEquals(
      result.loaded,
      true,
      "a static import of an excluded package does not stop the load",
    );
    const missing =
      /^MODULE_NOT_FOUND: Cannot find module '@vendor\/(heavy|opt)': sidecar "agent" excludes/;
    assertMatch(result.named, missing);
    assertMatch(result.call, missing);
    assertMatch(result.prop, missing);
    assertMatch(result.require, missing);
    assertEquals(result.dynamic, "MODULE_NOT_FOUND");
    assertEquals(result.extDep, "MODULE_NOT_FOUND");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("packageExcluded: names and globs, `*` within one segment", () => {
  assert(
    packageExcluded("@anthropic-ai/claude-code-darwin-arm64", ["@anthropic-ai/claude-code-*"]),
  );
  assert(packageExcluded("@img/sharp-linux-x64", ["@img/*"]));
  assert(packageExcluded("fsevents", ["fsevents"]));
  assert(packageExcluded("lib.x", ["lib.*"]));
  assert(!packageExcluded("libax", ["lib.x"]), "a dot is literal");
  assert(!packageExcluded("@anthropic-ai/claude-agent-sdk", ["@anthropic-ai/claude-code-*"]));
  assert(!packageExcluded("@a/b", ["*"]), "`*` never crosses the scope's `/`");
  assert(!packageExcluded("fsevents2", ["fsevents"]));
});

Deno.test("run.exclude: validated (shape, patterns, overlap with external, needs nodeModules)", () => {
  const def = (run: Record<string, unknown>) => ({ name: "a", run });
  const bundled = { module: "m.mjs", nodeModules: "node_modules" };
  assertEquals(sidecarDefinitionError(def({ ...bundled, exclude: ["@x/y-*", "z"] })), null);
  assertEquals(
    sidecarDefinitionError(def({ ...bundled, exclude: "x" })),
    "run.exclude must be a string array",
  );
  for (const bad of ["*", "@*/*", "a/b/c", "x y", "", "pkg/sub"]) {
    assertMatch(
      sidecarDefinitionError(def({ ...bundled, exclude: [bad] })) ?? "",
      /is not a package name or a glob/,
      bad,
    );
  }
  assertEquals(
    sidecarDefinitionError(def({ ...bundled, external: ["@x/y-a"], exclude: ["@x/y-*"] })),
    'run.exclude excludes "@x/y-a", which run.external copies',
  );
  assertMatch(
    sidecarDefinitionError(def({ module: "m.mjs", exclude: ["x"] })) ?? "",
    /need run\.nodeModules/,
  );
});

Deno.test("run.bootstrapFd: an exec sidecar's option, 3 to 9", () => {
  const def = (run: Record<string, unknown>) => ({ name: "a", run });
  assertEquals(sidecarDefinitionError(def({ exec: "./bin/s", bootstrapFd: 3 })), null);
  for (const bad of [2, 10, 3.5, "3"]) {
    assertEquals(
      sidecarDefinitionError(def({ exec: "./bin/s", bootstrapFd: bad })),
      "run.bootstrapFd must be a file descriptor from 3 to 9",
    );
  }
  assertEquals(
    sidecarDefinitionError(def({ module: "m.ts", bootstrapFd: 3 })),
    "run.bootstrapFd is not an option (module, nodeModules, external, exclude, entries)",
  );
});
