// Real-browser e2e for the App Router runtime boundaries — behavior only a live browser
// proves (the in-process tests can't drive a click-triggered render throw + reset):
//   • a render error in a page segment is caught by app/error.tsx IN PLACE — the layout
//     shell survives — and its reset() re-renders the segment successfully; and
//   • a notFound() route serves the not-found.tsx UI with a 404 on a hard load, and shows
//     it on a soft navigation without a full page reload.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = new URL("./fixtures/error-boundary", import.meta.url).pathname;

Deno.test({
  name: "e2e: error.tsx catches a render throw in place (+reset); notFound serves the 404 UI",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();

  try {
    await t.step(
      "a render error is caught by error.tsx; the layout survives; reset recovers",
      async () => {
        const page = await browser.newPage(server.origin + "/");
        await page.waitForFunction("!!document.querySelector('[data-testid=boom]')");

        // Flip the island into a render-time throw.
        const boom = await page.$("[data-testid=boom]");
        assert(boom, "the boom button exists");
        await boom.click();

        // error.tsx renders in place of the throwing segment, carrying the thrown message.
        await pollFor(page, "!!document.querySelector('[data-testid=error]')");
        const msg = await page.evaluate(
          "document.querySelector('[data-testid=error-message]').textContent",
        );
        assertStringIncludes(String(msg), "kaboom");
        // The segment's content was replaced, but the root layout's shell survived.
        assert(
          await page.evaluate("!document.querySelector('[data-testid=boom]')"),
          "the throwing segment was replaced by the fallback",
        );
        assert(
          await page.evaluate("!!document.querySelector('[data-testid=shell]')"),
          "the layout shell survived the error",
        );

        // reset() re-renders the segment: the island is back and the fallback is gone.
        const reset = await page.$("[data-testid=reset]");
        assert(reset, "the reset button exists");
        await reset.click();
        await pollFor(page, "!!document.querySelector('[data-testid=boom]')");
        assert(
          await page.evaluate("!document.querySelector('[data-testid=error]')"),
          "the fallback cleared after reset",
        );
        await page.close();
      },
    );

    await t.step("a notFound() route serves the not-found UI with a 404 status", async () => {
      const res = await fetch(server.origin + "/gone");
      assertEquals(res.status, 404);
      assertStringIncludes(await res.text(), "Nothing here");
    });

    await t.step(
      "soft-navigating to the notFound route shows not-found, no full reload",
      async () => {
        const page = await browser.newPage(server.origin + "/");
        await page.waitForFunction("!!document.querySelector('[data-testid=home]')");
        await page.evaluate("window.__noReload = true"); // a full reload would clear this
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.includes('go missing')).click()",
        );
        await pollFor(page, "!!document.querySelector('[data-testid=notfound]')");
        assert(
          await page.evaluate("window.__noReload === true"),
          "the soft navigation must not have triggered a full page reload",
        );
        await page.close();
      },
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
