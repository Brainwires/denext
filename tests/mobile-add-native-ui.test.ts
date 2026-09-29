// `denext mobile add context-menu | system-icons` (src/build/mobile-context-menu-install.ts): no
// npm package; DenextContextMenu on iOS (in the app target, registered by the shared bridge view
// controller) and Android (registered from MainActivity); DenextSystemIcon on iOS only (Android
// is reported as skipped); the two compose with each other and with OTA in either order; a second
// run changes nothing; an edited template is kept; the embedded templates carry their marker.
// No test spawns a real process.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  addMobileCapabilities,
  type CommandRunner,
  planMobileCapabilities,
  type PlannedCommand,
} from "../src/build/mobile-capabilities.ts";
import {
  addContextMenuToProject,
  addSystemIconsToProject,
} from "../src/build/mobile-context-menu-install.ts";
import {
  bridgeViewControllerSource,
  mainActivitySource,
} from "../src/build/mobile-native-install.ts";
import {
  CONTEXT_MENU_ANDROID_FILES,
  CONTEXT_MENU_IOS_FILES,
  isPristineContextMenuTemplate,
  renderContextMenuTemplate,
} from "../src/build/context-menu-native-templates.ts";
import {
  isPristineSystemIconTemplate,
  renderSystemIconTemplate,
  SYSTEM_ICON_IOS_FILES,
} from "../src/build/system-icon-native-templates.ts";
import { CAPABILITY_PRIVACY } from "../src/build/mobile-privacy.ts";

const PBXPROJ_FIXTURE = await Deno.readTextFile(
  new URL("./fixtures/capacitor8/project.pbxproj", import.meta.url),
);

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const MAIN_ACTIVITY = "android/app/src/main/java/com/example/app/MainActivity.java";
const BRIDGE = "ios/App/App/DenextBridgeViewController.swift";
const IOS_MENU = "ios/App/App/DenextContextMenuPlugin.swift";
const ANDROID_MENU =
  "android/app/src/main/java/dev/denext/contextmenu/DenextContextMenuPlugin.java";
const IOS_ICONS = "ios/App/App/DenextSystemIconPlugin.swift";

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

