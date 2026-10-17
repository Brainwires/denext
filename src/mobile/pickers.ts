/**
 * Image, media and document pickers for `denext/mobile`: the native `Camera` and `FilePicker`
 * plugins in the shell, else a hidden `<input type="file">` created for the call.
 *
 * @module
 */

import { blobToBase64, isDismissal } from "./base64.ts";
import { isNativeShell } from "./bridge.ts";
import type { PickedHandle } from "./filesystem.ts";
import { nativePlugin } from "./plugin.ts";
import { onDesktop, viaDesktop } from "./desktop-branch.ts";
import {
  type FilePickerAcceptType,
  isAbortError,
  pickerTypes,
  registerWebHandle,
} from "./picked-web.ts";

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
  /**
   * The file's path, for display only: the picked copy natively, the file itself on desktop
   * (a browser hides it).
   */
  readonly path?: string;
  /**
   * The file's read-only handle: `{ picked: handle }` with the path `""` reaches it through
   * `readFile`, and it can be passed to `openPath` / `revealInFileManager`. On desktop, and in
   * browsers with `showOpenFilePicker`; the iOS/Android pickers and `<input type="file">` have
   * none.
   */
  readonly handle?: PickedHandle;
}

/** What {@linkcode pickMedia} offers: photos, videos, or both. */
export type PickMediaTypes = "images" | "videos" | "all";

/** Options for {@linkcode pickMedia}. */
export interface PickMediaOptions {
  /** What can be picked: `"images"` (the default), `"videos"` or `"all"`. */
  readonly mediaTypes?: PickMediaTypes;
  /** Let the user pick several (default `false`: one). The library only. */
  readonly multiple?: boolean;
  /**
   * With `multiple`, the most the user may pick; `0` or absent is the system's maximum. The
   * native pickers enforce it (Android 13+ and iOS); elsewhere the result is cut to it.
   */
  readonly selectionLimit?: number;
  /**
   * Number the picks in the order chosen and return them in that order (iOS 15+, through
   * `@capawesome/capacitor-file-picker` when installed). Picks come in selection order anyway
   * wherever the platform keeps it.
   */
  readonly ordered?: boolean;
  /** JPEG quality of picked photos, 0–100 (native only). */
  readonly quality?: number;
  /**
   * `"library"` (the default) or `"camera"`: take one photo, or record one video with
   * `mediaTypes: "videos"`.
   */
  readonly source?: "library" | "camera";
}

/** A photo or video from {@linkcode pickMedia}. */
export interface PickedMedia {
  /** `"image"` or `"video"`. */
  readonly type: "image" | "video";
  /** A URL for `<img src>` / `<video src>` (a `capacitor://` file URL natively, `blob:` on the web). */
  readonly webPath: string;
  /** The MIME type (`image/jpeg`, `video/mp4`, …). */
  readonly mimeType: string;
  /** The format, lower case (`"jpeg"`, `"heic"`, `"mp4"`, `"quicktime"`, …). */
  readonly format: string;
  /** The file name, when known. */
  readonly name?: string;
  /** The size in bytes, when known. */
  readonly size?: number;
  /** The width in pixels, when the picker reports it. */
  readonly width?: number;
  /** The height in pixels, when the picker reports it. */
  readonly height?: number;
  /** A video's length in seconds, when the picker reports it. */
  readonly duration?: number;
  /** The picked copy's native path (the shell only). */
  readonly path?: string;
  /** The picked `File` (the web only), for `FormData` uploads. */
  readonly file?: File;
}

/** A `Camera.chooseFromGallery` / `recordVideo` result item. */
interface CameraMediaResult {
  type?: number;
  uri?: string;
  webPath?: string;
  metadata?: {
    size?: number;
    duration?: number;
    format?: string;
    resolution?: string;
  };
}

