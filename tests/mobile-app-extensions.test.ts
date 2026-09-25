// `denext mobile add share-extension | widget | live-activity` (src/build/mobile-app-extensions.ts,
// mobile-app-group.ts and the capabilities in mobile-capabilities.ts) on a stock Capacitor 8
// project built from the real T3 Code project file: the extension targets, their sources, the
// App Group in every entitlements file and Info.plist, the plugins registered through the
// shared bridge view controller and MainActivity, the Android intent filters, widget providers
// and resources. Every generator is idempotent, keeps edited templates, and upgrades unedited
// ones; the composed widget bundle follows the installed names. Configurable widgets
// (--configurable): the App Intents source, its read-back on a re-run, and the bundle's iOS 17
// block.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  addLiveActivitiesToProject,
  addShareExtensionToProject,
  addWidgetsToProject,
} from "../src/build/mobile-app-extensions.ts";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import {
  isPristineAppExtensionTemplate,
  renderAppExtensionTemplate,
  SHARE_EXTENSION_IOS_FILES,
} from "../src/build/app-extension-native-templates.ts";
import {
  androidWidgetLayout,
  configurableWidgetSource,
  formatWidgetParams,
  LIVE_ACTIVITY_PLUGIN_IOS_FILES,
  parseWidgetParams,
  snakeName,
  widgetParamsIn,
  WIDGETS_ANDROID_FILES,
  WIDGETS_IOS_FILES,
  WIDGETS_PLUGIN_IOS_FILES,
  widgetsBundleSource,
  widgetSource,
} from "../src/build/widget-native-templates.ts";
import { markedTemplateIntact } from "../src/build/native-template-marker.ts";
import { targetBuildSetting } from "../src/build/pbxproj.ts";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  planMobileCapabilities,
} from "../src/build/mobile-capabilities.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const STOCK_STORYBOARD = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">
    <scenes><scene sceneID="tne-QT-ifu"><objects>
        <viewController id="BYZ-38-t0r" customClass="CAPBridgeViewController" customModule="Capacitor" sceneMemberID="viewController"/>
    </objects></scene></scenes>
