/**
 * `expo-camera` for denext: `CameraView` as a live camera preview (`getUserMedia`) whose ref
 * takes pictures (a canvas frame) and records video (`MediaRecorder`), the permission hooks,
 * and barcode scanning over `denext/mobile`'s {@linkcode scanBarcode} (the
 * `@capacitor/barcode-scanner` full-screen scanner in the Capacitor shell, `BarcodeDetector`
 * over the camera in the browser).
 *
 * - A `CameraView` with `onBarcodeScanned` opens denext's scanner when it mounts (a
 *   full-screen scanner rather than an inline preview) and reports the first code read; after
 *   a cancel it shows a "Scan" button that reopens it. `CameraView.launchScanner` opens the
 *   same scanner and reports to `CameraView.onModernBarcodeScanned`.
 * - Otherwise it previews the `facing` camera. `ref.current.takePictureAsync()` returns a
 *   `data:` URL picture (`quality`, `base64`, `scale`, `imageType`, `mirror`, `exif` as the
 *   track's settings, `pictureRef`); inside the shell without a running preview it falls back
 *   to the system camera (`@capacitor/camera`, `denext mobile add camera`).
 *   `recordAsync()` records the preview (with sound in `mode="video"` unless `mute`) until
 *   `stopRecording()`, `maxDuration` or `maxFileSize`, and resolves with a `blob:` URL.
 * - The shell's web view asks for camera / microphone access itself: the iOS app needs
 *   `NSCameraUsageDescription` (and `NSMicrophoneUsageDescription` to record sound).
 *
 * Not provided: the native preview's controls (autofocus, white balance, picture size,
 * `videoQuality`, `animateShutter`), the codec choice (the browser picks one), and EXIF
 * written into the file (`exif` reports the track's settings instead).
 *
 * @example
 * ```ts
 * import { CameraView, useCameraPermissions } from "denext/expo/camera";
 *
 * const [permission, requestPermission] = useCameraPermissions();
 * // <CameraView barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
 * ```
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useImperativeHandle, useRef, useState } from "../runtime/hooks.ts";
import { type BarcodeFormat, scanBarcode } from "../mobile/barcode.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { pickImage } from "../mobile/pickers.ts";
import {
  createEmitter,
  createPermissionHook,
  type Emitter,
  hostView,
  measureImage,
  nativeOnly,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  requestMediaPermission,
  type Subscription,
  viewStyle,
  webPermission,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse, Subscription };

/** A barcode kind, by Expo's name. */
export type BarcodeType =
  | "aztec"
  | "ean13"
  | "ean8"
  | "qr"
  | "pdf417"
  | "upc_e"
  | "datamatrix"
  | "code39"
  | "code93"
  | "itf14"
  | "codabar"
  | "code128"
  | "upc_a";

/** Which camera. */
export type CameraType = "front" | "back";

/** A point in view coordinates. */
export interface BarcodePoint {
  /** X. */
  x: number;
  /** Y. */
  y: number;
}

/** Where a code was found (not reported by denext's scanner: zeros). */
export interface BarcodeBounds {
  /** The top-left corner. */
  origin: BarcodePoint;
  /** The size. */
  size: { width: number; height: number };
}

/** A scanned code. */
export interface BarcodeScanningResult {
  /** The kind, by Expo's name. */
  type: string;
  /** The decoded text. */
  data: string;
  /** The raw value. */
  raw?: string;
  /** The corners (not reported: empty). */
  cornerPoints: BarcodePoint[];
  /** The bounds (not reported: zeros). */
  bounds: BarcodeBounds;
}

/** The kinds a scan looks for. */
export interface BarcodeSettings {
  /** The kinds. */
  barcodeTypes: BarcodeType[];
}

/** How the camera flashes (applied to the torch where the track supports it). */
export type FlashMode = "off" | "on" | "auto" | "screen";

/** What the camera is for. */
export type CameraMode = "picture" | "video";

/** A video codec, by Expo's name. */
export type VideoCodec = "avc1" | "hvc1" | "jpeg" | "apcn" | "ap4h";

/** The image format of a picture. */
export type ImageType = "png" | "jpg";

