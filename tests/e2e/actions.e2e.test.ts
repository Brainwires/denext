// Real-browser e2e for examples/actions: the full Server Action round-trip through
// the hydrated "use client" island — fill the enhanced form, submit, and confirm
// the action ran over the client RPC path (useActionState renders its returned
// state in place, no navigation) and persisted server-side. The native no-JS form
// POST + CSRF refusal are covered server-side by
// tests/integration/example-actions.test.ts.
//
// Form fields are set via the DOM (not synthetic keystrokes) so the input state is
// deterministic — `new FormData(form)` reads the live values regardless.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/actions", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/actions SSRs the action endpoint and hydrates the client island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step("the native form's SSR markup carries the Server Action endpoint", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, '<form action="/_denext/action/');
      assertStringIncludes(html, 'method="post"');
    });

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const detail = (e as any).detail;
      if (detail?.type === "error") consoleErrors.push(String(detail.text ?? ""));
    });

    await t.step("submitting the hydrated island round-trips the Server Action", async () => {
      await page.waitForFunction(
        "!!document.querySelector('.live form') && !!document.querySelector('.live button')",
      );
      await page.evaluate("window.__noReload = true");
      // Set the live form values deterministically, then submit.
      await page.evaluate(
        "document.querySelector('.live input[name=name]').value = 'Grace';" +
          "document.querySelector('.live input[name=message]').value = 'Hopper was here';",
      );
      const submit = await page.$(".live button");
      assert(submit, "the enhanced submit button exists");
      await submit.click();

      // useOptimistic shows the submitted row in the island's live list in place —
      // proof the form was intercepted, the action ran over the client RPC, and the
      // component re-rendered from its result (no full navigation).
      await page.waitForFunction(
        "!!document.querySelector('.live .entries') && " +
          "document.querySelector('.live .entries').textContent.includes('Hopper was here')",
      );
      const noReload = await page.evaluate("window.__noReload === true");
      assert(noReload, "the client submit must not full-reload the page");
    });

    await t.step("the Server Action persisted the entry server-side", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "Grace");
      assertStringIncludes(html, "Hopper was here");
    });

    await t.step("no console errors during hydration and submission", () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