</document>
`;

const STOCK_MAIN_ACTIVITY = `package com.brainwires.t3code;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {}
`;

const INFO_PLIST_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>T3 Code</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>t3code</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;

const MANIFEST_TEXT = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:launchMode="singleTask" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const INFO_PLIST = "ios/App/App/Info.plist";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";
const MAIN_ACTIVITY = "android/app/src/main/java/com/brainwires/t3code/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const APP_ENTITLEMENTS = "ios/App/App/App.entitlements";
const GROUP = "group.com.brainwires.t3code";

/** A stock Capacitor 8 project (the T3 pbxproj) with ios/ and android/, plus `extra`. */
async function project(extra: Record<string, string | null> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_app_ext_" });
  const files: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'com.brainwires.t3code', webDir: 'www' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift":
      "class SceneDelegate { func f() { _ = CAPBridgeViewController() } }\n",
    [INFO_PLIST]: INFO_PLIST_TEXT,
    [MANIFEST]: MANIFEST_TEXT,
    [MAIN_ACTIVITY]: STOCK_MAIN_ACTIVITY,
    "android/app/build.gradle": 'android {\n    namespace = "com.brainwires.t3code"\n}\n',
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

const read = (dir: string, path: string) => Deno.readTextFile(join(dir, path));
const exists = async (dir: string, path: string) => {
  try {
    await Deno.stat(join(dir, path));
    return true;
  } catch {
    return false;
  }
};

async function inProject(
  fn: (dir: string) => Promise<void>,
  extra: Record<string, string | null> = {},
): Promise<void> {
  const dir = await project(extra);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The names of the native targets in the project. */
async function targets(dir: string): Promise<string[]> {
  const text = await read(dir, PBXPROJ);
  return [...text.matchAll(/isa = PBXNativeTarget;[\s\S]*?\n\t\t\tname = ([^;]+);/g)].map((m) =>
    m[1]
  );
}

/** How many Sources phases compile `name`. */
async function compiled(dir: string, name: string): Promise<number> {
  return (await read(dir, PBXPROJ)).split(`/* ${name} in Sources */,`).length - 1;
}

// ---- share-extension -------------------------------------------------------------------------

Deno.test("share-extension: the iOS target, the app plugin, the App Group and the Android filters", async () => {
  await inProject(async (dir) => {
    const report = await addShareExtensionToProject({ dir, appGroup: GROUP });
    assertEquals(report.kept, []);
    assertEquals(report.skipped, []);
    assertEquals(await targets(dir), ["App", "DenextShareExtension"]);
    // Sources: the extension's two files, the inbox also in the app, the plugin + bridge in the app.
    assertEquals(await compiled(dir, "ShareViewController.swift"), 1);
    assertEquals(await compiled(dir, "DenextShareInbox.swift"), 2);
    assertEquals(await compiled(dir, "DenextShareReceivePlugin.swift"), 1);
    assertEquals(await compiled(dir, "DenextBridgeViewController.swift"), 1);
    for (const [name, template] of Object.entries(SHARE_EXTENSION_IOS_FILES)) {
      assertEquals(
        await read(dir, `ios/App/DenextShareExtension/${name}`),
        await renderAppExtensionTemplate(template),
      );
    }
    // The bridge (no OTA: the app-extension registering-only controller) and the storyboard.
    const bridge = await read(dir, BRIDGE);
    assert(await isPristineAppExtensionTemplate(bridge));
    assertStringIncludes(bridge, "bridge?.registerPluginInstance(DenextShareReceivePlugin())");
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController"',
    );
    // App Group: app + extension entitlements, both Info.plists; the scheme from the app's URL types.
    for (
      const file of [
        APP_ENTITLEMENTS,
        "ios/App/DenextShareExtension/DenextShareExtension.entitlements",
      ]
    ) {
      const text = await read(dir, file);
      assertStringIncludes(text, "<key>com.apple.security.application-groups</key>");
      assertStringIncludes(text, `<string>${GROUP}</string>`);
    }
    assertStringIncludes(
      await read(dir, INFO_PLIST),
      `<key>DenextAppGroup</key>\n\t<string>${GROUP}</string>`,
    );
    const extPlist = await read(dir, "ios/App/DenextShareExtension/Info.plist");
    assertStringIncludes(extPlist, `<key>DenextAppGroup</key>\n\t<string>${GROUP}</string>`);
    assertStringIncludes(extPlist, "<key>DenextAppScheme</key>\n\t<string>t3code</string>");
    assertStringIncludes(extPlist, "<string>com.apple.share-services</string>");
    assertStringIncludes(extPlist, "<key>NSExtensionActivationSupportsWebURLWithMaxCount</key>");
    assertStringIncludes(extPlist, "<string>T3 Code</string>");
    // The App target now signs with App/App.entitlements; the extension with its own.
    const pbx = await read(dir, PBXPROJ);
    assertEquals(
      [...targetBuildSetting(pbx, "App", "CODE_SIGN_ENTITLEMENTS").values()],
      ["App/App.entitlements", "App/App.entitlements"],
    );
    assertEquals(
      [...targetBuildSetting(pbx, "DenextShareExtension", "PRODUCT_BUNDLE_IDENTIFIER").values()],
      ["com.brainwires.t3code.share", "com.brainwires.t3code.share"],
    );
    assertEquals(
      [...targetBuildSetting(pbx, "DenextShareExtension", "IPHONEOS_DEPLOYMENT_TARGET").values()],
      ["15.0", "15.0"],
    );
    // Android: SEND + SEND_MULTIPLE filters, the plugin, its registration.
    const manifest = await read(dir, MANIFEST);
    assertStringIncludes(manifest, '<action android:name="android.intent.action.SEND" />');
    assertStringIncludes(manifest, '<action android:name="android.intent.action.SEND_MULTIPLE" />');
    assertStringIncludes(manifest, '<data android:mimeType="image/*" />');
    assert(
      manifest.indexOf("android.intent.action.SEND") < manifest.indexOf("</activity>"),
      "inside the launcher activity",
    );
    assert(
      await exists(
        dir,
        "android/app/src/main/java/dev/denext/sharereceive/DenextShareReceivePlugin.java",
      ),
    );
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "registerPlugin(DenextShareReceivePlugin.class);",
    );
    // The portal note.
    assert(report.manual.some((m) => m.startsWith(`App Group ${GROUP} must exist`)));
  });
});

Deno.test("share-extension: a second run changes nothing", async () => {
  await inProject(async (dir) => {
    await addShareExtensionToProject({ dir });
    const snapshot = await read(dir, PBXPROJ);
    const again = await addShareExtensionToProject({ dir });
    assertEquals(again.written, []);
    assertEquals(again.kept, []);
    assertEquals(await read(dir, PBXPROJ), snapshot);
  });
});

Deno.test("share-extension: the default App Group is group.<bundle id>; --scheme wins over the plist", async () => {
  await inProject(async (dir) => {
    await addShareExtensionToProject({ dir, scheme: "t3share" });
    assertStringIncludes(
      await read(dir, APP_ENTITLEMENTS),
      "<string>group.com.brainwires.t3code</string>",
    );
    assertStringIncludes(
      await read(dir, "ios/App/DenextShareExtension/Info.plist"),
      "<string>t3share</string>",
    );
  });
});

Deno.test("share-extension: no URL scheme refuses before writing anything", async () => {
  await inProject(
    async (dir) => {
      const before = await read(dir, PBXPROJ);
      await assertRejects(
        () => addShareExtensionToProject({ dir }),
        Error,
        "pass --scheme <scheme>",
      );
      assertEquals(await read(dir, PBXPROJ), before);
      assert(!(await exists(dir, "ios/App/DenextShareExtension")));
    },
    {
      [INFO_PLIST]:
        '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict>\n</plist>\n',
    },
  );
});

Deno.test("share-extension: an existing CODE_SIGN_ENTITLEMENTS file is used, not replaced", async () => {
  const pbx = PBXPROJ_FIXTURE.replaceAll(
    "CODE_SIGN_STYLE = Automatic;",
    "CODE_SIGN_ENTITLEMENTS = App/Custom.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;",
  );
  await inProject(async (dir) => {
    await addShareExtensionToProject({ dir, appGroup: GROUP });
    assertStringIncludes(await read(dir, "ios/App/App/Custom.entitlements"), GROUP);
    assertStringIncludes(await read(dir, "ios/App/App/Custom.entitlements"), "aps-environment");
    assert(!(await exists(dir, APP_ENTITLEMENTS)));
  }, {
    [PBXPROJ]: pbx,
    "ios/App/App/Custom.entitlements": `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>development</string>
