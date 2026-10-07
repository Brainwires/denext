// The `denext mobile add` capabilities behind the Expo SDK shims that call a native plugin
// directly (`denext/expo/speech`, …) rather than through a `denext/mobile` function. Kept apart
// from the main table in ./mobile-capabilities.ts (which spreads them in) so each pin sits with
// what its shim needs. Every plugin below was checked against its published package: a
// `@capacitor/core` peer range admitting 8 and a Package.swift for Capacitor 8's SPM projects.

import type { MobileCapability } from "./mobile-capabilities.ts";

/** The Capacitor major these pins target. */
const CAPACITOR_MAJOR = 8;

/** The Expo SDK shims' capabilities, by `denext mobile add` name. */
export const EXPO_SDK_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  "text-to-speech": {
    npm: "@capacitor-community/text-to-speech",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "expo-speech's speak / stop / getAvailableVoicesAsync on the OS speech engine " +
      "(AVSpeechSynthesizer / Android TextToSpeech; the Android WebView has no speechSynthesis)",
  },
};
