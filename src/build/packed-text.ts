// Texts that ship compressed: a generator packs a set of named string records into one
// Brotli-compressed JSON document in base64 (a quarter of the text's size: the JSR package has a
// 20 MiB cap), and the module it writes hands that string to `packedRecords`. Every record is an
// object whose keys are known up front and whose values decode on the first read of any of them,
// so importing a packed module costs nothing until a text is used.
//
// The native templates are packed this way (scripts/gen-native-templates.ts →
// src/build/native-templates.packed.ts, which loads the pack from @denext/docs-corpus). A single
// generated text (the CLI's verb table, the config schema, the Google Fonts families) is packed
// whole and read back with `unpackText`.

import { decodeBase64 } from "@std/encoding/base64";
import { brotliDecompressSync } from "node:zlib";

/** The names in a pack: for each group, each record's keys in order. */
export type PackLayout = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

/** The records of a pack, by group and record name. */
export type PackedRecords<L extends PackLayout> = {
  readonly [G in keyof L]: { readonly [R in keyof L[G]]: Readonly<Record<string, string>> };
};

/**
 * Decode one packed text (written by scripts/lib/pack-texts.ts `brotliBase64`): base64, then
 * Brotli, then UTF-8.
 *
 * @param brotliBase64 The packed text.
 * @returns The text.
 */
export function unpackText(brotliBase64: string): string {
  return new TextDecoder().decode(brotliDecompressSync(decodeBase64(brotliBase64)));
}

/**
 * A packed JSON document (scripts/gen-packed-texts.ts), decoded on the first call and kept.
 *
 * Generated modules whose values are data tables read them through this (and
 * {@linkcode packedObject}) rather than decoding when imported: a module graph that only imports
 * them (the config validator's, and through it the packaged desktop app's) then never runs
 * `node:zlib`'s Brotli. In a Linux WebKitGTK window that call can bind to the system
 * `libbrotlidec` the web view loads and never return, so an eager decode kept the app from
 * starting (tests/desktop-runtime-graph.test.ts).
 *
 * @param brotliBase64 The packed document.
 * @returns The decoder: the document's values by name.
 */
export function lazyPack(brotliBase64: string): () => Readonly<Record<string, unknown>> {
  let values: Readonly<Record<string, unknown>> | undefined;
  return () => values ??= JSON.parse(unpackText(brotliBase64));
}

/**
 * An object value of a pack whose keys are known up front (written beside the pack by its
 * generator): each key is an enumerable getter, and the first read of any of them decodes the
 * pack. `Object.keys`, `in` and `Object.hasOwn` decode nothing.
 *
 * @param pack The pack's decoder ({@linkcode lazyPack}).
 * @param name The value's name in the pack.
 * @param keys The value's own keys, in order.
 * @returns The object.
 */
export function packedObject<T>(
  pack: () => Readonly<Record<string, unknown>>,
  name: string,
  keys: readonly string[],
): T {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => (pack()[name] as Record<string, unknown>)[key],
    });
  }
  return out as T;
}

/** Decode a pack (written by scripts/lib/pack-texts.ts): Brotli, then base64, then JSON. */
function unpackTexts(
  brotliBase64: string,
): Record<string, Record<string, Record<string, string>>> {
  return JSON.parse(unpackText(brotliBase64));
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
