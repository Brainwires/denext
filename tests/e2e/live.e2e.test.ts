// Real-browser e2e for examples/live: the four Live hooks over one WebSocket, driven across
// multiple tabs — behavior only a real browser + real socket can prove.
//   • useLive       — clicking +1 in one tab streams a fresh shared count to EVERY tab.
//   • usePresence   — each tab appears in the others' presence list; CLOSING a tab drops it
//                     (leave detection needs a real socket close, not a mock).
//   • useChannel    — a server push lands the announcement text in every tab at once, and
//   • useSubscription— the same click recomputes the "sent" count via a tag in every tab.
// The wires themselves are covered without a browser by tests/integration (the example test).
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertStringIncludes } from "@std/assert";
import { buildAndServe, launchBrowser, openClients, pollFor, waitForAll } from "./harness.ts";

const EXAMPLE = new URL("../../examples/live", import.meta.url).pathname;

Deno.test({
  name: "e2e: examples/live syncs count, presence, channel and subscription across tabs",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(EXAMPLE);
  const browser = await launchBrowser();
  // The server keeps `count`/`sent` in memory and resets them per boot, so a fresh
  // `buildAndServe` starts both at 0 — the assertions below are absolute, not relative.
  const clients = await openClients(browser, server.origin + "/", 2);
  const [a, b] = clients.pages;
  try {
    await t.step("both tabs hydrate the three live islands", async () => {
      await waitForAll(clients.pages, "document.querySelector('.live-count .count')");
      await waitForAll(clients.pages, "document.querySelector('.presence .peers')");
      await waitForAll(clients.pages, "document.querySelector('.notifications .count')");
      // A fresh server: the shared count starts at 0 in both tabs.
      await waitForAll(
        clients.pages,
        "document.querySelector('.live-count .count').textContent === '0'",
      );
    });

    await t.step("useLive: clicking +1 in tab A streams a fresh count to BOTH tabs", async () => {
      const bump = await a.$(".live-count button");
      assert(bump, "the +1 button exists");
      await bump.click();
      // The click invalidates the "count" tag on the server, which re-pushes getCount to
      // every useLive subscriber — so tab B (which never navigated) advances too.
      await waitForAll(
        clients.pages,
        "document.querySelector('.live-count .count').textContent === '1'",
      );
    });

    await t.step(
      "useChannel + useSubscription: one click pushes the event AND the count",
      async () => {
        const send = await a.$(".notifications button");
        assert(send, "the Send announcement button exists");
        await send.click();
        // The channel push (latest text) and the tag-driven subscription (count) are two
        // distinct real-time paths from the same server mutation — both must reach both tabs.
        await waitForAll(
          clients.pages,
          "document.querySelector('.notifications .count').textContent === '1 sent'",
        );
        await waitForAll(
          clients.pages,
          "(document.querySelector('.notifications .latest').textContent || '').includes('Ping at')",
        );
      },
    );

    await t.step("usePresence: a name published in A appears in B's peer list", async () => {
      // Both tabs joined the "lobby" room on load, so each already sees the other as the
      // default "anonymous"; publishing a name from A must update B's entry live.
      await pollFor(b, "!!document.querySelector('.presence .peers li:not(.empty)')");
      const name = "Ada Lovelace";
      await a.evaluate(
        `const i = document.querySelector('.presence input');` +
          `i.value = ${JSON.stringify(name)};` +
          `i.dispatchEvent(new Event('input', { bubbles: true }));`,
      );
      await pollFor(
        b,
        `(document.querySelector('.presence .peers').textContent || '').includes(${
          JSON.stringify(name)
        })`,
      );
    });

    await t.step(
      "usePresence: closing tab A drops it from B's presence (socket-close leave)",
      async () => {
        await a.close();
        // Only a real socket close proves leave detection — B falls back to the empty state.
        await pollFor(b, "!!document.querySelector('.presence .peers li.empty')");
        const peers = await b.evaluate("document.querySelector('.presence .peers').textContent");
        assertStringIncludes(String(peers), "nobody yet");
      },
    );

    assert(clients.errors.length === 0, `no console errors: ${clients.errors.join("\n")}`);
  } finally {
    await clients.closeAll();
    await browser.close();
    await server.close();
  }
});