</dict>
</plist>
`,
  });
});

Deno.test("share-extension: an invalid --app-group is refused", async () => {
  await inProject(async (dir) => {
    await assertRejects(
      () => addShareExtensionToProject({ dir, appGroup: "com.example" }),
      Error,
      "an App Group is",
    );
  });
});

// ---- widgets + Live Activities ---------------------------------------------------------------

Deno.test("widget: the WidgetKit target, the bundle, the plugin and the Android provider", async () => {
  await inProject(async (dir) => {
    const report = await addWidgetsToProject({ dir, names: ["Status", "OrderProgress"] });
    assertEquals(report.kept, []);
    assertEquals(await targets(dir), ["App", "DenextWidgets"]);
    for (
      const n of [
        "StatusWidget.swift",
        "OrderProgressWidget.swift",
        "DenextWidgetsBundle.swift",
        "DenextWidgetStore.swift",
      ]
    ) {
      assertEquals(await compiled(dir, n), 1, n);
    }
    assertEquals(await compiled(dir, "DenextWidgetsPlugin.swift"), 1);
    assertEquals(
      await read(dir, "ios/App/DenextWidgets/StatusWidget.swift"),
      await renderAppExtensionTemplate(widgetSource("Status")),
    );
    assertEquals(
      await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift"),
      await renderAppExtensionTemplate(widgetsBundleSource(["OrderProgress", "Status"], false)),
    );
    assertStringIncludes(
      await read(dir, "ios/App/DenextWidgets/Info.plist"),
      "<string>com.apple.widgetkit-extension</string>",
    );
    assertStringIncludes(await read(dir, BRIDGE), "DenextWidgetsPlugin()");
    // Android: the plugin, one provider per name (importing the app's R), layouts, receivers.
    const java = "android/app/src/main/java/dev/denext/widgets";
    assert(await exists(dir, `${java}/DenextWidgetsPlugin.java`));
    const provider = await read(dir, `${java}/OrderProgressWidget.java`);
    assertStringIncludes(provider, "import com.brainwires.t3code.R;");
    assertStringIncludes(provider, "R.layout.denext_widget_order_progress");
    const layout = await read(
      dir,
      "android/app/src/main/res/layout/denext_widget_order_progress.xml",
    );
    assertEquals(layout, await renderAppExtensionTemplate(androidWidgetLayout(), "xml"));
    assert(layout.startsWith("<!-- denext-app-extension-template: "));
    assertEquals(await markedTemplateIntact("app-extension", layout), true);
    assertStringIncludes(
      await read(dir, "android/app/src/main/res/xml/denext_widget_status_info.xml"),
      'android:initialLayout="@layout/denext_widget_status"',
    );
    const manifest = await read(dir, MANIFEST);
    assertStringIncludes(manifest, 'android:name="dev.denext.widgets.StatusWidget"');
    assertStringIncludes(manifest, 'android:resource="@xml/denext_widget_order_progress_info"');
    assert(manifest.indexOf("StatusWidget") > manifest.indexOf("</activity>"));
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "registerPlugin(DenextWidgetsPlugin.class);",
    );
    // Idempotent.
    const again = await addWidgetsToProject({ dir, names: ["Status", "OrderProgress"] });
    assertEquals(again.written, []);
  });
});

Deno.test("widget: bad or missing names are refused", async () => {
  await inProject(async (dir) => {
    await assertRejects(() => addWidgetsToProject({ dir }), Error, "needs --name");
    await assertRejects(() => addWidgetsToProject({ dir, names: ["status"] }), Error, "PascalCase");
    await assertRejects(
      () => addLiveActivitiesToProject({ dir, names: ["Bad-Name"] }),
      Error,
      "PascalCase",
    );
  });
});

Deno.test("live-activity after widget: one widget extension, the attributes in both targets", async () => {
  await inProject(async (dir) => {
    await addWidgetsToProject({ dir, names: ["Status"] });
    const report = await addLiveActivitiesToProject({ dir, names: ["Delivery"] });
    assertEquals(await targets(dir), ["App", "DenextWidgets"]);
    assertEquals(await compiled(dir, "DenextActivityAttributes.swift"), 2);
    assertEquals(await compiled(dir, "DeliveryLiveActivity.swift"), 1);
    assertEquals(await compiled(dir, "DenextLiveActivities.swift"), 1);
    assertEquals(await compiled(dir, "DenextLiveActivityPlugin.swift"), 1);
    assertEquals(
      await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift"),
      await renderAppExtensionTemplate(widgetsBundleSource(["Status"], true)),
    );
    const dispatcher = await read(dir, "ios/App/DenextWidgets/DenextLiveActivities.swift");
    assertStringIncludes(dispatcher, 'case "Delivery": DeliveryLiveActivity.lockScreen(context)');
    assertStringIncludes(
      await read(dir, INFO_PLIST),
      "<key>NSSupportsLiveActivities</key>\n\t<true/>",
    );
    const bridge = await read(dir, BRIDGE);
    assertStringIncludes(bridge, "DenextWidgetsPlugin()");
    assertStringIncludes(bridge, "DenextLiveActivityPlugin()");
    assert(report.skipped.some((s) => s.startsWith("Android: Live Activities are iOS only")));
    // No Android plugin for Live Activities.
    assert(!(await read(dir, MAIN_ACTIVITY)).includes("LiveActivity"));
    // A second name joins the dispatcher.
    await addLiveActivitiesToProject({ dir, names: ["Workout"] });
    const both = await read(dir, "ios/App/DenextWidgets/DenextLiveActivities.swift");
    assertStringIncludes(both, 'case "Delivery":');
    assertStringIncludes(both, 'case "Workout":');
  });
});

Deno.test("live-activity alone creates the widget extension; a widget later reuses it", async () => {
  await inProject(async (dir) => {
    await addLiveActivitiesToProject({ dir, names: ["Delivery"] });
    assertEquals(await targets(dir), ["App", "DenextWidgets"]);
    assertEquals(
      await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift"),
      await renderAppExtensionTemplate(widgetsBundleSource([], true)),
    );
    await addWidgetsToProject({ dir, names: ["Status"] });
    assertEquals(await targets(dir), ["App", "DenextWidgets"]);
    assertStringIncludes(
      await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift"),
      "StatusWidget()",
    );
    assertEquals(await compiled(dir, "DenextWidgetStore.swift"), 1);
  });
});

// ---- template markers ------------------------------------------------------------------------

Deno.test("templates: an edited widget view is kept, an unedited earlier one upgraded, --force replaces", async () => {
  await inProject(async (dir) => {
    await addWidgetsToProject({ dir, names: ["Status"] });
    const path = "ios/App/DenextWidgets/StatusWidget.swift";
    // An unedited template of an earlier generation: an intact marker over other content.
    await Deno.writeTextFile(join(dir, path), await renderAppExtensionTemplate("// older\n"));
    const upgraded = await addWidgetsToProject({ dir, names: ["Status"] });
    assertEquals(upgraded.upgraded, [path]);
    assertEquals(await read(dir, path), await renderAppExtensionTemplate(widgetSource("Status")));
    // Edited: kept, reported.
    const edited = (await read(dir, path)).replace("Open the app", "Open T3");
    await Deno.writeTextFile(join(dir, path), edited);
    const kept = await addWidgetsToProject({ dir, names: ["Status"] });
    assertEquals(kept.kept, [path]);
    assert(kept.manual.some((m) => m.startsWith(`${path} differs from denext's template`)));
    assertEquals(await read(dir, path), edited);
    // --force replaces it.
    await addWidgetsToProject({ dir, names: ["Status"], force: true });
    assertEquals(await read(dir, path), await renderAppExtensionTemplate(widgetSource("Status")));
  });
});

