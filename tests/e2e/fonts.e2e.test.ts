// Networked e2e for examples/fonts: `denext build` self-hosts the Inter font from
// next/font/google — it discovers the font by executing the layout module,
// downloads the CSS + files from Google, rewrites the @font-face `src` to local
// paths, and emits the files under client/_fonts. This validates that whole
// networked build path, plus that the emitted files serve over HTTP.
//
// (The render-time substitution — swapping the Google <link> for the local inline
// @font-face CSS — is covered by unit tests in tests/next-font.test.ts. It can't be
// re-validated in THIS harness because build + serve share one process, where the
// layout's module-top-level `Inter()` runs once and isn't re-registered at render;
// a real deployment runs `build` and `start` as separate processes.)
//
// Opt-in + NETWORK-REQUIRED (build fetches fonts.googleapis.com): `deno task
// test:e2e`. If Google is unreachable the build falls back to a runtime <link>
// (empty font manifest) and the test skips its self-host assertions.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/fonts", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/fonts self-hosts next/font/google at build",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = await buildAndServe(EXAMPLE);
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(EXAMPLE, ".denext", "manifest.json")),
    ) as { fonts?: Record<string, string> };
    const fonts = manifest.fonts ?? {};

    if (Object.keys(fonts).length === 0) {
      console.warn(
        "e2e: build produced no self-hosted fonts (Google unreachable / offline?) — " +
          "skipping self-host assertions.",
      );
      return;
    }

    // Discovery + download + rewrite: each entry is a Google URL → local @font-face
    // CSS whose `src` points at /_denext/fonts (not gstatic).
    const [googleUrl, css] = Object.entries(fonts)[0];
    assertStringIncludes(googleUrl, "fonts.googleapis.com");
    assertStringIncludes(css, "@font-face");
    assertStringIncludes(css, "/_denext/fonts/");
    assert(!css.includes("gstatic.com"), "the @font-face src is local, not gstatic");

    // Emit: the font files landed under client/_fonts with real bytes.
    const fontsDir = join(EXAMPLE, ".denext", "client", "_fonts");
    const files = [...Deno.readDirSync(fontsDir)].filter((e) => e.isFile);
    assert(files.length > 0, "at least one font file was emitted");
    const first = await Deno.readFile(join(fontsDir, files[0].name));
    assert(first.byteLength > 0, "the emitted font file has content");

    // Serve: the emitted files are served (200 + immutable) at /_denext/fonts/*.
    const fontRes = await fetch(server.origin + "/_denext/fonts/" + files[0].name);
    assertEquals(fontRes.status, 200);
    assert((await fontRes.arrayBuffer()).byteLength > 0);
    assertStringIncludes(fontRes.headers.get("cache-control") ?? "", "immutable");
  } finally {
    await server.close();
  }
});