/** Options for `takePictureAsync`. */
export interface CameraPictureOptions {
  /** Compression quality 0–1 (JPEG; default 1). */
  quality?: number;
  /** Also return the image as base64. */
  base64?: boolean;
  /** Also return the camera track's settings as `exif`. */
  exif?: boolean;
  /** Extra EXIF (not written). */
  additionalExif?: Record<string, unknown>;
  /** Called with the picture instead of resolving with it. */
  onPictureSaved?: (picture: CameraCapturedPicture) => void;
  /** Skip processing (no effect). */
  skipProcessing?: boolean;
  /** Scale the picture (0–1). */
  scale?: number;
  /** `jpg` (default) or `png`. */
  imageType?: ImageType;
  /** Mirror the picture. */
  mirror?: boolean;
  /** Mirror the picture (older name). */
  isImageMirror?: boolean;
  /** Resolve with a {@linkcode PictureRef} instead of a picture. */
  pictureRef?: boolean;
  /** Other Expo options (accepted, not used). */
  [option: string]: unknown;
}

/** A picture `takePictureAsync` took. */
export interface CameraCapturedPicture {
  /** The width. */
  width: number;
  /** The height. */
  height: number;
  /** The format. */
  format: "jpg" | "png";
  /** The picture: a `data:` URL from the preview, the camera plugin's URL natively. */
  uri: string;
  /** The picture as base64 (with `base64: true`). */
  base64?: string;
  /** The camera track's settings (with `exif: true`). */
  exif?: Record<string, unknown>;
}

/** What `PictureRef.savePictureAsync` resolves with. */
export interface PhotoResult {
  /** The picture's URL. */
  uri: string;
  /** The width. */
  width: number;
  /** The height. */
  height: number;
  /** The picture as base64 (with `base64: true`). */
  base64?: string;
}

/** Options for `PictureRef.savePictureAsync`. */
export interface SavePictureOptions {
  /** Compression quality 0–1. */
  quality?: number;
  /** Also return base64. */
  base64?: boolean;
  /** Other options (accepted, not used). */
  [option: string]: unknown;
}

/** Options for `recordAsync`. */
export interface CameraRecordingOptions {
  /** Stop after this many seconds. */
  maxDuration?: number;
  /** Stop once the recording reaches this many bytes. */
  maxFileSize?: number;
  /** Mirror the video (not applied). */
  mirror?: boolean;
  /** The codec (the browser picks one MediaRecorder supports). */
  codec?: VideoCodec;
}

/** Options for {@linkcode CameraView.launchScanner}. */
export interface ScanningOptions {
  /** The kinds to look for. */
  barcodeTypes: BarcodeType[];
  /** Pinch to zoom (the scanner's own). */
  isPinchToZoomEnabled?: boolean;
  /** Guidance (the scanner's own). */
  isGuidanceEnabled?: boolean;
  /** Highlighting (the scanner's own). */
  isHighlightingEnabled?: boolean;
}

/** What {@linkcode CameraView.onModernBarcodeScanned} listeners get. */
export type ScanningResult = Omit<BarcodeScanningResult, "bounds" | "cornerPoints">;

/** `CameraView` props. */
export interface CameraViewProps {
  /** Which camera (`back` by default). */
  facing?: CameraType;
  /** `picture` (default) or `video` (asks for the microphone too, unless `mute`). */
  mode?: CameraMode;
  /** Record without sound. */
  mute?: boolean;
  /** Whether the preview runs (default `true`). */
  active?: boolean;
  /** Mirror the front camera's preview (default: mirrored). */
  mirror?: boolean;
  /** The flash (the torch, where the track supports it). */
  flash?: FlashMode;
  /** Keep the torch on. */
  enableTorch?: boolean;
  /** Zoom 0–1 (where the track supports it). */
  zoom?: number;
  /** The kinds to look for (default all). */
  barcodeScannerSettings?: BarcodeSettings;
  /**
   * Called with the first code read. When set, the view opens denext's full-screen scanner
   * instead of a preview.
   */
  onBarcodeScanned?: (result: BarcodeScanningResult) => void;
  /** Called once the preview runs. */
  onCameraReady?: () => void;
  /** Called when the camera or the scanner cannot run (no camera, permission refused). */
  onMountError?: (event: { message: string }) => void;
  /** A ref to the {@linkcode CameraViewHandle}. */
  ref?: unknown;
  /** The view's style. */
  style?: unknown;
  /** Children drawn over the view. */
  children?: unknown;
  /** Other view props. */
  [prop: string]: unknown;
}

