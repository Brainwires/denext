// Real-browser e2e for a ROOT-LESS islands page (every client part a `client:*` island, so the
// document inlines no root Flight tree):
//   • a Server Action's refresh() re-renders the same route in place — the changed server output
//     is patched onto the markup (text, attributes, an added node) while the islands keep their
//     state (adopted, not remounted), and nothing reloads;
//   • a later refresh (now through the retained root) keeps the island state too;
//   • a soft nav to another route removes the island, and its effect cleanup runs (its document
//     listener is gone — no leak).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe, collectConsoleLogs, launchBrowser, pollFor } from "./harness.ts";
import { fromFileUrl } from "@std/path";

const FIXTURE = fromFileUrl(new URL("./fixtures/islands-refresh", import.meta.url));

const q = (id: string) => `document.querySelector('[data-testid=${id}]')`;
const text = (id: string) => `((${q(id)} || {}).textContent || '')`;

Deno.test({
  name: "e2e: a root-less islands page keeps island state across action refreshes",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  try {
    const html = await (await fetch(server.origin + "/")).text();
    assertStringIncludes(html, '<script id="__denext_flight" type="application/json">null');

    const page = await browser.newPage(server.origin + "/");
    const logs = collectConsoleLogs(page);
    await pollFor(page, `!!${q("count")}`);

    await t.step("the counter island hydrates and counts", async () => {
      // Click until the island is live (client:load hydrates right after boot), then settle on
      // an exact count.
      await pollFor(page, `(${q("count")}.click(), !${text("count")}.includes('count: 0'))`);
      const n = Number(String(await page.evaluate(text("count"))).replace(/\D/g, ""));
      await page.evaluate(`${q("count")}.click(); ${q("count")}.click()`);
      await pollFor(page, `${text("count")}.includes('count: ${n + 2}')`);
      await page.evaluate(`window.__count = ${JSON.stringify(`count: ${n + 2}`)}`);
      await page.evaluate("window.__noReload = true");
    });

    await t.step("a refresh patches the server output and keeps the island state", async () => {
      await page.evaluate(`${q("bump")}.click()`);
      await pollFor(page, `${text("server")}.includes('server hits: 1')`);
      assert(await page.evaluate(`${q("server")}.className === 'hits-1'`), "attribute patched");
      assert(await page.evaluate(`!!${q("bumped")}`), "a node the refresh added is there");
      assertEquals(await page.evaluate(text("count")), await page.evaluate("window.__count"));
      assert(await page.evaluate("window.__noReload === true"), "no reload");
      await page.evaluate("document.dispatchEvent(new Event('ping'))");
      assertEquals(await page.evaluate("window.__pings"), 1, "one live listener");
    });

    await t.step("a second refresh (retained root) keeps it too", async () => {
      await page.evaluate(`${q("bump")}.click()`);
      await pollFor(page, `${text("server")}.includes('server hits: 2')`);
      assertEquals(await page.evaluate(text("count")), await page.evaluate("window.__count"));
      // The bump island is live after both refreshes.
      await page.evaluate(`${q("bump")}.click()`);
      await pollFor(page, `${text("server")}.includes('server hits: 3')`);
    });

    await t.step("navigating away unmounts the island (its listener is gone)", async () => {
      await page.evaluate(
        "Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === '/other').click()",
      );
      await pollFor(page, `!!${q("other")}`);
      assert(await page.evaluate("window.__noReload === true"), "a soft nav");
      const before = await page.evaluate("window.__pings");
      await page.evaluate("document.dispatchEvent(new Event('ping'))");
      assertEquals(await page.evaluate("window.__pings"), before, "the listener was cleaned up");
    });

    assert(
      !/hydration mismatch|failed/i.test(logs.join("\n")),
      `no mismatch or failure logs:\n${logs.join("\n")}`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
