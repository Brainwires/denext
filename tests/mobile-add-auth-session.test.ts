// `denext mobile add auth-session` (src/build/mobile-auth-session-install.ts + the capability in
// src/build/mobile-capabilities.ts): writes the DenextAuthSession native templates, adds the
// Swift files to the Xcode target, registers the plugin through the bridge view controller and
// MainActivity it shares with add-ota (in either order), keeps edited files, and is idempotent.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { addAuthSessionToProject } from "../src/build/mobile-auth-session-install.ts";
import { addOtaToProject } from "../src/build/mobile-ota-install.ts";
import {
  AUTH_SESSION_ANDROID_FILES,
  AUTH_SESSION_BRIDGE_VIEW_CONTROLLER,
  AUTH_SESSION_IOS_FILES,
  AUTH_SESSION_TEMPLATE_VERSION,
  isPristineAuthSessionTemplate,
  renderAuthSessionTemplate,
} from "../src/build/auth-session-native-templates.ts";
import {
  isPristineOtaTemplate,
  OTA_IOS_FILES,
  OTA_TEMPLATE_VERSION,
  renderOtaTemplate,
} from "../src/build/ota-native-templates.ts";
import { markedTemplateIntact, renderMarkedTemplate } from "../src/build/native-template-marker.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import {
  addMobileCapabilities,
  type CommandRunner,
  formatCapabilityPlan,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import { createMobileCommand } from "../src/cli/commands/mobile.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

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

const INFO_PLIST_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>App</string>
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
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS_PLUGIN = "ios/App/App/DenextAuthSessionPlugin.swift";
const ANDROID_PLUGIN =
  "android/app/src/main/java/dev/denext/authsession/DenextAuthSessionPlugin.java";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const INFO_PLIST = "ios/App/App/Info.plist";
const MANIFEST = "android/app/src/main/AndroidManifest.xml";

