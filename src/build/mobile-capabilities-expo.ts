// The `denext mobile add` capabilities behind the Expo SDK shims that call a native plugin
// directly (`denext/expo/speech`, …) rather than through a `denext/mobile` function. Kept apart
// from the main table in ./mobile-capabilities.ts (which spreads them in) so each pin sits with
// what its shim needs. Every plugin below was checked against its published package: a
// `@capacitor/core` peer range admitting 8 and a Package.swift for Capacitor 8's SPM projects.
// calendar, contacts, print and brightness also install denext's own plugin beside the pinned
// one (mobile-expo-sdk-install.ts), for the Expo calls the pinned plugin has no call for.

import type { MobileCapability } from "./mobile-capabilities.ts";
import { addExpoAppConfigToProject } from "./mobile-expo-app-config.ts";
import {
  BRIGHTNESS_INSTALL,
  CALENDAR_INSTALL,
  CONTACTS_INSTALL,
  PRINT_INSTALL,
} from "./mobile-expo-sdk-install.ts";

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
  brightness: {
    npm: "@capacitor-community/screen-brightness",
    version: "^8.0.0",
    capacitorMajor: CAPACITOR_MAJOR,
    // WRITE_SETTINGS is special access: declared here, granted by the user in the settings
    // screen requestPermissionsAsync() opens.
    androidPermissions: ["android.permission.WRITE_SETTINGS"],
    notes: "expo-brightness's get / set / restore (the screen's level on iOS, the app window's " +
      "on Android), Android's system brightness and mode (WRITE_SETTINGS, asked for by " +
      "requestPermissionsAsync) and iOS's brightness listener (with denext's DenextBrightness)",
    configure: () => ({ install: BRIGHTNESS_INSTALL }),
  },
  print: {
    npm: "@capgo/capacitor-printer",
    version: "^8.1.4",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "expo-print's printAsync (HTML or a file through the system print dialog; a " +
      "WebView cannot print by itself), printToFileAsync (HTML to PDF) and iOS's " +
      "selectPrinterAsync / printerUrl (with denext's DenextPrint)",
    configure: () => ({ install: PRINT_INSTALL }),
  },
  "intent-launcher": {
    npm: "@capgo/capacitor-intent-launcher",
    version: "^8.3.33",
    capacitorMajor: CAPACITOR_MAJOR,
    notes:
      "expo-intent-launcher's startActivityAsync / openApplication / getApplicationIconAsync " +
      "(Android intents; Android only)",
  },
  contacts: {
    npm: "@capgo/capacitor-contacts",
    version: "^8.1.4",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: { NSContactsUsageDescription: "Find and save your contacts." },
    androidPermissions: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
    notes: "expo-contacts' address book (read, add, update, remove, the picker and the system " +
      "contact forms), containers (iOS), change events and Android's full updates (with " +
      "denext's DenextContacts)",
    configure: () => ({ install: CONTACTS_INSTALL }),
  },
  calendar: {
    npm: "@ebarooni/capacitor-calendar",
    version: "^8.7.1",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: {
      NSCalendarsFullAccessUsageDescription: "Add and show your events.",
      NSCalendarsWriteOnlyAccessUsageDescription: "Add events to your calendar.",
      NSCalendarsUsageDescription: "Add and show your events.",
      NSRemindersFullAccessUsageDescription: "Add and show your reminders.",
      NSRemindersUsageDescription: "Add and show your reminders.",
    },
    androidPermissions: ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
    notes: "expo-calendar's calendars, events and (iOS) reminders, and the native event editor; " +
      "attendees, an event by id, one occurrence's changes, time zones and the event viewer " +
      "(with denext's DenextCalendar)",
    configure: () => ({ install: CALENDAR_INSTALL }),
  },
};
