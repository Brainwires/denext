// Real-browser proof of per-island hydration on an isomorphic (non-Flight) route: the page
// hydrates while its `client:*` islands keep their server DOM, inert. The `client:interaction`
// island hydrates on its first click and that same click updates it; the `client:visible` one
// hydrates when it scrolls into view, adopting the server's node rather than replacing it.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/iso-islands", import.meta.url));
const text = (id: string) => `document.querySelector('[data-testid=${id}]').textContent`;

Deno.test({
  name: "e2e: client:* islands hydrate on their own on an isomorphic route",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.origin + "/", { waitUntil: "load" });
    assertEquals(
      await page.evaluate("document.getElementById('__denext_flight')"),
      null,
      "an isomorphic route (no Flight payload)",
    );
    // The page hydrated: its own button responds.
    await pollFor(
      page,
      `(document.querySelector('[data-testid=page]').click(), ${text("page")} === "page 1")`,
    );
    assertEquals(await page.evaluate("window.__hydrated ?? []"), [], "no island hydrated yet");
    await page.evaluate("window.__far = document.querySelector('[data-testid=far]')");

    // client:interaction: one click hydrates the island and reaches its handler.
    await page.evaluate("document.querySelector('[data-testid=tap]').click()");
    await pollFor(page, `${text("tap")} === "tap 1"`);
    assertEquals(await page.evaluate("window.__hydrated"), ["tap"], "only the tapped island");

    // client:visible: hydrates once scrolled into view, on the server's node.
    await page.evaluate("document.querySelector('[data-testid=far]').scrollIntoView()");
    await pollFor(page, "(window.__hydrated ?? []).includes('far')");
    assert(
      await page.evaluate("window.__far === document.querySelector('[data-testid=far]')"),
      "the server's node was adopted",
    );
    await page.evaluate("document.querySelector('[data-testid=far]').click()");
    await pollFor(page, `${text("far")} === "far 1"`);
    assertEquals(errors, [], "no console errors (no hydration mismatch)");
  } finally {
    await browser.close();
    await server.close();
  }
});
