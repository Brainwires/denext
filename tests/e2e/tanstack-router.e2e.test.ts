// Networked e2e for examples/tanstack-router: a stock file-based TanStack Router app in denext
// SPA mode (library mode — no plugin), end to end through the real CLI — `deno install` →
// `denext build` → `denext start` — then a real Chromium: the shell mounts `#app`, the
// router renders the home route, a <Link> click is a same-document navigation, a deep URL
// gets the history-API fallback shell and renders its route, and an unknown URL renders
// TanStack's not-found UI. Locks the reconciler fix this example surfaced: a Suspense
// boundary that suspended on mount (TanStack's class CatchBoundary waiting on the lazy
// class runtime) must still reveal after a parent re-render in the pending window.
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

const EXAMPLE = fromFileUrl(new URL("../../examples/tanstack-router", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;

Deno.test({
  name: "e2e: examples/tanstack-router runs a file-based TanStack Router app in SPA mode",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const install = await runDeno(["install"], EXAMPLE, INSTALL_TIMEOUT_MS);
  if (!install.ok) {
    console.warn(
      "e2e: `deno install` failed (npm unreachable / offline?) — skipping.\n" + install.out,
    );
    return;
  }
  const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
  assert(built.ok, "denext build failed:\n" + built.out);

  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step(
      "the shell mounts #app (spa.rootId) and every extensionless URL gets it",
      async () => {
        const home = await (await fetch(server.origin + "/")).text();
        assertStringIncludes(home, '<div id="app"><p class="boot">Loading…</p></div>');
        assertStringIncludes(home, '<script type="module" src="/_denext/client/index.js">');
        const deep = await fetch(server.origin + "/posts/2");
        assertEquals(deep.status, 200);
        assertStringIncludes(await deep.text(), '<div id="app">');
      },
    );

    const browser = await launchBrowser();
    try {
      await t.step("home renders, a <Link> click navigates without a document load", async () => {
        const page = await browser.newPage(server.origin + "/");
        const errors = collectConsoleErrors(page);
        await page.waitForSelector("#home", { timeout: 20_000 });
        await page.evaluate(() => {
          (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
        });
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
          "Loaders run in the browser",
        );
        assertNoConsoleErrors(errors);
        await page.close();
      });

      await t.step("a deep URL renders its route through the fallback shell", async () => {
        const page = await browser.newPage(server.origin + "/posts/3");
        const errors = collectConsoleErrors(page);
        await page.waitForSelector("#post", { timeout: 20_000 });
        assertStringIncludes(
          await page.evaluate(() => document.querySelector("#post h1")!.textContent ?? ""),
          "One codegen step",
        );
        assertNoConsoleErrors(errors);
        await page.close();
      });

      await t.step("an unknown URL renders the router's not-found UI", async () => {
        const page = await browser.newPage(server.origin + "/nope");
        await page.waitForSelector("#not-found", { timeout: 20_000 });
        const missing = await browser.newPage(server.origin + "/posts/999");
        await missing.waitForSelector("#post-missing", { timeout: 20_000 });
        await page.close();
        await missing.close();
      });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
