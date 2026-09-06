// Real-browser e2e for examples/typed-api: two tabs; adding a todo in one updates the other's
// list (a tag watch → typed refetch), its counts (a validated live subscription) and its event
// toast (a server-push channel) — all over one WebSocket. The wires themselves are covered
// without a browser by tests/integration/example-typed-api.test.ts.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/typed-api", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/typed-api pushes a typed create to a second tab",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();
  try {
    const a = await browser.newPage(server.origin + "/");
    const b = await browser.newPage(server.origin + "/");
    const errors: string[] = [];
    for (const page of [a, b]) {
      page.addEventListener("console", (e) => {
        // deno-lint-ignore no-explicit-any
        const detail = (e as any).detail;
        if (detail?.type === "error") errors.push(String(detail.text ?? ""));
      });
    }
    await t.step(
      "both tabs hydrate the typed list and the live stats",
      async () => {
        for (const page of [a, b]) {
          await page.waitForFunction(
            "document.querySelectorAll('.todos .entries li').length >= 2",
          );
          await page.waitForFunction(
            "!!document.querySelector('.live-todos .count')",
          );
        }
      },
    );
    const title = `From tab A ${Date.now()}`;
    await t.step(
      "adding in tab A updates tab B's list, counts, and event toast",
      async () => {
        await a.evaluate(
          `document.querySelector('.todos .add input').value = ${JSON.stringify(title)};` +
            "document.querySelector('.todos .add input').dispatchEvent(new Event('input', { bubbles: true }))",
        );
        const add = await a.$(".todos .add button");
        assert(add, "the add button exists");
        await add.click();
        await b.waitForFunction(
          `document.querySelector('.todos .entries').textContent.includes(${
            JSON.stringify(title)
          })`,
        );
        await b.waitForFunction(
          `(document.querySelector('.live-todos .toast').textContent || '').includes(${
            JSON.stringify(title)
          })`,
        );
        const toast = await b.evaluate(
          "document.querySelector('.live-todos .toast').textContent",
        );
        assertStringIncludes(String(toast), "added:");
        const total = await b.evaluate(
          "document.querySelector('.live-todos .count').dataset.total",
        );
        assert(
          Number(total) >= 3,
          `the subscription re-pushed the count (${total})`,
        );
      },
    );
    assert(errors.length === 0, `no console errors: ${errors.join("\n")}`);
  } finally {
    await browser.close();
    await server.close();
  }
});
