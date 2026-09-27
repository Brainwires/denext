// `denext mobile add app-review | app-update | screen-orientation | media-library |
// privacy-screen | tracking | background | restore` (src/build/mobile-capabilities-platform.ts):
// the pinned packages, the Info.plist usage strings, and `background`'s native wiring (the
// Background Runner config in capacitor.config, UIBackgroundModes + the BGTask identifier,
// the AppDelegate registration, android/app/build.gradle's flatDir). No real process runs.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  planMobileCapabilities,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import {
  BACKGROUND_RUNNER_CONFIG,
  PLATFORM_CAPABILITIES,
  withAppDelegateBackgroundRunner,
  withRunnerFlatDir,
} from "../src/build/mobile-capabilities-platform.ts";

const INFO_PLIST = "ios/App/App/Info.plist";
const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const APP_GRADLE = "android/app/build.gradle";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";

const INFO_PLIST_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
</dict>
</plist>
`;

const DELEGATE_TEXT = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }
}
`;

const GRADLE_TEXT = `apply plugin: 'com.android.application'

repositories {
    flatDir{
        dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'
    }
}
`;

const MANIFEST_TEXT = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
</manifest>
`;

/** A Capacitor 8 project; `files` overrides (null leaves one out). */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_platform2_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts":
      "import type { CapacitorConfig } from '@capacitor/cli';\n\nconst config: CapacitorConfig = {\n  appId: 'com.example.app',\n  webDir: 'out',\n};\n\nexport default config;\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    // The web export `cap sync` copies (without it the run falls back to `cap update`).
    "out/index.html": "<!doctype html>\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    [INFO_PLIST]: INFO_PLIST_TEXT,
    [APP_DELEGATE]: DELEGATE_TEXT,
    [APP_GRADLE]: GRADLE_TEXT,
    [MANIFEST]: MANIFEST_TEXT,
    ...files,
  };
  try {
    for (const [path, content] of Object.entries(all)) {
      if (content === null) continue;
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A runner recording every command (all exit 0). */
function fakeRunner() {
  const calls: PlannedCommand[] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve({ code: 0 });
  };
  return { run, lines: () => calls.map((c) => [c.cmd, ...c.args].join(" ")) };
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

Deno.test("platform capabilities: each pins a Capacitor 8 package and says what it gives", () => {
  const pins: Record<string, string> = {};
  for (const [name, cap] of Object.entries(PLATFORM_CAPABILITIES)) {
    assertEquals(cap.capacitorMajor, 8, name);
    assert(cap.notes, name);
    pins[name] = cap.npm ? `${cap.npm}@${cap.version}` : "(denext native plugin)";
  }
  assertEquals(pins, {
    "app-review": "@capawesome/capacitor-app-review@^8.0.2",
    "app-update": "@capawesome/capacitor-app-update@^8.0.5",
    "screen-orientation": "@capacitor/screen-orientation@^8.0.1",
    "media-library": "@capacitor-community/media@^9.1.0",
    "privacy-screen": "@capacitor/privacy-screen@^2.0.1",
    tracking: "capacitor-plugin-app-tracking-transparency@^3.0.0",
    background: "@capacitor/background-runner@^3.0.0",
    restore: "@capacitor/app@^8.1.1",
    accessibility: "(denext native plugin)",
    "background-location": "@capgo/background-geolocation@^8.4.7",
    application: "@capacitor/app@^8.1.1",
  });
});

Deno.test("mobile add: the six plugin capabilities install and write their usage strings", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({
      capabilities: [
        "app-review",
        "app-update",
        "screen-orientation",
        "media-library",
        "privacy-screen",
        "tracking",
      ],
      cwd: dir,
      run,
    });
    assertEquals(lines(), [
      "npm install @capawesome/capacitor-app-review@^8.0.2 @capawesome/capacitor-app-update@^8.0.5 " +
      "@capacitor/screen-orientation@^8.0.1 @capacitor-community/media@^9.1.0 " +
      "@capacitor/privacy-screen@^2.0.1 capacitor-plugin-app-tracking-transparency@^3.0.0",
      "npx cap sync",
    ]);
    const plist = await read(dir, INFO_PLIST);
    for (
      const key of [
        "NSPhotoLibraryUsageDescription",
        "NSPhotoLibraryAddUsageDescription",
        "NSUserTrackingUsageDescription",
      ]
    ) assertStringIncludes(plist, `<key>${key}</key>`);
    const manual = report.plan.manual.join("\n");
    for (
      const hint of ["UIRequiresFullScreen", "App Store lookup", "androidGalleryMode", "5.1.2"]
    ) {
      assertStringIncludes(manual, hint);
    }
  });
});

Deno.test("mobile add tracking: an app's own usage string is kept", async () => {
  const custom = INFO_PLIST_TEXT.replace(
    "</dict>",
    "\t<key>NSUserTrackingUsageDescription</key>\n\t<string>Ours.</string>\n</dict>",
  );
  await inProject({ [INFO_PLIST]: custom }, async (dir) => {
    const { run } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["tracking"], cwd: dir, run });
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(plist, "<string>Ours.</string>");
    assertEquals(plist.split("NSUserTrackingUsageDescription").length, 2);
  });
});

Deno.test("mobile add background: runner config, plist keys, AppDelegate, gradle; idempotent", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const plan = await planMobileCapabilities({ capabilities: ["background"], cwd: dir });
    const text = formatCapabilityPlan(plan);
    assertStringIncludes(text, "UIBackgroundModes: fetch, processing");
    assertStringIncludes(text, "BGTaskSchedulerPermittedIdentifiers: dev.denext.background");
    const report = await addMobileCapabilities({ capabilities: ["background"], cwd: dir, run });
    assertEquals(lines(), ["npm install @capacitor/background-runner@^3.0.0", "npx cap sync"]);
    for (const path of ["capacitor.config.ts", INFO_PLIST, APP_DELEGATE, APP_GRADLE]) {
      assert(report.written.includes(path), path);
    }
    const config = await read(dir, "capacitor.config.ts");
    assertStringIncludes(config, "BackgroundRunner");
    assertStringIncludes(config, "dev.denext.background");
    assertStringIncludes(config, "denext-background.js");
    assertStringIncludes(config, "appId: 'com.example.app'");
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(plist, "<key>UIBackgroundModes</key>");
    assertStringIncludes(plist, "<string>processing</string>");
    assertStringIncludes(plist, "<string>dev.denext.background</string>");
    const delegate = await read(dir, APP_DELEGATE);
    assertStringIncludes(delegate, "import Capacitor\nimport CapacitorBackgroundRunner\n");
    assertStringIncludes(
      delegate,
      "-> Bool {\n        // denext mobile add background: register the Background Runner's BGTask.\n" +
        "        BackgroundRunnerPlugin.registerBackgroundTask()\n" +
        "        BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)\n" +
        "        // Override point",
    );
    assertStringIncludes(
      await read(dir, APP_GRADLE),
      "        dirs '../../node_modules/@capacitor/background-runner/android/src/main/libs', 'libs'\n" +
        "        dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'\n",
    );
    assertStringIncludes(report.plan.manual.join("\n"), "BGTaskScheduler");
    const again = await addMobileCapabilities({ capabilities: ["background"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add background: a JSON config and an app's own runner config", async () => {
  await inProject({
    "capacitor.config.ts": null,
    "capacitor.config.json": JSON.stringify({ appId: "com.example.app", webDir: "out" }),
  }, async (dir) => {
    const { run } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["background"], cwd: dir, run });
    const config = JSON.parse(await read(dir, "capacitor.config.json"));
    assertEquals(config.plugins.BackgroundRunner, BACKGROUND_RUNNER_CONFIG);
    assertEquals(config.appId, "com.example.app");
  });
  const own = { appId: "a.b", webDir: "out", plugins: { BackgroundRunner: { label: "mine" } } };
  await inProject({
    "capacitor.config.ts": null,
    "capacitor.config.json": JSON.stringify(own),
  }, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["background"], cwd: dir, run });
    assertEquals(JSON.parse(await read(dir, "capacitor.config.json")), own);
    assert(!report.written.includes("capacitor.config.json"));
  });
});

Deno.test("withAppDelegateBackgroundRunner / withRunnerFlatDir: edge cases", () => {
  assertEquals(withAppDelegateBackgroundRunner("class AppDelegate {}"), null);
  const once = withAppDelegateBackgroundRunner(DELEGATE_TEXT)!;
  assertEquals(withAppDelegateBackgroundRunner(once), once);
  const renamed = DELEGATE_TEXT.replace(
    "didFinishLaunchingWithOptions launchOptions",
    "didFinishLaunchingWithOptions opts",
  );
  assertStringIncludes(
    withAppDelegateBackgroundRunner(renamed)!,
    "handleApplicationDidFinishLaunching(launchOptions: opts)",
  );
  assertEquals(withRunnerFlatDir("apply plugin: 'x'\n"), null);
  const gradle = withRunnerFlatDir(GRADLE_TEXT)!;
  assertEquals(withRunnerFlatDir(gradle), gradle);
});

Deno.test("mobile add restore: @capacitor/app plus the startup note", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["restore"], cwd: dir, run });
    assertEquals(lines(), ["npm install @capacitor/app@^8.1.1", "npx cap sync"]);
    assertStringIncludes(report.plan.manual.join("\n"), "onRestoredResult");
  });
});

Deno.test("mobile add deep-links --domain: the manual step names the appLinks config", async () => {
  await inProject({}, async (dir) => {
    const plan = await planMobileCapabilities({
      capabilities: ["deep-links"],
      cwd: dir,
      domains: ["app.example.com"],
    });
    const manual = plan.manual.join("\n");
    assertStringIncludes(manual, "appLinks: { apple: { appIds:");
    assertStringIncludes(manual, "sha256CertFingerprints");
  });
});
