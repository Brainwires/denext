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
 * `printToFileAsync` (HTML to a PDF file) and, on iOS, `selectPrinterAsync` (the printer picker)
 * and `printerUrl` (printing straight to that printer, without the dialog) go through denext's
 * `DenextPrint` plugin, which `denext mobile add print` installs beside the printer plugin: the
 * PDF is laid out on `width` x `height` points (US Letter, 612 x 792, by default) inside
 * `margins`, by UIMarkupTextPrintFormatter + UIPrintPageRenderer on iOS and a WebView's print
 * adapter on Android, and written to the app's cache folder. In a browser, or a shell without
 * `DenextPrint`, both reject with `ERR_UNAVAILABLE` (a browser makes no PDF and lists no
 * printers), and `selectPrinterAsync` does on Android too, as in Expo. `printAsync`'s `width`,
 * `height`, `margins` and `orientation` are left to the print dialog.
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

/** denext's `DenextPrint` (PDF files; the iOS printer picker and direct printing). */
interface DenextPrintPlugin {
  printToFile(options: {
    html: string;
    width?: number;
    height?: number;
    margins?: PageMargins;
    base64?: boolean;
    textZoom?: number;
  }): Promise<FilePrintResult>;
  selectPrinter(): Promise<Printer>;
  printToPrinter(
    options: { printerUrl: string; html?: string; data?: string; path?: string },
  ): Promise<void>;
}

/** `DenextPrint` with `method`, or undefined (the web, or a shell without it). */
function denextPrint(method: keyof DenextPrintPlugin): DenextPrintPlugin | undefined {
  return nativePlugin<DenextPrintPlugin>("DenextPrint", [method]);
}

/** Why a `DenextPrint` call is unavailable. */
const NEEDS_DENEXT_PRINT = "It needs denext's DenextPrint plugin in the Capacitor shell " +
  "(`denext mobile add print`).";

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

/** What a `uri` prints as: its bytes (a data or http(s) URL) or a file path of the app. */
type PrintSource = { data: string; mimeType: string } | { path: string };

/** `uri` as a {@linkcode PrintSource}: a data or http(s) URL as bytes, anything else as a path. */
async function printSource(uri: string): Promise<PrintSource> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (data) {
    const mimeType = data[1] || "application/pdf";
    return { data: data[2] ? data[3] : btoa(decodeURIComponent(data[3])), mimeType };
  }
  if (/^https?:/i.test(uri)) {
    const res = await fetch(uri);
    if (!res.ok) {
      throw new Error(`denext/expo: fetching ${uri} to print failed (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    return { data: await base64Of(blob), mimeType: blob.type || "application/pdf" };
  }
  return { path: uri.replace(/^file:\/\//, "") };
}

/** Print `uri` through the plugin: a data or http(s) URL as bytes, anything else as a path. */
async function printUriNative(p: PrinterPlugin, uri: string): Promise<void> {
  const source = await printSource(uri);
  if ("path" in source) return await p.printFile({ path: source.path });
  return await p.printBase64(source);
}

/** iOS: print `html` or `uri` straight to the printer at `printerUrl` (no dialog). */
async function printToPrinter(
  p: DenextPrintPlugin,
  printerUrl: string,
  html: string | undefined,
  uri: string | undefined,
): Promise<void> {
  if (html) return await p.printToPrinter({ printerUrl, html });
  const source = await printSource(uri!);
  return await p.printToPrinter(
    "path" in source ? { printerUrl, path: source.path } : { printerUrl, data: source.data },
  );
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
  const direct = options.printerUrl && nativePlatform() === "ios"
    ? denextPrint("printToPrinter")
    : undefined;
  const p = direct ? undefined : printer();
  if (!p && !direct) {
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
    if (direct) await printToPrinter(direct, options.printerUrl!, html, options.uri);
    else if (html) await p!.printHtml({ html });
    else await printUriNative(p!, options.uri!);
  } finally {
    printing = false;
  }
}

/**
 * Pick a printer with the system printer picker (iOS, as in Expo). Pass its `url` as
 * `printAsync`'s `printerUrl` to print there without the dialog.
 *
 * @returns The printer.
 * @throws `E_PRINTER_SELECTION_CANCELLED` when the picker is closed; `ERR_UNAVAILABLE` off iOS
 *   or without `DenextPrint`.
 */
export async function selectPrinterAsync(): Promise<Printer> {
  const p = nativePlatform() === "ios" ? denextPrint("selectPrinter") : undefined;
  if (!p) {
    throw unavailable(
      "expo-print",
      "selectPrinterAsync",
      nativePlatform() === "ios" ? NEEDS_DENEXT_PRINT : "Only iOS has a printer picker.",
    );
  }
  const { name, url } = await p.selectPrinter();
  return { name, url };
}

/**
 * Render HTML to a PDF file in the app's cache folder: on pages of `width` x `height` points
 * (612 x 792, US Letter, by default) inside `margins`, with `base64` the bytes too.
 *
 * @param options The HTML and page setup.
 * @returns The file's URI, its page count and, when asked for, its base64.
 * @throws `ERR_UNAVAILABLE` in a browser, or in a shell without `DenextPrint`.
 */
export async function printToFileAsync(options: FilePrintOptions = {}): Promise<FilePrintResult> {
  const p = denextPrint("printToFile");
  if (!p) throw unavailable("expo-print", "printToFileAsync", NEEDS_DENEXT_PRINT);
  const { width, height, margins, base64, textZoom } = options;
  const setup = Object.entries({ width, height, margins, base64, textZoom })
    .filter(([, value]) => value !== undefined);
  const result = await p.printToFile({ html: options.html ?? "", ...Object.fromEntries(setup) });
  const out: FilePrintResult = { uri: result.uri, numberOfPages: result.numberOfPages };
  if (result.base64 !== undefined) out.base64 = result.base64;
  return out;
}
