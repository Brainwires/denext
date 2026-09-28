// `denext mobile add storage` (src/build/mobile-storage-install.ts): the DenextStorage plugin on
// iOS and Android, registered through the shared bridge view controller and MainActivity, with
// no npm package; the templates follow the JS contract src/mobile/kv-store.ts calls.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addMobileCapabilities, type CommandRunner } from "../src/build/mobile-capabilities.ts";
import { addStorageToProject } from "../src/build/mobile-storage-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import { STORAGE_ANDROID_FILES, STORAGE_IOS_FILES } from "../src/build/storage-native-templates.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS = "ios/App/App/DenextStoragePlugin.swift";
const ANDROID = "android/app/src/main/java/dev/denext/storage/DenextStoragePlugin.java";

async function inProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_storage_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Info.plist":
      '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n</dict>\n</plist>\n',
    "android/app/src/main/AndroidManifest.xml": "<manifest><application/></manifest>\n",
    [MAIN_ACTIVITY]: "package com.example.app;\n\nimport com.getcapacitor.BridgeActivity;\n\n" +
      "public class MainActivity extends BridgeActivity {}\n",
  };
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

Deno.test("mobile add storage: DenextStorage on iOS + Android, registered, idempotent", async () => {
  await inProject(async (dir) => {
    const report = await addMobileCapabilities({ capabilities: ["storage"], cwd: dir, run });
    for (const path of [IOS, ANDROID, BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    const ios = await read(dir, IOS);
    assert(ios.startsWith("// denext-storage-template: 1 sha256="));
    assertStringIncludes(ios, 'jsName = "DenextStorage"');
    assertStringIncludes(ios, "import SQLite3");
    const android = await read(dir, ANDROID);
    assertStringIncludes(android, '@CapacitorPlugin(name = "DenextStorage")');
    assertEquals(await read(dir, BRIDGE), await bridgeViewControllerSource(new Set(["storage"])));
    assertStringIncludes(await read(dir, BRIDGE), "registerPluginInstance(DenextStoragePlugin())");
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["storage"])),
    );
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "registerPlugin(DenextStoragePlugin.class);",
    );
    assertStringIncludes(await read(dir, PBXPROJ), "DenextStoragePlugin.swift");
    assertStringIncludes(report.plan.notes.join("\n"), "openKeyValueStore");
    const again = await addMobileCapabilities({ capabilities: ["storage"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("DenextStorage templates: every method kv-store.ts calls, on both platforms", () => {
  const ios = STORAGE_IOS_FILES["DenextStoragePlugin.swift"];
  const android = STORAGE_ANDROID_FILES["DenextStoragePlugin.java"];
  for (const method of ["getMany", "setMany", "removeMany", "keys", "clear"]) {
    assertStringIncludes(ios, `CAPPluginMethod(name: "${method}"`);
    assertStringIncludes(ios, `@objc func ${method}(_ call: CAPPluginCall)`);
    assertStringIncludes(android, `public void ${method}(PluginCall call)`);
  }
  // The same table and answers as the JS side's SQL driver.
  for (const text of [ios, android]) {
    assertStringIncludes(text, "PRIMARY KEY (store, key)) WITHOUT ROWID");
    assertStringIncludes(text, '"values"');
    assertStringIncludes(text, '"keys"');
    assertStringIncludes(text, "STORAGE_ERROR");
  }
  assertStringIncludes(ios, ".applicationSupportDirectory");
  assertStringIncludes(android, '"denext-kv.db"');
});

Deno.test("DenextStorage: an edited file is kept, forced over, and the install is idempotent", async () => {
  await inProject(async (dir) => {
    const first = await addStorageToProject({ dir });
    assert(first.written.includes(IOS));
    await Deno.writeTextFile(join(dir, ANDROID), "// mine\n");
    const second = await addStorageToProject({ dir });
    assert(second.kept.includes(ANDROID));
    const forced = await addStorageToProject({ dir, force: true });
    assert(forced.written.includes(ANDROID));
    assertEquals((await addStorageToProject({ dir })).written, []);
  });
});
