// `denext mobile add permissions` (and the capabilities that ask for a permission:
// local-notifications, biometrics, geolocation, background-location): install the native
// `DenextSettings` plugin behind `openAppSettings()` (denext/mobile). iOS:
// `DenextSettingsPlugin.swift`, added to the Xcode app target and registered by
// `DenextBridgeViewController` (the OTA one when OTA is installed, else a registering-only one).
// Android: `dev/denext/settings/DenextSettingsPlugin.java`, registered from `MainActivity`. Both
// compose with every other denext native feature in either order (see mobile-native-install.ts).
// Running it twice changes nothing.

import { SETTINGS_ANDROID_FILES, SETTINGS_IOS_FILES } from "./settings-native-templates.ts";
import {
  type NativeInstallOptions,
  type NativeInstallReport,
  SETTINGS_TEMPLATES,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/**
 * Install the native `DenextSettings` plugin (behind `openAppSettings()` in `denext/mobile`)
 * into the Capacitor project at `opts.dir`: `DenextSettingsPlugin.swift` in the Xcode app
 * target, registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched
 * to it while they are stock), and `DenextSettingsPlugin.java` registered from `MainActivity`.
 * Idempotent; an unedited template from an earlier denext is upgraded, and customised files are
 * never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addSettingsToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "settings",
    iosFiles: SETTINGS_IOS_FILES,
    androidFiles: SETTINGS_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/settings",
    kind: SETTINGS_TEMPLATES,
    registration: {
      needle: "DenextSettingsPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextSettingsPlugin())` after super.capacitorDidLoad().",
    },
  });
}

/**
 * denext's `DenextSettings` plugin behind `openAppSettings()`: every capability that asks for a
 * permission installs it, so a refused (`blocked`) permission can send the user to Settings.
 * One shared step object, so a run that names several such capabilities installs it once.
 */
export const SETTINGS_INSTALL: NativeInstallStep = {
  label: "DenextSettings plugin (openAppSettings: iOS app settings, Android App info) + its " +
    "registration in DenextBridgeViewController / MainActivity",
  run: addSettingsToProject,
};
