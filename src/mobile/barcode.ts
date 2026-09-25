/**
 * Barcode / QR scanning for `denext/mobile`: the official `CapacitorBarcodeScanner` plugin in
 * the shell, else the `BarcodeDetector` API over a camera stream in the browser.
 *
 * @module
 */

import { isDismissal } from "./base64.ts";
import { nativePlugin } from "./plugin.ts";

/** A barcode format, by its `BarcodeDetector` name. */
export type BarcodeFormat =
  | "qr_code"
  | "aztec"
  | "codabar"
  | "code_39"
  | "code_93"
  | "code_128"
  | "data_matrix"
  | "ean_13"
  | "ean_8"
  | "itf"
  | "pdf417"
  | "upc_a"
  | "upc_e";

/** Options for {@linkcode scanBarcode}. */
export interface ScanBarcodeOptions {
  /**
   * The formats to look for. Default: all. The native scanner takes a single format hint, so
   * with more than one it looks for every format.
   */
  readonly formats?: readonly BarcodeFormat[];
}

/** What {@linkcode scanBarcode} read. */
export interface ScannedBarcode {
  /** The decoded text. */
  readonly value: string;
  /** Its format, by its `BarcodeDetector` name (`"qr_code"`, `"ean_13"`, …; `"unknown"`). */
  readonly format: string;
}

/**
 * The `code` on a {@linkcode scanBarcode} rejection: `unsupported` (no scanner here: no
 * plugin, and no `BarcodeDetector` or camera in the browser, or none of the formats asked
 * for) or `denied` (camera permission refused).
 */
export type BarcodeScanErrorCode = "unsupported" | "denied";

/** The `Error` a {@linkcode scanBarcode} promise rejects with for the codes above. */
export interface BarcodeScanError extends Error {
  /** Why it failed. */
  readonly code: BarcodeScanErrorCode;
}

/** The JS side of `@capacitor/barcode-scanner` (its native `scanBarcode`). */
interface BarcodeScannerPlugin {
  scanBarcode(options: {
    hint: number;
    scanInstructions: string;
    scanButton: boolean;
    scanText: string;
    cameraDirection: number;
    scanOrientation: number;
  }): Promise<{ ScanResult?: string; format?: number }>;
}

/**
 * The plugin's format numbers (html5-qrcode's `Html5QrcodeSupportedFormats`, which the native
 * `OSBARCScannerHint` shares) by index, as `BarcodeDetector` names; 17 is "all".
 */
const NATIVE_FORMATS = [
  "qr_code",
  "aztec",
  "codabar",
  "code_39",
  "code_93",
  "code_128",
  "data_matrix",
  "maxicode",
  "itf",
  "ean_13",
  "ean_8",
  "pdf417",
  "rss_14",
  "rss_expanded",
  "upc_a",
  "upc_e",
  "upc_ean_extension",
];
const NATIVE_ALL_FORMATS = 17;
const NATIVE_CANCELLED = "OS-PLUG-BARC-0006";
const NATIVE_DENIED = "OS-PLUG-BARC-0007";

/** A {@linkcode BarcodeScanError}. */
function scanError(code: BarcodeScanErrorCode, message: string): BarcodeScanError {
  const err = new Error(`scanBarcode: ${message}`) as Error & { code: BarcodeScanErrorCode };
  err.name = "BarcodeScanError";
  err.code = code;
  return err;
}

/** The native scan: one format as the hint, else all; a dismissal is null. */
async function nativeScan(
  plugin: BarcodeScannerPlugin,
  formats: readonly BarcodeFormat[],
): Promise<ScannedBarcode | null> {
  const hint = formats.length === 1 ? NATIVE_FORMATS.indexOf(formats[0]) : NATIVE_ALL_FORMATS;
  try {
    const result = await plugin.scanBarcode({
      hint,
      // The plugin's own JS wrapper fills these in; the iOS side requires them.
      scanInstructions: " ",
      scanButton: false,
      scanText: " ",
      cameraDirection: 1,
      scanOrientation: 3,
    });
    return {
      value: String(result.ScanResult ?? ""),
      format: NATIVE_FORMATS[result.format ?? -1] ?? "unknown",
    };
  } catch (err) {
    if (isDismissal(err, [NATIVE_CANCELLED])) return null;
    if ((err as { code?: unknown })?.code === NATIVE_DENIED) {
      throw scanError("denied", "camera access was refused");
    }
    throw err;
  }
}

/** The `BarcodeDetector` constructor, as far as the web path uses it. */
interface DetectorClass {
  new (options?: { formats: string[] }): {
    detect(source: unknown): Promise<Array<{ rawValue: string; format: string }>>;
  };
  getSupportedFormats?(): Promise<string[]>;
}

