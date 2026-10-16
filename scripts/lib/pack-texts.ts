// The writing half of src/build/packed-text.ts: named string records → one Brotli-compressed
// (quality 11, a 16 MiB window) JSON document in base64, plus the layout (each record's keys)
// the packed module lists beside it so `packedRecords` can build its records without decoding.

import { encodeBase64 } from "@std/encoding/base64";
import zlib from "node:zlib";

/** Groups of named string records, as packed. */
export type TextGroups = Record<string, Record<string, Record<string, string>>>;

/**
 * `bytes` Brotli-compressed at quality 11 with a 16 MiB window, in base64.
 *
 * @param bytes The data.
 * @returns The compressed data as base64.
 */
export function brotliBase64(bytes: Uint8Array): string {
  const br = zlib.brotliCompressSync(bytes, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
  return encodeBase64(new Uint8Array(br.buffer, br.byteOffset, br.byteLength));
}

/**
 * Pack `groups`: the layout `packedRecords` takes and the compressed document.
 *
 * @param groups The records, by group and record name.
 * @returns The layout and the packed document.
 */
export function packTexts(
  groups: TextGroups,
): { layout: Record<string, Record<string, string[]>>; packed: string; bytes: number } {
  const layout: Record<string, Record<string, string[]>> = {};
  for (const [group, records] of Object.entries(groups)) {
    layout[group] = {};
    for (const [name, record] of Object.entries(records)) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string") {
          throw new Error(`${group}.${name}["${key}"] is not a string`);
        }
      }
      layout[group][name] = Object.keys(record);
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(groups));
  return { layout, packed: brotliBase64(json), bytes: json.byteLength };
}
