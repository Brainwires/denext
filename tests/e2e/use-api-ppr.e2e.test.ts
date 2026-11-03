// Real-browser E2E: `useApi({ suspense: true })` on a Cache Components isomorphic route is
// seeded from the PPR shell. The fixture's page is cacheable (`revalidate`) under
// `cacheComponents: true`, so it is served from a cached static shell — first a MISS (prerendered
// now), then a HIT (the cached shell). On both, the first paint already shows the API's data,
// and the page hydrates (its counter works) without a single request to `/api/*` or the batch
// endpoint: every request the page makes is observed through CDP's Network domain.
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/use-api-ppr", import.meta.url));

Deno.test({
  name: "e2e: useApi on a cacheComponents isomorphic route hydrates from the PPR shell, no fetch",
}, async () => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    for (const expected of ["MISS", "HIT"]) {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      // deno-lint-ignore no-explicit-any
      const cdp = page.unsafelyGetCelestialBindings() as any;
      const requested: string[] = [];
      let cacheState: string | undefined;
      cdp.addEventListener(
        "Network.requestWillBeSent",
        (e: { detail: { request: { url: string } } }) => void requested.push(e.detail.request.url),
      );
      cdp.addEventListener(
        "Network.responseReceived",
        (e: { detail: { type: string; response: { headers: Record<string, string> } } }) => {
          if (e.detail.type !== "Document") return;
          const headers = e.detail.response.headers;
          cacheState = headers["x-denext-cache"] ?? headers["X-Denext-Cache"];
        },
      );
      await cdp.Network.enable({});
      await page.goto(server.origin + "/", { waitUntil: "load" });
      assertEquals(cacheState, expected, "served from the PPR shell");
      assertEquals(
        await page.evaluate(`document.querySelector('[data-testid="greeting"]').textContent`),
        "world from the shell",
      );
      // Hydrated: the counter responds.
      await page.evaluate(`document.querySelector('[data-testid="counter"]').click()`);
      await pollFor(
        page,
        `document.querySelector('[data-testid="counter"]').textContent.includes("count 1")`,
      );
      // Still the seeded data, and no request for it.
      assertEquals(
        await page.evaluate(`document.querySelector('[data-testid="greeting"]').textContent`),
        "world from the shell",
      );
      const apiCalls = requested.filter((u) => {
        const { pathname } = new URL(u);
        return pathname.startsWith("/api/") || pathname === "/_denext/api-batch";
      });
      assertEquals(apiCalls, [], `${expected}: no /api fetch on mount`);
      assert(requested.length > 0, "the page's own requests were observed");
      assertEquals(errors, [], `${expected}: no console errors (no hydration mismatch)`);
      await page.close();
    }
    // The cached shell document itself carries the data (first paint) and its seed.
    const html = await (await fetch(server.origin + "/")).text();
    assertStringIncludes(html, "world from the shell");
    assertStringIncludes(html, 'id="__denext_state"');
  } finally {
    await browser.close();
    await server.close();
  }
});
