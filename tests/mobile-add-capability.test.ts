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
import {
  EMPTY_ENTITLEMENTS,
  withAppDelegatePushForwarding,
  withManifestIntentFilter,
  withManifestPermission,
  withPlistDefault,
  withPlistStringArray,
  withPlistUrlScheme,
} from "../src/build/mobile-native-config.ts";
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
    "deep-links",
    "auth-session",
    "push",
  ]);
  for (const [name, cap] of Object.entries(MOBILE_CAPABILITIES)) {
    assertEquals(cap.capacitorMajor, 8, name);
    // auth-session is denext's own native plugin: no npm package to pin.
    if (cap.npm === undefined) continue;
    assert(cap.version?.startsWith("^8."), name);
  }
  assertEquals(
    Object.keys(MOBILE_CAPABILITIES).filter((n) => MOBILE_CAPABILITIES[n].npm === undefined),
    ["auth-session"],
  );
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

// ---- deep-links and push -------------------------------------------------------------------

const APP_DELEGATE_PATH = "ios/App/App/AppDelegate.swift";
const ENTITLEMENTS_PATH = "ios/App/App/App.entitlements";
const PBXPROJ_PATH = "ios/App/App.xcodeproj/project.pbxproj";

const APP_DELEGATE = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // A "}" in a comment and a string must not end the class: "{ }"
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }
}
`;

const ACTIVITY_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <activity android:name=".Other" />
    </application>
</manifest>
`;

const PBXPROJ = "// !$*UTF8*$!\n{ objects = { }; }\n";

/** A project with an iOS app (Info.plist, AppDelegate, pbxproj) and an Android activity. */
function nativeProject(extra: Record<string, string | null> = {}) {
  return {
    [APP_DELEGATE_PATH]: APP_DELEGATE,
    [MANIFEST_PATH]: ACTIVITY_MANIFEST,
    [PBXPROJ_PATH]: PBXPROJ,
    ...extra,
  };
}

/** Occurrences of `needle` in `text`. */
const count = (text: string, needle: string) => text.split(needle).length - 1;

Deno.test("mobile add deep-links: URL types, intent filters and associated domains, idempotent", async () => {
  await inProject(nativeProject(), async (dir) => {
    const { run, calls } = fakeRunner();
    const opts = {
      capabilities: ["deep-links"],
      cwd: dir,
      run,
      schemes: ["myapp", "myapp-dev"],
      domains: ["app.example.com"],
    };
    const report = await addMobileCapabilities(opts);
    assertEquals(calls[0].args, ["install", "@capacitor/app@^8.1.1"]);
    assertEquals(report.written.sort(), [ENTITLEMENTS_PATH, MANIFEST_PATH, PLIST_PATH].sort());

    const plist = await read(dir, PLIST_PATH);
    assertStringIncludes(
      plist,
      "\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n" +
        "\t\t\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n" +
        "\t\t\t<array>\n\t\t\t\t<string>myapp</string>\n\t\t\t</array>\n\t\t</dict>\n",
    );
    assertStringIncludes(plist, "<string>myapp-dev</string>");
    assertEquals(count(plist, "<key>CFBundleURLTypes</key>"), 1);

    const manifest = await read(dir, MANIFEST_PATH);
    assertStringIncludes(
      manifest,
      "            <intent-filter>\n" +
        '                <action android:name="android.intent.action.VIEW" />\n' +
        '                <category android:name="android.intent.category.DEFAULT" />\n' +
        '                <category android:name="android.intent.category.BROWSABLE" />\n' +
        '                <data android:scheme="myapp" />\n' +
        "            </intent-filter>\n",
    );
    assertStringIncludes(
      manifest,
      '<intent-filter android:autoVerify="true">\n' +
        '                <action android:name="android.intent.action.VIEW" />\n' +
        '                <category android:name="android.intent.category.DEFAULT" />\n' +
        '                <category android:name="android.intent.category.BROWSABLE" />\n' +
        '                <data android:scheme="https" android:host="app.example.com" />\n',
    );
    assert(
      manifest.indexOf('android:host="app.example.com"') < manifest.indexOf(".Other"),
      "added to the launcher activity",
    );

    const entitlements = await read(dir, ENTITLEMENTS_PATH);
    assertStringIncludes(
      entitlements,
      "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n" +
        "\t\t<string>applinks:app.example.com</string>\n\t</array>\n",
    );
    assertStringIncludes(report.plan.manual.join("\n"), "Code Signing Entitlements");
    assertStringIncludes(report.plan.manual.join("\n"), "apple-app-site-association");
    assertStringIncludes(report.plan.manual.join("\n"), 'accept: { hosts: ["app.example.com"] }');

    // Again: nothing to add anywhere.
    const again = await addMobileCapabilities(opts);
    assertEquals(again.written, []);
    assertEquals(again.unchanged.sort(), [ENTITLEMENTS_PATH, MANIFEST_PATH, PLIST_PATH].sort());
    assertEquals(await read(dir, PLIST_PATH), plist);
    assertEquals(await read(dir, MANIFEST_PATH), manifest);
    assertEquals(await read(dir, ENTITLEMENTS_PATH), entitlements);

    // A new scheme and domain merge into what is there.
    await addMobileCapabilities({
      ...opts,
      schemes: ["MYAPP-DEV".toLowerCase(), "extra"],
      domains: ["b.example.com"],
    });
    const merged = await read(dir, PLIST_PATH);
    assertEquals(count(merged, "<string>myapp-dev</string>"), 1);
    assertEquals(count(merged, "<key>CFBundleURLTypes</key>"), 1);
    assertStringIncludes(merged, "<string>extra</string>");
    const mergedEnt = await read(dir, ENTITLEMENTS_PATH);
    assertStringIncludes(
      mergedEnt,
      "<string>applinks:app.example.com</string>\n\t\t<string>applinks:b.example.com</string>",
    );
    assertEquals(count(await read(dir, MANIFEST_PATH), 'android:scheme="extra"'), 1);
  });
});

