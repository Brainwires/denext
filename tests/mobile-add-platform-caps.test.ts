// `denext mobile add permissions | local-notifications | biometrics | social-login |
// geolocation | purchases` (src/build/mobile-capabilities.ts + mobile-settings-install.ts): the
// pinned npm packages, the Info.plist usage strings, Android permissions, the Sign in with Apple
// entitlement and Google's URL scheme, and denext's DenextSettings plugin (behind
// openAppSettings) written once however many capabilities install it, registered through the
// shared bridge view controller and MainActivity. Also `accessibility` (the DenextAccessibility
// plugin, and a 2.10.0 bridge upgraded to register it), `background-location`,
// `application`, camera's microphone string, and the web-export precheck before `cap sync`. No
// test spawns a real process.

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
import { addAccessibilityToProject } from "../src/build/mobile-accessibility-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import {
  ACCESSIBILITY_ANDROID_FILES,
  ACCESSIBILITY_IOS_FILES,
  isPristineAccessibilityTemplate,
  renderAccessibilityTemplate,
} from "../src/build/accessibility-native-templates.ts";
import { OTA_TEMPLATE_VERSION } from "../src/build/ota-native-templates.ts";
import {
  APP_EXTENSION_TEMPLATE_VERSION,
  genericBridgeViewController,
} from "../src/build/app-extension-native-templates.ts";
import {
  isPristineSettingsTemplate,
  renderSettingsTemplate,
  SETTINGS_ANDROID_FILES,
  SETTINGS_IOS_FILES,
} from "../src/build/settings-native-templates.ts";
import { markedTemplateIntact, renderMarkedTemplate } from "../src/build/native-template-marker.ts";

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
const IOS_A11Y = "ios/App/App/DenextAccessibilityPlugin.swift";
const ANDROID_A11Y =
  "android/app/src/main/java/dev/denext/accessibility/DenextAccessibilityPlugin.java";

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
    // The web export `cap sync` copies (without it the run falls back to `cap update`).
    "out/index.html": "<!doctype html>\n",
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

// ---- accessibility ----------------------------------------------------------------------------

