// `denext mobile add-ota` (src/build/mobile-ota-install.ts): installs the DenextOta native
// templates into a Capacitor 8 project, wires the stock bridge view controller and
// MainActivity, embeds the OTA public key, reports customised ones as manual steps, and is
// idempotent.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import { OTA_ANDROID_FILES, OTA_IOS_FILES } from "../src/build/ota-native-templates.ts";
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
  assertStringIncludes(
    store,
    '"denext-ota-v1\\n\\(version)\\n\\(required ? "1" : "0")\\n\\(sha256Hex(Data(notes.utf8)))"',
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
  assertStringIncludes(
    store,
    `static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2"]`,
  );
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
    `"denext-ota-v1\\n" + version + "\\n" + (required ? "1" : "0") + "\\n"`,
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
  assertStringIncludes(
    policy,
    `"https".equalsIgnoreCase(base.getScheme()) && !LOOPBACK_HOSTS.contains(host)`,
  );
  assertStringIncludes(
    store,
    `throw new OtaException("signature", "The manifest signature is missing or does not verify.")`,
  );
  assertStringIncludes(
    store,
    `Arrays.asList("localhost", "127.0.0.1", "::1", "[::1]", "10.0.2.2")`,
  );
});
