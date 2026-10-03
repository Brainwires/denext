// `denext mobile add export-routes`: make the Capacitor shell serve an exported multi-page App
// Router site's routes. Capacitor answers every path without an extension with the root
// `index.html` (a single-page-app assumption), so `<a href="/protected">` would load the home
// page. Every bridge view controller and MainActivity denext composes already routes exported
// pages (bridge-export-router-native-template.ts and `EXPORT_ROUTES` in mobile-native-install.ts),
// so an app with any denext native feature has it; this installs it into an app with none: iOS
// `DenextBridgeViewController.swift` registering no plugin (the storyboard and SceneDelegate
// switched to it while they are stock), and the composed MainActivity with no feature. An
// unedited denext file from an earlier release is upgraded to the current one (adding the
// router), an edited one is kept and reported. Running it twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  BRIDGE_VC_FILE,
  hasAndroidApp,
  hasIosApp,
  installBridgeViewController,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  registerInMainActivity,
  wireBridgeViewController,
} from "./mobile-native-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/** What the bridge view controller must contain, and the manual step when it cannot. */
const IOS_ROUTER = {
  needle: "DenextExportRouter",
  step: "override `router()` to return DenextExportRouter() (copy the router from denext's " +
    "bridge view controller template).",
};

/**
 * Make the Capacitor project at `opts.dir` serve an exported multi-page app's routes: `/route`
 * loads `/route/index.html` or `/route.html` when the export has that page, any other
 * extensionless path still the root `index.html`. iOS: the export-aware
 * `DenextBridgeViewController` (with the plugins of every installed denext feature), compiled
 * into the App target and wired into the storyboard and SceneDelegate. Android: the composed
 * MainActivity, which carries `DenextExportRoutes`. Idempotent.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addExportRoutesToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const inst = new NativeInstaller(opts, {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  });
  if (await hasIosApp(inst)) {
    await installBridgeViewController(inst, null, IOS_ROUTER);
    await inst.edit(
      join(opts.dir, PBXPROJ),
      (text) => addSourceFiles(text, [BRIDGE_VC_FILE], { randomId: opts.randomId }).text,
    );
    await wireBridgeViewController(inst);
  }
  if (await hasAndroidApp(inst)) await registerInMainActivity(inst, null);
  return inst.report;
}

/** The install step of `denext mobile add export-routes`. */
export const EXPORT_ROUTES_INSTALL: NativeInstallStep = {
  label: "export-aware routing (/route → route/index.html): DenextBridgeViewController's " +
    "router on iOS, DenextExportRoutes in MainActivity on Android",
  run: addExportRoutesToProject,
};
