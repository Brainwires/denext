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
import { addExportRoutesToProject } from "../src/build/mobile-export-routes-install.ts";
import {
  mainActivitySource,
  WEBKIT_DEPENDENCY,
  withWebkitDependency,
} from "../src/build/mobile-native-install.ts";
import { needsFrameGuardOptOut, planCapacitor } from "../packages/migrate/src/migrate-capacitor.ts";

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
  const add = FRAME_GUARD_SWIFT.indexOf("controller.add(guardHandler, name: handlerName)");
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

// ---- AU6-L8: the origin guard ------------------------------------------------------------------

Deno.test("frame guard SECURITY (AU6-L8): iOS refuses a main frame on another origin than the app's", () => {
  // Every message's origin is compared with the allowed set (unless the config turns it off).
  assertStringIncludes(
    FRAME_GUARD_SWIFT,
    "if let allowed = allowedOrigins, !allowed.contains(from) {",
  );
  const forward = FRAME_GUARD_SWIFT.indexOf(
    "target?.userContentController(userContentController, didReceive: message)",
  );
  assert(FRAME_GUARD_SWIFT.indexOf("!allowed.contains(from)") < forward);
  // The allowed set: Capacitor's local URL, server.url only in a debug build, the config's list.
  assertStringIncludes(FRAME_GUARD_SWIFT, "let pluginConfig = config.getPluginConfig(configId)");
  assertStringIncludes(FRAME_GUARD_SWIFT, 'private static let configId = "DenextBridge"');
  assertStringIncludes(
    FRAME_GUARD_SWIFT,
    'guard pluginConfig.getBoolean("frameGuard", true) else { return nil }',
  );
  assertStringIncludes(
    FRAME_GUARD_SWIFT,
    "if let local = origin(of: config.localURL) { origins.insert(local) }",
  );
  assertStringIncludes(
    FRAME_GUARD_SWIFT,
    "        #if DEBUG\n        if let server = origin(of: config.serverURL) { origins.insert(server) }\n        #endif\n",
  );
  assertStringIncludes(FRAME_GUARD_SWIFT, 'pluginConfig.getArray("allowedOrigins", [])');
});

Deno.test("frame guard SECURITY (AU6-L8): Android narrows Capacitor's bridge to the app's origin", async () => {
  const activity = await mainActivitySource("p", new Set());
  // Installed right after the bridge is built, before the first page commits.
  assertStringIncludes(
    activity,
    "        if (bridge != null) bridge.addWebViewListener(new RendererRecovery(this));\n" +
      "        // denext: native plugin calls only from the app's own origin (see BridgeOriginGuard).\n" +
      "        if (bridge != null) BridgeOriginGuard.install(this, bridge);\n",
  );
  assertStringIncludes(activity, "static final class BridgeOriginGuard {");
  assertStringIncludes(activity, 'if (!config.getBoolean("frameGuard", true)) return;');
  assertStringIncludes(
    activity,
    "androidx.webkit.WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);",
  );
  assertStringIncludes(activity, "allowedOrigins(activity, bridge, config), listener);");
  assertStringIncludes(activity, "rules.add(localOrigin(bridge));");
  assertStringIncludes(
    activity,
    "String server = debuggable ? origin(bridge.getServerUrl()) : null;",
  );
  assertStringIncludes(activity, "if (isMainFrame && data != null) {");
  // A gradle dependency the app module needs, added once.
  const gradle = "android {}\ndependencies {\n    implementation 'x:y:1'\n}\n";
  const once = withWebkitDependency(gradle)!;
  assertStringIncludes(once, `dependencies {\n    ${WEBKIT_DEPENDENCY}\n`);
  assertEquals(withWebkitDependency(once), once);
  assertEquals(withWebkitDependency("android {}\n"), null);
});

