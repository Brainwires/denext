// An exported multi-page App Router site in the Capacitor shell: Capacitor answers every path
// without an extension with the root index.html, so denext's native files route `/route` to
// `route/index.html` or `route.html` when the export has that page. iOS: every generated
// DenextBridgeViewController (OTA, auth-session-only, registering-only, and the no-plugin one
// `denext mobile add export-routes` writes) overrides `router()` with DenextExportRouter
// (src/build/bridge-export-router-native-template.ts). Android: every composed MainActivity
// registers DenextExportRoutes (src/build/mobile-native-install.ts). A bridge or activity an
// earlier denext wrote is upgraded in place; `denext mobile doctor` flags a multi-page export
// whose shell lacks the routing.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  EXPORT_ROUTER_OVERRIDE,
  EXPORT_ROUTER_SWIFT,
  withExportRouter,
} from "../src/build/bridge-export-router-native-template.ts";
import {
  type AndroidFeature,
  bridgeViewControllerSource,
  mainActivitySource,
  type NativeFeature,
} from "../src/build/mobile-native-install.ts";
import { renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import { addExportRoutesToProject } from "../src/build/mobile-export-routes-install.ts";
import { addAuthSessionToProject } from "../src/build/mobile-auth-session-install.ts";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import { addSettingsToProject } from "../src/build/mobile-settings-install.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";
import { MOBILE_CAPABILITIES } from "../src/build/mobile-capabilities.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const CLASS_LINE = "class DenextBridgeViewController: CAPBridgeViewController {\n";
const ROUTES_REGISTRATION = "        registerPlugin(DenextExportRoutes.class);\n";

/** The bridge variants: none, OTA alone, OTA composed, auth-session alone, registering-only. */
const VARIANTS: readonly (readonly NativeFeature[])[] = [
  [],
  ["ota"],
  ["ota", "auth-session", "settings", "storage"],
  ["auth-session"],
  ["settings"],
  ["share-receive", "widgets", "native-modules"],
];

/** The generation each bridge family had before the router (the release this one follows). */
const BEFORE_ROUTER: Readonly<Record<string, number>> = {
  ota: 5,
  "auth-session": 2,
  "app-extension": 2,
};

/** `text`'s marker family and generation. */
function marker(text: string): { family: string; generation: number } {
  const [, family, generation] = /^\/\/ denext-([a-z-]+)-template: (\d+) /.exec(text) ?? [];
  return { family, generation: Number(generation) };
}

Deno.test("export router: every bridge variant overrides router() and carries the router once", async () => {
  for (const set of VARIANTS) {
    const label = set.join("+") || "(none)";
    const text = await bridgeViewControllerSource(new Set(set));
    // The override opens the class body, ahead of any other member.
    assertStringIncludes(text, CLASS_LINE + EXPORT_ROUTER_OVERRIDE, label);
    assertEquals(text.split("override open func router() -> Router {").length, 2, label);
    assertEquals(text.split("struct DenextExportRouter: Router {").length, 2, label);
    assert(text.endsWith(EXPORT_ROUTER_SWIFT), label);
    // A marker the release before the router sees as newer, so it keeps the file.
    const { family, generation } = marker(text);
    assert(family in BEFORE_ROUTER, label);
    assert(generation > BEFORE_ROUTER[family], `${label}: ${family} ${generation}`);
  }
  // No plugin: the registering-only bridge with nothing registered, frame guard still first.
  const none = await bridgeViewControllerSource(new Set());
  assert(!none.includes("registerPluginInstance"));
  assertStringIncludes(none, "DenextMainFrameBridgeGuard.install(on: bridge)");
});

Deno.test("export router: the Swift routes /route to its page, else the root index.html", () => {
  // Checks the source's load-bearing parts (it is compiled only in an app).
  const swift = EXPORT_ROUTER_SWIFT;
  // A path with an extension (an asset, or route/index.html itself) passes through.
  assertStringIncludes(swift, "guard url.pathExtension.isEmpty else { return basePath + path }");
  // route/index.html first, then route.html, each only when the served UI has the file.
  assertStringIncludes(swift, 'for candidate in [trimmed + "/index.html", trimmed + ".html"] {');
  assertStringIncludes(swift, "if fm.fileExists(atPath: basePath + candidate)");
  // A trailing slash names the same page; the root and unknown paths stay a single-page app.
  assertStringIncludes(swift, 'path.hasSuffix("/") ? String(path.dropLast()) : path');
  assertStringIncludes(swift, '        return basePath + "/index.html"\n    }\n');
  // A decoded path that leaves basePath (`/../secret`) is refused before any file check.
  assertStringIncludes(swift, "guard staysInside(path) else {");
  assertStringIncludes(swift, 'if path.split(separator: "/").contains("..") { return false }');
  assertStringIncludes(swift, ".standardizedFileURL.path");
  // basePath is Capacitor's to set (setAssetPath: the bundled public/ or an OTA directory).
  assertStringIncludes(swift, 'var basePath: String = ""');
  assertStringIncludes(EXPORT_ROUTER_OVERRIDE, "DenextExportRouter()");
  // No stray interpolation in the Swift.
  assert(!swift.includes("${") && !EXPORT_ROUTER_OVERRIDE.includes("${"));
});

Deno.test("export router: a template without the bridge class is refused", () => {
  assertThrows(() => withExportRouter("class X {}\n"), Error, "no place for the export router");
});

Deno.test("export routes: every MainActivity registers DenextExportRoutes before the bridge", async () => {
  const sets: AndroidFeature[][] = [[], ["ota"], ["ota", "auth-session", "back"], ["storage"]];
  for (const set of sets) {
    const label = set.join("+") || "(none)";
    const text = await mainActivitySource("com.example.app", new Set(set));
    assert(text.startsWith("// denext-main-activity-template: 4 "), label);
    const registration = text.indexOf(ROUTES_REGISTRATION);
    const superCall = text.indexOf("super.onCreate(savedInstanceState);");
    assert(registration > 0 && registration < superCall, label);
    // OTA's prepare stays first thing.
    const prepare = text.indexOf("DenextOta.prepare(this, bridgeBuilder);");
    assert(prepare === -1 || prepare < registration, label);
    assertEquals(text.split("public static final class DenextExportRoutes").length, 2, label);
  }
});

Deno.test("export routes: the Java reroutes extensionless local paths to the export's page", async () => {
  const java = await mainActivitySource("com.example.app", new Set());
  // A plugin (no methods) whose load() runs while the bridge is built, before the first page.
  assertStringIncludes(
    java,
    '@com.getcapacitor.annotation.CapacitorPlugin(name = "DenextExportRoutes")',
  );
  assertStringIncludes(java, "bridge.setWebViewClient(new ExportRoutesClient(bridge));");
  // An app's own WebViewClient is kept.
  assertStringIncludes(
    java,
    "current.getClass() != com.getcapacitor.BridgeWebViewClient.class",
  );
  // The client stays a BridgeWebViewClient and asks the local server for the page's file.
  assertStringIncludes(
    java,
    "private static final class ExportRoutesClient extends com.getcapacitor.BridgeWebViewClient",
  );
  assertStringIncludes(
    java,
    "return super.shouldInterceptRequest(view, page == null ? request : new Rerouted(request, page));",
  );
  // Only the app's own host, never under live reload, never an extension or a parent segment.
  assertStringIncludes(java, "if (bridge.getServerUrl() != null) return null;");
  assertStringIncludes(java, "!host.equalsIgnoreCase(bridge.getHost())");
  assertStringIncludes(java, 'last.contains(".") || path.contains("/..")');
  // route/index.html first, then route.html, in the UI served (an OTA directory or the assets).
  assertStringIncludes(java, 'new String[] { path + "/index.html", path + ".html" }');
  assertStringIncludes(java, "String base = bridge.getServerBasePath();");
  assertStringIncludes(
    java,
    'if (base.startsWith("/")) return new java.io.File(base + page).isFile();',
  );
  assertStringIncludes(java, "bridge.getContext().getAssets().open(base + page)");
  // The rerouted request keeps everything but the path.
  assertStringIncludes(java, "this.url = request.getUrl().buildUpon().path(path).build();");
  assert(!java.includes("${"));
});

// ---- installing and upgrading ------------------------------------------------------------------

const STOCK_STORYBOARD = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">
    <scenes><scene sceneID="tne-QT-ifu"><objects>
        <viewController id="BYZ-38-t0r" customClass="CAPBridgeViewController" customModule="Capacitor" sceneMemberID="viewController"/>
    </objects></scene></scenes>
</document>
`;

const STOCK_ACTIVITY = `package com.example.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

/** A stock Capacitor 8 project (iOS and Android) with `pages` in its `out/` export. */
async function project(pages: readonly string[] = ["index.html"]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_routes_" });
  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify({ appId: "com.example.app", webDir: "out" }),
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "ios/App/App.xcodeproj/project.pbxproj": PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift":
      "import UIKit\nimport Capacitor\nlet root = CAPBridgeViewController()\n",
    "android/app/src/main/AndroidManifest.xml": "<manifest><application/></manifest>\n",
    [ACTIVITY]: STOCK_ACTIVITY,
  };
  for (const page of pages) files[`out/${page}`] = "<!doctype html>\n";
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** Runs `fn` in a fresh project, removed afterwards. */
async function inProject(
  pages: readonly string[],
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await project(pages);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));

Deno.test("mobile add export-routes: a stock project gets the no-plugin bridge and MainActivity", async () => {
  assert(MOBILE_CAPABILITIES["export-routes"].npm === undefined, "denext's own native code");
  await inProject(["index.html", "protected/index.html"], async (dir) => {
    const report = await addExportRoutesToProject({ dir, randomId: fixedIds() });
    assertEquals(report.manual, []);
    assertEquals(report.kept, []);
    assertEquals(await read(dir, BRIDGE), await bridgeViewControllerSource(new Set()));
    assertEquals(
      await read(dir, ACTIVITY),
      await mainActivitySource("com.example.app", new Set()),
    );
    // Compiled into the App target and used by the storyboard and SceneDelegate.
    assertStringIncludes(
      await read(dir, "ios/App/App.xcodeproj/project.pbxproj"),
      "DenextBridgeViewController.swift",
    );
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController"',
    );
    assertStringIncludes(
      await read(dir, "ios/App/App/SceneDelegate.swift"),
      "DenextBridgeViewController()",
    );
    // Twice: nothing changes.
    const again = await addExportRoutesToProject({ dir, randomId: fixedIds() });
    assertEquals(again.written, []);
    assert(again.unchanged.includes(BRIDGE) && again.unchanged.includes(ACTIVITY));
  });
});

