/**
 * Clipboard access for `denext/mobile`: the desktop runtime's native clipboard in a Deno Desktop
 * window, the native `Clipboard` plugin in the shell, else the async Clipboard API.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";
import { type DesktopNative, onDesktop, viaDesktop } from "./desktop-branch.ts";
import { base64ToBytes, blobToBase64 } from "./base64.ts";

/** The JS side of `@capacitor/clipboard`. */
interface ClipboardPlugin {
  read(): Promise<{ value?: string; type?: string }>;
  write(options: { string?: string; image?: string }): Promise<void>;
}

/** One item of `navigator.clipboard.read()`. */
interface WebClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

/** The slice of `navigator.clipboard` the web fallback uses. */
interface WebClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  read?(): Promise<WebClipboardItem[]>;
  write?(items: unknown[]): Promise<void>;
}

/** What {@linkcode readClipboard} can read. */
export type ClipboardFormat = "text" | "html" | "image";

/** Options for {@linkcode readClipboard}. */
export interface ReadClipboardOptions {
  /**
   * The format to read: `"text"` (the default), `"html"` (the HTML a rich-text copy put there),
   * or `"image"` (a PNG, as base64).
   */
  readonly format?: ClipboardFormat;
}

/**
 * Rich content for {@linkcode writeClipboard}: text, HTML with an optional plain-text
 * alternative (what apps without HTML paste), or a PNG image as base64. An image replaces the
 * clipboard on its own: it cannot carry text alongside.
 */
export type ClipboardContent =
  | { readonly text: string; readonly html?: string; readonly image?: undefined }
  | { readonly html: string; readonly text?: string; readonly image?: undefined }
  | { readonly image: string; readonly text?: undefined; readonly html?: undefined };

/** The native plugin, when the shell has it. */
function clipboardPlugin(): ClipboardPlugin | undefined {
  return nativePlugin<ClipboardPlugin>("Clipboard", ["read", "write"]);
}

/** `navigator.clipboard`, or a rejection that says why there is none. */
function webClipboard(fn: string): WebClipboard {
  const clip = (globalThis as { navigator?: { clipboard?: Partial<WebClipboard> } }).navigator
    ?.clipboard;
  if (typeof clip?.readText !== "function" || typeof clip.writeText !== "function") {
    throw new Error(
      `${fn}: no clipboard available (navigator.clipboard needs a secure context; none during SSR)`,
    );
  }
  return clip as WebClipboard;
}

/**
 * The desktop call's result, or `undefined` to take the next path: off desktop, without the
 * `clipboard` capability (`unavailable`), or for a format this desktop backend lacks
 * (`unsupported`).
 */
async function viaDesktopClipboard<T>(
  call: (desktop: DesktopNative) => Promise<T>,
): Promise<{ value: T } | undefined> {
  if (!onDesktop()) return undefined;
  try {
    return await viaDesktop("clipboard", call);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "unsupported") return undefined;
    throw err;
  }
}

/** The plain-text rendering of an HTML fragment (for a clipboard that only takes text). */
function htmlToText(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** The first `type` blob on the web clipboard, or `undefined` (none, or no `read()`). */
async function readWebBlob(
  fn: string,
  match: (type: string) => boolean,
): Promise<Blob | undefined> {
  const clip = webClipboard(fn);
  if (typeof clip.read !== "function") return undefined;
  for (const item of await clip.read()) {
    const type = item.types.find(match);
    if (type !== undefined) return await item.getType(type);
  }
  return undefined;
}

/** Read HTML or an image off the shell / web clipboard. */
async function readRich(format: "html" | "image"): Promise<string> {
  const plugin = clipboardPlugin();
  if (plugin && format === "image") {
    const { value, type } = await plugin.read();
    return typeof type === "string" && type.startsWith("image/") && value
      ? value.replace(/^data:[^,]*,/, "")
      : "";
  }
  if (format === "html") {
    const blob = await readWebBlob("readClipboard", (t) => t === "text/html");
    return blob ? await blob.text() : "";
  }
  const blob = await readWebBlob("readClipboard", (t) => t === "image/png");
  return blob ? await blobToBase64(blob) : "";
}

/**
 * Read the clipboard: its text by default, or the HTML / image `options.format` asks for.
 *
 * - In a Deno Desktop window with the `clipboard` capability (`denext desktop add clipboard`),
 *   the OS clipboard through the desktop runtime (no permission prompt, no user gesture): text,
 *   HTML and images under denext's pinned runtime.
 * - Inside the native shell, `@capacitor/clipboard` (`denext mobile add clipboard`): text, and an
 *   image when the clipboard holds one.
 * - Otherwise the async Clipboard API (`navigator.clipboard`), which browsers gate behind a
 *   permission prompt or a user gesture; HTML and images need `navigator.clipboard.read()`.
 *
 * @param options `format`: `"text"` (default), `"html"` or `"image"`.
 * @returns The text, the HTML, or the image as base64 PNG — `""` when the clipboard holds none of
 * that format.
 * @example
 * ```tsx
 * "use client";
 * import { readClipboard } from "denext/mobile";
 *
 * export function PasteCode({ onCode }: { onCode: (code: string) => void }) {
 *   return <button type="button" onClick={async () => onCode(await readClipboard())}>Paste</button>;
 * }
 * // Rich paste: const html = await readClipboard({ format: "html" });
 * ```
 */
export async function readClipboard(options: ReadClipboardOptions = {}): Promise<string> {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "html" && format !== "image") {
    throw new TypeError(`readClipboard: unknown format "${String(format)}" (text, html or image)`);
  }
  if (format !== "text") {
    const desktop = await viaDesktopClipboard((d) => d.clipboardReadFormat(format));
    return desktop ? desktop.value : await readRich(format);
  }
  const desktop = onDesktop() && await viaDesktop("clipboard", (d) => d.clipboardRead());
  if (desktop) return desktop.value;
  const plugin = clipboardPlugin();
  if (plugin) return (await plugin.read()).value ?? "";
  return await webClipboard("readClipboard").readText();
}

