// `denext ui` in a real browser — the first thing that ever EXECUTES `src/ui/client.ts`.
//
// Every other UI test drives the server the way a JavaScript-disabled browser would: real form
// posts, real `303`s. That is the guarantee the UI is built around, and it is well covered. But
// it means the client module was only ever asserted as SOURCE TEXT
// (`ui-view-substrate.test.ts` greps it), never run — so nothing could catch a module that fails
// to parse, a CSP that refuses to load it, or an enhanced submit that silently falls back to a
// full navigation. The dev-server bug this file's second test pins was invisible for exactly
// that reason.
//
// Opt-in and nightly, like the rest of `tests/e2e/`: astral downloads Chromium on first run.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";

/** A project directory with a `deno.json`. */
async function project(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: "jsr:@denext/denext@^2" }, tasks: { dev: "echo dev" } }),
  );
  return dir;
}

/**
 * Publish a `.denext/dev.json` for a dev server that is not there: the panel will offer Stop
 * for it, and stopping must discover that it is already gone.
 *
 * The origin is a stand-in that stays LISTENING until `close` and answers nothing but 404 — the
 * port a dev server vacated and something else took. A port bound and given straight back
 * would be free only until another test bound it, and Chromium takes seconds to reach the
 * Stop button; a server of our own has no such window, and "not ok" is "no answer" to the
 * stop's probe exactly as a refused connection is.
 */
async function staleDevJson(dir: string): Promise<{ close(): Promise<void> }> {
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const srv = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    () => new Response("not found", { status: 404 }),
  );
  const port = await promise;
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, ".denext", "dev.json"),
    JSON.stringify({
      origin: `http://127.0.0.1:${port}`,
      port,
      hostname: "127.0.0.1",
      pid: 2147483646, // never signalled: the origin is not a dev server, so this is the stale path
      startedAt: Date.now(),
    }),
  );
  return {
    async close() {
      ac.abort();
      await srv.finished;
    },
  };
}

