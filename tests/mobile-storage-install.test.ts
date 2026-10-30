// `denext mobile add storage` (src/build/mobile-storage-install.ts): the DenextStorage plugin on
// iOS and Android, registered through the shared bridge view controller and MainActivity, with
// no npm package; the templates follow the JS contract src/mobile/kv-store.ts calls.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addMobileCapabilities, type CommandRunner } from "../src/build/mobile-capabilities.ts";
import {
  addEncryptedStorageToProject,
  addStorageToProject,
} from "../src/build/mobile-storage-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import {
  SQLCIPHER_ANDROID_DEPENDENCIES,
  STORAGE_ANDROID_FILES,
  STORAGE_CIPHER_ANDROID_FILES,
  STORAGE_IOS_FILES,
} from "../src/build/storage-native-templates.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS = "ios/App/App/DenextStoragePlugin.swift";
const IOS_STORE = "ios/App/App/DenextStorageStore.swift";
const ANDROID = "android/app/src/main/java/dev/denext/storage/DenextStoragePlugin.java";
const ANDROID_CIPHER = "android/app/src/main/java/dev/denext/storage/DenextStorageCipher.java";
const APP_GRADLE = "android/app/build.gradle";

async function inProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mobile_storage_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "node_modules/@capacitor/cli/package.json": JSON.stringify({ version: "8.5.2" }),
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
    for (const path of [IOS, IOS_STORE, ANDROID, BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    assert(!report.written.includes(ANDROID_CIPHER), "no SQLCipher without --encrypted");
    const ios = await read(dir, IOS);
    assert(ios.startsWith("// denext-storage-template: 3 sha256="));
    assertStringIncludes(ios, 'jsName = "DenextStorage"');
    assertStringIncludes(await read(dir, IOS_STORE), "import SQLite3");
    assert(!(await read(dir, PBXPROJ)).includes("SQLCipher"));
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
    assertStringIncludes(await read(dir, PBXPROJ), "DenextStorageStore.swift");
    assertStringIncludes(report.plan.notes.join("\n"), "openKeyValueStore");
    const again = await addMobileCapabilities({ capabilities: ["storage"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("DenextStorage templates: every method kv-store.ts calls, on both platforms", () => {
  const ios = STORAGE_IOS_FILES["DenextStoragePlugin.swift"] +
    STORAGE_IOS_FILES["DenextStorageStore.swift"];
  const android = STORAGE_ANDROID_FILES["DenextStoragePlugin.java"];
  for (const method of ["getMany", "setMany", "removeMany", "keys", "clear", "cipher"]) {
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
    // Encrypted stores: the key on the wire, the codes kv-store.ts maps.
    assertStringIncludes(text, '"key"');
    assertStringIncludes(text, "ENCRYPTION_UNAVAILABLE");
    assertStringIncludes(text, "WRONG_KEY");
    assertStringIncludes(text, "secure_delete");
    assertStringIncludes(text, "INSERT OR IGNORE");
  }
  assertStringIncludes(ios, "#if canImport(SQLCipher)");
  assertStringIncludes(ios, "PRAGMA cipher_version");
  assertStringIncludes(STORAGE_CIPHER_ANDROID_FILES["DenextStorageCipher.java"], "net.zetetic");
  assert(!android.includes("net.zetetic"), "the plugin compiles without SQCipher");
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

Deno.test("mobile add storage --encrypted: SQLCipher on iOS (Swift package) and Android (Gradle), idempotent", async () => {
  await inProject(async (dir) => {
    await Deno.writeTextFile(
      join(dir, APP_GRADLE),
      "apply plugin: 'com.android.application'\n\ndependencies {\n    implementation 'androidx.appcompat:appcompat:1.7.1'\n}\n",
    );
    const report = await addMobileCapabilities({
      capabilities: ["storage"],
      cwd: dir,
      run,
      encrypted: true,
    });
    for (const path of [IOS, IOS_STORE, ANDROID, ANDROID_CIPHER, APP_GRADLE, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    const pbx = await read(dir, PBXPROJ);
    assertStringIncludes(
      pbx,
      'repositoryURL = "https://github.com/sqlcipher/SQLCipher.swift.git";',
    );
    assertStringIncludes(pbx, "productName = SQLCipher;");
    assertStringIncludes(pbx, "SQLCipher in Frameworks");
    for (const dep of SQLCIPHER_ANDROID_DEPENDENCIES) {
      assertStringIncludes(await read(dir, APP_GRADLE), dep);
    }
    assertStringIncludes(await read(dir, APP_GRADLE), "androidx.sqlite:sqlite:");
    assertStringIncludes(report.plan.manual.join("\n"), "denext mobile add secure-store");
    const again = await addMobileCapabilities({
      capabilities: ["storage"],
      cwd: dir,
      run,
      encrypted: true,
    });
    assertEquals(again.written, []);
    assertEquals(
      (await read(dir, PBXPROJ)).match(/isa = XCRemoteSwiftPackageReference;/g)?.length,
      1,
    );
    assertEquals((await read(dir, APP_GRADLE)).split("sqlcipher-android").length, 2);
  });
});

Deno.test("mobile add storage secure-store --encrypted: no note to add secure-store, which this run adds", async () => {
  await inProject(async (dir) => {
    const report = await addMobileCapabilities({
      capabilities: ["storage", "secure-store"],
      cwd: dir,
      run,
      encrypted: true,
    });
    assert(report.written.includes(PBXPROJ));
    assert(!report.plan.manual.join("\n").includes("denext mobile add secure-store"));
  });
});

Deno.test("mobile add storage --encrypted: a project without build.gradle gets the dependency as a manual step", async () => {
  await inProject(async (dir) => {
    const report = await addEncryptedStorageToProject({ dir });
    assert(report.written.includes(ANDROID_CIPHER));
    for (const dep of SQLCIPHER_ANDROID_DEPENDENCIES) {
      assertStringIncludes(report.manual.join("\n"), dep);
    }
    // A build.gradle with no dependencies block: the same manual step.
    await Deno.writeTextFile(join(dir, APP_GRADLE), "apply plugin: 'com.android.application'\n");
    const second = await addEncryptedStorageToProject({ dir });
    assertStringIncludes(second.manual.join("\n"), "add `" + SQLCIPHER_ANDROID_DEPENDENCIES[0]);
  });
});

Deno.test("mobile add --encrypted is only for storage", async () => {
  await inProject(async (dir) => {
    const err = await addMobileCapabilities({
      capabilities: ["haptics"],
      cwd: dir,
      run,
      encrypted: true,
    }).catch((e) => e);
    assert(err instanceof Error);
    assertStringIncludes(err.message, "--encrypted is only for storage");
  });
});

Deno.test("mobile add storage --encrypted / file-transfer in an iOS-only project: the Android skip is listed once", async () => {
  await inProject(async (dir) => {
    await Deno.remove(join(dir, "android"), { recursive: true });
    for (const capability of ["storage", "file-transfer"]) {
      const report = await addMobileCapabilities({
        capabilities: [capability],
        cwd: dir,
        run,
        encrypted: capability === "storage",
      });
      const android = report.skipped.filter((s) => s.startsWith("Android: no android/app"));
      assertEquals(android.length, 1, `${capability}: ${report.skipped.join(" | ")}`);
    }
  });
});
