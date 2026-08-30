// next/font compat: local fonts self-host via @font-face; google fonts register
// a stylesheet link; both return a stable {className, style, variable}. No network.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import localFont from "../src/compat/next/font/local.ts";
import {
  googleFontUrl,
  Inter,
  Open_Sans,
  rewriteGoogleFontFaceCss,
} from "../src/compat/next/font/google.ts";
import {
  collectedFontFaces,
  renderFontStyles,
  resetFonts,
  setSelfHostedFonts,
} from "../src/compat/next/font/registry.ts";
import { selfHostFonts } from "../src/build/self-host-fonts.ts";
import { staticExport } from "../src/build/export.ts";
import { join } from "@std/path";
import { walk } from "@std/fs";

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

Deno.test("rewriteGoogleFontFaceCss self-hosts gstatic URLs to local paths", () => {
  const css = `@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/inter/v13/abc.woff2) format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/inter/v13/def.woff2) format('woff2');
}`;
  const { css: out, assets } = rewriteGoogleFontFaceCss(css, "/_denext/fonts/");
  // No remote URLs remain; all point at local files.
  assert(!out.includes("https://fonts.gstatic.com"), "no gstatic URLs remain");
  assertStringIncludes(out, "url(/_denext/fonts/");
  assertStringIncludes(out, ".woff2)");
  assertEquals(assets.length, 2, "two font files to download");
  assert(assets.every((a) => a.url.startsWith("https://fonts.gstatic.com")));
  assert(assets.every((a) => a.filename.endsWith(".woff2")));
  // Deterministic + deduped: rewriting again yields the same filenames.
  const again = rewriteGoogleFontFaceCss(css, "/_denext/fonts/");
  assertEquals(again.assets.map((a) => a.filename), assets.map((a) => a.filename));
});

Deno.test("multi-word Google family exports work (Open_Sans)", () => {
  resetFonts();
  const f = Open_Sans({ weight: "400" });
  assertStringIncludes(f.style.fontFamily, "'Open Sans'");
  assertStringIncludes(renderFontStyles(), "family=Open+Sans");
});

// Build self-hosting: when the build supplies a self-host map, the Google <link>
// is replaced by inline @font-face CSS (local src) — the browser never hits Google.
Deno.test("renderFontStyles substitutes self-hosted CSS for the Google link", () => {
  resetFonts();
  const inter = Inter({ subsets: ["latin"] });
  assert(inter.className.startsWith("__font_Inter_"));
  const url = googleFontUrl("Inter", { subsets: ["latin"] });
  setSelfHostedFonts({ [url]: "@font-face{font-family:Inter;src:url(/_denext/fonts/abc.woff2)}" });
  try {
    const head = renderFontStyles();
    assert(!head.includes("<link"), "the Google <link> is gone");
    assertStringIncludes(head, "/_denext/fonts/abc.woff2"); // local src, inline
    assertStringIncludes(head, "<style data-denext-fonts>");
  } finally {
    setSelfHostedFonts({}); // reset global
    resetFonts();
  }
});

Deno.test("renderFontStyles keeps a Google <link> for a font not in the self-host map", () => {
  resetFonts();
  Inter({ subsets: ["latin"] });
  setSelfHostedFonts({ "https://fonts.googleapis.com/css2?family=Other": "x" });
  try {
    assertStringIncludes(renderFontStyles(), '<link rel="stylesheet"'); // fell back
  } finally {
    setSelfHostedFonts({});
    resetFonts();
  }
});

Deno.test("rewriteGoogleFontFaceCss `subsets` keeps only the requested subset's faces", () => {
  const css = `/* cyrillic */
@font-face { font-family:'Inter'; src: url(https://fonts.gstatic.com/s/inter/cyr.woff2) format('woff2'); unicode-range: U+0400-04FF; }
/* latin */
@font-face { font-family:'Inter'; src: url(https://fonts.gstatic.com/s/inter/lat.woff2) format('woff2'); unicode-range: U+0000-00FF; }`;
  const { css: out, assets } = rewriteGoogleFontFaceCss(css, "/_denext/fonts/", ["latin"]);
  assertEquals(assets.length, 1, "only the latin file is self-hosted");
  assertStringIncludes(out, "/* latin */");
  assert(!out.includes("cyrillic"), "the cyrillic face is dropped");
  // No subsets → all faces kept (both files).
  assertEquals(rewriteGoogleFontFaceCss(css, "/_denext/fonts/").assets.length, 2);
});

