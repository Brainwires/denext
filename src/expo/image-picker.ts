/**
 * `expo-image-picker` for denext: photos and videos from the library or the camera over
 * `denext/mobile`'s {@linkcode pickImage} / {@linkcode pickMedia} (`@capacitor/camera` in the
 * Capacitor shell, a file input on the web).
 *
 * `mediaTypes` (images, videos or both), `allowsMultipleSelection` with `selectionLimit`, and
 * `orderedSelection` (iOS 15+, with `@capawesome/capacitor-file-picker` installed) are honoured;
 * a video asset carries its `duration` in milliseconds. There is no crop editor. `width` /
 * `height` come from the picker, else are measured by loading the picture (or the video's
 * metadata). Permissions are asked by the picker itself, so the permission calls report
 * `granted`.
 *
 * @example
 * ```ts
 * import * as ImagePicker from "denext/expo/image-picker";
 *
 * const result = await ImagePicker.launchImageLibraryAsync({ base64: true });
 * if (!result.canceled) upload(result.assets[0]);
 * ```
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";
import {
  type PickedImage,
  type PickedMedia,
  pickImage,
  pickMedia,
  type PickMediaTypes,
} from "../mobile/pickers.ts";
import {
  createPermissionHook,
  measureImage,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

/** Media kinds (legacy enum). */
export enum MediaTypeOptions {
  /** Images and videos. */
  All = "All",
  /** Videos. */
  Videos = "Videos",
  /** Images. */
  Images = "Images",
}

/** Which camera to open. */
export enum CameraType {
  /** The back camera. */
  back = "back",
  /** The front camera. */
  front = "front",
}

/** A media kind. */
export type MediaType = "images" | "videos" | "livePhotos";

/** A camera permission answer. */
export type CameraPermissionResponse = PermissionResponse;

/** A photo-library permission answer. */
export type MediaLibraryPermissionResponse = PermissionResponse & {
  /** How much of the library is accessible. */
  accessPrivileges?: "all" | "limited" | "none";
};

/** Options for the launch calls. */
export interface ImagePickerOptions {
  /** Show a crop editor (not provided). */
  allowsEditing?: boolean;
  /** The crop aspect (not provided). */
  aspect?: [number, number];
  /** JPEG quality, 0–1 (native only). */
  quality?: number;
  /** The media kinds: images (the default), videos, or both. */
  mediaTypes?: MediaType | MediaType[] | MediaTypeOptions;
  /** Include EXIF (not provided). */
  exif?: boolean;
  /** Include the image as base64 in `asset.base64`. */
  base64?: boolean;
  /** Allow picking several from the library. */
  allowsMultipleSelection?: boolean;
  /** With `allowsMultipleSelection`, the most that can be picked (`0`: the system's maximum). */
  selectionLimit?: number;
  /** Number the picks and return them in selection order (iOS 15+). */
  orderedSelection?: boolean;
  /** The camera to open (ignored). */
  cameraType?: CameraType;
}

/** A picked asset. */
export interface ImagePickerAsset {
  /** A URL an image can show (`blob:` on the web, a `capacitor:` file URL natively). */
  uri: string;
  /** The library asset id (not known here). */
  assetId?: string | null;
  /** Width in pixels (0 when it could not be measured). */
  width: number;
  /** Height in pixels (0 when it could not be measured). */
  height: number;
  /** `"image"` or `"video"`. */
  type?: "image" | "video" | "livePhoto" | "pairedVideo" | null;
  /** A file name. */
  fileName?: string | null;
  /** The size in bytes, when known. */
  fileSize?: number;
  /** EXIF (not provided). */
  exif?: Record<string, unknown> | null;
  /** The image as base64 (with `base64: true`). */
  base64?: string | null;
  /** A video's length in milliseconds (null for an image). */
  duration?: number | null;
  /** The MIME type. */
  mimeType?: string;
  /** The picked `File` (web only), for `FormData` uploads. */
  file?: File;
}

