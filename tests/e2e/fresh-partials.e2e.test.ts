// Fresh Partials in a real browser: a migrated Fresh app (tests/helpers/fresh-parity-app.ts)
// built and served, then driven in headless Chromium. A `<button f-partial>` swaps the "recipe"
// region in place (no history entry), and an `f-client-nav` link with `f-partial` appends to the
// "list" region and pushes its `href` — the same document throughout, the island beside the
// regions still hydrated, and its `import.meta.env` showing the public variable, not the secret.
//
// A second app navigates between two pages with `f-client-nav` links under `f-view-transition`:
// only the `<Partial>` region changes (a counter island beside it keeps its count), the answer's
// head merges into the page's (title, the `description` meta and the page stylesheet, never a
// duplicate), the swap runs inside `document.startViewTransition`, and back / forward restore
// each entry's content and URL.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";
import { startCliServer } from "./harness.ts";
import { buildInChild } from "../helpers/bounded-build.ts";
import {
  PUBLIC_VALUE,
  SECRET_VALUE,
  writeFreshNavApp,
  writeFreshParityApp,
} from "../helpers/fresh-parity-app.ts";

Deno.test({
  name: "Fresh Partials: an f-partial button and link swap their regions in place",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-fresh-partials-" }));
  try {
    await writeFreshParityApp(dir);
    await buildInChild(dir);
    const server = await startCliServer(dir, 120_000);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(server.origin + "/");
      const errors = collectConsoleErrors(page);
      await pollFor(page, `document.querySelector("#env.ready") !== null`);
      await page.evaluate("globalThis.__sameDocument = true");
      const env = String(await page.evaluate(`document.querySelector("#env").textContent`));
      assertEquals(env, `${PUBLIC_VALUE} ${PUBLIC_VALUE} undefined`);
      assert(!env.includes(SECRET_VALUE));

      await (await page.$("#swap"))!.click();
      await pollFor(page, `document.querySelector("#recipe").textContent === "Lemonade"`);
      assertEquals(await page.evaluate("location.pathname + location.search"), "/");

      await (await page.$("#more"))!.click();
      await pollFor(page, `document.querySelectorAll("ul li").length === 2`);
      assertEquals(
        await page.evaluate(`[...document.querySelectorAll("ul li")].map((l) => l.textContent)`),
        ["one", "two"],
      );
      assertEquals(await page.evaluate("location.pathname + location.search"), "/?page=2");
      // The rest of the page stayed: the swapped recipe, and the island, on the same document.
      assertEquals(
        await page.evaluate(`document.querySelector("#recipe").textContent`),
        "Lemonade",
      );
      assert(await page.evaluate(`document.querySelector("#env.ready") !== null`));
      assert(await page.evaluate("globalThis.__sameDocument === true"), "no full reload");
      assertNoConsoleErrors(errors);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** The page's head as the test compares it: title, every description meta, every stylesheet. */
const HEAD_STATE = `({
  title: document.title,
  descriptions: [...document.head.querySelectorAll('meta[name="description"]')]
    .map((m) => m.getAttribute("content")),
  sheets: [...document.head.querySelectorAll('link[rel="stylesheet"]')]
    .map((l) => l.getAttribute("href")).filter((h) => h === "/a.css" || h === "/b.css"),
})`;

/** What the page shows: the region, the island's count, the URL and the title. */
const VIEW_STATE = `({
  content: document.querySelector("#content")?.textContent,
  count: document.querySelector("#inc")?.textContent,
  path: location.pathname,
  title: document.title,
})`;

/**
 * Count the view transitions the swaps start (the API call, not what it paints) and keep the
 * newest one's `finished`: input during a transition goes to its pseudo-elements, so the test
 * clicks again only once it ended.
 */
const COUNT_TRANSITIONS = `(() => {
  globalThis.__sameDocument = true;
  globalThis.__transitions = 0;
  globalThis.__transitionDone = Promise.resolve();
  const start = document.startViewTransition;
  if (typeof start !== "function") return false;
  document.startViewTransition = function (cb) {
    globalThis.__transitions++;
    const vt = start.call(document, cb);
    globalThis.__transitionDone = vt.finished.catch(() => {});
    return vt;
  };
  return true;
})()`;

Deno.test({
  name: "Fresh Partials: client navigation merges the head, transitions, and goes back / forward",
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-fresh-nav-" }));
  try {
    await writeFreshNavApp(dir);
    await buildInChild(dir);
    const server = await startCliServer(dir, 120_000);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(server.origin + "/");
      const errors = collectConsoleErrors(page);
      const click = async (selector: string) => {
        await page.evaluate("globalThis.__transitionDone");
        await (await page.$(selector))!.click();
      };
      await pollFor(page, `document.querySelector("#inc.ready") !== null`);
      assertEquals(await page.evaluate(HEAD_STATE), {
        title: "Page a",
        descriptions: ["about a"],
        sheets: ["/a.css"],
      });
      const hasTransitions = await page.evaluate(COUNT_TRANSITIONS);
      // The island's state, which only a full reload or a re-mount would lose.
      await click("#inc");
      await click("#inc");
      await pollFor(page, `document.querySelector("#inc").textContent === "2"`);

      await click("#to-b");
      await pollFor(page, `document.querySelector("#content").textContent === "content b"`);
      const onB = { content: "content b", count: "2", path: "/b", title: "Page b" };
      assertEquals(await page.evaluate(VIEW_STATE), onB);
      // Merged, not appended: one description meta, updated; the new stylesheet added once.
      assertEquals(await page.evaluate(HEAD_STATE), {
        title: "Page b",
        descriptions: ["about b"],
        sheets: ["/a.css", "/b.css"],
      });
      assertEquals(
        await page.evaluate(`getComputedStyle(document.querySelector("#content")).letterSpacing`),
        "1px",
        "the merged stylesheet applies",
      );
      if (hasTransitions) {
        assertEquals(await page.evaluate("globalThis.__transitions"), 1, "one view transition");
      }

      // Back and forward restore each entry's region, URL and head.
      const onA = { content: "content a", count: "2", path: "/", title: "Page a" };
      await page.evaluate("globalThis.__transitionDone.then(() => history.back())");
      await pollFor(page, `document.querySelector("#content").textContent === "content a"`);
      assertEquals(await page.evaluate(VIEW_STATE), onA);
      assertEquals(
        (await page.evaluate(HEAD_STATE) as { descriptions: string[] }).descriptions,
        ["about a"],
      );
      await page.evaluate("history.forward()");
      await pollFor(page, `document.querySelector("#content").textContent === "content b"`);
      assertEquals(await page.evaluate(VIEW_STATE), onB);
      assertEquals(
        (await page.evaluate(HEAD_STATE) as { descriptions: string[] }).descriptions,
        ["about b"],
      );

      // To a again by a link: the head merges back, still without a duplicate.
      await click("#to-a");
      await pollFor(page, `document.querySelector("#content").textContent === "content a"`);
      assertEquals(await page.evaluate(VIEW_STATE), onA);
      assertEquals(await page.evaluate(HEAD_STATE), {
        title: "Page a",
        descriptions: ["about a"],
        sheets: ["/a.css", "/b.css"],
      });
      if (hasTransitions) {
        assertEquals(await page.evaluate("globalThis.__transitions"), 2, "a transition per link");
      }
      assert(await page.evaluate("globalThis.__sameDocument === true"), "no full reload");
      assertNoConsoleErrors(errors);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