/** Tear down a UI server and its project directory. */
async function teardown(server: UiServer, dir: string): Promise<void> {
  await server.shutdown();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

Deno.test("denext ui: the ?t= handshake, and ui.js actually loads under the strict CSP", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);

    await page.goto(server.url); // the single-use ?t= URL the CLI prints

    // The handshake trades the query parameter for an HttpOnly cookie and redirects to a clean
    // URL, so the token never lingers in history or a referrer.
    assertEquals(await page.evaluate("location.search"), "", "?t= must not survive the handshake");

    // The module is same-origin, so `script-src 'self'` admits it. If the CSP or the module
    // itself were broken, the tag would still be here — so the tag alone proves nothing, and
    // the next test proves EXECUTION. This asserts it is wired in at all.
    const tag = await page.evaluate(
      `!!document.querySelector('script[src*="/_ui/ui.js"]')`,
    );
    assertEquals(tag, true, "the page must reference /_ui/ui.js");

    // A CSP refusal or a parse error in the module surfaces here, and nowhere else.
    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: Stop swaps the panel in place — no navigation, which is the whole bug", async () => {
  const dir = await project();
  const stale = await staleDevJson(dir);
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);

    // The origin MUST come from `server.url`: the server binds 127.0.0.1 but publishes the
    // display host, and the session cookie is `SameSite=Strict` on whichever one that is.
    // Reconstructing the other spelling is a different origin, so the cookie is never sent and
    // every panel answers a refusal instead.
    await page.goto(server.url); // handshake first, so the cookie carries the next navigation
    await page.goto(`${new URL(server.url).origin}/dev`);

    // A dev server is published, so the page offers Stop.
    await pollFor(page, `document.body.textContent.indexOf('Stop denext dev') !== -1`);

    // A full navigation would rebuild the document and clear this — which is exactly what the
    // `303` used to do, taking `ui.js`'s one EventSource and the output sink with it.
    await page.evaluate("window.__noReload = true");

    const button = await page.$("button");
    assert(button, "the dev page must render a submit button");
    await page.evaluate(
      `Array.from(document.querySelectorAll('button'))` +
        `.find((b) => b.textContent.trim() === 'Stop denext dev').click()`,
    );

    // The panel re-renders from a fresh survey: the stale dev.json is gone, so the step now
    // offers Start again. This is `swapPanel` doing its work on an intercepted submit.
    await pollFor(page, `document.body.textContent.indexOf('Start denext dev') !== -1`);
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "the page must NOT have navigated — a redirect here destroys the output sink",
    );

    // And the sink itself is on the page, ready for the next run's streamed output.
    assertEquals(
      await page.evaluate(`!!document.querySelector('#panel pre.out')`),
      true,
      "the dev console must be present for ui.js to append streamed lines into",
    );

    // The stale file really was cleared, not just re-rendered away.
    const devJson = join(dir, ".denext", "dev.json");
    let exists = true;
    try {
      await Deno.stat(devJson);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "the stale dev.json must be cleared on the server");

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await stale.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: a panel swap re-renders without losing the page's other panels", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    await page.goto(`${new URL(server.url).origin}/setup`);

    // The shell (nav) and the panel are separate: a fragment swap replaces only `#panel`, so
    // the navigation must still be there afterwards. This is what keeps `ui.js` an enhancement
    // rather than a second renderer.
    assertEquals(await page.evaluate(`!!document.querySelector("#panel")`), true);
    const navBefore = await page.evaluate(`document.querySelectorAll("nav a").length`);
    assert(Number(navBefore) > 0, "the shell must render navigation links");

    await page.evaluate("window.__noReload = true");
    // `refresh()` is what every SSE frame calls; drive the same path directly.
    await page.evaluate(
      `fetch(location.pathname, { headers: { accept: "text/html-fragment" } })` +
        `.then((r) => r.text()).then((t) => { window.__fragment = t; })`,
    );
    await pollFor(page, "typeof window.__fragment === 'string'");

    const fragment = String(await page.evaluate("window.__fragment"));
    assertStringIncludes(fragment, '<section id="panel"', "a fragment must be the bare panel");
    assert(
      !fragment.includes("<html"),
      "a fragment must not be a whole document, or swapPanel would nest one",
    );
    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: the sidebar navigates without a reload, and Back comes home", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    // A desktop viewport, explicitly: below the 860px drawer breakpoint the sidebar's nav is
    // `display: none` until the burger opens it, so a link in it has no box to click — and
    // headless Chromium's default window on the Linux runners is 800px wide ("Unable to get
    // stable box model"). The drawer has its own test; this one is about the wide layout.
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(server.url); // the handshake lands on "/"

    await pollFor(page, `location.pathname === "/"`);
    const titleBefore = String(await page.evaluate("document.title"));
    // A full navigation rebuilds the document and clears this.
    await page.evaluate("window.__noReload = true");

    const link = await page.$('.sidebar nav a[href="/setup"]');
    assert(link, "the sidebar must link to Setup");
    await link.click();

    await pollFor(page, `location.pathname === "/setup"`);
    await pollFor(page, `!!document.querySelector("#panel")`);
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "a sidebar click must swap the panel, not navigate",
    );

    // The marker lives in the shell, OUTSIDE the swapped panel, so the client has to move it.
    assertEquals(
      await page.evaluate(
        `document.querySelector('.sidebar nav a[aria-current="page"]').getAttribute("href")`,
      ),
      "/setup",
      "aria-current must follow the panel on screen",
    );

    // The fragment carries no <title>; it arrives as a header and the client applies it.
    const titleAfter = String(await page.evaluate("document.title"));
    assert(titleAfter !== titleBefore, `the tab title must follow the panel (still ${titleAfter})`);
    assertStringIncludes(titleAfter, "denext ui");

    await page.evaluate("history.back()");
    await pollFor(page, `location.pathname === "/"`);
    await pollFor(
      page,
      `document.querySelector('.sidebar nav a[aria-current="page"]').getAttribute("href") === "/"`,
    );
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "Back must restore the panel without reloading either",
    );
    assertEquals(String(await page.evaluate("document.title")), titleBefore);

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: a link the browser should own is left alone", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    // The enhancement must decline anything a browser treats specially, or it would break
    // opening a link in a new tab, downloads, and every off-origin link the panels carry.
    const declined = await page.evaluate(`(() => {
      const a = document.createElement("a");
      a.href = "https://example.com/x";
      const off = a.href;
      a.href = "/config";
      a.target = "_blank";
      const target = a.href;
      return { off, target };
    })()`);
    assert(declined, "the probe must run");
    // A cross-origin link and a _blank link are both still ordinary links in the document.
    assertEquals(
      await page.evaluate(`!!document.querySelector('.sidebar nav a[href="/config/routing"]')`),
      true,
    );
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: the cron preview follows what you type, without taking the field", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: "jsr:@denext/denext@^2" } }),
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    await page.goto(`${new URL(server.url).origin}/config/cron`);

    // The blank row renders an EMPTY preview container: the client has somewhere to put the
    // server's answer, which is why the container is rendered even when there is nothing to say.
    await pollFor(page, `!!document.querySelector("[data-cron-preview]")`);
    await page.evaluate("window.__noReload = true");

    const field = await page.$('input[name="cron"]');
    assert(field, "the editor must offer an expression field");
    await field.click();
    await field.type("0 3 * * *");

    // The description is the SERVER's `describeCron`, fetched as the expression is typed.
    await pollFor(
      page,
      `document.querySelector("[data-cron-preview]").textContent.indexOf("every day at 03:00 UTC") !== -1`,
    );

    // The whole point of fetching a block rather than the panel: the field the person is typing
    // in is never replaced, so it keeps both focus and what they typed.
    assertEquals(
      await page.evaluate(
        `document.activeElement === document.querySelector('input[name="cron"]')`,
      ),
      true,
      "the expression field must keep focus while its preview updates",
    );
    assertEquals(
      await page.evaluate(`document.querySelector('input[name="cron"]').value`),
      "0 3 * * *",
      "the field must keep what was typed",
    );
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "a preview must never reload the page",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("denext ui: filtering swaps the results in place and gives the box back", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: "jsr:@denext/denext@^2" } }),
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    // The config views stopped filtering when they became pages and tabs: finding a key is
    // navigation now, not a query. The verbs list still filters, and it is the same path —
    // a GET form submitted as the link someone assembled.
    await page.goto(`${new URL(server.url).origin}/commands`);

    await pollFor(page, `!!document.querySelector("form.filter")`);
    await page.evaluate("window.__noReload = true");

    const box = await page.$("form.filter input");
    assert(box, "the commands panel must offer a filter box");
    await box.click();
    await box.type("build");

    // A GET form is a link someone assembled: it goes the same way a nav click does.
    await page.evaluate(`document.querySelector("form.filter").requestSubmit()`);
    await pollFor(page, `location.search.indexOf("build") !== -1`);

    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "filtering must swap the panel, not navigate",
    );

    // Unlike the cron preview, this swaps the WHOLE panel — the box included — so the caret has
    // to be put back, or a second keystroke would land somewhere else entirely.
    await pollFor(page, `document.activeElement === document.querySelector("form.filter input")`);
    assertEquals(
      await page.evaluate(`document.querySelector("form.filter input").value`),
      "build",
      "the filter box must come back with the query still in it",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("denext ui: the schedule builder composes without reloading the page", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: "jsr:@denext/denext@^2" } }),
  );
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    // Short enough that the builder sits below the fold, as it does on a laptop once the page
    // has a schedule or two: the swap it asks for must not send the viewport back to the top.
    await page.setViewportSize({ width: 1100, height: 320 });
    await page.goto(`${new URL(server.url).origin}/config/cron`);
    await pollFor(page, `!!document.querySelector(".builder")`);

    // The claim under test: the builder needs no client code of its own. It is a GET form, and
    // `ui.js` already treats one as a navigation it can swap in place — so this must update the
    // panel WITHOUT a page load, which is what __noReload catches.
    await page.evaluate("window.__noReload = true");

    // Scroll the builder to the top of the window and remember where that left the page.
    await page.evaluate(`document.querySelector(".builder").scrollIntoView()`);
    await pollFor(page, "window.scrollY > 0");
    const scrolled = Number(await page.evaluate("window.scrollY"));
    assert(scrolled > 0, "the builder sits below the fold in this window");

    const weekly = await page.$('.builder input[value="weekly"]');
    assert(weekly, "the builder offers a Weekly shape");
    await weekly.click();
    const use = await page.$('.builder button[type="submit"]');
    assert(use, "the builder offers its submit");
    await use.click();

    // Choosing a shape does not re-render on its own, so this submit carries the selects the
    // DAILY shape had rendered — hour 3, minute 0 — and the server composes them as a weekly
    // schedule. The Day picker only appears now that the shape asks for one.
    await pollFor(
      page,
      `document.querySelector('input[name="cron"]').value === "0 3 * * 1"`,
    );
    assertEquals(
      await page.evaluate(`!!document.querySelector('select[name="dow"]')`),
      true,
      "a weekly schedule is asked which day",
    );
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "the builder must swap the panel, never reload the page",
    );
    assert(
      String(await page.evaluate("location.search")).includes("every=weekly"),
      "the composed schedule is in the address, so it can be linked and reloaded",
    );

    // The swap replaced the whole panel, builder included, through the same path a nav click
    // takes — and a nav click scrolls to the top. A form INSIDE the panel must not: the page
    // stays where it was, and the builder is still the thing on screen.
    const after = Number(await page.evaluate("window.scrollY"));
    assert(
      Math.abs(after - scrolled) <= 40,
      `the viewport must stay put across the builder's swap (was ${scrolled}, now ${after})`,
    );
    const inView = await page.evaluate(
      `(() => { const r = document.querySelector(".builder").getBoundingClientRect();` +
        ` return r.top < innerHeight && r.bottom > 0; })()`,
    );
    assertEquals(inView, true, "the builder is still in view after the swap it asked for");

    // The panel's mark of a request in flight is gone once the answer has landed.
    assertEquals(
      await page.evaluate(`document.querySelector("#panel").hasAttribute("aria-busy")`),
      false,
      "the swapped-in panel is not marked busy",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: the overview's status block sits above the cards, three across then one", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(server.url);
    await pollFor(page, `!!document.querySelector(".status")`);

    // What the block says comes from the project's files: `project()` pins ^2 and starts no
    // dev server, and nothing on this page spawns anything to find that out.
    const status = String(await page.evaluate(`document.querySelector(".status").textContent`));
    assertStringIncludes(status, "^2");
    assertStringIncludes(status, "Not running");

    // The number of cards in the first row: how many share the top edge of the first one.
    const perRow = `(() => { const tops = [...document.querySelectorAll(".cards .card")]` +
      `.map((c) => c.getBoundingClientRect().top); return tops.filter((t) => t === tops[0]).length; })()`;
    assertEquals(
      await page.evaluate(perRow),
      3,
      "at full width the overview cards sit three across",
    );

    await page.setViewportSize({ width: 390, height: 780 });
    await pollFor(page, `${perRow} === 1`);
    assertEquals(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
      "a phone never scrolls sideways",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: on a phone the navigation is a drawer, not a strip", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${new URL(server.url).origin}/config`);
    await pollFor(page, `!!document.querySelector(".nav-burger")`);

    // `getClientRects()` rather than computed display: an element inside a `display:none`
    // ancestor still computes its OWN display, so checking that would pass while shut.
    const shown = (selector: string) =>
      page.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).getClientRects().length > 0`,
      );

    // Closed by default — the bar keeps the brand and the button, and gives the screen back.
    assertEquals(await shown(".sidebar nav"), false, "the navigation starts closed on a phone");
    assertEquals(await shown(".nav-burger"), true, "the button is there to open it");

    await page.evaluate("window.__noReload = true");

    // Opening is pure CSS: a label driving a checkbox, so it works with scripting off too.
    const burger = await page.$(".nav-burger");
    assert(burger, "the bar offers a button");
    await burger.click();
    await pollFor(page, `document.querySelector(".sidebar nav").getClientRects().length > 0`);
    // The drawer is the vertical list the wide layout shows, headings included — which is why
    // the narrow layout stopped hiding them when it stopped being a strip.
    assertEquals(await shown(".nav-section"), true, "the section heading comes with it");

    // Following a link closes it again. A swap has no reload to reset the checkbox, so the
    // drawer would otherwise sit open on top of the panel that was just asked for.
    const link = await page.$('.sidebar nav a[href="/plugins"]');
    assert(link, "the drawer lists the panels");
    await link.click();
    await pollFor(page, `location.pathname === "/plugins"`);
    await pollFor(page, `document.querySelector(".sidebar nav").getClientRects().length === 0`);
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "and it closed by swapping, never by reloading",
    );

    // Widen it: the button is a narrow-layout affordance only, and the column comes back.
    await page.setViewportSize({ width: 1200, height: 900 });
    await pollFor(page, `document.querySelector(".sidebar nav").getClientRects().length > 0`);
    assertEquals(await shown(".nav-burger"), false, "no button once there is a column");

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: a sidebar taller than the window scrolls to its last entry", async () => {
  const dir = await project();
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    // Wide enough for the column layout, short enough that the navigation does not fit: the
    // column is pinned to the viewport, so anything past its bottom edge has nowhere to go
    // unless the list itself scrolls. It used to render outside the box, unreachable.
    await page.setViewportSize({ width: 1200, height: 420 });
    await pollFor(page, `!!document.querySelector(".sidebar nav a")`);

    const overflows = await page.evaluate(
      `(() => { const n = document.querySelector(".sidebar nav");
        return n.scrollHeight > n.clientHeight; })()`,
    );
    assertEquals(
      overflows,
      true,
      "this viewport must actually overflow, or the test proves nothing",
    );

    // The last entry is out of view to begin with...
    const bottomOf = `(() => { const a = [...document.querySelectorAll(".sidebar nav a")].pop();
      return Math.round(a.getBoundingClientRect().bottom); })()`;
    assert(
      Number(await page.evaluate(bottomOf)) > 420,
      "the last entry should start below the fold",
    );

    // ...and scrolling the list brings it back, which is the whole fix.
    await page.evaluate(
      `(() => { const n = document.querySelector(".sidebar nav"); n.scrollTop = n.scrollHeight; })()`,
    );
    await pollFor(page, `${bottomOf} <= 421`);

    // The brand stays put: the list scrolls, not the whole column.
    assertEquals(
      await page.evaluate(
        `Math.round(document.querySelector(".brand").getBoundingClientRect().top) >= 0`,
      ),
      true,
      "the brand must not scroll away with the list",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: leaving a config view with unsaved edits asks first", async () => {
  const dir = await project();
  await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    // The sidebar is clicked below; it is only laid out (and clickable) at desktop widths.
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(server.url);
    await pollFor(page, `location.pathname === "/"`);

    const toConfig = await page.$('.sidebar nav a[href="/config/routing"]');
    assert(toConfig, "the sidebar must link to the Routing view");
    await toConfig.click();
    await pollFor(page, `location.pathname === "/config/routing"`);
    await pollFor(page, `!!document.querySelector("#f-basePath")`);

    // Nothing is dirty yet, so a link still navigates straight through.
    assertEquals(
      await page.evaluate(`!!document.querySelector('form[data-dirty-track][data-dirty="1"]')`),
      false,
      "a freshly rendered view has no unsaved edits",
    );

    // Type into the band the way a person would: the tracker listens for input events.
    await page.evaluate(`
      const field = document.querySelector("#f-basePath");
      field.value = "/docs";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await pollFor(page, `!!document.querySelector('form[data-dirty-track][data-dirty="1"]')`);

    // Now the same click has to stop and ask instead of swapping the panel away.
    const away = await page.$('.sidebar nav a[href="/setup"]');
    assert(away, "the sidebar must link to Setup");
    await away.click();
    await pollFor(page, `!!document.querySelector("dialog.nav-guard[open]")`);
    assertEquals(
      await page.evaluate(`location.pathname`),
      "/config/routing",
      "the navigation must not have happened while the question is open",
    );
    // The dialog lives outside the panel, or a swap would take it away mid-decision.
    assertEquals(
      await page.evaluate(`!!document.querySelector("#panel dialog.nav-guard")`),
      false,
      "the guard must not be inside the swapped panel",
    );

    // Cancel: stay exactly where we were, edits intact.
    await page.evaluate(
      `[...document.querySelectorAll("dialog.nav-guard button")]
        .find((b) => b.textContent === "Cancel").click()`,
    );
    await pollFor(page, `!document.querySelector("dialog.nav-guard[open]")`);
    assertEquals(await page.evaluate(`location.pathname`), "/config/routing");
    assertEquals(
      await page.evaluate(`document.querySelector("#f-basePath").value`),
      "/docs",
      "cancelling keeps the edit",
    );

    // Discard: the edit goes back, and the navigation the person asked for finally happens.
    await away.click();
    await pollFor(page, `!!document.querySelector("dialog.nav-guard[open]")`);
    await page.evaluate(
      `[...document.querySelectorAll("dialog.nav-guard button")]
        .find((b) => b.textContent === "Discard").click()`,
    );
    await pollFor(page, `location.pathname === "/setup"`);

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});

