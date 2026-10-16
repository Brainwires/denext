// next/font/local's metric-matched fallback face (`adjustFontFallback`): the overrides are
// read from the font file itself, as Next does with fontkit.
//
// Expected values were produced by Next 16.3.8's own code over the same fixture files —
// `getFallbackMetricsFromFontFile` from `next/dist/compiled/@next/font/dist/local` fed the
// font opened by Next's compiled fontkit (`next/dist/compiled/@next/font/dist/fontkit`):
//
//   Geist-Regular.ttf / .woff  {unitsPerEm 1000, ascent 1005, descent -295, lineGap 0}
//     sans-serif → ascent 94.56%, descent 27.76%, line-gap 0.00%, size-adjust 106.28% (Arial)
//     serif      → ascent 86.45%, descent 25.38%, line-gap 0.00%, size-adjust 116.25% (TNR)
//   geist-latin.woff2 (a variable subset, different hmtx)
//     sans-serif → ascent 94.47%, descent 27.73%, line-gap 0.00%, size-adjust 106.39%
//     serif      → ascent 86.37%, descent 25.35%, line-gap 0.00%, size-adjust 116.36%
//
// (Sanity check of Next's Arial constants: the same code over macOS's Arial.ttf gives
// size-adjust 100.00%.) Fixture licence: tests/fixtures/fonts/LICENSE.md (Geist, OFL-1.1).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import localFont, { type LocalFontOptions } from "../src/compat/next/font/local.ts";
import { collectedFontFaces, resetFonts } from "../src/compat/next/font/registry.ts";
import { fontFileMetrics } from "../src/compat/next/font/font-file.ts";
import { localFallbackOverrides } from "../src/compat/next/font/fallback.ts";
import { removeTempDir } from "./helpers/temp.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures/fonts/", import.meta.url));
const TTF = join(FIXTURES, "Geist-Regular.ttf");
const WOFF = join(FIXTURES, "Geist-Regular.woff");
const WOFF2 = join(FIXTURES, "geist-latin.woff2");

const GEIST_SANS = "ascent-override:94.56%;descent-override:27.76%;" +
  "line-gap-override:0.00%;size-adjust:106.28%;";
const GEIST_SERIF = "ascent-override:86.45%;descent-override:25.38%;" +
  "line-gap-override:0.00%;size-adjust:116.25%;";
const WOFF2_SANS = "ascent-override:94.47%;descent-override:27.73%;" +
  "line-gap-override:0.00%;size-adjust:106.39%;";
const WOFF2_SERIF = "ascent-override:86.37%;descent-override:25.35%;" +
  "line-gap-override:0.00%;size-adjust:116.36%;";