/** Expo barcode names → `BarcodeDetector` names. */
const FORMATS: Readonly<Record<BarcodeType, BarcodeFormat>> = {
  aztec: "aztec",
  ean13: "ean_13",
  ean8: "ean_8",
  qr: "qr_code",
  pdf417: "pdf417",
  upc_e: "upc_e",
  datamatrix: "data_matrix",
  code39: "code_39",
  code93: "code_93",
  itf14: "itf",
  codabar: "codabar",
  code128: "code_128",
  upc_a: "upc_a",
};

/** A `BarcodeDetector` name as Expo's. */
function expoType(format: string): string {
  const hit = Object.entries(FORMATS).find(([, name]) => name === format);
  return hit ? hit[0] : format;
}

/** A scanned code as Expo's result. */
function toResult(value: string, format: string): BarcodeScanningResult {
  return {
    type: expoType(format),
    data: value,
    raw: value,
    cornerPoints: [],
    bounds: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
  };
}

/**
 * The camera permission: `granted` when the native scanner plugin is installed (it asks when
 * it opens), else the browser's camera permission.
 *
 * @returns The permission.
 */
async function getCameraPermissionsAsync(): Promise<PermissionResponse> {
  if (nativePlugin("CapacitorBarcodeScanner", ["scanBarcode"])) {
    return permissionResponse(PermissionStatus.GRANTED);
  }
  return permissionResponse(await webPermission("camera"));
}

/**
 * Request the camera permission (in the browser: a `getUserMedia` call, stopped at once).
 *
 * @returns The permission.
 */
async function requestCameraPermissionsAsync(): Promise<PermissionResponse> {
  if (nativePlugin("CapacitorBarcodeScanner", ["scanBarcode"])) {
    return permissionResponse(PermissionStatus.GRANTED);
  }
  return permissionResponse(await requestMediaPermission({ video: true }));
}

/**
 * The microphone permission (the browser's).
 *
 * @returns The permission.
 */
async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return permissionResponse(await webPermission("microphone"));
}

/**
 * Request the microphone permission (a `getUserMedia` call, stopped at once).
 *
 * @returns The permission.
 */
async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return permissionResponse(await requestMediaPermission({ audio: true }));
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

/** Hook form of the microphone permission: `[response, request, get]`. */
export const useMicrophonePermissions: (
  options?: PermissionHookOptions<object>,
) => [
  PermissionResponse | null,
  () => Promise<PermissionResponse>,
  () => Promise<PermissionResponse>,
] = /* @__PURE__ */ createPermissionHook({
  getMethod: getMicrophonePermissionsAsync,
  requestMethod: requestMicrophonePermissionsAsync,
});

/**
 * The permission calls and {@linkcode scanFromURLAsync}, as Expo's `Camera` object groups them
 * (expo-camera exports the permission calls only here). Camera: granted when the native
 * scanner plugin is installed (it asks when it opens), else the browser's camera permission
 * (a request is a `getUserMedia` call, stopped at once). Microphone: the browser's.
 */
export const Camera: {
  getCameraPermissionsAsync: () => Promise<PermissionResponse>;
  requestCameraPermissionsAsync: () => Promise<PermissionResponse>;
  getMicrophonePermissionsAsync: () => Promise<PermissionResponse>;
  requestMicrophonePermissionsAsync: () => Promise<PermissionResponse>;
  scanFromURLAsync: (url: string, barcodeTypes?: BarcodeType[]) => Promise<
    BarcodeScanningResult[]
  >;
} = {
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
  getMicrophonePermissionsAsync,
  requestMicrophonePermissionsAsync,
  scanFromURLAsync,
};

/**
 * The type of expo-camera's native module (what `requireNativeModule("ExpoCamera")` returns).
 * There is no native module on the web: constructing this stand-in throws. Use
 * {@linkcode Camera}, {@linkcode CameraView} and the permission hooks instead.
 */
