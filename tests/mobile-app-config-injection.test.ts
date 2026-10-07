// `denext mobile add app-config` reads an Expo app config that may come from someone else's
// repository, so nothing in it may reach a native project file as markup or build settings: an
// Info.plist key, an Android permission and the iOS deployment target are validated (a rejected
// one is a `manual` item with the reason, never written), and the shared writers in
// src/build/mobile-native-config.ts refuse (null) a key, name or permission that could inject.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  addExpoAppConfigToProject,
  withDeploymentTargetAtLeast,
  withGradleSdkAtLeast,
} from "../src/build/mobile-expo-app-config.ts";
import {
  manifestMetaDataValue,
  withManifestApplicationAttribute,
  withManifestMetaData,
  withManifestPermission,
  withPlistDefault,
  withPlistDictTrue,
  withPlistString,
  withPlistStringArray,
  withPlistTrue,
} from "../src/build/mobile-native-config.ts";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
</dict>
</plist>
`;

const ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name">
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

/** A plist key ending in `UsageDescription` that closes the key and adds an ATS exception. */
const PLIST_KEY_INJECTION = "X</key><string>a</string><key>NSAppTransportSecurity</key><dict>" +
  "<key>NSAllowsArbitraryLoads</key><true/></dict><key>NSCameraUsageDescription";

/** A permission that closes the element and declares another one. */
const PERMISSION_INJECTION =
  'android.permission.CAMERA" /><uses-permission android:name="android.permission.READ_SMS';

/** A deployment target that ends the setting and adds another build setting. */
const TARGET_INJECTION = '99.0;\n\t\t\t\tEVIL_SETTING = "-force_load /tmp/evil.a"';

/** Write `files` under a fresh temp dir and run `fn` on it. */
async function withApp(
  files: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_app_config_inj_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The native projects of a Capacitor 8 shell. */
async function shell(): Promise<Record<string, string>> {
  return {
    "ios/App/App/Info.plist": INFO_PLIST,
    "ios/App/App.xcodeproj/project.pbxproj": await Deno.readTextFile(
      new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
    ),
    "android/app/src/main/AndroidManifest.xml": ANDROID_MANIFEST,
  };
}

Deno.test("mobile add app-config: an Info.plist key that would inject is reported, never written", async () => {
  await withApp({
    "app.json": {
      expo: {
        ios: {
          infoPlist: {
            [PLIST_KEY_INJECTION]: "x",
            NSContactsUsageDescription: "Find friends",
          },
        },
      },
    },
    ...(await shell()),
  }, async (dir) => {
    const report = await addExpoAppConfigToProject({ dir });
    const plist = await Deno.readTextFile(join(dir, "ios/App/App/Info.plist"));
    assert(!plist.includes("NSAppTransportSecurity"), plist);
    assert(!plist.includes("<true/>"), plist);
    assert(!plist.includes("NSCameraUsageDescription"), plist);
    // The valid key next to it is still carried.
    assertStringIncludes(plist, "<key>NSContactsUsageDescription</key>\n\t<string>Find friends");
    const manual = report.manual.join("\n");
    assertStringIncludes(manual, "not a valid Info.plist key");
    assertStringIncludes(manual, "not written");
  });
});

Deno.test("mobile add app-config: an Android permission that would inject is reported, never written", async () => {
  await withApp({
    "app.json": { expo: { android: { permissions: [PERMISSION_INJECTION, "READ_CONTACTS"] } } },
    ...(await shell()),
  }, async (dir) => {
    const report = await addExpoAppConfigToProject({ dir });
    const manifest = await Deno.readTextFile(join(dir, "android/app/src/main/AndroidManifest.xml"));
    assert(!manifest.includes("READ_SMS"), manifest);
    assert(!manifest.includes("permission.CAMERA"), manifest);
    assertStringIncludes(
      manifest,
      '<uses-permission android:name="android.permission.READ_CONTACTS" />',
    );
    assertStringIncludes(report.manual.join("\n"), "not a valid Android permission name");
  });
});

Deno.test("mobile add app-config: a permission with regex syntax is reported, not a crash", async () => {
  await withApp({
    "app.json": { expo: { android: { permissions: ["android.permission.CAMERA("] } } },
    ...(await shell()),
  }, async (dir) => {
    const report = await addExpoAppConfigToProject({ dir });
    const manifest = await Deno.readTextFile(join(dir, "android/app/src/main/AndroidManifest.xml"));
    assertEquals(manifest, ANDROID_MANIFEST);
    assertStringIncludes(report.manual.join("\n"), "not a valid Android permission name");
  });
});

Deno.test("mobile add app-config: a deployment target that would inject a build setting is reported, never written", async () => {
  const files = await shell();
  await withApp({
    "app.json": {
      expo: {
        plugins: [["expo-build-properties", { ios: { deploymentTarget: TARGET_INJECTION } }]],
      },
    },
    ...files,
  }, async (dir) => {
    const report = await addExpoAppConfigToProject({ dir });
    const project = await Deno.readTextFile(join(dir, "ios/App/App.xcodeproj/project.pbxproj"));
    assert(!project.includes("EVIL_SETTING"), "no injected build setting");
    assertEquals(project, files["ios/App/App.xcodeproj/project.pbxproj"]);
    assertStringIncludes(report.manual.join("\n"), "not a version");
  });
});

Deno.test("native config writers: a key, name or permission that could inject is refused (null)", () => {
  const evilKey = "K</key><true/><key>L";
  assertEquals(withPlistString(INFO_PLIST, evilKey, "v", false), null);
  assertEquals(withPlistString(INFO_PLIST, evilKey, "v", true), null);
  assertEquals(withPlistDefault(INFO_PLIST, evilKey, "v"), null);
  assertEquals(withPlistStringArray(INFO_PLIST, evilKey, ["v"]), null);
  assertEquals(withPlistDictTrue(INFO_PLIST, evilKey, "NSAllowsLocalNetworking"), null);
  assertEquals(withPlistDictTrue(INFO_PLIST, "NSAppTransportSecurity", evilKey), null);
  assertEquals(withPlistTrue(INFO_PLIST, evilKey), null);
  assertEquals(withManifestPermission(ANDROID_MANIFEST, PERMISSION_INJECTION), null);
  assertEquals(withManifestPermission(ANDROID_MANIFEST, "a.b("), null);
  assertEquals(withManifestMetaData(ANDROID_MANIFEST, 'n" android:value="x', "v"), null);
  assertEquals(manifestMetaDataValue(ANDROID_MANIFEST, "a.b("), undefined);
  assertEquals(
    withManifestApplicationAttribute(ANDROID_MANIFEST, 'a="1" android:debuggable', "true"),
    null,
  );
  const pbx = "IPHONEOS_DEPLOYMENT_TARGET = 15.0;\n";
  assertEquals(withDeploymentTargetAtLeast(pbx, TARGET_INJECTION), null);
  assertEquals(withDeploymentTargetAtLeast(pbx, "16"), "IPHONEOS_DEPLOYMENT_TARGET = 16;\n");
  assertEquals(withGradleSdkAtLeast("ext { minSdkVersion = 24 }", "minSdkVersion|x", 26), null);
  // Valid names still work, a dotted permission included (the `.` matched literally).
  assertStringIncludes(
    withManifestPermission(ANDROID_MANIFEST, "com.example.permission.C2D_MESSAGE") ?? "",
    '<uses-permission android:name="com.example.permission.C2D_MESSAGE" />',
  );
  assertStringIncludes(
    withPlistString(INFO_PLIST, "com.apple.developer.team-identifier", "T", false) ?? "",
    "<key>com.apple.developer.team-identifier</key>",
  );
});
