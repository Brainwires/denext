// Real-browser end-to-end test for resumability (examples/resumability). Builds and
// serves the production app, then drives it with headless Chromium to prove the
// behavior the in-memory reconciler tests can't: on load NOTHING hydrates, clicking
// ONE counter resumes only that island (its render count climbs, the others stay
// frozen at their single SSR render), the effect-driven clock resumes on idle, and
// there are no hydration-mismatch warnings.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { launch } from "@astral/astral";
import { buildAndServe } from "./harness.ts";

const EXAMPLE = new URL("../../examples/resumability", import.meta.url).pathname;

/** Read an array of element textContents (via a JSON round-trip through evaluate). */
async function texts(page: { evaluate: (js: string) => Promise<unknown> }, selector: string) {
  const json = await page.evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll(${
      JSON.stringify(selector)
    })).map((e) => e.textContent))`,
  );
  return JSON.parse(String(json)) as string[];
}

Deno.test({
  name: "e2e: examples/resumability — no hydration on load, per-island resume, no mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launch({ headless: true });

  try {
    await t.step("server HTML carries the resumable payload, all islands at render 1", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "data-dnx-island"); // islands carved out
      assertStringIncludes(html, 'data-dnx-h="click"'); // handler hosts stamped
      assertStringIncludes(html, 'id="__denext_islands"'); // deferred payload
      // Every island (and the page shell) rendered exactly once on the server.
      assertStringIncludes(html, "renders: 1");
      assertStringIncludes(html, "page shell renders (server-only): <strong>1</strong>");
    });

    // Attach the console listener BEFORE navigating, so early messages (the clock's
    // idle-resume log, and any hydration-mismatch warning) are captured — they fire
    // right after load and would be missed if we listened only after newPage(url).
    const page = await browser.newPage();
    const logs: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      logs.push(String(d?.text ?? ""));
    });
    await page.goto(server.origin + "/", { waitUntil: "load" });

    await t.step("the clock resumes on idle on its own (render count climbs)", async () => {
      // The effect island hydrates on idle and ticks — its badge climbs past 1.
      await page.waitForFunction(
        "document.querySelector('.badge.idle') && " +
          "document.querySelector('.badge.idle').textContent.trim() !== 'renders: 1'",
      );
    });

    await t.step("the counters did NOT hydrate on load — frozen at render 1", async () => {
      const badges = await texts(page, ".badge.live");
      assertEquals(badges, ["renders: 1", "renders: 1", "renders: 1"], badges.join(" | "));
      const buttons = await texts(page, "button");
      for (const b of buttons) assertStringIncludes(b, "Clicked 0");
    });

    await t.step("clicking one counter resumes only that island", async () => {
      const first = await page.$("button");
      assert(first, "counter button should exist");
      await first.click();
      await page.waitForFunction(
        "document.querySelector('button').textContent.indexOf('Clicked 1') !== -1",
      );

      const badges = await texts(page, ".badge.live");
      // The clicked counter re-rendered (>= 2); the untouched two stay frozen at 1.
      assert(badges[0] !== "renders: 1", `clicked counter should climb, got ${badges[0]}`);
      assertEquals(badges[1], "renders: 1");
      assertEquals(badges[2], "renders: 1");

      const buttons = await texts(page, "button");
      assertStringIncludes(buttons[0], "Clicked 1 time");
      assertStringIncludes(buttons[1], "Clicked 0");
      assertStringIncludes(buttons[2], "Clicked 0");
    });

    await t.step("the page shell (a Server Component) never ran on the client", async () => {
      const shell = await page.evaluate("document.querySelector('.pagestat strong').textContent");
      assertEquals(String(shell), "1");
    });

    await t.step("console shows only the resumed islands, and NO hydration mismatch", () => {
      const joined = logs.join("\n");
      assertStringIncludes(joined, "counter 1 resumed");
      assertStringIncludes(joined, "clock resumed on idle");
      assert(!joined.includes("counter 2 resumed"), "counter 2 must not have resumed");
      assert(!joined.includes("counter 3 resumed"), "counter 3 must not have resumed");
      assert(
        !/hydration mismatch/i.test(joined),
        `no hydration mismatch expected; logs:\n${joined}`,
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
