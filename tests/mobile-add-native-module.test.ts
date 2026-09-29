// `denext mobile add native-module --name <Name>` (src/build/mobile-native-module.ts + the
// capability in src/build/mobile-capabilities.ts): writes the app's own Capacitor plugin (Swift
// + Kotlin), registers it through DenextNativeModules from the shared bridge view controller and
// MainActivity, wires Kotlin into the Gradle build, writes the typed client, keeps edited
// files, and is idempotent.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addNativeModulesToProject,
  checkNativeModuleNames,
  withKotlinAndroid,
  withKotlinClasspath,
} from "../src/build/mobile-native-module.ts";
import { addAuthSessionToProject } from "../src/build/mobile-auth-session-install.ts";
import { KOTLIN_VERSION, REGISTRAR_ANCHOR } from "../src/build/native-module-native-templates.ts";
import { addMobileCapabilities, formatCapabilityPlan } from "../src/build/mobile-capabilities.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

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

const STOCK_MAIN_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

const ROOT_GRADLE_TEXT = `buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath 'com.google.gms:google-services:4.4.4'
    }
}

apply from: "variables.gradle"
`;

const APP_GRADLE_TEXT = `apply plugin: 'com.android.application'

android {
    namespace = "com.example.app"
}

apply from: 'capacitor.build.gradle'
`;

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const REGISTRAR_IOS = "ios/App/App/DenextNativeModules.swift";
const ANDROID_DIR = "android/app/src/main/java/dev/denext/nativemodules";
const REGISTRAR_ANDROID = `${ANDROID_DIR}/DenextNativeModules.java`;
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const ROOT_GRADLE = "android/build.gradle";
const APP_GRADLE = "android/app/build.gradle";

/** A stock Capacitor 8 project with ios/ and android/. */
async function project(extra: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_add_native_module_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'dev.example', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift":
      "import UIKit\nimport Capacitor\nlet root = CAPBridgeViewController()\n",
    [MAIN_ACTIVITY]: STOCK_MAIN_ACTIVITY,
    [ROOT_GRADLE]: ROOT_GRADLE_TEXT,
    [APP_GRADLE]: APP_GRADLE_TEXT,
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  return dir;
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));

let ids = 0;
const randomId = () => (0xABC000000000000000000000n + BigInt(++ids)).toString(16).toUpperCase();

