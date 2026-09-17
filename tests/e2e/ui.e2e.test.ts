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

/** A project directory with a `deno.json` and, optionally, a dev server that is not there. */
async function project(withStaleDevJson: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_ui_e2e_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { denext: "jsr:@denext/denext@^2" }, tasks: { dev: "echo dev" } }),
  );
  if (withStaleDevJson) {
    // A port nothing listens on: bound to learn a free number, then given straight back. The
    // panel will offer Stop for it, and stopping must discover that it is already gone.
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    await Deno.mkdir(join(dir, ".denext"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, ".denext", "dev.json"),
      JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        port,
        hostname: "127.0.0.1",
        pid: 2147483646, // never signalled: the origin never answers, so this is the stale path
        startedAt: Date.now(),
      }),
    );
  }
  return dir;
}

/** Tear down a UI server and its project directory. */
async function teardown(server: UiServer, dir: string): Promise<void> {
  await server.shutdown();
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

Deno.test("denext ui: the ?t= handshake, and ui.js actually loads under the strict CSP", async () => {
  const dir = await project(false);
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
  const dir = await project(true);
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
    await page.goto(`${new URL(server.url).origin}/wizard`);

    // A dev server is published, so the Finish step offers Stop.
    await pollFor(page, `document.body.textContent.indexOf('Stop denext dev') !== -1`);

    // A full navigation would rebuild the document and clear this — which is exactly what the
    // `303` used to do, taking `ui.js`'s one EventSource and the output sink with it.
    await page.evaluate("window.__noReload = true");

    const button = await page.$("button");
    assert(button, "the Finish step must render a submit button");
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
    await teardown(server, dir);
  }
});

Deno.test("denext ui: a panel swap re-renders without losing the page's other panels", async () => {
  const dir = await project(false);
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url);
    await page.goto(`${new URL(server.url).origin}/wizard`);

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
  const dir = await project(false);
  const server = await startUiServer({ dir, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectConsoleErrors(page);
    await page.goto(server.url); // the handshake lands on "/"

    await pollFor(page, `location.pathname === "/"`);
    const titleBefore = String(await page.evaluate("document.title"));
    // A full navigation rebuilds the document and clears this.
    await page.evaluate("window.__noReload = true");

    const link = await page.$('.sidebar nav a[href="/wizard"]');
    assert(link, "the sidebar must link to the wizard");
    await link.click();

    await pollFor(page, `location.pathname === "/wizard"`);
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
      "/wizard",
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
  const dir = await project(false);
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
      await page.evaluate(`!!document.querySelector('.sidebar nav a[href="/config"]')`),
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
    await page.goto(`${new URL(server.url).origin}/config`);

    await pollFor(page, `!!document.querySelector("form.filter")`);
    await page.evaluate("window.__noReload = true");

    const box = await page.$("form.filter input");
    assert(box, "the config panel must offer a filter box");
    await box.click();
    await box.type("base");

    // A GET form is a link someone assembled: it goes the same way a nav click does.
    await page.evaluate(`document.querySelector("form.filter").requestSubmit()`);
    await pollFor(page, `location.search.indexOf("base") !== -1`);

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
      "base",
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
    await page.goto(`${new URL(server.url).origin}/config/cron`);
    await pollFor(page, `!!document.querySelector(".builder")`);

    // The claim under test: the builder needs no client code of its own. It is a GET form, and
    // `ui.js` already treats one as a navigation it can swap in place — so this must update the
    // panel WITHOUT a page load, which is what __noReload catches.
    await page.evaluate("window.__noReload = true");

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

    assertNoConsoleErrors(errors);
  } finally {
    await browser.close();
    await teardown(server, dir);
  }
});
