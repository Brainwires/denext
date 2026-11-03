// Real-browser e2e: a next-compat page's Server Component `<form action={serverAction}>`, for an
// action exported from a "use server" module and for an inline one.
//   - An app with NO "use client" module: the form carries the action endpoint, and a
//     JavaScript-disabled submit runs the action and comes back to the re-rendered page.
//   - An app whose page also renders a client component: with JavaScript on, the hydrated
//     client submits the form itself (no page load) and the list re-renders.
// Both check that the root layout's <html>/<body> are the document's own tags (their attributes
// on them), never nested inside the page container.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import type { Page } from "@astral/astral";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { forgetTaggedServers } from "../../src/runtime/server-action.ts";
import { writeActionFormFixture } from "../helpers/next-compat-action-form-fixture.ts";
import {
  assertNoConsoleErrors,
  buildAndServe,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
} from "./harness.ts";

/** The served HTML's document shape: one <html>, the page container holding no document tag. */
async function assertDocumentShape(origin: string): Promise<void> {
  const html = await (await fetch(origin + "/")).text();
  assertEquals(html.match(/<html[\s>]/g)?.length, 1, "exactly one <html> tag");
  assertEquals(html.match(/<body[\s>]/g)?.length, 1, "exactly one <body> tag");
  assert(html.includes('<html lang="fr" class="dark">'), "the layout's <html> attributes");
  assert(html.includes('<body class="shell">'), "the layout's <body> attributes");
  for (const id of ["exported", "inline"]) {
    const form = new RegExp(`<form id="${id}" action="/_denext/action/[^"]+" method="post">`);
    assert(form.test(html), `the ${id} action's form posts to its endpoint`);
  }
}

/**
 * Submit `title` through the form `#form`, filled through the DOM: by clicking its button, or
 * (`click: false`) by `requestSubmit` — the same submit event, with no click coordinates to go
 * stale while a refresh is moving the page around.
 */
async function submitTitle(page: Page, title: string, form = "exported", click = true) {
  await page.evaluate(
    `document.querySelector('#${form} input[name=title]').value = ${JSON.stringify(title)}`,
  );
  if (click) return void await (await page.$(`#${form} button`))!.click();
  await page.evaluate(`document.getElementById("${form}").requestSubmit()`);
}

const itemsInclude = (title: string) =>
  `!!document.getElementById("items") && ` +
  `document.getElementById("items").textContent.includes(${JSON.stringify(title)})`;

Deno.test({
  name: "e2e: next-compat Server Action form with no client module works with JavaScript off",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncform_e2e_" });
  await writeActionFormFixture(dir, false);
  const browser = await launchBrowser();
  try {
    const server = await buildAndServe(dir);
    try {
      await assertDocumentShape(server.origin);
      const page = await browser.newPage();
      // deno-lint-ignore no-explicit-any
      const cdp = page.unsafelyGetCelestialBindings() as any;
      await cdp.Emulation.setScriptExecutionDisabled({ value: true });
      await page.goto(`${server.origin}/`, { waitUntil: "load" });
      for (const form of ["exported", "inline"]) {
        const navigated = page.waitForNavigation({ waitUntil: "load" });
        await submitTitle(page, `${form}-without-js`, form);
        await navigated;
        // The browser posted to the action endpoint and followed its redirect to the page.
        assertEquals(new URL(page.url).pathname, "/", "back on the page after the post");
      }
      const after = await page.content();
      assert(after.includes("exported-without-js"), "the exported action's item is listed");
      assert(after.includes("inline:inline-without-js"), "the inline action's item is listed");
      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    await stopNextCompat();
    // Both apps' action modules share the id `app/actions.ts`: let the next one be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "e2e: next-compat Server Action form beside a client component submits through the client",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncform_island_e2e_" });
  await writeActionFormFixture(dir, true);
  const browser = await launchBrowser();
  try {
    const server = await buildAndServe(dir);
    try {
      await assertDocumentShape(server.origin);
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      await page.goto(`${server.origin}/`, { waitUntil: "load" });
      // Hydrated: the client counter responds (clicked on each poll until it does).
      const count = `document.getElementById("count")`;
      await pollFor(page, `!!${count} && (${count}.click(), ${count}.textContent !== "0")`);
      const clicked = await page.evaluate(`${count}.textContent`);
      assertEquals(await page.evaluate(`document.documentElement.lang`), "fr");
      assertEquals(await page.evaluate(`document.body.className`), "shell");
      await page.evaluate("window.__noReload = true");
      await submitTitle(page, "posted-by-the-client", "exported", false);
      await pollFor(page, itemsInclude("posted-by-the-client"));
      await submitTitle(page, "inline-by-the-client", "inline", false);
      await pollFor(page, itemsInclude("inline:inline-by-the-client"));
      assert(
        await page.evaluate("window.__noReload === true"),
        "the hydrated client ran the action without a page load",
      );
      // The counter kept its state: the page was re-rendered in place, not reloaded.
      assertEquals(await page.evaluate(`${count}.textContent`), clicked);
      assertNoConsoleErrors(errors);
      await page.close();
    } finally {
      await server.close();
    }
  } finally {
    await browser.close();
    await stopNextCompat();
    // Both apps' action modules share the id `app/actions.ts`: let the next one be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
