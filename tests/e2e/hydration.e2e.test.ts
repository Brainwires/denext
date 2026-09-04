// Real-browser end-to-end test: builds examples/hello, serves the production
// build, and drives it with a headless Chromium (via astral). This exercises the
// full SSR -> hydration round-trip that the in-memory FakeNode reconciler tests
// cannot: real event wiring, real client navigation, and a code-split
// `dynamic({ ssr: false })` chunk fetched and mounted in the browser.
//
// Opt-in: run with `deno task test:e2e`. astral downloads Chromium on first run,
// so this is intentionally excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import type { Page } from "@astral/astral";
import {
  assertNoConsoleErrors,
  buildAndServe,
  clickCounterAndExpectOne,
  clickLinkByText,
  collectConsoleErrors,
  launchBrowser,
  type RunningServer,
} from "./harness.ts";

const EXAMPLE = new URL("../../examples/hello", import.meta.url).pathname;

async function stepServerHtml(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/")).text();
  assertStringIncludes(html, "server-rendered (not yet hydrated)");
  assert(
    !html.includes('data-testid="island"'),
    "the ssr:false island must not be in SSR HTML",
  );
}

async function stepHydrationMountsIsland(page: Page): Promise<void> {
  await page.waitForFunction(
    "!!document.querySelector('.on') && !!document.querySelector('[data-testid=\"island\"]')",
  );
  const status = await page.evaluate(
    "document.querySelector('.on') ? document.querySelector('.on').textContent : ''",
  );
  assertStringIncludes(String(status), "hydrated");
  const island = await page.evaluate(
    "document.querySelector('[data-testid=\"island\"]').textContent",
  );
  assertStringIncludes(String(island), "Client-only island");
}

async function stepLinkSoftNav(page: Page): Promise<void> {
  // Mark the window; a full reload would wipe this flag.
  await page.evaluate("window.__denextNoReload = true");
  await clickLinkByText(page, "About");
  await page.waitForFunction("location.pathname === '/about'");
  const survived = await page.evaluate("window.__denextNoReload === true");
  assert(survived, "client navigation must not trigger a full page reload");
}

async function stepReconcileInPlace(page: Page): Promise<void> {
  // Tag a layout DOM node (the footer, shared by every route). A reconcile-in-
  // place nav patches the existing node so the marker survives; the old
  // innerHTML-swap remount would replace it with a fresh node and lose it.
  await page.evaluate("document.querySelector('.foot').__denextMark = 'kept'");
  await clickLinkByText(page, "Home");
  await page.waitForFunction("location.pathname === '/'");
  const kept = await page.evaluate(
    "document.querySelector('.foot') && document.querySelector('.foot').__denextMark === 'kept'",
  );
  assert(kept, "the shared layout node must be reused across soft nav (reconcile-in-place)");
}

Deno.test({
  name: "e2e: examples/hello builds, hydrates, is interactive, and code-splits an ssr:false island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step(
      "server HTML is pre-hydration and omits the client-only island",
      () => stepServerHtml(server),
    );

    const page = await browser.newPage(server.origin + "/");
    // Collect any console errors during the session (a hydration crash surfaces here).
    const consoleErrors = collectConsoleErrors(page);

    await t.step(
      "hydration flips the status flag and mounts the ssr:false island chunk",
      () => stepHydrationMountsIsland(page),
    );
    await t.step(
      "the counter button is interactive after hydration",
      () => clickCounterAndExpectOne(page),
    );
    await t.step(
      "clicking a <Link> navigates client-side (SPA, no full reload)",
      () => stepLinkSoftNav(page),
    );
    await t.step(
      "soft nav reconciles in place — shared layout DOM is reused, not remounted",
      () => stepReconcileInPlace(page),
    );
    await t.step(
      "no console errors were logged during hydration and navigation",
      () => assertNoConsoleErrors(consoleErrors),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