Deno.test("frame guard (AU6-L8): recomposing MainActivity adds androidx.webkit to the app's gradle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_origin_guard_" });
  try {
    const java = join(dir, "android/app/src/main/java/dev/example/MainActivity.java");
    await Deno.mkdir(join(java, ".."), { recursive: true });
    await Deno.writeTextFile(
      java,
      "package dev.example;\n\nimport com.getcapacitor.BridgeActivity;\n\n" +
        "public class MainActivity extends BridgeActivity {}\n",
    );
    await Deno.writeTextFile(
      join(dir, "android/app/build.gradle"),
      "apply plugin: 'com.android.application'\n\ndependencies {\n}\n",
    );
    await addExportRoutesToProject({ dir });
    assertStringIncludes(await Deno.readTextFile(java), "BridgeOriginGuard.install(this, bridge);");
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "android/app/build.gradle")),
      WEBKIT_DEPENDENCY,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile doctor (AU6-L8): server.url / allowNavigation with the origin guard on, or turned off", async () => {
  const dir = await project();
  const doctor = async (config: Record<string, unknown>) => {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "dev.example", webDir: "out", ...config }),
    );
    return (await runMobileDoctor({ root: dir, profile: "release" })).findings
      .filter((f) => f.check === "bridge-origin-guard");
  };
  try {
    assertEquals(await doctor({}), []);
    const on = await doctor({ server: { allowNavigation: ["auth.example.com"] } });
    assertEquals(on.length, 1);
    assertEquals(on[0].level, "warning");
    assertStringIncludes(on[0].message, "https://auth.example.com");
    assertStringIncludes(on[0].fix, "plugins.DenextBridge.allowedOrigins");
    assertEquals(
      await doctor({
        server: { allowNavigation: ["auth.example.com"] },
        plugins: { DenextBridge: { allowedOrigins: ["https://auth.example.com"] } },
      }),
      [],
    );
    const off = await doctor({
      server: { url: "https://app.example.com" },
      plugins: { DenextBridge: { frameGuard: false } },
    });
    assertEquals(off.length, 1);
    assertStringIncludes(off[0].message, "frameGuard is false");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("migrate (AU6-L8): a kept config that loads a hosted server.url opts out of the origin guard", async () => {
  assert(needsFrameGuardOptOut({ server: { url: "https://app.example.com" } }));
  assert(!needsFrameGuardOptOut({ server: { url: "http://localhost:3000" } }));
  assert(!needsFrameGuardOptOut({}));
  assert(
    !needsFrameGuardOptOut({
      server: { url: "https://app.example.com" },
      plugins: { DenextBridge: { allowedOrigins: ["https://app.example.com"] } },
    }),
  );
  const dir = await Deno.makeTempDir({ prefix: "denext_migrate_guard_" });
  try {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({
        appId: "dev.example",
        webDir: "out",
        server: { url: "https://app.example.com" },
      }),
    );
    const plan = await planCapacitor(
      {
        dir,
        deps: {},
        cli: "denext",
        run: "deno task",
        pm: null,
        appName: "x",
        kind: "spa",
        options: { platforms: [] },
      } as unknown as Parameters<typeof planCapacitor>[0],
    );
    assertEquals(plan.frameGuardOptOut, "capacitor.config.json");
    assert(plan.info.review.some((r) => r.reason.includes("frameGuard: false")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const IOS_SDK_FOR_GUARD = Deno.build.os === "darwin" &&
  new Deno.Command("xcrun", {
    args: ["--sdk", "iphoneos", "--show-sdk-path"],
    stdout: "null",
    stderr: "null",
  })
    .outputSync().success;

Deno.test({
  name:
    "frame guard (AU6-L8): the Swift guard type-checks against WebKit and a Capacitor stub, debug and release",
  ignore: !IOS_SDK_FOR_GUARD,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_guard_swift_" });
    try {
      await Deno.copyFile(
        new URL("./fixtures/frame-guard/Capacitor.swift", import.meta.url),
        join(dir, "Capacitor.swift"),
      );
      await Deno.writeTextFile(
        join(dir, "Guard.swift"),
        "import Foundation\nimport WebKit\nimport Capacitor\n" + FRAME_GUARD_SWIFT,
      );
      const swiftc = async (args: string[]) => {
        const out = await new Deno.Command("xcrun", {
          args: ["--sdk", "iphoneos", "swiftc", "-target", "arm64-apple-ios15.0", ...args],
          cwd: dir,
        }).output();
        assert(out.success, new TextDecoder().decode(out.stderr));
      };
      await swiftc([
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        join(dir, "Capacitor.swift"),
      ]);
      for (const flags of [[], ["-DDEBUG"]]) {
        await swiftc([
          "-typecheck",
          "-swift-version",
          "5",
          ...flags,
          "-I",
          dir,
          join(dir, "Guard.swift"),
        ]);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
