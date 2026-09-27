// `denext mobile add accessibility`: install the native `DenextAccessibility` plugin behind
// `isScreenReaderEnabled()` / `onScreenReaderChange()` / `useScreenReader()` (denext/mobile) and
// React Native mode's `AccessibilityInfo.isScreenReaderEnabled`. iOS:
// `DenextAccessibilityPlugin.swift`, added to the Xcode app target and registered by
// `DenextBridgeViewController` (the OTA one when OTA is installed, else a registering-only one).
// Android: `dev/denext/accessibility/DenextAccessibilityPlugin.java`, registered from
// `MainActivity`. Both compose with every other denext native feature in either order (see
// mobile-native-install.ts). Running it twice changes nothing.

import {
  ACCESSIBILITY_ANDROID_FILES,
  ACCESSIBILITY_IOS_FILES,
} from "./accessibility-native-templates.ts";
import {
  ACCESSIBILITY_TEMPLATES,
  type NativeInstallOptions,
  type NativeInstallReport,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/**
 * Install the native `DenextAccessibility` plugin (behind `isScreenReaderEnabled()` in
 * `denext/mobile`) into the Capacitor project at `opts.dir`: `DenextAccessibilityPlugin.swift`
 * in the Xcode app target, registered by `DenextBridgeViewController` (the storyboard and
 * SceneDelegate switched to it while they are stock), and `DenextAccessibilityPlugin.java`
 * registered from `MainActivity`. Idempotent; an unedited template from an earlier denext is
 * upgraded, and customised files are never rewritten without `force`, only reported under
 * `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addAccessibilityToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "accessibility",
    iosFiles: ACCESSIBILITY_IOS_FILES,
    androidFiles: ACCESSIBILITY_ANDROID_FILES,
    androidDir: "android/app/src/main/java/dev/denext/accessibility",
    kind: ACCESSIBILITY_TEMPLATES,
    registration: {
      needle: "DenextAccessibilityPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextAccessibilityPlugin())` after " +
        "super.capacitorDidLoad().",
    },
  });
}

/** `accessibility`'s native step: the DenextAccessibility plugin and its registration. */
export const ACCESSIBILITY_INSTALL: NativeInstallStep = {
  label: "DenextAccessibility plugin (screen reader state: VoiceOver, TalkBack) + its " +
    "registration in DenextBridgeViewController / MainActivity",
  run: addAccessibilityToProject,
};