Deno.test("mobile add export-routes: with denext plugins installed, it keeps them", async () => {
  await inProject(["index.html"], async (dir) => {
    await addAuthSessionToProject({ dir });
    const bridge = await read(dir, BRIDGE);
    const activity = await read(dir, ACTIVITY);
    assertStringIncludes(bridge, "DenextAuthSessionPlugin()");
    const report = await addExportRoutesToProject({ dir });
    assertEquals(report.written, []);
    assertEquals(await read(dir, BRIDGE), bridge);
    assertEquals(await read(dir, ACTIVITY), activity);
  });
});

/** `text`'s body as the release before the router wrote it, under that release's marker. */
async function beforeRouter(text: string): Promise<string> {
  const { family } = marker(text);
  const body = text.slice(text.indexOf("\n") + 1)
    .replace(EXPORT_ROUTER_OVERRIDE, "")
    .replace(EXPORT_ROUTER_SWIFT, "");
  assert(!body.includes("DenextExportRouter"));
  return await renderMarkedTemplate(family, BEFORE_ROUTER[family], body);
}

/** A MainActivity as generation 3 (renderer recovery, no export routes) wrote it. */
async function generation3Activity(text: string): Promise<string> {
  const body = text.slice(text.indexOf("\n") + 1);
  const start = body.indexOf("\n    /**\n     * denext: an exported multi-page app's routes");
  assert(start > 0);
  const old = body.slice(0, start) + "\n}\n";
  const withoutRegistration = old.replace(
    "        // denext: an exported page loads its own HTML (see DenextExportRoutes below).\n" +
      ROUTES_REGISTRATION,
    "",
  );
  assert(!withoutRegistration.includes("DenextExportRoutes"));
  return await renderMarkedTemplate("main-activity", 3, withoutRegistration);
}

