/**
 * `expo-print` for denext: the system print dialog.
 *
 * - In the Capacitor shell, `@capgo/capacitor-printer` (`denext mobile add print`): `html`
 *   prints through UIPrintInteractionController / Android's PrintManager, and a `uri` (a
 *   `data:` URL, an http(s) URL fetched first, or a file path of the app) prints as its file
 *   (PDF, image). A WebView's own `window.print()` does nothing on iOS or Android, so the shell
 *   needs the plugin.
 * - In a browser, the page's print dialog: `html` and `uri` print from a hidden `<iframe>`, and
 *   with neither the page itself prints (Expo's web behaviour).
 *
 * `printToFileAsync` (HTML to a PDF file) and `selectPrinterAsync` (iOS's printer picker) are not
 * available: neither the plugin nor a browser makes a PDF or lists printers, so both reject with
 * `ERR_UNAVAILABLE`. `width`, `height`, `margins`, `orientation` and `printerUrl` are left to the
 * print dialog.
 *
 * @example
 * ```ts
 * import * as Print from "denext/expo/print";
 *
 * await Print.printAsync({ html: "<h1>Receipt</h1><p>Total: $4.20</p>" });
 * ```
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";
import { unavailable } from "./internal/common.ts";

/** The orientation values Expo takes. */
export interface OrientationType {
  /** Portrait. */
  portrait: string;
  /** Landscape. */
  landscape: string;
}

/** Page margins in points. */
export interface PageMargins {
  /** Top. */
  top: number;
  /** Right. */
  right: number;
  /** Bottom. */
  bottom: number;
  /** Left. */
  left: number;
}

/** What to print. */
export interface PrintOptions {
  /** A file to print: a `data:` URL, an http(s) URL, or a file path of the app. */
  uri?: string;
  /** HTML to print. */
  html?: string;
  /** Page width in points (left to the dialog). */
  width?: number;
  /** Page height in points (left to the dialog). */
  height?: number;
  /** iOS: print straight to this printer (left to the dialog). */
  printerUrl?: string;
  /** iOS: lay HTML out with the markup formatter (always, here). */
  useMarkupFormatter?: boolean;
  /** Deprecated: HTML for iOS's markup formatter (printed as `html`). */
  markupFormatterIOS?: string;
  /** The orientation (left to the dialog). */
  orientation?: OrientationType["portrait"] | OrientationType["landscape"];
  /** Page margins (left to the dialog). */
  margins?: PageMargins;
}

/** A printer (`selectPrinterAsync`). */
export interface Printer {
  /** Its name. */
  name: string;
  /** Its URL. */
  url: string;
}

/** Options for {@linkcode printToFileAsync}. */
export interface FilePrintOptions {
  /** HTML to render. */
  html?: string;
  /** Use the markup formatter. */
  useMarkupFormatter?: boolean;
  /** Page width in points. */
  width?: number;
  /** Page height in points. */
  height?: number;
  /** Page margins. */
  margins?: PageMargins;
  /** Also return the PDF as base64. */
  base64?: boolean;
  /** Android text zoom. */
  textZoom?: number;
}

/** A PDF made by {@linkcode printToFileAsync}. */
export interface FilePrintResult {
  /** Its file URI. */
  uri: string;
  /** Its page count. */
  numberOfPages: number;
  /** Its bytes as base64, when asked for. */
  base64?: string;
}

/** The orientation values. */
export const Orientation: OrientationType = { portrait: "portrait", landscape: "landscape" };

/** `@capgo/capacitor-printer`, the calls used here. */
interface PrinterPlugin {
  printHtml(options: { html: string; name?: string }): Promise<void>;
  printBase64(options: { data: string; mimeType: string; name?: string }): Promise<void>;
  printFile(options: { path: string; mimeType?: string; name?: string }): Promise<void>;
}