/** A stock Capacitor 8 project with ios/ and android/ (plus `extra` files). */
async function project(extra: Record<string, string> = {}): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_add_auth_" });
  const files: Record<string, string> = {
    "capacitor.config.ts": "export default { appId: 'dev.example', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "ios/App/App/SceneDelegate.swift": STOCK_SCENE_DELEGATE,
    [INFO_PLIST]: INFO_PLIST_TEXT,
    [MANIFEST]: MANIFEST_TEXT,
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

/** Run `fn` on a fresh project, removing it afterwards. */
async function inProject(
  fn: (dir: string) => Promise<void>,
  extra: Record<string, string> = {},
): Promise<void> {
  const dir = await project(extra);
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** How many times `/* <name> in Sources *\/,` appears in the pbxproj (once per compiled file). */
async function compiled(dir: string, name: string): Promise<number> {
  return (await read(dir, PBXPROJ)).split(`/* ${name} in Sources */,`).length - 1;
}

/** Every file the two installers touch, for comparing two projects. */
const SHARED_FILES = [
  BRIDGE,
  IOS_PLUGIN,
  ANDROID_PLUGIN,
  MAIN_ACTIVITY,
  "ios/App/App/Base.lproj/Main.storyboard",
  "ios/App/App/SceneDelegate.swift",
];

Deno.test("add auth-session: a stock project gets the plugin, the bridge and the registration", async () => {
  await inProject(async (dir) => {
    const report = await addAuthSessionToProject({ dir });
    assertEquals(report.manual, []);
    assertEquals(report.skipped, []);
    assertEquals(
      await read(dir, IOS_PLUGIN),
      await renderAuthSessionTemplate(AUTH_SESSION_IOS_FILES["DenextAuthSessionPlugin.swift"]),
    );
    assertEquals(
      await read(dir, ANDROID_PLUGIN),
      await renderAuthSessionTemplate(AUTH_SESSION_ANDROID_FILES["DenextAuthSessionPlugin.java"]),
    );
    // No OTA: the registering-only bridge view controller.
    const bridge = await read(dir, BRIDGE);
    assertEquals(bridge, await renderAuthSessionTemplate(AUTH_SESSION_BRIDGE_VIEW_CONTROLLER));
    assert(bridge.startsWith(`// denext-auth-session-template: ${AUTH_SESSION_TEMPLATE_VERSION} `));
    assertStringIncludes(bridge, "bridge?.registerPluginInstance(DenextAuthSessionPlugin())");
    assert(!bridge.includes("DenextOta"));
    assertEquals(await compiled(dir, "DenextBridgeViewController.swift"), 1);
    assertEquals(await compiled(dir, "DenextAuthSessionPlugin.swift"), 1);
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController" customModule="App" customModuleProvider="target"',
    );
    assertStringIncludes(
      await read(dir, "ios/App/App/SceneDelegate.swift"),
      "window?.rootViewController = DenextBridgeViewController()",
    );
    const activity = await read(dir, MAIN_ACTIVITY);
    assertEquals(activity, mainActivitySource("com.example.app", new Set(["auth-session"])));
    assertStringIncludes(activity, "import dev.denext.authsession.DenextAuthSessionPlugin;");
    assert(!activity.includes("DenextOta"));
    assert(
      activity.indexOf("registerPlugin(DenextAuthSessionPlugin.class);") <
        activity.indexOf("super.onCreate(savedInstanceState);"),
    );
    // bridge, plugin, java, pbxproj, storyboard, scene delegate, activity
    assertEquals(report.written.length, 7, report.written.join("\n"));
  });
});

Deno.test("add auth-session: idempotent — a second run writes nothing", async () => {
  await inProject(async (dir) => {
    await addAuthSessionToProject({ dir });
    const snapshot = await Promise.all([PBXPROJ, ...SHARED_FILES].map((p) => read(dir, p)));
    const again = await addAuthSessionToProject({ dir });
    assertEquals(again.written, []);
    assertEquals(again.manual, []);
    assertEquals(await Promise.all([PBXPROJ, ...SHARED_FILES].map((p) => read(dir, p))), snapshot);
  });
});

Deno.test("add auth-session + add-ota: both orders register both plugins, identically", async () => {
  const results: string[][] = [];
  for (const order of [["auth", "ota"], ["ota", "auth"]]) {
    await inProject(async (dir) => {
      for (const step of order) {
        const report = step === "auth"
          ? await addAuthSessionToProject({ dir })
          : await addOtaToProject({ dir });
        assertEquals(report.manual, [], `${order.join(" → ")}: ${report.manual.join("\n")}`);
        assertEquals(report.kept, []);
      }
      const bridge = await read(dir, BRIDGE);
      assertEquals(bridge, await bridgeViewControllerSource(new Set(["ota", "auth-session"])));
      // The OTA controller (start directory, watchdog) with the auth plugin registered too.
      assertStringIncludes(bridge, "DenextOtaStore.shared.prepareLaunch()");
      assert(
        bridge.indexOf("bridge?.registerPluginInstance(plugin)") <
          bridge.indexOf("bridge?.registerPluginInstance(DenextAuthSessionPlugin())"),
      );
      const activity = await read(dir, MAIN_ACTIVITY);
      assertEquals(
        activity,
        mainActivitySource("com.example.app", new Set(["ota", "auth-session"])),
      );
      assert(
        activity.indexOf("DenextOta.prepare(this, bridgeBuilder);") <
          activity.indexOf("registerPlugin(DenextAuthSessionPlugin.class);"),
      );
      assert(
        activity.indexOf("registerPlugin(DenextAuthSessionPlugin.class);") <
          activity.indexOf("super.onCreate(savedInstanceState);"),
      );
      for (
        const name of [
          "DenextBridgeViewController.swift",
          "DenextOtaPlugin.swift",
          "DenextOtaStore.swift",
          "DenextAuthSessionPlugin.swift",
        ]
      ) {
        assertEquals(await compiled(dir, name), 1, `${order.join(" → ")}: ${name}`);
      }
      // Re-running either installer now changes nothing.
      assertEquals((await addAuthSessionToProject({ dir })).written, []);
      assertEquals((await addOtaToProject({ dir })).written, []);
      results.push(await Promise.all(SHARED_FILES.map((p) => read(dir, p))));
    });
  }
  assertEquals(results[0], results[1]);
});

Deno.test("add-ota alone still writes exactly the OTA bridge and MainActivity", async () => {
  await inProject(async (dir) => {
    await addOtaToProject({ dir });
    assertEquals(
      await read(dir, BRIDGE),
      await renderOtaTemplate(OTA_IOS_FILES["DenextBridgeViewController.swift"]),
    );
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      mainActivitySource("com.example.app", new Set(["ota"])),
    );
    assert(!(await read(dir, MAIN_ACTIVITY)).includes("DenextAuthSession"));
  });
});

