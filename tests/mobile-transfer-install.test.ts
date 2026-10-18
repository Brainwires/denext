// `denext mobile add file-transfer` (src/build/mobile-transfer-install.ts): the DenextTransfer
// plugin on iOS and Android, registered through the shared bridge view controller and
// MainActivity, AppDelegate forwarding the background session's events, and WorkManager in the
// app's dependencies; no npm package. Running it twice changes nothing.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addMobileCapabilities, type CommandRunner } from "../src/build/mobile-capabilities.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import { withAppDelegateBackgroundTransfers } from "../src/build/mobile-native-config.ts";
import {
  isPristineTransferTemplate,
  WORK_RUNTIME_DEPENDENCY,
} from "../src/build/transfer-native-templates.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const GRADLE = "android/app/build.gradle";
const IOS = ["DenextTransferManager.swift", "DenextTransferPlugin.swift"];
const ANDROID = [
  "DenextTransferHttp.java",
  "DenextTransferPlugin.java",
  "DenextTransferStore.java",
  "DenextTransferWorker.java",
];

const STOCK_APP_DELEGATE = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }
}
`;

async function inProject(fn: (dir: string) => Promise<void>, gradle = true): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_transfer_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    [APP_DELEGATE]: STOCK_APP_DELEGATE,
    "ios/App/App/Info.plist":
      '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n',
    "android/app/src/main/AndroidManifest.xml": "<manifest><application/></manifest>\n",
    [MAIN_ACTIVITY]: "package com.example.app;\n\nimport com.getcapacitor.BridgeActivity;\n\n" +
      "public class MainActivity extends BridgeActivity {}\n",
  };
  if (gradle) {
    files[GRADLE] = "apply plugin: 'com.android.application'\n\ndependencies {\n" +
      "    implementation project(':capacitor-android')\n}\n";
  }
  try {
    for (const [path, content] of Object.entries(files)) {
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const run: CommandRunner = () => Promise.resolve({ code: 0 });
const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

Deno.test("mobile add file-transfer: DenextTransfer on iOS + Android, registered, WorkManager, idempotent", async () => {
  await inProject(async (dir) => {
    const report = await addMobileCapabilities({ capabilities: ["file-transfer"], cwd: dir, run });
    const ios = IOS.map((f) => `ios/App/App/${f}`);
    const android = ANDROID.map((f) => `android/app/src/main/java/dev/denext/transfer/${f}`);
    for (const path of [...ios, ...android, BRIDGE, MAIN_ACTIVITY, PBXPROJ, APP_DELEGATE, GRADLE]) {
      assert(report.written.includes(path), path);
    }
    for (const path of [...ios, ...android]) {
      assert((await read(dir, path)).startsWith("// denext-transfer-template: 1 sha256="), path);
    }
    assertStringIncludes(await read(dir, ios[1]), 'jsName = "DenextTransfer"');
    assertStringIncludes(await read(dir, ios[0]), "URLSessionConfiguration.background");
    assertStringIncludes(await read(dir, android[1]), '@CapacitorPlugin(name = "DenextTransfer")');
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["file-transfer"])),
    );
    assertStringIncludes(await read(dir, BRIDGE), "registerPluginInstance(DenextTransferPlugin())");
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["file-transfer"])),
    );
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "registerPlugin(DenextTransferPlugin.class);",
    );
    const pbxproj = await read(dir, PBXPROJ);
    for (const f of IOS) assertStringIncludes(pbxproj, f);
    assertStringIncludes(await read(dir, GRADLE), WORK_RUNTIME_DEPENDENCY);
    assertStringIncludes(
      await read(dir, APP_DELEGATE),
      "DenextTransferManager.handleEvents(forBackgroundURLSession: identifier",
    );
    assertStringIncludes(report.plan.notes.join("\n"), "downloadToFile / uploadFile");
    const again = await addMobileCapabilities({ capabilities: ["file-transfer"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add file-transfer: no app build.gradle dependencies block is a manual step", async () => {
  await inProject(async (dir) => {
    const report = await addMobileCapabilities({ capabilities: ["file-transfer"], cwd: dir, run });
    assert(
      report.manual.some((m) => m.includes(WORK_RUNTIME_DEPENDENCY)),
      report.manual.join("\n"),
    );
  }, false);
});

Deno.test("withAppDelegateBackgroundTransfers: appends once; an app's own handler is left alone", () => {
  const edited = withAppDelegateBackgroundTransfers(STOCK_APP_DELEGATE);
  assert(edited !== null);
  assertStringIncludes(
    edited,
    "    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {\n" +
      "        if !DenextTransferManager.handleEvents(forBackgroundURLSession: identifier, completionHandler: completionHandler) {\n" +
      "            completionHandler()\n",
  );
  assertEquals(withAppDelegateBackgroundTransfers(edited), edited);
  const own = STOCK_APP_DELEGATE.replace(
    "var window: UIWindow?",
    "var window: UIWindow?\n    func application(_ a: UIApplication, handleEventsForBackgroundURLSession i: String, completionHandler: @escaping () -> Void) {}",
  );
  assertEquals(withAppDelegateBackgroundTransfers(own), null);
  assertEquals(withAppDelegateBackgroundTransfers("struct Nothing {}"), null);
});

Deno.test("mobile add file-transfer: an edited template is kept, an unedited one recognised", async () => {
  await inProject(async (dir) => {
    await addMobileCapabilities({ capabilities: ["file-transfer"], cwd: dir, run });
    const worker = "android/app/src/main/java/dev/denext/transfer/DenextTransferWorker.java";
    const manager = "ios/App/App/DenextTransferManager.swift";
    assert(await isPristineTransferTemplate(await read(dir, manager)));
    const edited = (await read(dir, worker)) + "\n// local change\n";
    await Deno.writeTextFile(join(dir, worker), edited);
    assertEquals(await isPristineTransferTemplate(edited), false);
    const again = await addMobileCapabilities({ capabilities: ["file-transfer"], cwd: dir, run });
    assert(
      again.manual.some((m) => m.includes("DenextTransferWorker.java")),
      again.manual.join("\n"),
    );
    assertEquals(await read(dir, worker), edited);
  });
});
