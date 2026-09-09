// Real-browser e2e for client-side (soft) navigation — behavior only a live browser proves:
//   • a layout-owned client island keeps its state across a soft nav (the page slot swaps,
//     the layout is NOT remounted, and there is no full page reload);
//   • a soft nav into an ASYNC segment lands on its resolved content with the layout intact
//     (denext's isomorphic nav buffers the server render — it does not stream a loading.tsx
//     fallback on a soft nav, unlike Next; the content swaps in once resolved); and
//   • history back/forward restores the right page with the layout state intact.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = new URL("./fixtures/soft-nav", import.meta.url).pathname;

const clickLink = (href: string) =>
  `Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '${href}').click()`;

Deno.test({
  name: "e2e: soft navigation preserves layout state, buffers an async segment, restores on back",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  const page = await browser.newPage(server.origin + "/");

  try {
    await t.step("the layout island's state survives a soft nav to another page", async () => {
      await page.waitForFunction("!!document.querySelector('[data-testid=home]')");
      await page.evaluate("window.__noReload = true"); // a full reload would clear this
      // Advance the layout-owned counter to 2.
      const counter = await page.$("[data-testid=navcount]");
      assert(counter, "the nav counter exists");
      await counter.click();
      await counter.click();
      await pollFor(
        page,
        "document.querySelector('[data-testid=navcount]').textContent.includes('count: 2')",
      );

      await page.evaluate(clickLink("/other"));
      await pollFor(page, "!!document.querySelector('[data-testid=other]')");
      // The page slot swapped, but the layout island kept its state and nothing reloaded.
      assert(
        await page.evaluate(
          "document.querySelector('[data-testid=navcount]').textContent.includes('count: 2')",
        ),
        "the layout counter survived the navigation",
      );
      assert(await page.evaluate("window.__noReload === true"), "the nav did not full-reload");
      assert(
        await page.evaluate("!document.querySelector('[data-testid=home]')"),
        "the home slot was replaced",
      );
    });

    await t.step(
      "a soft nav into an async segment lands on resolved content, layout intact",
      async () => {
        assert(
          await page.evaluate("!document.querySelector('[data-testid=slow]')"),
          "not on /slow yet",
        );
        await page.evaluate(clickLink("/slow"));
        // denext buffers the async server render, then swaps in the resolved content (no
        // streamed loading state on a soft nav — see the header note).
        await pollFor(page, "!!document.querySelector('[data-testid=slow]')");
        assert(await page.evaluate("location.pathname === '/slow'"), "the URL advanced to /slow");
        // Still the same document: the layout counter and the no-reload sentinel survived.
        assert(
          await page.evaluate(
            "document.querySelector('[data-testid=navcount]').textContent.includes('count: 2')",
          ),
          "the layout counter survived the async nav too",
        );
        assert(
          await page.evaluate("window.__noReload === true"),
          "the async nav did not full-reload",
        );
      },
    );

    await t.step("history back restores the previous page with layout state intact", async () => {
      await page.evaluate("history.back()");
      await pollFor(page, "!!document.querySelector('[data-testid=other]')");
      const count = await page.evaluate(
        "document.querySelector('[data-testid=navcount]').textContent",
      );
      assertStringIncludes(String(count), "count: 2");
      assert(
        await page.evaluate("window.__noReload === true"),
        "back navigation did not full-reload",
      );
    });
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});