Deno.test("templates: an edited bundle is kept, and a new widget missing from it is reported", async () => {
  await inProject(async (dir) => {
    await addWidgetsToProject({ dir, names: ["Status"] });
    const path = "ios/App/DenextWidgets/DenextWidgetsBundle.swift";
    await Deno.writeTextFile(join(dir, path), (await read(dir, path)) + "// mine\n");
    const report = await addWidgetsToProject({ dir, names: ["Queue"] });
    assert(report.kept.includes(path));
    assert(report.manual.some((m) => m === `${path}: list QueueWidget() in the bundle's body.`));
  });
});

Deno.test("with OTA installed, the OTA bridge registers the extension plugins too", async () => {
  await inProject(async (dir) => {
    await addOtaToProject({ dir });
    await addShareExtensionToProject({ dir });
    await addWidgetsToProject({ dir, names: ["Status"] });
    const bridge = await read(dir, BRIDGE);
    assertStringIncludes(bridge, "DenextOta");
    assertStringIncludes(bridge, "DenextShareReceivePlugin()");
    assertStringIncludes(bridge, "DenextWidgetsPlugin()");
    const activity = await read(dir, MAIN_ACTIVITY);
    assert(activity.indexOf("DenextOta.prepare(") < activity.indexOf("DenextWidgetsPlugin.class"));
    assertStringIncludes(activity, "registerPlugin(DenextShareReceivePlugin.class);");
    // add-ota again keeps every registration.
    await addOtaToProject({ dir });
    assertEquals(await read(dir, BRIDGE), bridge);
  });
});

