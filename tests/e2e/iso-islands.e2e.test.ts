// Real-browser proof of per-island hydration on an isomorphic (non-Flight) route: the page
// hydrates while its `client:*` islands keep their server DOM, inert, and their code out of the
// page bundle (each island's module is a chunk of its own, not loaded). The `client:interaction`
// island loads and hydrates on its first click and that same click updates it; the
// `client:visible` one below the fold neither loads nor hydrates until something wakes it (here a
// click on its server DOM, which is held and replayed), then adopts the server's node rather than
// replacing it. Both read the page's context and their props.
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
    assertEquals(await page.evaluate("window.__loaded ?? []"), [], "no island's code loaded");
    await page.evaluate("window.__far = document.querySelector('[data-testid=far]')");

    // client:interaction: one click loads and hydrates the island and reaches its handler.
    await page.evaluate("document.querySelector('[data-testid=tap]').click()");
    await pollFor(page, `${text("tap")} === "tap dark 1"`);
    assertEquals(await page.evaluate("window.__hydrated"), ["tap"], "only the tapped island");
    assertEquals(await page.evaluate("window.__loaded"), ["counter"], "only its chunk loaded");

    // The page stays interactive while the far island stays unloaded and inert.
    // (The poll above may have clicked more than once before the page hydrated: count on.)
    const clicks = Number(String(await page.evaluate(text("page"))).split(" ")[1]);
    await page.evaluate("document.querySelector('[data-testid=page]').click()");
    await pollFor(page, `${text("page")} === "page ${clicks + 1}"`);
    assertEquals(await page.evaluate(text("far")), "far dark 5", "inert below the fold");
    assertEquals(await page.evaluate("window.__loaded"), ["counter"], "far's chunk not loaded");

    // client:visible, woken early by an event (selective hydration): a click on its server DOM
    // loads and hydrates it on the server's node, and the click, held meanwhile, is replayed.
    await page.evaluate("document.querySelector('[data-testid=far]').click()");
    await pollFor(page, "(window.__hydrated ?? []).includes('far')");
    assertEquals(await page.evaluate("window.__loaded"), ["counter", "far"]);
    assert(
      await page.evaluate("window.__far === document.querySelector('[data-testid=far]')"),
      "the server's node was adopted",
    );
    await pollFor(page, `${text("far")} === "far dark 6"`); // context and props reached it
    await page.evaluate("document.querySelector('[data-testid=far]').click()");
    await pollFor(page, `${text("far")} === "far dark 7"`);
    assertEquals(errors, [], "no console errors (no hydration mismatch)");
  } finally {
    await browser.close();
    await server.close();
  }
});
