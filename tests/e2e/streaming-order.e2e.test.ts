// Real-browser e2e for examples/streaming — the ORDERING guarantees of out-of-order
// streaming SSR, which the presence-only streaming.e2e.test.ts doesn't assert:
//   • the shell (with its Suspense fallback) is flushed BEFORE the resolved boundary —
//     proven at the wire level by reading the response stream in chunks (the server waits
//     400 ms between the two writes, so they can't coalesce into one buffered document); and
//   • in the browser the resolved content is swapped IN PLACE of the fallback (the inline
//     __dnxSwap runtime replaces it, it doesn't append a second copy).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert } from "@std/assert";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const EXAMPLE = new URL("../../examples/streaming", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/streaming — shell flushes before the boundary, which swaps in place",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step("/stream flushes the shell + fallback before the resolved boundary", async () => {
      // Read the raw response stream in arrival order. The shell (heading + the
      // `data-fallback` skeleton) is written first; the resolved "Report ready" is written
      // only after a 400 ms delay — so there is a chunk boundary between them, and the
      // resolved text can never appear in the same first chunk as the fallback. A buffered
      // (non-streaming) document would deliver both at once and fail this.
      const res = await fetch(server.origin + "/stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      let shellBeforeResolved = false;
      let resolvedSeen = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        if (
          !resolvedSeen && acc.includes("Streamed SSR") && acc.includes("data-fallback") &&
          !acc.includes("Report ready")
        ) {
          shellBeforeResolved = true; // shell + fallback delivered, resolved content not yet
        }
        if (acc.includes("Report ready")) {
          resolvedSeen = true;
          break;
        }
      }
      await reader.cancel();
      assert(shellBeforeResolved, "the shell + fallback must be delivered before the boundary");
      assert(resolvedSeen, "the resolved boundary must stream in after the shell");
    });

    await t.step("the browser swaps the resolved content IN PLACE of the fallback", async () => {
      const page = await browser.newPage(server.origin + "/stream");
      // The shell (and its fallback) is interactive immediately; the boundary resolves later.
      await pollFor(page, "document.body.textContent.includes('Report ready')");
      // The swap replaced the fallback — it did not leave it behind or append a second copy.
      const fallbacks = await page.evaluate(
        "document.querySelectorAll('[data-fallback]').length",
      );
      assert(
        Number(fallbacks) === 0,
        `the fallback must be gone after the swap, found ${fallbacks}`,
      );
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
