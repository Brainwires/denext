/**
 * The first-party package catalog (`deno task gen:plugin-catalog`): every `@denext/*` workspace
 * package with its version, specifier, kind, plugin factory, CLI verb, docs page and options
 * schema. It ships Brotli-compressed (`./catalog.packed.ts`, src/build/packed-text.ts): the JSR
 * package has a 20 MiB cap. The repository keeps the readable document as `catalog.json` beside
 * this module, which the package leaves out.
 *
 * Runtime-only (the CLI, `denext migrate` / `upgrade`, the project UI): it decodes with
 * `node:zlib` on first use.
 *
 * @module
 */

import { unpackText } from "../build/packed-text.ts";
import { PLUGIN_CATALOG_BROTLI_BASE64 } from "./catalog.packed.ts";

/** One catalogued first-party package. */
export interface PluginCatalogRow {
  /** The JSR package name (`@denext/openapi`). */
  readonly name: string;
  /** The workspace package's version. */
  readonly version: string;
  /** The `deno add` / import-map specifier pinning it (`jsr:@denext/openapi@^0.3.0`). */
  readonly spec: string;
  /** The package's export keys. */
  readonly exports: readonly string[];
  /** The `@denext/denext` range it is built against; absent when it imports no denext. */
  readonly denext?: string;
  /** A `plugins: []` entry, or a plain library you import. */
  readonly kind: "plugin" | "library";
  /** The factory export a plugin is wired in as. */
  readonly factory?: string;
  /** The CLI verb a plugin contributes. */
  readonly verb?: string;
  /** The top-level option keys of the factory's options. */
  readonly configKeys?: readonly string[];
  /** The README H1, as plain text. */
  readonly title: string;
  /** The README's first paragraph, plain text. */
  readonly blurb: string;
  /** The docs-site path documenting it. */
  readonly docs?: string;
  /** The factory's options interface name. */
  readonly optionsType?: string;
  /** The JSON Schema of the factory's options. */
  readonly optionsSchema?: unknown;
}

/** The catalog document. */
export interface PluginCatalogDocument {
  /** The generator that wrote it. */
  readonly generatedBy: string;
  /** The packages, sorted by name. */
  readonly plugins: readonly PluginCatalogRow[];
}

let decoded: PluginCatalogDocument | undefined;

/**
 * The catalog, decoded on first use.
 *
 * @returns The catalog document.
 */
export function pluginCatalog(): PluginCatalogDocument {
  return decoded ??= JSON.parse(unpackText(PLUGIN_CATALOG_BROTLI_BASE64)) as PluginCatalogDocument;
}
