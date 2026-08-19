// Real-browser e2e for examples/streaming: the buffered dashboard resolves its
// async Server Components in the delivered HTML, and the /stream route streams its
// shell first then swaps the resolved Suspense boundary into place out of order
// (the inline __dnxSwap runtime running in a real browser).
//
// Opt-in: `deno task test:e2e`.

import { assertStringIncludes } from "@std/assert";
import { launch } from "@astral/astral";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/streaming", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/streaming renders async Server Components and streams a shell",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launch({ headless: true });

  try {
    await t.step("the buffered dashboard shows both resolved widgets", async () => {
      const page = await browser.newPage(server.origin + "/dashboard");
      await page.waitForFunction("document.body.textContent.includes('$48,210')");
      const body = await page.evaluate("document.body.textContent");
      assertStringIncludes(String(body), "1,204");
      await page.close();
    });

    await t.step("/stream swaps in the resolved boundary out of order", async () => {
      const page = await browser.newPage(server.origin + "/stream");
      // The stable shell heading flushes first…
      await page.waitForFunction("document.body.textContent.includes('Streamed SSR')");
      // …then the inline __dnxSwap runtime reveals the resolved boundary, replacing
      // its fallback with the streamed-in content.
      await page.waitForFunction("document.body.textContent.includes('Report ready')");
      const body = await page.evaluate("document.body.textContent");
      assertStringIncludes(String(body), "Report ready");
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
