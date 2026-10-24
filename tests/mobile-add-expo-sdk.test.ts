// `denext mobile add calendar | contacts | print | brightness` (src/build/mobile-expo-sdk-install.ts):
// the pinned npm plugin as before, plus denext's own plugin beside it for the Expo calls that
// plugin has no call for: the Swift file in the app target (registered by the shared bridge view
// controller) and the Java file(s) registered from MainActivity; the four compose with each other,
// with the other denext features and with OTA in either order; a second run changes nothing; an
// edited template is kept; the embedded templates carry their marker and type-check against
// UIKit / EventKit / Contacts and a Capacitor stub where the iOS SDK is installed. No test spawns
// a real install.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import { addExpoSdkPluginToProject } from "../src/build/mobile-expo-sdk-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
  type NativeFeature,
} from "../src/build/mobile-native-install.ts";
import {
  BRIGHTNESS_ANDROID_FILES,
  BRIGHTNESS_IOS_FILES,
  CALENDAR_ANDROID_FILES,
  CALENDAR_IOS_FILES,
  CONTACTS_ANDROID_FILES,
  CONTACTS_IOS_FILES,
  EXPO_SDK_TEMPLATE_VERSIONS,
  type ExpoSdkFamily,
  isPristineExpoSdkTemplate,
  PRINT_ANDROID_FILES,
  PRINT_ANDROID_PDF_FILES,
  PRINT_IOS_FILES,
  renderExpoSdkTemplate,
} from "../src/build/expo-sdk-native-templates.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";

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

const STOCK_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

/** Each family: its plugin class, npm package and Android folder. */
const FAMILIES: Record<ExpoSdkFamily, { cls: string; npm: string; pkg: string }> = {
  calendar: { cls: "DenextCalendarPlugin", npm: "@ebarooni/capacitor-calendar", pkg: "calendar" },
  contacts: { cls: "DenextContactsPlugin", npm: "@capgo/capacitor-contacts", pkg: "contacts" },
  print: { cls: "DenextPrintPlugin", npm: "@capgo/capacitor-printer", pkg: "print" },
  brightness: {
    cls: "DenextBrightnessPlugin",
    npm: "@capacitor-community/screen-brightness",
    pkg: "brightness",
  },
};
const ALL = Object.keys(FAMILIES) as ExpoSdkFamily[];

const iosPath = (family: ExpoSdkFamily) => `ios/App/App/${FAMILIES[family].cls}.swift`;
const androidPath = (family: ExpoSdkFamily) =>
  `android/app/src/main/java/dev/denext/${FAMILIES[family].pkg}/${FAMILIES[family].cls}.java`;
const PDF_WRITER = "android/app/src/main/java/android/print/DenextPdfWriter.java";

/** A stock Capacitor 8 project with ios/ and android/; `files` overrides. */
async function inProject(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_expo_sdk_" });
  const all: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/Info.plist": "<plist><dict></dict></plist>\n",
    [MANIFEST]: "<manifest><application /></manifest>\n",
    [MAIN_ACTIVITY]: STOCK_ACTIVITY,
    ...files,
  };
  try {
    for (const [path, content] of Object.entries(all)) {
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

for (const family of ALL) {
  Deno.test(`mobile add ${family}: the pinned plugin plus denext's beside it, registered, idempotent`, async () => {
    await inProject({}, async (dir) => {
      const { run, lines } = fakeRunner();
      const report = await addMobileCapabilities({ capabilities: [family], cwd: dir, run });
      assertStringIncludes(lines().join("\n"), FAMILIES[family].npm, "the npm plugin stays");
      for (const path of [iosPath(family), androidPath(family), BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
        assert(report.written.includes(path), `${path} written`);
      }
      const ios = await read(dir, iosPath(family));
      const version = EXPO_SDK_TEMPLATE_VERSIONS[family];
      assert(ios.startsWith(`// denext-${family}-template: ${version} sha256=`));
      assertStringIncludes(ios, `jsName = "${FAMILIES[family].cls.replace(/Plugin$/, "")}"`);
      const android = await read(dir, androidPath(family));
      assertStringIncludes(
        android,
        `@CapacitorPlugin(name = "${FAMILIES[family].cls.replace(/Plugin$/, "")}")`,
      );
      assertEquals(await read(dir, BRIDGE), await bridgeViewControllerSource(new Set([family])));
      assertStringIncludes(
        await read(dir, BRIDGE),
        `registerPluginInstance(${FAMILIES[family].cls}())`,
      );
      assertEquals(
        await read(dir, MAIN_ACTIVITY),
        await mainActivitySource("com.example.app", new Set([family])),
      );
      assertStringIncludes(await read(dir, PBXPROJ), `${FAMILIES[family].cls}.swift`);
      const again = await addMobileCapabilities({ capabilities: [family], cwd: dir, run });
      assertEquals(again.written, []);
    });
  });
}

Deno.test("mobile add print: the PDF writer goes in android.print (hidden callback constructors)", async () => {
  await inProject({}, async (dir) => {
    const report = await addExpoSdkPluginToProject("print", { dir });
    assert(report.written.includes(PDF_WRITER));
    const writer = await read(dir, PDF_WRITER);
    assert(writer.startsWith(`// denext-print-template: ${EXPO_SDK_TEMPLATE_VERSIONS.print} `));
    assertStringIncludes(writer, "package android.print;");
    assertStringIncludes(writer, "new PrintDocumentAdapter.LayoutResultCallback()");
    assertStringIncludes(
      await read(dir, androidPath("print")),
      "import android.print.DenextPdfWriter;",
    );
  });
});

Deno.test("mobile add brightness: WRITE_SETTINGS declared, asked for at run time", async () => {
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["brightness"], cwd: dir, run });
    assertStringIncludes(await read(dir, MANIFEST), "android.permission.WRITE_SETTINGS");
    const android = await read(dir, androidPath("brightness"));
    assertStringIncludes(android, "Settings.ACTION_MANAGE_WRITE_SETTINGS");
    assertStringIncludes(android, "SCREEN_BRIGHTNESS_MODE_MANUAL");
  });
});