Deno.test("add auth-session: an edited template is kept unless --force", async () => {
  await inProject(async (dir) => {
    await addAuthSessionToProject({ dir });
    const edited = (await read(dir, IOS_PLUGIN)).replace('"busy")', '"busy!")');
    await Deno.writeTextFile(join(dir, IOS_PLUGIN), edited);
    assert(!(await isPristineAuthSessionTemplate(edited)));
    const kept = await addAuthSessionToProject({ dir });
    assertEquals(kept.kept, [IOS_PLUGIN]);
    assertEquals(kept.manual.length, 1);
    assertStringIncludes(kept.manual[0], "--force");
    assertEquals(await read(dir, IOS_PLUGIN), edited);
    const forced = await addAuthSessionToProject({ dir, force: true });
    assert(forced.written.includes(IOS_PLUGIN));
    assert(await isPristineAuthSessionTemplate(await read(dir, IOS_PLUGIN)));
  });
});

Deno.test("add auth-session: an unedited earlier template is upgraded in place", async () => {
  await inProject(async (dir) => {
    const older = await renderAuthSessionTemplate("// an older template\n");
    await Deno.mkdir(join(dir, ANDROID_PLUGIN, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, ANDROID_PLUGIN), older);
    const report = await addAuthSessionToProject({ dir });
    assertEquals(report.upgraded, [ANDROID_PLUGIN]);
    assertStringIncludes(
      await read(dir, ANDROID_PLUGIN),
      '@CapacitorPlugin(name = "DenextAuthSession")',
    );
  });
});

Deno.test("add auth-session: an edited bridge controller is kept, with the registration step", async () => {
  await inProject(async (dir) => {
    const report = await addAuthSessionToProject({ dir });
    assertEquals(report.kept, [BRIDGE]);
    assertEquals(
      await read(dir, BRIDGE),
      "import Capacitor\n\nclass DenextBridgeViewController: CAPBridgeViewController {}\n",
    );
    assert(
      report.manual.some((m) =>
        m.startsWith(BRIDGE) && m.includes("registerPluginInstance(DenextAuthSessionPlugin())")
      ),
      report.manual.join("\n"),
    );
  }, {
    [BRIDGE]: "import Capacitor\n\nclass DenextBridgeViewController: CAPBridgeViewController {}\n",
  });
});

