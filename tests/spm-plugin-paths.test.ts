// `stabilizeSpmPluginPaths` (src/build/spm-plugin-paths.ts): after `cap sync`, the iOS shell's
// CapApp-SPM/Package.swift links each plugin through pnpm's store; the paths are rewritten to the
// package's `node_modules/<name>` entry so a committed shell builds on another checkout. Also
// `denext mobile sync`, which runs `cap sync` and then the rewrite.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { capacitorIosDir, stabilizeSpmPluginPaths } from "../src/build/spm-plugin-paths.ts";
import { createMobileCommand } from "../src/cli/commands/mobile.ts";

const STORE =
  "node_modules/.pnpm/@scope+plugin@8.0.1_@capacitor+core@8.5.3/node_modules/@scope/plugin";

/** Package.swift as Capacitor's CLI writes it, with one remote and two local packages. */
function packageSwift(pluginPath: string, keptPath: string): string {
  return `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "CapApp-SPM",
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "ScopePlugin", path: "${pluginPath}"),
        .package(name: "Kept", path: "${keptPath}")
    ]
)
`;
}

/**
 * A Capacitor project at `<tmp>/app` (iOS shell in `iosPath`) whose plugin lives in pnpm's store
 * at the workspace root, linked from the app's own node_modules.
 */
async function project(iosPath: string | null): Promise<{ app: string; swift: string }> {
  const root = await Deno.makeTempDir({ prefix: "denext_spm_" });
  const app = join(root, "app");
  const real = join(root, STORE);
  await Deno.mkdir(real, { recursive: true });
  await Deno.writeTextFile(join(real, "package.json"), JSON.stringify({ name: "@scope/plugin" }));
  await Deno.mkdir(join(app, "node_modules/@scope"), { recursive: true });
  await Deno.symlink(real, join(app, "node_modules/@scope/plugin"));
  await Deno.writeTextFile(join(app, "package.json"), "{}");
  await Deno.writeTextFile(
    join(app, "capacitor.config.json"),
    JSON.stringify({ appId: "com.example.app", ...(iosPath ? { ios: { path: iosPath } } : {}) }),
  );
  const swift = join(app, iosPath ?? "ios", "App/CapApp-SPM/Package.swift");
  await Deno.mkdir(dirname(swift), { recursive: true });
  await Deno.writeTextFile(
    swift,
    packageSwift(`../../../../${STORE}`, "../../../node_modules/kept-elsewhere"),
  );
  return { app, swift };
}

Deno.test("stabilizeSpmPluginPaths: a pnpm store path becomes the package's node_modules entry", async () => {
  const { app, swift } = await project(null);
  try {
    const changed = await stabilizeSpmPluginPaths(app);
    assertEquals(changed, [[`../../../../${STORE}`, "../../../node_modules/@scope/plugin"]]);
    const text = await Deno.readTextFile(swift);
    assertStringIncludes(
      text,
      '.package(name: "ScopePlugin", path: "../../../node_modules/@scope/plugin")',
    );
    assertStringIncludes(
      text,
      '.package(name: "Kept", path: "../../../node_modules/kept-elsewhere")',
    );
    assertStringIncludes(text, "capacitor-swift-pm.git", "remote packages are untouched");
    assertEquals(await stabilizeSpmPluginPaths(app), [], "idempotent");
  } finally {
    await Deno.remove(dirname(app), { recursive: true });
  }
});

Deno.test("stabilizeSpmPluginPaths: follows capacitor.config's ios.path; no Package.swift is a no-op", async () => {
  const { app, swift } = await project("shell");
  try {
    assertEquals(await capacitorIosDir(app), join(app, "shell"));
    assertEquals((await stabilizeSpmPluginPaths(app)).length, 1);
    assertStringIncludes(await Deno.readTextFile(swift), "../../../node_modules/@scope/plugin");
    await Deno.remove(join(app, "shell"), { recursive: true });
    assertEquals(await stabilizeSpmPluginPaths(app), []);
  } finally {
    await Deno.remove(dirname(app), { recursive: true });
  }
});

Deno.test("denext mobile sync: cap sync in the project, then the plugin paths", async () => {
  const { app, swift } = await project(null);
  const calls: string[] = [];
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await createMobileCommand((c) => {
      calls.push(`${c.cwd}: ${c.cmd} ${c.args.join(" ")}`);
      return Promise.resolve({ code: 0 });
    }).run({
      positionals: ["sync", "ios"],
      flags: { dir: app },
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
    assertEquals(calls, [`${app}: npx cap sync ios`]);
    assertStringIncludes(await Deno.readTextFile(swift), "../../../node_modules/@scope/plugin");
    assertStringIncludes(lines.join("\n"), "plugin path → ../../../node_modules/@scope/plugin");
  } finally {
    console.log = log;
    await Deno.remove(dirname(app), { recursive: true });
  }
});
