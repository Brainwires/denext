// React Native mode's `ActionSheetIOS.dismissActionSheet()` (src/react-native/action-sheet-ios.ts):
// it closes the topmost sheet `showActionSheetWithOptions` opened, without calling its callback
// (React Native's RCTActionSheetManager), and is a no-op with none open. The in-page dialog and
// menu close through an AbortSignal (`showDialog`'s and `showContextMenu`'s `signal`); in the
// Capacitor shell denext's `DenextContextMenu` plugin closes its own menu and
// `@capacitor/action-sheet`'s system sheet (`dismiss({ target })`, generation 2 of
// src/build/context-menu-native-templates.ts, which `denext mobile add action-sheet` installs).
// The iOS plugin is type-checked against UIKit and a Capacitor stub where the iOS SDK exists.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ActionSheetIOS } from "../src/react-native/mod.ts";
import { resetActionSheetIOSForTesting } from "../src/react-native/action-sheet-ios.ts";
import { showContextMenu } from "../src/mobile/context-menu.ts";
import { showDialog } from "../src/mobile/dialog.ts";
import {
  CONTEXT_MENU_ANDROID_FILES,
  CONTEXT_MENU_IOS_FILES,
  CONTEXT_MENU_TEMPLATE_VERSION,
} from "../src/build/context-menu-native-templates.ts";
import { MOBILE_CAPABILITIES } from "../src/build/mobile-capabilities.ts";
import { CONTEXT_MENU_INSTALL } from "../src/build/mobile-context-menu-install.ts";
import { type FakeElement, makeDom } from "./helpers/dom.ts";
import { type Any, inShell, settle, withGlobals } from "./helpers/mobile-fakes.ts";

/** Every element under `root`, depth-first. */
function walk(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (n: Any) => {
    if (n?.nodeType === 1) out.push(n);
    for (const c of n?.childNodes ?? []) visit(c);
  };
  visit(root);
  return out;
}

const byRole = (root: FakeElement, role: string) =>
  walk(root).filter((el) => el.getAttribute("role") === role);

// ---- the web: the in-page dialog and menu ----------------------------------------------------

Deno.test("dismissActionSheet (web): closes the open dialog without calling the callback", async () => {
  const { doc } = makeDom();
  try {
    await withGlobals({ document: doc }, async () => {
      const picked: number[] = [];
      ActionSheetIOS.dismissActionSheet(); // none open: a no-op
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Cancel", "Delete"], cancelButtonIndex: 0 },
        (i) => void picked.push(i),
      );
      await settle();
      assertEquals(byRole(doc.body, "alertdialog").length, 1);
      ActionSheetIOS.dismissActionSheet();
      await settle();
      assertEquals(byRole(doc.body, "alertdialog").length, 0, "the dialog is gone");
      assertEquals(picked, [], "React Native never calls the callback of a dismissed sheet");
      ActionSheetIOS.dismissActionSheet(); // nothing left: a no-op
      // The next sheet works as before.
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["A", "B"] },
        (i) => void picked.push(i),
      );
      await settle();
      const buttons = walk(byRole(doc.body, "alertdialog")[0]).filter((e) =>
        e.tagName === "BUTTON"
      );
      buttons[1].dispatch("click");
      await settle();
      assertEquals(picked, [1]);
    });
  } finally {
    resetActionSheetIOSForTesting();
  }
});

Deno.test("dismissActionSheet (web): the menu of a sheet with disabled options; the topmost only", async () => {
  const { doc } = makeDom();
  try {
    await withGlobals({ document: doc }, async () => {
      const picked: string[] = [];
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Copy", "Paste"], disabledButtonIndices: [1] },
        (i) => void picked.push(`menu ${i}`),
      );
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Keep", "Drop"], disabledButtonIndices: [0] },
        (i) => void picked.push(`top ${i}`),
      );
      await settle();
      assertEquals(byRole(doc.body, "menu").length, 2);
      ActionSheetIOS.dismissActionSheet();
      await settle();
      const left = byRole(doc.body, "menu");
      assertEquals(left.length, 1, "only the topmost sheet closed");
      assertEquals(
        byRole(left[0], "menuitem").map((e) => e.textContent),
        ["Copy", "Paste"],
      );
      byRole(left[0], "menuitem")[0].dispatch("click");
      await settle();
      assertEquals(picked, ["menu 0"]);
    });
  } finally {
    resetActionSheetIOSForTesting();
  }
});

