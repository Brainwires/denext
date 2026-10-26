// Capacitor's `ios.path` / `android.path` (src/build/capacitor-native-dirs.ts): a project whose
// native shells live outside the default `ios/` and `android/` is read and edited where they
// are by `denext mobile add | build | doctor | assets | privacy | fingerprint`. The fixture keeps
// them under `native/`; nothing may appear under a default `ios/` or `android/` folder.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_NATIVE_DIRS,
  loadNativeDirs,
  nativeJoin,
  nativeRel,
  nativeText,
} from "../src/build/capacitor-native-dirs.ts";
import { CAPACITOR_BUILD_IGNORES } from "../src/build/capacitor-pins.ts";
import { capacitorIgnoresFor } from "../packages/migrate/src/migrate-capacitor.ts";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  planMobileCapabilities,
} from "../src/build/mobile-capabilities.ts";
import { generateMobileAssets } from "../src/build/mobile-assets.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";
import { privacyEntriesFor, writePrivacyManifests } from "../src/build/mobile-privacy.ts";
import {
  computeNativeFingerprint,
  NATIVE_FINGERPRINT_INFO_KEY,
  writeNativeFingerprint,
} from "../src/build/mobile-fingerprint.ts";
import { planMobileBuild } from "../src/build/mobile-build.ts";
import { encodePng, solid } from "../src/build/png-raster.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>
</plist>
`;

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:usesCleartextTraffic="true" android:label="@string/app_name">
    </application>
</manifest>
`;

const GRADLE = `android {
    namespace = "dev.example"
    defaultConfig {
        applicationId "dev.example"
        versionCode 7
        versionName "1.4"
    }
}
`;

const CONFIG_TS = `import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.example",
  appName: "Example",
  webDir: "out",
  ios: { path: "native/ios" },
  android: { path: "./native/android/" },
};

export default config;
`;

/** A Capacitor 8 project with its shells under `native/`; `files` adds or overrides. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_dirs_" });
  const all: Record<string, string> = {
    "capacitor.config.ts": CONFIG_TS,
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    "native/ios/App/App/Info.plist": INFO_PLIST,
    "native/ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    "native/android/app/src/main/AndroidManifest.xml": MANIFEST,
    "native/android/app/build.gradle": GRADLE,
    ".git/HEAD": "ref: refs/heads/main\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Nothing was written under the default `ios/` or `android/` folders. */
async function assertNoDefaultDirs(dir: string): Promise<void> {
  assertFalse(await exists(join(dir, "ios")), "nothing under ios/");
  assertFalse(await exists(join(dir, "android")), "nothing under android/");
}

const noRun: CommandRunner = () => Promise.resolve({ code: 0 });

