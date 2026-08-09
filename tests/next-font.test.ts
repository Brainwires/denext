// next/font compat: local fonts self-host via @font-face; google fonts register
// a stylesheet link; both return a stable {className, style, variable}. No network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import localFont from "../src/compat/next/font/local.ts";
import { googleFontUrl, Inter, Open_Sans } from "../src/compat/next/font/google.ts";
import {
  collectedFontFaces,
  renderFontStyles,
  resetFonts,
} from "../src/compat/next/font/registry.ts";

Deno.test("localFont emits @font-face + a class, returns a handle", () => {
  resetFonts();
  const f = localFont({ src: "/fonts/MySans.woff2", variable: "--font-my", display: "swap" });
  assert(f.className.startsWith("__font_"));
  assertStringIncludes(f.style.fontFamily, "dnx-local-");
  assert(f.variable.endsWith("_var"));
  const css = collectedFontFaces().join("\n");
  assertStringIncludes(css, "@font-face");
  assertStringIncludes(css, "format('woff2')");
  assertStringIncludes(css, "url('/fonts/MySans.woff2')");
  assertStringIncludes(css, "--font-my:");
});

Deno.test("localFont is deterministic (same options → same className)", () => {
  resetFonts();
  const a = localFont({ src: "/fonts/X.woff2" });
  const b = localFont({ src: "/fonts/X.woff2" });
  assertEquals(a.className, b.className);
});

Deno.test("googleFontUrl builds a css2 URL with weights", () => {
  assertEquals(
    googleFontUrl("Inter", { weight: ["400", "700"] }),
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
  );
  assertEquals(
    googleFontUrl("Open Sans", { weight: "400", style: ["normal", "italic"] }),
    "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;1,400&display=swap",
  );
});

Deno.test("Google font export registers a stylesheet link + class", () => {
  resetFonts();
  const inter = Inter({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-inter" });
  assert(inter.className.startsWith("__font_Inter_"));
  assert(inter.variable.endsWith("_var"));
  const head = renderFontStyles();
  assertStringIncludes(head, '<link rel="stylesheet"');
  assertStringIncludes(head, "family=Inter");
  assertStringIncludes(head, "<style data-denext-fonts>");
});

Deno.test("multi-word Google family exports work (Open_Sans)", () => {
  resetFonts();
  const f = Open_Sans({ weight: "400" });
  assertStringIncludes(f.style.fontFamily, "'Open Sans'");
  assertStringIncludes(renderFontStyles(), "family=Open+Sans");
});