Deno.test("mobile add accessibility: no package; DenextAccessibility on iOS + Android, registered", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["accessibility"], cwd: dir, run });
    assertEquals(lines(), [], "no npm package, no cap sync");
    for (const path of [IOS_A11Y, ANDROID_A11Y, BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    const ios = await read(dir, IOS_A11Y);
    assert(ios.startsWith("// denext-accessibility-template: 1 sha256="));
    assertStringIncludes(ios, "UIAccessibility.voiceOverStatusDidChangeNotification");
    assertStringIncludes(ios, 'jsName = "DenextAccessibility"');
    const android = await read(dir, ANDROID_A11Y);
    assertStringIncludes(android, "addTouchExplorationStateChangeListener");
    assertStringIncludes(android, '@CapacitorPlugin(name = "DenextAccessibility")');
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["accessibility"])),
    );
    assertStringIncludes(
      await read(dir, BRIDGE),
      "registerPluginInstance(DenextAccessibilityPlugin())",
    );
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["accessibility"])),
    );
    assertStringIncludes(await read(dir, PBXPROJ), "DenextAccessibilityPlugin.swift");
    assertStringIncludes(report.plan.notes.join("\n"), "useScreenReader()");
    const again = await addMobileCapabilities({ capabilities: ["accessibility"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add accessibility + permissions: one bridge and one MainActivity, either order", async () => {
  const results: string[][] = [];
  for (const order of [["accessibility", "permissions"], ["permissions", "accessibility"]]) {
    await inProject({}, async (dir) => {
      const { run } = fakeRunner();
      for (const cap of order) await addMobileCapabilities({ capabilities: [cap], cwd: dir, run });
      results.push([await read(dir, BRIDGE), await read(dir, MAIN_ACTIVITY)]);
    });
  }
  assertEquals(results[0], results[1]);
  const [bridge, activity] = results[0];
  assertEquals(bridge, await bridgeViewControllerSource(new Set(["settings", "accessibility"])));
  assertStringIncludes(activity, "registerPlugin(DenextAccessibilityPlugin.class);");
  assertStringIncludes(activity, "registerPlugin(DenextSettingsPlugin.class);");
  const withOta = await mainActivitySource("com.example.app", new Set(["ota", "accessibility"]));
  assert(
    withOta.indexOf("DenextOta.prepare(") < withOta.indexOf("DenextAccessibilityPlugin.class"),
  );
});

Deno.test("DenextAccessibility templates: an edited file is kept, an unedited one upgraded", async () => {
  await inProject({ [INFO_PLIST]: null }, async (dir) => {
    const first = await addAccessibilityToProject({ dir });
    assert(first.written.includes(IOS_A11Y));
    await Deno.writeTextFile(join(dir, ANDROID_A11Y), "// mine\n");
    const second = await addAccessibilityToProject({ dir });
    assert(second.kept.includes(ANDROID_A11Y));
    const forced = await addAccessibilityToProject({ dir, force: true });
    assert(forced.written.includes(ANDROID_A11Y));
  });
  for (
    const [name, template] of Object.entries({
      ...ACCESSIBILITY_IOS_FILES,
      ...ACCESSIBILITY_ANDROID_FILES,
    })
  ) {
    const text = await renderAccessibilityTemplate(template);
    assertEquals(await isPristineAccessibilityTemplate(text), true, name);
    assertEquals(await isPristineAccessibilityTemplate(text + "// edit\n"), false, name);
  }
});

Deno.test("bridge: a 2.10.0 bridge is upgraded when accessibility joins; a newer one is kept", async () => {
  // 2.10.0 wrote ota generation 4 and app-extension generation 1 and knew neither settings nor
  // accessibility: this release's bridges are ahead of both, so 2.10.0 keeps them.
  assert(OTA_TEMPLATE_VERSION > 4 && APP_EXTENSION_TEMPLATE_VERSION > 1);
  const widgetsLines =
    "        // denext widgets: setWidgetData() / reloadWidgets() in denext/mobile.\n" +
    "        bridge?.registerPluginInstance(DenextWidgetsPlugin())\n";
  const shipped = await renderMarkedTemplate(
    "app-extension",
    1,
    genericBridgeViewController(widgetsLines),
  );
  await inProject({
    [BRIDGE]: shipped,
    "ios/App/App/DenextWidgetsPlugin.swift": "// widgets\n",
  }, async (dir) => {
    const report = await addAccessibilityToProject({ dir });
    assert(report.upgraded.includes(BRIDGE));
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["widgets", "accessibility"])),
    );
  });
  const newer = await renderMarkedTemplate(
    "app-extension",
    APP_EXTENSION_TEMPLATE_VERSION + 1,
    genericBridgeViewController("        // a newer denext's feature\n"),
  );
  await inProject({ [BRIDGE]: newer }, async (dir) => {
    const report = await addAccessibilityToProject({ dir });
    assert(report.kept.includes(BRIDGE));
    assertEquals(await read(dir, BRIDGE), newer, "never downgraded");
    assertStringIncludes(report.manual.join("\n"), "newer denext");
  });
});

// ---- background-location, application, camera --------------------------------------------------

Deno.test("mobile add background-location: the plugin, the keys, no background permission", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({
      capabilities: ["background-location", "background"],
      cwd: dir,
      run,
    });
    assertEquals(lines(), [
      "npm install @capgo/background-geolocation@^8.4.7 @capacitor/background-runner@^3.0.0",
      "npx cap sync",
    ]);
    const plist = await read(dir, INFO_PLIST);
    for (
      const key of [
        "NSLocationWhenInUseUsageDescription",
        "NSLocationAlwaysAndWhenInUseUsageDescription",
      ]
    ) {
      assertStringIncludes(plist, `<key>${key}</key>`);
    }
    const modes = plist.slice(plist.indexOf("<key>UIBackgroundModes</key>"));
    for (const mode of ["fetch", "processing", "location"]) {
      assertStringIncludes(modes.slice(0, modes.indexOf("</array>")), `<string>${mode}</string>`);
    }
    const manifest = await read(dir, MANIFEST);
    for (const p of ["FOREGROUND_SERVICE_LOCATION", "FOREGROUND_SERVICE", "ACCESS_FINE_LOCATION"]) {
      assertStringIncludes(manifest, `android.permission.${p}"`);
    }
    assert(!manifest.includes("ACCESS_BACKGROUND_LOCATION"), "Play reviews it; not declared");
    assert(report.written.includes(IOS_SETTINGS), "a refused Always needs openAppSettings()");
    assertStringIncludes(
      await read(dir, "ios/App/App/PrivacyInfo.xcprivacy"),
      "<string>CA92.1</string>",
    );
    const manual = report.plan.manual.join("\n");
    for (const step of ["2.5.4", "Foreground service permissions", "useLegacyBridge"]) {
      assertStringIncludes(manual, step);
    }
  });
});

