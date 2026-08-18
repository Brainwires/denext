// Real-browser end-to-end test for @denext/pages-router client hydration + soft
// navigation. Builds examples/pages-router for production, serves it, and drives
// it with a headless Chromium (astral). This exercises what the in-memory handler
// tests can't: real hydration (state + events), SPA link navigation with no full
// reload, the soft-nav data endpoint (running getServerSideProps), a code-split
// chunk fetched on demand, and reconcile-in-place of the shared `_app` shell.
//
// Opt-in: run with `deno task test:e2e`. astral downloads Chromium on first run,
// so this is excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { launch } from "@astral/astral";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/pages-router", import.meta.url).pathname;

Deno.test({
  name: "e2e: pages-router hydrates, is interactive, and soft-navigates (SSR data + code-split)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launch({ headless: true });

  try {
    await t.step(
      "server HTML is server-rendered and carries __NEXT_DATA__ + a hydration script",
      async () => {
        const html = await (await fetch(server.origin + "/")).text();
        assertStringIncludes(html, 'class="home"');
        assertStringIncludes(html, "Clicked 0 times");
        assertStringIncludes(html, 'id="__NEXT_DATA__"');
        assertStringIncludes(html, '<script type="module" src="/_denext/pages/');
      },
    );

    await t.step("App Router routes still win over the Pages Router", async () => {
      const html = await (await fetch(server.origin + "/app-page")).text();
      assertStringIncludes(html, 'class="app-only"');
      assert(
        !html.includes('id="__NEXT_DATA__"'),
        "an App Router route is not a Pages Router page",
      );
    });

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const detail = (e as any).detail;
      if (detail?.type === "error") consoleErrors.push(String(detail.text ?? ""));
    });

    await t.step("hydration completes (the runtime sets its hydrated marker)", async () => {
      await page.waitForFunction(
        "document.documentElement.getAttribute('data-denext-pages-hydrated') === '1'",
      );
    });

    await t.step("the counter is interactive after hydration", async () => {
      const button = await page.$("button");
      assert(button, "counter button should exist");
      await button.click();
      const label = await page.evaluate(
        "document.querySelector('button') ? document.querySelector('button').textContent : ''",
      );
      assertStringIncludes(String(label), "Clicked 1 time");
    });

    await t.step("clicking a <Link> soft-navigates (SPA, no full reload)", async () => {
      // A full reload would wipe these markers; a soft nav preserves them.
      await page.evaluate("window.__prNoReload = true");
      await page.evaluate("document.querySelector('.shell').__prMark = 'kept'");
      await page.evaluate(
        "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'About').click()",
      );
      await page.waitForFunction(
        "location.pathname === '/about' && !!document.querySelector('.about')",
      );
      const survived = await page.evaluate("window.__prNoReload === true");
      assert(survived, "client navigation must not trigger a full page reload");
      const shellKept = await page.evaluate(
        "document.querySelector('.shell') && document.querySelector('.shell').__prMark === 'kept'",
      );
      assert(shellKept, "the shared _app shell must be reconciled in place, not remounted");
    });

    await t.step(
      "soft nav to a getServerSideProps route fetches data + a code-split chunk",
      async () => {
        // From /about, navigate Home then to the gSSP post — its props come from
        // the server data endpoint and its component from a lazily-imported chunk.
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Home').click()",
        );
        await page.waitForFunction(
          "location.pathname === '/' && !!document.querySelector('.home')",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Post').click()",
        );
        await page.waitForFunction(
          "location.pathname === '/blog/hello' && !!document.querySelector('.post')",
        );
        const text = await page.evaluate("document.querySelector('.post').textContent");
        assertStringIncludes(String(text), "Post: hello (gssp)");
        const stillSpa = await page.evaluate("window.__prNoReload === true");
        assert(stillSpa, "data-driven soft nav must not reload the page");
      },
    );

    await t.step("browser back button restores the previous route", async () => {
      await page.evaluate("history.back()");
      await page.waitForFunction("location.pathname === '/' && !!document.querySelector('.home')");
    });

    await t.step("no console errors during hydration and navigation", () => {
      assert(consoleErrors.length === 0, `unexpected console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