const INSTALLERS = [
  { name: "add-ota", run: (dir: string) => addOtaToProject({ dir }) },
  { name: "add auth-session", run: (dir: string) => addAuthSessionToProject({ dir }) },
  { name: "add permissions", run: (dir: string) => addSettingsToProject({ dir }) },
] as const;

for (const { name, run } of INSTALLERS) {
  Deno.test(`export routes: ${name} upgrades the bridge and MainActivity an earlier denext wrote`, async () => {
    await inProject(["index.html", "protected/index.html"], async (dir) => {
      await run(dir);
      const bridge = await read(dir, BRIDGE);
      const activity = await read(dir, ACTIVITY);
      await Deno.writeTextFile(join(dir, BRIDGE), await beforeRouter(bridge));
      await Deno.writeTextFile(join(dir, ACTIVITY), await generation3Activity(activity));
      // The doctor flags both shells.
      const flagged = await runMobileDoctor({ root: dir, profile: "release" });
      const hit = flagged.findings.filter((f) => f.check === "export-routes");
      assertEquals(hit.length, 1);
      assertEquals(hit[0].level, "error");
      assertStringIncludes(hit[0].message, "iOS and Android");
      assertStringIncludes(hit[0].message, "out/protected/index.html");
      // Re-running the installer upgrades both to the current text.
      const again = await run(dir);
      assertEquals(again.kept, []);
      assert(again.upgraded.includes(BRIDGE), again.upgraded.join());
      assert(again.upgraded.includes(ACTIVITY), again.upgraded.join());
      assertEquals(await read(dir, BRIDGE), bridge);
      assertEquals(await read(dir, ACTIVITY), activity);
      const after = await runMobileDoctor({ root: dir, profile: "release" });
      assertEquals(after.findings.filter((f) => f.check === "export-routes"), []);
    });
  });
}

