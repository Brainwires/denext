// The native half of `downloadToFile()` / `uploadFile()` and the transfer controls
// (`pauseFileTransfer`, `resumeFileTransfer`, `cancelFileTransfer`, `fileTransfers`,
// `onFileTransfer`) from denext/mobile, embedded as text so it ships inside the JSR package:
// `denext mobile add file-transfer` writes it into a Capacitor project.
//
// - iOS: `ios/App/App/DenextTransferManager.swift` (a `URLSession` background session that keeps
//   running with the app suspended or terminated, its records saved under Application Support)
//   and `DenextTransferPlugin.swift` (registered by `DenextBridgeViewController`). AppDelegate
//   forwards `handleEventsForBackgroundURLSession` to the manager.
// - Android: `dev/denext/transfer/`: `DenextTransferPlugin.java` (registered from `MainActivity`),
//   `DenextTransferWorker.java` (one unique WorkManager job per transfer, network-constrained),
//   `DenextTransferStore.java` (the records, in shared preferences; a live record's request
//   headers in the no-backup folder) and `DenextTransferHttp.java` (the HTTP half in plain
//   Java: range-resumed downloads, multipart uploads). The app's build.gradle gains
//   `androidx.work:work-runtime`.
//
// The JS contract (src/mobile/file-transfer.ts): `start({ id, kind, url, directory, path, method,
// headers, multipart?, mimeType?, background })` → `{ id }`; `pause` / `resume` / `cancel` /
// `forget({ id })` → `{ paused | resumed | cancelled | forgotten }`; `list()` → `{ transfers }`;
// the `transfer` event `{ id, type, kind, state, bytes, total?, status?, file?, body?, headers?,
// code?, error?, resumable }`.
//
// Edit these as source in native-templates/transfer.ts: they are compiled only in an app
// (against Capacitor 8). Every `\`` there is an escaped template-literal character.
//
// Every file is written through `renderTransferTemplate`, which puts a marker line on top: the
// template generation and the SHA-256 of the rest of the file. A file whose marker still matches
// its body is an unedited denext template and is upgraded in place by a later run; an edited one
// is kept. Bump TRANSFER_TEMPLATE_VERSION when the templates change.
//
// The template texts ship packed: native-templates/transfer.ts (the readable source, not
// published) is packed with the others into native-templates.packed.ts by
// `deno task gen:native-templates`.

import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";

/** The generation of the templates, stamped into every file the installer writes. */
export const TRANSFER_TEMPLATE_VERSION = 4;

/**
 * A template as the installer writes it: a first line
 * `// denext-transfer-template: <TRANSFER_TEMPLATE_VERSION> sha256=<hex>` (the SHA-256 of
 * everything after that line), then the template.
 *
 * @param template The template text.
 * @returns The file content.
 */
export function renderTransferTemplate(template: string): Promise<string> {
  return renderMarkedTemplate("transfer", TRANSFER_TEMPLATE_VERSION, template);
}

/**
 * Whether `text` is an unedited transfer template: its marker line matches its body.
 *
 * @param text A file's content.
 * @returns `true` when the file carries an intact marker.
 */
export async function isPristineTransferTemplate(text: string): Promise<boolean> {
  return await markedTemplateIntact("transfer", text) === true;
}

/** The iOS files, for `ios/App/App/`. */
export const TRANSFER_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.transfer.TRANSFER_IOS_FILES;

/** The Android files, for `android/app/src/main/java/dev/denext/transfer/`. */
export const TRANSFER_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.transfer.TRANSFER_ANDROID_FILES;

/** The WorkManager dependency the Android worker needs, as `android/app/build.gradle` lists it. */
export const WORK_RUNTIME_DEPENDENCY = "implementation 'androidx.work:work-runtime:2.10.5'";