export class CameraNativeModule {
  /** Whether the system scanner UI is available (never, here). */
  declare readonly isModernBarcodeScannerAvailable: boolean;
  /** Whether recording can be toggled (never, here). */
  declare readonly toggleRecordingAsyncAvailable: boolean;
  /** Whether a camera is available. */
  declare readonly isAvailableAsync: () => Promise<boolean>;
  /** Open the system scanner UI. */
  declare readonly launchScanner: (options?: Record<string, unknown>) => Promise<void>;
  /** Close the system scanner UI. */
  declare readonly dismissScanner: () => Promise<void>;
  /** Decode the barcodes in an image. */
  declare readonly scanFromURLAsync: (
    url: string,
    barcodeTypes?: BarcodeType[],
  ) => Promise<BarcodeScanningResult[]>;
  /** The camera permission. */
  declare readonly getCameraPermissionsAsync: () => Promise<PermissionResponse>;
  /** Request the camera permission. */
  declare readonly requestCameraPermissionsAsync: () => Promise<PermissionResponse>;
  /** The microphone permission. */
  declare readonly getMicrophonePermissionsAsync: () => Promise<PermissionResponse>;
  /** Request the microphone permission. */
  declare readonly requestMicrophonePermissionsAsync: () => Promise<PermissionResponse>;
  /** The video codecs the camera can record with. */
  declare readonly getAvailableVideoCodecsAsync: () => Promise<string[]>;

  /** Always throws: there is no native camera module on the web. */
  constructor() {
    throw nativeOnly("expo-camera", "CameraNativeModule");
  }
}

/**
 * Decode the barcodes in the image at `url` with the browser's `BarcodeDetector`.
 *
 * @param url The image URL.
 * @param barcodeTypes The kinds to look for (default all).
 * @returns The codes found; it rejects where there is no `BarcodeDetector`.
 */
export async function scanFromURLAsync(
  url: string,
  barcodeTypes?: BarcodeType[],
): Promise<BarcodeScanningResult[]> {
  const Detector = (globalThis as {
    BarcodeDetector?: new (o?: { formats?: string[] }) => {
      detect(source: unknown): Promise<{ rawValue: string; format: string }[]>;
    };
  }).BarcodeDetector;
  if (!Detector) throw new Error("scanFromURLAsync: no BarcodeDetector in this browser");
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const formats = barcodeTypes?.map((t) => FORMATS[t]);
  const found = await new Detector(formats ? { formats } : undefined).detect(bitmap);
  return found.map((code) => toResult(code.rawValue, code.format));
}

// ---- the camera view ------------------------------------------------------------------------

/** The browser's media devices, where there are any. */
function mediaDevices(): MediaDevices | undefined {
  const media = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator
    ?.mediaDevices;
  return typeof media?.getUserMedia === "function" ? media : undefined;
}

/** The browser's `MediaRecorder`, where there is one. */
function mediaRecorder(): typeof MediaRecorder | undefined {
  const Recorder = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  return typeof Recorder === "function" ? Recorder : undefined;
}

/** Whether a scanner can open: the native plugin, or `BarcodeDetector` with a camera. */
function scannerAvailable(): boolean {
  if (nativePlugin("CapacitorBarcodeScanner", ["scanBarcode"])) return true;
  const g = globalThis as { BarcodeDetector?: unknown };
  return typeof g.BarcodeDetector === "function" && mediaDevices() !== undefined;
}