Deno.test("native dirs: ios.path / android.path from a TS or JSON config, else the defaults", async () => {
  const dir = await project();
  try {
    assertEquals(await loadNativeDirs(dir), { ios: "native/ios", android: "native/android" });
    assertEquals(nativeRel(dir, "ios/App/App/Info.plist"), "native/ios/App/App/Info.plist");
    assertEquals(nativeRel(dir, "android"), "native/android");
    assertEquals(nativeRel(dir, "iosfoo/x"), "iosfoo/x", "only a whole first segment maps");
    assertEquals(nativeRel(dir, "package.json"), "package.json");
    assertEquals(
      nativeJoin(dir, "ios", "App", "Podfile"),
      join(dir, "native", "ios", "App", "Podfile"),
    );

    await Deno.remove(join(dir, "capacitor.config.ts"));
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "dev.example", ios: { path: "shells\\apple" } }),
    );
    assertEquals(await loadNativeDirs(dir), { ios: "shells/apple", android: "android" });

    // A path outside the project (absolute, or climbing out) is not followed.
    for (const path of ["/abs/ios", "../elsewhere", "a/../../b", "C:/ios", ""]) {
      await Deno.writeTextFile(
        join(dir, "capacitor.config.json"),
        JSON.stringify({ ios: { path }, android: { path: 3 } }),
      );
      assertEquals(await loadNativeDirs(dir), DEFAULT_NATIVE_DIRS, path);
    }

    await Deno.remove(join(dir, "capacitor.config.json"));
    assertEquals(await loadNativeDirs(dir), DEFAULT_NATIVE_DIRS);
    assertEquals(nativeRel(dir, "ios/App"), "ios/App");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile add edits the Info.plist under ios.path", async () => {
  const dir = await project();
  try {
    const report = await addMobileCapabilities({ capabilities: ["barcode"], cwd: dir, run: noRun });
    assert(report.written.includes("native/ios/App/App/Info.plist"), report.written.join(", "));
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "native/ios/App/App/Info.plist")),
      "<key>NSCameraUsageDescription</key>",
    );
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile doctor reads the shells under ios.path / android.path", async () => {
  const dir = await project();
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    const messages = report.findings.map((f) => f.message);
    assert(
      messages.some((m) => m.startsWith("native/ios/App/App/Info.plist: App Transport Security")),
      messages.join("\n"),
    );
    assert(
      messages.some((m) => m.startsWith("native/android/app/src/main/AndroidManifest.xml:")),
      messages.join("\n"),
    );
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile assets writes the icon sets under ios.path / android.path", async () => {
  const dir = await project();
  try {
    await Deno.writeFile(
      join(dir, "icon.png"),
      await encodePng(solid(64, 64, { r: 9, g: 9, b: 9 })),
    );
    const written = await generateMobileAssets(dir, {
      icon: join(dir, "icon.png"),
      background: { r: 0, g: 0, b: 0 },
    }, {
      kinds: ["icon"],
    });
    assertEquals(written.platforms, ["ios", "android"]);
    assert(
      await exists(
        join(dir, "native/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
      ),
    );
    assert(await exists(join(dir, "native/android/app/src/main/res/mipmap-mdpi/ic_launcher.png")));
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile privacy writes the manifest under ios.path", async () => {
  const dir = await project();
  try {
    const report = await writePrivacyManifests(dir, privacyEntriesFor(["filesystem"]));
    assertEquals(report.written, [
      "native/ios/App/App/PrivacyInfo.xcprivacy",
      "native/ios/App/App.xcodeproj/project.pbxproj",
    ]);
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "native/ios/App/App/PrivacyInfo.xcprivacy")),
      "C617.1",
    );
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile fingerprint hashes and stamps the shells under ios.path", async () => {
  const dir = await project();
  try {
    const first = await computeNativeFingerprint(dir);
    const paths = first.inputs.flatMap((i) => i.kind === "file" ? [i.path] : []);
    // Inputs keep Capacitor's default names, so moving the shells alone changes nothing.
    assert(paths.includes("ios/App/App/Info.plist"), paths.join(", "));
    assert(paths.includes("android/app/build.gradle"), paths.join(", "));

    await Deno.writeTextFile(join(dir, "native/android/app/build.gradle"), GRADLE + "\n// x\n");
    assert((await computeNativeFingerprint(dir)).fingerprint !== first.fingerprint);

    await writeNativeFingerprint(dir);
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "native/ios/App/App/Info.plist")),
      NATIVE_FINGERPRINT_INFO_KEY,
    );
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile build plans Gradle in android.path", async () => {
  const dir = await project();
  try {
    const plan = await planMobileBuild({
      root: dir,
      appDir: dir,
      platform: "android",
      cli: ["run", "-A", "cli.ts"],
      deno: "deno",
      skipExport: true,
    });
    assertEquals(plan.version, "1.4");
    assertEquals(plan.buildNumber, 7);
    const gradle = plan.commands.at(-1)!;
    assertEquals(gradle.cwd, join(dir, "native/android"));
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: nativeText moves default-layout paths in a message, nothing else", async () => {
  const dir = await project();
  try {
    await loadNativeDirs(dir);
    assertEquals(
      nativeText(dir, "ios/App/App/Info.plist: set NSSupportsLiveActivities to YES."),
      "native/ios/App/App/Info.plist: set NSSupportsLiveActivities to YES.",
    );
    assertEquals(
      nativeText(dir, "no ios/ or android/ project found; see `android/app/build.gradle`"),
      "no native/ios/ or native/android/ project found; see `native/android/app/build.gradle`",
    );
    // Already in the project's layout, a package name, another word, or no path: unchanged.
    for (
      const text of [
        "native/ios/App/App/Info.plist",
        "@capacitor/ios and @capacitor/android",
        "my-ios/x, ios.path, android:name, ./ios/x",
        "run `npx cap add ios` first",
      ]
    ) assertEquals(nativeText(dir, text), text);

    await Deno.remove(join(dir, "capacitor.config.ts"));
    await loadNativeDirs(dir);
    assertEquals(nativeText(dir, "ios/App/App/Info.plist"), "ios/App/App/Info.plist");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: mobile add names the project's paths in its warnings and steps", async () => {
  const dir = await project();
  try {
    const plan = await planMobileCapabilities({ capabilities: ["push"], cwd: dir });
    const lines = [...plan.warnings, ...plan.manual, ...plan.notes];
    assert(
      plan.warnings.some((w) => w.includes("no native/android/app/google-services.json")),
      plan.warnings.join("\n"),
    );
    assert(
      plan.manual.some((m) => m.includes("point the App target at native/ios/App/")),
      plan.manual.join("\n"),
    );
    const printed = formatCapabilityPlan(plan);
    assertStringIncludes(printed, "(native/ios/App/App/App.entitlements)");
    for (const line of [...lines, ...printed.split("\n")]) {
      assertFalse(/(?<![\w./@-])(?:ios|android)\//.test(line), `default path in: ${line}`);
    }

    const report = await addMobileCapabilities({ capabilities: ["push"], cwd: dir, run: noRun });
    for (const line of [...report.manual, ...report.skipped, ...report.plan.manual]) {
      assertFalse(/(?<![\w./@-])(?:ios|android)\//.test(line), `default path in: ${line}`);
    }
    // The entitlements file was written where Capacitor looks, not under a default ios/.
    assert(await exists(join(dir, "native/ios/App/App/App.entitlements")));
    await assertNoDefaultDirs(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: the doctor's source scan skips the shells under ios.path / android.path", async () => {
  const dir = await project({
    "native/ios/App/App/public/assets/app.js": "localStorage.setItem('a', '1');\n",
    "native/android/app/src/main/assets/public/app.js": "localStorage.getItem('a');\n",
    "src/ios/storage.ts": "export const kept = () => localStorage.getItem('b');\n",
  });
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    const storage = report.findings.find((f) => f.check === "web-storage");
    assert(storage, report.findings.map((f) => f.check).join(", "));
    // Only the app's own source is listed; the native folders (and their copied export) are not.
    assert(storage.message.startsWith("src/ios/storage.ts keep data in"), storage.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native dirs: migrate's .gitignore lines follow ios.path / android.path", async () => {
  const dir = await project();
  try {
    assertEquals(await capacitorIgnoresFor(dir), [
      "native/ios/App/App/public/",
      "native/ios/App/build/",
      "native/ios/DerivedData/",
      "native/android/app/src/main/assets/public/",
      "native/android/app/build/",
      "native/android/build/",
      "native/android/.gradle/",
    ]);
    await Deno.remove(join(dir, "capacitor.config.ts"));
    assertEquals(await capacitorIgnoresFor(dir), [...CAPACITOR_BUILD_IGNORES]);
    assert(CAPACITOR_BUILD_IGNORES.includes("ios/App/App/public/"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