/** The browser globals the web path needs, or null when one is missing. */
function webScanner(): {
  Detector: DetectorClass;
  media: { getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> };
  doc: Document;
} | null {
  const g = globalThis as {
    BarcodeDetector?: DetectorClass;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } };
    document?: Document;
  };
  const media = g.navigator?.mediaDevices;
  if (typeof g.BarcodeDetector !== "function" || typeof media?.getUserMedia !== "function") {
    return null;
  }
  if (typeof g.document?.createElement !== "function" || !g.document.body) return null;
  return {
    Detector: g.BarcodeDetector,
    media: media as { getUserMedia(c: MediaStreamConstraints): Promise<MediaStream> },
    doc: g.document,
  };
}

/** A full-screen overlay showing the camera, with a Cancel button. */
function scanOverlay(
  doc: Document,
): { root: HTMLElement; video: HTMLVideoElement; cancel: HTMLElement } {
  const root = doc.createElement("div");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Scan a barcode");
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;";
  const video = doc.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.style.cssText = "width:100%;height:100%;object-fit:cover;";
  const cancel = doc.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.style.cssText =
    "position:absolute;left:50%;bottom:max(24px,env(safe-area-inset-bottom));" +
    "transform:translateX(-50%);padding:10px 20px;font:inherit;border-radius:8px;";
  root.append(video, cancel);
  doc.body.append(root);
  return { root, video, cancel };
}

/** Detect frames until a code is read, the user cancels (null), or detection fails. */
function detectLoop(
  detector: InstanceType<DetectorClass>,
  video: HTMLVideoElement,
  cancel: HTMLElement,
): Promise<ScannedBarcode | null> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    cancel.addEventListener("click", () => finish(() => resolve(null)), { once: true });
    const tick = () => {
      if (done) return;
      detector.detect(video).then((codes) => {
        const code = codes[0];
        if (code) finish(() => resolve({ value: code.rawValue, format: code.format }));
        else setTimeout(tick, 120);
      }, (err) => finish(() => reject(err)));
    };
    tick();
  });
}

/** The web scan: BarcodeDetector over the rear camera, the stream stopped however it ends. */
async function webScan(formats: readonly BarcodeFormat[]): Promise<ScannedBarcode | null> {
  const web = webScanner();
  if (!web) {
    throw scanError("unsupported", "no scanner here (no BarcodeDetector or camera; SSR)");
  }
  const supported = await web.Detector.getSupportedFormats?.() ?? [];
  const wanted = formats.filter((f) => supported.length === 0 || supported.includes(f));
  if (formats.length > 0 && wanted.length === 0) {
    throw scanError("unsupported", `this browser cannot read ${formats.join(", ")}`);
  }
  const detector = new web.Detector(wanted.length > 0 ? { formats: wanted } : undefined);
  let stream: MediaStream;
  try {
    stream = await web.media.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch (err) {
    if ((err as { name?: unknown })?.name === "NotAllowedError") {
      throw scanError("denied", "camera access was refused");
    }
    throw err;
  }
  const overlay = scanOverlay(web.doc);
  try {
    overlay.video.srcObject = stream;
    await overlay.video.play();
    return await detectLoop(detector, overlay.video, overlay.cancel);
  } finally {
    for (const track of stream.getTracks()) track.stop();
    overlay.video.srcObject = null;
    overlay.root.remove();
  }
}

/**
 * Scan one barcode or QR code with the camera.
 *
 * - Inside the native shell with `@capacitor/barcode-scanner` installed (`denext mobile add
 *   barcode`, which also writes the camera usage string), the plugin's full-screen scanner.
 * - Otherwise, where the browser has `BarcodeDetector` and a camera, a full-screen camera view
 *   with a Cancel button; the camera stream is stopped however the scan ends. Elsewhere it
 *   rejects with code `unsupported`.
 *
 * A cancelled scan resolves `null` rather than rejecting.
 *
 * @param options `formats` to look for (default all).
 * @returns The value and format read, or `null` when the user cancelled. It rejects with a
 * {@linkcode BarcodeScanError} (`unsupported`, `denied`) or the platform's own error.
 * @example
 * ```tsx
 * "use client";
 * import { scanBarcode } from "denext/mobile";
 *
 * export function ScanTicket({ onTicket }: { onTicket: (id: string) => void }) {
 *   return (
 *     <button type="button" onClick={async () => {
 *       const code = await scanBarcode({ formats: ["qr_code"] });
 *       if (code) onTicket(code.value);
 *     }}>Scan ticket</button>
 *   );
 * }
 * ```
 */
export async function scanBarcode(
  options: ScanBarcodeOptions = {},
): Promise<ScannedBarcode | null> {
  const formats = [...new Set(options.formats ?? [])];
  const unknown = formats.filter((f) => NATIVE_FORMATS.indexOf(f) < 0);
  if (unknown.length > 0) throw new TypeError(`scanBarcode: unknown format ${unknown.join(", ")}`);
  const plugin = nativePlugin<BarcodeScannerPlugin>("CapacitorBarcodeScanner", ["scanBarcode"]);
  return plugin ? await nativeScan(plugin, formats) : await webScan(formats);
}
