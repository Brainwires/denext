// The native halves of denext's app extensions, embedded as text so they ship inside the JSR
// package: `denext mobile add share-extension | widget | live-activity` writes them into a
// Capacitor project. This file holds what the three share (the template family, the bridge
// view controller that registers the plugins when the project has no over-the-air UI, the
// extension Info.plist) and the share extension itself:
//
// - iOS: `ios/App/DenextShareExtension/` (a Share Extension target: `ShareViewController.swift`
//   and `DenextShareInbox.swift`, which the App target compiles too) and
//   `ios/App/App/DenextShareReceivePlugin.swift` (the plugin behind `onShareReceived`).
// - Android: `dev/denext/sharereceive/DenextShareReceivePlugin.java` (reads the SEND intent).
//
// Widgets and Live Activities are in widget-native-templates.ts.
//
// Edit these as source in native-templates/app-extension.ts:
// they are compiled only in an app (build-checked with xcodebuild and
// Gradle against Capacitor 8). The templates are `String.raw` literals, so a Swift `\(x)` or a
// Java `"\n"` is written as is; only `${…}` interpolates (the names the installer passes).
//
// Every file is written through `renderAppExtensionTemplate`, which puts a marker line on top
// (a `//` comment, or `<!-- … -->` in an XML file): the template generation and the SHA-256 of
// the rest of the file. A file whose marker still matches its body is an unedited denext
// template and is upgraded in place by a later run; an edited one is kept. Bump
// APP_EXTENSION_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/app-extension.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import {
  markedTemplateIntact,
  type MarkerStyle,
  renderMarkedTemplate,
} from "./native-template-marker.ts";
import { withFrameGuard } from "./bridge-frame-guard-native-template.ts";
import { withMemoryWarning } from "./bridge-memory-warning-native-template.ts";
import { withExportRouter } from "./bridge-export-router-native-template.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/**
 * The generation of the templates, stamped into every file the installers write. Generation 2
 * (denext 2.11): the registering-only `DenextBridgeViewController` (written in this family) can
 * register the DenextSettings and DenextAccessibility plugins (and, in the same unreleased
 * generation, the native views and the app's own native modules), which 2.10.0 (generation 1)
 * does not know; the bump makes 2.10.0 keep such a bridge instead of rewriting it without them.
 * The same generation's bridge also drops native bridge calls from frames other than the main
 * one (bridge-frame-guard-native-template.ts), which 2.10.0 therefore never rewrites away.
 * Generation 3: the bridge serves an exported multi-page app's routes (`DenextExportRouter`, see
 * bridge-export-router-native-template.ts), which an older denext would rewrite away; the bridge
 * with no registrations at all is what `denext mobile add export-routes` writes.
 * Generation 4: the router refuses a path that leaves the UI directory (a decoded `/../secret`),
 * which an older denext would rewrite away.
 * Generation 5: the bridge forwards the OS's low-memory warning to the page
 * (`DenextMemoryWarning`, see bridge-memory-warning-native-template.ts: React Native mode's
 * `AppState` `memoryWarning`); the bump keeps an older denext from rewriting it away.
 * Bump again only when a released generation would drop a registration, the frame guard, the
 * memory-warning forwarder or the router (or one of its checks).
 */
export const APP_EXTENSION_TEMPLATE_VERSION = 5;

/** The marker family of the app extension templates. */
const FAMILY = "app-extension";

/**
 * A template as the installers write it: a first line
 * `// denext-app-extension-template: <APP_EXTENSION_TEMPLATE_VERSION> sha256=<hex>` (or the same
 * as an XML comment), then the template.
 *
 * @param template The template text.
 * @param style `"xml"` for an XML file.
 * @returns The file content.
 */
export function renderAppExtensionTemplate(
  template: string,
  style: MarkerStyle = "line",
): Promise<string> {
  return renderMarkedTemplate(FAMILY, APP_EXTENSION_TEMPLATE_VERSION, template, style);
}