/** The JS side of `@capacitor/camera` (the calls {@linkcode pickImage} and {@linkcode pickMedia} make). */
interface CameraPlugin {
  getPhoto(options: {
    resultType: "uri" | "dataUrl";
    source: string;
    quality?: number;
    allowEditing: boolean;
  }): Promise<{ webPath?: string; dataUrl?: string; format?: string }>;
  chooseFromGallery(options: {
    mediaType: number;
    allowMultipleSelection: boolean;
    limit?: number;
    includeMetadata: boolean;
    quality?: number;
  }): Promise<{ results?: CameraMediaResult[] }>;
  recordVideo(options: { includeMetadata: boolean }): Promise<CameraMediaResult>;
  pickImages(options: { quality?: number; limit?: number }): Promise<{
    photos?: Array<{ webPath?: string; path?: string; format?: string }>;
  }>;
}

/** One `@capawesome/capacitor-file-picker` result file. */
interface FilePickerFile {
  name?: string;
  mimeType?: string;
  size?: number;
  data?: string;
  path?: string;
  webPath?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** The JS side of `@capawesome/capacitor-file-picker` (the calls {@linkcode pickDocument} and {@linkcode pickMedia} make). */
interface FilePickerPlugin {
  pickFiles(options: { types?: string[]; limit: number; readData: boolean }): Promise<{
    files?: FilePickerFile[];
  }>;
  pickMedia(options: MediaPickOptions): Promise<{ files?: FilePickerFile[] }>;
  pickImages(options: MediaPickOptions): Promise<{ files?: FilePickerFile[] }>;
  pickVideos(options: MediaPickOptions): Promise<{ files?: FilePickerFile[] }>;
}

/** `FilePicker.pickMedia` / `pickImages` / `pickVideos` options. */
interface MediaPickOptions {
  readData: boolean;
  limit: number;
  ordered?: boolean;
}

/** A `Camera.getPhoto` result as a {@linkcode PickedImage}: `as` picks the field (else whichever is set). */
export function pickedImageFrom(
  photo: { webPath?: string; dataUrl?: string; format?: string },
  as?: "webPath" | "dataUrl",
): PickedImage {
  const format = String(photo.format ?? "jpeg").toLowerCase();
  const inline = as === "dataUrl" || (as === undefined && typeof photo.webPath !== "string");
  return inline ? { dataUrl: photo.dataUrl, format } : { webPath: photo.webPath, format };
}

/** One file of a `FilePicker.pickFiles` result as a {@linkcode PickedDocument}. */
export function pickedDocumentFrom(
  file: { name?: string; mimeType?: string; size?: number; data?: string; path?: string },
): PickedDocument {
  const picked: PickedDocument = {
    name: String(file.name ?? ""),
    mimeType: file.mimeType || "application/octet-stream",
    size: typeof file.size === "number" ? file.size : 0,
    ...(typeof file.path === "string" ? { path: file.path } : {}),
  };
  return typeof file.data === "string" ? { ...picked, data: file.data } : picked;
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
 * and removed after it (`multiple` lets the user choose several). Resolves the chosen files, or
 * null when the chooser is dismissed or nothing was chosen.
 */
function chooseFiles(
  fn: string,
  accept: string,
  capture: boolean,
  multiple = false,
): Promise<File[] | null> {
  const doc = (globalThis as { document?: PickerDocument }).document;
  if (typeof doc?.createElement !== "function" || !doc.body) {
    return Promise.reject(new Error(`${fn}: no document to open a file chooser in (SSR)`));
  }
  const input = doc.createElement("input");
  input.type = "file";
  if (accept) input.accept = accept;
  if (capture) input.setAttribute("capture", "environment");
  if (multiple) input.multiple = true;
  input.style.display = "none";
  return new Promise((resolve) => {
    const done = (files: File[] | null) => {
      input.remove();
      resolve(files && files.length > 0 ? files : null);
    };
    input.addEventListener("change", () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    doc.body!.appendChild(input);
    input.click();
  });
}

/** {@linkcode chooseFiles} for one file. */
async function chooseFile(fn: string, accept: string, capture: boolean): Promise<File | null> {
  return (await chooseFiles(fn, accept, capture))?.[0] ?? null;
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

/**
 * The Camera plugin's cancel codes (take photo, choose from the gallery, record video; the legacy
 * flow rejects with a message instead).
 */
const CAMERA_CANCEL_CODES = ["OS-PLUG-CAMR-0006", "OS-PLUG-CAMR-0020", "OS-PLUG-CAMR-0017"];

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
    return photo ? pickedImageFrom(photo, as) : null;
  }
  const file = await chooseFile("pickImage", "image/*", source === "camera");
  if (!file) return null;
  const format = imageFormat(file);
  if (as === "webPath") return { webPath: URL.createObjectURL(file), format };
  const type = file.type || `image/${format}`;
  return { dataUrl: `data:${type};base64,${await blobToBase64(file)}`, format };
}

// ---- pickMedia --------------------------------------------------------------------------------

/** {@linkcode PickMediaTypes} → the Camera plugin's `MediaTypeSelection`. */
const CAMERA_MEDIA_TYPE: Record<PickMediaTypes, number> = { images: 0, videos: 1, all: 2 };

/** {@linkcode PickMediaTypes} → a file input's `accept`. */
const MEDIA_ACCEPT: Record<PickMediaTypes, string> = {
  images: "image/*",
  videos: "video/*",
  all: "image/*,video/*",
};

/** File formats whose MIME subtype differs from the format name. */
const MIME_SUBTYPES: Readonly<Record<string, string>> = {
  jpg: "jpeg",
  mov: "quicktime",
  m4v: "x-m4v",
  "3gp": "3gpp",
};

/** The MIME type of a picked `format` of `type`. */
function mediaMime(type: "image" | "video", format: string): string {
  return `${type}/${MIME_SUBTYPES[format] ?? format}`;
}

/** A format from a MIME type's subtype, else a file name's extension, else `"unknown"`. */
function formatOf(mimeType: string | undefined, name: string | undefined): string {
  const sub = /^(?:image|video)\/([\w.+-]+)/.exec(mimeType ?? "")?.[1];
  const ext = /\.(\w+)$/.exec(name ?? "")?.[1];
  return (sub ?? ext ?? "unknown").toLowerCase();
}

/** A URL the WebView can load for a native file path (Capacitor's `convertFileSrc`). */
function webPathFor(path: string | undefined): string {
  if (!path) return "";
  const convert = (globalThis as { Capacitor?: { convertFileSrc?: (p: string) => string } })
    .Capacitor?.convertFileSrc;
  return typeof convert === "function" ? convert(path) : path;
}

/** The last path segment of a URI, when it has one. */
function baseName(uri: string | undefined): string | undefined {
  const name = uri?.split(/[?#]/)[0].split("/").pop();
  return name ? decodeURIComponent(name) : undefined;
}

/** One Camera `MediaResult` as {@linkcode PickedMedia}. */
function pickedMediaFromCamera(result: CameraMediaResult): PickedMedia {
  const type = result.type === 1 ? "video" : "image";
  const meta = result.metadata ?? {};
  const name = baseName(result.uri ?? result.webPath);
  const format = String(meta.format ?? formatOf(undefined, name)).toLowerCase();
  const resolution = /^(\d+)x(\d+)$/.exec(meta.resolution ?? "");
  return {
    type,
    webPath: result.webPath ?? webPathFor(result.uri),
    mimeType: mediaMime(type, format === "unknown" ? (type === "video" ? "mp4" : "jpeg") : format),
    format,
    ...(name ? { name } : {}),
    ...(typeof meta.size === "number" ? { size: meta.size } : {}),
    ...(resolution ? { width: Number(resolution[1]), height: Number(resolution[2]) } : {}),
    ...(type === "video" && typeof meta.duration === "number" ? { duration: meta.duration } : {}),
    ...(result.uri ? { path: result.uri } : {}),
  };
}

/** One FilePicker file as {@linkcode PickedMedia}. */
function pickedMediaFromFilePicker(file: FilePickerFile): PickedMedia {
  const mimeType = file.mimeType || "application/octet-stream";
  const type = mimeType.startsWith("video/") ? "video" : "image";
  return {
    type,
    webPath: file.webPath ?? webPathFor(file.path),
    mimeType,
    format: formatOf(mimeType, file.name),
    ...(file.name ? { name: file.name } : {}),
    ...(typeof file.size === "number" ? { size: file.size } : {}),
    ...(typeof file.width === "number" ? { width: file.width } : {}),
    ...(typeof file.height === "number" ? { height: file.height } : {}),
    ...(type === "video" && typeof file.duration === "number" ? { duration: file.duration } : {}),
    ...(file.path ? { path: file.path } : {}),
  };
}

/** A browser `File` as {@linkcode PickedMedia}. */
function pickedMediaFromFile(file: File): PickedMedia {
  const type = file.type.startsWith("video/") ? "video" : "image";
  const format = formatOf(file.type, file.name);
  return {
    type,
    webPath: URL.createObjectURL(file),
    mimeType: file.type || mediaMime(type, format),
    format,
    name: file.name,
    size: file.size,
    file,
  };
}

/** `items` cut to `limit` (0 or absent: all), or null when empty. */
function upTo<T>(items: readonly T[] | undefined, limit: number): T[] | null {
  const kept = (items ?? []).slice(0, limit > 0 ? limit : undefined);
  return kept.length > 0 ? kept : null;
}

/** The checked options of a {@linkcode pickMedia} call. */
interface MediaRequest {
  readonly kinds: PickMediaTypes;
  readonly multiple: boolean;
  readonly limit: number;
  readonly ordered: boolean;
  readonly quality?: number;
}

/** {@linkcode pickMedia}'s options, checked. */
function mediaRequest(options: PickMediaOptions): MediaRequest {
  const kinds = options.mediaTypes ?? "images";
  if (!Object.hasOwn(CAMERA_MEDIA_TYPE, kinds)) {
    throw new TypeError(`pickMedia: unknown mediaTypes "${kinds}" (images, videos or all)`);
  }
  const source = options.source ?? "library";
  if (source !== "library" && source !== "camera") {
    throw new TypeError(`pickMedia: unknown source "${source}" (library or camera)`);
  }
  const multiple = options.multiple === true && source === "library";
  const limit = !multiple ? 1 : Math.max(0, Math.floor(options.selectionLimit ?? 0));
  return {
    kinds,
    multiple,
    limit,
    ordered: options.ordered === true,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  };
}

/** Record a video with the camera: the Camera plugin's `recordVideo`, else a capture input. */
async function recordMedia(): Promise<PickedMedia[] | null> {
  const plugin = nativePlugin<CameraPlugin>("Camera", ["recordVideo"]);
  if (plugin) {
    const video = await unlessDismissed(
      () => plugin.recordVideo({ includeMetadata: true }),
      CAMERA_CANCEL_CODES,
    );
    return video ? [pickedMediaFromCamera({ ...video, type: 1 })] : null;
  }
  const files = await chooseFiles("pickMedia", "video/*", true);
  return files ? [pickedMediaFromFile(files[0])] : null;
}

/** Take a photo with the camera, through {@linkcode pickImage}. */
async function takeMedia(quality: number | undefined): Promise<PickedMedia[] | null> {
  return asMedia(
    await pickImage({ source: "camera", ...(quality === undefined ? {} : { quality }) }),
  );
}

/** A {@linkcode pickImage} result as a one-item {@linkcode pickMedia} result. */
function asMedia(photo: PickedImage | null): PickedMedia[] | null {
  if (!photo?.webPath) return null;
  const { webPath, format } = photo;
  return [{ type: "image", webPath, mimeType: mediaMime("image", format), format }];
}

/** The FilePicker plugin call for `kinds`, when the plugin has it. */
function filePickerMedia(
  kinds: PickMediaTypes,
):
  | ((plugin: FilePickerPlugin, options: MediaPickOptions) => Promise<{ files?: FilePickerFile[] }>)
  | undefined {
  const method = kinds === "images"
    ? "pickImages"
    : kinds === "videos"
    ? "pickVideos"
    : "pickMedia";
  const plugin = nativePlugin<FilePickerPlugin>("FilePicker", [method]);
  return plugin ? (p, o) => p[method](o) : undefined;
}

/** Pick from the library through `@capawesome/capacitor-file-picker`, or undefined without it. */
async function pickWithFilePicker(
  request: MediaRequest,
): Promise<PickedMedia[] | null | undefined> {
  const call = filePickerMedia(request.kinds);
  const plugin = call && nativePlugin<FilePickerPlugin>("FilePicker", []);
  if (!call || !plugin) return undefined;
  const result = await unlessDismissed(
    () =>
      call(plugin, {
        readData: false,
        limit: request.limit,
        ...(request.ordered ? { ordered: true } : {}),
      }),
    [],
  );
  return upTo(result?.files, request.limit)?.map(pickedMediaFromFilePicker) ?? null;
}

/** Pick from the library through the Camera plugin, or undefined when it cannot. */
async function pickWithCamera(request: MediaRequest): Promise<PickedMedia[] | null | undefined> {
  const quality = request.quality === undefined ? {} : { quality: request.quality };
  const gallery = nativePlugin<CameraPlugin>("Camera", ["chooseFromGallery"]);
  if (gallery) {
    const result = await unlessDismissed(
      () =>
        gallery.chooseFromGallery({
          mediaType: CAMERA_MEDIA_TYPE[request.kinds],
          allowMultipleSelection: request.multiple,
          ...(request.multiple && request.limit > 0 ? { limit: request.limit } : {}),
          includeMetadata: true,
          ...quality,
        }),
      CAMERA_CANCEL_CODES,
    );
    return upTo(result?.results, request.limit)?.map(pickedMediaFromCamera) ?? null;
  }
  if (request.kinds !== "images") return undefined;
  const legacy = nativePlugin<CameraPlugin>("Camera", ["pickImages"]);
  if (legacy && request.multiple) {
    const result = await unlessDismissed(
      () =>
        legacy.pickImages({ ...quality, ...(request.limit > 0 ? { limit: request.limit } : {}) }),
      CAMERA_CANCEL_CODES,
    );
    return upTo(result?.photos, request.limit)?.map((photo) => {
      const format = String(photo.format ?? "jpeg").toLowerCase();
      return {
        type: "image" as const,
        webPath: photo.webPath ?? webPathFor(photo.path),
        mimeType: mediaMime("image", format),
        format,
        ...(photo.path ? { path: photo.path } : {}),
      };
    }) ?? null;
  }
  if (!nativePlugin<CameraPlugin>("Camera", ["getPhoto"])) return undefined;
  return asMedia(await pickImage({ source: "photos", ...quality }));
}

/**
 * Pick photos and videos: several at once from the library, or one taken / recorded with the
 * camera.
 *
 * - Inside the native shell, `@capacitor/camera`'s gallery picker (`denext mobile add camera`;
 *   `chooseFromGallery`, with `selectionLimit` honoured on iOS and Android 13+) or its
 *   `recordVideo`. With `ordered: true`, or without the Camera plugin,
 *   `@capawesome/capacitor-file-picker` (`denext mobile add document-picker`) picks from the
 *   library instead.
 * - Otherwise a file chooser (`<input type="file" multiple accept="image/*,video/*">`); a
 *   `source: "camera"` one asks mobile browsers for the camera. A browser cannot cap the
 *   selection, so the result is cut to `selectionLimit`.
 *
 * Picks come in the order chosen wherever the platform keeps it. A dismissed picker resolves
 * `null` rather than rejecting.
 *
 * @param options `mediaTypes` (`"images"`, the default, `"videos"` or `"all"`), `multiple`,
 * `selectionLimit`, `ordered`, `quality` (0–100, native) and `source` (`"library"`, the default,
 * or `"camera"`).
 * @returns The picked items (at least one), or `null` when the user cancelled. It rejects when
 * permission is denied, or during SSR.
 * @example
 * ```ts
 * import { pickMedia } from "denext/mobile";
 *
 * const items = await pickMedia({ mediaTypes: "all", multiple: true, selectionLimit: 10 });
 * for (const item of items ?? []) {
 *   gallery.add(item.type === "video" ? { video: item.webPath, seconds: item.duration } : { src: item.webPath });
 * }
 * ```
 */
export async function pickMedia(options: PickMediaOptions = {}): Promise<PickedMedia[] | null> {
  const request = mediaRequest(options);
  if (options.source === "camera") {
    return request.kinds === "videos" ? await recordMedia() : await takeMedia(request.quality);
  }
  if (request.ordered) {
    const ordered = await pickWithFilePicker(request);
    if (ordered !== undefined) return ordered;
  }
  const camera = await pickWithCamera(request);
  if (camera !== undefined) return camera;
  const filePicker = await pickWithFilePicker(request);
  if (filePicker !== undefined) return filePicker;
  const files = await chooseFiles(
    "pickMedia",
    MEDIA_ACCEPT[request.kinds],
    false,
    request.multiple,
  );
  return upTo(files ?? [], request.limit)?.map(pickedMediaFromFile) ?? null;
}

/** The File System Access API's open picker, where the browser has it. */
type OpenFilePicker = (options: {
  multiple?: boolean;
  types?: FilePickerAcceptType[];
}) => Promise<FileSystemFileHandle[]>;

/** A file from `showOpenFilePicker` (registered), or `null` when cancelled. */
async function pickWithOpenPicker(
  picker: OpenFilePicker,
  types: readonly string[] | undefined,
): Promise<PickedDocument | null> {
  let handle: FileSystemFileHandle | undefined;
  try {
    const accept = pickerTypes(types);
    [handle] = await picker({ multiple: false, ...(accept ? { types: accept } : {}) });
  } catch (err) {
    if (isAbortError(err)) return null;
    throw err;
  }
  if (!handle) return null;
  const file = await handle.getFile();
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    data: await blobToBase64(file),
    handle: registerWebHandle(handle),
  };
}

/**
 * Pick a document (any file, or the `types` given) with the system document picker.
 *
 * - Inside the native shell with `@capawesome/capacitor-file-picker` installed (`denext
 *   mobile add document-picker`), the iOS document picker / Android's system file picker; the
 *   result carries the picked copy's `path`, and `data` with `readData: true`.
 * - In a Deno Desktop window (`denext desktop add dialogs`), the native open panel: the result
 *   carries a read-only `handle` for the file (for `readFile` with `{ picked: handle }`, and the
 *   shell functions), its absolute `path` for display, and `data` with `readData: true`.
 * - In a browser with the File System Access API (`showOpenFilePicker`), the browser's open
 *   dialog: the file's bytes as base64 `data` and a `handle` for this page.
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
  const readData = options.readData === true;
  const desktop = onDesktop() &&
    await viaDesktop("dialogs", (d) => d.dialogOpenFile(types, readData));
  if (desktop) return desktop.value;
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
    return file ? pickedDocumentFrom(file) : null;
  }
  const picker = (globalThis as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  if (!isNativeShell() && typeof picker === "function") {
    return await pickWithOpenPicker(picker, types);
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
