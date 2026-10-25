// The native halves of the expo-calendar, expo-contacts, expo-print and expo-brightness calls the
// pinned Capacitor plugins have no call for, embedded as text so they ship inside the JSR
// package: `denext mobile add calendar | contacts | print | brightness` writes each beside the
// pinned plugin (which keeps doing the rest) into a Capacitor project.
//
// - calendar: `DenextCalendar` (EventKit / CalendarContract): an event by id, an occurrence's
//   attendees (read-only on iOS; added, changed and removed on Android), changing one
//   occurrence or its time zone, and the system event viewer / editor on an event.
// - contacts: `DenextContacts` (Contacts / ContactsContract): containers (iOS), change events,
//   and on Android the postal addresses, URLs, birthday and photo the pinned plugin's update
//   drops.
// - print: `DenextPrint`: HTML to a PDF file (UIMarkupTextPrintFormatter + UIPrintPageRenderer on
//   iOS; a WebView's print adapter on Android), and the iOS printer picker / printing straight to
//   a printer.
// - brightness: `DenextBrightness`: Android's system brightness and brightness mode (behind
//   WRITE_SETTINGS) and iOS's brightness change events.
//
// iOS: `<Name>Plugin.swift` in `ios/App/App/`, registered by `DenextBridgeViewController`.
// Android: `dev/denext/<name>/<Name>Plugin.java`, registered from `MainActivity` (print also
// writes `android/print/DenextPdfWriter.java`). Edit these as source in
// native-templates/{calendar,contacts,print,brightness}.ts: they are compiled only in an app
// (against Capacitor 8).
//
// Every file is written through `renderExpoSdkTemplate`, which puts a marker line on top: the
// family, its template generation and the SHA-256 of the rest of the file. A file whose marker
// still matches its body is an unedited denext template and is upgraded in place by a later run;
// an edited one is kept. Bump the family's version in EXPO_SDK_TEMPLATE_VERSIONS when its
// templates change.
//
// The template texts ship packed: native-templates/*.ts (the readable sources, not published)
// are packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The Expo SDK plugin families denext writes. */
export type ExpoSdkFamily = "calendar" | "contacts" | "print" | "brightness";

/**
 * Each family's template generation, stamped into every file of it the installer writes. Print
 * generation 2: iOS `printToPrinter` prints only a file in the app's Documents, Caches or temporary
 * folder, and Android `printToFile`'s WebView cannot read `file:` / `content:` URLs; the bump keeps
 * an older denext from rewriting either away.
 */
export const EXPO_SDK_TEMPLATE_VERSIONS: Readonly<Record<ExpoSdkFamily, number>> = {
  calendar: 2,
  contacts: 1,
  print: 2,
  brightness: 1,
};

/**
 * A template as the installer writes it: a first line
 * `// denext-<family>-template: <version> sha256=<hex>` (the SHA-256 of everything after that
 * line), then the template.
 *
 * @param family The plugin family.
 * @param template The template text.
 * @returns The file content.
 */
export function renderExpoSdkTemplate(family: ExpoSdkFamily, template: string): Promise<string> {
  return renderMarkedTemplate(family, EXPO_SDK_TEMPLATE_VERSIONS[family], template);
}

/**
 * Whether `text` is an unedited `family` template: its marker line matches its body.
 *
 * @param family The plugin family.
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineExpoSdkTemplate(
  family: ExpoSdkFamily,
  text: string,
): Promise<boolean> {
  return await markedTemplateIntact(family, text) === true;
}

/** `DenextCalendar` for iOS, for `ios/App/App/`. */
export const CALENDAR_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.calendar.CALENDAR_IOS_FILES;
/** `DenextCalendar` for Android, for `android/app/src/main/java/dev/denext/calendar/`. */
export const CALENDAR_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.calendar.CALENDAR_ANDROID_FILES;

/** `DenextContacts` for iOS, for `ios/App/App/`. */
export const CONTACTS_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.contacts.CONTACTS_IOS_FILES;
/** `DenextContacts` for Android, for `android/app/src/main/java/dev/denext/contacts/`. */
export const CONTACTS_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.contacts.CONTACTS_ANDROID_FILES;

/** `DenextPrint` for iOS, for `ios/App/App/`. */
export const PRINT_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.print.PRINT_IOS_FILES;
/** `DenextPrint` for Android, for `android/app/src/main/java/dev/denext/print/`. */
export const PRINT_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.print.PRINT_ANDROID_FILES;
/** Its PDF writer, for `android/app/src/main/java/android/print/`. */
export const PRINT_ANDROID_PDF_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.print.PRINT_ANDROID_PDF_FILES;

/** `DenextBrightness` for iOS, for `ios/App/App/`. */
export const BRIGHTNESS_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.brightness.BRIGHTNESS_IOS_FILES;
/** `DenextBrightness` for Android, for `android/app/src/main/java/dev/denext/brightness/`. */
export const BRIGHTNESS_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.brightness.BRIGHTNESS_ANDROID_FILES;