Deno.test("mobile add application: @capacitor/app + @capacitor/device, each package once", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["application"], cwd: dir, run });
    assertEquals(lines(), [
      "npm install @capacitor/app@^8.1.1 @capacitor/device@^8.0.3",
      "npx cap sync",
    ]);
    const plan = await planMobileCapabilities({
      capabilities: ["restore", "device", "application", "back"],
      cwd: dir,
    });
    assertEquals(plan.install?.args, [
      "install",
      "@capacitor/app@^8.1.1",
      "@capacitor/device@^8.0.3",
    ]);
  });
});

Deno.test("mobile add camera: NSMicrophoneUsageDescription for in-page video recording", async () => {
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["camera"], cwd: dir, run });
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(plist, "<key>NSMicrophoneUsageDescription</key>");
    assertStringIncludes(plist, "<key>NSCameraUsageDescription</key>");
    assertStringIncludes(report.plan.manual.join("\n"), "RECORD_AUDIO");
  });
});

// ---- the web export before `cap sync` -----------------------------------------------------------

Deno.test("mobile add: no web export yet runs `cap update` and says what is left", async () => {
  await inProject({ "out/index.html": null }, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["dialog"], cwd: dir, run });
    assertEquals(lines(), ["npm install @capacitor/dialog@^8.0.1", "npx cap update"]);
    assertEquals(report.plan.webAssetsMissing, "out");
    const warning = report.plan.warnings.join("\n");
    assertStringIncludes(warning, "no web export at out/index.html");
    assertStringIncludes(warning, "Run `denext export`, then `npx cap sync`");
    const text = formatCapabilityPlan(report.plan);
    assertStringIncludes(text, "sync           npx cap update");
    assertStringIncludes(text, "WARNING        no web export");
  });
  // An empty folder is not an export either (cap sync wants its index.html).
  await inProject({ "out/index.html": null, "out/.keep": "" }, async (dir) => {
    const plan = await planMobileCapabilities({ capabilities: ["dialog"], cwd: dir });
    assertEquals(plan.sync?.args, ["cap", "update"]);
  });
});

Deno.test("mobile add: the web-export check follows webDir, server.url and Capacitor's default", async () => {
  const cases: Array<[Record<string, string | null>, string[], string | undefined]> = [
    // No webDir: Capacitor's default, www.
    [{ "capacitor.config.ts": "export default { appId: 'a.b' };\n" }, ["cap", "update"], "www"],
    [
      { "capacitor.config.ts": "export default { appId: 'a.b' };\n", "www/index.html": "x" },
      ["cap", "sync"],
      undefined,
    ],
    // A JSON config naming its own folder.
    [
      {
        "capacitor.config.ts": null,
        "capacitor.config.json": JSON.stringify({ appId: "a.b", webDir: "dist" }),
        "dist/index.html": "x",
      },
      ["cap", "sync"],
      undefined,
    ],
    // server.url: cap sync skips the copy check.
    [
      {
        "capacitor.config.ts":
          "export default { appId: 'a.b', webDir: 'out', server: { url: 'http://10.0.0.2:3000' } };\n",
        "out/index.html": null,
      },
      ["cap", "sync"],
      undefined,
    ],
    // A webDir computed by code: left to Capacitor.
    [
      {
        "capacitor.config.ts":
          "const d = () => 'out';\nexport default { appId: 'a.b', webDir: d() };\n",
        "out/index.html": null,
      },
      ["cap", "sync"],
      undefined,
    ],
  ];
  for (const [files, sync, missing] of cases) {
    await inProject(files, async (dir) => {
      const plan = await planMobileCapabilities({ capabilities: ["dialog"], cwd: dir });
      assertEquals(plan.sync?.args, sync, JSON.stringify(files));
      assertEquals(plan.webAssetsMissing, missing);
    });
  }
});