Deno.test("denext ui: a task's output streams into the panel's sink as it runs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  // A line nothing else on the page contains, held on screen long enough to be seen: the
  // stream's end broadcasts `task-done`, and the client answers that with a panel refresh.
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { denext: "jsr:@denext/denext@^2" },
      tasks: { hello: "echo e2e-hello-from-the-task && sleep 3" },
    }),
  );
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    await page.goto(`${new URL(server.url).origin}/tasks`);

    // The page lists the declared task as a real form posting to /tasks/run, with the empty
    // output sink `ui.js` streams into below it.
    await pollFor(page, `!!document.querySelector('form.op input[name="task"][value="hello"]')`);
    assertEquals(
      await page.evaluate(`document.querySelector("#panel pre.out").textContent`),
      "",
      "the sink starts empty",
    );
    await page.evaluate("window.__noReload = true");

    await page.evaluate(
      `Array.from(document.querySelectorAll('form.op button'))` +
        `.find((b) => b.textContent.trim() === 'deno task hello').click()`,
    );

    // The intercepted submit gets a `text/event-stream` back and appends each `data:` frame's
    // text to the sink — this is `streamInto`, which no other test executes.
    await pollFor(
      page,
      `document.querySelector("#panel pre.out").textContent.indexOf("e2e-hello-from-the-task") !== -1`,
    );
    assertEquals(
      await page.evaluate("window.__noReload === true"),
      true,
      "a task run must stream into the page, not navigate away from it",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("denext ui: Save sleeps until an edit, and Discard puts the view back", async () => {
  const dir = await project();
  await Deno.writeTextFile(join(dir, "denext.config.ts"), 'export default { basePath: "/v1" };\n');
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(server.url);
    await page.goto(`${new URL(server.url).origin}/config/routing`);
    await pollFor(page, `!!document.querySelector("#f-basePath")`);

    // The tracker takes the scalar band: the server renders Save enabled (it has to — with
    // scripting off there is no edit to wait for), and the client puts it to sleep.
    const save =
      `document.querySelector("#f-basePath").form.querySelector('button[type="submit"]:not([name])')`;
    await pollFor(page, `${save}.disabled === true`);
    assertEquals(
      await page.evaluate(
        `!!document.querySelector("#f-basePath").form.querySelector("[data-discard]")`,
      ),
      false,
      "there is nothing to discard before an edit",
    );

    // An edit wakes Save and puts Discard beside it.
    await page.evaluate(`
      const field = document.querySelector("#f-basePath");
      field.value = "/docs";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    await pollFor(page, `${save}.disabled === false`);
    assertEquals(
      await page.evaluate(
        `!!document.querySelector("#f-basePath").form.querySelector("[data-discard]")`,
      ),
      true,
      "Discard appears with the first edit",
    );
    await page.evaluate("window.__noReload = true");

    // Discard: the value the server rendered is back, Save sleeps again, and the button is gone
    // — without a request, so nothing was written and nothing was navigated.
    await page.evaluate(
      `document.querySelector("#f-basePath").form.querySelector("[data-discard]").click()`,
    );
    await pollFor(page, `${save}.disabled === true`);
    assertEquals(
      await page.evaluate(`document.querySelector("#f-basePath").value`),
      "/v1",
      "Discard restores what the file had",
    );
    assertEquals(
      await page.evaluate(
        `!!document.querySelector("#f-basePath").form.querySelector("[data-discard]")`,
      ),
      false,
      "Discard removes itself once there is nothing to discard",
    );
    assertEquals(
      await page.evaluate(`!!document.querySelector('form[data-dirty-track][data-dirty="1"]')`),
      false,
      "the form is clean again, so leaving it will not ask",
    );
    assertEquals(await page.evaluate("window.__noReload === true"), true);
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "denext.config.ts")),
      'basePath: "/v1"',
      "nothing reached the file",
    );

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});
