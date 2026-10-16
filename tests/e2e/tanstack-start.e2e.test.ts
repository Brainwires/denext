// Networked e2e for examples/tanstack-start: TanStack Start's shape server-rendered by the
// `@denext/tanstack-start` plugin, end to end through the real CLI — `deno install` →
// `denext build` → `denext start` — then a real Chromium. The plugin generates the route tree,
// every page arrives server-rendered (its loader ran on the server, the document is the root
// route's `shellComponent`), the browser hydrates it (a click updates state) without
// re-rendering, a <Link> click is a client navigation that runs the next route's loader in the
// browser, and a deep URL arrives rendered.
//
// Opt-in + NETWORK-REQUIRED (`deno install` fetches @tanstack/react-router from npm):
// `deno task test:e2e`. Skipped automatically if the install can't reach npm.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  assertNoConsoleErrors,
  collectConsoleErrors,
  launchBrowser,
  runDeno,
  startCliServer,
} from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/tanstack-start", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

Deno.test({
  name: "e2e: examples/tanstack-start server-renders and hydrates a TanStack Start app",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const install = await runDeno(["install"], EXAMPLE, 180_000);
  if (!install.ok) {
    console.warn("e2e: `deno install` failed (npm unreachable?) — skipping.\n" + install.out);
    return;
  }
  const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, 240_000);
  assert(built.ok, "denext build failed:\n" + built.out);

  const server = await startCliServer(EXAMPLE, 60_000);
  try {
    await t.step("a page arrives server-rendered, with the client entry", async () => {
      const html = await (await fetch(server.origin + "/posts/3")).text();
      assert(html.startsWith("<!DOCTYPE html><html"), "the shellComponent is the document");
      assertStringIncludes(
        html,
        "<title>The plugin owns the route tree</title>",
        "the route's head",
      );
      assertStringIncludes(
        html,
        "<h1>The plugin owns the route tree</h1>",
        "the loader ran on the server",
      );
      assertStringIncludes(html, '<script type="module" src="/_tss/client.js"');
      assertEquals((await fetch(server.origin + "/_tss/client.js")).status, 200);
    });

    const browser = await launchBrowser();
    try {
      await t.step("the browser hydrates the document, then navigates on the client", async () => {
        const page = await browser.newPage(server.origin + "/");
        const errors = collectConsoleErrors(page);
        await page.waitForSelector("#home", { timeout: 20_000 });
        await page.evaluate(() => {
          (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
        });
        // Hydrated: the server's button now answers clicks.
        for (let i = 0; i < 100; i++) {
          await page.evaluate(() => (document.querySelector("#count") as HTMLElement).click());
          const text = await page.evaluate(() => document.querySelector("#count")!.textContent);
          if (text !== "clicked 0") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assertStringIncludes(
          await page.evaluate(() => document.querySelector("#count")!.textContent ?? ""),
          "clicked",
        );
        assert(
          await page.evaluate(() => document.querySelector("#count")!.textContent !== "clicked 0"),
          "the hydrated button updates its state",
        );
        assertEquals(
          await page.evaluate(() => document.querySelector("#rendered-on")!.textContent),
          "loader ran on the server",
          "hydration reused the server's loader data",
        );
        const posts = await page.$('nav a[href="/posts"]');
        assert(posts, "the nav renders the Posts link");
        await posts.click();
        await page.waitForSelector("#posts", { timeout: 15_000 });
        const state = await page.evaluate(() => ({
          path: location.pathname,
          sameDocument:
            (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument === true,
          items: document.querySelectorAll("#posts li").length,
        }));
        assertEquals(state, { path: "/posts", sameDocument: true, items: 3 });
        const post = await page.$('#posts a[href="/posts/2"]');
        assert(post, "the posts list links to /posts/2");
        await post.click();
        await page.waitForSelector("#post", { timeout: 15_000 });
        assertStringIncludes(
          await page.evaluate(() => document.querySelector("#post")!.textContent ?? ""),
          "Then the router takes over",
        );
        assertNoConsoleErrors(errors);
        await page.close();
      });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
