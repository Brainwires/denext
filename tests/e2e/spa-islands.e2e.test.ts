// Real-browser E2E for SPA mode's `client:*` deferred mounts (fixtures/spa-islands): the
// production build splits each deferred component into its own chunk, and in the browser each
// one's module loads, and the component mounts, only when its trigger fires — `client:idle`
// once the page is idle, `client:media` when its query matches, `client:visible` when its
// placeholder scrolls near the viewport, `client:interaction` on the first click on its
// `client:placeholder` — while the rest of the app is interactive from the start.
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/spa-islands", import.meta.url));

const exists = (id: string) => `!!document.querySelector('[data-testid="${id}"]')`;
const loaded = (name: string) => `!!(window.__loaded && window.__loaded.${name})`;

Deno.test({
  name: "e2e: SPA client:* directives defer each component's chunk and mount to its trigger",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    await t.step("the build splits every deferred component off the entry", async () => {
      const client = join(FIXTURE, ".denext", "client");
      const entry = await Deno.readTextFile(join(client, "index.js")).catch(() => "");
      const files: string[] = [];
      for await (const e of Deno.readDir(client)) if (e.name.endsWith(".js")) files.push(e.name);
      for (const name of ["chart", "panel", "wide", "later"]) {
        const marker = `__loaded.${name}`;
        assert(!entry.includes(marker), `${name} is not in index.js`);
        let found = false;
        for (const f of files) {
          if ((await Deno.readTextFile(join(client, f))).includes(marker)) found = true;
        }
        assert(found, `${name} has a chunk of its own`);
      }
    });

    const page = await browser.newPage(server.origin + "/");
    const errors = collectConsoleErrors(page);

    await t.step("the app is interactive before any deferred component mounts", async () => {
      await pollFor(page, exists("counter"));
      await page.evaluate(`document.querySelector('[data-testid="counter"]').click()`);
      await pollFor(
        page,
        `document.querySelector('[data-testid="counter"]').textContent === 'count 1'`,
      );
      assertEquals(await page.evaluate(loaded("chart")), false, "the chart's chunk waits");
      assertEquals(await page.evaluate(exists("chart")), false);
      assertEquals(await page.evaluate(loaded("panel")), false, "the panel's chunk waits");
      assertEquals(await page.evaluate(exists("panel")), false);
    });

    await t.step("client:idle and client:media (matching) mount on their own", async () => {
      await pollFor(page, exists("later"));
      await pollFor(page, exists("wide"));
      assertEquals(await page.evaluate(exists("chart")), false, "the far chart still waits");
    });

    await t.step("client:visible mounts when its placeholder nears the viewport", async () => {
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
      await pollFor(page, exists("chart"));
      assert(await page.evaluate(loaded("chart")));
      const text = await page.evaluate(
        `document.querySelector('[data-testid="chart"]').textContent`,
      ) as string;
      assert(text.includes("sales") && text.includes("1"), `props pass through: ${text}`);
    });

    await t.step("client:interaction mounts on the first click on its placeholder", async () => {
      assertEquals(await page.evaluate(exists("panel")), false);
      await page.evaluate(`window.scrollTo(0, 0)`);
      await page.evaluate(
        `(() => { const b = document.querySelector('[data-testid="open"]');` +
          ` b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); b.click(); })()`,
      );
      await pollFor(page, exists("panel"));
      assertEquals(await page.evaluate(exists("open")), false, "the placeholder is gone");
    });

    await t.step("no console errors", () => {
      assertEquals(errors, []);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