Deno.test("add auth-session: an OTA bridge from an earlier denext waits for add-ota", async () => {
  await inProject(async (dir) => {
    await addOtaToProject({ dir });
    // An earlier generation's OTA bridge: a marker whose hash matches its (different) body.
    const older = "// denext-ota-template: 2 sha256=" +
      (await renderOtaTemplate("class DenextBridgeViewController {}\n")).split("sha256=")[1];
    await Deno.writeTextFile(join(dir, BRIDGE), older);
    const report = await addAuthSessionToProject({ dir });
    assertEquals(await read(dir, BRIDGE), older);
    assert(
      report.manual.some((m) => m.includes("run `denext mobile add-ota` first")),
      report.manual.join("\n"),
    );
    // add-ota upgrades it, and now registers the auth plugin as well.
    await addOtaToProject({ dir });
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["ota", "auth-session"])),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The composed bridge keeps the pristine-hash contract: its marker is computed over the composed
// body, so a later installer recognises it as an unedited denext file and upgrades it in place.

/** `text` as an earlier generation of `family` would have written it: another body, re-marked. */
async function olderGeneration(family: string, version: number, text: string): Promise<string> {
  const body = text.slice(text.indexOf("\n") + 1).replace("super.capacitorDidLoad()", "// older");
  assert(body !== text.slice(text.indexOf("\n") + 1), "the body must change");
  return await renderMarkedTemplate(family, version, body);
}

Deno.test("composed bridge: every feature combination carries a marker matching its body", async () => {
  const features = ["ota", "auth-session", "share-receive", "widgets", "live-activity"] as const;
  for (let mask = 1; mask < 1 << features.length; mask++) {
    const set = new Set(features.filter((_, i) => mask & (1 << i)));
    const text = await bridgeViewControllerSource(set);
    const family = /^\/\/ denext-([a-z-]+)-template: /.exec(text)?.[1];
    assert(family, [...set].join("+"));
    assertEquals(await markedTemplateIntact(family, text), true, [...set].join("+"));
  }
});

Deno.test("composed bridge: add-ota → add auth-session → add-ota upgrades or leaves it, never keeps it", async () => {
  await inProject(async (dir) => {
    await addOtaToProject({ dir });
    await addAuthSessionToProject({ dir });
    const composed = await read(dir, BRIDGE);
    assertEquals(composed, await bridgeViewControllerSource(new Set(["ota", "auth-session"])));
    // Same template version: nothing to do, nothing kept.
    const same = await addOtaToProject({ dir });
    assertEquals(same.kept, []);
    assertEquals(same.written, []);
    assert(same.unchanged.includes(BRIDGE));
    // A composed bridge from an earlier OTA generation: upgraded in place.
    const older = await olderGeneration("ota", OTA_TEMPLATE_VERSION - 1, composed);
    assert(await isPristineOtaTemplate("DenextBridgeViewController.swift", older));
    await Deno.writeTextFile(join(dir, BRIDGE), older);
    const bumped = await addOtaToProject({ dir });
    assertEquals(bumped.kept, []);
    assertEquals(bumped.manual, []);
    assertEquals(bumped.upgraded, [BRIDGE]);
    assertEquals(await read(dir, BRIDGE), composed);
    // The control: a composed bridge edited under its marker is the user's, and kept.
    await Deno.writeTextFile(join(dir, BRIDGE), composed.replace("super.capacitorDidLoad()", "x"));
    assertEquals((await addOtaToProject({ dir })).kept, [BRIDGE]);
  });
});

Deno.test("composed bridge: add auth-session → add-ota → add-ota upgrades or leaves it, never keeps it", async () => {
  await inProject(async (dir) => {
    await addAuthSessionToProject({ dir });
    // The auth-only bridge from an earlier auth-session generation: add-ota still upgrades it.
    const authOnly = await read(dir, BRIDGE);
    await Deno.writeTextFile(
      join(dir, BRIDGE),
      await olderGeneration("auth-session", AUTH_SESSION_TEMPLATE_VERSION + 1, authOnly),
    );
    const first = await addOtaToProject({ dir });
    assertEquals(first.kept, []);
    assertEquals(first.upgraded.includes(BRIDGE), true, first.upgraded.join());
    const composed = await read(dir, BRIDGE);
    assertEquals(composed, await bridgeViewControllerSource(new Set(["ota", "auth-session"])));
    const same = await addOtaToProject({ dir });
    assertEquals(same.kept, []);
    assertEquals(same.written, []);
    assertEquals((await addAuthSessionToProject({ dir })).written, []);
    await Deno.writeTextFile(
      join(dir, BRIDGE),
      await olderGeneration("ota", OTA_TEMPLATE_VERSION - 1, composed),
    );
    const bumped = await addOtaToProject({ dir });
    assertEquals(bumped.kept, []);
    assertEquals(bumped.upgraded, [BRIDGE]);
    assertEquals(await read(dir, BRIDGE), composed);
    // MainActivity has no marker: denext recognises its composed source exactly, and add-ota
    // leaves an activity that already calls DenextOta.prepare alone.
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      mainActivitySource("com.example.app", new Set(["ota", "auth-session"])),
    );
    assert(bumped.unchanged.includes(MAIN_ACTIVITY));
  });
});

Deno.test("add auth-session: a custom MainActivity becomes a manual step", async () => {
  const custom = STOCK_MAIN_ACTIVITY.replace(
    "extends BridgeActivity {}",
    "extends BridgeActivity {\n    // app code\n}",
  );
  await inProject(async (dir) => {
    const report = await addAuthSessionToProject({ dir });
    assertEquals(await read(dir, MAIN_ACTIVITY), custom);
    assert(
      report.manual.some((m) =>
        m.startsWith(MAIN_ACTIVITY) && m.includes("registerPlugin(DenextAuthSessionPlugin.class);")
      ),
    );
  }, { [MAIN_ACTIVITY]: custom });
});

Deno.test("native templates: the auth plugins' contract (jsName, methods, codes, Custom Tab)", () => {
  const swift = AUTH_SESSION_IOS_FILES["DenextAuthSessionPlugin.swift"];
  assertStringIncludes(swift, 'public let jsName = "DenextAuthSession"');
  assertStringIncludes(swift, 'CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)');
  assertStringIncludes(swift, "ASWebAuthenticationSession(url: url, callbackURLScheme: scheme)");
  assertStringIncludes(swift, "session.prefersEphemeralWebBrowserSession = ephemeral");
  assertStringIncludes(swift, "authError.code == .canceledLogin");
  assertStringIncludes(swift, "session.presentationContextProvider = self");
  for (const code of ["cancelled", "busy", "invalid", "unsupported"]) {
    assertStringIncludes(swift, `"${code}")`);
  }
  const java = AUTH_SESSION_ANDROID_FILES["DenextAuthSessionPlugin.java"];
  assertStringIncludes(java, '@CapacitorPlugin(name = "DenextAuthSession")');
  assertStringIncludes(java, "protected void handleOnNewIntent(Intent intent)");
  assertStringIncludes(java, "mainHandler.postDelayed(resumeCancel, RESUME_CANCEL_DELAY_MS)");
  assertStringIncludes(java, '"android.support.customtabs.extra.SESSION"');
  assertStringIncludes(java, "bridge.saveCall(call);");
  assertStringIncludes(java, "bridge.releaseCall(call);");
  assert(!java.includes("import androidx.browser"), "no androidx.browser dependency");
  for (const code of ["cancelled", "busy", "invalid", "unsupported"]) {
    assertStringIncludes(java, `"${code}")`);
  }
});

// ---------------------------------------------------------------------------------------------
// The `auth-session` capability of `denext mobile add`.

/** A runner that records every command and exits 0. */
function fakeRunner() {
  const calls: PlannedCommand[] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve({ code: 0 });
  };
  return { run, calls };
}

