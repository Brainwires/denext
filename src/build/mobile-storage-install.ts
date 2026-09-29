// `denext mobile add storage`: install the native `DenextStorage` plugin behind
// `openKeyValueStore()` (denext/mobile) and React Native mode's AsyncStorage / MMKV stand-ins.
// iOS: `DenextStoragePlugin.swift`, added to the Xcode app target and registered by
// `DenextBridgeViewController` (the OTA one when OTA is installed, else a registering-only one).
// Android: `dev/denext/storage/DenextStoragePlugin.java`, registered from `MainActivity`. Both
// compose with every other denext native feature in either order (see mobile-native-install.ts).
// Running it twice changes nothing.

import { STORAGE_ANDROID_FILES, STORAGE_IOS_FILES } from "./storage-native-templates.ts";
import {
  type NativeInstallOptions,
  type NativeInstallReport,
  STORAGE_TEMPLATES,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/**
 * Install the native `DenextStorage` plugin (behind `openKeyValueStore()` in `denext/mobile`)
 * into the Capacitor project at `opts.dir`: `DenextStoragePlugin.swift` in the Xcode app target,
 * registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched to it
 * while they are stock), and `DenextStoragePlugin.java` registered from `MainActivity`.
 * Idempotent; an unedited template from an earlier denext is upgraded, and customised files are
 * never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addStorageToProject(opts: NativeInstallOptions): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "storage",
    iosFiles: STORAGE_IOS_FILES,
    androidFiles: STORAGE_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/storage",
    kind: STORAGE_TEMPLATES,
    registration: {
      needle: "DenextStoragePlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextStoragePlugin())` after super.capacitorDidLoad().",
    },
  });
}

/** `storage`'s native step: the DenextStorage plugin and its registration. */
export const STORAGE_INSTALL: NativeInstallStep = {
  label: "DenextStorage plugin (durable key-value storage in the app's data folder) + its " +
    "registration in DenextBridgeViewController / MainActivity",
  run: addStorageToProject,
};