Deno.test("add native-module: writes the plugin, registrars, client, Kotlin wiring; registers it", async () => {
  const dir = await project();
  try {
    const report = await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    assertEquals(report.manual, []);
    assertEquals(report.kept, []);

    const swift = await read(dir, "ios/App/App/ScannerPlugin.swift");
    assertStringIncludes(swift, 'public let jsName = "Scanner"');
    assertStringIncludes(
      swift,
      'CAPPluginMethod(name: "echo", returnType: CAPPluginReturnPromise)',
    );
    assertStringIncludes(swift, 'notifyListeners("echoed"');
    assert(swift.startsWith("// denext-native-module-template: 1 sha256="));

    const registrar = await read(dir, REGISTRAR_IOS);
    assertStringIncludes(registrar, "bridge?.registerPluginInstance(ScannerPlugin())");
    assertStringIncludes(registrar, REGISTRAR_ANCHOR);
    assertStringIncludes(await read(dir, BRIDGE), "DenextNativeModules.register(bridge)");
    const pbx = await read(dir, PBXPROJ);
    for (
      const f of [
        "ScannerPlugin.swift",
        "DenextNativeModules.swift",
        "DenextBridgeViewController.swift",
      ]
    ) {
      assertStringIncludes(pbx, `${f} in Sources`);
    }
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController"',
    );

    const kotlin = await read(dir, `${ANDROID_DIR}/ScannerPlugin.kt`);
    assertStringIncludes(kotlin, '@CapacitorPlugin(name = "Scanner")');
    assertStringIncludes(kotlin, "class ScannerPlugin : Plugin()");
    assertStringIncludes(
      await read(dir, REGISTRAR_ANDROID),
      "activity.registerPlugin(ScannerPlugin.class);",
    );
    const activity = await read(dir, MAIN_ACTIVITY);
    assertStringIncludes(activity, "import dev.denext.nativemodules.DenextNativeModules;");
    assert(
      activity.indexOf("DenextNativeModules.register(this);") <
        activity.indexOf("super.onCreate(savedInstanceState);"),
      "registered before the bridge is built",
    );
    assertStringIncludes(
      await read(dir, ROOT_GRADLE),
      `classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}"`,
    );
    const appGradle = await read(dir, APP_GRADLE);
    assertStringIncludes(
      appGradle,
      "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'\n",
    );
    assertStringIncludes(appGradle, "JvmTarget.fromTarget(");

    const client = await read(dir, "native/NativeScanner.ts");
    assertStringIncludes(client, 'import { nativeModule } from "denext/mobile";');
    assertStringIncludes(client, 'nativeModule<Spec, Events>("Scanner", { calls: "positional" })');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add native-module: idempotent; a second module joins the registrars", async () => {
  const dir = await project();
  try {
    await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    const again = await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    assertEquals(again.written, [], "a second run writes nothing");
    await addNativeModulesToProject({ dir, names: ["Payments"], randomId });
    const registrar = await read(dir, REGISTRAR_IOS);
    assertStringIncludes(registrar, "ScannerPlugin()");
    assertStringIncludes(registrar, "PaymentsPlugin()");
    assert(registrar.indexOf("PaymentsPlugin()") < registrar.indexOf(REGISTRAR_ANCHOR));
    const java = await read(dir, REGISTRAR_ANDROID);
    assertStringIncludes(java, "ScannerPlugin.class");
    assertStringIncludes(java, "PaymentsPlugin.class");
    const appGradle = await read(dir, APP_GRADLE);
    assertEquals(appGradle.split("org.jetbrains.kotlin.android").length, 2, "applied once");
    assertEquals(appGradle.split("KotlinCompile").length, 2, "one JVM target block");
    const pbx = await read(dir, PBXPROJ);
    assertEquals(pbx.split("DenextNativeModules.swift in Sources */ = {").length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add native-module: an edited plugin is kept; composes with another denext plugin", async () => {
  const dir = await project();
  try {
    await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    const swift = join(dir, "ios/App/App/ScannerPlugin.swift");
    await Deno.writeTextFile(swift, (await Deno.readTextFile(swift)) + "// mine\n");
    const report = await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    assertEquals(report.kept, ["ios/App/App/ScannerPlugin.swift"]);
    assertStringIncludes(await Deno.readTextFile(swift), "// mine");

    // Another denext plugin recomposes the shared bridge and MainActivity with both.
    const auth = await addAuthSessionToProject({ dir, randomId });
    assertEquals(auth.manual, []);
    const bridge = await read(dir, BRIDGE);
    assertStringIncludes(bridge, "DenextAuthSessionPlugin()");
    assertStringIncludes(bridge, "DenextNativeModules.register(bridge)");
    const activity = await read(dir, MAIN_ACTIVITY);
    assertStringIncludes(activity, "DenextNativeModules.register(this);");
    assertStringIncludes(activity, "registerPlugin(DenextAuthSessionPlugin.class);");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add native-module: a registrar without its anchor becomes a manual step", async () => {
  const dir = await project({
    [REGISTRAR_IOS]: "enum DenextNativeModules { static func register(_ b: Any?) {} }\n",
  });
  try {
    const report = await addNativeModulesToProject({ dir, names: ["Scanner"], randomId });
    assert(
      report.manual.some((m) => m.includes("bridge?.registerPluginInstance(ScannerPlugin())")),
      report.manual.join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add native-module: Gradle edits", () => {
  assertEquals(withKotlinClasspath("buildscript {}\n"), null, "no AGP classpath: manual");
  const root = withKotlinClasspath(ROOT_GRADLE_TEXT)!;
  assertStringIncludes(
    root,
    "classpath 'com.android.tools.build:gradle:8.13.0'\n        classpath \"org.jetbrains.kotlin:kotlin-gradle-plugin:",
  );
  assertEquals(withKotlinClasspath(root), root, "idempotent");
  assertEquals(withKotlinAndroid("android {}\n"), null, "no application plugin: manual");
  const app = withKotlinAndroid(APP_GRADLE_TEXT)!;
  assertEquals(withKotlinAndroid(app), app, "idempotent");
  const kotlinAlready = "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'\n";
  assertEquals(withKotlinAndroid(kotlinAlready)!.split("kotlin-android").length, 2);
});

Deno.test("add native-module: names are PascalCase and not denext's own", () => {
  assertEquals(checkNativeModuleNames(["Scanner", "Scanner", "Pay2"]), ["Scanner", "Pay2"]);
  for (const bad of [[], ["scanner"], ["Scan-ner"], ["DenextThing"]]) {
    let threw = false;
    try {
      checkNativeModuleNames(bad);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(bad));
  }
});

Deno.test("add native-module: the capability plans the install and runs it without npm", async () => {
  const dir = await project();
  try {
    const dry = await addMobileCapabilities({
      capabilities: ["native-module"],
      cwd: dir,
      dryRun: true,
      names: ["Scanner"],
    });
    assertEquals(dry.plan.install, undefined, "no npm package");
    assertStringIncludes(formatCapabilityPlan(dry.plan), "native module Scanner");
    await assertRejects(
      () => Deno.stat(join(dir, "native/NativeScanner.ts")),
      Deno.errors.NotFound,
      undefined,
      "a dry run writes nothing",
    );
    const ran: string[] = [];
    const report = await addMobileCapabilities({
      capabilities: ["native-module"],
      cwd: dir,
      names: ["Scanner"],
      run: ({ cmd, args }) => {
        ran.push([cmd, ...args].join(" "));
        return Promise.resolve({ code: 0 });
      },
    });
    assertEquals(ran, [], "no install, no cap sync");
    assert(report.written.includes("native/NativeScanner.ts"), report.written.join("\n"));
    await assertRejects(
      () =>
        addMobileCapabilities({
          capabilities: ["native-module"],
          cwd: dir,
          dryRun: true,
          names: [],
        }),
      Error,
      "--name",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
