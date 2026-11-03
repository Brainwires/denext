// Real-browser proof of `<ViewTransition>` on a soft navigation and its `ref` (Chromium has the
// View Transitions API): the layout's crumb boundary persists across the navigation and runs
// `onUpdate` (its text follows the route), the untouched logo boundary runs nothing, and the
// crumb's `ref` holds React's `ViewTransitionInstance`, whose `group.getComputedStyle()` reads
// the boundary's live `::view-transition-group(crumb)` during a transition.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/vt-nav", import.meta.url));

Deno.test({
  name: "e2e: <ViewTransition> onUpdate on a soft navigation, and its ref",
}, async () => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.origin + "/", { waitUntil: "load" });
    await pollFor(page, "(window.__cb ?? []).includes('ref:crumb')");
    assertEquals(
      await page.evaluate("typeof window.__ref.group.getComputedStyle"),
      "function",
      "the ref holds the boundary's ViewTransitionInstance",
    );
    await page.evaluate(
      "window.__noReload = true; document.querySelector('a[href=\"/other\"]').click()",
    );
    await pollFor(page, "!!document.querySelector('[data-testid=other]')");
    await pollFor(page, "(window.__cb ?? []).includes('update:crumb')");
    assertEquals(await page.evaluate("window.__noReload"), true, "a soft navigation");
    assertEquals(
      await page.evaluate("document.querySelector('[data-testid=crumb]').textContent"),
      "at /other",
    );
    assertEquals(
      await page.evaluate("window.__cb"),
      ["ref:crumb", "update:crumb"],
      "only the changed boundary updates; the ref stays attached across the navigation",
    );
    assertEquals(errors, [], "no console errors");
  } finally {
    await browser.close();
    await server.close();
  }
});
