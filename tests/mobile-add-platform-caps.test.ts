// `denext mobile add permissions | local-notifications | biometrics | social-login |
// geolocation | purchases` (src/build/mobile-capabilities.ts + mobile-settings-install.ts): the
// pinned npm packages, the Info.plist usage strings, Android permissions, the Sign in with Apple
// entitlement and Google's URL scheme, and denext's DenextSettings plugin (behind
// openAppSettings) written once however many capabilities install it, registered through the
// shared bridge view controller and MainActivity. No test spawns a real process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  planMobileCapabilities,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import { addSettingsToProject } from "../src/build/mobile-settings-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import {
  isPristineSettingsTemplate,
  renderSettingsTemplate,
  SETTINGS_ANDROID_FILES,
  SETTINGS_IOS_FILES,
} from "../src/build/settings-native-templates.ts";
import { markedTemplateIntact } from "../src/build/native-template-marker.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const INFO_PLIST = "ios/App/App/Info.plist";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS_SETTINGS = "ios/App/App/DenextSettingsPlugin.swift";
const ANDROID_SETTINGS = "android/app/src/main/java/dev/denext/settings/DenextSettingsPlugin.java";
const ENTITLEMENTS = "ios/App/App/App.entitlements";

const STOCK_STORYBOARD = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">
    <scenes>
        <scene sceneID="tne-QT-ifu">
            <objects>
                <viewController id="BYZ-38-t0r" customClass="CAPBridgeViewController" customModule="Capacitor" sceneMemberID="viewController"/>
            </objects>
        </scene>
    </scenes>
</document>
`;

const INFO_PLIST_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
</dict>
</plist>
`;