/** Write rich content to the shell / web clipboard. */
async function writeRich(content: ClipboardContent): Promise<void> {
  const plugin = clipboardPlugin();
  if (content.image !== undefined) {
    if (plugin) return await plugin.write({ image: `data:image/png;base64,${content.image}` });
    const clip = webClipboard("writeClipboard");
    const Item = (globalThis as { ClipboardItem?: new (data: Record<string, Blob>) => unknown })
      .ClipboardItem;
    if (typeof clip.write !== "function" || typeof Item !== "function") {
      throw new Error("writeClipboard: this browser cannot put an image on the clipboard");
    }
    return await clip.write([
      new Item({ "image/png": new Blob([base64ToBytes(content.image)], { type: "image/png" }) }),
    ]);
  }
  const text = content.text ?? htmlToText(content.html ?? "");
  const clip = plugin ? undefined : webClipboard("writeClipboard");
  const Item = (globalThis as { ClipboardItem?: new (data: Record<string, Blob>) => unknown })
    .ClipboardItem;
  if (content.html !== undefined && clip && typeof clip.write === "function" && Item) {
    return await clip.write([
      new Item({
        "text/html": new Blob([content.html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
  }
  // No HTML clipboard here (the shell plugin, or a browser without ClipboardItem): the text.
  if (plugin) return await plugin.write({ string: text });
  await clip!.writeText(text);
}

/** `content` checked: exactly one of the shapes {@linkcode ClipboardContent} allows. */
function checkContent(content: unknown): ClipboardContent {
  const c = (content ?? {}) as { text?: unknown; html?: unknown; image?: unknown };
  const str = (v: unknown) => v === undefined || typeof v === "string";
  const ok = typeof content === "object" && content !== null && str(c.text) && str(c.html) &&
    str(c.image) && (c.text !== undefined || c.html !== undefined || c.image !== undefined) &&
    (c.image === undefined || (c.text === undefined && c.html === undefined));
  if (!ok) {
    throw new TypeError(
      "writeClipboard: pass a string, { text, html? }, { html, text? } or { image } (base64 PNG)",
    );
  }
  return content as ClipboardContent;
}

/**
 * Write to the clipboard: text, or rich content (HTML with a plain-text alternative, or a PNG
 * image as base64).
 *
 * - In a Deno Desktop window with the `clipboard` capability (`denext desktop add clipboard`),
 *   the OS clipboard through the desktop runtime: text, HTML and images under denext's pinned
 *   runtime (a format the backend lacks takes the WebView path below).
 * - Inside the native shell, `@capacitor/clipboard` (`denext mobile add clipboard`): text and
 *   images (HTML is written as its text).
 * - Otherwise the async Clipboard API: `writeText`, and `ClipboardItem` for HTML and images.
 *
 * @param content The text, or `{ text, html? }` / `{ html, text? }` / `{ image }`.
 * @returns A promise that settles once the content is on the clipboard. It rejects where there is
 * no clipboard (an insecure context, SSR), for an image where the platform has no image
 * clipboard, or when the platform refuses.
 * @example
 * ```tsx
 * "use client";
 * import { writeClipboard } from "denext/mobile";
 *
 * export function CopyLink({ url }: { url: string }) {
 *   return <button type="button" onClick={() => writeClipboard(url)}>Copy link</button>;
 * }
 * // Rich copy: await writeClipboard({ html: "<b>Hi</b>", text: "Hi" });
 * ```
 */
export async function writeClipboard(content: string | ClipboardContent): Promise<void> {
  if (typeof content === "string") {
    if (onDesktop() && await viaDesktop("clipboard", (d) => d.clipboardWrite(content))) return;
    const plugin = clipboardPlugin();
    if (plugin) return await plugin.write({ string: content });
    return await webClipboard("writeClipboard").writeText(content);
  }
  const checked = checkContent(content);
  if (await viaDesktopClipboard((d) => d.clipboardWriteContent(checked))) return;
  await writeRich(checked);
}

/**
 * The kinds of content on the clipboard, as MIME types (`"text/plain"`, `"text/html"`,
 * `"image/png"` for any image, `"text/uri-list"` for files, `"text/rtf"`).
 *
 * In a Deno Desktop window with the `clipboard` capability, the OS clipboard's formats without
 * reading them; elsewhere the types `navigator.clipboard.read()` reports (a permission prompt in
 * most browsers), or the shell plugin's one item.
 *
 * @returns The MIME types; empty for an empty clipboard.
 */
export async function clipboardFormats(): Promise<string[]> {
  const desktop = await viaDesktopClipboard((d) => d.clipboardFormats());
  if (desktop) return desktop.value;
  const plugin = clipboardPlugin();
  if (plugin) {
    const { value, type } = await plugin.read();
    return value ? [typeof type === "string" && type ? type : "text/plain"] : [];
  }
  const clip = webClipboard("clipboardFormats");
  if (typeof clip.read !== "function") {
    return (await clip.readText()) !== "" ? ["text/plain"] : [];
  }
  const types = new Set<string>();
  for (const item of await clip.read()) for (const t of item.types) types.add(t);
  return [...types];
}