Deno.test("a preload font emits <link rel=preload> for its self-hosted files", () => {
  resetFonts();
  const url = googleFontUrl("Inter", { subsets: ["latin"] });
  Inter({ subsets: ["latin"], preload: true });
  setSelfHostedFonts({
    [url]: "@font-face{font-family:Inter;src:url(/_denext/fonts/abc.woff2) format('woff2')}",
  });
  try {
    const head = renderFontStyles();
    assertStringIncludes(head, '<link rel="preload" href="/_denext/fonts/abc.woff2" as="font"');
    assertStringIncludes(head, "crossorigin");
    // The preload precedes the <style> so the fetch starts before parsing the face.
    assert(head.indexOf('rel="preload"') < head.indexOf("<style"), head);
  } finally {
    setSelfHostedFonts({});
    resetFonts();
  }
});

Deno.test("a non-preload font emits no preload link", () => {
  resetFonts();
  const url = googleFontUrl("Inter", { subsets: ["latin"] });
  Inter({ subsets: ["latin"] }); // preload not requested
  setSelfHostedFonts({ [url]: "@font-face{src:url(/_denext/fonts/abc.woff2)}" });
  try {
    assert(!renderFontStyles().includes('rel="preload"'));
  } finally {
    setSelfHostedFonts({});
    resetFonts();
  }
});

Deno.test("selfHostFonts is best-effort: a fetch failure is skipped, never thrown", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const manifest = await selfHostFonts(
      ["https://fonts.googleapis.com/css2?family=Inter"],
      await Deno.makeTempDir({ prefix: "denext-fonts-" }),
    );
    assertEquals(manifest, {}); // nothing self-hosted → all fall back to runtime link
  } finally {
    globalThis.fetch = origFetch;
    console.warn = warn;
  }
});

Deno.test("staticExport self-hosts next/font/google — no runtime Google <link>", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_font_export_" });
  const origFetch = globalThis.fetch;
  // Stub Google's endpoints: the css2 stylesheet → an @font-face referencing a gstatic
  // woff2, and that woff2 → bytes. Anything else falls through to the real fetch.
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("fonts.googleapis.com")) {
      return Promise.resolve(
        new Response(
          `/* latin */\n@font-face{font-family:'Inter';font-style:normal;font-weight:400;` +
            `src:url(https://fonts.gstatic.com/s/inter/v1/sample.woff2) format('woff2')}`,
          { status: 200, headers: { "content-type": "text/css" } },
        ),
      );
    }
    if (u.includes("fonts.gstatic.com")) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const root = new URL("../", import.meta.url).pathname;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
          "next/font/google": `${root}src/compat/next/font/google.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `import { Inter } from "next/font/google";\n` +
        `const inter = Inter({ subsets: ["latin"] });\n` +
        `export default function Page(){ return <main className={inter.className}>FONT_PAGE</main>; }\n`,
    );

    const result = await staticExport(dir);
    const html = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(html, "@font-face"); // inlined local face, not a Google <link>
    assertStringIncludes(html, "/_denext/fonts/");
    assert(
      !html.includes("fonts.googleapis.com"),
      "a self-hosted export must not emit a runtime Google stylesheet <link>",
    );
    // The font file physically landed where a static host serves /_denext/fonts.
    let woff2 = 0;
    for await (const e of walk(join(result.outDir, "_denext", "fonts"), { includeDirs: false })) {
      if (e.isFile) woff2++;
    }
    assert(woff2 >= 1, "a self-hosted font file was emitted under out/_denext/fonts");
  } finally {
    globalThis.fetch = origFetch;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
