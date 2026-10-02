// `desktop.denoFlags`: extra `deno desktop` flags (a pnpm workspace's `--node-modules-dir=none`)
// from an allow-list, never a permission flag. Covers the allow-list, config validation, the
// package scripts' bundle command and the scaffolded macOS script, and the pnpm-workspace hint.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { desktopDenoFlagError, desktopDenoFlags } from "../src/desktop/deno-flags.ts";
import { desktopDenoFlagArgs, desktopPnpmWorkspaceHint } from "../src/build/desktop-deno-flags.ts";
import { desktopBundleCommand } from "../src/build/desktop-package-script.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import type { DenextConfig } from "../src/server/config.ts";

Deno.test("desktopDenoFlagError: the allow-list, bare and with values", () => {
  for (
    const ok of [
      "--node-modules-dir",
      "--node-modules-dir=none",
      "--node-modules-dir=manual",
      "--exclude-unused-npm",
      "--no-check",
      "--no-check=remote",
      "--check=all",
      "--no-lock",
      "--lock=deno.lock",
      "--frozen-lockfile",
      "--frozen-lockfile=false",
      "--cached-only",
      "--no-remote",
      "--no-npm",
      "--no-code-cache",
      "--conditions=development,deno",
      "--node-modules-linker=hoisted",
      "--unstable-kv",
      "--unstable-sloppy-imports",
    ]
  ) {
    assertEquals(desktopDenoFlagError(ok), null, ok);
  }
  const reason = (flag: unknown) => desktopDenoFlagError(flag) ?? "";
  assertStringIncludes(reason("--node-modules-dir=global"), "invalid value");
  assertStringIncludes(reason("--conditions"), "needs a value");
  assertStringIncludes(reason("--exclude-unused-npm=1"), "invalid value");
  assertStringIncludes(reason("--frobnicate"), "not an allowed flag");
  assertStringIncludes(reason("--node-modules-dir none"), "whitespace");
  assertStringIncludes(reason(""), "non-empty");
  assertStringIncludes(reason(3), "non-empty");
  assertStringIncludes(reason("constructor"), "not an allowed flag");
});

Deno.test("desktopDenoFlagError: permission flags and denext's own flags are refused", () => {
  for (
    const flag of [
      "-A",
      "--allow-all",
      "--allow-net",
      "--allow-run=sh",
      "--deny-read=/",
      "--ignore-env",
      "-R",
      "-N=example.com",
      "--permission-set=x",
      "--no-prompt",
      "--unsafely-ignore-certificate-errors",
    ]
  ) {
    assertStringIncludes(desktopDenoFlagError(flag) ?? "", "permission", flag);
  }
  for (
    const flag of [
      "--output=x",
      "--target=x",
      "--include=secrets",
      "--icon=x.png",
      "--config=other.json",
      "-c",
      "--v8-flags=--allow-natives-syntax",
      "--inspect",
      "--env-file=.env",
      "--import-map=x.json",
    ]
  ) {
    assertStringIncludes(desktopDenoFlagError(flag) ?? "", "denext sets", flag);
  }
});

Deno.test("desktopDenoFlags: read from the config, checked", () => {
  assertEquals(desktopDenoFlags(undefined), []);
  assertEquals(desktopDenoFlags({ desktop: {} }), []);
  assertEquals(
    desktopDenoFlags({
      desktop: { denoFlags: ["--node-modules-dir=none", "--exclude-unused-npm"] },
    }),
    ["--node-modules-dir=none", "--exclude-unused-npm"],
  );
  assertThrows(() => desktopDenoFlags({ desktop: { denoFlags: "--no-check" } }), Error, "array");
  assertThrows(
    () => desktopDenoFlags({ desktop: { denoFlags: ["--no-check", "--allow-all"] } }),
    Error,
    "desktop.denoFlags[1]",
  );
});

Deno.test("config validation: desktop.denoFlags", () => {
  const check = (denoFlags: unknown) => () =>
    validateDenextConfig({ desktop: { denoFlags } } as unknown as DenextConfig);
  check(["--node-modules-dir=none", "--exclude-unused-npm"])();
  assertThrows(check("--no-check"), Error, "desktop.denoFlags");
  assertThrows(check(["--allow-read"]), Error, "desktop.denoFlags[0]");
});

/** A temp project with `scripts/` and `config` as its `denext.config.ts`. */
async function project(config: string): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  return { dir, entry: toFileUrl(join(dir, "scripts", "package-linux.ts")).href };
}

Deno.test("package scripts: the bundle command passes desktop.denoFlags before the entry", async () => {
  const { dir, entry } = await project(
    'export default { desktop: { denoFlags: ["--node-modules-dir=none", "--exclude-unused-npm"] } };\n',
  );
  const cwd = Deno.cwd();
  try {
    Deno.chdir(dir);
    assertEquals(await desktopDenoFlagArgs(entry), [
      "--node-modules-dir=none",
      "--exclude-unused-npm",
    ]);
    const cmd = await desktopBundleCommand(entry, "linux", {
      target: "x86_64-unknown-linux-gnu",
      out: "dist/a-x64",
      icons: [],
    });
    const at = cmd.indexOf("--node-modules-dir=none");
    assert(at > 2 && at < cmd.indexOf("desktop.ts"), cmd.join(" "));
    assertEquals(cmd[at + 1], "--exclude-unused-npm");
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
  // No config next to the script: no extra flags.
  assertEquals(await desktopDenoFlagArgs("file:///nowhere/scripts/x.ts"), []);
});

Deno.test("package scripts: a refused flag stops the build", async () => {
  const { dir, entry } = await project('export default { desktop: { denoFlags: ["-A"] } };\n');
  try {
    let message = "";
    await desktopDenoFlagArgs(entry).catch((err) => (message = err.message));
    assertStringIncludes(message, "permission");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold: the macOS script passes desktop.denoFlags (regenerate-scripts picks it up)", () => {
  const mac = scaffoldFiles({ dir: ".", desktop: true }).find((f) =>
    f.path === "scripts/package-macos.ts"
  )!;
  assertStringIncludes(mac.content, "...await desktopDenoFlagArgs(import.meta.url),");
});

Deno.test("desktopPnpmWorkspaceHint: a pnpm workspace with nodeModulesDir manual and no flag", async () => {
  const root = await Deno.makeTempDir();
  try {
    const app = join(root, "apps", "desktop");
    await Deno.mkdir(app, { recursive: true });
    await Deno.writeTextFile(join(root, "deno.json"), '{ "nodeModulesDir": "manual" }\n');
    // Not a pnpm workspace yet: no hint.
    assertEquals(await desktopPnpmWorkspaceHint(app, []), undefined);
    await Deno.writeTextFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const hint = await desktopPnpmWorkspaceHint(app, []);
    assertStringIncludes(hint ?? "", "--node-modules-dir=none");
    // The project chose a mode: no hint.
    assertEquals(await desktopPnpmWorkspaceHint(app, ["--node-modules-dir=none"]), undefined);
    assertEquals(await desktopPnpmWorkspaceHint(app, ["--node-modules-dir"]), undefined);
    // The nearest deno.json that sets nodeModulesDir decides.
    await Deno.writeTextFile(join(app, "deno.jsonc"), '// app\n{ "nodeModulesDir": "auto" }\n');
    assertEquals(await desktopPnpmWorkspaceHint(app, []), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
