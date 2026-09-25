/**
 * Image and document pickers for `denext/mobile`: the native `Camera` and `FilePicker` plugins
 * in the shell, else a hidden `<input type="file">` created for the call.
 *
 * @module
 */

import { blobToBase64, isDismissal } from "./base64.ts";
import { nativePlugin } from "./plugin.ts";

/**
 * Where {@linkcode pickImage} gets the picture: `"camera"` (take one), `"photos"` (the photo
 * library) or `"prompt"` (ask the user which; the default).
 */
export type ImageSource = "camera" | "photos" | "prompt";

/** Options for {@linkcode pickImage}. */
export interface PickImageOptions {
  /** Where the picture comes from. Default `"prompt"`. */
  readonly source?: ImageSource;
  /** JPEG quality, 0–100 (native only; the browser returns the file as picked). */
  readonly quality?: number;
  /**
   * What to return: `"webPath"` (the default), a URL an `<img>` can show without copying the
   * bytes into JavaScript, or `"dataUrl"`, the image inline as a `data:` URL.
   */
  readonly as?: "webPath" | "dataUrl";
}

/** A picture from {@linkcode pickImage}: one of `webPath` / `dataUrl`, plus its format. */
export interface PickedImage {
  /** A URL for `<img src>` (a `capacitor://` file URL natively, a `blob:` URL on the web). */
  readonly webPath?: string;
  /** The image as a `data:` URL (with `as: "dataUrl"`). */
  readonly dataUrl?: string;
  /** The image format: `"jpeg"`, `"png"`, `"heic"`, … (lower case). */
  readonly format: string;
}

/** Options for {@linkcode pickDocument}. */
export interface PickDocumentOptions {
  /** Accepted MIME types (`"application/pdf"`, `"image/*"`). Default: any file. */
  readonly types?: readonly string[];
  /**
   * Natively, also read the file into `data` (base64). Default `false`: large files can
   * exhaust memory, so the native result carries `path` alone unless asked. The web result
   * always carries `data`.
   */
  readonly readData?: boolean;
}

/** A file from {@linkcode pickDocument}. */
export interface PickedDocument {
  /** The file name, extension included. */
  readonly name: string;
  /** Its MIME type (`application/octet-stream` when the platform does not know it). */
  readonly mimeType: string;
  /** Its size in bytes. */
  readonly size: number;
  /** The contents as base64: always on the web, natively with `readData: true`. */
  readonly data?: string;
  /** The native file path of the picked copy (native only). */
  readonly path?: string;
}

/** The JS side of `@capacitor/camera` (the call {@linkcode pickImage} makes). */
interface CameraPlugin {
  getPhoto(options: {
    resultType: "uri" | "dataUrl";
    source: string;
    quality?: number;
    allowEditing: boolean;
  }): Promise<{ webPath?: string; dataUrl?: string; format?: string }>;
}

/** The JS side of `@capawesome/capacitor-file-picker` (the call {@linkcode pickDocument} makes). */
interface FilePickerPlugin {
  pickFiles(options: { types?: string[]; limit: number; readData: boolean }): Promise<{
    files?: Array<
      { name?: string; mimeType?: string; size?: number; data?: string; path?: string }
    >;
  }>;
}

/** {@linkcode ImageSource} → the Camera plugin's `CameraSource` value. */
const CAMERA_SOURCE: Record<ImageSource, string> = {
  camera: "CAMERA",
  photos: "PHOTOS",
  prompt: "PROMPT",
};

/** The slice of `document` the web pickers use. */
interface PickerDocument {
  createElement(tag: "input"): HTMLInputElement;
  body?: { appendChild(node: unknown): unknown } | null;
}

/**
 * Open the browser's file chooser through a hidden `<input type="file">` made for this call
 * and removed after it. Resolves the chosen file, or null when the chooser is dismissed.
 */
function chooseFile(fn: string, accept: string, capture: boolean): Promise<File | null> {
  const doc = (globalThis as { document?: PickerDocument }).document;
  if (typeof doc?.createElement !== "function" || !doc.body) {
    return Promise.reject(new Error(`${fn}: no document to open a file chooser in (SSR)`));
  }
  const input = doc.createElement("input");
  input.type = "file";
  if (accept) input.accept = accept;
  if (capture) input.setAttribute("capture", "environment");
  input.style.display = "none";
  return new Promise((resolve) => {
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    doc.body!.appendChild(input);
    input.click();
  });
}

/** The format of an image file: its MIME subtype, else its extension. */
function imageFormat(file: File): string {
  const sub = /^image\/([\w.+-]+)/.exec(file.type)?.[1];
  const ext = /\.([\w]+)$/.exec(file.name)?.[1];
  return (sub ?? ext ?? "unknown").toLowerCase();
}

/** Resolve `run()`, or null when the user dismissed the plugin's UI. */
async function unlessDismissed<T>(run: () => Promise<T>, codes: readonly string[]) {
  try {
    return await run();
  } catch (err) {
    if (isDismissal(err, codes)) return null;
    throw err;
  }
}

