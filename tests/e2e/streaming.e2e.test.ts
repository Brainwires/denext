// Real-browser e2e for examples/streaming. The buffered dashboard resolves its
// async Server Components in the delivered HTML, and the /stream route flushes its
// shell + Suspense fallback to the browser immediately. (The out-of-order swap of
// the resolved boundary is verified at the byte level in
// tests/integration/example-streaming.test.ts.)
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

    await t.step("the /stream route renders its streamed shell in the browser", async () => {
      // The shell heading is stable — it's part of the first flushed chunk and is
      // never swapped, so it's a race-free signal that streaming SSR reached and
      // rendered in a real browser. (The out-of-order boundary swap itself is
      // byte-verified in tests/integration/example-streaming.test.ts.)
      const page = await browser.newPage(server.origin + "/stream");
      await page.waitForFunction("document.body.textContent.includes('Streamed SSR')");
      const body = await page.evaluate("document.body.textContent");
      assertStringIncludes(String(body), "Streamed SSR");
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
