// The compat bundler's `next/font/google` virtual module: every catalogued family becomes a
// named loader, layered over the runtime module's own exports.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as esbuild from "esbuild";
import { GOOGLE_FONT_FAMILIES } from "../src/compat/next/font/google-families.ts";
import { googleFontFamiliesModule, googleFontsPlugin } from "../src/build/google-fonts-plugin.ts";

Deno.test("google fonts: the catalogue is large, sorted, and yields unique identifiers", () => {
  assert(GOOGLE_FONT_FAMILIES.length > 1500, `families: ${GOOGLE_FONT_FAMILIES.length}`);
  assertEquals([...GOOGLE_FONT_FAMILIES].sort(), [...GOOGLE_FONT_FAMILIES]);
  const names = GOOGLE_FONT_FAMILIES.map((f) => f.replace(/ /g, "_"));
  assertEquals(new Set(names).size, names.length, "no two families share an export name");
  for (const n of names) assert(/^[A-Za-z_$][\w$]*$/.test(n), `not an identifier: ${n}`);
  for (const f of ["Inter", "Noto Sans Hebrew", "Vazirmatn", "Instrument Serif"]) {
    assert(GOOGLE_FONT_FAMILIES.includes(f), f);
  }
});

Deno.test("google fonts: the virtual module layers per-family loaders over the runtime exports", () => {
  const src = googleFontFamiliesModule(["Inter", "Noto Sans Hebrew"]);
  assertStringIncludes(src, `export * from "next/font/google";`);
  assertStringIncludes(src, `import { googleFont } from "next/font/google";`);
  assertStringIncludes(
    src,
    `export const Noto_Sans_Hebrew = (o) => googleFont("Noto Sans Hebrew", o);`,
  );
  assertStringIncludes(src, `export const Inter = (o) => googleFont("Inter", o);`);
});

Deno.test({
  name:
    "google fonts: an app import of an uncurated family bundles (the plugin claims only app imports)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Stand-in for the runtime alias plugin: the virtual module's own `next/font/google`
  // imports must reach it, the app's must not.
  const runtime: esbuild.Plugin = {
    name: "fake-runtime",
    setup(build) {
      build.onResolve({ filter: /^next\/font\/google$/ }, () => ({ path: "rt", namespace: "rt" }));
      build.onLoad({ filter: /.*/, namespace: "rt" }, () => ({
        contents: `export const googleFont = (f, o) => ({ className: "f-" + f.replace(/ /g, "-") });
export const Inter = (o) => googleFont("Inter", o);`,
        loader: "js",
      }));
    },
  };
  try {
    const out = await esbuild.build({
      stdin: {
        contents: `import { Inter, Noto_Sans_Hebrew } from "next/font/google";
export const a = Inter(), b = Noto_Sans_Hebrew({ subsets: ["hebrew"] });`,
        loader: "js",
      },
      bundle: true,
      write: false,
      format: "esm",
      plugins: [googleFontsPlugin(), runtime],
      logLevel: "silent",
    });
    const text = out.outputFiles[0].text;
    assertStringIncludes(text, `"Noto Sans Hebrew"`);
    assertStringIncludes(text, `"Inter"`);
    assert(!text.includes(`"Vazirmatn"`), "unused families are tree-shaken");
  } finally {
    await esbuild.stop();
  }
});