Deno.test("calendar + contacts + print + brightness: one bridge and one MainActivity, either order", async () => {
  const bridges: string[] = [];
  const activities: string[] = [];
  for (const order of [ALL, [...ALL].reverse()]) {
    await inProject({}, async (dir) => {
      for (const family of order) await addExpoSdkPluginToProject(family, { dir });
      bridges.push(await read(dir, BRIDGE));
      activities.push(await read(dir, MAIN_ACTIVITY));
      const pbx = await read(dir, PBXPROJ);
      for (const family of ALL) {
        assertEquals(pbx.split(`${FAMILIES[family].cls}.swift in Sources */`).length, 3, family);
      }
    });
  }
  assertEquals(bridges[0], bridges[1]);
  assertEquals(bridges[0], await bridgeViewControllerSource(new Set(ALL)));
  assertEquals(activities[0], activities[1]);
  assertEquals(activities[0], await mainActivitySource("com.example.app", new Set(ALL)));
  for (const family of ALL) {
    assertStringIncludes(activities[0], `registerPlugin(${FAMILIES[family].cls}.class);`);
    assertStringIncludes(
      activities[0],
      `import dev.denext.${FAMILIES[family].pkg}.${FAMILIES[family].cls};`,
    );
  }
});

Deno.test("mobile add calendar: an unedited OTA bridge with other features is recomposed", async () => {
  // The bridge an earlier run composed for OTA + the native menu: recognised as this release's
  // (from the registrations it carries) and recomposed with the calendar plugin added.
  const before: NativeFeature[] = ["ota", "context-menu"];
  await inProject({
    [BRIDGE]: await bridgeViewControllerSource(new Set(before)),
    "ios/App/App/DenextOtaPlugin.swift": "// ota\n",
    "ios/App/App/DenextContextMenuPlugin.swift": "// menu\n",
  }, async (dir) => {
    const report = await addExpoSdkPluginToProject("calendar", { dir });
    assert(report.written.includes(BRIDGE), report.manual.join("\n"));
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set([...before, "calendar"])),
    );
  });
});

Deno.test("mobile add contacts: an edited plugin is kept; --force replaces it", async () => {
  await inProject({}, async (dir) => {
    await addExpoSdkPluginToProject("contacts", { dir });
    const path = androidPath("contacts");
    const edited = (await read(dir, path)) + "\n// mine\n";
    await Deno.writeTextFile(join(dir, path), edited);
    const kept = await addExpoSdkPluginToProject("contacts", { dir });
    assert(kept.kept.includes(path));
    assertEquals(await read(dir, path), edited);
    const forced = await addExpoSdkPluginToProject("contacts", { dir, force: true });
    assert(forced.written.includes(path));
    assert(!(await read(dir, path)).includes("// mine"));
  });
});

/** Every embedded template, by family. */
const TEMPLATES: Record<ExpoSdkFamily, Readonly<Record<string, string>>[]> = {
  calendar: [CALENDAR_IOS_FILES, CALENDAR_ANDROID_FILES],
  contacts: [CONTACTS_IOS_FILES, CONTACTS_ANDROID_FILES],
  print: [PRINT_IOS_FILES, PRINT_ANDROID_FILES, PRINT_ANDROID_PDF_FILES],
  brightness: [BRIGHTNESS_IOS_FILES, BRIGHTNESS_ANDROID_FILES],
};