Deno.test("showDialog / showContextMenu: an aborted signal closes them with no choice", async () => {
  const { doc } = makeDom();
  await withGlobals({ document: doc }, async () => {
    const dialog = new AbortController();
    const shown = showDialog({ title: "T", buttons: [{ text: "OK" }], signal: dialog.signal });
    await settle();
    assertEquals(byRole(doc.body, "alertdialog").length, 1);
    dialog.abort();
    assertEquals(await shown, { index: null });
    assertEquals(byRole(doc.body, "alertdialog").length, 0);
    // Aborted before it opens: it never shows.
    assertEquals(
      await showDialog({ title: "T", buttons: [{ text: "OK" }], signal: dialog.signal }),
      {
        index: null,
      },
    );
    assertEquals(byRole(doc.body, "alertdialog").length, 0);

    const menu = new AbortController();
    const chosen = showContextMenu([{ id: "a", label: "A" }], { signal: menu.signal });
    await settle();
    assertEquals(byRole(doc.body, "menu").length, 1);
    menu.abort();
    assertEquals(await chosen, null);
    assertEquals(byRole(doc.body, "menu").length, 0);
    assertEquals(await showContextMenu([{ id: "a", label: "A" }], { signal: menu.signal }), null);
    assertEquals(byRole(doc.body, "menu").length, 0);
  });
});

// ---- the shell: DenextContextMenu's dismiss ---------------------------------------------------

/** A plugin whose `show` / `showActions` stay open until answered, recording every call. */
function pendingPlugin(method: string) {
  const calls: Array<[string, unknown]> = [];
  const answers: Array<(value: unknown) => void> = [];
  const plugin: Record<string, (arg?: unknown) => Promise<unknown>> = {
    [method]: (arg) => {
      calls.push([method, arg]);
      return new Promise((resolve) => answers.push(resolve));
    },
  };
  return { plugin, calls, answers };
}

Deno.test("dismissActionSheet (shell): @capacitor/action-sheet's sheet closes through DenextContextMenu", async () => {
  for (const platform of ["ios", "android"] as const) {
    const sheet = pendingPlugin("showActions");
    const dismissals: unknown[] = [];
    const menu = {
      show: () => Promise.resolve({ selectedId: null }),
      dismiss: (o: unknown) => (dismissals.push(o), Promise.resolve({ dismissed: true })),
    };
    try {
      await inShell(platform, { ActionSheet: sheet.plugin, DenextContextMenu: menu }, async () => {
        const picked: number[] = [];
        ActionSheetIOS.showActionSheetWithOptions(
          { options: ["A", "B"] },
          (i) => void picked.push(i),
        );
        await settle();
        assertEquals(sheet.calls.length, 1, platform);
        ActionSheetIOS.dismissActionSheet();
        await settle();
        assertEquals(dismissals, [{ target: "sheet" }], platform);
        // Had the native call answered after all, the dismissed sheet's callback stays silent.
        sheet.answers[0]({ index: 1 });
        await settle();
        assertEquals(picked, [], platform);
      });
    } finally {
      resetActionSheetIOSForTesting();
    }
  }
});

Deno.test("dismissActionSheet (shell): the native menu of a sheet with disabled options closes", async () => {
  const menu = pendingPlugin("show");
  const dismissals: unknown[] = [];
  const plugin = {
    ...menu.plugin,
    dismiss: (o: unknown) => {
      dismissals.push(o);
      menu.answers[0]({ selectedId: null }); // the native side answers a dismissed menu
      return Promise.resolve({ dismissed: true });
    },
  };
  try {
    await inShell("android", { DenextContextMenu: plugin }, async () => {
      const picked: number[] = [];
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["A", "B"], disabledButtonIndices: [0], cancelButtonIndex: 1 },
        (i) => void picked.push(i),
      );
      await settle();
      assertEquals(menu.calls.length, 1);
      ActionSheetIOS.dismissActionSheet();
      await settle();
      assertEquals(dismissals, [{ target: "menu" }]);
      assertEquals(picked, [], "no callback, not even the cancel index");
    });
  } finally {
    resetActionSheetIOSForTesting();
  }
});

Deno.test("dismissActionSheet (shell): without the generation-2 plugin nothing native is called", async () => {
  const sheet = pendingPlugin("showActions");
  try {
    await inShell(
      "ios",
      { ActionSheet: sheet.plugin, DenextContextMenu: { show: () => {} } },
      async () => {
        const picked: number[] = [];
        ActionSheetIOS.showActionSheetWithOptions({ options: ["A"] }, (i) => void picked.push(i));
        await settle();
        ActionSheetIOS.dismissActionSheet(); // must not throw
        sheet.answers[0]({ index: 0 });
        await settle();
        assertEquals(picked, []);
      },
    );
  } finally {
    resetActionSheetIOSForTesting();
  }
});

