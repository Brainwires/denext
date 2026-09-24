// `denext mobile add <capability...>` (src/build/mobile-capabilities.ts +
// src/cli/commands/mobile.ts): finds the Capacitor project, refuses a mismatched
// @capacitor/core major, picks the package manager from the lockfile, adds Info.plist keys and
// Android permissions, and runs the install and `cap sync` through an injected runner. No test
// spawns a real process.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  formatCapabilityTable,
  MOBILE_CAPABILITIES,
  type MobileCapability,
  planMobileCapabilities,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import { withManifestPermission, withPlistDefault } from "../src/build/mobile-native-config.ts";
import { createMobileCommand } from "../src/cli/commands/mobile.ts";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSCameraUsageDescription</key>
		<string>nested, not top-level</string>
	</dict>
</dict>
</plist>
`;

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name">
    </application>

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const PLIST_PATH = "ios/App/App/Info.plist";
const MANIFEST_PATH = "android/app/src/main/AndroidManifest.xml";

/** A fake Capacitor 8 project; `files` adds or overrides (a null value leaves a file out). */
async function project(files: Record<string, string | null> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_add_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'dev.example', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    [PLIST_PATH]: INFO_PLIST,
    [MANIFEST_PATH]: MANIFEST,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) continue;
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** A runner that records every command and exits with `codes[i]` (default 0). */
function fakeRunner(codes: number[] = []) {
  const calls: PlannedCommand[] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve({ code: codes[calls.length - 1] ?? 0 });
  };
  return { run, calls };
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

/** Run `fn` with `dir` removed afterwards. */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await project(files);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("mobile add: the package manager comes from the lockfile (npm without one)", async () => {
  const cases: Array<[string | null, string, string]> = [
    ["pnpm-lock.yaml", "pnpm", "add"],
    ["package-lock.json", "npm", "install"],
    ["bun.lock", "bun", "add"],
    ["bun.lockb", "bun", "add"],
    ["yarn.lock", "yarn", "add"],
    [null, "npm", "install"],
  ];
  for (const [lockfile, cmd, verb] of cases) {
    await inProject(lockfile ? { [lockfile]: "" } : {}, async (dir) => {
      const plan = await planMobileCapabilities({ capabilities: ["haptics", "share"], cwd: dir });
      assertEquals(plan.packageManager, cmd, String(lockfile));
      assertEquals(plan.lockfile, lockfile ?? undefined);
      assertEquals(plan.install, {
        cmd,
        args: [verb, "@capacitor/haptics@^8.0.2", "@capacitor/share@^8.0.2"],
        cwd: dir,
      });
    });
  }
});

Deno.test("mobile add: runs the install, edits the manifest, then cap sync", async () => {
  await inProject({ "pnpm-lock.yaml": "" }, async (dir) => {
    const { run, calls } = fakeRunner();
    const report = await addMobileCapabilities({
      capabilities: ["network", "haptics", "network"],
      cwd: dir,
      run,
    });
    assertEquals(calls, [
      {
        cmd: "pnpm",
        args: ["add", "@capacitor/network@^8.0.1", "@capacitor/haptics@^8.0.2"],
        cwd: dir,
      },
      { cmd: "npx", args: ["cap", "sync"], cwd: dir },
    ]);
    assertEquals(report.ran, [
      "pnpm add @capacitor/network@^8.0.1 @capacitor/haptics@^8.0.2",
      "npx cap sync",
    ]);
    assertEquals(report.written, [MANIFEST_PATH]);
    const manifest = await read(dir, MANIFEST_PATH);
    assertStringIncludes(
      manifest,
      '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n    <application',
    );
    assertEquals(await read(dir, PLIST_PATH), INFO_PLIST, "no plist keys for these");

    // Again: the permission is already there.
    const again = await addMobileCapabilities({ capabilities: ["network"], cwd: dir, run });
    assertEquals(again.written, []);
    assertEquals(again.unchanged, [MANIFEST_PATH]);
    assertEquals(await read(dir, MANIFEST_PATH), manifest);
  });
});

Deno.test("mobile add: Info.plist keys are added when absent and never replace yours", async () => {
  const table: Record<string, MobileCapability> = {
    camera: {
      npm: "@capacitor/camera",
      version: "^8.0.0",
      capacitorMajor: 8,
      iosPlist: {
        NSCameraUsageDescription: "Scan <codes> & more",
        CFBundleDisplayName: "Would overwrite",
      },
      androidPermissions: ["android.permission.CAMERA"],
    },
  };
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["camera"], cwd: dir, run, table });
    assertEquals(report.written, [PLIST_PATH, MANIFEST_PATH]);
    const plist = await read(dir, PLIST_PATH);
    assertStringIncludes(
      plist,
      "\t<key>NSCameraUsageDescription</key>\n\t<string>Scan &lt;codes&gt; &amp; more</string>\n</dict>\n</plist>",
    );
    assertStringIncludes(plist, "<key>CFBundleDisplayName</key>\n\t<string>App</string>");
    assert(!plist.includes("Would overwrite"));
  });
});

Deno.test("mobile add: a missing platform is skipped, and a manifest without <application> reported", async () => {
  await inProject({ [MANIFEST_PATH]: null }, async (dir) => {
    const { run, calls } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["network"], cwd: dir, run });
    assertEquals(report.written, []);
    assertStringIncludes(report.skipped[0], "cap add android");
    assertEquals(calls.length, 2, "install and sync still run");
  });
  await inProject({ [MANIFEST_PATH]: "<manifest></manifest>" }, async (dir) => {
    const report = await addMobileCapabilities({
      capabilities: ["network"],
      cwd: dir,
      run: fakeRunner().run,
    });
    assertStringIncludes(report.skipped[0], "by hand");
  });
});

Deno.test("mobile add: --dry-run plans, prints, and changes nothing", async () => {
  await inProject({ "yarn.lock": "" }, async (dir) => {
    const { run, calls } = fakeRunner();
    const report = await addMobileCapabilities({
      capabilities: ["network", "secure-store"],
      cwd: dir,
      run,
      dryRun: true,
    });
    assertEquals(calls, []);
    assertEquals(report.ran, []);
    assertEquals(await read(dir, MANIFEST_PATH), MANIFEST);
    const text = formatCapabilityPlan(report.plan);
    assertStringIncludes(text, `project        ${dir}`);
    assertStringIncludes(text, "@capacitor/core 8 (installed)");
    assertStringIncludes(text, "package mgr    yarn (yarn.lock)");
    assertStringIncludes(
      text,
      "install        yarn add @capacitor/network@^8.0.1 @aparajita/capacitor-secure-storage@^8.0.1",
    );
    assertStringIncludes(text, "<uses-permission android.permission.ACCESS_NETWORK_STATE>");
    assertStringIncludes(text, "sync           npx cap sync");
    assertStringIncludes(text, "secure-store: secureStore.get / set / delete");
  });
});

Deno.test("mobile add: refuses an @capacitor/core major the plugins do not target", async () => {
  await inProject({
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "7.4.3" }),
  }, async (dir) => {
    const { run, calls } = fakeRunner();
    await assertRejects(
      () => addMobileCapabilities({ capabilities: ["haptics"], cwd: dir, run }),
      Error,
      "@capacitor/core 7 (installed) does not match Capacitor 8",
    );
    assertEquals(calls, [], "nothing ran");
  });
  // Not installed yet: package.json's range decides.
  await inProject({
    "node_modules/@capacitor/core/package.json": null,
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "~6.2.0" } }),
  }, async (dir) => {
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["haptics"], cwd: dir }),
      Error,
      "@capacitor/core 6 (from package.json)",
    );
  });
  await inProject({
    "node_modules/@capacitor/core/package.json": null,
    "package.json": "{}",
  }, async (dir) => {
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["haptics"], cwd: dir }),
      Error,
      "does not depend on @capacitor/core",
    );
  });
});

Deno.test("mobile add: finds the project in --dir, else cwd; unknown capabilities refused", async () => {
  await inProject({}, async (dir) => {
    const outer = await Deno.makeTempDir({ prefix: "denext_mobile_add_cwd_" });
    try {
      const viaDir = await planMobileCapabilities({ capabilities: ["device"], cwd: outer, dir });
      assertEquals(viaDir.root, dir);
      const viaCwd = await planMobileCapabilities({ capabilities: ["device"], cwd: dir });
      assertEquals(viaCwd.root, dir);
      await assertRejects(
        () => planMobileCapabilities({ capabilities: ["device"], cwd: outer }),
        Error,
        "no Capacitor project",
      );
    } finally {
      await Deno.remove(outer, { recursive: true });
    }
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["camera", "haptics"], cwd: dir }),
      Error,
      'unknown capability "camera"',
    );
    await assertRejects(
      () => planMobileCapabilities({ capabilities: [], cwd: dir }),
      Error,
      "at least one capability",
    );
  });
});

Deno.test("mobile add: an explicit --dir without a project throws, never falling back to cwd", async () => {
  await inProject({}, async (dir) => {
    const outer = await Deno.makeTempDir({ prefix: "denext_mobile_add_dir_" });
    try {
      // cwd IS a Capacitor project, but --dir names another folder: that folder is the only
      // place looked, and the error names it.
      const err = await assertRejects(
        () => planMobileCapabilities({ capabilities: ["device"], cwd: dir, dir: outer }),
        Error,
        "no Capacitor project",
      );
      assertStringIncludes(err.message, `--dir ${outer}`);
      assertStringIncludes(err.message, outer);
      // A relative --dir resolves against cwd and is named as given.
      const rel = await assertRejects(
        () => planMobileCapabilities({ capabilities: ["device"], cwd: dir, dir: "missing" }),
        Error,
        "--dir missing",
      );
      assertStringIncludes(rel.message, join(dir, "missing"));
      // addMobileCapabilities refuses before running anything.
      const { run, calls } = fakeRunner([]);
      await assertRejects(
        () => addMobileCapabilities({ capabilities: ["device"], cwd: dir, dir: outer, run }),
        Error,
        "no Capacitor project",
      );
      assertEquals(calls, []);
    } finally {
      await Deno.remove(outer, { recursive: true });
    }
  });
});

Deno.test("mobile add: a failing install stops before editing or syncing", async () => {
  await inProject({}, async (dir) => {
    const { run, calls } = fakeRunner([1]);
    await assertRejects(
      () => addMobileCapabilities({ capabilities: ["network"], cwd: dir, run }),
      Error,
      "exited with code 1",
    );
    assertEquals(calls.length, 1);
    assertEquals(await read(dir, MANIFEST_PATH), MANIFEST);
  });
});

Deno.test("mobile add: the table pins every capability to Capacitor 8", () => {
  assertEquals(Object.keys(MOBILE_CAPABILITIES), [
    "haptics",
    "clipboard",
    "share",
    "device",
    "network",
    "keep-awake",
    "splash",
    "secure-store",
    "browser",
  ]);
  for (const [name, cap] of Object.entries(MOBILE_CAPABILITIES)) {
    assertEquals(cap.capacitorMajor, 8, name);
    assert(cap.version.startsWith("^8."), name);
  }
  assertStringIncludes(formatCapabilityTable(), "keep-awake    @capacitor-community/keep-awake@^8");
});

/** Run the `mobile` verb with a fake runner, capturing console.log. */
async function runVerb(
  positionals: string[],
  flags: Record<string, string | boolean>,
  run: CommandRunner,
): Promise<string[]> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await createMobileCommand(run).run({
      positionals,
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines;
}

Deno.test("denext mobile add: --list, --dry-run and a real run through the verb", async () => {
  const { run, calls } = fakeRunner();
  const listed = await runVerb(["add"], { list: true }, run);
  assertStringIncludes(listed.join("\n"), "secure-store  @aparajita/capacitor-secure-storage");

  await inProject({ "bun.lockb": "" }, async (dir) => {
    const planned = await runVerb(["add", "haptics"], { "dry-run": true, dir }, run);
    assertStringIncludes(planned.join("\n"), "nothing changed");
    assertStringIncludes(planned.join("\n"), "install        bun add @capacitor/haptics@^8.0.2");
    assertEquals(calls, []);

    const done = await runVerb(["add", "network"], { dir }, run);
    assertEquals(calls.map((c) => [c.cmd, ...c.args].join(" ")), [
      "bun add @capacitor/network@^8.0.1",
      "npx cap sync",
    ]);
    assertStringIncludes(done.join("\n"), `wrote      ${MANIFEST_PATH}`);
  });
});

Deno.test("native config: withPlistDefault / withManifestPermission edge cases", () => {
  assertEquals(withPlistDefault("not a plist", "K", "v"), null);
  // A nested key of the same name does not count as present.
  const plist = withPlistDefault(INFO_PLIST, "NSCameraUsageDescription", "top");
  assert(plist?.includes("<string>top</string>"));
  assertEquals(withPlistDefault(plist!, "NSCameraUsageDescription", "again"), plist);

  // An <application> on the same line as other text gets the element inline.
  assertEquals(
    withManifestPermission("<manifest><application/></manifest>", "a.B"),
    '<manifest><uses-permission android:name="a.B" />\n<application/></manifest>',
  );
  const sdk23 = '<manifest><uses-permission-sdk-23 android:name="a.B"/><application/></manifest>';
  assertEquals(withManifestPermission(sdk23, "a.B"), sdk23);
  assertEquals(withManifestPermission("<manifest/>", "a.B"), null);
});