Deno.test("mobile add deep-links: option checks", async () => {
  await inProject({}, async (dir) => {
    const plan = (o: Record<string, unknown>) =>
      planMobileCapabilities({ capabilities: ["deep-links"], cwd: dir, ...o });
    await assertRejects(() => plan({}), Error, "deep-links needs --scheme");
    await assertRejects(() => plan({ schemes: ["My App"] }), Error, "--scheme My App");
    await assertRejects(() => plan({ schemes: ["https"] }), Error, "use --domain");
    await assertRejects(() => plan({ domains: ["https://x.com/a"] }), Error, "--domain https");
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["haptics"], cwd: dir, schemes: ["myapp"] }),
      Error,
      "--scheme is only for deep-links",
    );
    const ok = await plan({ schemes: ["myapp"], domains: ["*.Example.com"] });
    assertEquals(ok.native.manifest.map((e) => e.label), [
      "intent-filter myapp://",
      "intent-filter https://*.example.com (autoVerify)",
    ]);
    const text = formatCapabilityPlan(ok);
    assertStringIncludes(text, "Info.plist     CFBundleURLTypes: myapp");
    assertStringIncludes(text, "entitlements   com.apple.developer.associated-domains");
    assertStringIncludes(text, "manifest       intent-filter myapp://");
  });
});

Deno.test("mobile add push: entitlement, AppDelegate forwarding, permission; FCM warning", async () => {
  await inProject(nativeProject(), async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["push"], cwd: dir, run });
    assertEquals(
      report.written.sort(),
      [APP_DELEGATE_PATH, ENTITLEMENTS_PATH, MANIFEST_PATH].sort(),
    );
    assertStringIncludes(
      await read(dir, ENTITLEMENTS_PATH),
      "\t<key>aps-environment</key>\n\t<string>development</string>\n</dict>",
    );
    const delegate = await read(dir, APP_DELEGATE_PATH);
    assertStringIncludes(
      delegate,
      "    }\n\n    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {\n" +
        "        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)\n    }\n",
    );
    assert(delegate.endsWith("object: error)\n    }\n}\n"), delegate);
    assertStringIncludes(
      await read(dir, MANIFEST_PATH),
      '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    );
    assertEquals(report.plan.warnings.length, 1);
    assertStringIncludes(report.plan.warnings[0], "google-services.json");
    assertStringIncludes(report.plan.manual.join("\n"), "production");

    const again = await addMobileCapabilities({ capabilities: ["push"], cwd: dir, run });
    assertEquals(again.written, []);
    assertEquals(await read(dir, APP_DELEGATE_PATH), delegate);
  });
  // With google-services.json: no warning. A production aps-environment is kept.
  const production = EMPTY_ENTITLEMENTS.replace(
    "<dict>\n",
    "<dict>\n\t<key>aps-environment</key>\n\t<string>production</string>\n",
  );
  await inProject(
    nativeProject({
      "android/app/google-services.json": "{}",
      "ios/App/App/Custom.entitlements": production,
      [PBXPROJ_PATH]: PBXPROJ +
        'CODE_SIGN_ENTITLEMENTS = App/Custom.entitlements;\nCODE_SIGN_ENTITLEMENTS = "$(SRCROOT)/App/Custom.entitlements";\n',
    }),
    async (dir) => {
      const report = await addMobileCapabilities({
        capabilities: ["push"],
        cwd: dir,
        run: fakeRunner().run,
      });
      assertEquals(report.plan.warnings, []);
      assertEquals(report.plan.entitlementsFiles, ["ios/App/App/Custom.entitlements"]);
      assert(!report.plan.manual.join("\n").includes("Code Signing Entitlements"), "already wired");
      assertEquals(await read(dir, "ios/App/App/Custom.entitlements"), production);
      assert(!(await Deno.stat(join(dir, ENTITLEMENTS_PATH)).then(() => true, () => false)));
    },
  );
});

