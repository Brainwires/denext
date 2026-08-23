// Real-browser end-to-end test for the six island hydration directives
// (examples/islands). Builds and serves the production app, then drives it with
// headless Chromium to prove what the in-memory tests can't: each `client:*` island
// hydrates on its OWN schedule via a REAL IntersectionObserver / requestIdleCallback
// / matchMedia / delegated interaction — not all-at-once — and `client:only` mounts
// client-side with no server HTML.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/islands", import.meta.url).pathname;

/** textContent of one element (or "" if absent), via evaluate. */
function text(page: { evaluate: (js: string) => Promise<unknown> }, selector: string) {
  return page.evaluate(
    `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||""`,
  ).then(String);
}

const badge = (label: string) => `.island[data-label="${label}"] .badge`;
const hydrated = (label: string) =>
  `document.querySelector(${JSON.stringify(badge(label))}) && ` +
  `document.querySelector(${JSON.stringify(badge(label))}).textContent.indexOf('hydrated') !== -1`;

Deno.test({
  name: "e2e: examples/islands — six directives each hydrate on their own schedule",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step("server HTML carves all six islands; client:only has no SSR body", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      for (const s of ["load", "idle", "visible", "interaction", "media", "only"]) {
        assertStringIncludes(html, `data-dnx-strategy="${s}"`);
      }
      // The media island stamps its query on the wrapper.
      assertStringIncludes(html, `data-dnx-strategy-param="(min-width: 600px)"`);
      // Five islands SSR their body; client:only does NOT (no first paint).
      for (const s of ["load", "idle", "visible", "interaction", "media"]) {
        assertStringIncludes(html, `data-label="${s}"`);
      }
      assert(!html.includes(`data-label="only"`), "client:only must not render server HTML");
      // The deferred-hydration payload is present.
      assertStringIncludes(html, 'id="__denext_islands"');
    });

    const page = await browser.newPage();
    const logs: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      logs.push(String((e as any).detail?.text ?? ""));
    });
    await page.goto(server.origin + "/", { waitUntil: "load" });

    await t.step("client:load and client:only hydrate immediately", async () => {
      await page.waitForFunction(hydrated("load"));
      // client:only had no server DOM — it appears only after its client-only mount.
      await page.waitForFunction(hydrated("only"));
      assertStringIncludes(await text(page, badge("only")), "hydrated");
    });

    await t.step("client:idle hydrates on idle without interaction", async () => {
      await page.waitForFunction(hydrated("idle"));
    });

    await t.step("client:visible stays inert until scrolled into view", async () => {
      // Below a 120vh spacer, so it is off-screen on load: still SSR-inert.
      assertEquals((await text(page, badge("visible"))).indexOf("hydrated"), -1);
      await page.evaluate(
        `document.querySelector('.island[data-label="visible"]').scrollIntoView()`,
      );
      await page.waitForFunction(hydrated("visible")); // IntersectionObserver fires
    });

    await t.step(
      "client:interaction stays inert until first interaction, then replays it",
      async () => {
        const btn = await page.$('.island[data-label="interaction"] button');
        assert(btn, "interaction island button should exist (SSR body present)");
        // Not hydrated before the click.
        assertEquals((await text(page, badge("interaction"))).indexOf("hydrated"), -1);
        await btn.click();
        await page.waitForFunction(hydrated("interaction"));
        // The triggering click was replayed to the now-live handler → counter at 1.
        await page.waitForFunction(
          `document.querySelector('.island[data-label="interaction"] button')` +
            `.textContent.indexOf('clicked 1') !== -1`,
        );
      },
    );

    await t.step("client:media hydrates iff its query matches the viewport", async () => {
      const matches = await page.evaluate(`matchMedia('(min-width: 600px)').matches`);
      if (matches) {
        await page.waitForFunction(hydrated("media"));
      } else {
        // Query doesn't match this viewport → island stays inert (correct).
        assertEquals((await text(page, badge("media"))).indexOf("hydrated"), -1);
      }
    });

    await t.step("each island logged its own hydration; no hydration mismatch", () => {
      const hydrations = logs.filter((l) => l.startsWith("island:"));
      // load, idle, visible, interaction, only always hydrate here; media depends on
      // the viewport. So at least five distinct islands logged, each exactly once.
      const distinct = new Set(hydrations);
      assert(distinct.size >= 5, `expected >=5 islands hydrated, got: ${[...distinct].join(", ")}`);
      for (const l of distinct) {
        assertEquals(
          hydrations.filter((x) => x === l).length,
          1,
          `island logged more than once: ${l}`,
        );
      }
      assert(
        !logs.some((l) => /hydrat|mismatch/i.test(l) && /warn|did not match|expected/i.test(l)),
        "no hydration-mismatch warning expected:\n" + logs.join("\n"),
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
