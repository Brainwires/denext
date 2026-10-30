// Texts that ship compressed: a generator packs a set of named string records into one
// Brotli-compressed JSON document in base64 (a quarter of the text's size: the JSR package has a
// 20 MiB cap), and the module it writes hands that string to `packedRecords`. Every record is an
// object whose keys are known up front and whose values decode on the first read of any of them,
// so importing a packed module costs nothing until a text is used.
//
// The native templates are packed this way (scripts/gen-native-templates.ts →
// src/build/native-templates.packed.ts, which imports the pack from @denext/docs-corpus).

import { decodeBase64 } from "@std/encoding/base64";
import { brotliDecompressSync } from "node:zlib";

/** The names in a pack: for each group, each record's keys in order. */
export type PackLayout = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** The records of a pack, by group and record name. */
export type PackedRecords<L extends PackLayout> = {
  readonly [G in keyof L]: { readonly [R in keyof L[G]]: Readonly<Record<string, string>> };
};

/** Decode a pack (written by scripts/lib/pack-texts.ts): Brotli, then base64, then JSON. */
function unpackTexts(
  brotliBase64: string,
): Record<string, Record<string, Record<string, string>>> {
  return JSON.parse(new TextDecoder().decode(brotliDecompressSync(decodeBase64(brotliBase64))));
}

/**
 * The records of a pack, decoded lazily: each record has the keys `layout` lists, in that order,
 * as enumerable getters; the first read of any of them decodes the whole pack.
 *
 * @param layout Each group's records and their keys (written beside the pack by its generator).
 * @param brotliBase64 The packed document.
 * @returns The records, by group and record name.
 */
export function packedRecords<const L extends PackLayout>(
  layout: L,
  brotliBase64: string,
): PackedRecords<L> {
  let texts: Record<string, Record<string, Record<string, string>>> | undefined;
  const text = (group: string, record: string, key: string): string => {
    texts ??= unpackTexts(brotliBase64);
    const value = texts[group]?.[record]?.[key];
    if (value === undefined) throw new Error(`packed text ${group}.${record}["${key}"] is missing`);
    return value;
  };
  const out: Record<string, Record<string, Record<string, string>>> = {};
  for (const [group, records] of Object.entries(layout)) {
    out[group] = {};
    for (const [record, keys] of Object.entries(records)) {
      const target: Record<string, string> = {};
      for (const key of keys) {
        Object.defineProperty(target, key, {
          enumerable: true,
          get: () => text(group, record, key),
        });
      }
      out[group][record] = target;
    }
  }
  return out as PackedRecords<L>;
}
