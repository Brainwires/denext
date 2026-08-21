// Real-browser e2e for examples/image: loads the page in headless Chromium and
// confirms the optimized <img> actually decodes — i.e. the browser fetched
// /_denext/image, got a valid WebP, and the image has real intrinsic dimensions.
//
// Opt-in: `deno task test:e2e`.

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/image", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/image loads an optimized WebP via /_denext/image",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage(server.origin + "/");

    await t.step("the priority image points at the optimizer and carries a srcset", async () => {
      const src = await page.evaluate(
        "document.querySelector('img') ? document.querySelector('img').getAttribute('src') : ''",
      );
      assertStringIncludes(String(src), "/_denext/image?url=");
      const srcset = await page.evaluate(
        "document.querySelector('img') ? (document.querySelector('img').getAttribute('srcset') || '') : ''",
      );
      assertStringIncludes(String(srcset), "128w");
    });

    await t.step("the optimized image decodes (non-zero intrinsic size)", async () => {
      // Wait for the first <img> to finish loading with real pixels.
      await page.waitForFunction(
        "(() => { const i = document.querySelector('img'); return !!i && i.complete && i.naturalWidth > 0; })()",
      );
      const w = await page.evaluate("document.querySelector('img').naturalWidth");
      assert(Number(w) > 0, "the optimized image must decode to a non-zero width");
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
