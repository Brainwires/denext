// React Native mode's embedded fonts (`reactNative.fonts`, src/build/react-native-fonts.ts): the
// files the expo-font config plugin embeds natively, resolved from the project, copied into the
// client output, declared by `@font-face` rules in the SPA shell, and served by the dev server.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  copyReactNativeFonts,
  fontFaceStyle,
  fontFor,
  resolveReactNativeFonts,
} from "../src/build/react-native-fonts.ts";
import { spaShellHtml } from "../src/build/spa/shared.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const spa: DenextConfig = { mode: "spa", spa: { entry: "./index.ts" } };
const PKG = "node_modules/@expo-google-fonts/dm-sans";

async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_rn_fonts_" });
  for (
    const [rel, text] of Object.entries({
      [`${PKG}/package.json`]: JSON.stringify({
        name: "@expo-google-fonts/dm-sans",
        main: "index.js",
      }),
      [`${PKG}/index.js`]: "export {};\n",
      [`${PKG}/400Regular/DMSans_400Regular.ttf`]: "TTF",
      "assets/Mono.woff2": "WOFF2",
    })
  ) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), text);
  }
  return dir;
}

Deno.test("reactNative.fonts: package subpaths and ./ paths resolve; @font-face; copied; served", async () => {
  const dir = await project();
  try {
    const config: DenextConfig = {
      ...spa,
      reactNative: {
        fonts: {
          "DMSans-Regular": "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
          Mono: "./assets/Mono.woff2",
        },
      },
    };
    const fonts = await resolveReactNativeFonts(config, dir);
    assertEquals(fonts.map((f) => [f.family, f.name]), [
      ["DMSans-Regular", "DMSans_400Regular.ttf"],
      ["Mono", "Mono.woff2"],
    ]);
    const style = fontFaceStyle(fonts, "/_denext/client/");
    assertStringIncludes(
      style,
      '@font-face{font-family:"DMSans-Regular";src:url("/_denext/client/fonts/DMSans_400Regular.ttf") format("truetype");font-display:block}',
    );
    assertStringIncludes(style, 'url("/_denext/client/fonts/Mono.woff2") format("woff2")');
    const out = join(dir, "out-client");
    await copyReactNativeFonts(fonts, out);
    assertEquals(await Deno.readTextFile(join(out, "fonts/Mono.woff2")), "WOFF2");
    assertEquals(
      fontFor(fonts, "/_denext/client/fonts/Mono.woff2", "/_denext/client/")?.family,
      "Mono",
    );
    assertEquals(fontFor(fonts, "/_denext/client/fonts/x.ttf", "/_denext/client/"), undefined);
    const html = await spaShellHtml({
      spa: { entry: "./index.ts", head: "<!-- app head -->" },
      scriptSrc: "/_denext/client/index.js",
      reactNativeRootStyle: true,
      headPrefix: style,
    });
    assert(html.indexOf("@font-face") < html.indexOf("<!-- app head -->"), "ahead of spa.head");
    assertEquals(await resolveReactNativeFonts(spa, dir), [], "none without the option");
    await assertRejects(
      () => resolveReactNativeFonts({ ...spa, reactNative: { fonts: { X: "./nope.ttf" } } }, dir),
      Error,
      'reactNative.fonts["X"]',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reactNative.fonts is validated", () => {
  validateDenextConfig({ ...spa, reactNative: { fonts: { A: "./a.ttf" } } });
  assertThrows(
    () => validateDenextConfig({ ...spa, reactNative: { fonts: { A: 1 } as never } }),
    Error,
    "reactNative.fonts",
  );
});
