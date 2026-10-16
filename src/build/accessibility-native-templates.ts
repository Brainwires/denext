// The native half of `isScreenReaderEnabled()` / `onScreenReaderChange()` (denext/mobile, and
// React Native mode's `AccessibilityInfo`) and of `getFontScale()` / `useFontScale()` (the OS
// text size: Dynamic Type on iOS, the font scale on Android), embedded as text so it ships inside
// the JSR package: `denext mobile add accessibility` writes it into a Capacitor project.
//
// - iOS: `ios/App/App/DenextAccessibilityPlugin.swift`, registered by
//   `DenextBridgeViewController`. `isScreenReaderEnabled()` reads
//   `UIAccessibility.isVoiceOverRunning`; `voiceOverStatusDidChangeNotification` fires
//   `screenReaderChanged`. `getFontScale()` maps `preferredContentSizeCategory` to React
//   Native's font scale table (large = 1.0); `UIContentSizeCategory.didChangeNotification` fires
//   `fontScaleChanged`. A WKWebView does not apply Dynamic Type to the page itself.
// - Android: `dev/denext/accessibility/DenextAccessibilityPlugin.java`, registered from
//   `MainActivity`. `isScreenReaderEnabled()` reads `AccessibilityManager.isTouchExplorationEnabled`
//   (TalkBack and the other touch-exploration services, as React Native reports it); a
//   `TouchExplorationStateChangeListener` fires `screenReaderChanged`. `getFontScale()` answers
//   `Configuration.fontScale` and the WebView's `textZoom` (the part of it the WebView already
//   applies to the page); a configuration change the activity handles fires `fontScaleChanged`.
//
// Both answer `{ value: boolean }` and send `{ value: boolean }` with the event: the contract
// React Native mode's AccessibilityInfo overlay already reads. The font scale answers and sends
// `{ value: number, textZoom?: number }` (`textZoom` in percent, Android only).
//
// Generation 2 (denext 2.11) added the font scale; an unedited generation-1 file is upgraded.
//
// Edit these as source in native-templates/accessibility.ts:
// they are compiled only in an app (against Capacitor 8). Every `\``
// there is an escaped template-literal character.
//
// Every file is written through `renderAccessibilityTemplate`, which puts a marker line on top:
// the template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump ACCESSIBILITY_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/accessibility.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const ACCESSIBILITY_TEMPLATE_VERSION = 2;

/**
 * A template as the installer writes it: a first line
 * `// denext-accessibility-template: <ACCESSIBILITY_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256
 * of everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderAccessibilityTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("accessibility", ACCESSIBILITY_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited accessibility template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineAccessibilityTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("accessibility", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const ACCESSIBILITY_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.accessibility.ACCESSIBILITY_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/accessibility/`. */
export const ACCESSIBILITY_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.accessibility.ACCESSIBILITY_ANDROID_FILES;
