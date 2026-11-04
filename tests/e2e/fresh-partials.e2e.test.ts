// Fresh Partials in a real browser: a migrated Fresh app (tests/helpers/fresh-parity-app.ts)
// built and served, then driven in headless Chromium. A `<button f-partial>` swaps the "recipe"
// region in place (no history entry), and an `f-client-nav` link with `f-partial` appends to the
// "list" region and pushes its `href` — the same document throughout, the island beside the
// regions still hydrated, and its `import.meta.env` showing the public variable, not the secret.
//
// Opt-in: run with `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { assertNoConsoleErrors, collectConsoleErrors, launchBrowser, pollFor } from "./harness.ts";
import { startCliServer } from "./harness.ts";
import { buildInChild } from "../helpers/bounded-build.ts";
import { PUBLIC_VALUE, SECRET_VALUE, writeFreshParityApp } from "../helpers/fresh-parity-app.ts";

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
