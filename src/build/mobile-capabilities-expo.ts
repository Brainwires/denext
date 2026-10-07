// The `denext mobile add` capabilities behind the Expo SDK shims that call a native plugin
// directly (`denext/expo/speech`, …) rather than through a `denext/mobile` function. Kept apart
// from the main table in ./mobile-capabilities.ts (which spreads them in) so each pin sits with
// what its shim needs. Every plugin below was checked against its published package: a
// `@capacitor/core` peer range admitting 8 and a Package.swift for Capacitor 8's SPM projects.

import type { MobileCapability } from "./mobile-capabilities.ts";
import { addExpoAppConfigToProject } from "./mobile-expo-app-config.ts";

/** The Capacitor major these pins target. */
const CAPACITOR_MAJOR = 8;

/** The Expo SDK shims' capabilities, by `denext mobile add` name. */
export const EXPO_SDK_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  // Not a plugin: the Expo app config's native settings, written into the shell's projects.
  "app-config": {
    capacitorMajor: CAPACITOR_MAJOR,
    listing: "(the Expo app config)",
    notes: "an Expo app's ios.infoPlist usage strings (and its config plugins'), " +
      "android.permissions and expo-build-properties (deployment target, SDK levels, cleartext) " +
      "written into ios/ and android/, as Expo's prebuild would",
    configure: () => ({
      install: {
        label: "app.json / app.config.* usage strings, Android permissions and " +
          "expo-build-properties into Info.plist, AndroidManifest.xml, variables.gradle and " +
          "project.pbxproj (only adds; SDK levels and the deployment target only rise)",
        run: addExpoAppConfigToProject,
      },
    }),
  },
  "text-to-speech": {
    npm: "@capacitor-community/text-to-speech",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "expo-speech's speak / stop / getAvailableVoicesAsync on the OS speech engine " +
      "(AVSpeechSynthesizer / Android TextToSpeech; the Android WebView has no speechSynthesis)",
  },
};
