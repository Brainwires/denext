// Real-browser e2e for denext/navigation's StackLayout: a push keeps the list screen (its
// state and scroll position), the iOS edge swipe follows the finger and commits a pop, the
// pop is claimed at once (the kept screen, no reload), and nothing shifts layout on the way
// (every movement is a transform). The swipe is driven with synthetic touch-type pointer
// events at the stack's left edge.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = new URL("./fixtures/native-stack", import.meta.url).pathname;

/** Fire a touch-type pointer event on the stack container. */
const pointer = (type: string, x: number, y: number) =>
  `document.querySelector('[data-dnx-stack]').dispatchEvent(new PointerEvent(${
    JSON.stringify(type)
  }, { pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, clientX: ${x}, clientY: ${y} }))`;

Deno.test({
  name: "e2e: StackLayout push keeps the list, the edge swipe pops it back without layout shift",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  const page = await browser.newPage(server.origin + "/items");
  try {
    await t.step("push keeps the list mounted (hidden) with its state and scroll", async () => {
      await page.waitForFunction("!!document.querySelector('[data-testid=count]')");
      await page.evaluate(`
        window.__noReload = true;
        window.__shift = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; })
          .observe({ type: "layout-shift" });
        const b = document.querySelector('[data-testid=count]'); b.click(); b.click();
        document.querySelector('[data-dnx-screen-body]').scrollTop = 400;
      `);
      await pollFor(
        page,
        "document.querySelector('[data-testid=count]').textContent.includes('2')",
      );
      await page.evaluate(
        "Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/items/12').click()",
      );
      await pollFor(page, "!!document.querySelector('[data-testid=item]')");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 2");
      await pollFor(
        page,
        "getComputedStyle(document.querySelectorAll('[data-dnx-screen]')[0]).display === 'none'",
      );
      assertEquals(await page.evaluate("location.pathname"), "/items/12");
    });

    await t.step("the edge swipe follows the finger, then commits a pop", async () => {
      const width = await page.evaluate(
        "document.querySelector('[data-dnx-stack]').getBoundingClientRect().width",
      ) as number;
      await page.evaluate(pointer("pointerdown", 4, 300));
      await page.evaluate(pointer("pointermove", 20, 301));
      await page.evaluate(pointer("pointermove", Math.round(width * 0.4), 303));
      const moved = await page.evaluate(
        "new DOMMatrix(getComputedStyle(document.querySelectorAll('[data-dnx-screen]')[1]).transform).m41",
      ) as number;
      assert(Math.abs(moved - Math.round(width * 0.4) + 4) < 2, `top screen follows: ${moved}`);
      assert(
        await page.evaluate(
          "getComputedStyle(document.querySelectorAll('[data-dnx-screen]')[0]).display !== 'none'",
        ),
        "the list is revealed underneath",
      );
      await page.evaluate(pointer("pointermove", Math.round(width * 0.7), 305));
      await page.evaluate(pointer("pointerup", Math.round(width * 0.7), 305));
      await pollFor(page, "location.pathname === '/items'");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 1");
    });

    await t.step(
      "the kept list is back: same state, same scroll, no reload, no layout shift",
      async () => {
        assert(
          await page.evaluate(
            "document.querySelector('[data-testid=count]').textContent.includes('2')",
          ),
          "counter state kept",
        );
        assertEquals(
          await page.evaluate("document.querySelector('[data-dnx-screen-body]').scrollTop"),
          400,
        );
        assert(await page.evaluate("window.__noReload === true"), "no full reload");
        const shift = await page.evaluate("window.__shift") as number;
        assert(shift < 0.01, `cumulative layout shift ${shift}`);
      },
    );

    await t.step("browser back after another push is claimed the same way", async () => {
      await page.evaluate(
        "Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/items/3').click()",
      );
      await pollFor(
        page,
        "location.pathname === '/items/3' && !!document.querySelector('[data-testid=item]')",
      );
      await page.evaluate("history.back()");
      await pollFor(page, "location.pathname === '/items'");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 1");
      assert(
        await page.evaluate(
          "document.querySelector('[data-testid=count]').textContent.includes('2')",
        ),
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