// ---- configurable widgets --------------------------------------------------------------------

const USAGE_PARAMS = parseWidgetParams([
  "period:enum=auto|session|weekly",
  "default:enum=all|mine",
]);

Deno.test("parseWidgetParams: enum parameters, and every malformed item refused", () => {
  assertEquals(USAGE_PARAMS, [
    { name: "period", values: ["auto", "session", "weekly"] },
    { name: "default", values: ["all", "mine"] },
  ]);
  assertEquals(
    formatWidgetParams(USAGE_PARAMS),
    "period:enum=auto|session|weekly,default:enum=all|mine",
  );
  assertEquals(parseWidgetParams([" size:enum= s | l "]), [{ name: "size", values: ["s", "l"] }]);
  const refused = (item: string, message: string) =>
    assertThrows(() => parseWidgetParams([item]), Error, message);
  refused("period", "expected <param>:enum=<a|b|c>");
  refused("Period:enum=a|b", "lowerCamelCase");
  refused("period:string=a", "only enum parameters");
  refused("params:enum=a|b", "reserved");
  refused("period:enum=a||b", "is not an enum value");
  refused("period:enum=1h|2h", "is not an enum value");
  refused("period:enum=a|a", "listed twice");
  assertThrows(
    () => parseWidgetParams(["p:enum=a", "p:enum=b"]),
    Error,
    "parameter p is given twice",
  );
});