/** A stock Capacitor 8 project with ios/ and android/; `files` overrides (null leaves one out). */
async function inProject(
  files: Record<string, string | null>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_ui_" });
  const all: Record<string, string | null> = {
    "capacitor.config.ts": "export default { appId: 'com.example.app', webDir: 'out' };\n",
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "node_modules/@capacitor/core/package.json": JSON.stringify({ version: "8.5.2" }),
    "out/index.html": "<!doctype html>\n",
    [PBXPROJ]: PBXPROJ_FIXTURE,
    "ios/App/App/Base.lproj/Main.storyboard": STOCK_STORYBOARD,
    "android/app/src/main/AndroidManifest.xml": "<manifest><application /></manifest>\n",
    [MAIN_ACTIVITY]: STOCK_ACTIVITY,
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

Deno.test("mobile add context-menu: no package; the plugin on iOS + Android, registered, idempotent", async () => {
  await inProject({}, async (dir) => {
    const { run, lines } = fakeRunner();
    const report = await addMobileCapabilities({ capabilities: ["context-menu"], cwd: dir, run });
    assertEquals(lines(), [], "no npm package, no cap sync");
    for (const path of [IOS_MENU, ANDROID_MENU, BRIDGE, MAIN_ACTIVITY, PBXPROJ]) {
      assert(report.written.includes(path), path);
    }
    const ios = await read(dir, IOS_MENU);
    assert(ios.startsWith("// denext-context-menu-template: 1 sha256="));
    for (
      const text of [
        'jsName = "DenextContextMenu"',
        "UIContextMenuInteraction(delegate: self)",
        "previewForHighlightingMenuWithConfiguration",
        "UIEditMenuInteraction",
        'notifyListeners("menuAction"',
        "UIImage(systemName: $0)",
        "action.subtitle = subtitle",
      ]
    ) assertStringIncludes(ios, text);
    const android = await read(dir, ANDROID_MENU);
    assertStringIncludes(android, '@CapacitorPlugin(name = "DenextContextMenu")');
    assertStringIncludes(android, "new PopupMenu(getContext(), point, Gravity.NO_GRAVITY)");
    assertStringIncludes(android, "HapticFeedbackConstants.LONG_PRESS");
    assertEquals(
      await read(dir, BRIDGE),
      await bridgeViewControllerSource(new Set(["context-menu"])),
    );
    assertStringIncludes(
      await read(dir, BRIDGE),
      "registerPluginInstance(DenextContextMenuPlugin())",
    );
    assertEquals(
      await read(dir, MAIN_ACTIVITY),
      await mainActivitySource("com.example.app", new Set(["context-menu"])),
    );
    assertStringIncludes(
      await read(dir, MAIN_ACTIVITY),
      "import dev.denext.contextmenu.DenextContextMenuPlugin;",
    );
    assertStringIncludes(await read(dir, PBXPROJ), "DenextContextMenuPlugin.swift");
    assertStringIncludes(
      await read(dir, "ios/App/App/Base.lproj/Main.storyboard"),
      'customClass="DenextBridgeViewController"',
    );
    const again = await addMobileCapabilities({ capabilities: ["context-menu"], cwd: dir, run });
    assertEquals(again.written, []);
  });
});

Deno.test("mobile add system-icons: iOS only; Android is reported as skipped", async () => {
  await inProject({}, async (dir) => {
    const report = await addSystemIconsToProject({ dir });
    for (const path of [IOS_ICONS, BRIDGE, PBXPROJ]) assert(report.written.includes(path), path);
    assert(!report.written.includes(MAIN_ACTIVITY), "MainActivity untouched");
    assertStringIncludes(report.skipped.join("\n"), "Material Symbols");
    const ios = await read(dir, IOS_ICONS);
    assert(ios.startsWith("// denext-system-icon-template: 1 sha256="));
    assertStringIncludes(ios, "UIImage(systemName: name, withConfiguration: config)");
    assertStringIncludes(ios, 'jsName = "DenextSystemIcon"');
    assertStringIncludes(
      await read(dir, BRIDGE),
      "registerPluginInstance(DenextSystemIconPlugin())",
    );
    assertEquals(await read(dir, MAIN_ACTIVITY), STOCK_ACTIVITY);
    const again = await addSystemIconsToProject({ dir });
    assertEquals(again.written, []);
  });
});

Deno.test("context-menu + system-icons: one bridge registering both, either order", async () => {
  const bridges: string[] = [];
  for (const order of [["context-menu", "system-icons"], ["system-icons", "context-menu"]]) {
    await inProject({}, async (dir) => {
      const { run } = fakeRunner();
      for (const cap of order) await addMobileCapabilities({ capabilities: [cap], cwd: dir, run });
      bridges.push(await read(dir, BRIDGE));
      const pbx = await read(dir, PBXPROJ);
      assertEquals(pbx.split("DenextContextMenuPlugin.swift in Sources */").length, 3);
      assertEquals(pbx.split("DenextSystemIconPlugin.swift in Sources */").length, 3);
    });
  }
  assertEquals(bridges[0], bridges[1]);
  assertEquals(
    bridges[0],
    await bridgeViewControllerSource(new Set(["context-menu", "system-icons"])),
  );
});

Deno.test("mobile add context-menu: an edited plugin is kept; --force replaces it", async () => {
  await inProject({}, async (dir) => {
    await addContextMenuToProject({ dir });
    const edited = (await read(dir, IOS_MENU)) + "\n// mine\n";
    await Deno.writeTextFile(join(dir, IOS_MENU), edited);
    const kept = await addContextMenuToProject({ dir });
    assert(kept.kept.includes(IOS_MENU));
    assertEquals(await read(dir, IOS_MENU), edited);
    const forced = await addContextMenuToProject({ dir, force: true });
    assert(forced.written.includes(IOS_MENU));
    assert(!(await read(dir, IOS_MENU)).includes("// mine"));
  });
});

Deno.test("context-menu / system-icons: plan notes, and privacy entries (none needed)", async () => {
  await inProject({}, async (dir) => {
    const plan = await planMobileCapabilities({
      capabilities: ["context-menu", "system-icons"],
      cwd: dir,
    });
    const notes = plan.notes.join("\n");
    assertStringIncludes(notes, "useContextMenu");
    assertStringIncludes(notes, "SystemIcon");
  });
  assertEquals(CAPABILITY_PRIVACY["context-menu"], []);
  assertEquals(CAPABILITY_PRIVACY["system-icons"], []);
});

Deno.test("the embedded templates render with an intact marker", async () => {
  for (
    const text of [
      ...Object.values(CONTEXT_MENU_IOS_FILES),
      ...Object.values(CONTEXT_MENU_ANDROID_FILES),
    ]
  ) {
    const rendered = await renderContextMenuTemplate(text);
    assert(await isPristineContextMenuTemplate(rendered));
    assert(!(await isPristineContextMenuTemplate(rendered + " ")));
  }
  for (const text of Object.values(SYSTEM_ICON_IOS_FILES)) {
    assert(await isPristineSystemIconTemplate(await renderSystemIconTemplate(text)));
  }
  // Swift string interpolation survives the template literal (backslashes are escaped).
  assertStringIncludes(SYSTEM_ICON_IOS_FILES["DenextSystemIconPlugin.swift"], '"\\(name)|');
});
