// Real-browser proof that a soft navigation streams its deferred values per boundary, as a
// document load does: navigating to a route whose client component `<Await>`s a fast and a slow
// deferred value renders the route at once with both fallbacks, reveals the fast value while the
// slow one is still loading, then the slow one — with no full reload.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/soft-nav", import.meta.url));
const has = (id: string) => `!!document.querySelector('[data-testid=${id}]')`;

Deno.test({
  name: "e2e: a soft navigation streams its deferred values per boundary",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(server.origin + "/");
    const errors = collectConsoleErrors(page);
    await page.waitForFunction("!!document.querySelector('[data-testid=home]')");
    // Hydrated: the layout's client counter responds.
    const counter = await page.$("[data-testid=navcount]");
    assert(counter);
    await counter.click();
    await pollFor(
      page,
      "document.querySelector('[data-testid=navcount]').textContent.includes('count: 1')",
    );
    await page.evaluate("window.__noReload = true");

    await page.evaluate(
      "Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/deferred').click()",
    );
    // The route commits at its payload: both boundaries show their fallbacks.
    await pollFor(page, `${has("deferred")} && ${has("slow-wait")}`);
    // The fast value arrives while the slow one is still loading.
    await pollFor(page, has("fast"));
    assert(
      await page.evaluate(`${has("slow-wait")} && !${has("slow")}`),
      "the fast boundary revealed before the slow value arrived",
    );
    await pollFor(page, has("slow"));
    assert(
      await page.evaluate(
        "document.querySelector('[data-testid=slow]').textContent === 'slow value'",
      ),
    );
    assert(await page.evaluate("window.__noReload === true"), "no full reload");
    assert(errors.length === 0, `no console errors: ${errors.join("\n")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
