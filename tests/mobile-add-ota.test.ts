// `denext mobile add-ota` (src/build/mobile-ota-install.ts): installs the DenextOta native
// templates into a Capacitor 8 project, wires the stock bridge view controller and
// MainActivity, embeds the OTA public key, reports customised ones as manual steps, and is
// idempotent.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import {
  isPristineOtaTemplate,
  OTA_ANDROID_FILES,
  OTA_IOS_FILES,
  OTA_TEMPLATE_VERSION,
  renderOtaTemplate,
  SHIPPED_OTA_TEMPLATE_SHA256,
} from "../src/build/ota-native-templates.ts";
import { generateOtaKeyPair } from "../src/build/ota-signing.ts";
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
      assertEquals(await read(dir, `ios/App/App/${name}`), await renderOtaTemplate(content));
    }
    for (const [name, content] of Object.entries(OTA_ANDROID_FILES)) {
      assertEquals(
        await read(dir, `android/app/src/main/java/dev/denext/ota/${name}`),
        await renderOtaTemplate(content),
      );
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
    assertEquals(kept.kept, ["ios/App/App/DenextOtaStore.swift"]);
    const forced = await addOtaToProject({ dir, force: true });
    assert(forced.written.includes("ios/App/App/DenextOtaStore.swift"));
    assertEquals(forced.upgraded, []);
    assertEquals(
      await read(dir, "ios/App/App/DenextOtaStore.swift"),
      await renderOtaTemplate(OTA_IOS_FILES["DenextOtaStore.swift"]),
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

// ---------------------------------------------------------------------------------------------
// Signed OTA: the public key embedded by --public-key, and the native verification branches.

const STOCK_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
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

const STOCK_ANDROID_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name">

        <activity android:name=".MainActivity" android:exported="true" />
    </application>

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";

/** A stock project that also has Info.plist and AndroidManifest.xml. */
const keyedProject = () =>
  project({ [INFO_PLIST]: STOCK_INFO_PLIST, [ANDROID_MANIFEST]: STOCK_ANDROID_MANIFEST });

Deno.test("add-ota: publicKey is embedded in Info.plist and AndroidManifest, idempotently", async () => {
  const dir = await keyedProject();
  try {
    const first = (await generateOtaKeyPair()).publicKey;
    const report = await addOtaToProject({ dir, publicKey: first });
    assertEquals(report.manual, []);
    assert(report.written.includes(INFO_PLIST) && report.written.includes(ANDROID_MANIFEST));
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(
      plist,
      `\t<key>DenextOtaPublicKey</key>\n\t<string>${first}</string>\n</dict>\n</plist>`,
    );
    // The nested ATS dict is untouched: the key goes into the top-level dict.
    assertStringIncludes(plist, "\t\t<true/>\n\t</dict>\n\t<key>DenextOtaPublicKey</key>");
    const manifest = await read(dir, ANDROID_MANIFEST);
    assertStringIncludes(
      manifest,
      `        <meta-data android:name="dev.denext.ota.PUBLIC_KEY" android:value="${first}" />\n    </application>`,
    );

    // Same key again: nothing changes.
    const again = await addOtaToProject({ dir, publicKey: first });
    assertEquals(again.written, []);
    assertEquals(await read(dir, INFO_PLIST), plist);
    assertEquals(await read(dir, ANDROID_MANIFEST), manifest);

    // A new key replaces the old one (exactly one entry each).
    const second = (await generateOtaKeyPair()).publicKey;
    await addOtaToProject({ dir, publicKey: second });
    const plist2 = await read(dir, INFO_PLIST);
    const manifest2 = await read(dir, ANDROID_MANIFEST);
    assertEquals(plist2, plist.replace(first, second));
    assertEquals(manifest2, manifest.replace(first, second));
    assertEquals(plist2.split("DenextOtaPublicKey").length, 2);
    assertEquals(manifest2.split("dev.denext.ota.PUBLIC_KEY").length, 2);

    // Without a key, neither file is touched (and an embedded key stays).
    const plain = await addOtaToProject({ dir });
    assert(!plain.written.includes(INFO_PLIST) && !plain.written.includes(ANDROID_MANIFEST));
    assertEquals(await read(dir, INFO_PLIST), plist2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: a project without Info.plist / AndroidManifest gets manual key steps", async () => {
  const dir = await project();
  try {
    const report = await addOtaToProject({
      dir,
      publicKey: (await generateOtaKeyPair()).publicKey,
    });
    assert(report.manual.some((m) => m.startsWith(INFO_PLIST) && m.includes("DenextOtaPublicKey")));
    assert(
      report.manual.some((m) =>
        m.startsWith(ANDROID_MANIFEST) && m.includes("dev.denext.ota.PUBLIC_KEY")
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run `denext mobile add-ota <dir>` with `flags`, returning what it logged. */
async function addOtaVerb(dir: string, flags: Record<string, string | boolean>): Promise<string[]> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("mobile")!.run({
      positionals: ["add-ota", dir],
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines;
}

Deno.test("denext mobile add-ota --public-key takes base64 SPKI or a PEM; no key prints the https note", async () => {
  const dir = await keyedProject();
  try {
    const plain = await addOtaVerb(dir, {});
    assert(
      plain.some((l) => l.includes("unsigned OTA only works over https or loopback")),
      plain.join("\n"),
    );
    const { publicKey } = await generateOtaKeyPair();
    const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)!.join("\n")}\n` +
      "-----END PUBLIC KEY-----\n";
    await Deno.writeTextFile(join(dir, "ota.pem"), pem);
    const keyed = await addOtaVerb(dir, { "public-key": join(dir, "ota.pem") });
    assert(!keyed.some((l) => l.includes("unsigned OTA")), keyed.join("\n"));
    assertStringIncludes(await read(dir, INFO_PLIST), `<string>${publicKey}</string>`);
    assertStringIncludes(await read(dir, ANDROID_MANIFEST), `android:value="${publicKey}"`);
    // `denext ota keygen`'s .pub (one base64 line) works as is.
    const other = (await generateOtaKeyPair()).publicKey;
    await Deno.writeTextFile(join(dir, "ota.key.pub"), other + "\n");
    await addOtaVerb(dir, { "public-key": join(dir, "ota.key.pub") });
    assertStringIncludes(await read(dir, INFO_PLIST), `<string>${other}</string>`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext mobile add-ota --public-key refuses a key that is not P-256 SPKI, writing nothing", async () => {
  const dir = await keyedProject();
  const exit = Deno.exit;
  const error = console.error;
  const errors: string[] = [];
  try {
    await Deno.writeTextFile(join(dir, "bad.pub"), "definitely not a key");
    Deno.exit = ((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof Deno.exit;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    let thrown = "";
    try {
      await addOtaVerb(dir, { "public-key": join(dir, "bad.pub") });
    } catch (err) {
      thrown = String(err);
    }
    assertStringIncludes(thrown, "exit 1");
    assert(errors.some((e) => e.includes("P-256")), errors.join("\n"));
    assertEquals(await read(dir, INFO_PLIST), STOCK_INFO_PLIST);
    assertEquals(await read(dir, ANDROID_MANIFEST), STOCK_ANDROID_MANIFEST);
  } finally {
    Deno.exit = exit;
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native templates: iOS recomputes the version and enforces the signature/transport policy", () => {
  const store = OTA_IOS_FILES["DenextOtaStore.swift"];
  const init = body(store, "init(baseUrl: String?, headers: JSObject?, manifest: JSObject?)");
  // files → version → signature, all inside the request parse (before any download).
  const recompute = init.indexOf("DenextOtaStore.manifestVersion(files) == version");
  const trust = init.indexOf("try DenextOtaStore.checkTrust(");
  assert(recompute > 0 && trust > recompute, init);
  assertStringIncludes(init, `code: "integrity"`);
  assertStringIncludes(init, `signature: manifest["signature"] as? String`);
  assertStringIncludes(store, "$0.path.utf16.lexicographicallyPrecedes($1.path.utf16)");
  assertStringIncludes(store, '.map { "\\($0.path)\\t\\($0.sha256)\\n" }');
  // The signed bytes: v1 without a sequence, v2 with one, v3 with a nativeFingerprint too (the
  // same format as otaSignaturePayload).
  assertStringIncludes(
    store,
    'let head = "\\(version)\\n\\(required ? "1" : "0")\\n\\(sha256Hex(Data(notes.utf8)))"',
  );
  assertStringIncludes(store, 'return Data("denext-ota-v1\\n\\(head)".utf8)');
  assertStringIncludes(
    store,
    'let v2 = "\\(head)\\n\\(sequence)\\n\\(minNative.map { String($0) } ?? "")"',
  );
  assertStringIncludes(store, 'return Data("denext-ota-v2\\n\\(v2)".utf8)');
  assertStringIncludes(store, 'return Data("denext-ota-v3\\n\\(v2)\\n\\(nativeFingerprint)".utf8)');
  assertStringIncludes(
    init,
    "minNative: minNative,\n                    nativeFingerprint: nativeFingerprint\n                ),",
  );
  // The key comes from Info.plist only, through CryptoKit.
  assertStringIncludes(store, `static let publicKeyInfoKey = "DenextOtaPublicKey"`);
  assertStringIncludes(store, "Bundle.main.object(forInfoDictionaryKey:");
  assertStringIncludes(store, "P256.Signing.PublicKey(derRepresentation: der)");
  assertStringIncludes(store, "P256.Signing.ECDSASignature(rawRepresentation: raw)");
  assertStringIncludes(store, "key.isValidSignature(ecdsa, for: payload)");
  const policy = body(store, "static func checkTrust(");
  assertStringIncludes(policy, `code: "signature"`);
  assertStringIncludes(policy, `case .invalid:\n            throw OtaError(code: "signature"`);
  assertStringIncludes(policy, `code: "insecure"`);
  assertStringIncludes(
    policy,
    `baseUrl.scheme?.lowercased() == "https" || loopbackHosts.contains(host)`,
  );
  // The Android emulator's host alias is not loopback on iOS.
  assertStringIncludes(
    store,
    `static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]`,
  );
  assert(!store.includes("10.0.2.2"));
  // The plugin parses (and so verifies) the request before touching any state.
  const plugin = OTA_IOS_FILES["DenextOtaPlugin.swift"];
  for (const method of ["download", "apply"]) {
    const fn = body(plugin, `@objc func ${method}(`);
    assert(fn.indexOf("parseRequest(call)") < fn.indexOf("DispatchQueue.main.async"), fn);
  }
});

Deno.test("native templates: Android recomputes the version and enforces the signature/transport policy", () => {
  const plugin = OTA_ANDROID_FILES["DenextOtaPlugin.java"];
  const store = OTA_ANDROID_FILES["DenextOtaStore.java"];
  const parse = plugin.slice(
    plugin.indexOf("private static DenextOtaStore.ApplyRequest parseApplyRequest("),
  );
  const recompute = parse.indexOf("DenextOtaStore.manifestVersion(files).equals(version)");
  const trust = parse.indexOf("store.checkTrust(");
  assert(recompute > 0 && trust > recompute, parse);
  assertStringIncludes(parse, `new DenextOtaStore.OtaException("integrity"`);
  for (const method of ["download", "apply"]) {
    assertStringIncludes(
      body(plugin, `public void ${method}(`),
      "parseApplyRequest(call, store())",
    );
  }
  assertStringIncludes(store, "Collections.sort(sorted, (a, b) -> a.path.compareTo(b.path));");
  assertStringIncludes(store, ".append('\\t').append(file.sha256).append('\\n');");
  assertStringIncludes(
    store,
    `String head = version + "\\n" + (required ? "1" : "0") + "\\n" + sha256Hex(notes.getBytes(StandardCharsets.UTF_8));`,
  );
  assertStringIncludes(store, `text = "denext-ota-v1\\n" + head;`);
  assertStringIncludes(
    store,
    `String v2 = head + "\\n" + sequence + "\\n" + (minNative == null ? "" : String.valueOf(minNative));`,
  );
  assertStringIncludes(
    store,
    `text = nativeFingerprint == null ? "denext-ota-v2\\n" + v2 : "denext-ota-v3\\n" + v2 + "\\n" + nativeFingerprint;`,
  );
  assertStringIncludes(
    parse,
    "                minNative,\n                nativeFingerprint\n            ),",
  );
  // The key comes from the manifest meta-data only; raw r‖s becomes DER for SHA256withECDSA.
  assertStringIncludes(store, `PUBLIC_KEY_META = "dev.denext.ota.PUBLIC_KEY"`);
  assertStringIncludes(store, "PackageManager.GET_META_DATA");
  assertStringIncludes(
    store,
    `KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki))`,
  );
  assertStringIncludes(store, `Signature.getInstance("SHA256withECDSA")`);
  assertStringIncludes(store, "import android.util.Base64;");
  assert(!store.includes("P1363".concat("Format")) && !store.includes("java.util.Base64"));
  assertStringIncludes(store, "static byte[] rawSignatureToDer(byte[] raw)");
  const policy = body(store, "void checkTrust(");
  assertStringIncludes(policy, `new OtaException(\n                    "insecure"`);
  assertStringIncludes(policy, `!"https".equalsIgnoreCase(base.getScheme()) && !loopback`);
  // 10.0.2.2 (the emulator's host) counts as loopback only in a debuggable build.
  assertStringIncludes(
    policy,
    "LOOPBACK_HOSTS.contains(host) || (EMULATOR_HOST.equals(host) && isDebuggable())",
  );
  assertStringIncludes(
    store,
    "(context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0",
  );
  assertStringIncludes(
    store,
    `throw new OtaException("signature", "The manifest signature is missing or does not verify.")`,
  );
  assertStringIncludes(store, `Arrays.asList("localhost", "127.0.0.1", "::1", "[::1]")`);
  assertStringIncludes(store, `EMULATOR_HOST = "10.0.2.2"`);
});

// ---------------------------------------------------------------------------------------------
// Upgrades: an unedited denext template of any earlier release is replaced without --force.

const IOS_STORE = "ios/App/App/DenextOtaStore.swift";

Deno.test("add-ota: a marked template from an earlier generation is upgraded in place", async () => {
  const dir = await project();
  try {
    // An earlier generation's file: a marker whose hash matches its (different) body.
    const older = "// denext-ota-template: 2 sha256=" +
      (await renderOtaTemplate("// an older template\n")).split("sha256=")[1];
    assert(await isPristineOtaTemplate("DenextOtaStore.swift", older));
    await Deno.writeTextFile(join(dir, IOS_STORE), older);
    const report = await addOtaToProject({ dir });
    assertEquals(report.upgraded, [IOS_STORE]);
    assertEquals(report.kept, []);
    assert(report.written.includes(IOS_STORE));
    const written = await read(dir, IOS_STORE);
    assertEquals(written, await renderOtaTemplate(OTA_IOS_FILES["DenextOtaStore.swift"]));
    assert(written.startsWith(`// denext-ota-template: ${OTA_TEMPLATE_VERSION} sha256=`));
    assert(await isPristineOtaTemplate("DenextOtaStore.swift", written));
    // Edit the body under an intact marker: now it is the user's file.
    await Deno.writeTextFile(
      join(dir, IOS_STORE),
      written.replace("maxFiles = 20_000", "maxFiles = 5"),
    );
    const again = await addOtaToProject({ dir });
    assertEquals(again.kept, [IOS_STORE]);
    assertEquals(again.upgraded, []);
    assertStringIncludes(await read(dir, IOS_STORE), "maxFiles = 5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Whether this checkout has the release tags (a shallow CI clone may not). */
async function hasTag(tag: string): Promise<boolean> {
  try {
    const out = await new Deno.Command("git", {
      args: ["rev-parse", "-q", "--verify", `refs/tags/${tag}`],
    })
      .output();
    return out.success;
  } catch {
    return false;
  }
}

/** The OTA templates as released at `tag` (`git show <tag>:src/build/ota-native-templates.ts`). */
async function templatesAt(tag: string): Promise<Record<string, string>> {
  const out = await new Deno.Command("git", {
    args: ["show", `${tag}:src/build/ota-native-templates.ts`],
  }).output();
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeFile(file, out.stdout);
    const mod = await import(`file://${file}`);
    return { ...mod.OTA_IOS_FILES, ...mod.OTA_ANDROID_FILES };
  } finally {
    await Deno.remove(file);
  }
}

const RELEASE_TAGS = ["v2.7.0", "v2.7.1", "v2.8.0", "v2.8.1", "v2.8.2", "v2.8.3"];

Deno.test({
  name: "add-ota: templates shipped by 2.7.0 … 2.8.3 are recognised and upgraded without --force",
  ignore: !(await hasTag("v2.8.3")),
  async fn() {
    const sha = async (text: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const seen: Record<string, Set<string>> = {};
    for (const tag of RELEASE_TAGS) {
      for (const [name, text] of Object.entries(await templatesAt(tag))) {
        (seen[name] ??= new Set()).add(await sha(text));
        assert(await isPristineOtaTemplate(name, text), `${tag} ${name}`);
      }
    }
    // The embedded table is exactly the shipped history.
    assertEquals(
      Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()])),
      Object.fromEntries(
        Object.entries(SHIPPED_OTA_TEMPLATE_SHA256).map(([k, v]) => [k, [...v].sort()]),
      ),
    );
    // A project installed by 2.8.3 upgrades every template without --force.
    const old = await templatesAt("v2.8.3");
    const dir = await project();
    try {
      for (const name of Object.keys(OTA_IOS_FILES)) {
        await Deno.writeTextFile(join(dir, "ios/App/App", name), old[name]);
      }
      for (const name of Object.keys(OTA_ANDROID_FILES)) {
        await Deno.mkdir(join(dir, "android/app/src/main/java/dev/denext/ota"), {
          recursive: true,
        });
        await Deno.writeTextFile(
          join(dir, "android/app/src/main/java/dev/denext/ota", name),
          old[name],
        );
      }
      const report = await addOtaToProject({ dir });
      assertEquals(report.upgraded.length, 6, report.manual.join("\n"));
      assertEquals(report.kept, []);
      // One changed character and it is the user's file again.
      assert(!(await isPristineOtaTemplate("DenextOta.java", old["DenextOta.java"] + " ")));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/**
 * The OTA files exactly as `add-ota` wrote them at `tag` (a release with marker lines): the
 * module at that tag, its marker import pointed at this checkout's (unchanged) marker module.
 */
async function writtenTemplatesAt(
  tag: string,
): Promise<{ generation: number; files: Record<string, string> }> {
  const out = await new Deno.Command("git", {
    args: ["show", `${tag}:src/build/ota-native-templates.ts`],
  }).output();
  const marker = new URL("../src/build/native-template-marker.ts", import.meta.url).href;
  const source = new TextDecoder().decode(out.stdout)
    .replace(`from "./native-template-marker.ts"`, `from "${marker}"`);
  const file = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(file, source);
    const mod = await import(`file://${file}`);
    const files: Record<string, string> = {};
    for (const [name, text] of Object.entries({ ...mod.OTA_IOS_FILES, ...mod.OTA_ANDROID_FILES })) {
      files[name] = await mod.renderOtaTemplate(text as string);
    }
    return { generation: mod.OTA_TEMPLATE_VERSION, files };
  } finally {
    await Deno.remove(file);
  }
}

Deno.test({
  name: "add-ota: generation-3 templates (2.9.0 … 2.10.0-rc.2) upgrade to the current one",
  ignore: !(await hasTag("v2.10.0-rc.2")),
  async fn() {
    const { generation, files } = await writtenTemplatesAt("v2.10.0-rc.2");
    assertEquals(generation, 3);
    assert(OTA_TEMPLATE_VERSION > generation, "bump OTA_TEMPLATE_VERSION when templates change");
    // The templates did change since (the native fingerprint gate, payload v3).
    assert(!files["DenextOtaStore.swift"].includes("native_mismatch"));
    const dir = await project();
    try {
      const otaDir = join(dir, "android/app/src/main/java/dev/denext/ota");
      await Deno.mkdir(otaDir, { recursive: true });
      for (const name of Object.keys(OTA_IOS_FILES)) {
        assert(await isPristineOtaTemplate(name, files[name]), name);
        await Deno.writeTextFile(join(dir, "ios/App/App", name), files[name]);
      }
      for (const name of Object.keys(OTA_ANDROID_FILES)) {
        assert(await isPristineOtaTemplate(name, files[name]), name);
        await Deno.writeTextFile(join(otaDir, name), files[name]);
      }
      const report = await addOtaToProject({ dir });
      assertEquals(report.upgraded.length, 6, report.manual.join("\n"));
      assertEquals(report.kept, []);
      const store = await read(dir, IOS_STORE);
      assert(store.startsWith(`// denext-ota-template: ${OTA_TEMPLATE_VERSION} sha256=`));
      assertStringIncludes(store, `code: "native_mismatch"`);
      assertStringIncludes(
        await read(dir, "android/app/src/main/java/dev/denext/ota/DenextOtaStore.java"),
        `"native_mismatch"`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** Run `denext mobile add-ota <dir>` expecting it to exit non-zero; returns stderr + stdout. */
async function addOtaVerbFails(
  dir: string,
  flags: Record<string, string | boolean>,
): Promise<{ errors: string[]; lines: string[] }> {
  const exit = Deno.exit;
  const error = console.error;
  const errors: string[] = [];
  let thrown = "";
  let lines: string[] = [];
  Deno.exit = ((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof Deno.exit;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await buildRegistry().get("mobile")!.run({
      positionals: ["add-ota", dir],
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  } catch (err) {
    thrown = String(err);
  } finally {
    Deno.exit = exit;
    console.error = error;
    console.log = log;
  }
  assertStringIncludes(thrown, "exit 1");
  lines = [...lines];
  return { errors, lines };
}

Deno.test("denext mobile add-ota --public-key exits non-zero when a template was kept or a key not embedded", async () => {
  const { publicKey } = await generateOtaKeyPair();
  // An edited template kept: the key is embedded, but that platform may not verify it.
  const edited = await keyedProject();
  try {
    await Deno.writeTextFile(join(edited, "ota.pub"), publicKey);
    await Deno.writeTextFile(join(edited, IOS_STORE), "// my store\n");
    const { errors } = await addOtaVerbFails(edited, { "public-key": join(edited, "ota.pub") });
    assert(errors.some((e) => e.includes(IOS_STORE) && e.includes("edited")), errors.join("\n"));
    assertStringIncludes(await read(edited, INFO_PLIST), publicKey);
  } finally {
    await Deno.remove(edited, { recursive: true });
  }
  // No Info.plist / AndroidManifest to embed into.
  const bare = await project();
  try {
    await Deno.writeTextFile(join(bare, "ota.pub"), publicKey);
    const { errors } = await addOtaVerbFails(bare, { "public-key": join(bare, "ota.pub") });
    assert(
      errors.some((e) => e.includes("could not be embedded in ios/App/App/Info.plist")),
      errors.join("\n"),
    );
    assert(errors.some((e) => e.includes("AndroidManifest.xml")), errors.join("\n"));
  } finally {
    await Deno.remove(bare, { recursive: true });
  }
  // Without --public-key, a kept template is only a manual step (exit 0).
  const plain = await project({ [IOS_STORE]: "// mine\n" });
  try {
    const lines = await addOtaVerb(plain, {});
    assert(lines.some((l) => l.includes("kept yours")), lines.join("\n"));
  } finally {
    await Deno.remove(plain, { recursive: true });
  }
});

Deno.test("add-ota: the unsigned note follows the files, not the flag", async () => {
  const dir = await keyedProject();
  try {
    await addOtaToProject({ dir, publicKey: (await generateOtaKeyPair()).publicKey });
    // Re-run without --public-key: the key embedded earlier is still there, so no note.
    const again = await addOtaVerb(dir, {});
    assert(!again.some((l) => l.includes("unsigned OTA")), again.join("\n"));
    assertEquals((await addOtaToProject({ dir })).unsignedPlatforms, []);
    // Drop the Android key by hand: the note names that platform only.
    const manifest = await read(dir, ANDROID_MANIFEST);
    await Deno.writeTextFile(
      join(dir, ANDROID_MANIFEST),
      manifest.replace(/\s*<meta-data android:name="dev\.denext\.ota\.PUBLIC_KEY"[^>]*\/>/, ""),
    );
    const lines = await addOtaVerb(dir, {});
    assert(
      lines.some((l) =>
        l.includes("(Android)") && l.includes("unsigned OTA only works over https or loopback")
      ),
      lines.join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("add-ota: the Info.plist key is matched and added in the top-level dict only", async () => {
  // A nested dict that happens to hold the same key name is not the app's key.
  const nested = STOCK_INFO_PLIST.replace(
    "\t\t<key>NSAllowsArbitraryLoads</key>",
    "\t\t<key>DenextOtaPublicKey</key>\n\t\t<string>NOT-OURS</string>\n\t\t<key>NSAllowsArbitraryLoads</key>",
  );
  const dir = await project({ [INFO_PLIST]: nested, [ANDROID_MANIFEST]: STOCK_ANDROID_MANIFEST });
  try {
    assert((await addOtaToProject({ dir })).unsignedPlatforms.includes("iOS"));
    const key = (await generateOtaKeyPair()).publicKey;
    const report = await addOtaToProject({ dir, publicKey: key });
    assertEquals(report.keyNotEmbedded, []);
    const plist = await read(dir, INFO_PLIST);
    assertStringIncludes(plist, "<string>NOT-OURS</string>");
    assertStringIncludes(
      plist,
      `\t<key>DenextOtaPublicKey</key>\n\t<string>${key}</string>\n</dict>\n</plist>`,
    );
    assertEquals(plist.split("DenextOtaPublicKey").length, 3);
    // Replacing touches the top-level entry, never the nested one.
    const next = (await generateOtaKeyPair()).publicKey;
    await addOtaToProject({ dir, publicKey: next });
    const replaced = await read(dir, INFO_PLIST);
    assertEquals(replaced, plist.replace(key, next));
    // A top-level key that holds something other than a string cannot be replaced safely.
    await Deno.writeTextFile(
      join(dir, INFO_PLIST),
      STOCK_INFO_PLIST.replace("<dict>\n", "<dict>\n\t<key>DenextOtaPublicKey</key>\n\t<true/>\n"),
    );
    const odd = await addOtaToProject({ dir, publicKey: key });
    assertEquals(odd.keyNotEmbedded, [INFO_PLIST]);
    // No top-level dict at all.
    await Deno.writeTextFile(join(dir, INFO_PLIST), "<plist><array></array></plist>");
    assertEquals((await addOtaToProject({ dir, publicKey: key })).keyNotEmbedded, [INFO_PLIST]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native templates: path, cap, release and trial rules (iOS)", () => {
  const store = OTA_IOS_FILES["DenextOtaStore.swift"];
  const plugin = OTA_IOS_FILES["DenextOtaPlugin.swift"];
  // Control characters and backslashes refused on Unicode scalars; segments split on UTF-8 bytes.
  const safe = body(store, "static func isSafeRelativePath(");
  assertStringIncludes(
    safe,
    "path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F",
  );
  assertStringIncludes(safe, `path.utf8.split(separator: UInt8(ascii: "/")`);
  assertStringIncludes(
    body(store, "static func isSha256("),
    "(48...57).contains($0) || (97...102).contains($0)",
  );
  // Caps, refused as invalid before any download.
  assertStringIncludes(store, "static let maxFiles = 20_000");
  assertStringIncludes(store, "static let maxTotalBytes: Int64 = 512 * 1024 * 1024");
  assertStringIncludes(store, "return 30 + Double(size) / 32_768");
  // Release policy: downgrade and native gate, after the trust check, before the download.
  const init = body(store, "init(baseUrl: String?, headers: JSObject?, manifest: JSObject?)");
  assert(
    init.indexOf("checkTrust(") <
      init.indexOf(
        "checkRelease(sequence: sequence, minNative: minNative, nativeFingerprint: nativeFingerprint)",
      ),
    init,
  );
  assertStringIncludes(
    init,
    `let nativeFingerprint = try DenextOtaStore.fingerprintField(manifest["nativeFingerprint"])`,
  );
  const release = body(store, "static func checkRelease(");
  assertStringIncludes(release, `code: "downgrade"`);
  assertStringIncludes(release, "guard sequence >= highest");
  assertStringIncludes(release, `code: "native_too_old"`);
  // The native gate: only when both the manifest and the binary carry a fingerprint.
  assertStringIncludes(
    release,
    "if let wanted = nativeFingerprint, let binary = binaryFingerprint, wanted != binary {",
  );
  assertStringIncludes(release, `code: "native_mismatch"`);
  assertStringIncludes(store, `static let nativeFingerprintInfoKey = "DenextNativeFingerprint"`);
  assertStringIncludes(
    body(store, "static func fingerprintField("),
    `guard let text = value as? String, isSha256(text) else {`,
  );
  assertStringIncludes(store, `Bundle.main.infoDictionary?["CFBundleVersion"]`);
  // The accepted sequence is recorded when a version is staged and survives reset.
  assertStringIncludes(body(store, "func stage("), "forKey: Key.sequence");
  assert(!body(store, "func reset()").includes("Key.sequence"));
  // Bounded streaming downloads, same-origin redirects only, headers re-applied only there.
  assertStringIncludes(store, "guard transfer.received <= transfer.file.size else");
  assertStringIncludes(store, "response.expectedContentLength > transfer.file.size");
  const redirect = body(store, "        willPerformHTTPRedirection response: HTTPURLResponse,");
  assert(redirect.length > 0);
  assertStringIncludes(store, "guard isSameOrigin(request.url) else");
  assertStringIncludes(store, "return completionHandler(nil)");
  // Resume: verified files are kept, other versions' attempts are swept.
  assertStringIncludes(store, "A failure keeps the verified files for the next attempt.");
  assert(
    !body(store, "func download(_ request: ApplyRequest)").includes("removeItem(at: partial)"),
  );
  assertStringIncludes(store, "values.isExcludedFromBackup = true");
  // Trials: two attempts, a configurable boot timeout.
  assertStringIncludes(store, "static let maxTrialAttempts = 2");
  assertStringIncludes(
    body(store, "func prepareLaunch()"),
    "trialAttempts < DenextOtaStore.maxTrialAttempts",
  );
  assertStringIncludes(body(store, "func beginTrial("), "trialAttempts = 1");
  assertStringIncludes(store, `static let bootTimeoutInfoKey = "DenextOtaBootTimeout"`);
  // The plugin: foreground-only watchdog, page-bound boot, cancellable download.
  assertStringIncludes(plugin, "UIApplication.willResignActiveNotification");
  assertStringIncludes(plugin, "UIApplication.didBecomeActiveNotification");
  assertStringIncludes(body(plugin, "@objc func booted("), "version == nil || version == pending");
  assertStringIncludes(body(plugin, "@objc func reset("), "self.downloadTask?.cancel()");
  assertStringIncludes(plugin, `"switched": false`);
  assertStringIncludes(plugin, `"staged": false`);
  assertStringIncludes(plugin, "DenextOtaStore.applyDeadline");
});

Deno.test("native templates: path, cap, release and trial rules (Android)", () => {
  const store = OTA_ANDROID_FILES["DenextOtaStore.java"];
  const plugin = OTA_ANDROID_FILES["DenextOtaPlugin.java"];
  assertStringIncludes(
    body(store, "static boolean isSafeRelativePath("),
    "c < 0x20 || c == 0x7f || c == '\\\\'",
  );
  assertStringIncludes(store, "static final int MAX_FILES = 20_000;");
  assertStringIncludes(store, "static final long MAX_TOTAL_BYTES = 512L * 1024 * 1024;");
  assertStringIncludes(store, "return 30_000 + size * 1000 / 32_768;");
  const parse = plugin.slice(
    plugin.indexOf("private static DenextOtaStore.ApplyRequest parseApplyRequest("),
  );
  assert(
    parse.indexOf("store.checkTrust(") <
      parse.indexOf("store.checkRelease(sequence, minNative, nativeFingerprint);"),
    parse,
  );
  assertStringIncludes(
    parse,
    `String nativeFingerprint = DenextOtaStore.fingerprintField(manifest.opt("nativeFingerprint"));`,
  );
  const release = body(store, "void checkRelease(");
  assertStringIncludes(release, `new OtaException("downgrade"`);
  assertStringIncludes(release, "if (sequence < highest)");
  assertStringIncludes(release, `new OtaException("native_too_old"`);
  // The native gate: only when both the manifest and the binary carry a fingerprint.
  assertStringIncludes(
    release,
    "if (nativeFingerprint != null && binary != null && !nativeFingerprint.equals(binary)) {",
  );
  assertStringIncludes(release, `"native_mismatch"`);
  assertStringIncludes(store, `NATIVE_FINGERPRINT_META = "dev.denext.native.FINGERPRINT"`);
  assertStringIncludes(
    body(store, "String binaryFingerprint("),
    "info.metaData.get(NATIVE_FINGERPRINT_META)",
  );
  assertStringIncludes(
    body(store, "static String fingerprintField("),
    "if (value instanceof String && isSha256((String) value)) {",
  );
  assertStringIncludes(
    store,
    "PackageInfoCompat.getLongVersionCode(context.getPackageManager().getPackageInfo(",
  );
  assertStringIncludes(
    body(store, "synchronized void stage("),
    "editor.putLong(KEY_SEQUENCE, sequence);",
  );
  assert(!body(store, "synchronized void reset()").includes("KEY_SEQUENCE"));
  // Streaming with a cap, manual redirects within the origin only.
  assertStringIncludes(store, "connection.setInstanceFollowRedirects(false);");
  assertStringIncludes(store, "if (!isSameOrigin(next, base))");
  assertStringIncludes(store, "if (received > file.size)");
  // No-backup storage with a migration from files/, deletes off the main thread.
  assertStringIncludes(store, `new File(context.getNoBackupFilesDir(), "denext-ota")`);
  assertStringIncludes(store, "private void migrateLegacyRoot()");
  assertStringIncludes(body(store, "private static void discard("), "JANITOR.execute(");
  assertStringIncludes(body(store, "synchronized void reset()"), "discard(root);");
  // The pool is stopped before anything is renamed or deleted, on every path.
  assertStringIncludes(
    store,
    "// Always first: no worker may still be writing when anything is renamed or deleted.",
  );
  assertStringIncludes(
    body(store, "private void stop(ExecutorService pool)"),
    "pool.shutdownNow();",
  );
  // Trials and the plugin lifecycle.
  assertStringIncludes(
    body(store, "private File prepareLaunch()"),
    "attempts < MAX_TRIAL_ATTEMPTS",
  );
  assertStringIncludes(store, `BOOT_TIMEOUT_META = "dev.denext.ota.BOOT_TIMEOUT"`);
  assertStringIncludes(body(plugin, "protected void handleOnDestroy()"), "cancelWatchdog();");
  assertStringIncludes(body(plugin, "protected void handleOnPause()"), "pauseWatchdog();");
  assertStringIncludes(body(plugin, "protected void handleOnResume()"), "resumeWatchdog();");
  assertStringIncludes(
    body(plugin, "public void booted("),
    "version != null && !version.equals(pending)",
  );
  assertStringIncludes(body(plugin, "public void reset("), "store().cancelDownload();");
  assertStringIncludes(plugin, `result.put("switched", false);`);
  assertStringIncludes(plugin, `result.put("staged", false);`);
});