/**
 * Whether `text` is an unedited app extension template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineAppExtensionTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact(FAMILY, text) === true;
}

/** The share extension's target (and folder, under `ios/App/`). */
export const SHARE_EXTENSION_TARGET = "DenextShareExtension";

/**
 * `DenextBridgeViewController.swift` for a project without the over-the-air UI that registers
 * `registrations` (Swift statements, one per line, already indented). With OTA installed, the
 * OTA bridge view controller registers them instead.
 *
 * @param registrations The registration lines.
 * @returns The template (without its marker).
 */
export function genericBridgeViewController(registrations: string): string {
  return withExportRouter(withFrameGuard(withMemoryWarning(String
    .raw`// Generated by denext (denext mobile add). Safe to commit; re-run it after upgrading denext
// (then ship a new binary). denext mobile add-ota replaces this file with one that also serves
// the over-the-air UI. See https://denext.dev/docs/desktop.

@preconcurrency import Capacitor
import UIKit

/// A CAPBridgeViewController that registers denext's native plugins before the first page.
///
/// Use it where the app would use CAPBridgeViewController: Main.storyboard's view controller
/// class and SceneDelegate's root view controller (the installer sets both when they still name
/// CAPBridgeViewController). An app with its own bridge subclass changes that subclass's
/// superclass to DenextBridgeViewController and calls super from any capacitorDidLoad()
/// override.
class DenextBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
${registrations}    }
}
`)));
}

/**
 * An extension's `Info.plist` (written once, never replaced: its keys are edited in place).
 *
 * @param displayName The name the share sheet / widget gallery shows.
 * @param extension The `NSExtension` dict's inner lines (indented two tabs).
 * @returns The plist.
 */
export function extensionInfoPlist(displayName: string, extension: string): string {
  const name = displayName.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>$(DEVELOPMENT_LANGUAGE)</string>
	<key>CFBundleDisplayName</key>
	<string>${name}</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>NSExtension</key>
	<dict>
${extension}	</dict>
</dict>
</plist>
`;
}

/** The share extension's `NSExtension` dict: URL, text and up to ten images. */
export const SHARE_EXTENSION_ATTRIBUTES = `		<key>NSExtensionAttributes</key>
		<dict>
			<key>NSExtensionActivationRule</key>
			<dict>
				<key>NSExtensionActivationSupportsText</key>
				<true/>
				<key>NSExtensionActivationSupportsWebURLWithMaxCount</key>
				<integer>1</integer>
				<key>NSExtensionActivationSupportsImageWithMaxCount</key>
				<integer>10</integer>
			</dict>
		</dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.share-services</string>
		<key>NSExtensionPrincipalClass</key>
		<string>ShareViewController</string>
`;

/** Swift sources for `ios/App/DenextShareExtension/`, keyed by file name. */
export const SHARE_EXTENSION_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.appExtension.SHARE_EXTENSION_IOS_FILES;

/** The app-side plugin for `ios/App/App/`. */
export const SHARE_RECEIVE_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.appExtension.SHARE_RECEIVE_IOS_FILES;

/** Java sources for `android/app/src/main/java/dev/denext/sharereceive/`, keyed by file name. */
export const SHARE_RECEIVE_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.appExtension.SHARE_RECEIVE_ANDROID_FILES;

/** The launcher activity's intent filters that make the app a share target on Android. */
export const SHARE_INTENT_FILTERS: readonly string[] = [
  "<!-- denext share-extension: shared text, links and images reach onShareReceived. -->",
  "<intent-filter>",
  '    <action android:name="android.intent.action.SEND" />',
  '    <category android:name="android.intent.category.DEFAULT" />',
  '    <data android:mimeType="text/plain" />',
  '    <data android:mimeType="image/*" />',
  "</intent-filter>",
  "<intent-filter>",
  '    <action android:name="android.intent.action.SEND_MULTIPLE" />',
  '    <category android:name="android.intent.category.DEFAULT" />',
  '    <data android:mimeType="text/plain" />',
  '    <data android:mimeType="image/*" />',
  "</intent-filter>",
];