/** The shell's printer plugin, if installed. */
function printer(): PrinterPlugin | undefined {
  return nativePlugin<PrinterPlugin>("Printer", ["printHtml", "printBase64", "printFile"]);
}

/** A blob's bytes as base64. */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Print `uri` through the plugin: a data or http(s) URL as bytes, anything else as a path. */
async function printUriNative(p: PrinterPlugin, uri: string): Promise<void> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (data) {
    const mimeType = data[1] || "application/pdf";
    const payload = data[2] ? data[3] : btoa(decodeURIComponent(data[3]));
    return await p.printBase64({ data: payload, mimeType });
  }
  if (/^https?:/i.test(uri)) {
    const res = await fetch(uri);
    if (!res.ok) {
      throw new Error(`denext/expo: fetching ${uri} to print failed (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    return await p.printBase64({
      data: await base64Of(blob),
      mimeType: blob.type || "application/pdf",
    });
  }
  return await p.printFile({ path: uri.replace(/^file:\/\//, "") });
}

/**
 * Print `html` or `uri` from a hidden iframe, or the page itself with neither. The HTML frame is
 * sandboxed without script (see below).
 */
function printWeb(options: PrintOptions): Promise<void> {
  const g = globalThis as { document?: Document; print?: () => void };
  const doc = g.document;
  const html = options.html ?? options.markupFormatterIOS;
  if (!doc || (!html && !options.uri)) {
    g.print?.();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const frame = doc.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        setTimeout(() => frame.remove(), 1000);
      }
    };
    if (html) {
      // The caller's HTML runs in no script: `allow-modals` lets it print, `allow-same-origin`
      // lets this page call print() on it, and without `allow-scripts` that origin is never
      // the HTML's to use (a script in it would otherwise run as the page itself).
      frame.setAttribute("sandbox", "allow-modals allow-same-origin");
      frame.srcdoc = html;
    } else frame.src = options.uri!;
    doc.body.appendChild(frame);
  });
}

/** One print at a time, as Expo. */
let printing = false;

/**
 * Print HTML or a file with the system print dialog.
 *
 * @param options `html` or `uri` (exactly one), and dialog hints.
 * @throws When both or neither are given in the shell, while another print runs, or (with
 *   `ERR_UNAVAILABLE`) in the shell without the printer plugin.
 */
export async function printAsync(options: PrintOptions): Promise<void> {
  const html = options.html ?? options.markupFormatterIOS;
  if (options.uri && html) {
    throw new Error("Must provide exactly one of `html` and `uri` but both were specified");
  }
  if (nativePlatform() === "web") return await printWeb(options);
  const p = printer();
  if (!p) {
    throw unavailable(
      "expo-print",
      "printAsync",
      "A WebView cannot print by itself: run `denext mobile add print`.",
    );
  }
  if (!options.uri && !html) throw new Error("Must provide either `html` or `uri` to print");
  if (printing) throw new Error("Another print request is already in progress");
  printing = true;
  try {
    if (html) await p.printHtml({ html });
    else await printUriNative(p, options.uri!);
  } finally {
    printing = false;
  }
}

/**
 * Pick a printer (iOS): not available here.
 *
 * @returns Never: it rejects with `ERR_UNAVAILABLE`.
 */
export function selectPrinterAsync(): Promise<Printer> {
  return Promise.reject(
    unavailable("expo-print", "selectPrinterAsync", "The print dialog picks the printer."),
  );
}

/**
 * Render HTML to a PDF file: not available here (no PDF renderer in the plugin or the page).
 *
 * @param _options The HTML and page setup.
 * @returns Never: it rejects with `ERR_UNAVAILABLE`.
 */
export function printToFileAsync(_options?: FilePrintOptions): Promise<FilePrintResult> {
  return Promise.reject(
    unavailable(
      "expo-print",
      "printToFileAsync",
      "No PDF renderer is available here; print with printAsync, or render the PDF on a server.",
    ),
  );
}
