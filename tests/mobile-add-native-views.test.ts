// `denext mobile add native-views | native-map` (src/build/mobile-native-views-install.ts): the
// DenextNativeViews plugin (registry, video view) written on iOS and Android and registered
// through the shared bridge view controller and MainActivity; the map view's files and the
// osmdroid Gradle dependency; idempotence, edited files kept, and the composition with another
// denext native feature. No test spawns a real process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addMobileCapabilities, type CommandRunner } from "../src/build/mobile-capabilities.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import { withGradleDependency } from "../src/build/mobile-native-views-install.ts";
import {
  NATIVE_MAP_ANDROID_FILES,
  NATIVE_VIEWS_ANDROID_FILES,
  NATIVE_VIEWS_IOS_FILES,
  NATIVE_VIEWS_TEMPLATE_VERSION,
  OSMDROID_DEPENDENCY,
} from "../src/build/native-views-native-templates.ts";
import { markedTemplateIntact } from "../src/build/native-template-marker.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS_PLUGIN = "ios/App/App/DenextNativeViewsPlugin.swift";
const IOS_VIDEO = "ios/App/App/DenextVideoViewFactory.swift";
const IOS_MAP = "ios/App/App/DenextMapViewFactory.swift";
const ANDROID_DIR = "android/app/src/main/java/dev/denext/nativeviews";
const APP_GRADLE = "android/app/build.gradle";

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

const APP_GRADLE_TEXT = `apply plugin: 'com.android.application'

android {
    namespace = "com.example.app"
}

dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
    implementation project(':capacitor-android')
}
`;

/** A stock Capacitor 8 project with ios/ and android/; `files` overrides (null leaves one out). */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_views_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/Info.plist": "<plist><dict></dict></plist>\n",
    "android/app/src/main/AndroidManifest.xml": "<manifest><application/></manifest>\n",
    [MAIN_ACTIVITY]: STOCK_ACTIVITY,
    [APP_GRADLE]: APP_GRADLE_TEXT,
    ...files,
  };
  try {
    for (const [path, content] of Object.entries(all)) {
      if (content === null) continue;
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function fakeRunner() {
  const calls: string[] = [];
  const run: CommandRunner = (command) => {
    calls.push([command.cmd, ...command.args].join(" "));
    return Promise.resolve({ code: 0 });
  };
  return { run, calls };
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));

Deno.test("mobile add native-views: the plugin on iOS + Android, registered; no npm, no sync", async () => {
  await inProject({}, async (dir) => {
    const { run, calls } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["native-views"], cwd: dir, run });
    assertEquals(calls, []);
    const android = Object.keys(NATIVE_VIEWS_ANDROID_FILES).map((f) => `${ANDROID_DIR}/${f}`);
    for (const path of [IOS_PLUGIN, IOS_VIDEO, BRIDGE, MAIN_ACTIVITY, PBXPROJ, ...android]) {
      assert(report.written.includes(path), path);
    }
    const plugin = await read(dir, IOS_PLUGIN);
    assert(
      plugin.startsWith(
        `// denext-native-views-template: ${NATIVE_VIEWS_TEMPLATE_VERSION} sha256=`,
      ),
    );
    assertEquals(await markedTemplateIntact("native-views", plugin), true);
    assertStringIncludes(plugin, 'jsName = "DenextNativeViews"');
    assertStringIncludes(plugin, "public protocol DenextNativeViewFactory");
    assertStringIncludes(await read(dir, IOS_VIDEO), "player.observe(\\.timeControlStatus");
    for (const file of [IOS_PLUGIN, IOS_VIDEO]) {
      // Every Swift string interpolation survived the template literal (a lost backslash would
      // log "(id)" literally).
      assert(!/log\("\((?!\\)/.test(await read(dir, file)), file);
      assertStringIncludes(await read(dir, file), 'log("\\(');
    }
    assertStringIncludes(
      await read(dir, `${ANDROID_DIR}/DenextNativeViewsPlugin.java`),
      '@CapacitorPlugin(name = "DenextNativeViews")',
    );
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["native-views"])),
    );
    assertStringIncludes(
      await read(dir, BRIDGE),
      "registerPluginInstance(DenextNativeViewsPlugin())",
    );
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["native-views"])),
    );
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "import dev.denext.nativeviews.DenextNativeViewsPlugin;",
    );
    const pbx = await read(dir, PBXPROJ);
    assertStringIncludes(pbx, "DenextNativeViewsPlugin.swift");
    assertStringIncludes(pbx, "DenextVideoViewFactory.swift");
    assert(!pbx.includes("DenextMapViewFactory.swift"), "the map is native-map's");
    assertEquals(await read(dir, APP_GRADLE), APP_GRADLE_TEXT, "no osmdroid without native-map");
    const again = await addMobileCapabilities({ capabilities: ["native-views"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("native-views Android plugin: scrollPassthrough hands a drag on a view to the WebView", () => {
  const plugin = NATIVE_VIEWS_ANDROID_FILES["DenextNativeViewsPlugin.java"];
  // Generation 2 is the one that added it (an older denext must not rewrite it away).
  assert(NATIVE_VIEWS_TEMPLATE_VERSION >= 2);
  // The axis comes from create and from every frame.
  assertStringIncludes(plugin, 'call.getString("scrollPassthrough", "none")');
  assertStringIncludes(plugin, 'frame.optString("scrollPassthrough", "none")');
  // A drag past the system touch slop, along the axis ("both": either way), decided once.
  assertStringIncludes(plugin, "ViewConfiguration.get(getContext()).getScaledTouchSlop()");
  assertStringIncludes(plugin, "if (dx <= touchSlop && dy <= touchSlop) return false;");
  assertStringIncludes(
    plugin,
    '"both".equals(axis) || (vertical ? "vertical".equals(axis) : "horizontal".equals(axis))',
  );
  // A second finger (a pinch) stays the view's.
  assertStringIncludes(plugin, "MotionEvent.ACTION_POINTER_DOWN");
  // "over": the router cancels the view's gesture, then replays it to the WebView from its
  // ACTION_DOWN, moved into the WebView's coordinates.
  const router = plugin.slice(plugin.indexOf("private final class Router"));
  const takeOver = router.slice(router.indexOf("drag.takesOver(event)"));
  assert(
    takeOver.indexOf("cancelOf(event, 0, 0)") < takeOver.indexOf("toWeb(drag.down, dx, dy)") &&
      takeOver.indexOf("toWeb(drag.down, dx, dy)") < takeOver.indexOf("toWeb(event, dx, dy)"),
    "cancel, then the original down, then the current move",
  );
  assertStringIncludes(plugin, "copy.offsetLocation(dx, dy);");
  assertStringIncludes(plugin, "cancel.setAction(MotionEvent.ACTION_CANCEL);");
  // "under": the listener stops consuming, so the WebView's own onTouchEvent scrolls the page.
  assertStringIncludes(plugin, "toWeb(underDrag.down, 0, 0);");
  // A replayed event is not routed to an "under" view again.
  assertStringIncludes(plugin, "if (forwarding) return false;");
  // Nothing to scroll in the document: the drag stays the view's (as on iOS).
  assertStringIncludes(plugin, "web.canScrollVertically(1) || web.canScrollVertically(-1)");
});

Deno.test("mobile add native-map: native-views plus the map view and osmdroid", async () => {
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["native-map"], cwd: dir, run });
    for (
      const path of [IOS_PLUGIN, IOS_MAP, `${ANDROID_DIR}/DenextOsmMapFactory.java`, APP_GRADLE]
    ) {
      assert(report.written.includes(path), path);
    }
    assertStringIncludes(await read(dir, IOS_MAP), "@objc(DenextMapViewFactory)");
    assertStringIncludes(await read(dir, PBXPROJ), "DenextMapViewFactory.swift");
    const gradle = await read(dir, APP_GRADLE);
    assertStringIncludes(gradle, `dependencies {\n    ${OSMDROID_DEPENDENCY}\n`);
    assertEquals(Object.keys(NATIVE_MAP_ANDROID_FILES), ["DenextOsmMapFactory.java"]);
    const again = await addMobileCapabilities({ capabilities: ["native-map"], cwd: dir, run });
    assertEquals(again.written, []);
    assertEquals(await read(dir, APP_GRADLE), gradle, "the dependency is added once");
  });
});

