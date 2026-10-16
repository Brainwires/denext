// `denext mobile add calendar | contacts | print | brightness`: beside the pinned npm plugin
// each installs (which keeps doing what it does), install denext's own native plugin for the
// expo-calendar / expo-contacts / expo-print / expo-brightness calls that plugin has no call for
// (src/build/expo-sdk-native-templates.ts). iOS: `<Name>Plugin.swift`, added to the Xcode app
// target and registered by `DenextBridgeViewController`. Android: `dev/denext/<name>/` registered
// from `MainActivity` (print also writes `android/print/DenextPdfWriter.java`). Each composes with
// every other denext native feature in either order (see mobile-native-install.ts). Running it
// twice changes nothing.

import {
  BRIGHTNESS_ANDROID_FILES,
  BRIGHTNESS_IOS_FILES,
  CALENDAR_ANDROID_FILES,
  CALENDAR_IOS_FILES,
  CONTACTS_ANDROID_FILES,
  CONTACTS_IOS_FILES,
  type ExpoSdkFamily,
  PRINT_ANDROID_FILES,
  PRINT_ANDROID_PDF_FILES,
  PRINT_IOS_FILES,
} from "./expo-sdk-native-templates.ts";
import {
  expoSdkTemplates,
  type NativeInstallOptions,
  type NativeInstallReport,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin, type RegisteredPluginSpec } from "./mobile-plugin-install.ts";
import type { NativeInstallStep } from "./mobile-capabilities.ts";

/** The plugin class each family registers. */
const PLUGIN_CLASS: Readonly<Record<ExpoSdkFamily, string>> = {
  calendar: "DenextCalendarPlugin",
  contacts: "DenextContactsPlugin",
  print: "DenextPrintPlugin",
  brightness: "DenextBrightnessPlugin",
};

/** Each family's templates and where they go. */
const FILES: Readonly<
  Record<ExpoSdkFamily, Pick<RegisteredPluginSpec, "iosFiles" | "androidFiles" | "androidExtra">>
> = {
  calendar: { iosFiles: CALENDAR_IOS_FILES, androidFiles: CALENDAR_ANDROID_FILES },
  contacts: { iosFiles: CONTACTS_IOS_FILES, androidFiles: CONTACTS_ANDROID_FILES },
  print: {
    iosFiles: PRINT_IOS_FILES,
    androidFiles: PRINT_ANDROID_FILES,
    androidExtra: {
      dir: "android/app/src/main/java/android/print",
      files: PRINT_ANDROID_PDF_FILES,
    },
  },
  brightness: { iosFiles: BRIGHTNESS_IOS_FILES, androidFiles: BRIGHTNESS_ANDROID_FILES },
};

/**
 * Install denext's `family` plugin (`DenextCalendar`, `DenextContacts`, `DenextPrint` or
 * `DenextBrightness`) into the Capacitor project at `opts.dir`: the Swift file in the Xcode app
 * target, registered by `DenextBridgeViewController` (the storyboard and SceneDelegate switched
 * to it while they are stock), and the Java file(s) registered from `MainActivity`. Idempotent;
 * an unedited template from an earlier denext is upgraded, and customised files are never
 * rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param family The plugin.
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export function addExpoSdkPluginToProject(
  family: ExpoSdkFamily,
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const cls = PLUGIN_CLASS[family];
  return installRegisteredPlugin(opts, {
    feature: family,
    ...FILES[family],
    androidDir: `android/app/src/main/java/dev/denext/${family}`,
    kind: expoSdkTemplates(family),
    registration: {
      needle: `${cls}()`,
      step: "make capacitorDidLoad() call " +
        `\`bridge?.registerPluginInstance(${cls}())\` after super.capacitorDidLoad().`,
    },
  });
}

/** The native step of `family`'s capability: its denext plugin and the registration. */
function expoSdkInstall(family: ExpoSdkFamily, what: string): NativeInstallStep {
  return {
    label: `${PLUGIN_CLASS[family].replace(/Plugin$/, "")} plugin (${what}) + its registration ` +
      "in DenextBridgeViewController / MainActivity",
    run: (opts) => addExpoSdkPluginToProject(family, opts),
  };
}

/** `calendar`'s native step: DenextCalendar beside the pinned calendar plugin. */
export const CALENDAR_INSTALL: NativeInstallStep = expoSdkInstall(
  "calendar",
  "attendees, an event by id, one occurrence's changes and time zone, the event viewer",
);
/** `contacts`' native step: DenextContacts beside the pinned contacts plugin. */
export const CONTACTS_INSTALL: NativeInstallStep = expoSdkInstall(
  "contacts",
  "containers, change events, Android's full updates",
);
/** `print`'s native step: DenextPrint beside the pinned printer plugin. */
export const PRINT_INSTALL: NativeInstallStep = expoSdkInstall(
  "print",
  "HTML to PDF, the iOS printer picker",
);
/** `brightness`' native step: DenextBrightness beside the pinned brightness plugin. */
export const BRIGHTNESS_INSTALL: NativeInstallStep = expoSdkInstall(
  "brightness",
  "Android's system brightness and mode, brightness change events",
);