/** Register a local font; return its family, stack and the fallback face it emitted. */
function register(options: LocalFontOptions) {
  resetFonts();
  const font = localFont(options);
  const family = font.style.fontFamily.split(",")[0].replace(/'/g, "");
  const fallback = collectedFontFaces().find((css) => css.includes(" Fallback'")) ?? null;
  return { font, family, fallback };
}

Deno.test("localFont (TTF) emits Next's Arial fallback face and puts it in the stack", () => {
  const { font, family, fallback } = register({ src: TTF });
  assertEquals(
    fallback,
    `@font-face{font-family:'${family} Fallback';src:local("Arial");${GEIST_SANS}}`,
  );
  assertEquals(font.style.fontFamily, `'${family}', '${family} Fallback'`);
  assertStringIncludes(
    collectedFontFaces().join("\n"),
    `{font-family:'${family}', '${family} Fallback';}`,
  );
});

Deno.test("localFont reads WOFF and WOFF2 files to the same numbers as Next", () => {
  assertStringIncludes(register({ src: WOFF }).fallback ?? "", GEIST_SANS);
  assertStringIncludes(register({ src: WOFF2 }).fallback ?? "", WOFF2_SANS);
});

Deno.test("adjustFontFallback: 'Times New Roman' measures against Times New Roman", () => {
  const ttf = register({ src: TTF, adjustFontFallback: "Times New Roman" }).fallback ?? "";
  assertStringIncludes(ttf, `src:local("Times New Roman");${GEIST_SERIF}`);
  const woff2 = register({ src: WOFF2, adjustFontFallback: "Times New Roman" }).fallback ?? "";
  assertStringIncludes(woff2, WOFF2_SERIF);
});

Deno.test("adjustFontFallback: false emits no fallback face", () => {
  const { font, family, fallback } = register({ src: TTF, adjustFontFallback: false });
  assertEquals(fallback, null);
  assertEquals(font.style.fontFamily, `'${family}'`);
});

Deno.test("the caller's fallback stack follows the metric-matched face", () => {
  const { font, family } = register({ src: TTF, fallback: ["system-ui", "sans-serif"] });
  assertEquals(font.style.fontFamily, `'${family}', '${family} Fallback', system-ui, sans-serif`);
});

Deno.test("several sources: the fallback is measured from Next's pick (weight 400, normal)", () => {
  const picked = (src: LocalFontOptions["src"]) => {
    const css = register({ src }).fallback ?? "";
    return css.includes(WOFF2_SANS) ? "woff2" : css.includes(GEIST_SANS) ? "ttf" : "none";
  };
  // Nearest weight to 400 wins.
  assertEquals(picked([{ path: TTF, weight: "700" }, { path: WOFF2, weight: "400" }]), "woff2");
  // Same weight: a normal style replaces an italic one, never the reverse.
  assertEquals(
    picked([{ path: TTF, weight: "400", style: "italic" }, { path: WOFF2, weight: "400" }]),
    "woff2",
  );
  assertEquals(
    picked([{ path: WOFF2, weight: "400" }, { path: TTF, weight: "400", style: "italic" }]),
    "woff2",
  );
  // Equal distance: the thinner file.
  assertEquals(picked([{ path: TTF, weight: "500" }, { path: WOFF2, weight: "300" }]), "woff2");
  // A variable range spanning 400 is distance 0; `bold` is 700.
  assertEquals(
    picked([{ path: TTF, weight: "bold" }, { path: WOFF2, weight: "100 900" }]),
    "woff2",
  );
});

Deno.test("a URL-path src is read from public/, a relative one from the project", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-localfont-" });
  const cwd = Deno.cwd();
  try {
    await Deno.mkdir(join(dir, "public", "fonts"), { recursive: true });
    await Deno.mkdir(join(dir, "app", "fonts"), { recursive: true });
    await Deno.copyFile(TTF, join(dir, "public", "fonts", "Geist.ttf"));
    await Deno.copyFile(WOFF2, join(dir, "app", "fonts", "Geist.woff2"));
    Deno.chdir(dir);
    assertStringIncludes(register({ src: "/fonts/Geist.ttf" }).fallback ?? "", GEIST_SANS);
    assertStringIncludes(register({ src: "./fonts/Geist.woff2" }).fallback ?? "", WOFF2_SANS);
    assertEquals(register({ src: "./fonts/Missing.woff2" }).fallback, null);
  } finally {
    Deno.chdir(cwd);
    await removeTempDir(dir);
  }
});

Deno.test("fontFileMetrics: the head/hhea numbers fontkit reports; garbage → null", async () => {
  for (const file of [TTF, WOFF, WOFF2]) {
    const m = fontFileMetrics(await Deno.readFile(file));
    assert(m, file);
    assertEquals([m.unitsPerEm, m.ascent, m.descent, m.lineGap], [1000, 1005, -295, 0]);
    assert(m.azAvgWidth && m.azAvgWidth > 0);
  }
  assertEquals(fontFileMetrics(new TextEncoder().encode("not a font file at all")), null);
  assertEquals(fontFileMetrics(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0])), null);
});

Deno.test("no sample-text width (a missing character) → size-adjust 100%, as in Next", () => {
  const o = localFallbackOverrides(
    { unitsPerEm: 1000, ascent: 1005, descent: -295, lineGap: 20, azAvgWidth: undefined },
    "Arial",
  );
  assertEquals(o, {
    fallbackFont: "Arial",
    sizeAdjust: "100.00%",
    ascentOverride: "100.50%",
    descentOverride: "29.50%",
    lineGapOverride: "2.00%",
  });
});
