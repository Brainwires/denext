// `next/font/google` for a migrated app: one named export per Google Fonts family.
//
// Next's `next/font/google` exports a loader for EVERY family (`import { Noto_Sans_Hebrew }`),
// generated from its font catalogue. denext's `denext/next/font/google` is a hand-written
// module with a curated subset — enough for new code, but a migrated app imports whatever
// families it uses. So the compat bundler swaps the specifier for a virtual module that
// re-exports the runtime module and defines a loader for every catalogued family on top
// (a local export shadows the same name from `export *`, so the curated ones stay
// correct). esbuild tree-shakes the ~1,900 unused loaders away.

import type * as esbuild from "./esbuild/mod.ts";
import { GOOGLE_FONT_FAMILIES_BROTLI_BASE64 } from "../compat/next/font/google-families.packed.ts";
import { unpackText } from "./packed-text.ts";

const SPECIFIER = "next/font/google";
const NS = "denext-font-google";

/** Next's export-name rule: spaces become `_`. */
function exportName(family: string): string {
  return family.replace(/ /g, "_");
}

let families: readonly string[] | undefined;

/**
 * Every Google Fonts family name, sorted (scripts/gen-google-fonts.ts), decoded on the first call.
 *
 * @returns The family names.
 */
export function googleFontFamilies(): readonly string[] {
  return families ??= JSON.parse(unpackText(GOOGLE_FONT_FAMILIES_BROTLI_BASE64));
}

/**
 * The virtual module's source: the runtime module's exports plus a loader per family.
 * Exported for testing.
 */
export function googleFontFamiliesModule(
  families: readonly string[] = googleFontFamilies(),
): string {
  const lines = [
    `export * from ${JSON.stringify(SPECIFIER)};`,
    `import { googleFont } from ${JSON.stringify(SPECIFIER)};`,
  ];
  for (const family of families) {
    lines.push(
      `export const ${exportName(family)} = (o) => googleFont(${JSON.stringify(family)}, o);`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * esbuild plugin: claim app imports of `next/font/google` (never the virtual module's own,
 * which fall through to the runtime alias) and serve {@link googleFontFamiliesModule}.
 * Register it BEFORE the runtime/external alias plugins.
 */
export function googleFontsPlugin(): esbuild.Plugin {
  return {
    name: "denext-google-fonts",
    setup(build) {
      build.onResolve({ filter: /^next\/font\/google$/ }, (args) => {
        if (args.namespace === NS) return null;
        return { path: SPECIFIER, namespace: NS };
      });
      build.onLoad({ filter: /.*/, namespace: NS }, () => ({
        contents: googleFontFamiliesModule(),
        loader: "js",
      }));
    },
  };
}
