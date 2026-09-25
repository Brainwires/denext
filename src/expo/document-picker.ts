/**
 * `expo-document-picker` for denext: the system document picker over `denext/mobile`'s
 * {@linkcode pickDocument} (`@capawesome/capacitor-file-picker` in the Capacitor shell, a
 * file input on the web).
 *
 * One document per pick (`multiple` picks one). On the web the asset's `uri` is a `data:`
 * URL of the file; natively it is the picked copy's web-view URL.
 *
 * @example
 * ```ts
 * import * as DocumentPicker from "denext/expo/document-picker";
 *
 * const result = await DocumentPicker.getDocumentAsync({ type: "application/pdf" });
 * if (!result.canceled) upload(result.assets[0].uri);
 * ```
 *
 * @module
 */

import { pickDocument } from "../mobile/pickers.ts";

/** Options for {@linkcode getDocumentAsync}. */
export interface DocumentPickerOptions {
  /** Accepted MIME types (`"application/pdf"`, `"image/*"`; default any). */
  type?: string | string[];
  /** Copy the file to the cache folder (the picker always copies here). */
  copyToCacheDirectory?: boolean;
  /** Allow several (one is picked here). */
  multiple?: boolean;
  /** Include the contents as base64 in `asset.base64`. */
  base64?: boolean;
}

/** A picked document. */
export interface DocumentPickerAsset {
  /** The file name. */
  name: string;
  /** The size in bytes. */
  size?: number;
  /** A URL to read it from. */
  uri: string;
  /** The MIME type. */
  mimeType?: string;
  /** When it last changed (the pick time here). */
  lastModified: number;
  /** The contents as base64 (with `base64: true`). */
  base64?: string;
}

/** What {@linkcode getDocumentAsync} resolves with. */
export type DocumentPickerResult =
  | { canceled: false; assets: DocumentPickerAsset[] }
  | { canceled: true; assets: null };

/** A native file path as a URL the web view can load. */
function webViewUrl(path: string): string {
  const cap = (globalThis as { Capacitor?: { convertFileSrc?: (p: string) => string } })
    .Capacitor;
  return typeof cap?.convertFileSrc === "function" ? cap.convertFileSrc(path) : path;
}

/**
 * Pick a document.
 *
 * @param options Accepted types and `base64`.
 * @returns The document, or `canceled: true`.
 */
export async function getDocumentAsync(
  options: DocumentPickerOptions = {},
): Promise<DocumentPickerResult> {
  const types = options.type === undefined
    ? undefined
    : [options.type].flat().filter((t) => t !== "*/*");
  const picked = await pickDocument({
    ...(types && types.length > 0 ? { types } : {}),
    readData: options.base64 === true,
  });
  if (!picked) return { canceled: true, assets: null };
  const uri = picked.path
    ? webViewUrl(picked.path)
    : `data:${picked.mimeType};base64,${picked.data ?? ""}`;
  const asset: DocumentPickerAsset = {
    name: picked.name,
    size: picked.size,
    uri,
    mimeType: picked.mimeType,
    lastModified: Date.now(),
    ...(options.base64 && picked.data !== undefined ? { base64: picked.data } : {}),
  };
  return { canceled: false, assets: [asset] };
}
