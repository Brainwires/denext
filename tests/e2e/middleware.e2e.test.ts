// Real-browser e2e for middleware.ts (examples/hello): a legacy path is redirected before
// routing, and a normal response carries the header the middleware tags on. The redirect is
// asserted both at the wire level (308 + Location, deterministic) and in the browser (the
// address bar and the /about content after navigating to the old path).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const EXAMPLE = new URL("../../examples/hello", import.meta.url).pathname;

Deno.test({
  name: "e2e: middleware redirects a legacy path (308) and tags a response header",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step(
      "the wire: /old-about is a 308 to /about, and / carries x-powered-by",
      async () => {
        const redirect = await fetch(server.origin + "/old-about", { redirect: "manual" });
        assertEquals(redirect.status, 308);
        assertEquals(new URL(redirect.headers.get("location")!, server.origin).pathname, "/about");
        await redirect.body?.cancel();

        const ok = await fetch(server.origin + "/");
        assertEquals(ok.headers.get("x-powered-by"), "denext");
        await ok.body?.cancel();
      },
    );

    await t.step("the browser: navigating to /old-about lands on /about", async () => {
      const page = await browser.newPage(server.origin + "/old-about");
      // The middleware redirect resolves before the page renders — the browser ends on /about.
      await pollFor(page, "location.pathname === '/about'");
      await page.waitForFunction("document.body.textContent.includes('About denext')");
      assertStringIncludes(
        String(await page.evaluate("document.body.textContent")),
        "About denext",
      );
      assert(await page.evaluate("location.pathname === '/about'"), "the address bar shows /about");
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
