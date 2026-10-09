// Real-browser e2e for the phone navigation pieces, with real touches (CDP touch emulation on
// an iPhone-sized mobile viewport, so the browser itself turns the touches into pointer events
// and honours `touch-action`): SwipeableRow inside a VirtualList opens on a leftward swipe with
// transforms only (no layout shift), a full swipe runs the first action (the row is archived),
// a row swipes the same after the list has scrolled, an action is reachable by keyboard focus;
// and HistoryStack over the browser's history pushes a thread, pops it with a swipe that
// starts mid-screen (not at the edge), and follows the browser's back and forward buttons with
// the list's state and scroll kept.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import type { Page } from "@astral/astral";
import { fromFileUrl } from "@std/path";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/phone-nav", import.meta.url));

// deno-lint-ignore no-explicit-any
type Cdp = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A touch drag from `from` to `to` in `steps` moves, one per frame. */
async function touchDrag(
  cdp: Cdp,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await cdp.Input.dispatchTouchEvent({ type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp.Input.dispatchTouchEvent({ type: "touchMove", touchPoints: [{ x, y }] });
    await sleep(16);
  }
  await cdp.Input.dispatchTouchEvent({ type: "touchEnd", touchPoints: [] });
}

/** The vertical centre of row `id` (it must be rendered). */
async function rowY(page: Page, id: number): Promise<number> {
  return await page.evaluate(
    `(() => { const r = document.querySelector('[data-row="${id}"]').getBoundingClientRect(); ` +
      `return Math.round(r.top + r.height / 2); })()`,
  ) as number;
}

/** The x translation of row `id`'s sliding content. */
const contentX = (id: number) =>
  `new DOMMatrix(getComputedStyle(document.querySelector('[data-row="${id}"]')` +
  `.closest('[data-dnx-swipe-content]')).transform).m41`;

Deno.test({
  name: "e2e: SwipeableRow in a VirtualList and HistoryStack's swipe back, with real touches",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const cdp = page.unsafelyGetCelestialBindings() as Cdp;
  try {
    await cdp.Emulation.setDeviceMetricsOverride({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
    await page.goto(server.origin + "/");
    await pollFor(page, "!!document.querySelector('[data-row=\"3\"]')");
    await page.evaluate(`
      window.__noReload = true;
      window.__shift = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__shift += e.value; })
        .observe({ type: "layout-shift", buffered: true });
    `);

    await t.step("a leftward swipe opens the trailing actions, transforms only", async () => {
      const y = await rowY(page, 3);
      await touchDrag(cdp, { x: 330, y }, { x: 150, y });
      await pollFor(page, `${contentX(3)} === -148`, 5000);
      // The outermost action (Archive) sits at the row's right edge, Mute inside it: a hit
      // test at each slot's centre lands on that button.
      const hit = await page.evaluate(
        `(() => { const row = document.querySelector('[data-row="3"]').closest('[data-dnx-swipe-row]'); ` +
          `const r = row.getBoundingClientRect(); const y = r.top + r.height / 2; ` +
          `const at = (x) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'); ` +
          `return [at(r.right - 37), at(r.right - 111)]; })()`,
      ) as [string, string];
      assertEquals(hit, ["Archive", "Mute thread 3"]);
      const shift = await page.evaluate("window.__shift") as number;
      assert(shift < 0.01, `cumulative layout shift ${shift}`);
      // A tap on the open row closes it (and does not open the thread).
      await cdp.Input.dispatchTouchEvent({ type: "touchStart", touchPoints: [{ x: 60, y }] });
      await cdp.Input.dispatchTouchEvent({ type: "touchEnd", touchPoints: [] });
      await pollFor(page, `${contentX(3)} === 0`, 5000);
      assertEquals(await page.evaluate("location.pathname"), "/");
    });

    await t.step("a full swipe runs the first action: the row is archived", async () => {
      const y = await rowY(page, 5);
      await touchDrag(cdp, { x: 370, y }, { x: 20, y }, 16);
      await pollFor(page, "!document.querySelector('[data-row=\"5\"]')", 5000);
      assert(await page.evaluate("!!document.querySelector('[data-row=\"6\"]')"));
    });

    await t.step("after the list scrolls, a row swipes the same", async () => {
      await page.evaluate(
        "(() => { let el = document.querySelector('[data-row=\"2\"]'); " +
          "while (el && !(el.scrollHeight > el.clientHeight + 10 && " +
          "/auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement; " +
          "el.scrollTop = 3000; })()",
      );
      await pollFor(page, "!!document.querySelector('[data-row=\"60\"]')", 5000);
      const y = await rowY(page, 60);
      await touchDrag(cdp, { x: 330, y }, { x: 150, y });
      await pollFor(page, `${contentX(60)} === -148`, 5000);
      await cdp.Input.dispatchTouchEvent({ type: "touchStart", touchPoints: [{ x: 60, y }] });
      await cdp.Input.dispatchTouchEvent({ type: "touchEnd", touchPoints: [] });
      await pollFor(page, `${contentX(60)} === 0`, 5000);
    });

    await t.step("keyboard: focusing an action opens its side; it runs", async () => {
      await page.evaluate("document.querySelector('[aria-label=\"Mute thread 61\"]').focus()");
      await pollFor(page, `${contentX(61)} === -148`, 5000);
      await page.evaluate("document.querySelector('[aria-label=\"Mute thread 61\"]').click()");
      await pollFor(
        page,
        "document.querySelector('[data-row=\"61\"]').textContent.includes('(muted)')",
        5000,
      );
      await pollFor(page, `${contentX(61)} === 0`, 5000);
    });

    await t.step("a tap pushes the thread; the list stays mounted underneath", async () => {
      await page.evaluate("document.querySelector('[data-row=\"62\"]').click()");
      await pollFor(page, "location.pathname === '/t/62'");
      await pollFor(page, "!!document.querySelector('[data-testid=thread]')");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 2");
      assert(
        await page.evaluate("!!document.querySelector('[data-row=\"62\"]')"),
        "the list (and its scroll window) is kept",
      );
    });

    await t.step("a swipe that starts mid-screen pops back", async () => {
      await sleep(500); // the push animation
      await touchDrag(cdp, { x: 160, y: 500 }, { x: 380, y: 505 }, 14);
      await pollFor(page, "location.pathname === '/'", 5000);
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 1", 5000);
      await pollFor(page, "!!document.querySelector('[data-row=\"62\"]')", 5000); // scroll kept
    });

    await t.step("the browser's back and forward buttons move the stack", async () => {
      await page.evaluate("document.querySelector('[data-row=\"63\"]').click()");
      await pollFor(page, "location.pathname === '/t/63'");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 2");
      await page.evaluate("history.back()");
      await pollFor(page, "location.pathname === '/'");
      await pollFor(page, "document.querySelectorAll('[data-dnx-screen]').length === 1", 5000);
      await page.evaluate("history.forward()");
      await pollFor(page, "location.pathname === '/t/63'");
      await pollFor(
        page,
        "document.querySelector('[data-testid=thread]')?.textContent.includes('63')",
        5000,
      );
      assert(await page.evaluate("window.__noReload === true"), "no full reload");
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
