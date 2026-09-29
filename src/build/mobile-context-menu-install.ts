// `denext mobile add context-menu`: install the native `DenextContextMenu` plugin behind
// `showContextMenu()` / `useContextMenu()` (denext/mobile). iOS: `DenextContextMenuPlugin.swift`
// (a `UIContextMenuInteraction` on the web view with the lifted element preview, and `UIMenu`
// at a point), added to the Xcode app target and registered by `DenextBridgeViewController`.
// Android: `dev/denext/contextmenu/DenextContextMenuPlugin.java` (a `PopupMenu`), registered from
// `MainActivity`. `denext mobile add system-icons` installs the SF Symbol renderer that
// `<SystemIcon>` uses (iOS only). Both compose with every other denext native feature in either
// order (see mobile-native-install.ts). Running either twice changes nothing.

import { join } from "@std/path";
import {
  CONTEXT_MENU_ANDROID_FILES,
  CONTEXT_MENU_IOS_FILES,
} from "./context-menu-native-templates.ts";
import { SYSTEM_ICON_IOS_FILES } from "./system-icon-native-templates.ts";
import {
  BRIDGE_VC_FILE,
  CONTEXT_MENU_TEMPLATES,
  hasIosApp,
  installBridgeViewController,
  IOS_APP,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  SYSTEM_ICON_TEMPLATES,
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";
import { addSourceFiles } from "./pbxproj.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/**
 * Install the native `DenextContextMenu` plugin into the Capacitor project at `opts.dir`:
 * `DenextContextMenuPlugin.swift` in the Xcode app target, registered by
 * `DenextBridgeViewController` (the storyboard and SceneDelegate switched to it while they are
 * stock), and `DenextContextMenuPlugin.java` registered from `MainActivity`. Idempotent; an
 * unedited template from an earlier denext is upgraded, and customised files are never
 * rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addContextMenuToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "context-menu",
    iosFiles: CONTEXT_MENU_IOS_FILES,
    androidFiles: CONTEXT_MENU_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/contextmenu",
    kind: CONTEXT_MENU_TEMPLATES,
    registration: {
      needle: "DenextContextMenuPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextContextMenuPlugin())` after " +
        "super.capacitorDidLoad().",
    },
  });
}

/**
 * Install the native `DenextSystemIcon` plugin (the SF Symbol renderer behind `<SystemIcon>`)
 * into the Capacitor project at `opts.dir`: `DenextSystemIconPlugin.swift` in the Xcode app
 * target, registered by `DenextBridgeViewController`. Android needs nothing (it draws Material
 * Symbols in the page), so it is reported as skipped. Idempotent, like
 * {@linkcode addContextMenuToProject}.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addSystemIconsToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  const inst = new NativeInstaller<NativeInstallOptions, NativeInstallReport>(opts, report);
  if (await hasIosApp(inst)) {
    await installBridgeViewController(inst, "system-icons", {
      needle: "DenextSystemIconPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextSystemIconPlugin())` after " +
        "super.capacitorDidLoad().",
    });
    await writeTemplates(
      inst,
      join(opts.dir, IOS_APP),
      SYSTEM_ICON_IOS_FILES,
      SYSTEM_ICON_TEMPLATES,
    );
    const sources = [BRIDGE_VC_FILE, ...Object.keys(SYSTEM_ICON_IOS_FILES)];
    const randomId = opts.randomId;
    await inst.edit(
      join(opts.dir, PBXPROJ),
      (text) => addSourceFiles(text, sources, { randomId }).text,
    );
    await wireBridgeViewController(inst);
  }
  report.skipped.push(
    "Android: nothing to install (<SystemIcon> draws Material Symbols in the page there).",
  );
  return report;
}

/** `context-menu`'s native step: the DenextContextMenu plugin and its registration. */
export const CONTEXT_MENU_INSTALL: NativeInstallStep = {
  label: "DenextContextMenu plugin (UIContextMenuInteraction + UIMenu on iOS, PopupMenu on " +
    "Android) + its registration in DenextBridgeViewController / MainActivity",
  run: addContextMenuToProject,
};

/** `system-icons`' native step: the DenextSystemIcon plugin (iOS) and its registration. */
export const SYSTEM_ICONS_INSTALL: NativeInstallStep = {
  label: "DenextSystemIcon plugin (SF Symbols rendered natively, iOS) + its registration in " +
    "DenextBridgeViewController",
  run: addSystemIconsToProject,
};