/** What a launch call resolves with. */
export type ImagePickerResult =
  | { canceled: false; assets: ImagePickerAsset[] }
  | { canceled: true; assets: null };

/** A pending-result error (never produced here). */
export interface ImagePickerErrorResult {
  /** The code. */
  code: string;
  /** The message. */
  message: string;
  /** The native exception. */
  exception?: string;
}

/** A `denext/mobile` picture as an Expo asset. */
async function toAsset(picked: PickedImage, base64: boolean): Promise<ImagePickerAsset> {
  const uri = picked.webPath ?? picked.dataUrl ?? "";
  const mimeType = `image/${picked.format === "jpg" ? "jpeg" : picked.format}`;
  const asset: ImagePickerAsset = {
    uri,
    ...(await measureImage(uri)),
    type: "image",
    fileName: `image.${picked.format}`,
    mimeType,
    assetId: null,
    exif: null,
  };
  if (base64) {
    const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
    asset.base64 = bytesToBase64(bytes);
    asset.fileSize = bytes.byteLength;
  }
  return asset;
}

/** Expo's `mediaTypes` (new or legacy form) as `denext/mobile`'s media types. */
function mediaKinds(mediaTypes: ImagePickerOptions["mediaTypes"]): PickMediaTypes {
  if (mediaTypes === undefined) return "images";
  if (mediaTypes === MediaTypeOptions.All) return "all";
  if (mediaTypes === MediaTypeOptions.Videos) return "videos";
  if (mediaTypes === MediaTypeOptions.Images) return "images";
  const kinds: readonly string[] = Array.isArray(mediaTypes) ? mediaTypes : [mediaTypes];
  const images = kinds.includes("images") || kinds.includes("livePhotos");
  const videos = kinds.includes("videos");
  return images && videos ? "all" : videos ? "videos" : "images";
}

/** A video's pixel size and length in seconds (zeros when it cannot be loaded here). */
function measureVideo(url: string): Promise<{ width: number; height: number; duration: number }> {
  const zero = { width: 0, height: 0, duration: 0 };
  const doc = (globalThis as { document?: Document }).document;
  if (typeof doc?.createElement !== "function") return Promise.resolve(zero);
  const video = doc.createElement("video");
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(zero), 5000);
    const done = (size: typeof zero) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      resolve(size);
    };
    video.onloadedmetadata = () =>
      done({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
    video.onerror = () => done(zero);
    video.preload = "metadata";
    video.src = url;
  });
}

/** A `denext/mobile` photo or video as an Expo asset. */
async function mediaToAsset(item: PickedMedia, base64: boolean): Promise<ImagePickerAsset> {
  const uri = item.webPath;
  let { width, height, duration: seconds } = item;
  if (width === undefined || height === undefined || (item.type === "video" && !seconds)) {
    const measured = item.type === "video"
      ? await measureVideo(uri)
      : { ...(await measureImage(uri)), duration: 0 };
    width ??= measured.width;
    height ??= measured.height;
    seconds ||= measured.duration;
  }
  const asset: ImagePickerAsset = {
    uri,
    width,
    height,
    type: item.type,
    fileName: item.name ?? `${item.type}.${item.format}`,
    mimeType: item.mimeType,
    assetId: null,
    exif: null,
    duration: item.type === "video" ? Math.round((seconds ?? 0) * 1000) : null,
    ...(item.size === undefined ? {} : { fileSize: item.size }),
    ...(item.file ? { file: item.file } : {}),
  };
  if (base64 && item.type === "image") {
    const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
    asset.base64 = bytesToBase64(bytes);
    asset.fileSize = bytes.byteLength;
  }
  return asset;
}

