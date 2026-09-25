/**
 * `expo-camera` for denext: the permission hooks and the barcode-scanning surface of
 * `CameraView`, over `denext/mobile`'s {@linkcode scanBarcode} (the
 * `@capacitor/barcode-scanner` full-screen scanner in the Capacitor shell, `BarcodeDetector`
 * over the camera in the browser).
 *
 * A `CameraView` with `onBarcodeScanned` opens denext's scanner when it mounts (a
 * full-screen scanner rather than an inline preview) and reports the first code read; after
 * a cancel it shows a "Scan" button that reopens it. Photos, video recording and the other
 * camera controls are not provided (see the manifest).
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
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import { type BarcodeFormat, scanBarcode } from "../mobile/barcode.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import {
  createPermissionHook,
  hostView,
  type PermissionExpiration,
  type PermissionHookOptions,
  type PermissionResponse,
  permissionResponse,
  PermissionStatus,
  requestMediaPermission,
  viewStyle,
  webPermission,
} from "./internal/common.ts";

export { PermissionStatus };
export type { PermissionExpiration, PermissionHookOptions, PermissionResponse };

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

/** `CameraView` props (the scanning surface). */
export interface CameraViewProps {
  /** Which camera (ignored: the scanner uses the back camera). */
  facing?: CameraType;
  /** The kinds to look for (default all). */
  barcodeScannerSettings?: BarcodeSettings;
  /** Called with the first code read; the scanner opens only when this is set. */
  onBarcodeScanned?: (result: BarcodeScanningResult) => void;
  /** Called when the scanner cannot run (no camera, permission refused). */
  onMountError?: (event: { message: string }) => void;
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
export async function getCameraPermissionsAsync(): Promise<PermissionResponse> {
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
export async function requestCameraPermissionsAsync(): Promise<PermissionResponse> {
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
export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return permissionResponse(await webPermission("microphone"));
}

/**
 * Request the microphone permission (a `getUserMedia` call, stopped at once).
 *
 * @returns The permission.
 */
export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
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

/** The camera permission calls, as Expo's `Camera` object groups them. */
export const Camera: {
  getCameraPermissionsAsync: typeof getCameraPermissionsAsync;
  requestCameraPermissionsAsync: typeof requestCameraPermissionsAsync;
  getMicrophonePermissionsAsync: typeof getMicrophonePermissionsAsync;
  requestMicrophonePermissionsAsync: typeof requestMicrophonePermissionsAsync;
} = {
  getCameraPermissionsAsync,
  requestCameraPermissionsAsync,
  getMicrophonePermissionsAsync,
  requestMicrophonePermissionsAsync,
};

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

/**
 * The scanning camera view: opens denext's scanner on mount when `onBarcodeScanned` is set,
 * reports the first code, and offers a button to scan again after a cancel.
 *
 * @param props The view props.
 * @returns The view.
 */
export function CameraView(props: CameraViewProps): VNode {
  const {
    barcodeScannerSettings,
    onBarcodeScanned,
    onMountError,
    style,
    children,
    facing: _f,
    ...rest
  } = props;
  const [attempt, setAttempt] = useState(0);
  const [idle, setIdle] = useState(false);
  const latest = useRef(onBarcodeScanned);
  latest.current = onBarcodeScanned;
  const scanning = onBarcodeScanned !== undefined;
  const types = barcodeScannerSettings?.barcodeTypes?.join(",") ?? "";
  useEffect(() => {
    if (!scanning) return;
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
  }, [scanning, types, attempt]);
  const button = idle
    ? h("button", {
      type: "button",
      onClick: () => setAttempt((n) => n + 1),
      style: { margin: "auto", padding: "8px 16px", fontSize: 16 },
    }, "Scan")
    : null;
  return h(
    hostView(),
    { ...rest, style: viewStyle(style, { backgroundColor: "#000" }) },
    button,
    children as never,
  );
}
