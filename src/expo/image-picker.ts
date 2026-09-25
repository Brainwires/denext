/**
 * `expo-image-picker` for denext: one picture from the camera or the photo library over
 * `denext/mobile`'s {@linkcode pickImage} (`@capacitor/camera` in the Capacitor shell, a
 * file input on the web).
 *
 * One asset per pick (`allowsMultipleSelection` picks one), images only, no crop editor.
 * `width` / `height` are measured by loading the picture. Permissions are asked by the
 * picker itself, so the permission calls report `granted`.
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
import { type PickedImage, pickImage } from "../mobile/pickers.ts";
import {
  createPermissionHook,
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
  /** The media kinds (images only here). */
  mediaTypes?: MediaType | MediaType[] | MediaTypeOptions;
  /** Include EXIF (not provided). */
  exif?: boolean;
  /** Include the image as base64 in `asset.base64`. */
  base64?: boolean;
  /** Allow several (one is picked here). */
  allowsMultipleSelection?: boolean;
  /** The selection limit (one here). */
  selectionLimit?: number;
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
  /** `"image"`. */
  type?: "image" | "video" | "livePhoto" | "pairedVideo" | null;
  /** A file name. */
  fileName?: string | null;
  /** The size in bytes, when known. */
  fileSize?: number;
  /** EXIF (not provided). */
  exif?: Record<string, unknown> | null;
  /** The image as base64 (with `base64: true`). */
  base64?: string | null;
  /** The duration (videos only). */
  duration?: number | null;
  /** The MIME type. */
  mimeType?: string;
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

/** The pixel size of the image at `url`, or zeros when it cannot be loaded here. */
function measure(url: string): Promise<{ width: number; height: number }> {
  const ImageCtor = (globalThis as { Image?: new () => HTMLImageElement }).Image;
  if (!ImageCtor) return Promise.resolve({ width: 0, height: 0 });
  return new Promise((resolve) => {
    const img = new ImageCtor();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

/** A `denext/mobile` picture as an Expo asset. */
async function toAsset(picked: PickedImage, base64: boolean): Promise<ImagePickerAsset> {
  const uri = picked.webPath ?? picked.dataUrl ?? "";
  const mimeType = `image/${picked.format === "jpg" ? "jpeg" : picked.format}`;
  const asset: ImagePickerAsset = {
    uri,
    ...(await measure(uri)),
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

/** Pick from `source` and shape the result. */
async function launch(
  source: "camera" | "photos",
  options: ImagePickerOptions,
): Promise<ImagePickerResult> {
  const picked = await pickImage({
    source,
    ...(options.quality === undefined ? {} : { quality: Math.round(options.quality * 100) }),
  });
  if (!picked) return { canceled: true, assets: null };
  return { canceled: false, assets: [await toAsset(picked, options.base64 === true)] };
}

/**
 * Pick a picture from the photo library.
 *
 * @param options The quality and `base64` options.
 * @returns The asset, or `canceled: true`.
 */
export function launchImageLibraryAsync(
  options: ImagePickerOptions = {},
): Promise<ImagePickerResult> {
  return launch("photos", options);
}

/**
 * Take a picture with the camera.
 *
 * @param options The quality and `base64` options.
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