Deno.test("configurableWidgetSource: an App Intents enum per parameter, a static face before iOS 17", () => {
  const source = configurableWidgetSource("Usage", USAGE_PARAMS);
  assertEquals(widgetParamsIn(source), USAGE_PARAMS);
  assertEquals(widgetParamsIn(widgetSource("Usage")), undefined);
  for (
    const expected of [
      "import AppIntents",
      "enum UsagePeriodOption: String, AppEnum {\n    case `auto`\n    case `session`\n",
      '        .`weekly`: "Weekly",',
      // A keyword parameter name is a plain Swift name in backticks.
      '    @Parameter(title: "Default", default: .`all`)\n    var `default`: UsageDefaultOption',
      "struct UsageConfigurationIntent: WidgetConfigurationIntent {",
      '            "period": `period`.rawValue,',
      'static let defaults: [String: String] = [\n        "period": "auto",\n        "default": "all",',
      'DenextWidgetStore.object(kind: "Usage", params: params)',
      "struct UsageIntentProvider: AppIntentTimelineProvider {",
      'let kind = "Usage.static"',
      "StaticConfiguration(kind: kind, provider: UsageStaticProvider())",
      "if #available(iOSApplicationExtension 17.0, *) { return [] }",
      '@available(iOS 17.0, *)\nstruct UsageConfigurableWidget: Widget {\n    let kind = "Usage"',
      "AppIntentConfiguration(kind: kind, intent: UsageConfigurationIntent.self",
    ]
  ) {
    assertStringIncludes(source, expected);
  }
});

