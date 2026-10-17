// The native half of `<SystemIcon>` (denext/mobile), embedded as text so it ships inside the JSR
// package: `denext mobile add system-icons` writes it into a Capacitor project.
//
// - iOS: `ios/App/App/DenextSystemIconPlugin.swift`, registered by `DenextBridgeViewController`.
//   `render` draws an SF Symbol with `UIImage(systemName:withConfiguration:)` (weight, scale,
//   hierarchical / palette / multicolor) into a PNG data URL at the device's pixel scale, cached.
// - Android: nothing. SF Symbols are licensed for Apple platforms only; `<SystemIcon>` draws a
//   Material Symbol there (and on the web) from denext's own inline SVG set.
//
// Edit it as source in native-templates/system-icon.ts:
// it is compiled only in an app (build-checked with xcodebuild against
// Capacitor 8). Every `\``, `\${` and `\\` there is an escaped template-literal character.
//
// It is written through `renderSystemIconTemplate` (a `// denext-system-icon-template:` marker
// line: the generation and the SHA-256 of the rest). Bump SYSTEM_ICON_TEMPLATE_VERSION when it
// changes.
//
// The template texts ship packed: native-templates/system-icon.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the template, stamped into the file the installer writes. */
export const SYSTEM_ICON_TEMPLATE_VERSION = 1;

/**
 * The template as the installer writes it: a first line
 * `// denext-system-icon-template: <SYSTEM_ICON_TEMPLATE_VERSION> sha256=<hex>`, then the text.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderSystemIconTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("system-icon", SYSTEM_ICON_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited system-icon template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineSystemIconTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("system-icon", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const SYSTEM_ICON_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.systemIcon.SYSTEM_ICON_IOS_FILES;
