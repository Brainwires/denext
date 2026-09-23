// `denext mobile add-ota` (src/build/mobile-ota-install.ts): installs the DenextOta native
// templates into a Capacitor 8 project, wires the stock bridge view controller and
// MainActivity, reports customised ones as manual steps, and is idempotent.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import { OTA_ANDROID_FILES, OTA_IOS_FILES } from "../src/build/ota-native-templates.ts";
import { buildRegistry } from "../src/cli/register.ts";

const PBXPROJ = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

/** Capacitor 8's stock Main.storyboard view controller line (ios-spm-template). */
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

const STOCK_SCENE_DELEGATE = `import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()
    }
}
`;

const STOCK_MAIN_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";

/** A stock Capacitor 8 project with ios/ and android/ (plus `extra` files). */
async function project(extra: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_add_ota_" });
  const files: Record<string, string> = {
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift": STOCK_SCENE_DELEGATE,
    [MAIN_ACTIVITY]: STOCK_MAIN_ACTIVITY,
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

Deno.test("add-ota: a stock project gets every file and all the wiring", async () => {
  const dir = await project();
  try {
    const report = await addOtaToProject({ dir });
    assertEquals(report.manual, []);
    assertEquals(report.skipped, []);
    for (const [name, content] of Object.entries(OTA_IOS_FILES)) {
      assertEquals(await read(dir, `ios/App/App/${name}`), content);
    }
    for (const [name, content] of Object.entries(OTA_ANDROID_FILES)) {
      assertEquals(await read(dir, `android/app/src/main/java/dev/denext/ota/${name}`), content);
    }
    const pbxproj = await read(dir, "ios/App/App.xcodeproj/project.pbxproj");
    for (const name of Object.keys(OTA_IOS_FILES)) {
      assertStringIncludes(pbxproj, `/* ${name} in Sources */,`);
    }
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController" customModule="App" customModuleProvider="target"',
    );
    assertStringIncludes(
      await read(dir, "ios/App/App/SceneDelegate.swift"),
      "window?.rootViewController = DenextBridgeViewController()",
    );
    const activity = await read(dir, MAIN_ACTIVITY);
    assertStringIncludes(activity, "package com.example.app;");
    assertStringIncludes(activity, "import dev.denext.ota.DenextOta;");
    // prepare() runs before super.onCreate builds the bridge.
    assert(
      activity.indexOf("DenextOta.prepare(this, bridgeBuilder);") <
        activity.indexOf("super.onCreate(savedInstanceState);"),
    );
    assertEquals(report.written.length, 6 + 4); // 6 templates + pbxproj, storyboard, scene, activity
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: idempotent — a second run writes nothing", async () => {
  const dir = await project();
  try {
    await addOtaToProject({ dir });
    const snapshot = await Promise.all(
      [
        "ios/App/App.xcodeproj/project.pbxproj",
        "ios/App/App/Base.lproj/Main.storyboard",
        MAIN_ACTIVITY,
      ]
        .map((p) => read(dir, p)),
    );
    const again = await addOtaToProject({ dir });
    assertEquals(again.written, []);
    assertEquals(again.manual, []);
    assert(again.unchanged.includes("ios/App/App.xcodeproj/project.pbxproj"));
    assertEquals(
      await Promise.all(
        [
          "ios/App/App.xcodeproj/project.pbxproj",
          "ios/App/App/Base.lproj/Main.storyboard",
          MAIN_ACTIVITY,
        ]
          .map((p) => read(dir, p)),
      ),
      snapshot,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: a custom bridge subclass and MainActivity become manual steps", async () => {
  const customActivity = STOCK_MAIN_ACTIVITY.replace(
    "extends BridgeActivity {}",
    "extends BridgeActivity {\n    // app code\n}",
  );
  const dir = await project({
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD.replace(
      'customClass="CAPBridgeViewController" customModule="Capacitor"',
      'customClass="MainViewController" customModule="App" customModuleProvider="target"',
    ),
    "ios/App/App/SceneDelegate.swift": STOCK_SCENE_DELEGATE.replace(
      "CAPBridgeViewController()",
      "MainViewController()",
    ),
    "ios/App/App/MainViewController.swift":
      "import Capacitor\n\nclass MainViewController: CAPBridgeViewController {}\n",
    [MAIN_ACTIVITY]: customActivity,
  });
  try {
    const report = await addOtaToProject({ dir });
    assertEquals(report.manual.length, 2, report.manual.join("\n"));
    assertStringIncludes(
      report.manual[0],
      "`class MainViewController: CAPBridgeViewController` to `class MainViewController: DenextBridgeViewController`",
    );
    assertStringIncludes(report.manual[1], "DenextOta.prepare(this, bridgeBuilder);");
    assertEquals(await read(dir, MAIN_ACTIVITY), customActivity);
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="MainViewController"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: a custom controller already on the bridge needs no manual step", async () => {
  const dir = await project({
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD.replace(
      'customClass="CAPBridgeViewController" customModule="Capacitor"',
      'customClass="MainViewController" customModule="App" customModuleProvider="target"',
    ),
    "ios/App/App/MainViewController.swift":
      "import Capacitor\n\nclass MainViewController: DenextBridgeViewController {}\n",
  });
  try {
    const report = await addOtaToProject({ dir });
    assertEquals(
      report.manual.filter((m) => m.includes("MainViewController")),
      [],
      report.manual.join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: an edited template is kept unless --force", async () => {
  const dir = await project({ "ios/App/App/DenextOtaStore.swift": "// my edits\n" });
  try {
    const kept = await addOtaToProject({ dir });
    assertEquals(await read(dir, "ios/App/App/DenextOtaStore.swift"), "// my edits\n");
    assertEquals(kept.manual.length, 1);
    assertStringIncludes(kept.manual[0], "--force");
    const forced = await addOtaToProject({ dir, force: true });
    assert(forced.written.includes("ios/App/App/DenextOtaStore.swift"));
    assertEquals(
      await read(dir, "ios/App/App/DenextOtaStore.swift"),
      OTA_IOS_FILES["DenextOtaStore.swift"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: platforms that are not there are skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_add_ota_empty_" });
  try {
    const report = await addOtaToProject({ dir });
    assertEquals(report.written, []);
    assertEquals(report.skipped.length, 2);
    assertStringIncludes(report.skipped[0], "cap add ios");
    assertStringIncludes(report.skipped[1], "cap add android");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mobile add-ota [dir] runs the installer", async () => {
  const dir = await project();
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("mobile")!.run({
      positionals: ["add-ota", dir],
      flags: {},
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
    assert(lines.some((l) => l.includes("wrote") && l.includes("DenextOtaPlugin.swift")));
    assertStringIncludes(
      await read(dir, "ios/App/App/SceneDelegate.swift"),
      "DenextBridgeViewController()",
    );
  } finally {
    console.log = log;
    await Deno.remove(dir, { recursive: true });
  }
});

/** The body of the Swift/Java function starting at `signature`, up to the next blank-line-separated member. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert(start >= 0, `missing ${signature}`);
  const end = source.indexOf("\n\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

Deno.test("native templates: iOS registers and implements download/activate symmetric with apply", () => {
  const plugin = OTA_IOS_FILES["DenextOtaPlugin.swift"];
  const store = OTA_IOS_FILES["DenextOtaStore.swift"];
  for (const method of ["status", "download", "activate", "apply", "booted", "reset"]) {
    assertStringIncludes(
      plugin,
      `CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`,
    );
    assertStringIncludes(plugin, `@objc func ${method}(_ call: CAPPluginCall)`);
  }
  assertStringIncludes(plugin, `"staged": store.staged ?? NSNull()`);
  // download stages without switching; activate requires the staged version.
  const download = body(plugin, "@objc func download(");
  assertStringIncludes(download, "self.stage(request, call: call)");
  assert(!download.includes("switchWebView") && !download.includes("startTrial"), download);
  const activate = body(plugin, "@objc func activate(");
  assertStringIncludes(activate, `"not_staged"`);
  assertStringIncludes(activate, "self.startTrial(version");
  // apply = the same staging, then the same trial start.
  const apply = body(plugin, "@objc func apply(");
  assertStringIncludes(apply, "self.stage(request, call: call)");
  assertStringIncludes(apply, "self.startTrial(request.version");
  // The store: staged is cleared by a trial start and by reset, and launch never serves it.
  assertStringIncludes(store, `static let staged = "denext.ota.staged"`);
  assertStringIncludes(body(store, "func beginTrial("), "stagedVersion = nil");
  assertStringIncludes(body(store, "func reset()"), "Key.staged");
  assert(!body(store, "func prepareLaunch()").includes("staged"));
});

Deno.test("native templates: Android registers and implements download/activate symmetric with apply", () => {
  const plugin = OTA_ANDROID_FILES["DenextOtaPlugin.java"];
  const store = OTA_ANDROID_FILES["DenextOtaStore.java"];
  for (const method of ["status", "download", "activate", "apply", "booted", "reset"]) {
    assertStringIncludes(plugin, `@PluginMethod\n    public void ${method}(PluginCall call)`);
  }
  assertStringIncludes(plugin, `result.put("staged", orNull(store.staged()));`);
  const download = body(plugin, "public void download(");
  assertStringIncludes(download, "stage(store, request, call,");
  assert(!download.includes("switchWebView") && !download.includes("startTrial"), download);
  const activate = body(plugin, "public void activate(");
  assertStringIncludes(activate, `"not_staged"`);
  assertStringIncludes(activate, "startTrial(store, version");
  const apply = body(plugin, "public void apply(");
  assertStringIncludes(apply, "stage(store, request, call,");
  assertStringIncludes(apply, "startTrial(store, request.version");
  assertStringIncludes(store, `KEY_STAGED = "staged"`);
  assertStringIncludes(body(store, "synchronized void beginTrial("), ".remove(KEY_STAGED)");
  assertStringIncludes(body(store, "synchronized void reset()"), ".remove(KEY_STAGED)");
  assert(!body(store, "private File prepareLaunch()").includes("STAGED"));
  assert(!body(store, "synchronized File startDirectory()").includes("STAGED"));
});