/** The Camera plugin's cancel codes (the legacy flow rejects with a message instead). */
const CAMERA_CANCEL_CODES = ["OS-PLUG-CAMR-0006", "OS-PLUG-CAMR-0020"];

/**
 * Take a picture or pick one from the photo library.
 *
 * - Inside the native shell with `@capacitor/camera` installed (`denext mobile add camera`,
 *   which also writes the camera and photo-library usage strings), the system camera or photo
 *   picker (`Camera.getPhoto`).
 * - Otherwise a file chooser for images; `source: "camera"` asks mobile browsers to open the
 *   rear camera (`capture`).
 *
 * A dismissed camera or picker resolves `null` rather than rejecting.
 *
 * @param options `source` (`"camera"`, `"photos"` or `"prompt"`, the default), `quality`
 * (0–100, native) and `as` (`"webPath"`, the default, or `"dataUrl"`).
 * @returns The picture, or `null` when the user cancelled. It rejects when permission is
 * denied, or during SSR.
 * @example
 * ```tsx
 * "use client";
 * import { useState } from "denext";
 * import { pickImage } from "denext/mobile";
 *
 * export function AvatarPicker() {
 *   const [src, setSrc] = useState<string>();
 *   return (
 *     <button type="button" onClick={async () => {
 *       const photo = await pickImage({ source: "photos" });
 *       if (photo) setSrc(photo.webPath);
 *     }}>{src ? <img src={src} alt="" /> : "Choose a photo"}</button>
 *   );
 * }
 * ```
 */
export async function pickImage(options: PickImageOptions = {}): Promise<PickedImage | null> {
  const source = options.source ?? "prompt";
  if (!Object.hasOwn(CAMERA_SOURCE, source)) {
    throw new TypeError(`pickImage: unknown source "${source}" (camera, photos or prompt)`);
  }
  const as = options.as === "dataUrl" ? "dataUrl" : "webPath";
  const plugin = nativePlugin<CameraPlugin>("Camera", ["getPhoto"]);
  if (plugin) {
    const photo = await unlessDismissed(
      () =>
        plugin.getPhoto({
          resultType: as === "dataUrl" ? "dataUrl" : "uri",
          source: CAMERA_SOURCE[source],
          allowEditing: false,
          ...(options.quality === undefined ? {} : { quality: options.quality }),
        }),
      CAMERA_CANCEL_CODES,
    );
    if (!photo) return null;
    const format = String(photo.format ?? "jpeg").toLowerCase();
    return as === "dataUrl"
      ? { dataUrl: photo.dataUrl, format }
      : { webPath: photo.webPath, format };
  }
  const file = await chooseFile("pickImage", "image/*", source === "camera");
  if (!file) return null;
  const format = imageFormat(file);
  if (as === "webPath") return { webPath: URL.createObjectURL(file), format };
  const type = file.type || `image/${format}`;
  return { dataUrl: `data:${type};base64,${await blobToBase64(file)}`, format };
}

/**
 * Pick a document (any file, or the `types` given) with the system document picker.
 *
 * - Inside the native shell with `@capawesome/capacitor-file-picker` installed (`denext
 *   mobile add document-picker`), the iOS document picker / Android's system file picker; the
 *   result carries the picked copy's `path`, and `data` with `readData: true`.
 * - Otherwise a file chooser, and the file's bytes as base64 `data`.
 *
 * A dismissed picker resolves `null` rather than rejecting.
 *
 * @param options `types` (accepted MIME types; default any file) and `readData` (native: also
 * read the contents).
 * @returns The picked file, or `null` when the user cancelled. It rejects during SSR.
 * @example
 * ```ts
 * import { pickDocument } from "denext/mobile";
 *
 * const pdf = await pickDocument({ types: ["application/pdf"], readData: true });
 * if (pdf) await upload(pdf.name, pdf.data!);
 * ```
 */
export async function pickDocument(
  options: PickDocumentOptions = {},
): Promise<PickedDocument | null> {
  const types = options.types ? [...options.types] : undefined;
  const plugin = nativePlugin<FilePickerPlugin>("FilePicker", ["pickFiles"]);
  if (plugin) {
    const result = await unlessDismissed(
      () =>
        plugin.pickFiles({
          limit: 1,
          readData: options.readData === true,
          ...(types && types.length > 0 ? { types } : {}),
        }),
      [],
    );
    const file = result?.files?.[0];
    if (!file) return null;
    const picked: PickedDocument = {
      name: String(file.name ?? ""),
      mimeType: file.mimeType || "application/octet-stream",
      size: typeof file.size === "number" ? file.size : 0,
      ...(typeof file.path === "string" ? { path: file.path } : {}),
    };
    return typeof file.data === "string" ? { ...picked, data: file.data } : picked;
  }
  const file = await chooseFile("pickDocument", (types ?? []).join(","), false);
  if (!file) return null;
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    data: await blobToBase64(file),
  };
}