const MANIFEST_TEXT = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
</manifest>
`;

const STOCK_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

/** A stock Capacitor 8 project with ios/ and android/; `files` overrides (null leaves one out). */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_platform_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    ".git/HEAD": "ref: refs/heads/main\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    [INFO_PLIST]: INFO_PLIST_TEXT,
    [MANIFEST]: MANIFEST_TEXT,
    [MAIN_ACTIVITY]: STOCK_ACTIVITY,
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

Deno.test("mobile add permissions: no package; DenextSettings on iOS + Android, registered", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["permissions"], cwd: dir, run });
    assertEquals(lines(), [], "no npm package, no cap sync");
    for (const path of [IOS_SETTINGS, ANDROID_SETTINGS, BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    const ios = await read(dir, IOS_SETTINGS);
    assert(ios.startsWith("// denext-settings-template: 1 sha256="));
    assertEquals(await markedTemplateIntact("settings", ios), true);
    assertStringIncludes(ios, "UIApplication.openSettingsURLString");
    assertStringIncludes(await read(dir, ANDROID_SETTINGS), "ACTION_APPLICATION_DETAILS_SETTINGS");
    assertEquals(await read(dir, BRIDGE), await bridgeViewControllerSource(new Set(["settings"])));
    assertStringIncludes(await read(dir, BRIDGE), "registerPluginInstance(DenextSettingsPlugin())");
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["settings"])),
    );
    assertStringIncludes(await read(dir, PBXPROJ), "DenextSettingsPlugin.swift");
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController"',
    );
    // Idempotent: a second run writes nothing.
    const again = await addMobileCapabilities({ capabilities: ["permissions"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add: the permission capabilities install DenextSettings once", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const plan = await planMobileCapabilities({
      capabilities: ["local-notifications", "biometrics", "geolocation", "permissions"],
      cwd: dir,
    });
    assertEquals(plan.native.installs.length, 1, "shared install runs once");
    const text = formatCapabilityPlan(plan);
    assertEquals(text.split("DenextSettings plugin").length, 2, "listed once");
    const report = await addMobileCapabilities({
      capabilities: ["local-notifications", "biometrics", "geolocation"],
      cwd: dir,
      run,
    });
    assertEquals(lines(), [
      "npm install @capacitor/local-notifications@^8.3.1 @aparajita/capacitor-biometric-auth@^10.0.0 " +
      "@capacitor/geolocation@^8.2.2",
      "npx cap sync",
    ]);
    assert(report.written.includes(IOS_SETTINGS));
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(plist, "<key>NSFaceIDUsageDescription</key>");
    assertStringIncludes(plist, "<key>NSLocationWhenInUseUsageDescription</key>");
    const manifest = await read(dir, MANIFEST);
    for (
      const p of [
        "POST_NOTIFICATIONS",
        "USE_BIOMETRIC",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
      ]
    ) {
      assertStringIncludes(manifest, `android.permission.${p}`);
    }
    assertStringIncludes(report.plan.manual.join("\n"), "SCHEDULE_EXACT_ALARM");
  });
});

Deno.test("mobile add social-login: the Apple entitlement, Google's scheme, the manual steps", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({
      capabilities: ["social-login"],
      cwd: dir,
      run,
      schemes: ["com.googleusercontent.apps.1234-abcd"],
    });
    assertEquals(lines(), ["npm install @capgo/capacitor-social-login@^8.5.11", "npx cap sync"]);
    const entitlements = await read(dir, ENTITLEMENTS);
    assertStringIncludes(entitlements, "<key>com.apple.developer.applesignin</key>");
    assertStringIncludes(entitlements, "<string>Default</string>");
    assertStringIncludes(await read(dir, INFO_PLIST), "com.googleusercontent.apps.1234-abcd");
    const manual = report.plan.manual.join("\n");
    assertStringIncludes(manual, "facebook: false");
    assertStringIncludes(manual, "Sign in with Apple");
    assert(!manual.includes("re-run with --scheme"));
    const without = await planMobileCapabilities({ capabilities: ["social-login"], cwd: dir });
    assertStringIncludes(without.manual.join("\n"), "re-run with --scheme com.googleusercontent");
  });
});

Deno.test("mobile add purchases: RevenueCat's SDK and the store steps", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["purchases"], cwd: dir, run });
    assertEquals(lines(), ["npm install @revenuecat/purchases-capacitor@^13.6.1", "npx cap sync"]);
    assertEquals(report.written, []);
    const manual = report.plan.manual.join("\n");
    assertStringIncludes(manual, "In-App Purchase capability");
    assertStringIncludes(manual, "verifyRevenueCatWebhook");
    assertStringIncludes(manual, "3.1.1");
  });
});

Deno.test("DenextSettings templates: an edited file is kept, an unedited one upgraded", async () => {
  await inProject({ [INFO_PLIST]: null }, async (dir) => {
    const first = await addSettingsToProject({ dir });
    assert(first.written.includes(IOS_SETTINGS));
    await Deno.writeTextFile(join(dir, ANDROID_SETTINGS), "// mine\n");
    const second = await addSettingsToProject({ dir });
    assert(second.kept.includes(ANDROID_SETTINGS));
    assertStringIncludes(second.manual.join("\n"), "kept yours");
    const forced = await addSettingsToProject({ dir, force: true });
    assert(forced.written.includes(ANDROID_SETTINGS));
  });
  for (
    const [name, template] of Object.entries({ ...SETTINGS_IOS_FILES, ...SETTINGS_ANDROID_FILES })
  ) {
    const text = await renderSettingsTemplate(template);
    assertEquals(await isPristineSettingsTemplate(text), true, name);
    assertEquals(await isPristineSettingsTemplate(text + "// edit\n"), false, name);
  }
});

Deno.test("DenextSettings: composes with the other bridge / MainActivity features", async () => {
  const activity = await mainActivitySource(
    "com.example.app",
    new Set(["ota", "auth-session", "settings"]),
  );
  assertStringIncludes(activity, "import dev.denext.settings.DenextSettingsPlugin;");
  // OTA's prepare stays first in onCreate; settings registers after the others.
  assert(activity.indexOf("DenextOta.prepare(") < activity.indexOf("DenextSettingsPlugin.class"));
  const bridge = await bridgeViewControllerSource(new Set(["ota", "settings"]));
  assertStringIncludes(bridge, "registerPluginInstance(DenextSettingsPlugin())");
  // Existing combinations are byte-for-byte what they were (settings adds nothing to them).
  const before = await mainActivitySource("com.example.app", new Set(["auth-session"]));
  assert(!before.includes("Settings"));
});