Deno.test("widget --configurable: the source, the bundle's iOS 17 block, re-runs keep it", async () => {
  await inProject(async (dir) => {
    const report = await addWidgetsToProject({
      dir,
      names: ["Status", "Usage"],
      configurable: USAGE_PARAMS,
    });
    assertEquals(report.kept, []);
    assert(report.skipped.some((m) => m.startsWith("Android: widgets are static")));
    const path = "ios/App/DenextWidgets/UsageWidget.swift";
    const expected = await renderAppExtensionTemplate(
      configurableWidgetSource("Usage", USAGE_PARAMS),
    );
    assertEquals(await read(dir, path), expected);
    const bundle = await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift");
    assertEquals(
      bundle,
      await renderAppExtensionTemplate(
        widgetsBundleSource(["Status", "Usage"], false, ["Status", "Usage"]),
      ),
    );
    assertStringIncludes(
      bundle,
      "        UsageWidget()\n        if #available(iOSApplicationExtension 17.0, *) {\n" +
        "            StatusConfigurableWidget()\n            UsageConfigurableWidget()\n        }\n",
    );
    assertEquals(await compiled(dir, "UsageWidget.swift"), 1);
    // Idempotent, and a re-run without --configurable keeps the parameters.
    assertEquals(
      (await addWidgetsToProject({ dir, names: ["Usage"], configurable: USAGE_PARAMS }))
        .written,
      [],
    );
    const again = await addWidgetsToProject({ dir, names: ["Usage"] });
    assertEquals([again.written, again.upgraded], [[], []]);
    assertEquals(await read(dir, path), expected);
    // New parameters regenerate the unedited source.
    const other = parseWidgetParams(["period:enum=day|week"]);
    await addWidgetsToProject({ dir, names: ["Usage"], configurable: other });
    assertEquals(
      await read(dir, path),
      await renderAppExtensionTemplate(configurableWidgetSource("Usage", other)),
    );
    // Deleting the source and re-running without --configurable makes it static again.
    await Deno.remove(join(dir, path));
    await addWidgetsToProject({ dir, names: ["Usage"] });
    assertEquals(await read(dir, path), await renderAppExtensionTemplate(widgetSource("Usage")));
    assertStringIncludes(
      await read(dir, "ios/App/DenextWidgets/DenextWidgetsBundle.swift"),
      "            StatusConfigurableWidget()\n        }\n",
    );
  });
});

Deno.test("widget --configurable: an edited bundle missing the iOS 17 widget is reported", async () => {
  await inProject(async (dir) => {
    await addWidgetsToProject({ dir, names: ["Status"] });
    const path = "ios/App/DenextWidgets/DenextWidgetsBundle.swift";
    await Deno.writeTextFile(join(dir, path), (await read(dir, path)) + "// mine\n");
    const report = await addWidgetsToProject({
      dir,
      names: ["Usage"],
      configurable: USAGE_PARAMS,
    });
    assert(
      report.manual.includes(
        `${path}: list UsageWidget(), UsageConfigurableWidget() in the bundle's body.`,
      ),
      report.manual.join("\n"),
    );
  });
});

Deno.test("native templates: per-parameter snapshot keys, push-to-start, token events, list", () => {
  const store = WIDGETS_IOS_FILES["DenextWidgetStore.swift"];
  assertStringIncludes(store, "static func key(kind: String, params: [String: String] = [:])");
  assertStringIncludes(store, "return defaults.string(forKey: key(kind: kind))");
  const plugin = WIDGETS_PLUGIN_IOS_FILES["DenextWidgetsPlugin.swift"];
  assertStringIncludes(plugin, 'for (name, value) in call.getObject("params") ?? [:]');
  assertStringIncludes(plugin, 'reloadTimelines(ofKind: "\\(kind).static")');
  const android = WIDGETS_ANDROID_FILES["DenextWidgetsPlugin.java"];
  assertStringIncludes(android, 'String key = key(kind, call.getObject("params"));');
  assertStringIncludes(android, "TreeMap<String, String> sorted");
  const live = LIVE_ACTIVITY_PLUGIN_IOS_FILES["DenextLiveActivityPlugin.swift"];
  for (
    const expected of [
      'CAPPluginMethod(name: "pushToStartToken", returnType: CAPPluginReturnPromise)',
      'CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise)',
      "guard #available(iOS 17.2, *) else {",
      "Activity<DenextActivityAttributes>.pushToStartToken",
      'notifyListeners("pushToStartToken", data: ["token": Self.hex(token)], retainUntilConsumed: true)',
      'notifyListeners("pushToken", data: ["id": id, "token": Self.hex(token)], retainUntilConsumed: true)',
      "for await activity in Activity<DenextActivityAttributes>.activityUpdates",
      "policy = .after(Date(timeIntervalSince1970: at / 1000))",
    ]
  ) {
    assertStringIncludes(live, expected);
  }
});

