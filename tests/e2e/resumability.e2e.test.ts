// Real-browser end-to-end test for resumability (examples/resumability). Builds and
// serves the production app, then drives it with headless Chromium to prove the
// behavior the in-memory reconciler tests can't: on load NOTHING hydrates, clicking
// ONE counter resumes only that island (its render count climbs, the others stay
// frozen at their single SSR render), the effect-driven clock resumes on idle, and
// there are no hydration-mismatch warnings.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Page } from "@astral/astral";
import { buildAndServe, collectConsoleLogs, launchBrowser, type RunningServer } from "./harness.ts";

/**
 * Poll a boolean `expr` in the page until it's truthy, or `ms` elapses. astral's
 * `waitForFunction` has a fixed, short internal timeout that a heavily-loaded build/CI
 * host can exceed for a soft-nav → Flight re-boot → island-resume sequence; this gives an
 * explicit, generous budget so a slow machine doesn't flake (it still fails fast on a real
 * hang).
 */
async function pollFor(page: Page, expr: string, ms = 45000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(`!!(${expr})`)) return;
    if (Date.now() > deadline) throw new Error(`pollFor timed out after ${ms}ms: ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const EXAMPLE = new URL("../../examples/resumability", import.meta.url).pathname;

/** Read an array of element textContents (via a JSON round-trip through evaluate). */
async function texts(
  page: { evaluate: (js: string) => Promise<unknown> },
  selector: string,
) {
  const json = await page.evaluate(
    `JSON.stringify(Array.from(document.querySelectorAll(${
      JSON.stringify(selector)
    })).map((e) => e.textContent))`,
  );
  return JSON.parse(String(json)) as string[];
}

async function stepServerHtml(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/")).text();
  assertStringIncludes(html, "data-dnx-island"); // islands carved out
  assertStringIncludes(html, 'data-dnx-h="click"'); // handler hosts stamped
  assertStringIncludes(html, 'id="__denext_islands"'); // deferred payload
  // Every island (and the page shell) rendered exactly once on the server.
  assertStringIncludes(html, "renders: 1");
  assertStringIncludes(
    html,
    "page shell renders (server-only): <strong>1</strong>",
  );
}

async function stepClockResumes(page: Page): Promise<void> {
  // The effect island hydrates on idle and ticks — its badge climbs past 1.
  await page.waitForFunction(
    "document.querySelector('.badge.idle') && " +
      "document.querySelector('.badge.idle').textContent.trim() !== 'renders: 1'",
  );
}

async function stepCountersFrozen(page: Page): Promise<void> {
  const badges = await texts(page, ".badge.live");
  assertEquals(
    badges,
    ["renders: 1", "renders: 1", "renders: 1"],
    badges.join(" | "),
  );
  const buttons = await texts(page, "button");
  for (const b of buttons) assertStringIncludes(b, "Clicked 0");
}

async function stepClickResumesOne(page: Page): Promise<void> {
  const first = await page.$("button");
  assert(first, "counter button should exist");
  await first.click();
  await page.waitForFunction(
    "document.querySelector('button').textContent.indexOf('Clicked 1') !== -1",
  );

  const badges = await texts(page, ".badge.live");
  // The clicked counter re-rendered (>= 2); the untouched two stay frozen at 1.
  assert(
    badges[0] !== "renders: 1",
    `clicked counter should climb, got ${badges[0]}`,
  );
  assertEquals(badges[1], "renders: 1");
  assertEquals(badges[2], "renders: 1");

  const buttons = await texts(page, "button");
  assertStringIncludes(buttons[0], "Clicked 1 time");
  assertStringIncludes(buttons[1], "Clicked 0");
  assertStringIncludes(buttons[2], "Clicked 0");
}

async function stepShellServerOnly(page: Page): Promise<void> {
  const shell = await page.evaluate(
    "document.querySelector('.pagestat strong').textContent",
  );
  assertEquals(String(shell), "1");
}

function stepConsoleLogs(logs: string[]): void {
  const joined = logs.join("\n");
  assertStringIncludes(joined, "counter 1 resumed");
  assertStringIncludes(joined, "clock resumed on idle");
  assert(
    !joined.includes("counter 2 resumed"),
    "counter 2 must not have resumed",
  );
  assert(
    !joined.includes("counter 3 resumed"),
    "counter 3 must not have resumed",
  );
  assert(
    !/hydration mismatch/i.test(joined),
    `no hydration mismatch expected; logs:\n${joined}`,
  );
}

Deno.test({
  name: "e2e: examples/resumability — no hydration on load, per-island resume, no mismatch",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step(
      "server HTML carries the resumable payload, all islands at render 1",
      () => stepServerHtml(server),
    );

    // Attach the console listener BEFORE navigating, so early messages (the clock's
    // idle-resume log, and any hydration-mismatch warning) are captured — they fire
    // right after load and would be missed if we listened only after newPage(url).
    const page = await browser.newPage();
    const logs = collectConsoleLogs(page);
    await page.goto(server.origin + "/", { waitUntil: "load" });

    await t.step(
      "the clock resumes on idle on its own (render count climbs)",
      () => stepClockResumes(page),
    );
    await t.step(
      "the counters did NOT hydrate on load — frozen at render 1",
      () => stepCountersFrozen(page),
    );
    await t.step("clicking one counter resumes only that island", () => stepClickResumesOne(page));
    await t.step(
      "the page shell (a Server Component) never ran on the client",
      () => stepShellServerOnly(page),
    );
    await t.step(
      "console shows only the resumed islands, and NO hydration mismatch",
      () => stepConsoleLogs(logs),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

// Separate test (fresh page) for the Flight soft-navigation re-wire: a resumable
// route reached by an in-app <Link> must render its island content and become
// interactive — the audit found it stayed inert because the soft-nav path never
// re-booted resumability. Kept apart from the resume test above so the first page's
// long-running clock interval doesn't perturb the assertions.
Deno.test({
  name: "e2e: examples/resumability — a soft nav into a second resumable route wakes its island",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const logs = collectConsoleLogs(page);
    await page.goto(server.origin + "/", { waitUntil: "load" });

    // Soft-navigate via the in-app <Link> (no full reload).
    await page.evaluate(`(() => {
      const a = Array.from(document.querySelectorAll('a')).find((a) =>
        a.getAttribute('href') === '/second');
      if (a) a.click();
    })()`);
    await pollFor(page, "location.pathname === '/second'");

    // The island rendered its content after the soft nav (was empty before the fix).
    await pollFor(
      page,
      "document.querySelector('button') && " +
        "document.querySelector('button').textContent.indexOf('Clicked 0') !== -1",
    );
    assertStringIncludes(
      String(await page.evaluate("document.querySelector('h1').textContent")),
      "Second resumable route",
    );

    // And it is interactive: clicking advances the count (the island genuinely resumed —
    // it renders + wires its handler on the soft-nav eager mount). Dispatch the click on
    // the LIVE button node: a CDP-handle click (`page.$(...).click()`) can go stale/miss
    // across the eager mount's re-render, whereas a synthetic click on the current node
    // reliably fires the resumed handler — which is the behavior under test.
    const btn = await page.$("button");
    assert(btn, "the second route's counter button should exist");
    await page.evaluate("document.querySelector('button').click()");
    await pollFor(
      page,
      "document.querySelector('button').textContent.indexOf('Clicked 1') !== -1",
    );

    assert(
      !/hydration mismatch/i.test(logs.join("\n")),
      `no hydration mismatch after soft nav; logs:\n${logs.join("\n")}`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