/** A 2D canvas of `w`×`h` (the page's `document`), or null. */
function pictureCanvas(w: number, h: number): HTMLCanvasElement | null {
  const doc = (globalThis as { document?: Document }).document;
  const canvas = doc?.createElement?.("canvas") as HTMLCanvasElement | undefined;
  if (!canvas) return null;
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** The error a capture call throws without a running preview. */
function noPreview(call: string): Error {
  return new Error(
    `denext/expo: expo-camera's ${call} needs the camera preview, which is not running ` +
      "(no camera, permission refused, or the view is not mounted).",
  );
}

/** A picture's base64 payload, from its data URL. */
function dataUrlBase64(url: string): string {
  return url.slice(url.indexOf(",") + 1);
}

/**
 * A picture held in memory until saved: what `takePictureAsync({ pictureRef: true })`
 * resolves with.
 */
export class PictureRef {
  /** The width. */
  width = 0;
  /** The height. */
  height = 0;
  /** The picture's data URL. */
  #uri = "";

  /**
   * A picture reference.
   *
   * @param uri The picture's URL.
   * @param width Its width.
   * @param height Its height.
   * @returns The reference.
   */
  static fromUri(uri: string, width: number, height: number): PictureRef {
    const ref = new PictureRef();
    ref.#uri = uri;
    ref.width = width;
    ref.height = height;
    return ref;
  }

  /**
   * The picture as a {@linkcode PhotoResult} (it is already in memory: nothing is written).
   *
   * @param options `base64: true` adds the base64 payload.
   * @returns The picture.
   */
  savePictureAsync(options: SavePictureOptions = {}): Promise<PhotoResult> {
    const result: PhotoResult = { uri: this.#uri, width: this.width, height: this.height };
    if (options.base64 && this.#uri.startsWith("data:")) result.base64 = dataUrlBase64(this.#uri);
    return Promise.resolve(result);
  }
}

/** The ref handle of a {@linkcode CameraView} (what Expo's class instance offers). */
export interface CameraViewHandle {
  /** Take a picture from the preview (or, in the shell without one, with the camera plugin). */
  takePictureAsync(
    options?: CameraPictureOptions,
  ): Promise<CameraCapturedPicture | PictureRef | undefined>;
  /** Record the preview until `stopRecording` (or a limit); resolves with a `blob:` URL. */
  recordAsync(options?: CameraRecordingOptions): Promise<{ uri: string } | undefined>;
  /** Pause or resume the recording. */
  toggleRecordingAsync(): Promise<void | undefined>;
  /** Stop the recording. */
  stopRecording(): void;
  /** Pause the preview. */
  pausePreview(): Promise<void>;
  /** Resume the preview. */
  resumePreview(): Promise<void>;
  /** The picture sizes (`"<width>x<height>"`) the track supports at most. */
  getAvailablePictureSizesAsync(): Promise<string[]>;
  /** The cameras' labels. */
  getAvailableLensesAsync(): Promise<string[]>;
  /** What this view supports. */
  getSupportedFeatures(): {
    isModernBarcodeScannerAvailable: boolean;
    toggleRecordingAsyncAvailable: boolean;
  };
}

/** A recording in progress. */
interface Recording {
  recorder: MediaRecorder;
  done: Promise<{ uri: string } | undefined>;
}

/** The live parts of a mounted view: its video element, stream and recording. */
interface LiveCamera {
  video: HTMLVideoElement | null;
  stream: MediaStream | null;
  recording: Recording | null;
  mirrored: boolean;
}

/** Take a picture with the shell's camera plugin (no preview is running). */
async function pluginPicture(
  options: CameraPictureOptions,
): Promise<CameraCapturedPicture | PictureRef | undefined> {
  if (!nativePlugin("Camera", ["getPhoto"])) throw noPreview("takePictureAsync");
  const picked = await pickImage({
    source: "camera",
    as: options.base64 ? "dataUrl" : "webPath",
    quality: Math.round((options.quality ?? 1) * 100),
  });
  if (picked === null) return undefined;
  const uri = picked.dataUrl ?? picked.webPath ?? "";
  const { width, height } = await measureImage(uri);
  const format = picked.format === "png" ? "png" : "jpg";
  return finishPicture({ uri, width, height, format }, picked.dataUrl, options);
}

/** Draw the preview's current frame on a canvas, scaled and (optionally) mirrored. */
function drawFrame(video: HTMLVideoElement, options: CameraPictureOptions): HTMLCanvasElement {
  const scale = Math.max(0.01, Math.min(1, options.scale ?? 1));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  const canvas = pictureCanvas(width, height);
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    throw new Error("denext/expo: expo-camera needs a canvas to take a picture");
  }
  if (options.mirror ?? options.isImageMirror) context.setTransform(-1, 0, 0, 1, width, 0);
  context.drawImage(video, 0, 0, width, height);
  return canvas;
}

/** Take a picture from the preview frame on a canvas (or with the shell's camera plugin). */
async function captureFrame(
  live: LiveCamera,
  options: CameraPictureOptions,
): Promise<CameraCapturedPicture | PictureRef | undefined> {
  const video = live.video;
  if (!video || !live.stream || !video.videoWidth) return await pluginPicture(options);
  const canvas = drawFrame(video, options);
  const format = options.imageType === "png" ? "png" : "jpg";
  const uri = canvas.toDataURL(format === "png" ? "image/png" : "image/jpeg", options.quality ?? 1);
  const { width, height } = canvas;
  const picture = finishPicture({ uri, width, height, format }, uri, options);
  if (options.exif && !(picture instanceof PictureRef)) {
    picture.exif = { ...live.stream.getVideoTracks()[0]?.getSettings?.() };
  }
  return picture;
}

/** A picture as `options` ask for it: a {@linkcode PictureRef}, with base64, or plain. */
function finishPicture(
  picture: CameraCapturedPicture,
  dataUrl: string | undefined,
  options: CameraPictureOptions,
): CameraCapturedPicture | PictureRef {
  if (options.pictureRef) return PictureRef.fromUri(picture.uri, picture.width, picture.height);
  if (options.base64 && dataUrl) picture.base64 = dataUrlBase64(dataUrl);
  options.onPictureSaved?.(picture);
  return picture;
}

/** Record the preview's stream until stopped, `maxDuration` or `maxFileSize`. */
function startRecording(live: LiveCamera, options: CameraRecordingOptions): Recording {
  const Recorder = mediaRecorder();
  if (!live.stream) throw noPreview("recordAsync");
  if (!Recorder) throw new Error("denext/expo: expo-camera's recordAsync needs MediaRecorder");
  const recorder = new Recorder(live.stream);
  const chunks: Blob[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<{ uri: string } | undefined>((resolve, reject) => {
    recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data?.size) return;
      chunks.push(event.data);
      size += event.data.size;
      if (options.maxFileSize && size >= options.maxFileSize && recorder.state !== "inactive") {
        recorder.stop();
      }
    };
    recorder.onstop = () => {
      clearTimeout(timer);
      live.recording = null;
      if (chunks.length === 0) return resolve(undefined);
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
      resolve({ uri: URL.createObjectURL(blob) });
    };
    recorder.onerror = (event: Event) => {
      clearTimeout(timer);
      live.recording = null;
      reject((event as { error?: Error }).error ?? new Error("Recording failed"));
    };
  });
  if (options.maxDuration) {
    timer = setTimeout(
      () => recorder.state !== "inactive" && recorder.stop(),
      options.maxDuration * 1000,
    );
  }
  recorder.start(options.maxFileSize ? 1000 : undefined);
  return { recorder, done };
}

/** The imperative handle over a mounted view's live parts. */
function cameraHandle(live: LiveCamera): CameraViewHandle {
  return {
    takePictureAsync: (options = {}) => captureFrame(live, options),
    recordAsync(options = {}) {
      if (live.recording) return Promise.reject(new Error("A recording is already running"));
      try {
        live.recording = startRecording(live, options);
      } catch (err) {
        return Promise.reject(err);
      }
      return live.recording.done;
    },
    toggleRecordingAsync() {
      const recorder = live.recording?.recorder;
      if (recorder?.state === "recording") recorder.pause();
      else if (recorder?.state === "paused") recorder.resume();
      return Promise.resolve();
    },
    stopRecording() {
      const recorder = live.recording?.recorder;
      if (recorder && recorder.state !== "inactive") recorder.stop();
    },
    pausePreview() {
      live.video?.pause();
      return Promise.resolve();
    },
    async resumePreview() {
      await live.video?.play();
    },
    getAvailablePictureSizesAsync() {
      const track = live.stream?.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as
        | { width?: { max?: number }; height?: { max?: number } }
        | undefined;
      const w = caps?.width?.max;
      const h = caps?.height?.max;
      return Promise.resolve(w && h ? [`${w}x${h}`] : []);
    },
    async getAvailableLensesAsync() {
      const devices = await mediaDevices()?.enumerateDevices?.() ?? [];
      return devices.filter((d) => d.kind === "videoinput").map((d) => d.label).filter(Boolean);
    },
    getSupportedFeatures: () => ({
      isModernBarcodeScannerAvailable: scannerAvailable(),
      toggleRecordingAsyncAvailable: typeof mediaRecorder()?.prototype.pause === "function",
    }),
  };
}

/** Apply the torch and zoom constraints the track supports (best effort). */
function applyTrackOptions(stream: MediaStream, torch: boolean, zoom: number | undefined): void {
  const track = stream.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as
    | { torch?: boolean; zoom?: { min: number; max: number } }
    | undefined;
  if (!track || !caps) return;
  const advanced: Record<string, unknown> = {};
  if (caps.torch) advanced.torch = torch;
  if (caps.zoom && zoom !== undefined) {
    advanced.zoom = caps.zoom.min +
      (caps.zoom.max - caps.zoom.min) * Math.max(0, Math.min(1, zoom));
  }
  if (Object.keys(advanced).length) {
    track.applyConstraints({ advanced: [advanced as MediaTrackConstraintSet] }).catch(() => {});
  }
}

/** The scanner surface: denext's full-screen scanner, reopened by a "Scan" button. */
function ScannerView(props: CameraViewProps): VNode {
  const { barcodeScannerSettings, onBarcodeScanned, onMountError, style, children } = props;
  const [attempt, setAttempt] = useState(0);
  const [idle, setIdle] = useState(false);
  const latest = useRef(onBarcodeScanned);
  latest.current = onBarcodeScanned;
  const types = barcodeScannerSettings?.barcodeTypes?.join(",") ?? "";
  useEffect(() => {
    let active = true;
    setIdle(false);
    const formats = types ? types.split(",").map((t) => FORMATS[t as BarcodeType]) : undefined;
    scanBarcode(formats ? { formats } : {}).then((code) => {
      if (!active) return;
      if (code) latest.current?.(toResult(code.value, code.format));
      else setIdle(true);
    }, (err: Error) => {
      if (!active) return;
      setIdle(true);
      onMountError?.({ message: err.message });
    });
    return () => void (active = false);
  }, [types, attempt]);
  const button = idle
    ? h("button", {
      type: "button",
      onClick: () => setAttempt((n) => n + 1),
      style: { margin: "auto", padding: "8px 16px", fontSize: 16 },
    }, "Scan")
    : null;
  return h(
    hostView(),
    { style: viewStyle(style, { backgroundColor: "#000" }) },
    button,
    children as never,
  );
}

/**
 * The camera view. With `onBarcodeScanned` it opens denext's scanner on mount and reports the
 * first code (with a button to scan again after a cancel). Otherwise it shows a live
 * `getUserMedia` preview (`facing`, `mode`, `mute`, `active`, `zoom`, the torch), and its ref
 * takes pictures and records video (see {@linkcode CameraViewHandle}).
 *
 * @param props The view props.
 * @returns The view.
 */
export function CameraView(props: CameraViewProps): VNode {
  const {
    barcodeScannerSettings: _b,
    onBarcodeScanned,
    onCameraReady,
    onMountError,
    facing = "back",
    mode = "picture",
    mute = false,
    active = true,
    mirror,
    flash,
    enableTorch,
    zoom,
    style,
    children,
    ref,
    ...rest
  } = props;
  const live = useRef<LiveCamera>({ video: null, stream: null, recording: null, mirrored: false });
  const handleRef = useRef<CameraViewHandle | null>(null);
  handleRef.current ??= cameraHandle(live.current);
  useImperativeHandle(ref as never, () => handleRef.current!, []);
  const scanning = onBarcodeScanned !== undefined;
  const ready = useRef(onCameraReady);
  ready.current = onCameraReady;
  const failed = useRef(onMountError);
  failed.current = onMountError;
  const audio = mode === "video" && !mute;
  const torch = enableTorch === true || flash === "on";
  const track = useRef({ torch, zoom });
  track.current = { torch, zoom };
  useEffect(() => {
    if (scanning || !active) return;
    const media = mediaDevices();
    if (!media) {
      failed.current?.({ message: "No camera here (no navigator.mediaDevices)" });
      return;
    }
    let running = true;
    media.getUserMedia({
      video: { facingMode: facing === "front" ? "user" : "environment" },
      audio,
    }).then(async (stream) => {
      if (!running) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      live.current.stream = stream;
      applyTrackOptions(stream, track.current.torch, track.current.zoom);
      const video = live.current.video;
      if (video) {
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play?.()?.catch?.(() => {});
      }
      ready.current?.();
    }, (err: Error) => {
      if (running) failed.current?.({ message: err.message });
    });
    return () => {
      running = false;
      live.current.recording?.recorder.state !== "inactive" &&
        live.current.recording?.recorder.stop();
      for (const track of live.current.stream?.getTracks() ?? []) track.stop();
      live.current.stream = null;
    };
  }, [scanning, active, facing, audio]);
  useEffect(() => {
    if (live.current.stream) applyTrackOptions(live.current.stream, torch, zoom);
  }, [torch, zoom]);
  if (scanning) return h(ScannerView as never, { ...props, ref: undefined } as never);
  const mirrored = mirror ?? facing === "front";
  live.current.mirrored = mirrored;
  return h(
    hostView(),
    { ...rest, style: viewStyle(style, { backgroundColor: "#000", overflow: "hidden" }) },
    h("video", {
      ref: (el: HTMLVideoElement | null) => void (live.current.video = el),
      autoPlay: true,
      muted: true,
      playsInline: true,
      style: {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: mirrored ? "scaleX(-1)" : undefined,
      },
    }),
    children as never,
  );
}

/** The scanner listeners {@linkcode CameraView.launchScanner} reports to. */
let modernScans: Emitter<ScanningResult> | undefined;

/**
 * Whether denext's scanner can open here (read live): the native barcode plugin, or
 * `BarcodeDetector` with a camera.
 */
CameraView.isModernBarcodeScannerAvailable = false as boolean;
Object.defineProperty(CameraView, "isModernBarcodeScannerAvailable", {
  get: scannerAvailable,
  enumerable: true,
});

/**
 * Whether a camera is available: the native camera or scanner plugin, or a video input.
 *
 * @returns `true` when there is one.
 */
CameraView.isAvailableAsync = async (): Promise<boolean> => {
  if (nativePlugin("Camera", ["getPhoto"]) || scannerAvailable()) return true;
  const devices = await mediaDevices()?.enumerateDevices?.().catch(() => []) ?? [];
  return devices.some((d) => d.kind === "videoinput");
};

/**
 * The video codecs `recordAsync` can use, by Expo's name: `avc1` / `hvc1` where
 * `MediaRecorder` records H.264 / HEVC MP4.
 *
 * @returns The codecs.
 */
CameraView.getAvailableVideoCodecsAsync = (): Promise<VideoCodec[]> => {
  const Recorder = mediaRecorder();
  const supported = (type: string) => Recorder?.isTypeSupported?.(type) === true;
  const codecs: VideoCodec[] = [];
  if (supported("video/mp4;codecs=avc1")) codecs.push("avc1");
  if (supported("video/mp4;codecs=hvc1")) codecs.push("hvc1");
  return Promise.resolve(codecs);
};

/**
 * Open denext's full-screen scanner; the code read goes to the
 * {@linkcode CameraView.onModernBarcodeScanned} listeners.
 *
 * @param options The kinds to look for.
 */
CameraView.launchScanner = async (options?: ScanningOptions): Promise<void> => {
  const formats = options?.barcodeTypes?.map((t) => FORMATS[t]);
  const code = await scanBarcode(formats ? { formats } : {});
  if (!code) return;
  const { bounds: _b, cornerPoints: _c, ...result } = toResult(code.value, code.format);
  modernScans?.emit(result);
};

/** Close the scanner (it closes itself once it reads a code or is cancelled). */
CameraView.dismissScanner = (): Promise<void> => Promise.resolve();

/**
 * Listen for codes read by {@linkcode CameraView.launchScanner}.
 *
 * @param listener Called with each code.
 * @returns A subscription to remove.
 */
CameraView.onModernBarcodeScanned = (listener: (event: ScanningResult) => void): Subscription =>
  (modernScans ??= createEmitter()).subscribe(listener);

/** Expo's prop conversion tables (the facing and flash names). */
CameraView.ConversionTables = {
  type: { front: "front", back: "back" },
  flash: { off: "off", on: "on", auto: "auto", screen: "screen" },
} as { [prop: string]: unknown; type: Record<string, string>; flash: Record<string, string> };

/** The default props. */
CameraView.defaultProps = {} as CameraViewProps;
