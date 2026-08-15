// Real-browser e2e for examples/actions. The Server Action's *behavior* (native
// form POST → run → 303 → persisted, plus the CSRF refusal) is fully covered
// server-side by tests/integration/example-actions.test.ts. This browser test
// focuses on what only a browser can show: the SSR markup carries the action
// endpoint, and the "use client" island hydrates cleanly (no hydration crash).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertStringIncludes } from "@std/assert";
import { launch } from "@astral/astral";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/actions", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/actions SSRs the action endpoint and hydrates the client island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launch({ headless: true });

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

    await t.step("the client island hydrates (enhanced form + submit button present)", async () => {
      await page.waitForFunction(
        "!!document.querySelector('.live form') && !!document.querySelector('.live button')",
      );
      const label = await page.evaluate(
        "document.querySelector('.live button') ? document.querySelector('.live button').textContent : ''",
      );
      assertStringIncludes(String(label), "Sign the guestbook");
    });

    await t.step("hydration produced no console errors", () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