Deno.test("snakeName: resource names", () => {
  assertEquals(snakeName("Status"), "status");
  assertEquals(snakeName("OrderProgress"), "order_progress");
  assertEquals(snakeName("HTTPStatus2"), "http_status2");
});

// ---- denext mobile add -----------------------------------------------------------------------

const noRun: CommandRunner = () => Promise.resolve({ code: 0 });

Deno.test("mobile add: the three capabilities plan and install through --name / --app-group", async () => {
  await inProject(async (dir) => {
    const plan = await planMobileCapabilities({
      capabilities: ["share-extension", "widget", "live-activity"],
      cwd: dir,
      names: ["Status"],
      appGroups: [GROUP],
    });
    assertEquals(plan.install, undefined);
    assertEquals(plan.native.installs.length, 3);
    assertStringIncludes(formatCapabilityPlan(plan), "Share Extension target");
    const report = await addMobileCapabilities({
      capabilities: ["share-extension", "widget", "live-activity"],
      cwd: dir,
      run: noRun,
      names: ["Status"],
      appGroups: [GROUP],
    });
    assertEquals(report.ran, []);
    assertEquals(await targets(dir), ["App", "DenextShareExtension", "DenextWidgets"]);
    // The portal note once, though three installers report it.
    assertEquals(report.manual.filter((m) => m.startsWith("App Group")).length, 1);
  });
});

Deno.test("mobile add widget --configurable: planned and installed", async () => {
  await inProject(async (dir) => {
    const opts = {
      capabilities: ["widget"],
      cwd: dir,
      names: ["Usage"],
      configurable: ["period:enum=auto|session|weekly", "default:enum=all|mine"],
    };
    const plan = await planMobileCapabilities(opts);
    assertStringIncludes(formatCapabilityPlan(plan), "configurable widget Usage");
    await addMobileCapabilities({ ...opts, run: noRun });
    assertEquals(
      widgetParamsIn(await read(dir, "ios/App/DenextWidgets/UsageWidget.swift")),
      USAGE_PARAMS,
    );
  });
});

Deno.test("mobile add: option checks", async () => {
  await inProject(async (dir) => {
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["widget"], cwd: dir }),
      Error,
      "needs --name",
    );
    await assertRejects(
      () => planMobileCapabilities({ capabilities: ["haptics"], cwd: dir, names: ["X"] }),
      Error,
      "--name is only for widget, live-activity",
    );
    await assertRejects(
      () =>
        planMobileCapabilities({
          capabilities: ["live-activity"],
          cwd: dir,
          names: ["X"],
          configurable: ["p:enum=a|b"],
        }),
      Error,
      "--configurable is only for widget",
    );
    await assertRejects(
      () =>
        planMobileCapabilities({
          capabilities: ["widget"],
          cwd: dir,
          names: ["X"],
          configurable: ["p:enum"],
        }),
      Error,
      "expected <param>:enum=<a|b|c>",
    );
    await assertRejects(
      () =>
        planMobileCapabilities({
          capabilities: ["share-extension"],
          cwd: dir,
          appGroups: ["group.a.b", "group.c.d"],
        }),
      Error,
      "--app-group takes one App Group",
    );
  });
});

Deno.test("mobile add push: an extension's entitlements are not the app's", async () => {
  await inProject(async (dir) => {
    await addShareExtensionToProject({ dir });
    const plan = await planMobileCapabilities({ capabilities: ["push"], cwd: dir });
    assertEquals(plan.entitlementsFiles, [APP_ENTITLEMENTS]);
  });
});
