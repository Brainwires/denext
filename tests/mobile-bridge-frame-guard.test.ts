// The main-frame guard on the native bridge (src/build/bridge-frame-guard-native-template.ts):
// every generated DenextBridgeViewController.swift (OTA, auth-session-only, the registering-only
// one, and every composition) replaces Capacitor's `bridge` script-message handler with one that
// forwards only main-frame messages, installed before any plugin registration. An unguarded
// bridge an earlier denext wrote is upgraded in place; a 2.10.0 denext never rewrites a guarded
// one (every bridge family's generation is above 2.10.0's). `denext mobile doctor` flags an
// unguarded bridge and Android's legacy (every-frame) bridge.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  FRAME_GUARD_IMPORT,
  FRAME_GUARD_INSTALL,
  FRAME_GUARD_SWIFT,
  withFrameGuard,
} from "../src/build/bridge-frame-guard-native-template.ts";
import { EXPORT_ROUTER_SWIFT } from "../src/build/bridge-export-router-native-template.ts";
import {
  bridgeViewControllerSource,
  type NativeFeature,
} from "../src/build/mobile-native-install.ts";
import { renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { addAuthSessionToProject } from "../src/build/mobile-auth-session-install.ts";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import { addSettingsToProject } from "../src/build/mobile-settings-install.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const GUARD_CLASS = "final class DenextMainFrameBridgeGuard: NSObject, WKScriptMessageHandler";
const SUPER = "        super.capacitorDidLoad()\n";

/** The bridge variants: OTA alone, OTA composed, auth-session alone, registering-only ones. */
const VARIANTS: readonly (readonly NativeFeature[])[] = [
  ["ota"],
  ["ota", "auth-session", "settings", "storage"],
  ["auth-session"],
  ["settings"],
  ["share-receive", "widgets", "native-modules"],
  ["storage"],
];

/** The generation 2.10.0 wrote for each bridge family (its marker constants at v2.10.0). */
const V2_10_0_GENERATIONS: Readonly<Record<string, number>> = {
  ota: 4,
  "auth-session": 1,
  "app-extension": 1,
};

Deno.test("frame guard: every bridge variant installs it first and carries it once", async () => {
  for (const set of VARIANTS) {
    const label = set.join("+");
    const text = await bridgeViewControllerSource(new Set(set));
    assertStringIncludes(text, "import UIKit\n" + FRAME_GUARD_IMPORT, label);
    assertStringIncludes(text, SUPER + FRAME_GUARD_INSTALL, label);
    assertEquals(text.split(GUARD_CLASS).length, 2, label);
    // The guard class, then the export router (bridge-export-router-native-template.ts).
    assert(text.endsWith(FRAME_GUARD_SWIFT + EXPORT_ROUTER_SWIFT), label);
    // Installed before any plugin registration (none is callable before the guard is in place).
    const install = text.indexOf(FRAME_GUARD_INSTALL);
    const firstRegistration = text.search(/registerPluginInstance|DenextNativeModules\.register/);
    assert(firstRegistration === -1 || install < firstRegistration, label);
    // A marker the 2.10.0 installers see as newer, so they keep the file instead of downgrading.
    const [, family, generation] = /^\/\/ denext-([a-z-]+)-template: (\d+) /.exec(text) ?? [];
    assert(family in V2_10_0_GENERATIONS, label);
    assert(Number(generation) > V2_10_0_GENERATIONS[family], `${label}: ${family} ${generation}`);
  }
});

Deno.test("frame guard: the Swift drops non-main-frame messages and forwards the rest", () => {
  // Checks the source's load-bearing parts (it is compiled only in an app).
  assertStringIncludes(FRAME_GUARD_SWIFT, "guard message.frameInfo.isMainFrame else {");
  assertStringIncludes(
    FRAME_GUARD_SWIFT,
    "target?.userContentController(userContentController, didReceive: message)",
  );
  assertStringIncludes(FRAME_GUARD_SWIFT, "[denext] refused a native plugin call from a non-main");
  // It takes Capacitor's handler name, removing Capacitor's registration first (WebKit throws
  // on a duplicate name).
  const remove = FRAME_GUARD_SWIFT.indexOf("removeScriptMessageHandler(forName: handlerName)");
  const add = FRAME_GUARD_SWIFT.indexOf("controller.add(DenextMainFrameBridgeGuard(");
  assert(remove > 0 && add > remove);
  assertStringIncludes(FRAME_GUARD_SWIFT, 'private static let handlerName = "bridge"');
  // Weak: the content controller retains its handlers, so a strong reference would be a cycle.
  assertStringIncludes(FRAME_GUARD_SWIFT, "private weak var target: WKScriptMessageHandler?");
  // No backtick (the String.raw literal could not hold one) and no stray interpolation.
  assert(!FRAME_GUARD_SWIFT.includes("`") && !FRAME_GUARD_SWIFT.includes("${"));
});

Deno.test("frame guard: a template without its anchors is refused", () => {
  assertThrows(() => withFrameGuard("class X {}\n"), Error, "no place for the frame guard");
  assertThrows(() => withFrameGuard("import UIKit\nclass X {}\n"), Error);
});

// ---- upgrade of an unguarded bridge ----------------------------------------------------------

const STOCK_STORYBOARD = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">
    <scenes><scene sceneID="tne-QT-ifu"><objects>
        <viewController id="BYZ-38-t0r" customClass="CAPBridgeViewController" customModule="Capacitor" sceneMemberID="viewController"/>
    </objects></scene></scenes>
</document>
`;

/** A stock Capacitor 8 iOS project (no android/). */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_frame_guard_" });
  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", webDir: "out" }),
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift":
      "import UIKit\nimport Capacitor\nlet root = CAPBridgeViewController()\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** `text`'s body without the guard, under an intact `family` marker of `generation`. */
async function unguarded(family: string, generation: number, text: string): Promise<string> {
  const body = text.slice(text.indexOf("\n") + 1)
    .replace(FRAME_GUARD_IMPORT, "")
    .replace(FRAME_GUARD_INSTALL, "")
    .replace(FRAME_GUARD_SWIFT, "");
  assert(!body.includes("DenextMainFrameBridgeGuard"));
  return await renderMarkedTemplate(family, generation, body);
}

const INSTALLERS = [
  { name: "add-ota", family: "ota", run: addOtaToProject },
  { name: "add auth-session", family: "auth-session", run: addAuthSessionToProject },
  { name: "add permissions", family: "app-extension", run: addSettingsToProject },
] as const;

for (const { name, family, run } of INSTALLERS) {
  Deno.test(`frame guard: ${name} upgrades the unguarded bridge an earlier denext wrote`, async () => {
    const dir = await project();
    try {
      await run({ dir });
      const current = await Deno.readTextFile(join(dir, BRIDGE));
      const old = await unguarded(family, V2_10_0_GENERATIONS[family], current);
      await Deno.writeTextFile(join(dir, BRIDGE), old);
      // The doctor flags it in both profiles.
      for (const profile of ["store", "release"] as const) {
        const report = await runMobileDoctor({ root: dir, profile });
        const hit = report.findings.filter((f) => f.check === "bridge-frame-guard");
        assertEquals(hit.length, 1, profile);
        assertEquals(hit[0].level, "error");
      }
      const again = await run({ dir });
      assertEquals(again.kept, []);
      assert(again.upgraded.includes(BRIDGE), again.upgraded.join());
      assertEquals(await Deno.readTextFile(join(dir, BRIDGE)), current);
      const after = await runMobileDoctor({ root: dir, profile: "release" });
      assertEquals(after.findings.filter((f) => f.check === "bridge-frame-guard"), []);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("frame guard: an edited unguarded bridge is kept (and still flagged)", async () => {
  const dir = await project();
  try {
    await addAuthSessionToProject({ dir });
    const current = await Deno.readTextFile(join(dir, BRIDGE));
    const edited = (await unguarded("auth-session", 1, current)).replace(
      SUPER,
      SUPER + '        print("mine")\n',
    );
    await Deno.writeTextFile(join(dir, BRIDGE), edited);
    const again = await addAuthSessionToProject({ dir });
    assert(again.kept.includes(BRIDGE));
    assertEquals(await Deno.readTextFile(join(dir, BRIDGE)), edited);
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    assertStringIncludes(
      report.findings.find((f) => f.check === "bridge-frame-guard")!.fix,
      "install(on: bridge)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor --release: android.useLegacyBridge is an error", async () => {
  const dir = await project();
  try {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "dev.example", webDir: "out", android: { useLegacyBridge: true } }),
    );
    const release = await runMobileDoctor({ root: dir, profile: "release" });
    const hit = release.findings.filter((f) => f.check === "legacy-bridge");
    assertEquals(hit.length, 1);
    assertEquals(hit[0].level, "error");
    assertStringIncludes(hit[0].message, "every frame");
    const store = await runMobileDoctor({ root: dir, profile: "store" });
    assertEquals(store.findings.filter((f) => f.check === "legacy-bridge"), []);
    // No DenextBridgeViewController at all: nothing to upgrade, so no bridge-frame-guard finding.
    assertEquals(release.findings.filter((f) => f.check === "bridge-frame-guard"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