Deno.test("export routes: an edited bridge without the router is kept with a manual step", async () => {
  await inProject(["index.html"], async (dir) => {
    await addExportRoutesToProject({ dir });
    const edited = (await beforeRouter(await read(dir, BRIDGE))).replace(
      "        super.capacitorDidLoad()\n",
      '        super.capacitorDidLoad()\n        print("mine")\n',
    );
    await Deno.writeTextFile(join(dir, BRIDGE), edited);
    const report = await addExportRoutesToProject({ dir });
    assert(report.kept.includes(BRIDGE));
    assert(report.manual.some((m) => m.includes("DenextExportRouter")), report.manual.join("\n"));
    assertEquals(await read(dir, BRIDGE), edited);
  });
});

// ---- mobile doctor -------------------------------------------------------------------------------

/** The export-routes findings of a release doctor run over `dir`. */
async function exportFindings(dir: string) {
  const report = await runMobileDoctor({ root: dir, profile: "release" });
  return report.findings.filter((f) => f.check === "export-routes");
}

Deno.test("mobile doctor: a multi-page export needs the routing in both shells", async () => {
  // Stock shells: flagged for both platforms, in both profiles.
  await inProject(["index.html", "about.html"], async (dir) => {
    for (const profile of ["store", "release"] as const) {
      const report = await runMobileDoctor({ root: dir, profile });
      assert(report.checks.includes("export-routes"), profile);
      const hit = report.findings.filter((f) => f.check === "export-routes");
      assertEquals(hit.length, 1, profile);
      assertStringIncludes(hit[0].fix, "denext mobile add export-routes");
    }
    await addExportRoutesToProject({ dir });
    assertEquals(await exportFindings(dir), []);
  });
  // One platform missing: named alone.
  await inProject(["index.html", "a/index.html"], async (dir) => {
    await addExportRoutesToProject({ dir });
    await Deno.writeTextFile(join(dir, ACTIVITY), STOCK_ACTIVITY);
    const hit = await exportFindings(dir);
    assertEquals(hit.length, 1);
    assertStringIncludes(hit[0].message, "the Android shell");
  });
});

Deno.test("mobile doctor: a single-page export needs no routing", async () => {
  // The root page, error pages and asset folders are not routes of their own.
  await inProject(
    ["index.html", "404.html", "offline.html", "_denext/x/index.html", ".well-known/index.html"],
    async (dir) => assertEquals(await exportFindings(dir), []),
  );
});

/** Deterministic pbxproj ids. */
function fixedIds(): () => string {
  let n = 0;
  return () => (0xE0000000 + n++).toString(16).toUpperCase().padStart(24, "0");
}
