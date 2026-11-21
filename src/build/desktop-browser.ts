// `desktop.app.browser` at packaging time, macOS side: the Info.plist keys that make LaunchServices
// list the app under System Settings › Default web browser. `deno desktop` writes
// `CFBundleURLTypes` only for `desktop.app.deepLinks` (which refuses `http` / `https`), so the
// package script adds the browser's entries to the bundle's Info.plist before signing, the way it
// adds `NSUserActivityTypes` and the media usage descriptions (./desktop-app-config.ts).
//
// The Linux side is the `MimeType` merge in the `.desktop` writers (./desktop-installers.ts,
// ./desktop-linux-entry.ts).

import { BROWSER_DOCUMENT_TYPES, BROWSER_SCHEMES } from "../desktop/browser-config.ts";
import { dictGet, parsePlist, type PlistNode, renderPlist, stringOf } from "./plist-value.ts";

/** The `CFBundleURLName` of the browser's URL type (Chromium's and Firefox's name for it). */
const BROWSER_URL_TYPE_NAME = "Web site URL";

/** A plist string node. */
const str = (text: string): PlistNode => ({ kind: "string", text });

/** A plist dict node. */
const dict = (entries: Array<[string, PlistNode]>): PlistNode => ({ kind: "dict", entries });

/** The array items of `node`, or `[]`. */
function items(node: PlistNode | undefined): PlistNode[] {
  return node?.kind === "array" ? node.items : [];
}

/** Whether `node` is the browser URL type a previous run added (by its name). */
function isBrowserUrlType(node: PlistNode): boolean {
  return node.kind === "dict" &&
    stringOf(dictGet(node, "CFBundleURLName")) === BROWSER_URL_TYPE_NAME;
}

/** Whether `node` is a document type declaring exactly one of the browser's types. */
function isBrowserDocumentType(node: PlistNode): boolean {
  if (node.kind !== "dict") return false;
  const types = items(dictGet(node, "LSItemContentTypes"));
  const uti = types.length === 1 ? stringOf(types[0]) : undefined;
  return uti !== undefined && BROWSER_DOCUMENT_TYPES.some(([t]) => t === uti);
}

/**
 * `Info.plist` text that declares the app a web browser: a `CFBundleURLTypes` entry for `http` and
 * `https` (role `Viewer`) and one `CFBundleDocumentTypes` entry per document type in
 * {@linkcode BROWSER_DOCUMENT_TYPES} (`public.html`, `public.xhtml`, `public.url`), each with
 * `LSHandlerRank` `Alternate`. The deep-link URL types and any other document types stay; running
 * it twice gives the same file.
 *
 * @param text The bundle's `Contents/Info.plist` (XML).
 * @returns The new text.
 * @throws When the file is not an XML plist dict.
 */
export function withBrowserHandlers(text: string): string {
  const root = parsePlist(text);
  if (root.kind !== "dict") throw new Error("Info.plist is not a dict");
  const urlTypes = [
    ...items(dictGet(root, "CFBundleURLTypes")).filter((n) => !isBrowserUrlType(n)),
    dict([
      ["CFBundleURLName", str(BROWSER_URL_TYPE_NAME)],
      ["CFBundleTypeRole", str("Viewer")],
      ["CFBundleURLSchemes", { kind: "array", items: BROWSER_SCHEMES.map(str) }],
    ]),
  ];
  const docTypes = [
    ...items(dictGet(root, "CFBundleDocumentTypes")).filter((n) => !isBrowserDocumentType(n)),
    ...BROWSER_DOCUMENT_TYPES.map(([uti, name]) =>
      dict([
        ["CFBundleTypeName", str(name)],
        ["CFBundleTypeRole", str("Viewer")],
        ["LSHandlerRank", str("Alternate")],
        ["LSItemContentTypes", { kind: "array", items: [str(uti)] }],
      ])
    ),
  ];
  const entries = root.entries.filter(([k]) =>
    k !== "CFBundleURLTypes" && k !== "CFBundleDocumentTypes"
  );
  entries.push(["CFBundleURLTypes", { kind: "array", items: urlTypes }]);
  entries.push(["CFBundleDocumentTypes", { kind: "array", items: docTypes }]);
  return renderPlist({ kind: "dict", entries });
}