/** Pick from `source` and shape the result. */
async function launch(
  source: "camera" | "photos",
  options: ImagePickerOptions,
): Promise<ImagePickerResult> {
  const quality = options.quality === undefined
    ? {}
    : { quality: Math.round(options.quality * 100) };
  const kinds = mediaKinds(options.mediaTypes);
  const multiple = source === "photos" && options.allowsMultipleSelection === true;
  if (kinds === "images" && !multiple) {
    // One picture: the picker `pickImage` opens (with the camera / photos prompt natively).
    const picked = await pickImage({ source, ...quality });
    if (!picked) return { canceled: true, assets: null };
    return { canceled: false, assets: [await toAsset(picked, options.base64 === true)] };
  }
  const picked = await pickMedia({
    source: source === "camera" ? "camera" : "library",
    mediaTypes: kinds,
    multiple,
    ...(options.selectionLimit === undefined ? {} : { selectionLimit: options.selectionLimit }),
    ...(options.orderedSelection === true ? { ordered: true } : {}),
    ...quality,
  });
  if (!picked) return { canceled: true, assets: null };
  const assets = await Promise.all(
    picked.map((item) => mediaToAsset(item, options.base64 === true)),
  );
  return { canceled: false, assets };
}

/**
 * Pick photos or videos from the library: one, or several with `allowsMultipleSelection`.
 *
 * @param options `mediaTypes`, `allowsMultipleSelection`, `selectionLimit`, `orderedSelection`,
 * `quality` and `base64`.
 * @returns The assets, or `canceled: true`.
 */
export function launchImageLibraryAsync(
  options: ImagePickerOptions = {},
): Promise<ImagePickerResult> {
  return launch("photos", options);
}

/**
 * Take a picture with the camera, or record a video with `mediaTypes: "videos"`.
 *
 * @param options `mediaTypes`, `quality` and `base64`.
 * @returns The asset, or `canceled: true`.
 */
export function launchCameraAsync(options: ImagePickerOptions = {}): Promise<ImagePickerResult> {
  return launch("camera", options);
}

/**
 * A result lost when Android killed the app mid-pick: never, here.
 *
 * @returns null.
 */
export function getPendingResultAsync(): Promise<
  ImagePickerResult | ImagePickerErrorResult | null
> {
  return Promise.resolve(null);
}

/** The picker asks for access itself, so every permission call reports `granted`. */
function granted(): Promise<PermissionResponse> {
  return Promise.resolve(permissionResponse(PermissionStatus.GRANTED));
}

/**
 * The camera permission (the picker asks when it opens): `granted`.
 *
 * @returns The permission.
 */
export function getCameraPermissionsAsync(): Promise<CameraPermissionResponse> {
  return granted();
}

/**
 * Request the camera permission (the picker asks when it opens): `granted`.
 *
 * @returns The permission.
 */
export function requestCameraPermissionsAsync(): Promise<CameraPermissionResponse> {
  return granted();
}

/**
 * The photo-library permission (the picker asks when it opens): `granted`.
 *
 * @param _writeOnly Ignored.
 * @returns The permission.
 */
export async function getMediaLibraryPermissionsAsync(
  _writeOnly?: boolean,
): Promise<MediaLibraryPermissionResponse> {
  return { ...(await granted()), accessPrivileges: "all" };
}

/**
 * Request the photo-library permission (the picker asks when it opens): `granted`.
 *
 * @param writeOnly Ignored.
 * @returns The permission.
 */
export function requestMediaLibraryPermissionsAsync(
  writeOnly?: boolean,
): Promise<MediaLibraryPermissionResponse> {
  return getMediaLibraryPermissionsAsync(writeOnly);
}

/** Hook form of the camera permission: `[response, request, get]`. */
export const useCameraPermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: getCameraPermissionsAsync,
  requestMethod: requestCameraPermissionsAsync,
});

/** Hook form of the photo-library permission: `[response, request, get]`. */
export const useMediaLibraryPermissions: (
  options?: PermissionHookOptions<{ writeOnly?: boolean }>,
) => [
  MediaLibraryPermissionResponse | null,
  () => Promise<MediaLibraryPermissionResponse>,
  () => Promise<MediaLibraryPermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: (o?: { writeOnly?: boolean }) => getMediaLibraryPermissionsAsync(o?.writeOnly),
  requestMethod: (o?: { writeOnly?: boolean }) => requestMediaLibraryPermissionsAsync(o?.writeOnly),
});
