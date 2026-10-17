// The native half of `onBack()` / `useBackProgress()` (denext/mobile) on Android, embedded as
// text so it ships inside the JSR package: `denext mobile add back` writes it into a Capacitor
// project. `DenextBackPlugin.java` in package `dev.denext.back` adds an AndroidX
// `OnBackPressedCallback` to the activity's dispatcher the first time the web app enables it,
// and forwards the predictive-back gesture (`handleOnBackStarted` / `Progressed` /
// `Cancelled`, Android 14+) and the committed back to the WebView as plugin events. The
// callback is enabled only while the web app has a back handler (or a progress listener), so
// the rest of the time the system's own back (and its back-to-home animation) runs. iOS has no
// back button: there is no iOS half.
//
// Edit this as source in native-templates/back.ts:
// it is compiled only in an app (against Capacitor 8, androidx.activity
// 1.8+ for `BackEventCompat`). Every `\`` there is an escaped template-literal character.
//
// Every file is written through `renderBackTemplate`, which puts a marker line on top: the
// template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump BACK_TEMPLATE_VERSION when the template changes.
//
// The template texts ship packed: native-templates/back.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the template, stamped into every file the installer writes. */
export const BACK_TEMPLATE_VERSION = 1;

/**
 * A template as the installer writes it: a first line
 * `// denext-back-template: <BACK_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of everything
 * after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderBackTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("back", BACK_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited back template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineBackTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("back", text) === true;
}

/** The Android files, for `android/app/src/main/java/dev/denext/back/`. */
export const BACK_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.back.BACK_ANDROID_FILES;