// ---- the native plugin -------------------------------------------------------------------

Deno.test("mobile add action-sheet installs DenextContextMenu (whose dismiss closes the sheet)", () => {
  const config = MOBILE_CAPABILITIES["action-sheet"].configure?.({
    schemes: [],
    domains: [],
    appGroups: [],
    names: [],
    configurable: [],
  });
  assertEquals(config?.install, CONTEXT_MENU_INSTALL);
  assertEquals(MOBILE_CAPABILITIES["action-sheet"].npm, "@capacitor/action-sheet");
});

Deno.test("DenextContextMenu: dismiss on iOS and Android, generation 2", () => {
  assert(CONTEXT_MENU_TEMPLATE_VERSION > 1, "3.2.0 wrote generation 1");
  const ios = CONTEXT_MENU_IOS_FILES["DenextContextMenuPlugin.swift"];
  for (
    const text of [
      'CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise)',
      "@objc func dismiss(_ call: CAPPluginCall) {",
      'call.getString("target") == "sheet"',
      "presentedViewController as? UIAlertController",
      "sheet.preferredStyle == .actionSheet",
      "interaction?.dismissMenu()",
      'call.resolve(["dismissed": dismissed])',
    ]
  ) assertStringIncludes(ios, text);
  const android = CONTEXT_MENU_ANDROID_FILES["DenextContextMenuPlugin.java"];
  for (
    const text of [
      "    @PluginMethod\n    public void dismiss(PluginCall call) {",
      // @capacitor/action-sheet's tag (ActionSheetPlugin.showActions, 8.x).
      '"capacitorModalsActionSheet"',
      "findFragmentByTag(CAPACITOR_ACTION_SHEET)",
      "dismissAllowingStateLoss()",
      "open.dismiss();",
    ]
  ) assertStringIncludes(android, text);
});

const IOS_SDK = (() => {
  if (Deno.build.os !== "darwin") return false;
  try {
    return new Deno.Command("xcrun", {
      args: ["--sdk", "iphoneos", "--show-sdk-path"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

/** The slice of Capacitor 8's iOS API the plugin uses, as a module named Capacitor. */
const CAPACITOR_STUB = `import Foundation
import UIKit
import WebKit
public let CAPPluginReturnPromise = "promise"
@objc public class CAPPluginMethod: NSObject {
    public init(name: String, returnType: String) {}
}
@objc public protocol CAPBridgeProtocol: NSObjectProtocol {
    var webView: WKWebView? { get }
    var viewController: UIViewController? { get }
}
@objc public protocol CAPBridgedPlugin: NSObjectProtocol {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}
@objc open class CAPPluginCall: NSObject {
    public var options: [AnyHashable: Any]! = [:]
    public func getString(_ key: String) -> String? { options[key] as? String }
    public func resolve(_ data: [String: Any] = [:]) {}
    public func reject(_ message: String, _ code: String? = nil) {}
}
@objc open class CAPPlugin: NSObject {
    public weak var bridge: CAPBridgeProtocol?
    open func load() {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?) {}
}
`;

Deno.test({
  name: "DenextContextMenu (iOS): the plugin type-checks against UIKit and a Capacitor stub",
  ignore: !IOS_SDK,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_context_menu_swift_" });
    try {
      const xcrun = (args: string[]) =>
        new Deno.Command("xcrun", {
          args: ["--sdk", "iphoneos", "swiftc", "-target", "arm64-apple-ios15.0", ...args],
          stdout: "piped",
          stderr: "piped",
        }).output();
      await Deno.writeTextFile(join(dir, "Capacitor.swift"), CAPACITOR_STUB);
      const stub = await xcrun([
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        join(dir, "Capacitor.swift"),
      ]);
      assert(stub.success, new TextDecoder().decode(stub.stderr));
      const plugin = join(dir, "DenextContextMenuPlugin.swift");
      await Deno.writeTextFile(plugin, CONTEXT_MENU_IOS_FILES["DenextContextMenuPlugin.swift"]);
      const check = await xcrun(["-typecheck", "-swift-version", "5", "-I", dir, plugin]);
      assert(check.success, new TextDecoder().decode(check.stderr));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