Deno.test("the embedded templates render with an intact marker of their own family", async () => {
  for (const family of ALL) {
    for (const files of TEMPLATES[family]) {
      for (const text of Object.values(files)) {
        const rendered = await renderExpoSdkTemplate(family, text);
        assert(await isPristineExpoSdkTemplate(family, rendered), family);
        assert(!(await isPristineExpoSdkTemplate(family, rendered + " ")), family);
        const other = family === "print" ? "calendar" : "print";
        assert(!(await isPristineExpoSdkTemplate(other, rendered)), `${family} is not ${other}`);
      }
    }
  }
});

// ---- iOS: the Swift type-checks against the iOS SDK and a Capacitor stub ----------------------

const has = (tool: string, args = ["-version"]): boolean => {
  try {
    return new Deno.Command(tool, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
};

const IOS_SDK = Deno.build.os === "darwin" &&
  has("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);

/** The parts of Capacitor 8's Swift API the plugins use (signatures as Capacitor declares them). */
const CAPACITOR_STUB = `import Foundation
import UIKit
import WebKit

public protocol JSValue {}
extension String: JSValue {}
extension Bool: JSValue {}
extension Int: JSValue {}
extension Double: JSValue {}
extension NSNumber: JSValue {}
extension NSNull: JSValue {}
extension Array: JSValue {}
extension Dictionary: JSValue where Key == String, Value == JSValue {}
public typealias JSObject = [String: JSValue]
public typealias JSArray = [JSValue]
public typealias PluginCallResultData = [String: Any]
public let CAPPluginReturnPromise = "promise"
public class CAPPluginMethod: NSObject {
    public init(name: String, returnType: String) {}
}
@objc public protocol CAPBridgeProtocol: NSObjectProtocol {
    var viewController: UIViewController? { get }
    var webView: WKWebView? { get }
}
public protocol CAPBridgedPlugin {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}
open class CAPPluginCall: NSObject {
    public func getString(_ key: String) -> String? { nil }
    public func getDouble(_ key: String) -> Double? { nil }
    public func getInt(_ key: String) -> Int? { nil }
    public func getBool(_ key: String) -> Bool? { nil }
    public func getArray(_ key: String) -> JSArray? { nil }
    public func getObject(_ key: String) -> JSObject? { nil }
    public func resolve(_ data: PluginCallResultData = [:]) {}
    public func reject(_ message: String, _ code: String? = nil, _ error: Error? = nil, _ data: PluginCallResultData? = nil) {}
}
open class CAPPlugin: NSObject {
    public weak var bridge: CAPBridgeProtocol?
    open func load() {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?, retainUntilConsumed: Bool = false) {}
}
`;

for (const family of ALL) {
  Deno.test({
    name: `${family}: the Swift plugin type-checks against the iOS SDK and a Capacitor stub`,
    ignore: !IOS_SDK,
    async fn() {
      const dir = await Deno.makeTempDir({ prefix: "denext_expo_sdk_swift_" });
      try {
        const stub = join(dir, "Capacitor.swift");
        await Deno.writeTextFile(stub, CAPACITOR_STUB);
        const files = [stub];
        for (const [name, text] of Object.entries(TEMPLATES[family][0])) {
          const path = join(dir, name);
          // The stub stands in for the Capacitor module, compiled into the same module.
          await Deno.writeTextFile(path, text.replace("@preconcurrency import Capacitor\n", ""));
          files.push(path);
        }
        const out = await new Deno.Command("xcrun", {
          args: [
            "--sdk",
            "iphoneos",
            "swiftc",
            "-typecheck",
            "-swift-version",
            "5",
            "-target",
            "arm64-apple-ios15.0",
            ...files,
          ],
          stdout: "piped",
          stderr: "piped",
        }).output();
        const errors = new TextDecoder().decode(out.stderr);
        assert(out.success, errors);
        assert(!errors.includes("warning:"), errors);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}

Deno.test("print templates SECURITY (AU6-L6/L7): no app-private file reaches a printer or the PDF WebView", () => {
  const swift = PRINT_IOS_FILES["DenextPrintPlugin.swift"];
  // printToPrinter (no dialog) takes only a file in Documents, Caches or tmp, symlinks resolved.
  assertStringIncludes(swift, "guard let file = DenextPrintPlugin.printableFile(path) else {");
  assertStringIncludes(swift, "static func printableFile(_ path: String) -> URL? {");
  assertStringIncludes(swift, "url.resolvingSymlinksInPath().standardizedFileURL.path");
  assert(
    !swift.includes("controller.printingItem = path.hasPrefix"),
    "the raw path is never printed",
  );
  const java = PRINT_ANDROID_FILES["DenextPrintPlugin.java"];
  assertStringIncludes(java, "webView.getSettings().setAllowFileAccess(false);");
  assertStringIncludes(java, "webView.getSettings().setAllowContentAccess(false);");
});
