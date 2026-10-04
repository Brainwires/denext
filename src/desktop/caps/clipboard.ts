/**
 * The `clipboard` capability: the OS clipboard through `Deno.desktop.clipboard` (denext's pinned
 * Deno Desktop runtime) — plain text, HTML and PNG images, plus the formats it holds. The page side
 * is `denext/mobile`'s `readClipboard` / `writeClipboard` / `clipboardFormats`.
 *
 * Under the stock runtime there is no native clipboard, so every method answers `unavailable` and
 * the page keeps using the WebView's `navigator.clipboard` (its web path). A format this backend
 * lacks (HTML or images on the Winit backend) answers `unsupported`, and the page falls back for
 * that call too.
 *
 * Images travel as base64 PNG (the runtime converts TIFF / DIB / any other image format on read,
 * and refuses bytes that are not a PNG on write). An image write replaces the whole clipboard: the
 * runtime offers it in the OS's image formats, with no text alternative.
 *
 * Runtime-only (imported by the caps resolver, never a client bundle).
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import {
  type DesktopAppApi,
  desktopAppApi,
  type DesktopNativeClipboard,
} from "../launch-events.ts";

/** The largest text / HTML / base64 image a write accepts (the bridge caps a request at 4 MiB). */
const MAX_WRITE_CHARS = 4 * 1024 * 1024;

/** The formats a read can ask for. */
const READ_FORMATS = ["text", "html", "image"] as const;

/** Options for {@linkcode clipboardCapability}. */
export interface ClipboardCapabilityOptions {
  /** The runtime's app API (default `Deno.desktop`); tests pass a fake. */
  readonly api?: DesktopAppApi;
}

/** The native clipboard, or `unavailable` (the page then uses the WebView's clipboard). */
function nativeClipboard(api: DesktopAppApi | undefined): DesktopNativeClipboard {
  const clip = api?.clipboard;
  if (typeof clip?.readText !== "function" || typeof clip.writeText !== "function") {
    throw new DesktopCapError(
      "unavailable",
      "this Deno Desktop runtime has no native clipboard (denext's pinned runtime adds it)",
    );
  }
  return clip;
}

/** What the native clipboard supports (all `false` when the runtime cannot say). */
function supports(clip: DesktopNativeClipboard): { html: boolean; image: boolean } {
  let caps: ReturnType<DesktopNativeClipboard["capabilities"]> | undefined;
  try {
    caps = typeof clip.capabilities === "function" ? clip.capabilities() : undefined;
  } catch {
    caps = undefined;
  }
  return { html: caps?.html === true, image: caps?.image === true };
}

/** `unsupported` (501) for a format this backend lacks; the page falls back to its web path. */
function unsupported(what: string): DesktopCapError {
  return new DesktopCapError("unsupported", `this desktop backend has no ${what} clipboard`, {
    status: 501,
  });
}

/** An optional string argument (`undefined` when absent), capped. */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_WRITE_CHARS) {
    throw new DesktopCapError("validation", `${name} must be a string up to 4 MiB`);
  }
  return value;
}

/** Read one format: text and HTML as strings, an image as base64 PNG (`""` when none). */
async function readFormat(clip: DesktopNativeClipboard, format: unknown): Promise<string> {
  const f = format ?? "text";
  if (!READ_FORMATS.includes(f as typeof READ_FORMATS[number])) {
    throw new DesktopCapError("validation", 'format must be "text", "html" or "image"');
  }
  if (f === "text") return await clip.readText() ?? "";
  const can = supports(clip);
  if (f === "html") {
    if (!can.html) throw unsupported("HTML");
    return await clip.readHTML() ?? "";
  }
  if (!can.image) throw unsupported("image");
  const png = await clip.readImage();
  return png instanceof Uint8Array && png.length > 0 ? bytesToBase64(png) : "";
}

/** Write a base64 PNG (the image replaces the clipboard). */
async function writeImage(clip: DesktopNativeClipboard, image: string): Promise<void> {
  if (!supports(clip).image) throw unsupported("image");
  let png: Uint8Array;
  try {
    png = base64ToBytes(image);
  } catch {
    throw new DesktopCapError("validation", "image must be base64 PNG bytes");
  }
  try {
    await clip.writeImage(png);
  } catch (err) {
    if (err instanceof TypeError) throw new DesktopCapError("validation", "image is not a PNG");
    throw err;
  }
}

/**
 * Write `{ text }`, `{ html, text? }` or `{ image }` (base64 PNG). An image is exclusive: the
 * native write replaces the clipboard with the image alone.
 */
async function writeContent(clip: DesktopNativeClipboard, args: unknown): Promise<void> {
  const a = (args ?? {}) as { text?: unknown; html?: unknown; image?: unknown };
  const text = optionalString(a.text, "text");
  const html = optionalString(a.html, "html");
  const image = optionalString(a.image, "image");
  if (image !== undefined && (text !== undefined || html !== undefined)) {
    throw new DesktopCapError("validation", "an image write cannot carry text or html");
  }
  if (image !== undefined) return await writeImage(clip, image);
  if (html !== undefined) {
    if (!supports(clip).html) throw unsupported("HTML");
    return await clip.writeHTML(html, text);
  }
  if (text === undefined) {
    throw new DesktopCapError("validation", "text, html or image is required");
  }
  await clip.writeText(text);
}

/**
 * What reading the clipboard needs under denext's pinned runtime: an UNSCOPED `--allow-sys`
 * (`Deno.errors.NotCapable` otherwise); writing needs nothing.
 */
const READ_PERMISSIONS = { sys: ["*"] } as const;

/**
 * Build the `clipboard` capability.
 *
 * @param options The runtime API (tests).
 * @returns The capability.
 */
export function clipboardCapability(options: ClipboardCapabilityOptions = {}): DesktopCapability {
  const api = () => options.api ?? desktopAppApi();
  return {
    name: "clipboard",
    methods: {
      capabilities: {
        handler: () => {
          const clip = nativeClipboard(api());
          return { text: true, ...supports(clip) };
        },
      },
      readText: {
        permissions: READ_PERMISSIONS,
        handler: async () => await readFormat(nativeClipboard(api()), "text"),
      },
      writeText: {
        handler: async (args) => {
          const text = optionalString((args as { text?: unknown } | null)?.text, "text");
          await nativeClipboard(api()).writeText(text ?? "");
          return null;
        },
      },
      read: {
        permissions: READ_PERMISSIONS,
        handler: async (args) =>
          await readFormat(nativeClipboard(api()), (args as { format?: unknown } | null)?.format),
      },
      write: {
        handler: async (args) => {
          await writeContent(nativeClipboard(api()), args);
          return null;
        },
      },
      formats: {
        permissions: READ_PERMISSIONS,
        handler: async () => {
          const clip = nativeClipboard(api());
          if (typeof clip.availableFormats !== "function") return [];
          const formats = await clip.availableFormats();
          return Array.isArray(formats) ? formats.filter((f) => typeof f === "string") : [];
        },
      },
    },
  };
}
