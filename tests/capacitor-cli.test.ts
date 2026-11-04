// Every `cap` command denext runs is the project's own `@capacitor/cli`: `npx --no cap …` after a
// check that the package resolves from the project. A bare `npx cap` falls back to the npm
// registry's unrelated `cap` package when @capacitor/cli is missing (and `npm exec` assumes
// `--yes` without a TTY or in CI), so a missing CLI must be an error, never a download.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { assertCapacitorCli, capCommand, capSubcommand } from "../src/build/capacitor-cli.ts";
import { addMobileCapabilities, type PlannedCommand } from "../src/build/mobile-capabilities.ts";
import { type BuildCommand, planMobileBuild, runMobileBuild } from "../src/build/mobile-build.ts";
import { runMobileDev } from "../src/build/mobile-dev.ts";
import { createMobileCommand } from "../src/cli/commands/mobile.ts";
import { capture, stubExit } from "./_cli-coverage-helpers.ts";
import { installFakeCapacitorCli } from "./_capacitor-cli.ts";

const MISSING = "@capacitor/cli is not installed";

/** A Capacitor project without node_modules (a `.git` bounds the package-manager walk). */
async function project(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_cap_cli_" }));
  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", appName: "E", webDir: "out" }),
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "8.5.2" } }),
    "out/index.html": "<!doctype html>\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    "android/app/build.gradle": 'android {\n  defaultConfig {\n    applicationId "dev.example"\n' +
      '    versionCode 1\n    versionName "1.0"\n  }\n}\n',
    "android/app/src/main/AndroidManifest.xml":
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
      "  <application></application>\n</manifest>\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** A runner that records and succeeds. */
function recorder() {
  const calls: PlannedCommand[] = [];
  return {
    calls,
    run: (c: PlannedCommand) => {
      calls.push(c);
      return Promise.resolve({ code: 0 });
    },
  };
}

Deno.test("capCommand: npx --no, so npx never installs a missing package", () => {
  const c = capCommand(["sync", "ios"], "/p");
  assertEquals(c, { cmd: "npx", args: ["--no", "cap", "sync", "ios"], cwd: "/p" });
  assertEquals(capSubcommand(c), "sync");
  assertEquals(capSubcommand({ cmd: "npx", args: ["cap", "copy"] }), "copy");
  assertEquals(capSubcommand({ cmd: "deno", args: ["cap", "sync"] }), undefined);
  assertEquals(capSubcommand({ cmd: "npx", args: ["other", "cap"] }), undefined);
});

Deno.test("assertCapacitorCli: the project's node_modules or one above it, else an install hint", async () => {
  const dir = await project();
  try {
    await assertRejects(() => assertCapacitorCli(dir), Error, "npm install -D @capacitor/cli");
    const app = join(dir, "apps", "mobile");
    await Deno.mkdir(app, { recursive: true });
    await installFakeCapacitorCli(dir); // hoisted to a workspace root
    await assertCapacitorCli(app);
    await assertCapacitorCli(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile build: no @capacitor/cli → refused before anything runs", async () => {
  const dir = await project();
  try {
    const ran: BuildCommand[] = [];
    const plan = await planMobileBuild({
      root: dir,
      appDir: dir,
      platform: "android",
      cli: ["run", "-A", "cli.ts"],
      deno: "deno",
    });
    assertEquals(plan.commands[1], {
      ...capCommand(["sync", "android"], dir),
      scrubSigningEnv: true,
    });
    await assertRejects(
      () =>
        runMobileBuild(plan, {}, {
          log: () => {},
          run: (c) => {
            ran.push(c);
            return Promise.resolve({ code: 0 });
          },
        }),
      Error,
      MISSING,
    );
    assertEquals(ran, [], "not even the export");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile dev: no @capacitor/cli → refused before the config is edited or a server starts", async () => {
  const dir = await project();
  try {
    const before = await Deno.readTextFile(join(dir, "capacitor.config.json"));
    const { run, calls } = recorder();
    let started = false;
    await assertRejects(
      () =>
        runMobileDev({ cwd: dir }, {
          run,
          startServer: () => {
            started = true;
            return Promise.reject(new Error("no server in this test"));
          },
          waitForStop: () => new Promise(() => {}),
          log: () => {},
        }),
      Error,
      MISSING,
    );
    assertEquals(calls, []);
    assertEquals(started, false);
    assertEquals(await Deno.readTextFile(join(dir, "capacitor.config.json")), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile add: no @capacitor/cli → refused before the install, an edit or cap sync", async () => {
  const dir = await project();
  try {
    await Deno.mkdir(join(dir, "node_modules/@capacitor/core"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "node_modules/@capacitor/core/package.json"),
      JSON.stringify({ version: "8.5.2" }),
    );
    const manifest = await Deno.readTextFile(join(dir, "android/app/src/main/AndroidManifest.xml"));
    const { run, calls } = recorder();
    await assertRejects(
      () => addMobileCapabilities({ capabilities: ["network"], cwd: dir, run }),
      Error,
      MISSING,
    );
    assertEquals(calls, []);
    assertEquals(
      await Deno.readTextFile(join(dir, "android/app/src/main/AndroidManifest.xml")),
      manifest,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mobile sync: no @capacitor/cli → an install hint, and npx never starts", async () => {
  const dir = await project();
  const exit = stubExit();
  const out = capture();
  try {
    const { run, calls } = recorder();
    await assertRejects(
      async () => {
        await createMobileCommand(run).run({
          positionals: ["sync"],
          flags: { dir },
          global: { json: false, verbose: false, quiet: false },
          rest: [],
        });
      },
      Error,
      "__exit__1",
    );
    assertEquals(calls, []);
    assertStringIncludes(out.errs.join("\n"), MISSING);
  } finally {
    out.restore();
    exit.restore();
    await Deno.remove(dir, { recursive: true });
  }
});
