// The native half of `showContextMenu()` / `useContextMenu()` (denext/mobile), embedded as text
// so it ships inside the JSR package: `denext mobile add context-menu` writes it into a
// Capacitor project.
//
// - iOS: `ios/App/App/DenextContextMenuPlugin.swift`, registered by `DenextBridgeViewController`.
//   `arm` / `disarm` feed a `UIContextMenuInteraction` on the web view (the system long press,
//   the lifted element preview, `UIMenu` with SF Symbols, subtitles, destructive / disabled
//   items and submenus; `menuAction` events); `show` presents a `UIMenu` at a point
//   (`UIEditMenuInteraction` on iOS 16+, an action sheet on iOS 15).
// - Android: `dev/denext/contextmenu/DenextContextMenuPlugin.java`, registered from
//   `MainActivity`. `show` opens a `PopupMenu` anchored at the point (submenus as labelled
//   groups, destructive items in the Material error color, the long-press haptic).
//
// Both have `dismiss({ target })`: `"menu"` closes the menu `show` opened (it answers as
// dismissed), `"sheet"` closes the system action sheet `@capacitor/action-sheet` presents (iOS: a
// presented `UIAlertController` in the action-sheet style; Android: its
// `BottomSheetDialogFragment`, tagged `capacitorModalsActionSheet`), whose call is then never
// answered, as React Native's `ActionSheetIOS.dismissActionSheet()` never calls the callback.
// They resolve `{ dismissed }`. `denext mobile add action-sheet` installs this plugin for it.
//
// Generation 2 added `dismiss`; an unedited generation-1 file is upgraded, and the bump keeps an
// older denext from rewriting the method away.
//
// Edit these as source in native-templates/context-menu.ts:
// they are compiled only in an app (build-checked with xcodebuild and
// Gradle against Capacitor 8). Every `\``, `\${` and `\\` there is an escaped template-literal
// character, not part of the Swift/Java.
//
// Every file is written through `renderContextMenuTemplate`, which puts a marker line on top:
// the template generation and the SHA-256 of the rest of the file. A file whose marker still
// matches its body is an unedited denext template and is upgraded in place by a later run; an
// edited one is kept. Bump CONTEXT_MENU_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/context-menu.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const CONTEXT_MENU_TEMPLATE_VERSION = 2;

/**
 * A template as the installer writes it: a first line
 * `// denext-context-menu-template: <CONTEXT_MENU_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256
 * of everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderContextMenuTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("context-menu", CONTEXT_MENU_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited context-menu template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineContextMenuTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("context-menu", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const CONTEXT_MENU_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.contextMenu.CONTEXT_MENU_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/contextmenu/`. */
export const CONTEXT_MENU_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.contextMenu.CONTEXT_MENU_ANDROID_FILES;