Deno.test("mobile add auth-session --scheme: installs the plugin, registers the scheme, no npm", async () => {
  await inProject(async (dir) => {
    const { run, calls } = fakeRunner();
    const planned = await addMobileCapabilities({
      capabilities: ["auth-session"],
      cwd: dir,
      schemes: ["t3code"],
      dryRun: true,
    });
    const text = formatCapabilityPlan(planned.plan);
    assertStringIncludes(text, "install        (no npm package)");
    assertStringIncludes(text, "native         DenextAuthSession plugin");
    assertStringIncludes(text, "intent-filter t3code://");
    assert(!text.includes("cap sync"));
    assertEquals(planned.written, []);

    const report = await addMobileCapabilities({
      capabilities: ["auth-session"],
      cwd: dir,
      schemes: ["t3code"],
      run,
    });
    assertEquals(calls, []);
    assertEquals(report.ran, []);
    assertEquals(report.manual, []);
    assertEquals(report.plan.manual, []);
    for (const path of [IOS_PLUGIN, ANDROID_PLUGIN, BRIDGE, MAIN_ACTIVITY, INFO_PLIST, MANIFEST]) {
      assert(report.written.includes(path), path);
    }
    assertStringIncludes(await read(dir, MANIFEST), '<data android:scheme="t3code" />');
    assertStringIncludes(await read(dir, INFO_PLIST), "<string>t3code</string>");

    const again = await addMobileCapabilities({
      capabilities: ["auth-session"],
      cwd: dir,
      schemes: ["t3code"],
      run,
    });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add auth-session without --scheme prints the manual step; --domain refused", async () => {
  await inProject(async (dir) => {
    const { run } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["auth-session"], cwd: dir, run });
    assert(
      report.plan.manual.some((m) => m.includes("--scheme <scheme>")),
      report.plan.manual.join("\n"),
    );
    assertEquals(await read(dir, MANIFEST), MANIFEST_TEXT);
    let error = "";
    try {
      await addMobileCapabilities({
        capabilities: ["auth-session"],
        cwd: dir,
        domains: ["app.example.com"],
        run,
      });
    } catch (err) {
      error = String(err);
    }
    assertStringIncludes(error, "--domain is only for deep-links");
  });
});

Deno.test("denext mobile add auth-session --scheme t3code through the verb", async () => {
  await inProject(async (dir) => {
    const { run, calls } = fakeRunner();
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await createMobileCommand(run).run({
        positionals: ["add", "auth-session"],
        flags: { dir, scheme: "t3code" },
        global: { json: false, verbose: false, quiet: false },
        rest: [],
      });
    } finally {
      console.log = log;
    }
    assertEquals(calls, []);
    const out = lines.join("\n");
    assertStringIncludes(out, `wrote      ${IOS_PLUGIN}`);
    assertStringIncludes(out, "openAuthSession");
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "registerPlugin(DenextAuthSessionPlugin.class);",
    );
  });
});
