// launchManagedBrowser's close() closes every page first, each awaiting its own DevTools socket:
// astral's Browser.close() kills a local Chromium and leaves the pages' sockets to close from
// Chromium's end after it returns, which a one-CPU run's leak sanitizer reported as a leaked
// WebSocket (the unbundled SPA HMR e2e).

import { assertEquals } from "@std/assert";
import type { Browser } from "@astral/astral";
import { closePages } from "../src/profile/browser.ts";

/** A page whose close() takes a turn to settle, recording that it finished. */
function fakePage(log: string[], name: string, fails = false) {
  return {
    close: async () => {
      await new Promise((r) => setTimeout(r, 5));
      if (fails) throw new Error(`Page has already been closed (${name})`);
      log.push(`${name} closed`);
    },
  };
}

Deno.test("closePages: every open page's close is awaited before it returns", async () => {
  const log: string[] = [];
  const pages = [fakePage(log, "a"), fakePage(log, "b")];
  await closePages({ pages } as unknown as Pick<Browser, "pages">);
  log.push("returned");
  assertEquals(log, ["a closed", "b closed", "returned"]);
});

Deno.test("closePages: a page already closed doesn't stop the others", async () => {
  const log: string[] = [];
  const pages = [fakePage(log, "gone", true), fakePage(log, "open")];
  await closePages({ pages } as unknown as Pick<Browser, "pages">);
  assertEquals(log, ["open closed"]);
});

Deno.test("closePages: iterates a copy (a closing page leaves astral's list)", async () => {
  const log: string[] = [];
  const pages: { close: () => Promise<void> }[] = [];
  for (const name of ["x", "y", "z"]) {
    const page = {
      close: async () => {
        pages.splice(pages.indexOf(page), 1); // as astral's Page.close() does
        await Promise.resolve();
        log.push(name);
      },
    };
    pages.push(page);
  }
  await closePages({ pages } as unknown as Pick<Browser, "pages">);
  assertEquals(log, ["x", "y", "z"]);
  assertEquals(pages.length, 0);
});