Deno.test("mobile add native-views: an edited plugin is kept; composes with accessibility", async () => {
  await inProject({}, async (dir) => {
    const { run } = fakeRunner();
    await addMobileCapabilities({ capabilities: ["native-views"], cwd: dir, run });
    await Deno.writeTextFile(join(dir, IOS_PLUGIN), (await read(dir, IOS_PLUGIN)) + "// mine\n");
    const report = await addMobileCapabilities({
      capabilities: ["accessibility", "native-views"],
      cwd: dir,
      run,
    });
    assert(
      report.manual.some((m) => m.includes("DenextNativeViewsPlugin.swift")),
      "kept, reported",
    );
    assert((await read(dir, IOS_PLUGIN)).endsWith("// mine\n"));
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["accessibility", "native-views"])),
    );
    const activity = await read(dir, MAIN_ACTIVITY);
    assertStringIncludes(activity, "registerPlugin(DenextNativeViewsPlugin.class);");
    assertStringIncludes(activity, "registerPlugin(DenextAccessibilityPlugin.class);");
  });
});

Deno.test("mobile add native-map: a project without a dependencies block gets a manual step", async () => {
  await inProject(
    { [APP_GRADLE]: "android {}\n", "ios/App/App.xcodeproj/project.pbxproj": null },
    async (dir) => {
      const { run } = fakeRunner();
      const report = await addMobileCapabilities({ capabilities: ["native-map"], cwd: dir, run });
      assert(report.manual.some((m) => m.includes(OSMDROID_DEPENDENCY)), report.manual.join("\n"));
      assertEquals(report.skipped.filter((s) => s.startsWith("iOS")).length, 1, "reported once");
    },
  );
});

Deno.test("withGradleDependency: inserts into the top-level block once", () => {
  assertEquals(withGradleDependency("android {}\n", OSMDROID_DEPENDENCY), null);
  const once = withGradleDependency(APP_GRADLE_TEXT, OSMDROID_DEPENDENCY)!;
  assertStringIncludes(once, OSMDROID_DEPENDENCY);
  assertEquals(withGradleDependency(once, OSMDROID_DEPENDENCY), once);
  const pinnedElsewhere = APP_GRADLE_TEXT.replace(
    "implementation project",
    "implementation 'org.osmdroid:osmdroid-android:6.1.18'\n    implementation project",
  );
  assertEquals(withGradleDependency(pinnedElsewhere, OSMDROID_DEPENDENCY), pinnedElsewhere);
  assert(Object.keys(NATIVE_VIEWS_IOS_FILES).length === 2);
});