Deno.test("mobile add push: an AppDelegate with its own callback, and no ios/ at all", async () => {
  const custom = APP_DELEGATE.replace(
    "    var window",
    "    func application(_ a: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken t: Data) {}\n    var window",
  );
  await inProject(nativeProject({ [APP_DELEGATE_PATH]: custom }), async (dir) => {
    const report = await addMobileCapabilities({
      capabilities: ["push"],
      cwd: dir,
      run: fakeRunner().run,
    });
    assertStringIncludes(report.skipped.join("\n"), `${APP_DELEGATE_PATH}: could not add forward`);
    assertEquals(await read(dir, APP_DELEGATE_PATH), custom);
  });
  await inProject({ [PLIST_PATH]: null }, async (dir) => {
    const report = await addMobileCapabilities({
      capabilities: ["push"],
      cwd: dir,
      run: fakeRunner().run,
    });
    assertStringIncludes(report.skipped.join("\n"), "iOS: no ios/App/App/App.entitlements");
    assertStringIncludes(report.skipped.join("\n"), "npx cap add ios");
    assertEquals(report.plan.manual.filter((m) => m.includes("Code Signing")), []);
  });
});

Deno.test("native config: plist array / URL scheme / intent filter / AppDelegate edge cases", () => {
  // An existing empty array, and a key of the wrong type.
  const withEmpty = INFO_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>CFBundleURLTypes</key>\n\t<array/>\n</dict>\n</plist>",
  );
  const filled = withPlistUrlScheme(withEmpty, "myapp");
  assertStringIncludes(filled!, "<array>\n\t\t<dict>");
  assertEquals(withPlistUrlScheme(filled!, "MyApp"), filled, "schemes match case-insensitively");
  const wrongType = INFO_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>CFBundleURLTypes</key>\n\t<string>x</string>\n</dict>\n</plist>",
  );
  assertEquals(withPlistUrlScheme(wrongType, "myapp"), null);
  assertEquals(withPlistStringArray(wrongType, "CFBundleURLTypes", ["a"]), null);
  assertEquals(withPlistUrlScheme("nope", "myapp"), null);
  assertEquals(withPlistStringArray("nope", "k", ["a"]), null);
  const emptyArray = EMPTY_ENTITLEMENTS.replace("<dict>\n", "<dict>\n\t<key>k</key>\n\t<array/>\n");
  assertStringIncludes(
    withPlistStringArray(emptyArray, "k", ["a&b"])!,
    "<key>k</key>\n\t<array>\n\t\t<string>a&amp;b</string>\n\t</array>",
  );

  // No launcher activity, or two of them: nowhere to add a filter.
  assertEquals(withManifestIntentFilter("<manifest/>", { scheme: "x" }), null);
  const two = ACTIVITY_MANIFEST.replace(
    '<activity android:name=".Other" />',
    ACTIVITY_MANIFEST.slice(
      ACTIVITY_MANIFEST.indexOf("<activity"),
      ACTIVITY_MANIFEST.indexOf("</activity>") + 11,
    ),
  );
  assertEquals(withManifestIntentFilter(two, { scheme: "x" }), null);
  // A lone activity without MAIN still gets it.
  const lone =
    '<manifest><application><activity android:name=".A"></activity></application></manifest>';
  assertStringIncludes(withManifestIntentFilter(lone, { host: "a.com" })!, 'android:host="a.com"');

  assertEquals(withAppDelegatePushForwarding("struct NotADelegate {}"), null);
  assertEquals(withAppDelegatePushForwarding('class AppDelegate { let s = "'), null);
  const opaque = 'class AppDelegate {\n    let s = """\n}\n"""\n    /* } */ let t = "\\"}"\n}\n';
  assert(withAppDelegatePushForwarding(opaque)!.endsWith("object: error)\n    }\n}\n"));
  assertEquals(withAppDelegatePushForwarding('class AppDelegate { let s = """ }'), null);
  assertEquals(withAppDelegatePushForwarding("class AppDelegate { /* }"), null);
  assertEquals(withAppDelegatePushForwarding("class AppDelegate { // }"), null);
  const oneLine = withAppDelegatePushForwarding("class AppDelegate { var x = 1 }")!;
  assertStringIncludes(oneLine, "var x = 1 \n");
  assert(oneLine.endsWith("}\n}"));
});

Deno.test("denext mobile add: --scheme / --domain are comma-separated lists", async () => {
  await inProject(nativeProject(), async (dir) => {
    const { run } = fakeRunner();
    const out = await runVerb(
      ["add", "deep-links"],
      { dir, scheme: "myapp, other", domain: "app.example.com" },
      run,
    );
    const text = out.join("\n");
    assertStringIncludes(text, `wrote      ${PLIST_PATH}`);
    assertStringIncludes(text, "Still to do by hand:");
    const plist = await read(dir, PLIST_PATH);
    assertStringIncludes(plist, "<string>myapp</string>");
    assertStringIncludes(plist, "<string>other</string>");

    const pushed = await runVerb(["add", "push"], { dir }, run);
    assertStringIncludes(pushed.join("\n"), "WARNING: no android/app/google-services.json");
  });
});
