// Real-browser E2E: effects from a click or key press run before the next input event, as in
// React 18. The fixture (tests/e2e/fixtures/discrete-effects) is a menu whose open-state
// `useEffect` adds `window` capture `pointerdown` / `keydown` listeners that close it. Chromium
// runs input tasks ahead of timers, so on a slow machine an outside click ~14 ms after the opening
// commit used to beat a `useEffect` left to a timer, and the menu stayed open. Each scenario
// dispatches the opening click, lets only microtasks run (the sync render + commit), then
// dispatches the next input event in the same task: no timer can have run in between.
//   1. an outside pointerdown closes the menu;
//   2. Escape closes it;
//   3. focus an effect moves after a click is where the next key press lands;
//   4. a `startTransition` update still defers its effect past the commit.
//
// Opt-in: run with `deno task test:e2e` (needs the harness's headless Chromium).
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { buildAndServe, launchBrowser } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/discrete-effects", import.meta.url));

/** Page-side helpers, defined once per page. */
const HELPERS = `
window.__q = (id) => document.querySelector('[data-testid="' + id + '"]');
window.__micro = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
`;

/** Open the menu with a click, then send `next` in the same task; whether the menu is still open. */
const openThen = (next: string) =>
  `(async () => {
  __q("trigger").click();
  await __micro();
  const opened = !!__q("menu");
  ${next};
  await __micro();
  return [opened, !!__q("menu")];
})()`;

Deno.test(
  { name: "e2e: a click's useEffect is in place before the next input event" },
  async (t) => {
    const server = await buildAndServe(FIXTURE);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(server.origin + "/");
      /** A freshly loaded page, so no step inherits an open menu or a ran effect. */
      const fresh = async () => {
        await page.goto(server.origin + "/");
        await page.waitForFunction(`!!document.querySelector("[data-ready]")`);
        await page.evaluate(HELPERS);
      };

      await t.step(
        "an outside pointerdown right after the opening click closes the menu",
        async () => {
          await fresh();
          const r = await page.evaluate(openThen(
            `__q("outside").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`,
          ));
          assertEquals(r, [true, false]);
        },
      );

      await t.step("Escape right after the opening click closes the menu", async () => {
        await fresh();
        const r = await page.evaluate(openThen(
          `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
        ));
        assertEquals(r, [true, false]);
      });

      await t.step(
        "a key press right after the click lands on the input its effect focused",
        async () => {
          await fresh();
          const r = await page.evaluate(`(async () => {
          __q("search-open").click();
          await __micro();
          let target = null;
          document.addEventListener("keydown", (e) => (target = e.target.dataset.testid), { once: true });
          document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
          return target;
        })()`);
          assertEquals(r, "search");
        },
      );

      await t.step("a transition's commit still defers its useEffect", async () => {
        await fresh();
        const r = await page.evaluate(`new Promise((resolve) => {
        const btn = __q("transition");
        const mo = new MutationObserver(() => {
          mo.disconnect();
          // A microtask after the commit's DOM change: the passive effect must not have run.
          resolve(__seen.effectRuns.includes("count 1"));
        });
        mo.observe(btn, { childList: true, subtree: true, characterData: true });
        btn.click();
      })`);
        assertEquals(r, false);
        await page.waitForFunction(`__seen.effectRuns.includes("count 1")`);
      });
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
