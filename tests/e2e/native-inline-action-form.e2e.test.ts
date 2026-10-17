// Real-browser e2e: a native App Router page's inline Server Actions
// (tests/helpers/native-action-form-fixture.ts) — a plain one, one that closes over a component
// local, and a `"use server"` export bound with `.bind(null, …)`.
//   - JavaScript off: each form posts to its endpoint, the action runs, and the 303 brings the
//     browser back to the re-rendered page.
//   - JavaScript on, beside a client component: the hydrated client submits the forms itself (no
//     page load) and the list re-renders.
//   - No client JavaScript the build wrote or the page loaded carries an action's body or a bound
//     value.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Page } from "@astral/astral";
import { forgetTaggedServers } from "../../src/runtime/server-action.ts";
import { writeNativeActionFormFixture } from "../helpers/native-action-form-fixture.ts";
import {
  assertNoConsoleErrors,
  buildAndServe,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
} from "./harness.ts";

/** Strings only the actions' bodies and bound values hold. */
const SERVER_ONLY = ['"inline:"', "closed-", "tag-xyz"];

/**
 * Fill `#<form> input[name=title]` and submit it: by clicking its button, or (`click: false`) by
 * `requestSubmit` in the same task as the fill, so a re-render the previous action's refresh
 * started can't replace the input between the two.
 */
async function submitTitle(page: Page, form: string, title: string, click = true) {
  const fill = `document.querySelector('#${form} input[name=title]').value = ${
    JSON.stringify(title)
  }`;
  if (!click) {
    return void await page.evaluate(`${fill}; document.getElementById("${form}").requestSubmit()`);
  }
  await page.evaluate(fill);
  await (await page.$(`#${form} button`))!.click();
}

const itemsInclude = (text: string) =>
  `!!document.getElementById("items") && ` +
  `document.getElementById("items").textContent.includes(${JSON.stringify(text)})`;

/** Assert no client file the build wrote holds a server-only string. */
async function assertNoActionBodyShipped(dir: string): Promise<void> {
  const clientDir = join(dir, ".denext", "client");
  for await (const entry of Deno.readDir(clientDir)) {
    if (!entry.isFile || !entry.name.endsWith(".js")) continue;
    const js = await Deno.readTextFile(join(clientDir, entry.name));
    for (const s of SERVER_ONLY) assert(!js.includes(s), `${entry.name} ships ${s}`);
  }
}

Deno.test({
  name: "e2e: native inline Server Actions work with JavaScript off",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_inline_e2e_" });
  await writeNativeActionFormFixture(dir, { closure: true });
  const browser = await launchBrowser();
  try {
    const server = await buildAndServe(dir);
    try {
      const html = await (await fetch(server.origin + "/")).text();
      for (const form of ["inline", "closure", "bound"]) {
        const re = new RegExp(`<form id="${form}" action="/_denext/action/[^"]+" method="post">`);
        assert(re.test(html), `the ${form} form posts to its endpoint`);
      }
      const page = await browser.newPage();
      // deno-lint-ignore no-explicit-any
      const cdp = page.unsafelyGetCelestialBindings() as any;
      await cdp.Emulation.setScriptExecutionDisabled({ value: true });
      await page.goto(`${server.origin}/`, { waitUntil: "load" });
      for (const form of ["inline", "closure", "bound"]) {
        const navigated = page.waitForNavigation({ waitUntil: "load" });
        await submitTitle(page, form, `${form}-without-js`);
        await navigated;
        assertEquals(new URL(page.url).pathname, "/", "back on the page after the post");
      }
      const after = await page.content();
      assert(after.includes("inline:inline-without-js"), "the inline action ran");
      // The closure's form was rendered with no item listed: it bound "closed-0"; the next
      // render binds "closed-1" (one item), and so on.
      assert(after.includes("closed-1:closure-without-js"), "the closure ran with its value");
      assert(after.includes("tag-xyz:bound-without-js"), "the bound export ran with its value");
      await page.close();
      await assertNoActionBodyShipped(dir);
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "e2e: native inline Server Actions beside a client component submit through the client",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_native_inline_island_e2e_" });
  await writeNativeActionFormFixture(dir, { island: true, closure: true });
  const browser = await launchBrowser();
  try {
    const server = await buildAndServe(dir);
    try {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      await page.goto(`${server.origin}/`, { waitUntil: "load" });
      // Hydrated: the client counter responds (clicked on each poll until it does).
      const count = `document.getElementById("count")`;
      await pollFor(page, `!!${count} && (${count}.click(), ${count}.textContent !== "0")`);
      const clicked = await page.evaluate(`${count}.textContent`);
      await page.evaluate("window.__noReload = true");
      await submitTitle(page, "inline", "inline-by-the-client", false);
      await pollFor(page, itemsInclude("inline:inline-by-the-client"));
      await submitTitle(page, "closure", "closure-by-the-client", false);
      await pollFor(page, itemsInclude(":closure-by-the-client"));
      await submitTitle(page, "bound", "bound-by-the-client", false);
      await pollFor(page, itemsInclude("tag-xyz:bound-by-the-client")).catch(async (err) => {
        const items = await page.evaluate(`document.getElementById("items")?.textContent`);
        const form = await page.evaluate(`document.getElementById("bound")?.outerHTML`);
        throw new Error(`${err.message}\nitems: ${items}\nform: ${form}\nerrors: ${errors}`);
      });
      assert(
        await page.evaluate("window.__noReload === true"),
        "the hydrated client ran the actions without a page load",
      );
      assertEquals(await page.evaluate(`${count}.textContent`), clicked, "state kept");
      assertNoConsoleErrors(errors);
      // Every script the page loaded, and every client file the build wrote, is free of them.
      const loaded = JSON.parse(
        await page.evaluate(
          `JSON.stringify(performance.getEntriesByType("resource").map((e) => e.name)` +
            `.filter((n) => /\\.js(\\?|$)/.test(n)))`,
        ) as string,
      ) as string[];
      assert(loaded.length > 0, "the page loaded its client scripts");
      for (const url of loaded) {
        const js = await (await fetch(url)).text();
        for (const s of SERVER_ONLY) assert(!js.includes(s), `${url} ships ${s}`);
      }
      await page.close();
      await assertNoActionBodyShipped(dir);
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
