// Real-browser end-to-end test: builds examples/hello, serves the production
// build, and drives it with a headless Chromium (via astral). This exercises the
// full SSR -> hydration round-trip that the in-memory FakeNode reconciler tests
// cannot: real event wiring, real client navigation, and a code-split
// `dynamic({ ssr: false })` chunk fetched and mounted in the browser.
//
// Opt-in: run with `deno task test:e2e`. astral downloads Chromium on first run,
// so this is intentionally excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/hello", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/hello builds, hydrates, is interactive, and code-splits an ssr:false island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step("server HTML is pre-hydration and omits the client-only island", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "server-rendered (not yet hydrated)");
      assert(
        !html.includes('data-testid="island"'),
        "the ssr:false island must not be in SSR HTML",
      );
    });

    const page = await browser.newPage(server.origin + "/");

    // Collect any console errors during the session (a hydration crash surfaces here).
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const detail = (e as any).detail;
      if (detail?.type === "error") consoleErrors.push(String(detail.text ?? ""));
    });

    await t.step(
      "hydration flips the status flag and mounts the ssr:false island chunk",
      async () => {
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
      },
    );

    await t.step("the counter button is interactive after hydration", async () => {
      const button = await page.$("button");
      assert(button, "counter button should exist");
      await button.click();
      const label = await page.evaluate(
        "document.querySelector('button') ? document.querySelector('button').textContent : ''",
      );
      assertStringIncludes(String(label), "Clicked 1 time");
    });

    await t.step("clicking a <Link> navigates client-side (SPA, no full reload)", async () => {
      // Mark the window; a full reload would wipe this flag.
      await page.evaluate("window.__denextNoReload = true");
      await page.evaluate(
        "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'About').click()",
      );
      await page.waitForFunction("location.pathname === '/about'");
      const survived = await page.evaluate("window.__denextNoReload === true");
      assert(survived, "client navigation must not trigger a full page reload");
    });

    await t.step(
      "soft nav reconciles in place — shared layout DOM is reused, not remounted",
      async () => {
        // Tag a layout DOM node (the footer, shared by every route). A reconcile-in-
        // place nav patches the existing node so the marker survives; the old
        // innerHTML-swap remount would replace it with a fresh node and lose it.
        await page.evaluate("document.querySelector('.foot').__denextMark = 'kept'");
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Home').click()",
        );
        await page.waitForFunction("location.pathname === '/'");
        const kept = await page.evaluate(
          "document.querySelector('.foot') && document.querySelector('.foot').__denextMark === 'kept'",
        );
        assert(kept, "the shared layout node must be reused across soft nav (reconcile-in-place)");
      },
    );

    await t.step("no console errors were logged during hydration and navigation", () => {
      assert(
        consoleErrors.length === 0,
        `unexpected console errors: ${consoleErrors.join(" | ")}`,
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
