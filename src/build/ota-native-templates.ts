// The native halves of denext's over-the-air UI updates, embedded as text so they ship
// inside the JSR package: `denext mobile add-ota` writes them into a Capacitor project.
// iOS: three Swift files for `ios/App/App/` (the plugin, its store, and the bridge view
// controller that picks the start directory). Android: three Java files in package
// `dev.denext.ota` (no clash with the app's own package). Behaviour and state keys are the
// same on both platforms; see the "Over-the-air UI updates" section of the desktop docs.
//
// Edit these as source in native-templates/ota.ts:
// they are compiled only in an app (the iOS ones were build-checked
// with xcodebuild against Capacitor 8). Every `\`` and `\${` there is an escaped
// template-literal character, not part of the Swift/Java.
//
// `add-ota` writes each file through `renderOtaTemplate`, which puts a marker line on top:
// the template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later
// `add-ota`; so is a file matching one of the SHIPPED_OTA_TEMPLATE_SHA256 hashes (the
// templates denext 2.7.0 … 2.8.3 wrote, before the marker existed). Bump OTA_TEMPLATE_VERSION
// when the templates change.
//
// The template texts ship packed: native-templates/ota.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import {
  markedTemplateIntact,
  renderMarkedTemplate,
  sha256Text,
} from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/**
 * The generation of the templates, stamped into every file `add-ota` writes. Generation 5
 * (denext 2.11): the composed `DenextBridgeViewController` can register the DenextSettings and
 * DenextAccessibility plugins, which 2.10.0 (generation 4) does not know; the bump makes 2.10.0
 * keep such a bridge (a newer denext's) instead of rewriting it without them. The same
 * generation's bridge also drops native bridge calls from frames other than the main one (see
 * bridge-frame-guard-native-template.ts), which 2.10.0 therefore never rewrites away.
 * Generation 6: the bridge serves an exported multi-page app's routes from the UI directory in
 * use, bundled or over the air (`DenextExportRouter`, see
 * bridge-export-router-native-template.ts); the bump keeps an older denext from rewriting it away.
 * Generation 7: the store pins the origins a UI may come from (`DenextOtaOrigins` /
 * `dev.denext.ota.ORIGINS`), and without a public key accepts only a pinned https origin or
 * loopback; the bump keeps an older denext from rewriting that check away. The same unreleased
 * generation's router refuses a path that leaves the UI directory (a decoded `/../secret`).
 * Generation 8: the bridge forwards the OS's low-memory warning to the page
 * (`DenextMemoryWarning`, see bridge-memory-warning-native-template.ts: React Native mode's
 * `AppState` `memoryWarning`); the bump keeps an older denext from rewriting it away.
 * Generation 9: a downloaded UI is re-verified whenever it is served, not only when it arrives:
 * the stored manifest keeps the signed fields and is checked at every launch (signature and
 * version), and each file's SHA-256 is checked the first time it is served in a process (iOS:
 * `DenextOtaRouter`; Android: the `RouteProcessor` `DenextOta.prepare` installs). A mismatch
 * quarantines the version, falls back to the bundled UI and fires `otaRejected`. A file that is
 * there but cannot be read right now (a launch before the first unlock, by a silent push or a
 * BGTask, finds it data-protected; a permission or I/O error) is not a mismatch: that request is
 * refused (or, for the stored manifest at launch, this launch serves the confirmed or bundled UI)
 * and nothing is quarantined. The bump keeps an older denext from rewriting the check away.
 */
export const OTA_TEMPLATE_VERSION = 9;

/**
 * SHA-256 of every template file denext shipped before the marker line existed, by file name:
 * `git show <tag>:src/build/ota-native-templates.ts` at v2.7.0, v2.7.1 (the same), and v2.8.0 …
 * v2.8.3 (the same). A project file equal to one of them is an unedited denext template.
 */
export const SHIPPED_OTA_TEMPLATE_SHA256: Readonly<Record<string, readonly string[]>> = {
  "DenextBridgeViewController.swift": [
    "51a93de430e9943f092127c3ceacc7f986c34b6c210b195c295141d2f1305935",
  ],
  "DenextOtaPlugin.swift": [
    "cb83d47eacaa4386fc958faa0f926f293f33ee96647c154c075de7488ae3fc75",
    "b224256110ef09f169d00a80ca66b403a79b119a4da3008240f977d8ce4691b2",
  ],
  "DenextOtaStore.swift": [
    "6dd6987be3a7d26269e1bf8442f4e946bb560d610f7f065f5a1396a5192f288c",
    "89e8509b465ff9358c706cc92e2ffa4041670a4e82f0f38aba834d86a737bdf8",
  ],
  "DenextOta.java": [
    "9a751ae14ddcf07b0d3b2b52a88b2bd996ca291ccc271139cf622506985d12a3",
  ],
  "DenextOtaPlugin.java": [
    "84a45228b39fca4dd38d2c986220192e0a94f767bf463bfb34ea11934f10a619",
    "718d9971f9af3662a113a4f837dea78f4da178a4424da6acfdd11a9b507395bd",
  ],
  "DenextOtaStore.java": [
    "a01a0f127381158137aee57dfb9333dafbe6262ed24628d691b8af2395c5cdab",
    "685636c87aa660389f4c4ba8e714855dda02cee644769c82212466d2ea83a9f7",
  ],
};

/**
 * A template as `add-ota` writes it: a first line
 * `// denext-ota-template: <OTA_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of everything after
 * that line), then the template.
 */
export function renderOtaTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("ota", OTA_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited denext template for `name`: its marker line matches its body, or
 * it is byte-for-byte a template denext shipped before markers ({@linkcode SHIPPED_OTA_TEMPLATE_SHA256}).
 */
export async function isPristineOtaTemplate(name: string, text: string): Promise<boolean> {
  const marked = await markedTemplateIntact("ota", text);
  if (marked !== undefined) return marked;
  return (SHIPPED_OTA_TEMPLATE_SHA256[name] ?? []).includes(await sha256Text(text));
}

/** Swift sources for `ios/App/App/`, keyed by file name. */
export const OTA_IOS_FILES: Readonly<Record<string, string>> = NATIVE_TEMPLATES.ota.OTA_IOS_FILES;

/** Java sources for `android/app/src/main/java/dev/denext/ota/`, keyed by file name. */
export const OTA_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.ota.OTA_ANDROID_FILES;
